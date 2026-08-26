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

  // Deliberately NOT an early return on "no role categories". A recruiter can
  // have zero recruiter_assignments and still have interviews routed to them by
  // name — that is exactly the case for the two candidates currently routed to
  // test-recruiter-eng@staffva.com, who has no assignments at all. Returning
  // here told them they had nothing while two people waited.
  const roleCategories = (assignments ?? []).map((a) => a.role_category);

  const SELECT_COLUMNS =
    "id, candidate_id, role_category, overall_score, badge_level, second_interview_status, second_interview_overall, speaking_level, pre_interview_guide, completed_at, candidates!inner(display_name, country)";

  // Two queries rather than one, because "my candidates" has two meanings and
  // listing only the first hid the second.
  //
  // This page filtered on role_category alone. But interviews are ROUTED by
  // resolve_second_interviewer, which prefers the candidate's assigned
  // recruiter — and a recruiter can be assigned a candidate without owning that
  // candidate's role category. So an interview could be routed to someone whose
  // dashboard would never list it. Measured across the 29 candidates who have
  // passed: 9 were routed to a recruiter who could not see them, including all
  // 3 of Jerome's.
  //
  // Done as two requests and merged, rather than one PostgREST .or(), because
  // an .or() containing an in.() list has to inline role category values like
  // "UI/UX and Writing" into the filter string, where the slash and spaces are
  // an escaping hazard for no benefit.
  const base = () =>
    supabase
      .from("ai_interviews")
      .select(SELECT_COLUMNS)
      .not("completed_at", "is", null)
      .eq("passed", true);

  const [byCategory, byRouting] = await Promise.all([
    // An empty .in() list is not worth asking PostgREST about.
    roleCategories.length > 0
      ? base().in("role_category", roleCategories)
      : Promise.resolve({ data: [], error: null }),
    // An empty email would match on nothing useful and is worth skipping too.
    user.email
      ? base().ilike("second_interviewer_email", user.email)
      : Promise.resolve({ data: [], error: null }),
  ]);

  const intErr = byCategory.error || byRouting.error;

  if (intErr) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-red-400">Failed to load candidates: {intErr.message}</p>
      </div>
    );
  }

  // Deduplicate: an interview both routed to this recruiter AND in one of their
  // categories comes back from both queries.
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of [...(byCategory.data ?? []), ...(byRouting.data ?? [])]) {
    byId.set((row as Record<string, unknown>).id as string, row as Record<string, unknown>);
  }

  const interviews = [...byId.values()].sort((a, b) =>
    String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? ""))
  );

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
