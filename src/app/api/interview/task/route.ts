import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { roleTaskFor } from "@/lib/roleTask";
import { buildTask, findSeededTool, ALL_VARIANTS } from "@/lib/taskBank";
import { newTaskSeed } from "@/lib/taskSeed";
import { scoreTask, type TaskSubmission } from "@/lib/taskCheck";
import { recordVendorFailure } from "@/lib/vendorFailure";

/**
 * POST /api/interview/task — the Interview 2 performance task.
 *
 *   { action: "serve" }    → deal (or re-deal) this interview's task brief
 *   { action: "submit" }   → bank the answers and score them, once
 *   { action: "abandon" }  → the candidate cannot continue; bank nothing, park
 *                            the task, and send them back to the conversation
 *
 * Three rules this route exists to enforce:
 *
 *  1. The answer key never leaves the server. `serve` returns the brief only,
 *     and `submit` returns a bare acknowledgement — not which items were right.
 *     A candidate who fails gets a retake in three days; telling them exactly
 *     which planted defects they missed would hand them the answer key.
 *  2. The clock is ours. task_served_at and task_submitted_at are server
 *     stamps and elapsed is computed from them. The client's timer is display
 *     only and is never sent, never trusted.
 *  3. Serve is write-once. The UPDATE carries `task_variant is null`, so a
 *     second concurrent call changes nothing and gets the winner's brief. Two
 *     briefs for one interview would mean the checker scores against a key the
 *     candidate never saw.
 */

const MIN_QUESTIONS_BEFORE_TASK = 5;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { token, interviewId, action } = body as {
      token?: string;
      interviewId?: string;
      action?: string;
    };

    if (typeof token !== "string" || typeof interviewId !== "string") {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }
    const payload = verifyInterviewToken(token);

    const limited = await enforceRateLimit(`interview:task:${payload.candidate_id}`, LIMITS.task);
    if (limited) return limited;

    const supabase = createSupabaseServiceClient();

    // Kind-pinned exactly as handleRespond is. A behavioral interview must
    // never reach the skills task: it would score an Interview 1 against an
    // Interview 2 instrument.
    const { data: interview } = await supabase
      .from("ai_interviews")
      .select(
        "id, status, transcript, role_category, task_key, task_variant, task_seed, " +
          "task_status, task_served_at, task_mapping_rule, task_mapping_confident"
      )
      .eq("id", interviewId)
      .eq("candidate_id", payload.candidate_id)
      .eq("kind", "skills")
      .single();

    if (!interview) {
      return NextResponse.json({ error: "No open interview" }, { status: 409 });
    }

    if (action === "serve") return serve(supabase, interview, payload.candidate_id);
    if (action === "submit") return submit(supabase, interview, payload.candidate_id, body);
    if (action === "abandon") return abandon(supabase, interview);

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const isAuth = /\bjwt\b|\btoken\b|invalid signature/i.test(message);
    if (!isAuth) console.error("[iv2-task] failed:", message);
    return NextResponse.json(
      { error: isAuth ? message : "Something went wrong loading your task." },
      { status: isAuth ? 401 : 500 }
    );
  }
}

type InterviewRow = {
  id: string;
  status: string;
  transcript: unknown;
  role_category: string | null;
  task_key: string | null;
  task_variant: string | null;
  task_seed: string | null;
  task_status: string | null;
  task_served_at: string | null;
  task_mapping_rule: string | null;
  task_mapping_confident: boolean | null;
};

type Db = ReturnType<typeof createSupabaseServiceClient>;

/** Pick a variant this candidate has not seen, falling back to least-recent. */
async function chooseVariant(
  supabase: Db,
  candidateId: string,
  taskKey: string,
  pool: string[]
): Promise<string> {
  const { data: seen } = await supabase
    .from("interview_task_exposure")
    .select("variant")
    .eq("candidate_id", candidateId)
    .eq("task_key", taskKey);

  const used = new Set((seen || []).map((r: { variant: string }) => r.variant));
  const unseen = pool.filter((v) => !used.has(v));
  // Everyone in the marketplace is re-qualifying right now, so retakes are the
  // common case. Repeating a variant measures memory, not skill.
  if (unseen.length) return unseen[Math.floor(Math.random() * unseen.length)];
  return pool[Math.floor(Math.random() * pool.length)];
}

