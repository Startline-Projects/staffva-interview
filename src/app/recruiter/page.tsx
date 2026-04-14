import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/get-session-user";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import RecruiterCandidateTable from "./RecruiterCandidateTable";

export interface CandidateRow {
  interviewId: string;
  displayName: string;
  country: string;
  roleCategory: string;
  overallScore: number;
  badgeLevel: string;
  secondInterviewStatus: string | null;
  secondInterviewOverall: number | null;
  speakingLevel: string | null;
  preInterviewGuide: string | null;
}

export default async function RecruiterDashboard() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const supabase = await createSupabaseServerClient();

  // Look up profile by email
  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name")
    .eq("email", user.email)
    .single();

  if (!profile) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">Recruiter profile not found</p>
      </div>
    );
  }

  const recruiterName = profile.full_name || "Recruiter";

  // Get assigned role categories
  const { data: assignments } = await supabase
    .from("recruiter_assignments")
    .select("role_category")
    .eq("recruiter_id", profile.id);

  if (!assignments || assignments.length === 0) {
    return (
      <div>
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-2xl font-bold">My Candidates</h1>
          <p className="text-gray-500 text-sm">{recruiterName}</p>
        </div>
        <div className="bg-gray-900 rounded-xl p-12 text-center border border-gray-800">
          <p className="text-gray-500">
            No candidates assigned yet. Your assigned role categories will appear here once candidates complete their AI interview.
          </p>
        </div>
      </div>
    );
  }

  const roleCategories = assignments.map((a) => a.role_category);

  // Query ai_interviews with candidate join
  const { data: interviews, error: intErr } = await supabase
    .from("ai_interviews")
    .select(
      "id, candidate_id, role_category, overall_score, badge_level, second_interview_status, second_interview_overall, speaking_level, pre_interview_guide, completed_at, candidates!inner(display_name, country)"
    )
    .in("role_category", roleCategories)
    .not("completed_at", "is", null)
    .eq("passed", true)
    .order("completed_at", { ascending: false });

  if (intErr) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">Failed to load candidates: {intErr.message}</p>
      </div>
    );
  }

  const candidates: CandidateRow[] = (interviews || []).map((row: Record<string, unknown>) => {
    const cand = row.candidates as Record<string, string>;
    return {
      interviewId: row.id as string,
      displayName: cand?.display_name || "Unknown",
      country: cand?.country || "Unknown",
      roleCategory: row.role_category as string,
      overallScore: row.overall_score as number,
      badgeLevel: row.badge_level as string,
      secondInterviewStatus: row.second_interview_status as string | null,
      secondInterviewOverall: row.second_interview_overall as number | null,
      speakingLevel: row.speaking_level as string | null,
      preInterviewGuide: row.pre_interview_guide as string | null,
    };
  });

  return (
    <RecruiterCandidateTable
      recruiterName={recruiterName}
      candidates={candidates}
    />
  );
}
