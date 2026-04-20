import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token) {
    return NextResponse.json(
      { error: "Missing token parameter" },
      { status: 400 }
    );
  }

  try {
    const payload = verifyInterviewToken(token);

    const supabase = createSupabaseServiceClient();
    const { data: candidate, error } = await supabase
      .from("candidates")
      .select(
        "id, display_name, country, role_category, english_written_tier, bio, us_client_experience"
      )
      .eq("id", payload.candidate_id)
      .single();

    if (error && error.code !== "PGRST116") {
      console.error("Supabase candidate lookup failed:", error);
      return NextResponse.json(
        { error: "Database error during candidate lookup" },
        { status: 500 }
      );
    }

    if (!candidate) {
      return NextResponse.json(
        { error: "Candidate not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({ candidate });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid token";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
