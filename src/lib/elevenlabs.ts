const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1";

// Default voice — professional, neutral. Can be overridden per white-label client.
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // "Rachel" — clear professional female voice

export async function textToSpeechStream(
  text: string,
  voiceId?: string
): Promise<ArrayBuffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not configured");

  // Bound the upstream call — the route's platform timeout is 30s, so fail at
  // 20s with a real error rather than hanging until the function is killed.
  // A failed TTS is non-fatal (the client shows the question text), but a hung
  // one stalls the whole interview turn.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  let response: Response;
  try {
    response = await fetch(
      `${ELEVENLABS_API_URL}/text-to-speech/${voiceId || DEFAULT_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2_5",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true,
          },
        }),
        signal: controller.signal,
      }
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("ElevenLabs TTS timed out after 20s");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} — ${error}`);
  }

  return response.arrayBuffer();
}
