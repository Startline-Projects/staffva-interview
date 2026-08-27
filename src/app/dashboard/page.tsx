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

  // Which candidates may this recruiter see?
  //
  // This used to read interviewer_delegation, which was the SECOND-INTERVIEW
  // routing table: it stores 12 group names ("Support and Admin") while
  // ai_interviews.role_category stores job titles ("Virtual Assistant"). They
  // intersect on one value by coincidence, so the filter below exposed 2 of the
  // 30 passed interviews and silently hid the other 28. That was survivable only
  // because recruiters reached transcripts through /recruiter instead; with that
  // page gone this is the only route in, so it had to be fixed rather than moved.
  //
  // recruiter_assignments speaks the same job titles as ai_interviews.
  // Measured: 30 of 30 passed interviews resolve through it.
  const { data: profile } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", user.email)
    .maybeSingle();

  const { data: assignments } = profile
    ? await supabase
        .from("recruiter_assignments")
        .select("role_category")
        .eq("recruiter_id", profile.id)
    : { data: null };

  const assignedCategories = assignments?.map((a: { role_category: string }) => a.role_category) || [];

  // Get passed interviews for assigned categories
  const { data: interviews } = await supabase
    .from("ai_interviews")
    .select("id, candidate_id, role_category, overall_score, badge_level, passed, completed_at")
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
          <p className="text-gray-500">No candidates have passed the interview in your categories yet.</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {interviews.map((interview: {
            id: string;
            candidate_id: string;
            role_category: string;
            overall_score: number;
            badge_level: string;
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
