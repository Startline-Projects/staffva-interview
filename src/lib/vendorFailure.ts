import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * A retired Anthropic model broke every AI interview for ten weeks and nobody
 * noticed, because the catch around the model call replaced the error with
 * "I had a brief technical issue" and carried on. These helpers exist so that
 * cannot happen silently again.
 */

export type Vendor = "anthropic" | "deepgram" | "elevenlabs" | "resend";

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

  // The SDK reports an unknown/retired model as a 400 or 404 whose message
  // names the model, which is exactly the case that went undetected.
  if (status === 400) {
    const message = err instanceof Error ? err.message.toLowerCase() : "";
    return message.includes("model");
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
