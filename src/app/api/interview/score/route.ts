import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { recordVendorFailure } from "@/lib/vendorFailure";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendCandidateResultsEmail, sendFailEmail, sendTechnicalIssueEmail } from "@/lib/emails/send-results";

interface TranscriptEntry {
  role: "interviewer" | "candidate";
  text: string;
}

interface Scorecard {
  overall_score: number;
  badge_level: string;
  technical_knowledge_score: number;
  problem_solving_score: number;
  communication_score: number;
  experience_depth_score: number;
  professionalism_score: number;
  technical_knowledge_feedback: string;
  problem_solving_feedback: string;
  communication_feedback: string;
  experience_depth_feedback: string;
  professionalism_feedback: string;
  strengths: string;
  weaknesses: string;
  improvement_feedback: string;
  perfect_score_path: string;
  ai_notes: string;
  passed: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const { token, interviewId } = await request.json();

    if (!token || !interviewId) {
      return NextResponse.json({ error: "Missing token or interviewId" }, { status: 400 });
    }

    const payload = verifyInterviewToken(token);

    // Scoring is the largest single Anthropic call in the product (4096 output
    // tokens). It should run once per interview; the cron sweep may add one.
    const limited = await enforceRateLimit(
      `interview:score:${payload.candidate_id}`,
      LIMITS.score
    );
    if (limited) return limited;

    const supabase = createSupabaseServiceClient();

    // Load interview
    const { data: interview, error: fetchError } = await supabase
      .from("ai_interviews")
      .select("*")
      .eq("id", interviewId)
      .eq("candidate_id", payload.candidate_id)
      .single();

