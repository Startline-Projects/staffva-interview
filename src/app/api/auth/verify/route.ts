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
        "id, display_name, country, role_category, english_written_tier, bio, us_client_experience, interview1_passed, ai_interview_passed"
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

    // Which interview does this candidate face? Pre-split candidates with
    // skills-exam history are grandfathered onto that track (the session
    // route enforces the same rule server-side).
    const { count: skillsHistory } = await supabase
      .from("ai_interviews")
      .select("*", { count: "exact", head: true })
      .eq("candidate_id", candidate.id)
      .eq("kind", "skills");

    return NextResponse.json({ candidate, skillsHistory: (skillsHistory || 0) > 0 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Invalid token";
    return NextResponse.json({ error: message }, { status: 401 });
  }
}
