import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { v4 as uuidv4 } from "uuid";

interface ConversationEntry {
  role: "interviewer" | "candidate";
  text: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, action, transcript, interviewId } = body;

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const payload = verifyInterviewToken(token);
    const supabase = createSupabaseServiceClient();

    const { data: candidate, error: candidateError } = await supabase
      .from("candidates")
      .select("id, display_name, country, role_category, english_written_tier, speaking_level, bio, us_client_experience")
      .eq("id", payload.candidate_id)
      .single();

    if (candidateError || !candidate) {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }

    if (action === "start") {
      return await handleStart(supabase, candidate);
    }

    if (action === "respond") {
      if (!interviewId || !transcript) {
        return NextResponse.json({ error: "Missing interviewId or transcript" }, { status: 400 });
      }
      return await handleRespond(supabase, candidate, interviewId, transcript);
    }

    return NextResponse.json({ error: "Invalid action" }, { status: 400 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Session error";
    console.error("Session route error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleStart(supabase: any, candidate: Record<string, unknown>) {
  const { data: existing } = await supabase
    .from("ai_interviews")
    .select("id")
    .eq("candidate_id", candidate.id)
    .eq("status", "in_progress")
    .limit(1)
    .maybeSingle();

  if (existing) {
    const { data: interview } = await supabase
      .from("ai_interviews")
      .select("id, transcript")
      .eq("id", existing.id)
      .single();

    const conversation: ConversationEntry[] = interview?.transcript || [];
    const lastMsg = [...conversation].reverse().find((e: ConversationEntry) => e.role === "interviewer");

    return NextResponse.json({
      interviewId: existing.id,
      response: lastMsg?.text || "Welcome back. Let us continue where we left off.",
      isComplete: false,
    });
  }

  const { data: lastAttempt } = await supabase
    .from("interview_attempts")
    .select("next_retake_available_at")
    .eq("candidate_id", candidate.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastAttempt?.next_retake_available_at) {
    const retakeDate = new Date(lastAttempt.next_retake_available_at);
    if (retakeDate > new Date()) {
      return NextResponse.json(
        { error: "Retake not available until " + retakeDate.toLocaleDateString() },
        { status: 403 }
      );
    }
  }

  const { count } = await supabase
    .from("interview_attempts")
    .select("*", { count: "exact", head: true })
    .eq("candidate_id", candidate.id);

  const attemptNumber = (count || 0) + 1;
  const interviewId = uuidv4();
  const firstName = (candidate.display_name as string).split(" ")[0];
  const openingMessage = "Hello " + firstName + ", I am Alex, your AI interviewer. Welcome to your StaffVA skills interview for the " + candidate.role_category + " role. I will ask you a series of questions about your experience and skills. Take your time with each answer and be as specific as you can. Let us begin. Tell me about your most recent professional role and what your primary responsibilities were day to day.";

  const initialTranscript: ConversationEntry[] = [
    { role: "interviewer", text: openingMessage },
  ];

  const { error: insertError } = await supabase.from("ai_interviews").insert({
    id: interviewId,
    candidate_id: candidate.id,
    role_category: candidate.role_category,
    status: "in_progress",
    transcript: initialTranscript,
  });

  if (insertError) {
    return NextResponse.json({ error: "Failed to create interview: " + insertError.message }, { status: 500 });
  }

  await supabase.from("interview_attempts").insert({
    candidate_id: candidate.id,
    attempt_number: attemptNumber,
    ai_interview_id: interviewId,
  });

  return NextResponse.json({
    interviewId,
    response: openingMessage,
    isComplete: false,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRespond(supabase: any, candidate: Record<string, unknown>, interviewId: string, transcript: string) {
  const { data: interview, error: fetchError } = await supabase
    .from("ai_interviews")
    .select("*")
    .eq("id", interviewId)
    .eq("candidate_id", candidate.id)
    .single();

  if (fetchError || !interview) {
    return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  }

  if (interview.status !== "in_progress") {
    return NextResponse.json({ error: "Interview already completed" }, { status: 400 });
  }

  const conversation: ConversationEntry[] = [...(interview.transcript || [])];
  conversation.push({ role: "candidate", text: transcript });

  const questionsAsked = conversation.filter((e: ConversationEntry) => e.role === "interviewer").length;

  // Get attempt number for retake awareness
  const { data: attemptData } = await supabase
    .from("interview_attempts")
    .select("attempt_number")
    .eq("ai_interview_id", interviewId)
    .maybeSingle();
  const attemptNumber = attemptData?.attempt_number || 1;

  const claudeResponse = await getClaudeResponse(candidate, conversation, questionsAsked, attemptNumber);

  conversation.push({ role: "interviewer", text: claudeResponse.text });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: any = { transcript: conversation };

  if (claudeResponse.isComplete) {
    updateData.status = "completed";
    updateData.completed_at = new Date().toISOString();
  }

  await supabase.from("ai_interviews").update(updateData).eq("id", interviewId);

  return NextResponse.json({
    interviewId,
    response: claudeResponse.text,
    isComplete: claudeResponse.isComplete,
  });
}

async function getClaudeResponse(
  candidate: Record<string, unknown>,
  conversation: ConversationEntry[],
  questionsAsked: number,
  attemptNumber: number = 1
): Promise<{ text: string; isComplete: boolean }> {
  try {
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();

    const canComplete = questionsAsked >= 8;

    const retakeNote = attemptNumber > 1 ? "\n\nRETAKE NOTICE: This is attempt number " + attemptNumber + " for this candidate. They have taken this interview before. You MUST ask DIFFERENT questions than a typical first interview. Use alternative question angles, different scenarios, and fresh technical questions. Do not repeat standard opening questions. Vary your approach significantly so the candidate cannot rely on memorized answers from their previous attempt." : "";

    const systemPrompt = "You are Alex, a professional AI interviewer for StaffVA. You are conducting a voice-based skills interview.\n\nCANDIDATE PROFILE:\n- Name: " + candidate.display_name + "\n- Role: " + candidate.role_category + "\n- Country: " + candidate.country + "\n- English Level: Written " + candidate.english_written_tier + ", Speaking " + candidate.speaking_level + "\n- US Client Experience: " + (candidate.us_client_experience ? "Yes" : "No") + "\n- Bio: " + (candidate.bio || "Not provided") + retakeNote + "\n\nINTERVIEW RULES:\n1. You are having a VOICE conversation. Keep responses natural and conversational. Do not use bullet points, numbered lists, or markdown.\n2. Ask one question at a time. Never ask multiple questions in one response.\n3. Start with universal questions about professional experience, then move to role-specific technical questions.\n4. After every answer, evaluate: Was it specific enough? Did it answer the question? Does it contradict earlier statements? If any fail, ask a follow-up before moving on.\n5. If an answer is vague, ask for specifics. If it contradicts an earlier answer, call it out professionally.\n6. You MUST ask at least 8 questions before you may end the interview. You have asked " + questionsAsked + " so far." + (canComplete ? " You may now end the interview when you have enough data." : " You MUST continue asking questions. Do NOT end the interview yet.") + "\n7. Be warm but professional. Not robotic, not overly casual.\n8. Never reveal scores during the interview.\n9. Speak as if the candidate is listening to your voice.\n\nRESPONSE FORMAT: Reply with ONLY your spoken words. Do not include any JSON, curly braces, or metadata. Just say what Alex would say out loud.";

    const messages = conversation.map((entry: ConversationEntry) => ({
      role: (entry.role === "interviewer" ? "assistant" : "user") as "assistant" | "user",
      content: entry.text,
    }));

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const content = response.content[0];
    if (content.type !== "text") {
      return { text: "I apologize, let me rephrase. Could you repeat your last answer?", isComplete: false };
    }

    let text = content.text;

    // Strip any JSON that Claude might have included despite instructions
    const jsonMatch = text.match(/\{[\s\S]*"text"\s*:\s*"([\s\S]*?)"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        text = parsed.text || text;
      } catch {
        // Keep original text
      }
    }

    // Determine if interview should end
    const lower = text.toLowerCase();
    const isComplete = canComplete && (
      lower.includes("concludes our interview") ||
      lower.includes("end of the interview") ||
      lower.includes("that wraps up") ||
      lower.includes("have enough information") ||
      lower.includes("have all the information") ||
      lower.includes("completed your interview") ||
      lower.includes("this concludes") ||
      lower.includes("interview is now complete") ||
      lower.includes("interview is complete") ||
      lower.includes("thank you for your time today") ||
      lower.includes("hear back from staffva") ||
      lower.includes("next few business days") ||
      lower.includes("have a great day") ||
      (lower.includes("goodbye") && lower.includes("thank")) ||
      (lower.includes("take care") && canComplete && questionsAsked >= 10) ||
      questionsAsked >= 15
    );

    return { text, isComplete };
  } catch (err) {
    console.error("Claude API error:", err);
    return { text: "I had a brief technical issue. Could you please repeat your last answer?", isComplete: false };
  }
}
