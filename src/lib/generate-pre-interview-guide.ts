import { createSupabaseServiceClient } from "@/lib/supabase/server";

interface InterviewRecord {
  id: string;
  role_category: string;
  overall_score: number;
  badge_level: string;
  technical_knowledge_score: number;
  problem_solving_score: number;
  communication_score: number;
  experience_depth_score: number;
  professionalism_score: number;
  ai_notes: string;
  improvement_feedback: string;
}

const DIMENSION_LABELS: Record<string, string> = {
  technical_knowledge_score: "Technical Knowledge",
  problem_solving_score: "Problem Solving",
  communication_score: "Communication",
  experience_depth_score: "Experience Depth",
  professionalism_score: "Professionalism",
};

export async function generatePreInterviewGuide(
  interview: InterviewRecord
): Promise<string> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();

  const systemPrompt =
    "You are a recruiter preparation specialist for a professional offshore talent " +
    "marketplace. You generate pre-interview guides for human recruiters who will " +
    "conduct a second interview with a candidate. The recruiters are not experts in " +
    "the candidate's field — they are professional interviewers. Your guide gives " +
    "them verbatim questions to read, follow-up probes, and red flags to watch for. " +
    "The recruiter does not need to evaluate the answers in real time — they ask the " +
    "questions and report what was said. The AI will score the transcript afterward.";

  const dimensionScores = [
    { key: "technical_knowledge_score", score: interview.technical_knowledge_score },
    { key: "problem_solving_score", score: interview.problem_solving_score },
    { key: "communication_score", score: interview.communication_score },
    { key: "experience_depth_score", score: interview.experience_depth_score },
    { key: "professionalism_score", score: interview.professionalism_score },
  ];

  const dimensionSummary = dimensionScores
    .map((d) => {
      const label = DIMENSION_LABELS[d.key];
      const flagged = d.score < 14 ? " [FLAGGED — below 14/20]" : "";
      return `- ${label}: ${d.score}/20${flagged}`;
    })
    .join("\n");

  const userMessage =
    `CANDIDATE ROLE CATEGORY: ${interview.role_category}\n\n` +
    `FIRST INTERVIEW OVERALL SCORE: ${interview.overall_score}/100\n` +
    `BADGE LEVEL: ${interview.badge_level}\n\n` +
    `DIMENSION SCORES:\n${dimensionSummary}\n\n` +
    `AI NOTES FROM FIRST INTERVIEW:\n${interview.ai_notes || "None"}\n\n` +
    `IMPROVEMENT FEEDBACK FROM FIRST INTERVIEW:\n${interview.improvement_feedback || "None"}\n\n` +
    `Generate the pre-interview guide with these exact sections:\n\n` +
    `OPENING (2 sentences the recruiter says to open the call — warm, professional)\n\n` +
    `DIMENSION QUESTIONS (for each of the five dimensions — Technical Knowledge, ` +
    `Problem Solving, Communication, Experience Depth, Professionalism — provide:\n` +
    `  - 2 verbatim questions the recruiter reads exactly as written\n` +
    `  - 1 follow-up probe if the candidate gives a vague answer\n` +
    `  - Note: flag this dimension if first interview score was below 14/20)\n\n` +
    `RED FLAGS FROM FIRST INTERVIEW\n` +
    `(bullet list of specific things the AI flagged in the first interview that the ` +
    `recruiter should watch for or probe further — pulled from ai_notes and improvement_feedback)\n\n` +
    `CLOSING (1 sentence the recruiter says to close — professional and warm)\n\n` +
    `RECRUITER REMINDERS (3 bullet points):\n` +
    `- You do not need to evaluate the answers — just ask and document\n` +
    `- If the candidate goes off topic redirect with: "That's helpful — can you give me a specific example from your work?"\n` +
    `- Note anything that feels evasive, inconsistent, or overly rehearsed\n\n` +
    `Max length: 800 words. Plain text only. No markdown headers with # symbols.`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
  });

  const content = response.content[0];
  if (content.type !== "text") {
    throw new Error("Unexpected response type from Claude");
  }

  return content.text;
}

/**
 * Generates and saves the pre-interview guide for a completed interview.
 * Safe to call fire-and-forget — logs errors internally.
 */
export async function generateAndSaveGuide(
  interview: InterviewRecord
): Promise<void> {
  try {
    const guide = await generatePreInterviewGuide(interview);
    const supabase = createSupabaseServiceClient();

    const { error } = await supabase
      .from("ai_interviews")
      .update({
        pre_interview_guide: guide,
        pre_interview_guide_generated_at: new Date().toISOString(),
      })
      .eq("id", interview.id);

    if (error) {
      console.error(
        `[PRE-INTERVIEW GUIDE] Failed to save guide for interview ${interview.id}:`,
        error.message
      );
    } else {
      console.log(
        `[PRE-INTERVIEW GUIDE] Guide generated and saved for interview ${interview.id}`
      );
    }
  } catch (err) {
    console.error(
      `[PRE-INTERVIEW GUIDE] Generation failed for interview ${interview.id}:`,
      err
    );
  }
}
