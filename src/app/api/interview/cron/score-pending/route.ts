import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { generateInterviewToken } from "@/lib/auth/verify-token";

/**
 * GET /api/interview/cron/score-pending
 *
 * Safety net for interviews that finished but were never scored.
 *
 * Scoring is otherwise triggered ONLY by the browser, and only after the
 * closing text-to-speech finishes playing — so a candidate who closes the tab
 * during the goodbye (or whose single POST fails) ends up "completed" forever
 * with no scorecard, while the results page polls indefinitely. Nothing
 * server-side ever retried.
 *
 * This sweeps interviews that completed a few minutes ago and still have no
 * overall_score, mints a short-lived interview token for the owning candidate,
 * and drives the normal /api/interview/score endpoint — reusing its existing
 * logic and its "already scored" guard rather than duplicating scoring here.
 *
 * Fails closed when CRON_SECRET is unset.
 */

// Only pick up interviews that have been finished for a few minutes, so we
// never race the candidate's own in-flight scoring request.
const MIN_AGE_MINUTES = 5;
const BATCH_LIMIT = 10;

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createSupabaseServiceClient();
  const cutoff = new Date(Date.now() - MIN_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: pending, error } = await supabase
    .from("ai_interviews")
    .select("id, candidate_id")
    .eq("status", "completed")
    .is("overall_score", null)
    .lt("completed_at", cutoff)
    .order("completed_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error) {
    console.error("[score-pending] query failed:", error.message);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({ scanned: 0, triggered: 0 });
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  let triggered = 0;
  const failures: string[] = [];

  for (const interview of pending) {
    try {
      const token = generateInterviewToken(interview.candidate_id as string);

      const res = await fetch(`${baseUrl}/api/interview/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, interviewId: interview.id }),
      });

      if (res.ok) {
        triggered++;
        console.log(`[score-pending] triggered scoring for interview ${interview.id}`);
      } else {
        failures.push(`${interview.id}: HTTP ${res.status}`);
      }
    } catch (err) {
      failures.push(`${interview.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (failures.length > 0) {
    console.error(`[score-pending] ${failures.length} failed:`, failures.join("; "));
  }

  return NextResponse.json({ scanned: pending.length, triggered, failed: failures.length });
}
