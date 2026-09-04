import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * A retired Anthropic model broke every AI interview for ten weeks and nobody
 * noticed, because the catch around the model call replaced the error with
 * "I had a brief technical issue" and carried on. These helpers exist so that
 * cannot happen silently again.
 */

export type Vendor = "anthropic" | "deepgram" | "elevenlabs" | "resend" | "supabase";

/**
 * Is this error one that every subsequent request will also hit?
 *
 * A 429 or a 503 is bad luck and worth retrying. A 401, a 403, or a 404 for a
 * model id is a configuration fault: the key is wrong, revoked, or the model
 * has been retired. Those must never be smoothed over, because they affect
 * every candidate and they do not heal on their own.
 */
export function isFatalVendorError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (status === 401 || status === 403 || status === 404) return true;

  if (status === 400) {
    const message = err instanceof Error ? err.message.toLowerCase() : "";

    // The SDK reports an unknown/retired model as a 400 or 404 whose message
    // names the model, which is exactly the case that went undetected.
    if (message.includes("model")) return true;

    // Billing. Anthropic returns "Your credit balance is too low to access the
    // Anthropic API" as a plain 400, and it was landing here as NON-fatal —
    // because it does not contain the word "model".
    //
    // That is backwards. An exhausted balance is the most total failure a vendor
    // can have: every request fails, no candidate can be interviewed or scored,
    // and it does not heal on its own. And because alert-health raises its
    // critical vendor alert on `fatal = true`, this was the one failure
    // guaranteed to stay quiet. It was found by reading the table by hand, which
    // is precisely what the alert exists to make unnecessary.
    if (
      message.includes("credit") ||
      message.includes("billing") ||
      message.includes("quota") ||
      message.includes("payment") ||
      message.includes("insufficient")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Record a vendor failure. Never throws: logging a problem must not create a
 * second one. Fire-and-forget from a catch block.
 */
export async function recordVendorFailure(input: {
  vendor: Vendor;
  operation: string;
  error: unknown;
  fatal?: boolean;
  context?: Record<string, unknown>;
}): Promise<void> {
  try {
    const { vendor, operation, error, context } = input;
    const fatal = input.fatal ?? isFatalVendorError(error);
    const status = (error as { status?: number } | null)?.status ?? null;
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `[vendor-failure]${fatal ? " FATAL" : ""} ${vendor}/${operation}: ${message}`
    );

    await createSupabaseServiceClient().from("vendor_failures").insert({
      app: "interview",
      vendor,
      operation,
      fatal,
      status_code: status,
      message: message.slice(0, 2000),
      context: context ?? null,
    });
  } catch (loggingError) {
    // Deliberately swallowed -- this is the one place where swallowing is
    // correct, because the caller is already handling a failure.
    console.error("[vendor-failure] could not record failure:", loggingError);
  }
}
