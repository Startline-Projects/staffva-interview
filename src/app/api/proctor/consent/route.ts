import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PROCTOR_CONSENT_VERSION } from "@/lib/proctorConsent";

/**
 * Proctoring consent, interview-app side (the counsel draft requires the
 * consent be collectable in BOTH apps — a candidate whose test predates
 * proctoring reaches the interview without a stamp).
 *
 * GET  ?token=  → { consented } — has this candidate's affirmative act
 *                been recorded at the current version? (2.1 — see
 *                lib/proctorConsent for what that version covers.)
 * POST {token}  → stamp v2.0 with a timestamp at the act.
 */
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token");
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 400 });
  let candidateId: string;
  try {
    candidateId = verifyInterviewToken(token).candidate_id;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const supabase = createSupabaseServiceClient();
  const { data } = await supabase
    .from("candidates")
    .select("proctor_consent_version")
    .eq("id", candidateId)
    .single();
  return NextResponse.json({ consented: data?.proctor_consent_version === PROCTOR_CONSENT_VERSION });
}

export async function POST(req: NextRequest) {
  let body: { token?: unknown; version?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body.token !== "string") {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }
  if (body.version !== PROCTOR_CONSENT_VERSION) {
    return NextResponse.json({ error: "Unknown consent version" }, { status: 400 });
  }
  let candidateId: string;
  try {
    candidateId = verifyInterviewToken(body.token).candidate_id;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }
  const supabase = createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("candidates")
    .update({ proctor_consent_version: PROCTOR_CONSENT_VERSION, proctor_consent_at: new Date().toISOString() })
    .eq("id", candidateId)
    .select("id");
  if (error || !data?.length) {
    return NextResponse.json({ error: "Could not record consent" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
