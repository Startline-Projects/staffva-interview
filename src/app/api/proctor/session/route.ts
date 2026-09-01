import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * POST /api/proctor/session {token} — start (or resume) the camera-proctor
 * session for this candidate's AI interview. Same proctor_sessions table
 * and bucket as the platform; the platform's proctor-review cron reviews
 * both session kinds. Consent must already be stamped — the gate enforces
 * the order, this enforces the truth.
 */
export async function POST(req: NextRequest) {
  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.token !== "string") {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }
  let candidateId: string;
  try {
    candidateId = verifyInterviewToken(body.token).candidate_id;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const supabase = createSupabaseServiceClient();
  const { data: candidate } = await supabase
    .from("candidates")
    .select("id, proctor_consent_at")
    .eq("id", candidateId)
    .single();
  if (!candidate) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  if (!candidate.proctor_consent_at) {
    return NextResponse.json({ error: "Consent required first" }, { status: 403 });
  }

  // Resume a live session from the last hour (refresh mid-interview).
  const { data: open } = await supabase
    .from("proctor_sessions")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("session_kind", "ai_interview")
    .eq("review_status", "recording")
    .gte("started_at", new Date(Date.now() - 60 * 60 * 1000).toISOString())
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open) return NextResponse.json({ sessionId: open.id });

  const id = crypto.randomUUID();
  const { error } = await supabase.from("proctor_sessions").insert({
    id,
    candidate_id: candidateId,
    session_kind: "ai_interview",
    storage_prefix: `${candidateId}/ai_interview/${id}`,
  });
  if (error) return NextResponse.json({ error: "Could not start session" }, { status: 500 });

  return NextResponse.json({ sessionId: id });
}
