import { NextResponse } from "next/server";
import { generateInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

// DEV ONLY — generates a test token for the first candidate in the database
// Remove this route before production deployment
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Not available in production" }, { status: 403 });
  }

  try {
    const supabase = createSupabaseServiceClient();
    const { data: candidate, error } = await supabase
      .from("candidates")
      .select("id, display_name, role_category")
      .limit(1)
      .single();

    if (error || !candidate) {
      return NextResponse.json({ error: "No candidates found" }, { status: 404 });
    }

    const token = generateInterviewToken(candidate.id);

    return NextResponse.json({
      candidate_id: candidate.id,
      display_name: candidate.display_name,
      role_category: candidate.role_category,
      token,
      test_url: `/api/auth/verify?token=${token}`,
      interview_url: `/interview?token=${token}`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
