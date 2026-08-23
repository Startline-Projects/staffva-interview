import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { textToSpeechStream } from "@/lib/elevenlabs";

export async function POST(request: NextRequest) {
  try {
    // voiceId is deliberately NOT read from the request. It was interpolated
    // straight into the ElevenLabs URL path, and no caller has ever set it —
    // every client uses the default voice. Accepting it was an unnecessary
    // path-injection surface on a paid vendor call.
    const { token, text } = await request.json();

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
    }

    // Synthesis is billed per character, so the request must not be able to
    // choose the size of the bill. Real interviewer turns average 331
    // characters, so this is roughly 6x headroom over anything legitimate.
    const MAX_TTS_CHARS = 2000;
    if (typeof text !== "string" || text.length > MAX_TTS_CHARS) {
      return NextResponse.json(
        { error: `text must be a string of at most ${MAX_TTS_CHARS} characters` },
        { status: 400 }
      );
    }

    // Verify the candidate is authenticated
    const payload = verifyInterviewToken(token);

    // Synthesis is billed per character and is the largest single vendor cost
    // in the product, so this is the endpoint most worth bounding.
    const limited = await enforceRateLimit(
      `interview:tts:${payload.candidate_id}`,
      LIMITS.tts
    );
    if (limited) return limited;

    // Convert text to speech
    const audioBuffer = await textToSpeechStream(text);

    // Return audio as binary response
    return new NextResponse(audioBuffer, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": audioBuffer.byteLength.toString(),
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "TTS failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
