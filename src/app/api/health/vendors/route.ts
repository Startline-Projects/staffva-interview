import { NextRequest, NextResponse } from "next/server";
import { recordVendorFailure } from "@/lib/vendorFailure";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * GET /api/health/vendors
 *
 * Answers one question: can this app still actually reach the three vendors the
 * AI interview depends on, right now?
 *
 * This exists because claude-sonnet-4-20250514 was retired on 2026-06-15 and
 * every interview failed for ten weeks without a single alert. Nothing was
 * monitoring whether the model id was still valid, and the code caught the
 * error and apologised to the candidate instead. A build passes, a deploy
 * succeeds, and the product is dead.
 *
 * So the Anthropic check deliberately makes a REAL one-token call rather than
 * pinging a status page — a retired or misspelled model only shows up when you
 * actually ask for it. It costs a fraction of a cent per run.
 *
 * Returns 200 when everything works and 503 when anything is broken, so any
 * uptime monitor can watch it. Point one at this URL with the CRON_SECRET
 * bearer header; without a monitor this endpoint is decoration.
 *
 * Fails closed when CRON_SECRET is unset, like the other non-public routes.
 */

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 10000;

type Check = {
  vendor: string;
  ok: boolean;
  detail: string;
  ms: number;
};

async function timed(vendor: string, fn: () => Promise<string>): Promise<Check> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { vendor, ok: true, detail, ms: Date.now() - started };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await recordVendorFailure({
      vendor: vendor as "anthropic" | "deepgram" | "elevenlabs",
      operation: "health.check",
      error: err,
    });
    return { vendor, ok: false, detail, ms: Date.now() - started };
  }
}

// A real call. The model id is only validated by using it.
async function checkAnthropic(): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");

  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 0 });

  // Must stay in step with the model used by the interview itself; a health
  // check against a different model would have missed the retirement.
  const model = "claude-sonnet-5";
  const res = await client.messages.create({
    model,
    // Same reason as the model id: the probe has to send the shape production
    // sends, or it validates something nobody runs. Every interview call site
    // sets this explicitly, so this one does too — otherwise a rejection of
    // thinking:{type:"disabled"} would break every interview while the health
    // check stayed green. Omitting it here would also leave adaptive thinking
    // ON against max_tokens: 1, which cannot fit a thinking block.
    thinking: { type: "disabled" },
    max_tokens: 1,
    messages: [{ role: "user", content: "ok" }],
  });
  return `${model} responded (${res.usage.input_tokens} in / ${res.usage.output_tokens} out)`;
}

async function checkDeepgram(): Promise<string> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error("DEEPGRAM_API_KEY is not set");

  const res = await fetch("https://api.deepgram.com/v1/projects", {
    headers: { Authorization: `Token ${key}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const error = new Error(`Deepgram returned ${res.status}`);
    (error as Error & { status?: number }).status = res.status;
    throw error;
  }
  return "key valid";
}

async function checkElevenLabs(): Promise<string> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");

  // /v1/user also reports remaining character quota, which is the limit most
  // likely to be hit mid-campaign.
  const res = await fetch("https://api.elevenlabs.io/v1/user", {
    headers: { "xi-api-key": key },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const error = new Error(`ElevenLabs returned ${res.status}`);
    (error as Error & { status?: number }).status = res.status;
    throw error;
  }

  const body = (await res.json()) as {
    subscription?: { character_count?: number; character_limit?: number };
  };
  const used = body.subscription?.character_count;
  const limit = body.subscription?.character_limit;
  if (typeof used === "number" && typeof limit === "number" && limit > 0) {
    const pct = Math.round((used / limit) * 100);
    if (pct >= 95) throw new Error(`character quota ${pct}% consumed (${used}/${limit})`);
    return `key valid, quota ${pct}% used (${used}/${limit})`;
  }
  return "key valid";
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const checks = await Promise.all([
    timed("anthropic", checkAnthropic),
    timed("deepgram", checkDeepgram),
    timed("elevenlabs", checkElevenLabs),
  ]);

  const healthy = checks.every((c) => c.ok);

  // Record the OUTCOME of every check, not just the failures.
  //
  // Previously a successful run wrote nothing at all, which made "no failure
  // row" ambiguous: it meant either everything is fine or the cron never ran,
  // and those need opposite responses. It also threw away the ElevenLabs tier
  // and character quota on every run — the one number the capacity plan depends
  // on — leaving a hand-rolled curl as the only way to read it.
  //
  // Best-effort: a health check must never fail because its own bookkeeping
  // failed, or it becomes the outage it is meant to report.
  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.from("vendor_health").upsert(
      checks.map((c) => ({
        vendor: c.vendor,
        checked_at: new Date().toISOString(),
        ok: c.ok,
        detail: c.detail ? String(c.detail).slice(0, 500) : null,
        duration_ms: typeof c.ms === "number" ? c.ms : null,
      })),
      { onConflict: "vendor" }
    );
    if (error) {
      console.error("[health/vendors] could not record health:", error.message);
    }
  } catch (err) {
    console.error("[health/vendors] could not record health:", err);
  }

  return NextResponse.json(
    {
      healthy,
      checkedAt: new Date().toISOString(),
      checks,
    },
    { status: healthy ? 200 : 503 }
  );
}
