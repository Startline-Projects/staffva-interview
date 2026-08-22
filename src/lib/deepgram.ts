const DEEPGRAM_API_URL = "https://api.deepgram.com/v1";

// Generate a temporary API key for client-side Deepgram streaming
// This avoids exposing the main API key to the browser
export async function createDeepgramTemporaryKey(): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");

  const response = await fetch(`${DEEPGRAM_API_URL}/keys`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      comment: "StaffVA Interview temporary key",
      scopes: ["usage:write"],
      time_to_live_in_seconds: 600, // 10 minutes — enough for one interview
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Deepgram API error: ${response.status} — ${error}`);
  }

  const data = await response.json();
  return data.key;
}

// Server-side transcription for a complete audio blob (fallback)
export async function transcribeAudio(audioBuffer: ArrayBuffer | Buffer | Uint8Array): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");

  // Convert to Blob for fetch body compatibility.
  // Copied into a plain Uint8Array rather than passing the Buffer directly:
  // a Node Buffer's underlying storage is typed as ArrayBufferLike (which
  // includes SharedArrayBuffer), and that is not assignable to BlobPart.
  const source =
    audioBuffer instanceof ArrayBuffer ? new Uint8Array(audioBuffer) : audioBuffer;
  // `new Uint8Array(length)` is inferred as Uint8Array<ArrayBuffer> — the
  // narrow type BlobPart requires. Annotating it as plain `Uint8Array` would
  // widen it back to ArrayBufferLike and fail again.
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(source);

  const blob = new Blob([bytes], { type: "audio/webm" });

  // Bound the upstream call. The route's platform timeout is 30s, so failing at
  // 20s leaves room to return a proper error instead of being killed mid-flight
  // (which the client could not distinguish from a real transcription result).
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let response: Response;
  try {
    response = await fetch(
      `${DEEPGRAM_API_URL}/listen?model=nova-3&smart_format=true&language=en`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "audio/webm",
        },
        body: blob,
        signal: controller.signal,
      }
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Deepgram transcription timed out after 20s");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Deepgram transcription error: ${response.status} — ${error}`);
  }

  const data = await response.json();
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
}
