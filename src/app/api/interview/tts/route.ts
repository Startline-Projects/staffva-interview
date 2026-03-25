import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
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
    verifyInterviewToken(token);

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
