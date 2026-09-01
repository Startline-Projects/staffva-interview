import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * POST /api/proctor/session/[id]/end {token, attemptId?, cameraLostCount?}
 * Capture over → pending_review; attemptId binds the recording to its
 * ai_interviews row.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: { token?: unknown; attemptId?: unknown; cameraLostCount?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.token !== "string") {
    return NextResponse.json({ error: "Missing token" }, { status: 401 });
  }
  let candidateId: string;
  try {
    candidateId = verifyInterviewToken(body.token).candidate_id;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const supabase = createSupabaseServiceClient();
  const { data: session } = await supabase
    .from("proctor_sessions")
    .select("id, candidate_id, review_status")
    .eq("id", id)
    .single();
  if (!session || session.candidate_id !== candidateId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (session.review_status !== "recording") return NextResponse.json({ ok: true });

  await supabase
    .from("proctor_sessions")
    .update({
      review_status: "pending_review",
      ended_at: new Date().toISOString(),
      ...(typeof body.attemptId === "string" ? { attempt_id: body.attemptId } : {}),
      ...(typeof body.cameraLostCount === "number" && body.cameraLostCount >= 0
        ? { camera_lost_count: Math.min(Math.round(body.cameraLostCount), 100) }
        : {}),
    })
    .eq("id", id)
    .eq("review_status", "recording");

  return NextResponse.json({ ok: true });
}
