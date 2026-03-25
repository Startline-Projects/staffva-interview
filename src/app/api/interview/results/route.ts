import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  try {
    const interviewId = request.nextUrl.searchParams.get("id");
    const token = request.nextUrl.searchParams.get("token");

    if (!interviewId || !token) {
      return NextResponse.json({ error: "Missing id or token" }, { status: 400 });
    }

    const payload = verifyInterviewToken(token);
    const supabase = createSupabaseServiceClient();

    const { data: interview, error } = await supabase
      .from("ai_interviews")
      .select("id, overall_score, badge_level, technical_knowledge_score, problem_solving_score, communication_score, experience_depth_score, professionalism_score, technical_knowledge_feedback, problem_solving_feedback, communication_feedback, experience_depth_feedback, professionalism_feedback, strengths, weaknesses, improvement_feedback, perfect_score_path, passed, role_category")
      .eq("id", interviewId)
      .eq("candidate_id", payload.candidate_id)
      .single();

    if (error || !interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 });
    }

    return NextResponse.json({ interview });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load results";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
