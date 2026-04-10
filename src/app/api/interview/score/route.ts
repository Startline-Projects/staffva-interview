import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { sendCandidateResultsEmail, sendDelegationEmail } from "@/lib/emails/send-results";
import { generateAndSaveGuide } from "@/lib/generate-pre-interview-guide";

interface TranscriptEntry {
  role: "interviewer" | "candidate";
  text: string;
}

interface Scorecard {
  overall_score: number;
  badge_level: string;
  technical_knowledge_score: number;
  problem_solving_score: number;
  communication_score: number;
  experience_depth_score: number;
  professionalism_score: number;
  technical_knowledge_feedback: string;
  problem_solving_feedback: string;
  communication_feedback: string;
  experience_depth_feedback: string;
  professionalism_feedback: string;
  strengths: string;
  weaknesses: string;
  improvement_feedback: string;
  perfect_score_path: string;
  ai_notes: string;
  passed: boolean;
}

export async function POST(request: NextRequest) {
  try {
    const { token, interviewId } = await request.json();

    if (!token || !interviewId) {
      return NextResponse.json({ error: "Missing token or interviewId" }, { status: 400 });
    }

    const payload = verifyInterviewToken(token);
    const supabase = createSupabaseServiceClient();

    // Load interview
    const { data: interview, error: fetchError } = await supabase
      .from("ai_interviews")
      .select("*")
      .eq("id", interviewId)
      .eq("candidate_id", payload.candidate_id)
      .single();

    if (fetchError || !interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 });
    }

    if (interview.overall_score) {
      // Already scored
      return NextResponse.json({ scored: true, interview });
    }

    // Return immediately — scoring continues in the background via after()
    after(async () => {
      try {
        await performScoring(interview, payload.candidate_id);
      } catch (err) {
        console.error("Background scoring failed:", err);
      }
    });

    return NextResponse.json({ scored: false, scoring_started: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scoring failed";
    console.error("Scoring error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function performScoring(
  interview: Record<string, unknown>,
  candidateId: string
) {
  const supabase = createSupabaseServiceClient();

  // Load candidate
  const { data: candidate } = await supabase
    .from("candidates")
    .select("id, display_name, role_category, country, email")
    .eq("id", candidateId)
    .single();

  // Load interview config for pass threshold
  const { data: config } = await supabase
    .from("interview_config")
    .select("pass_threshold")
    .eq("company_id", "staffva")
    .single();

  const passThreshold = config?.pass_threshold || 60;

  // Build transcript text for Claude
  const transcript: TranscriptEntry[] = (interview.transcript as TranscriptEntry[]) || [];
  const transcriptText = transcript.map((e: TranscriptEntry) => {
    return (e.role === "interviewer" ? "ALEX: " : "CANDIDATE: ") + e.text;
  }).join("\n\n");

  // Generate scorecard via Claude
  const scorecard = await generateScorecard(
    candidate?.display_name || "Candidate",
    candidate?.role_category || (interview.role_category as string),
    candidate?.country || "Unknown",
    transcriptText,
    passThreshold
  );

  // Update interview record with scores
  const { error: updateError } = await supabase
    .from("ai_interviews")
    .update({
      overall_score: scorecard.overall_score,
      badge_level: scorecard.badge_level,
      technical_knowledge_score: scorecard.technical_knowledge_score,
      problem_solving_score: scorecard.problem_solving_score,
      communication_score: scorecard.communication_score,
      experience_depth_score: scorecard.experience_depth_score,
      professionalism_score: scorecard.professionalism_score,
      technical_knowledge_feedback: scorecard.technical_knowledge_feedback,
      problem_solving_feedback: scorecard.problem_solving_feedback,
      communication_feedback: scorecard.communication_feedback,
      experience_depth_feedback: scorecard.experience_depth_feedback,
      professionalism_feedback: scorecard.professionalism_feedback,
      strengths: scorecard.strengths,
      weaknesses: scorecard.weaknesses,
      improvement_feedback: scorecard.improvement_feedback,
      perfect_score_path: scorecard.perfect_score_path,
      ai_notes: scorecard.ai_notes,
      passed: scorecard.passed,
      advanced_to_second_interview: scorecard.passed,
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", interview.id);

  if (updateError) {
    console.error("Failed to save scores:", updateError.message);
    return;
  }

  // Write back to candidates table immediately after ai_interviews update
  const { error: candidateUpdateError } = await supabase
    .from("candidates")
    .update({
      ai_interview_badge: scorecard.badge_level,
      ai_interview_score: scorecard.overall_score,
      ai_interview_passed: scorecard.passed,
      ai_interview_completed_at: new Date().toISOString(),
    })
    .eq("id", candidateId);

  if (candidateUpdateError) {
    console.error(`[CRITICAL] Failed to write back to candidates table for ${candidateId}:`, candidateUpdateError.message);
  } else {
    console.log(`[SUCCESS] Candidate ${candidateId} writeback complete. Score: ${scorecard.overall_score}, Passed: ${scorecard.passed}`);
  }

  // NOTE: admin_status writeback skipped — no admin_status or admin_status_type enum
  // found in this codebase. Add the enum to Supabase first, then uncomment:
  // if (scorecard.passed) {
  //   await supabase
  //     .from("candidates")
  //     .update({ admin_status: 'active' })
  //     .eq("id", candidateId);
  // }

  // Send candidate results email
  try {
    if (candidate?.email) {
      const emailInterviewData = {
        ...scorecard,
        role_category: interview.role_category as string,
        transcript: (interview.transcript as TranscriptEntry[]) || [],
        candidate_id: candidateId,
      };
      await sendCandidateResultsEmail(
        { display_name: candidate.display_name, email: candidate.email },
        emailInterviewData
      );
    }
  } catch (emailErr) {
    console.error("Failed to send candidate email:", emailErr);
  }

  // If passed, assign second interviewer and send delegation email
  if (scorecard.passed) {
    const { data: delegation } = await supabase
      .from("interviewer_delegation")
      .select("interviewer_name, interviewer_email")
      .eq("company_id", "staffva")
      .eq("role_category", interview.role_category as string)
      .limit(1)
      .maybeSingle();

    if (delegation) {
      await supabase
        .from("ai_interviews")
        .update({
          second_interviewer_assigned: delegation.interviewer_name,
          second_interviewer_email: delegation.interviewer_email,
        })
        .eq("id", interview.id);

      try {
        const emailInterviewData = {
          ...scorecard,
          role_category: interview.role_category as string,
          transcript: (interview.transcript as TranscriptEntry[]) || [],
          candidate_id: candidateId,
        };
        await sendDelegationEmail(
          { display_name: candidate?.display_name || "Candidate" },
          emailInterviewData,
          delegation.interviewer_name,
          delegation.interviewer_email
        );
      } catch (emailErr) {
        console.error("Failed to send delegation email:", emailErr);
      }
    }

    // Generate pre-interview guide for the recruiter (fire-and-forget)
    generateAndSaveGuide({
      id: interview.id as string,
      role_category: (interview.role_category as string) || "",
      overall_score: scorecard.overall_score,
      badge_level: scorecard.badge_level,
      technical_knowledge_score: scorecard.technical_knowledge_score,
      problem_solving_score: scorecard.problem_solving_score,
      communication_score: scorecard.communication_score,
      experience_depth_score: scorecard.experience_depth_score,
      professionalism_score: scorecard.professionalism_score,
      ai_notes: scorecard.ai_notes,
      improvement_feedback: scorecard.improvement_feedback,
    }).catch((err) =>
      console.error("[PRE-INTERVIEW GUIDE] Unhandled error:", err)
    );
  }

}

async function generateScorecard(
  candidateName: string,
  roleCategory: string,
  country: string,
  transcriptText: string,
  passThreshold: number
): Promise<Scorecard> {
  const Anthropic = (await import("@anthropic-ai/sdk")).default;
  const client = new Anthropic();

  const systemPrompt = "You are a scoring engine for StaffVA AI interviews. You will receive a complete interview transcript and must produce a detailed scorecard.\n\nCANDIDATE: " + candidateName + "\nROLE: " + roleCategory + "\nCOUNTRY: " + country + "\nPASS THRESHOLD: " + passThreshold + " out of 100\n\nSCORING RULES:\n- Score each of the 5 dimensions from 0 to 20. Be honest and precise.\n- Overall score = sum of all 5 dimension scores (0-100).\n- Badge levels: 80-100 = exceptional, 60-79 = proficient, 40-59 = developing, below 40 = not_ready\n- passed = true if overall_score >= " + passThreshold + "\n- Each dimension feedback must be 1-2 specific sentences citing actual answers from the transcript.\n- Strengths: 2-3 specific things done well with examples from their answers.\n- Weaknesses: Specific gaps identified with actionable advice.\n- improvement_feedback: For each weak dimension, specific actionable steps to improve.\n- perfect_score_path: What a 100% candidate looks like for this role.\n- ai_notes: Internal observations, flags, inconsistencies, standout moments.\n\nSCORING DIMENSIONS:\n1. technical_knowledge (0-20): Specific, accurate knowledge of role tools, processes, standards.\n2. problem_solving (0-20): Logical thinking, prioritization, sound professional judgment.\n3. communication (0-20): Clear, organized, professional English. Answers the question asked.\n4. experience_depth (0-20): Specific numbers, outcomes, timelines. Real hands-on experience.\n5. professionalism (0-20): Ownership of mistakes, accountability, work ethic.\n\nRespond with ONLY a valid JSON object with these exact keys:\n{\n  \"technical_knowledge_score\": number,\n  \"problem_solving_score\": number,\n  \"communication_score\": number,\n  \"experience_depth_score\": number,\n  \"professionalism_score\": number,\n  \"technical_knowledge_feedback\": \"string\",\n  \"problem_solving_feedback\": \"string\",\n  \"communication_feedback\": \"string\",\n  \"experience_depth_feedback\": \"string\",\n  \"professionalism_feedback\": \"string\",\n  \"strengths\": \"string\",\n  \"weaknesses\": \"string\",\n  \"improvement_feedback\": \"string\",\n  \"perfect_score_path\": \"string\",\n  \"ai_notes\": \"string\"\n}";

  const response = await client.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: "user", content: "Score this interview transcript:\n\n" + transcriptText },
    ],
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

  const overallScore =
    (scores.technical_knowledge_score || 0) +
    (scores.problem_solving_score || 0) +
    (scores.communication_score || 0) +
    (scores.experience_depth_score || 0) +
    (scores.professionalism_score || 0);

  let badgeLevel = "not_ready";
  if (overallScore >= 80) badgeLevel = "exceptional";
  else if (overallScore >= 60) badgeLevel = "proficient";
  else if (overallScore >= 40) badgeLevel = "developing";

  return {
    overall_score: overallScore,
    badge_level: badgeLevel,
    technical_knowledge_score: scores.technical_knowledge_score || 0,
    problem_solving_score: scores.problem_solving_score || 0,
    communication_score: scores.communication_score || 0,
    experience_depth_score: scores.experience_depth_score || 0,
    professionalism_score: scores.professionalism_score || 0,
    technical_knowledge_feedback: scores.technical_knowledge_feedback || "",
    problem_solving_feedback: scores.problem_solving_feedback || "",
    communication_feedback: scores.communication_feedback || "",
    experience_depth_feedback: scores.experience_depth_feedback || "",
    professionalism_feedback: scores.professionalism_feedback || "",
    strengths: scores.strengths || "",
    weaknesses: scores.weaknesses || "",
    improvement_feedback: scores.improvement_feedback || "",
    perfect_score_path: scores.perfect_score_path || "",
    ai_notes: scores.ai_notes || "",
    passed: overallScore >= passThreshold,
  };
}
