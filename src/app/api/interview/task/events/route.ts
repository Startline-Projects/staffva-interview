import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * POST /api/interview/task/events — focus and paste telemetry during the task.
 *
 * READ THIS BEFORE WIRING ANYTHING TO THE DATA IT WRITES.
 *
 * These rows exist to give a person context when they are ALREADY reviewing a
 * session. Nothing automatic reads them, nothing scores them, and nothing here
 * may ever trigger a lockout. Two reasons, both of them receipts:
 *
 *  - The platform's own /api/proctor/events recomputes a lockout from leave
 *    events counted per candidate with no session-kind filter. Writing task
 *    telemetry there would manufacture strikes that pool with English-test
 *    strikes and lock somebody out of an exam they are passing. That is why
 *    this has its own table and its own route.
 *  - StaffVA has already shipped one detector that punished honest people: a
 *    silence guard that auto-rejected 29% of candidates for audio failures on
 *    our side. A candidate on a shared laptop, on mobile data, with a toddler
 *    in the room, produces exactly the event pattern a cheat does.
 *
 * We also do not block paste. Copying a 12-character reference number out of a
 * forwarded email is the honest workflow; blocking it would force an honest
 * candidate to hand-retype into an exact-match field and eat a transcription
 * error the cheat never risks.
 */

const KINDS = new Set(["blur", "focus", "paste", "visibility_hidden", "visibility_visible"]);
const MAX_BATCH = 40;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { token, interviewId, events } = body as {
      token?: string;
      interviewId?: string;
      events?: { kind?: string; at?: string; detail?: unknown }[];
    };

    if (typeof token !== "string" || typeof interviewId !== "string" || !Array.isArray(events)) {
      return NextResponse.json({ ok: true });
    }
    const payload = verifyInterviewToken(token);

    const limited = await enforceRateLimit(
      `interview:taskevents:${payload.candidate_id}`,
      LIMITS.taskEvents
    );
    // A rate limit here must not interrupt the candidate — telemetry is for us,
    // not for them. Swallow it and carry on.
    if (limited) return NextResponse.json({ ok: true });

    const supabase = createSupabaseServiceClient();

    // The interview must be this candidate's, and a skills one. Anything else
    // is dropped silently rather than surfaced — there is no useful thing for
    // a candidate to do about a telemetry rejection.
    const { data: interview } = await supabase
      .from("ai_interviews")
      .select("id")
      .eq("id", interviewId)
      .eq("candidate_id", payload.candidate_id)
      .eq("kind", "skills")
      .maybeSingle();
    if (!interview) return NextResponse.json({ ok: true });

    const rows = events
      .slice(0, MAX_BATCH)
      .filter((e) => e && typeof e.kind === "string" && KINDS.has(e.kind))
      .map((e) => ({
        interview_id: interviewId,
        candidate_id: payload.candidate_id,
        kind: e.kind as string,
        // The client's clock is not trusted for anything that matters, but an
        // ordering hint within a batch is harmless. A malformed value falls
        // back to the server's now().
        at: typeof e.at === "string" && !Number.isNaN(Date.parse(e.at))
          ? new Date(e.at).toISOString()
          : new Date().toISOString(),
        detail: e.detail && typeof e.detail === "object" ? e.detail : null,
      }));

    if (rows.length) {
      const { error } = await supabase.from("interview_task_events").insert(rows);
      if (error) console.error("[iv2-task-events] insert failed:", error.message);
    }

    return NextResponse.json({ ok: true });
  } catch {
    // Telemetry never errors the candidate. Ever.
    return NextResponse.json({ ok: true });
  }
}
