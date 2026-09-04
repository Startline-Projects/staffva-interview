import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Rate limiting for the paid endpoints.
 *
 * Every live interview turn costs an Anthropic call, an ElevenLabs synthesis
 * and a Deepgram transcription. Nothing bounded how often those could be
 * driven, so a loop against them spends real money — and reopening signup is
 * what makes that reachable.
 *
 * Backed by the shared Postgres instance (see migration: check_rate_limit) so
 * there is no extra vendor and no extra environment variable to forget. The
 * counter is a single atomic INSERT ... ON CONFLICT ... RETURNING, so
 * concurrent requests cannot both observe the same pre-increment value.
 *
 * Limits are deliberately generous: they are a ceiling on abuse, not a
 * throttle on use. A real interview makes ~9 model calls and ~10 syntheses
 * over ~15 minutes, so a candidate should never come close.
 */

export type RateLimit = { limit: number; windowSeconds: number };

// Keyed per candidate, not per IP. These routes are token-authenticated, so
// the candidate id is both available and precise — and candidates in the same
// country often share NAT'd addresses, which makes IP limits blunt here.
export const LIMITS = {
  // 15-question cap per interview; 60/hr allows retakes and reconnects.
  interviewTurn: { limit: 60, windowSeconds: 3600 },
  // One synthesis per interviewer turn, plus replays.
  tts: { limit: 120, windowSeconds: 3600 },
  // One transcription per candidate answer, plus the client's retry path.
  transcribe: { limit: 120, windowSeconds: 3600 },
  // Scoring is once per interview; the cron sweep may add one more.
  score: { limit: 10, windowSeconds: 3600 },
  // Interview 1 session starts: a candidate legitimately starts once, maybe
  // resumes a handful of times after refreshes.
  iv1Session: { limit: 15, windowSeconds: 3600 },
} satisfies Record<string, RateLimit>;

/**
 * Seconds until the current fixed window rolls over.
 *
 * Retry-After previously reported the whole window length, so a caller blocked
 * at 59 minutes past was told to wait another full hour when the counter was
 * about to reset. This mirrors check_rate_limit's own
 * floor(epoch / window) * window exactly, so the two cannot disagree.
 */
function secondsUntilWindowResets(windowSeconds: number): number {
  const nowSeconds = Date.now() / 1000;
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  return Math.max(1, Math.ceil(windowStart + windowSeconds - nowSeconds));
}

/**
 * Returns null when the caller may proceed, or a 429 response to return.
 *
 * Fails OPEN. If the limiter itself errors, the request is allowed: this
 * guards a cost ceiling, and taking the product down because a counter table
 * is unreachable would be a worse outcome than the spend it prevents. The
 * failure is logged so it is not silent.
 */
export async function enforceRateLimit(
  key: string,
  { limit, windowSeconds }: RateLimit
): Promise<NextResponse | null> {
  try {
    const supabase = createSupabaseServiceClient();
    const { data: allowed, error } = await supabase.rpc("check_rate_limit", {
      p_bucket: key,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });

    if (error) {
      console.error(`[rate-limit] check failed for ${key}, allowing:`, error.message);
      return null;
    }

    if (allowed === false) {
      const retryAfter = secondsUntilWindowResets(windowSeconds);
      console.warn(`[rate-limit] blocked ${key} (>${limit} per ${windowSeconds}s, resets in ${retryAfter}s)`);
      return NextResponse.json(
        {
          error: "Too many requests. Please wait a moment and try again.",
          retryAfterSeconds: retryAfter,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
    }

    return null;
  } catch (err) {
    console.error(`[rate-limit] check threw for ${key}, allowing:`, err);
    return null;
  }
}

/** Best-effort client address, for the few routes with no authenticated identity. */
export function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}
