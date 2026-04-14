import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/get-session-user";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import SecondInterviewClient from "./SecondInterviewClient";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function SecondInterviewPage({ params }: Props) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id: interviewId } = await params;
  const supabase = await createSupabaseServerClient();

  const { data: interviewData, error: intError } = await supabase
    .from("ai_interviews")
    .select("*")
    .eq("id", interviewId)
    .single();

  if (intError || !interviewData) {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-red-400">Interview not found</p>
      </div>
    );
  }

  const { data: candidateData } = await supabase
    .from("candidates")
    .select("display_name, country, role_category, voice_recording_1_url, voice_recording_2_url")
    .eq("id", interviewData.candidate_id)
    .single();

  return (
    <SecondInterviewClient
      interviewId={interviewId}
      initialInterview={interviewData}
      initialCandidate={candidateData}
    />
  );
}