async function serve(supabase: Db, interview: InterviewRow, candidateId: string) {
  if (interview.status !== "in_progress") {
    return NextResponse.json({ error: "No open interview" }, { status: 409 });
  }

  // Already served: return the same brief, rebuilt from the STORED seed. Never
  // recompute the seed — a resume must show the identical brief, including
  // after a refresh three minutes later.
  if (interview.task_variant && interview.task_seed) {
    if (interview.task_status === "scored" || interview.task_status === "submitted") {
      return NextResponse.json({ alreadySubmitted: true }, { status: 409 });
    }
    const { brief } = buildTask(
      interview.task_variant,
      interview.task_seed,
      seededToolFor(interview)
    );
    return NextResponse.json({
      brief,
      servedAt: interview.task_served_at,
      resumed: true,
      confident: interview.task_mapping_confident !== false,
    });
  }

  // The token is a 24-hour bearer credential sitting in the candidate's URL
  // bar. Without this gate, a script could POST for the brief hours early,
  // hand it to a model, and come back with the answers ready.
  const transcript = Array.isArray(interview.transcript)
    ? (interview.transcript as { role: string; text: string }[])
    : [];
  const questionsAsked = transcript.filter((e) => e.role === "interviewer").length;
  if (questionsAsked < MIN_QUESTIONS_BEFORE_TASK) {
    return NextResponse.json({ error: "Not yet" }, { status: 409 });
  }

  // The role is read from the interview's own snapshot, never from
  // candidates.role_category: migration 00120 grants authenticated UPDATE on
  // that column, so a candidate could otherwise change their role mid-interview
  // and choose their own exam.
  const match = roleTaskFor(interview.role_category);
  const pool = ALL_VARIANTS[match.key] || match.variantPool;
  const variant = await chooseVariant(supabase, candidateId, match.key, pool);
  const seed = newTaskSeed();
  const now = new Date().toISOString();

  // Write-once. A concurrent second serve loses here and re-reads the winner's
  // row below, so one interview can only ever have one brief.
  const { data: claimed } = await supabase
    .from("ai_interviews")
    .update({
      task_key: match.key,
      task_variant: variant,
      task_seed: seed,
      task_role_category: interview.role_category,
      task_mapping_rule: match.rule,
      task_mapping_confident: match.confident,
      task_status: "served",
      task_served_at: now,
    })
    .eq("id", interview.id)
    .is("task_variant", null)
    .select("task_variant, task_seed, task_served_at, task_mapping_confident")
    .maybeSingle();

  if (!claimed) {
    const { data: fresh } = await supabase
      .from("ai_interviews")
      .select("task_variant, task_seed, task_served_at, task_mapping_confident")
      .eq("id", interview.id)
      .single();
    if (!fresh?.task_variant || !fresh.task_seed) {
      return NextResponse.json({ error: "Could not open the task" }, { status: 500 });
    }
    const { brief } = buildTask(fresh.task_variant, fresh.task_seed, seededToolFor(interview));
    return NextResponse.json({
      brief,
      servedAt: fresh.task_served_at,
      confident: fresh.task_mapping_confident !== false,
    });
  }

  // Exposure is recorded after the claim, so a lost race never burns a variant.
  await supabase
    .from("interview_task_exposure")
    .upsert(
      { candidate_id: candidateId, task_key: match.key, variant },
      { onConflict: "candidate_id,task_key,variant" }
    );

  const { brief } = buildTask(variant, seed, seededToolFor(interview));
  return NextResponse.json({
    brief,
    servedAt: claimed.task_served_at,
    confident: match.confident,
  });
}

function seededToolFor(interview: InterviewRow): string | null {
  const transcript = Array.isArray(interview.transcript)
    ? (interview.transcript as { role: string; text: string }[])
    : [];
  return findSeededTool(transcript);
}

