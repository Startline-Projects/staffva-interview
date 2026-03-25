import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/get-session-user";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import InterviewStatusUpdater from "@/components/InterviewStatusUpdater";
import Link from "next/link";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function InterviewDetailPage({ params }: PageProps) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const supabase = createSupabaseServiceClient();

  const { data: interview, error } = await supabase
    .from("ai_interviews")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !interview) {
    return <div className="text-center py-12 text-gray-500">Interview not found.</div>;
  }

  // Get candidate info
  const { data: candidate } = await supabase
    .from("candidates")
    .select("id, display_name, country, role_category, bio")
    .eq("id", interview.candidate_id)
    .single();

  // Access check: recruiter can only see their assigned categories
  if (user.role === "recruiter") {
    const { data: delegations } = await supabase
      .from("interviewer_delegation")
      .select("role_category")
      .eq("interviewer_email", user.email);

    const assignedCategories = delegations?.map((d: { role_category: string }) => d.role_category) || [];
    if (!assignedCategories.includes(interview.role_category)) {
      return <div className="text-center py-12 text-gray-500">You do not have access to this interview.</div>;
    }
  }

  const dimensions = [
    { label: "Technical Knowledge", score: interview.technical_knowledge_score, feedback: interview.technical_knowledge_feedback },
    { label: "Problem Solving & Judgment", score: interview.problem_solving_score, feedback: interview.problem_solving_feedback },
    { label: "Communication Clarity", score: interview.communication_score, feedback: interview.communication_feedback },
    { label: "Experience Depth", score: interview.experience_depth_score, feedback: interview.experience_depth_feedback },
    { label: "Professionalism & Reliability", score: interview.professionalism_score, feedback: interview.professionalism_feedback },
  ];

  const transcript = interview.transcript || [];

  const badgeColors: Record<string, string> = {
    exceptional: "bg-amber-700 text-amber-100",
    proficient: "bg-amber-600/50 text-amber-200",
    developing: "bg-gray-600 text-gray-200",
    not_ready: "bg-gray-700 text-gray-400",
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* Back link */}
      <Link href={user.role === "admin" ? "/dashboard/admin" : "/dashboard"} className="text-gray-500 hover:text-white text-sm mb-6 inline-block">
        &larr; Back to dashboard
      </Link>

      {/* Candidate header */}
      <div className="bg-gray-900 rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold">{candidate?.display_name || "Unknown"}</h2>
            <p className="text-gray-400">{interview.role_category} — {candidate?.country}</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold">{interview.overall_score}/100</p>
            <span className={"inline-block px-3 py-1 rounded-full text-sm font-medium mt-1 " + (badgeColors[interview.badge_level] || "bg-gray-700")}>
              {interview.badge_level}
            </span>
          </div>
        </div>
        {candidate?.bio && <p className="text-gray-500 text-sm mt-3">{candidate.bio}</p>}
        <div className="mt-4">
          <a
            href={process.env.NEXT_PUBLIC_STAFFVA_URL + "/candidate/" + interview.candidate_id}
            target="_blank"
            className="text-amber-500 hover:text-amber-400 text-sm"
          >
            View StaffVA Profile &rarr;
          </a>
        </div>
      </div>

      {/* Second interview status */}
      {user.role === "recruiter" && (
        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h3 className="font-semibold mb-3">Second Interview Status</h3>
          <InterviewStatusUpdater
            interviewId={interview.id}
            currentStatus={interview.second_interview_status || "pending"}
          />
        </div>
      )}

      {/* Dimension scores */}
      <div className="bg-gray-900 rounded-xl p-6 mb-6">
        <h3 className="font-semibold mb-4">Scorecard</h3>
        <div className="space-y-4">
          {dimensions.map((dim) => (
            <div key={dim.label}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm">{dim.label}</span>
                <span className="font-bold">{dim.score ?? "—"}/20</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2 mb-1">
                <div
                  className="bg-amber-600 h-2 rounded-full"
                  style={{ width: ((dim.score || 0) / 20 * 100) + "%" }}
                />
              </div>
              {dim.feedback && <p className="text-gray-500 text-sm">{dim.feedback}</p>}
            </div>
          ))}
        </div>
      </div>

      {/* Strengths, weaknesses, improvement */}
      <div className="grid md:grid-cols-2 gap-6 mb-6">
        {interview.strengths && (
          <div className="bg-gray-900 rounded-xl p-6">
            <h3 className="font-semibold mb-2 text-green-400">Strengths</h3>
            <p className="text-gray-400 text-sm">{interview.strengths}</p>
          </div>
        )}
        {interview.weaknesses && (
          <div className="bg-gray-900 rounded-xl p-6">
            <h3 className="font-semibold mb-2 text-red-400">Areas to Improve</h3>
            <p className="text-gray-400 text-sm">{interview.weaknesses}</p>
          </div>
        )}
      </div>

      {/* AI notes */}
      {interview.ai_notes && (
        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h3 className="font-semibold mb-2">AI Interviewer Notes</h3>
          <p className="text-gray-400 text-sm">{interview.ai_notes}</p>
        </div>
      )}

      {/* Suggested focus areas */}
      {interview.improvement_feedback && (
        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h3 className="font-semibold mb-2">Suggested Focus Areas for Second Interview</h3>
          <p className="text-gray-400 text-sm">{interview.improvement_feedback}</p>
        </div>
      )}

      {/* Full transcript */}
      <div className="bg-gray-900 rounded-xl p-6 mb-6">
        <h3 className="font-semibold mb-4">Full Transcript</h3>
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {transcript.map((entry: { role: string; text: string }, i: number) => (
            <div key={i} className={"rounded-lg px-4 py-3 " + (
              entry.role === "interviewer" ? "bg-gray-800 text-gray-300" : "bg-amber-900/20 text-amber-100"
            )}>
              <span className="text-xs text-gray-600 block mb-1">
                {entry.role === "interviewer" ? "Alex" : candidate?.display_name || "Candidate"}
              </span>
              {entry.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