    if (fetchError || !interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 });
    }

    if (interview.overall_score) {
      // Already scored
      return NextResponse.json({ scored: true, interview });
    }

    // Return immediately — scoring continues in the background via after()
    after(async () => {
      try {
        await performScoring(interview, payload.candidate_id);
      } catch (err) {
        console.error("Background scoring failed:", err);
      }
    });

    return NextResponse.json({ scored: false, scoring_started: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scoring failed";
    console.error("Scoring error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function performScoring(
  interview: Record<string, unknown>,
  candidateId: string
) {
  const supabase = createSupabaseServiceClient();

  // How much of this transcript is our silence rather than their answer?
  // "[No response detected]" is what the client sends when transcription
  // returns nothing — including when the candidate never heard the question,
  // which measurably happened to 29.1% of candidates on their first turn.
  // Used below to decide whether a FAILING score is safe to act on.
  const transcriptEntries = Array.isArray(interview.transcript)
    ? (interview.transcript as { role?: string; text?: string }[])
    : [];
  const candidateTurns = transcriptEntries.filter((e) => e.role === "candidate");
  const silentTurns = candidateTurns.filter((e) => e.text === "[No response detected]");

  // Load candidate
  const { data: candidate } = await supabase
    .from("candidates")
    .select("id, display_name, role_category, country, email")
    .eq("id", candidateId)
    .single();

  // Load interview config for pass threshold
  const { data: config } = await supabase
    .from("interview_config")
    .select("pass_threshold")
    .eq("company_id", "staffva")
    .single();

  const passThreshold = config?.pass_threshold || 60;

  // Build transcript text for Claude
  const transcript: TranscriptEntry[] = (interview.transcript as TranscriptEntry[]) || [];
  const transcriptText = transcript.map((e: TranscriptEntry) => {
    return (e.role === "interviewer" ? "ALEX: " : "CANDIDATE: ") + e.text;
  }).join("\n\n");

  // Generate scorecard via Claude. Retry once on a malformed/incomplete
  // response — the parser now throws instead of silently zero-filling, and a
  // single bad completion used to leave the candidate permanently unscored
  // because the "already scored" guard blocks any later retry.
  let scorecard: Scorecard;
  try {
    scorecard = await generateScorecard(
      candidate?.display_name || "Candidate",
      candidate?.role_category || (interview.role_category as string),
      candidate?.country || "Unknown",
      transcriptText,
      passThreshold
    );
  } catch (err) {
    console.error("Scorecard generation failed, retrying once:", err instanceof Error ? err.message : err);
    scorecard = await generateScorecard(
      candidate?.display_name || "Candidate",
      candidate?.role_category || (interview.role_category as string),
      candidate?.country || "Unknown",
      transcriptText,
      passThreshold
    );
  }

  // Fail gate: count prior attempts for retake tracking
  const passed = scorecard.passed;
  const attemptCount = await supabase
    .from("interview_attempts")
    .select("id", { count: "exact" })
    .eq("candidate_id", candidateId);

  const priorAttempts = attemptCount.count ?? 0;

  // Update interview record with scores
  const { error: updateError } = await supabase
    .from("ai_interviews")
    .update({
      overall_score: scorecard.overall_score,
      badge_level: scorecard.badge_level,
      technical_knowledge_score: scorecard.technical_knowledge_score,
      problem_solving_score: scorecard.problem_solving_score,
      communication_score: scorecard.communication_score,
      experience_depth_score: scorecard.experience_depth_score,
      professionalism_score: scorecard.professionalism_score,
      technical_knowledge_feedback: scorecard.technical_knowledge_feedback,
      problem_solving_feedback: scorecard.problem_solving_feedback,
      communication_feedback: scorecard.communication_feedback,
      experience_depth_feedback: scorecard.experience_depth_feedback,
      professionalism_feedback: scorecard.professionalism_feedback,
      strengths: scorecard.strengths,
      weaknesses: scorecard.weaknesses,
      improvement_feedback: scorecard.improvement_feedback,
      perfect_score_path: scorecard.perfect_score_path,
      ai_notes: scorecard.ai_notes,
      passed: scorecard.passed,
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", interview.id);

  if (updateError) {
    console.error("Failed to save scores:", updateError.message);
    return;
  }

  // Do not reject a candidate on a transcript that is substantially our own
  // silence. Checked here rather than before scoring, for three reasons: the
  // score is still computed and kept, a PASSING candidate is never parked, and
  // it is the rejection — not the scoring — that does the damage.
  //
  // The first version of this guard required >=50% silence and, measured
  // against all 50 scored interviews in production, would have fired for
  // exactly none of them: the worst real transcript is 36% silent. These
  // thresholds park the two candidates who were actually harmed (4/11 silent
  // scoring 36, and 3/14 scoring 43) and leave the one who passed at 3/12
  // alone.
  const SILENT_TURN_FLOOR = 3;
  const tooMuchSilence =
    silentTurns.length >= SILENT_TURN_FLOOR ||
    (candidateTurns.length > 0 && silentTurns.length * 4 >= candidateTurns.length);

  if (!passed && tooMuchSilence) {
    await supabase
      .from("ai_interviews")
      .update({ status: "failed_technical" })
      .eq("id", interview.id as string);

    await recordVendorFailure({
      vendor: "elevenlabs",
      operation: "interview.score.silentTranscript",
      error: new Error(
        `Not rejected: ${silentTurns.length} of ${candidateTurns.length} answers were silent (scored ${scorecard.overall_score})`
      ),
      fatal: false,
      context: { interviewId: interview.id, candidateId, score: scorecard.overall_score },
    });

    // Tell them. This return skips the results email below, so a parked
    // candidate previously heard nothing at all — the interview simply ended
    // and no message ever arrived. Refusing to reject someone is only an
    // improvement if they find out; otherwise it is indistinguishable from
    // being ignored.
    //
    // Deliberately mentions no score. The scorecard exists, but quoting a
    // number computed from audio we failed to capture does the same harm as
    // acting on it.
    if (candidate?.email) {
      try {
        await sendTechnicalIssueEmail({
          display_name: candidate.display_name,
          email: candidate.email,
        });
      } catch (emailErr) {
        console.error("Failed to send technical-issue email:", emailErr);
      }
    }

    return;
  }

  // Write back to candidates table immediately after ai_interviews update
  const { error: candidateUpdateError } = await supabase
    .from("candidates")
    .update({
      ai_interview_badge: scorecard.badge_level,
      ai_interview_score: scorecard.overall_score,
      ai_interview_passed: passed,
      ai_interview_completed_at: new Date().toISOString(),
      // A pass no longer sets admin_status here. It used to advance the
      // candidate to 'pending_2nd_interview', which no longer exists as a step:
      // whether a pass makes someone approvable depends on the ten profile
      // gates too, and those are not this route's business. So record the
      // result, then let promote_candidate_if_ready decide (below).
      //
      // This also retires the whole DB_ADVANCE_FLOOR guard that used to sit
      // here. It existed because writing 'pending_2nd_interview' could trip the
      // 00084 invariant trigger and roll back the ENTIRE update, losing the
      // score and badge along with the status. We never write that status now,
      // so the trigger cannot fire on this path and the strand it guarded
      // against is gone.
      ...(passed ? {} : { admin_status: "ai_interview_failed" }),
      ai_interview_retake_notified_at: null,
    })
    .eq("id", candidateId);

  if (candidateUpdateError) {
    console.error(`[CRITICAL] Failed to write back to candidates table for ${candidateId}:`, candidateUpdateError.message);
  } else {
    console.log(`[SUCCESS] Candidate ${candidateId} writeback complete. Score: ${scorecard.overall_score}, Passed: ${passed}`);
  }

  // Does passing make them approvable? Only if the ten profile gates hold too,
  // so the decision lives in one place both apps call (migration 00116) rather
  // than being reimplemented here. Staying unpromoted is the ordinary outcome
  // for anyone who has not finished Build Your Profile yet — that step calls the
  // same function and promotes them when they do.
  //
  // A failure here is logged rather than thrown: the score is already saved, and
  // the promotion is idempotent, so the next attempt simply succeeds. The sweep
  // in /api/cron/promote-ready is what guarantees that "next attempt" exists for
  // a candidate who has no remaining steps of their own to trigger one.
  if (passed) {
    const { data: placement, error: promoteError } = await supabase.rpc("promote_candidate_if_ready", {
      p_candidate_id: candidateId,
    });

    if (promoteError) {
      console.error(`[CRITICAL] Could not decide placement for ${candidateId}:`, promoteError.message);
    } else {
      console.log(`[SUCCESS] Candidate ${candidateId} placement after passing: ${placement}`);
    }
  }

  // On fail: log attempt and send retake-notice email
  if (!passed) {
    const { error: attemptInsertError } = await supabase
      .from("interview_attempts")
      .insert({
        candidate_id: candidateId,
        attempt_number: priorAttempts + 1,
        ai_interview_id: interview.id as string,
        next_retake_available_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      });

    if (attemptInsertError) {
      console.error(`[CRITICAL] Failed to insert interview_attempts row for ${candidateId}:`, attemptInsertError.message);
    }

    try {
      if (candidate?.email) {
        await sendFailEmail(
          { display_name: candidate.display_name, email: candidate.email },
          scorecard.overall_score
        );
      }
    } catch (emailErr) {
      console.error("Failed to send fail email:", emailErr);
    }
  }

  // Send candidate results email (pass only — fail path uses sendFailEmail above)
  if (passed) {
    try {
      if (candidate?.email) {
        const emailInterviewData = {
          ...scorecard,
          role_category: interview.role_category as string,
          transcript: (interview.transcript as TranscriptEntry[]) || [],
          candidate_id: candidateId,
        };
        await sendCandidateResultsEmail(
          { display_name: candidate.display_name, email: candidate.email },
          emailInterviewData
        );
      }
    } catch (emailErr) {
      console.error("Failed to send candidate email:", emailErr);
    }
  }

}

const DIMENSION_KEYS = [
  "technical_knowledge_score",
  "problem_solving_score",
  "communication_score",
  "experience_depth_score",
  "professionalism_score",
] as const;

/**
 * Parse the model's scorecard JSON, failing LOUDLY rather than silently.
 *
 * Two problems this replaces:
 *  - a bare JSON.parse with no try/catch: one malformed or truncated response
 *    threw, the throw was swallowed by performScoring's caller, and the
 *    "already scored" guard then blocked any retry — leaving the candidate
 *    permanently unscored.
 *  - no shape validation: if the keys were missing or renamed, every
 *    `scores.X_score || 0` fell back to 0, producing an overall score of 0 and
 *    auto-sending a rejection email to a candidate who may have done well.
 *
 * Throwing here lets the caller retry with a fresh completion instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseScorecardJson(raw: string): any {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Scorecard response contained no JSON object");
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Scorecard JSON is malformed (likely truncated at max_tokens): ${message}`);
  }

  const missing = DIMENSION_KEYS.filter((k) => typeof parsed?.[k] !== "number");
  if (missing.length > 0) {
    throw new Error(
      `Scorecard JSON is missing numeric dimension scores: ${missing.join(", ")}`
    );
  }

  return parsed;
}

async function generateScorecard(
  candidateName: string,
  roleCategory: string,
  country: string,
  transcriptText: string,
  passThreshold: number
): Promise<Scorecard> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({
      // scoring runs in after() inside the same 60s budget, alongside emails + guide. The SDK default is 10 minutes, far beyond the
      // platform function limit, so a slow call would be killed mid-flight.
      // Budgeted to fit inside maxDuration 60. generateScorecard is called
      // twice (an app-level retry at :166), so the SDK's own retry made the
      // worst case 40s x 2 attempts x 2 calls = 160s inside a 60s function —
      // even a SINGLE slow call at 80s overran it. The function was then
      // killed mid-scoring and the interview stayed completed-but-unscored,
      // which is exactly the state the health alerter is currently reporting.
      //
      // 20s x 1 attempt x 2 calls = 40s worst case, leaving 20s for the
      // database writes and the emails that follow. Retry stays at the app
      // level, where it already exists.
      timeout: 20000,
      maxRetries: 0,
    });

  const systemPrompt = "You are a scoring engine for StaffVA skills interviews. The interview is a SKILLS EXAMINATION — the scorecard's job is to say how skilled this person demonstrably is at the role, proven by what they said.\n\nCANDIDATE: " + candidateName + "\nROLE: " + roleCategory + "\nCOUNTRY: " + country + "\nPASS THRESHOLD: " + passThreshold + " out of 100\n\nTHE EVIDENCE RULE, above all others: score only what was DEMONSTRATED in answers. Confident claims without concrete specifics score LOW. Specific, correct, step-level answers score HIGH even when modestly delivered. Fluent vagueness is the main failure mode this scorecard exists to catch — do not let polish stand in for skill.\n\nSCORING RULES:\n- Score each of the 5 dimensions from 0 to 20. Be honest and precise.\n- Overall score = sum of all 5 dimension scores (0-100).\n- Badge levels: 80-100 = exceptional, 60-79 = proficient, 40-59 = developing, below 40 = not_ready\n- passed = true if overall_score >= " + passThreshold + "\n- Each dimension feedback must be 1-2 specific sentences citing actual answers from the transcript.\n- Strengths: 2-3 specific skills they proved, with the evidence.\n- Weaknesses: specific gaps identified with actionable advice.\n- improvement_feedback: for each weak dimension, specific actionable steps.\n- perfect_score_path: what a 100% candidate looks like for this role.\n- ai_notes: internal observations — especially any claimed skill or tool that FAILED verification when probed, contradictions, and standout demonstrations.\n\nSCORING DIMENSIONS:\n1. technical_knowledge (0-20): demonstrated command of the role's tools and processes — correct specifics, real steps, named features and their limits. Listing a tool is worth nothing; showing how to use it is everything.\n2. problem_solving (0-20): how they handled the scenario and judgment probes — realistic ordered steps, sound prioritization, awareness of what could go wrong.\n3. communication (0-20): clear, organized answers that address the question asked. Judge clarity of thought; do not reward polish over substance.\n4. experience_depth (0-20): evidence the skill has been used for real — numbers, outcomes, timelines, what happened when it broke.\n5. professionalism (0-20): ownership in the accountability answer, and conduct throughout.\n\nRespond with ONLY a valid JSON object with these exact keys:\n{\n  \"technical_knowledge_score\": number,\n  \"problem_solving_score\": number,\n  \"communication_score\": number,\n  \"experience_depth_score\": number,\n  \"professionalism_score\": number,\n  \"technical_knowledge_feedback\": \"string\",\n  \"problem_solving_feedback\": \"string\",\n  \"communication_feedback\": \"string\",\n  \"experience_depth_feedback\": \"string\",\n  \"professionalism_feedback\": \"string\",\n  \"strengths\": \"string\",\n  \"weaknesses\": \"string\",\n  \"improvement_feedback\": \"string\",\n  \"perfect_score_path\": \"string\",\n  \"ai_notes\": \"string\"\n}";

  const response = await client.messages.create({
    model: "claude-sonnet-5",
    // Thinking off, deliberately. On Sonnet 5 adaptive thinking runs by DEFAULT
    // when this parameter is omitted (Sonnet 4 ran it off), and max_tokens caps
    // thinking and text TOGETHER — so the swap in 7c77555 silently gave part of
    // this budget to reasoning and started returning a thinking block first.
    //
    // Turning it off rather than budgeting for it, for two reasons:
    //   1. Latency. This runs in after() inside maxDuration 60, twice, behind a
    //      20s client timeout (see above). Adaptive thinking does not fit, and
    //      an unscored interview is a candidate who never gets a result.
    //   2. Consistency. 253 scorecards already exist, all scored without
    //      thinking. Enabling it shifts the score distribution mid-cohort —
    //      that is a rubric change, and it is not one this fix should smuggle in.
    thinking: { type: "disabled" },
    // 8000 is ~4x the ~2k tokens this JSON actually needs, which covers Sonnet
    // 5's denser tokenizer without inviting a longer completion.
    max_tokens: 8000,
    system: systemPrompt,
    messages: [
      { role: "user", content: "Score this interview transcript:\n\n" + transcriptText },
    ],
  });

  // A truncation must be reported as a truncation, not misdiagnosed by the
  // JSON parser as a malformed completion.
  if (response.stop_reason === "max_tokens") {
    throw new Error("Scorecard was truncated at max_tokens before the JSON closed");
  }

  // Select the TEXT block rather than assuming index 0 — on Sonnet 5 a thinking
  // block can arrive first, with empty text.
  const content = response.content.find((b) => b.type === "text");
  if (!content) {
    throw new Error("Claude returned no text block");
  }

  const scores = parseScorecardJson(content.text);

  const overallScore =
    (scores.technical_knowledge_score || 0) +
    (scores.problem_solving_score || 0) +
    (scores.communication_score || 0) +
    (scores.experience_depth_score || 0) +
    (scores.professionalism_score || 0);

  let badgeLevel = "not_ready";
  if (overallScore >= 80) badgeLevel = "exceptional";
  else if (overallScore >= 60) badgeLevel = "proficient";
  else if (overallScore >= 40) badgeLevel = "developing";

  return {
    overall_score: overallScore,
    badge_level: badgeLevel,
    technical_knowledge_score: scores.technical_knowledge_score || 0,
    problem_solving_score: scores.problem_solving_score || 0,
    communication_score: scores.communication_score || 0,
    experience_depth_score: scores.experience_depth_score || 0,
    professionalism_score: scores.professionalism_score || 0,
    technical_knowledge_feedback: scores.technical_knowledge_feedback || "",
    problem_solving_feedback: scores.problem_solving_feedback || "",
    communication_feedback: scores.communication_feedback || "",
    experience_depth_feedback: scores.experience_depth_feedback || "",
    professionalism_feedback: scores.professionalism_feedback || "",
    strengths: scores.strengths || "",
    weaknesses: scores.weaknesses || "",
    improvement_feedback: scores.improvement_feedback || "",
    perfect_score_path: scores.perfect_score_path || "",
    ai_notes: scores.ai_notes || "",
    passed: overallScore >= passThreshold,
  };
}
