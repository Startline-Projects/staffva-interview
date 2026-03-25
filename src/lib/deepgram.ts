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
export async function transcribeAudio(audioBuffer: Buffer | Uint8Array): Promise<string> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");

  const response = await fetch(
    `${DEEPGRAM_API_URL}/listen?model=nova-3&smart_format=true&language=en`,
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/webm",
      },
      body: audioBuffer instanceof Uint8Array ? audioBuffer : new Uint8Array(audioBuffer),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Deepgram transcription error: ${response.status} — ${error}`);
  }

  const data = await response.json();
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
}
