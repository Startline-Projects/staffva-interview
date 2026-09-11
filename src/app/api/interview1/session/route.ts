import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { recordVendorFailure } from "@/lib/vendorFailure";
import { dealIv1Plan } from "@/lib/iv1Questions";
import {
  isTokenError,
  iv1AnsweredIds,
  iv1NextTurn,
  type Iv1Plan,
  type Iv1TranscriptEntry,
} from "@/lib/iv1Session";

/** Matches the skills interview's resume window, which is itself coupled
 * to the platform's 8h token mint. */
const STALE_AFTER_HOURS = 6;

/**
 * POST /api/interview1/session { token, action: "start" }
 *
 * Interview 1 is structured, not conversational: the session deals a fixed
 * plan (opener + one question per behavioral category) and stores it on the
 * interview row, so a resume replays the same plan at the same position.
 * Questions are served ONE turn at a time — the client never holds the
 * whole list to read ahead.
 */
export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();
    if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });
    const payload = verifyInterviewToken(token);

    const limited = await enforceRateLimit(
      `interview:iv1session:${payload.candidate_id}`,
      LIMITS.iv1Session
    );
    if (limited) return limited;

    const supabase = createSupabaseServiceClient();
    const { data: candidate, error: candidateError } = await supabase
      .from("candidates")
      // role_category is selected because ai_interviews.role_category is
      // NOT NULL with no default. Behavioral questions do not vary by role,
      // but the row still has to carry one.
      .select("id, display_name, role_category, interview1_passed, ai_interview_passed")
      .eq("id", payload.candidate_id)
      .single();
    // PGRST116 is "no row", which really is a 404. Anything else — a
    // connection failure, a PostgREST 5xx, a statement timeout — is OURS, and
    // reporting it as 404 was not cosmetic: LiveInterview gates its Retry
    // button on `status !== 404`, so a transient database blip dead-ended the
    // candidate permanently under a message saying they do not exist.
    if (candidateError && candidateError.code !== "PGRST116") {
      await recordVendorFailure({
        vendor: "supabase",
        operation: "interview1.session.candidate_lookup",
        error: new Error(candidateError.message),
        context: { candidate_id: payload.candidate_id, code: candidateError.code },
      });
      return NextResponse.json(
        { error: "We couldn't reach your details just now. Please try again." },
        { status: 500 }
      );
    }
    if (!candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    // Already through — grandfathered single-interview passers included.
    if (candidate.interview1_passed === true || candidate.ai_interview_passed === true) {
      return NextResponse.json({ alreadyPassed: true });
    }

    // Retire stale behavioral sessions, then resume a fresh one.
    const staleCutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3600_000).toISOString();
    await supabase
      .from("ai_interviews")
      .update({ status: "failed_technical", parked_reason: "stale_abandoned" })
      .eq("candidate_id", candidate.id)
      .eq("kind", "behavioral")
      .eq("status", "in_progress")
      .lt("created_at", staleCutoff);

    const { data: existing } = await supabase
      .from("ai_interviews")
      .select("id, transcript, question_plan")
      .eq("candidate_id", candidate.id)
      .eq("kind", "behavioral")
      .eq("status", "in_progress")
      .gte("created_at", staleCutoff)
      .limit(1)
      .maybeSingle();

    const firstName = (candidate.display_name as string).split(" ")[0];

    if (existing && existing.question_plan) {
      const plan = existing.question_plan as Iv1Plan;
      const transcript = (existing.transcript || []) as Iv1TranscriptEntry[];
      const answeredIds = iv1AnsweredIds(transcript);
      const turn = iv1NextTurn(plan, answeredIds);
      return NextResponse.json({
        interviewId: existing.id,
        greeting: `Welcome back, ${firstName} — let's pick up where we left off.`,
        resumed: true,
        total: plan.questionIds.length,
        answered: answeredIds.length,
        ...turn,
      });
    }

    // Retake gate on the behavioral track.
    const { data: lastAttempt } = await supabase
      .from("interview_attempts")
      .select("next_retake_available_at")
      .eq("candidate_id", candidate.id)
      .eq("kind", "behavioral")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastAttempt?.next_retake_available_at) {
      const retakeDate = new Date(lastAttempt.next_retake_available_at);
      if (retakeDate > new Date()) {
        return NextResponse.json(
          { error: "Retake not available until " + retakeDate.toLocaleDateString() },
          { status: 403 }
        );
      }
    }

    const plan: Iv1Plan = { questionIds: dealIv1Plan(), followUp: null };
    const interviewId = uuidv4();
    const greeting = `Hi ${firstName} — good to meet you. I'll ask you ${plan.questionIds.length} questions — about ten minutes in all. Take your time on each one, and be yourself. Ready when you are.`;

    const { error: insertError } = await supabase.from("ai_interviews").insert({
      id: interviewId,
      candidate_id: candidate.id,
      // NOT NULL on ai_interviews, and omitting it here meant EVERY behavioral
      // interview failed at the insert — the candidate got the raw constraint
      // error on screen and no interview 1 row has ever existed. Behavioral
      // questions are role-agnostic, so this is bookkeeping, not a selector.
      role_category: candidate.role_category,
      kind: "behavioral",
      status: "in_progress",
      question_plan: plan,
      transcript: [{ role: "interviewer", text: greeting, at: new Date().toISOString() }],
      // The CAS token the answer route compares against.
      turn_count: 1,
    });
    if (insertError) {
      // The candidate must never read Postgres. Record the real fault where
      // alerting looks, and tell them the one thing they need to know.
      await recordVendorFailure({
        vendor: "supabase",
        operation: "interview1.session.create",
        error: new Error(insertError.message),
        fatal: true,
        context: {
          candidate_id: candidate.id,
          code: insertError.code,
          details: insertError.details,
        },
      });
      return NextResponse.json(
        { error: "We couldn't start your interview just now. Nothing has been used up — please try again." },
        { status: 500 }
      );
    }

    // The attempt row, with the retake window explicitly null — the window
    // is set on FAILURE by scoring, the only place that knows whether one
    // is warranted (the skills route learned this the hard way).
    const { count } = await supabase
      .from("interview_attempts")
      .select("*", { count: "exact", head: true })
      .eq("candidate_id", candidate.id)
      .eq("kind", "behavioral");
    await supabase.from("interview_attempts").insert({
      candidate_id: candidate.id,
      attempt_number: (count || 0) + 1,
      ai_interview_id: interviewId,
      kind: "behavioral",
      next_retake_available_at: null,
    });

    const turn = iv1NextTurn(plan, []);
    return NextResponse.json({
      interviewId,
      greeting,
      resumed: false,
      total: plan.questionIds.length,
      answered: 0,
      ...turn,
    });
  } catch (err: unknown) {
    // Only a token problem is a 401. A malformed body or a database outage
    // is ours — telling the candidate to re-login for it sends them to fix
    // something they cannot fix, and leaks internals on the way.
    const message = err instanceof Error ? err.message : "Unknown error";
    const isAuth = isTokenError(message);
    if (!isAuth) console.error("[iv1-session] failed:", message);
    return NextResponse.json(
      { error: isAuth ? message : "We couldn't start the interview. Try again in a moment." },
      { status: isAuth ? 401 : 500 }
    );
  }
}
