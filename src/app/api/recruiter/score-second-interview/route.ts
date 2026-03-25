import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { interviewId, transcript } = body;

    if (!interviewId || !transcript) {
      return NextResponse.json(
        { error: "Missing required fields: interviewId, transcript" },
        { status: 400 }
      );
    }

    // Verify recruiter is authenticated
    const supabaseAuth = await createSupabaseServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const role = user.user_metadata?.interview_role;
    const recruiterName = user.user_metadata?.interview_name || "Recruiter";
    const recruiterEmail = user.email || "";

    if (role !== "admin" && role !== "recruiter") {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const supabase = createSupabaseServiceClient();

    // Load the interview with first interview scores
    const { data: interview, error: fetchError } = await supabase
      .from("ai_interviews")
      .select("*")
      .eq("id", interviewId)
      .single();

    if (fetchError || !interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 });
    }

    // Check recruiter has access to this role category (admin sees all)
    if (role === "recruiter") {
      const { data: delegations } = await supabase
        .from("interviewer_delegation")
        .select("role_category")
        .eq("interviewer_email", recruiterEmail);

      const assignedCategories = (delegations || []).map((d: { role_category: string }) => d.role_category);
      if (!assignedCategories.includes(interview.role_category)) {
        return NextResponse.json({ error: "Not authorized for this candidate's role category" }, { status: 403 });
      }
    }

    // Check not already scored
    if (interview.second_interview_overall) {
      return NextResponse.json({
        error: "Second interview already scored",
        alreadyScored: true,
        interview,
      }, { status: 400 });
    }

    // Load candidate profile
    const { data: candidate } = await supabase
      .from("candidates")
      .select("id, display_name, role_category, country, email")
      .eq("id", interview.candidate_id)
      .single();

    // Call Claude to score the second interview (no speaking level yet)
    const scores = await scoreSecondInterview(interview, candidate, transcript);

    // Save results to ai_interviews (no speaking_level yet, no Sam email yet)
    const { error: updateError } = await supabase
      .from("ai_interviews")
      .update({
        second_interview_transcript: transcript,
        second_interview_scored_at: new Date().toISOString(),
        second_interview_overall: scores.second_overall,
        second_interview_technical: scores.second_technical,
        second_interview_problem: scores.second_problem,
        second_interview_communication: scores.second_communication,
        second_interview_experience: scores.second_experience,
        second_interview_professionalism: scores.second_professionalism,
        second_interview_feedback: scores.feedback,
        second_interview_ai_notes: scores.ai_notes,
        combined_score: scores.combined_score,
        combined_recommendation: scores.recommendation,
        combined_recommendation_reason: scores.recommendation_reason,
        second_interview_status: "completed",
        second_interview_recruiter_email: recruiterEmail,
        second_interview_recruiter_name: recruiterName,
      })
      .eq("id", interviewId);

    if (updateError) {
      return NextResponse.json({ error: "Failed to save scores: " + updateError.message }, { status: 500 });
    }

    return NextResponse.json({
      scored: true,
      scores: {
        second_technical: scores.second_technical,
        second_problem: scores.second_problem,
        second_communication: scores.second_communication,
        second_experience: scores.second_experience,
        second_professionalism: scores.second_professionalism,
        second_overall: scores.second_overall,
        combined_score: scores.combined_score,
        recommendation: scores.recommendation,
        recommendation_reason: scores.recommendation_reason,
        feedback: scores.feedback,
        ai_notes: scores.ai_notes,
      },
      first_interview: {
        overall_score: interview.overall_score,
        badge_level: interview.badge_level,
        technical_knowledge_score: interview.technical_knowledge_score,
        problem_solving_score: interview.problem_solving_score,
        communication_score: interview.communication_score,
        experience_depth_score: interview.experience_depth_score,
        professionalism_score: interview.professionalism_score,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scoring failed";
    console.error("Second interview scoring error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

interface SecondInterviewScores {
  second_technical: number;
  second_problem: number;
  second_communication: number;
  second_experience: number;
  second_professionalism: number;
  second_overall: number;
  combined_score: number;
  recommendation: "pass" | "hold" | "reject";
  recommendation_reason: string;
  feedback: string;
  ai_notes: string;
}

async function scoreSecondInterview(
  interview: Record<string, unknown>,
  candidate: Record<string, unknown> | null,
  transcript: string
): Promise<SecondInterviewScores> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();

  const systemPrompt = `You are scoring a second human interview for a professional offshore talent marketplace. You will receive the candidate's first interview scorecard and a transcript of their second interview conducted by a human recruiter. Score the second interview on the same five dimensions as the first. Weight experience depth and professionalism higher in the second interview because the first interview already tested technical knowledge. Return ONLY valid JSON — no markdown, no preamble, no explanation outside the JSON.`;

  const userMessage = `CANDIDATE PROFILE:
Role: ${candidate?.role_category || interview.role_category}
Country: ${candidate?.country || "Unknown"}
First interview overall score: ${interview.overall_score}/100
First interview badge: ${interview.badge_level}

FIRST INTERVIEW SCORES:
Technical Knowledge: ${interview.technical_knowledge_score}/20
Problem Solving: ${interview.problem_solving_score}/20
Communication Clarity: ${interview.communication_score}/20
Experience Depth: ${interview.experience_depth_score}/20
Professionalism: ${interview.professionalism_score}/20

FIRST INTERVIEW AI NOTES:
${interview.ai_notes || "None"}

SECOND INTERVIEW TRANSCRIPT:
${transcript}

Score this second interview on these five dimensions (each out of 20):
Technical Knowledge (15% weight in second interview — first interview already tested this heavily)
Problem Solving and Judgment (20% weight)
Communication Clarity (20% weight)
Relevant Experience Depth (25% weight — probe for specificity and consistency with first interview claims)
Professionalism and Reliability (20% weight — how they handled difficult questions, spoke about past employers, demonstrated accountability)

After scoring all five dimensions calculate:
- second_overall: sum of all five dimension scores
- combined_score: (first_interview_overall * 0.45) + (second_overall * 0.55), rounded to nearest integer
Based on combined_score determine recommendation:
- 60 or above: pass
- 50-59 or any professionalism score below 12: hold
- Below 50: reject
- Regardless of score — reject if transcript shows: no portfolio, cannot demonstrate tool knowledge, evasive about availability, speaks negatively about past clients, cannot substantiate experience claims under follow-up

Return exactly this JSON structure and nothing else:
{
  "second_technical": integer,
  "second_problem": integer,
  "second_communication": integer,
  "second_experience": integer,
  "second_professionalism": integer,
  "second_overall": integer,
  "combined_score": integer,
  "recommendation": "pass" or "hold" or "reject",
  "recommendation_reason": "one paragraph specific explanation referencing actual moments from the transcript",
  "feedback": "two to three paragraphs of specific actionable feedback — strengths observed in second interview, gaps identified, and for hold or reject candidates what they would need to improve",
  "ai_notes": "bullet points of specific flags, standout moments, inconsistencies noticed in the transcript that Sam should be aware of when reviewing"
}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const content = response.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  let jsonText = content.text;
  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonText = jsonMatch[0];
  }

  const scores = JSON.parse(jsonText);

  const secondOverall =
    (scores.second_technical || 0) +
    (scores.second_problem || 0) +
    (scores.second_communication || 0) +
    (scores.second_experience || 0) +
    (scores.second_professionalism || 0);

  const firstOverall = Number(interview.overall_score) || 0;
  const combinedScore = Math.round(firstOverall * 0.45 + secondOverall * 0.55);

  let recommendation: "pass" | "hold" | "reject" = scores.recommendation || "hold";
  if (combinedScore >= 60 && (scores.second_professionalism || 0) >= 12) {
    recommendation = "pass";
  } else if (combinedScore >= 50 || (scores.second_professionalism || 0) < 12) {
    recommendation = "hold";
  }
  if (combinedScore < 50) {
    recommendation = "reject";
  }
  if (scores.recommendation === "reject") {
    recommendation = "reject";
  }

  return {
    second_technical: scores.second_technical || 0,
    second_problem: scores.second_problem || 0,
    second_communication: scores.second_communication || 0,
    second_experience: scores.second_experience || 0,
    second_professionalism: scores.second_professionalism || 0,
    second_overall: secondOverall,
    combined_score: combinedScore,
    recommendation,
    recommendation_reason: scores.recommendation_reason || "",
    feedback: scores.feedback || "",
    ai_notes: scores.ai_notes || "",
  };
}
