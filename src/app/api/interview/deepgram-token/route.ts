import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createDeepgramTemporaryKey } from "@/lib/deepgram";

export async function POST(request: NextRequest) {
  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    // Verify the candidate is authenticated
    verifyInterviewToken(token);

    // Generate a temporary Deepgram key for browser-side streaming
    const deepgramKey = await createDeepgramTemporaryKey();

    return NextResponse.json({ key: deepgramKey });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to generate Deepgram key";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
