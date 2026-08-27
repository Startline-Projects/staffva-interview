import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { transcribeAudio } from "@/lib/deepgram";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const token = formData.get("token") as string;
    const audioFile = formData.get("audio") as File;

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    if (!audioFile) {
      return NextResponse.json({ error: "Missing audio" }, { status: 400 });
    }

    // Billed per audio minute. The client records at most 45 seconds per answer
    // (HARD_TIMEOUT in LiveInterview), which is well under a megabyte of opus,
    // so this bounds the bill without touching any real recording.
    const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
    if (audioFile.size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        { error: "Audio file is too large" },
        { status: 413 }
      );
    }

    // Verify auth
    const payload = verifyInterviewToken(token);

    // Billed per audio minute. The client retries a failed transcription with
    // the same blob, so this also bounds a retry loop.
    const limited = await enforceRateLimit(
      `interview:stt:${payload.candidate_id}`,
      LIMITS.transcribe
    );
    if (limited) return limited;

    // Convert File to Buffer
    const arrayBuffer = await audioFile.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Transcribe
    const result = await transcribeAudio(buffer);

    return NextResponse.json({
      transcript: result.text,
      stt_confidence: result.confidence,
      stt_duration_s: result.durationSeconds,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Transcription failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
