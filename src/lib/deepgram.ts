const DEEPGRAM_API_URL = "https://api.deepgram.com/v1";

export interface TranscriptionResult {
  text: string;
  // Deepgram's own confidence for the winning alternative (0..1) and the
  // measured audio duration. SERVER-derived from the audio itself, so unlike
  // the client-reported turn timing these cannot be fabricated in transit —
  // low confidence is the "degraded evidence" signal the review flow needs to
  // distinguish bad audio from bad answers.
  confidence: number | null;
  durationSeconds: number | null;
  /** Distinct speakers Deepgram heard in this turn (diarization). One is the
   *  norm. Recorded as CONTEXT FOR A HUMAN reviewing a flagged session — never
   *  a score input, and never a lockout: a television or a family member in
   *  earshot produces this constantly. */
  speakerCount: number | null;
}

export async function transcribeAudio(audioBuffer: ArrayBuffer | Buffer | Uint8Array): Promise<TranscriptionResult> {
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
      // diarize=true costs nothing extra — Deepgram returns speaker labels on the
      // same request we already pay for — and without it a second voice in the
      // room is transcribed as the candidate with no marker at all.
      //
      // What comes back is EVIDENCE FOR A HUMAN, never a score input. A shared
      // room, a television, or a child in the background produces multi-speaker
      // turns constantly, and a detector that rejects on that is the silence
      // guard again: it auto-rejected 29% of candidates for our own audio.
      `${DEEPGRAM_API_URL}/listen?model=nova-3&smart_format=true&language=en&diarize=true`,
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
  const alt = data.results?.channels?.[0]?.alternatives?.[0];
  // How many distinct speakers Deepgram heard in this turn. One is the norm.
  const words = Array.isArray(alt?.words) ? alt.words : [];
  const speakers = new Set(
    words
      .map((w: { speaker?: number }) => w.speaker)
      .filter((n: unknown): n is number => typeof n === "number")
  );
  return {
    text: alt?.transcript || "",
    confidence: typeof alt?.confidence === "number" ? alt.confidence : null,
    durationSeconds: typeof data.metadata?.duration === "number" ? data.metadata.duration : null,
    speakerCount: speakers.size || null,
  };
}