async function submit(
  supabase: Db,
  interview: InterviewRow,
  candidateId: string,
  body: Record<string, unknown>
) {
  if (!interview.task_variant || !interview.task_seed) {
    return NextResponse.json({ error: "No task was served" }, { status: 409 });
  }
  if (interview.task_status === "scored" || interview.task_status === "submitted") {
    // Idempotent, and deliberately says nothing about the result.
    return NextResponse.json({ ok: true, alreadySubmitted: true });
  }

  const submission = (body.submission || {}) as TaskSubmission;
  if (typeof submission !== "object") {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }

  // Claim the submit before doing anything else, so a double-tap cannot
  // produce two scores for one task.
  //
  // 'abandoned' is claimable too. A candidate who pressed "I can't continue",
  // was re-offered the task on the next turn, and then did it would otherwise
  // have hit the `.eq("task_status","served")` guard, been told {ok:true}, and
  // had their work thrown away with a success message.
  const now = new Date().toISOString();
  const { data: claimed } = await supabase
    .from("ai_interviews")
    .update({ task_status: "submitted", task_submitted_at: now })
    .eq("id", interview.id)
    .in("task_status", ["served", "abandoned"])
    .select("id")
    .maybeSingle();
  if (!claimed) {
    return NextResponse.json({ ok: true, alreadySubmitted: true });
  }

  const elapsedMs = interview.task_served_at
    ? new Date(now).getTime() - new Date(interview.task_served_at).getTime()
    : null;

  // PERSIST THE RAW ANSWERS FIRST, before scoring and before anything that can
  // throw. The claim above already moved the row out of 'served', so from this
  // point the candidate cannot re-submit — which means any failure between here
  // and the write erases work they cannot give again, and the client is told
  // {ok:true} while it happens. handleRespond learned this same lesson about
  // answers and the model call; this is the same shape.
  const { error: bankErr } = await supabase.from("interview_task_results").upsert(
    {
      interview_id: interview.id,
      candidate_id: candidateId,
      task_key: interview.task_key,
      variant: interview.task_variant,
      seed: interview.task_seed,
      submission,
      detail: {},
      elapsed_ms: elapsedMs,
    },
    { onConflict: "interview_id" }
  );
  if (bankErr) {
    // The answers are gone and we cannot get them back. Say so rather than
    // reporting success: the client keeps its state and the candidate can retry
    // while the row is still claimable on the next turn.
    console.error("[iv2-task] submission bank failed:", bankErr.message);
    await recordVendorFailure({
      vendor: "supabase",
      operation: "iv2_task_submission_bank",
      fatal: false,
      error: new Error(bankErr.message),
      context: { interview_id: interview.id },
    });
    await supabase
      .from("ai_interviews")
      .update({ task_status: "served", task_submitted_at: null })
      .eq("id", interview.id);
    return NextResponse.json({ error: "We couldn't save your answers." }, { status: 500 });
  }

  // Score in-process. No vendor, no network. A checker bug must never cost the
  // candidate the task — the answers are already banked above, so the worst
  // case here is a null score that a human can re-run from the stored seed.
  let scored: ReturnType<typeof scoreTask> | null = null;
  try {
    scored = scoreTask(
      interview.task_variant,
      interview.task_seed,
      submission,
      seededToolFor(interview)
    );
  } catch (err) {
    await recordVendorFailure({
      vendor: "supabase",
      operation: "iv2_task_score",
      fatal: false,
      error: err,
      context: { interview_id: interview.id, variant: interview.task_variant },
    });
  }

  if (scored) {
    const { error: scoreErr } = await supabase
      .from("interview_task_results")
      .update({
        score_pct: scored.pct,
        max_points: scored.maxPoints,
        earned: scored.earned,
        detail: { verdicts: scored.verdicts, missed: scored.missed },
      })
      .eq("interview_id", interview.id);
    if (scoreErr) {
      // The answers survived; only the verdict did not. Leave task_status at
      // 'submitted' so nothing downstream reads this as a scored zero, and
      // make it visible — a re-score from the stored seed is a one-liner.
      console.error("[iv2-task] score write failed:", scoreErr.message);
      await recordVendorFailure({
        vendor: "supabase",
        operation: "iv2_task_score_write",
        fatal: false,
        error: new Error(scoreErr.message),
        context: { interview_id: interview.id },
      });
      return NextResponse.json({ ok: true });
    }
  }

  await supabase
    .from("ai_interviews")
    .update({
      task_status: scored ? "scored" : "submitted",
      task_score_pct: scored?.pct ?? null,
    })
    .eq("id", interview.id);

  // Deliberately bare. The candidate learns nothing about which items they got
  // right — a retake opens three days after a failure, and the per-item detail
  // IS the answer key.
  return NextResponse.json({ ok: true });
}

async function abandon(supabase: Db, interview: InterviewRow) {
  if (interview.task_status === "scored" || interview.task_status === "submitted") {
    return NextResponse.json({ ok: true });
  }
  // Without this, a candidate who cannot do the task leaves the interview
  // in_progress, the 6-hour sweep retires it to failed_technical, and the
  // scoring route 409s — so the "infer nothing from a missing task" rule would
  // never run. Abandoning explicitly is what keeps that promise reachable.
  await supabase
    .from("ai_interviews")
    .update({ task_status: "abandoned", task_score_pct: null })
    .eq("id", interview.id)
    .in("task_status", ["served"]);
  return NextResponse.json({ ok: true });
}
