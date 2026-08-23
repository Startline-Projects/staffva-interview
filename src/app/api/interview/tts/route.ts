import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { textToSpeechStream } from "@/lib/elevenlabs";

export async function POST(request: NextRequest) {
  try {
    const { token, text, voiceId } = await request.json();

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    if (!text) {
      return NextResponse.json({ error: "Missing text" }, { status: 400 });
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
    const audioBuffer = await textToSpeechStream(text, voiceId);

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
