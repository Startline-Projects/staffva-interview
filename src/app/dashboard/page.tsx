import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/get-session-user";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import Link from "next/link";

export default async function RecruiterDashboard() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  // Admin goes to admin dashboard
  if (user.role === "admin") redirect("/dashboard/admin");

  const supabase = createSupabaseServiceClient();

  // Get role categories assigned to this recruiter
  const { data: delegations } = await supabase
    .from("interviewer_delegation")
    .select("role_category")
    .eq("interviewer_email", user.email);

  const assignedCategories = delegations?.map((d: { role_category: string }) => d.role_category) || [];

  // Get passed interviews for assigned categories
  const { data: interviews } = await supabase
    .from("ai_interviews")
    .select("id, candidate_id, role_category, overall_score, badge_level, passed, second_interview_status, completed_at")
    .eq("passed", true)
    .in("role_category", assignedCategories.length > 0 ? assignedCategories : ["__none__"])
    .order("completed_at", { ascending: false });

  // Get candidate names
  const candidateIds = [...new Set(interviews?.map((i: { candidate_id: string }) => i.candidate_id) || [])];
  let candidateMap: Record<string, { display_name: string }> = {};

  if (candidateIds.length > 0) {
    const { data: candidates } = await supabase
      .from("candidates")
      .select("id, display_name")
      .in("id", candidateIds);

    candidateMap = Object.fromEntries(
      (candidates || []).map((c: { id: string; display_name: string }) => [c.id, c])
    );
  }

  const badgeColors: Record<string, string> = {
    exceptional: "bg-amber-700 text-amber-100",
    proficient: "bg-amber-600/50 text-amber-200",
    developing: "bg-gray-600 text-gray-200",
    not_ready: "bg-gray-700 text-gray-400",
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold">Your Candidates</h2>
        <p className="text-gray-500 mt-1">
          Candidates who passed the AI interview in: {assignedCategories.join(", ") || "No categories assigned"}
        </p>
      </div>

      {(!interviews || interviews.length === 0) ? (
        <div className="bg-gray-900 rounded-xl p-8 text-center">
          <p className="text-gray-500">No candidates awaiting second interview yet.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {interviews.map((interview: {
            id: string;
            candidate_id: string;
            role_category: string;
            overall_score: number;
            badge_level: string;
            second_interview_status: string;
            completed_at: string;
          }) => {
            const candidate = candidateMap[interview.candidate_id];
            return (
              <div key={interview.id} className="bg-gray-900 rounded-xl p-5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div>
                    <p className="font-semibold">{candidate?.display_name || "Unknown"}</p>
                    <p className="text-gray-500 text-sm">{interview.role_category}</p>
                  </div>
                  <span className={"px-3 py-1 rounded-full text-xs font-medium " + (badgeColors[interview.badge_level] || "bg-gray-700 text-gray-300")}>
                    {interview.badge_level}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <p className="text-lg font-bold">{interview.overall_score}/100</p>
                    <p className="text-gray-500 text-xs">
                      {interview.completed_at ? new Date(interview.completed_at).toLocaleDateString() : ""}
                    </p>
                  </div>
                  <span className={"px-2 py-1 rounded text-xs " + (
                    interview.second_interview_status === "completed" ? "bg-green-900 text-green-300" :
                    interview.second_interview_status === "scheduled" ? "bg-blue-900 text-blue-300" :
                    "bg-gray-800 text-gray-400"
                  )}>
                    {interview.second_interview_status || "pending"}
                  </span>
                  <Link
                    href={"/dashboard/interview/" + interview.id}
                    className="px-4 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm font-medium transition-colors"
                  >
                    View Results
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
