import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { enforceRateLimit, LIMITS } from "@/lib/rateLimit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { isFatalVendorError, recordVendorFailure } from "@/lib/vendorFailure";
import { v4 as uuidv4 } from "uuid";
import { interviewDepthFor } from "@/lib/interviewDepth";

interface ConversationEntry {
  role: "interviewer" | "candidate";
  text: string;
  // When the SERVER recorded this entry. Stamped here, from the server clock,
  // so it cannot be fabricated by the client. Absent on rows written before
  // this field existed — every reader must tolerate that.
  at?: string;
  // Candidate entries only, and CLIENT-REPORTED — the browser measures how
  // long after the microphone opened the first speech arrived (latency_ms)
  // and how long the speech lasted (speech_ms). Advisory: bounds-checked on
  // the way in, but a hostile client can fabricate them, so nothing may ever
  // treat them as proof by themselves. The authoritative axis is the server
  // `at` deltas between turns.
  latency_ms?: number;
  speech_ms?: number;
  // Deepgram's confidence for this answer's transcription (0..1). Measured
  // server-side by the transcribe route but forwarded through the client, so
  // treat with the same advisory status as the timings.
  stt_confidence?: number;
}

/**
 * Validate client-reported turn timing. Returns only the fields that survive
 * the bounds check; everything else is silently dropped rather than rejected,
 * because timing must never be able to break an interview turn.
 */
function sanitizeTiming(raw: unknown): { latency_ms?: number; speech_ms?: number; stt_confidence?: number } {
  if (!raw || typeof raw !== "object") return {};
  const t = raw as Record<string, unknown>;
  const out: { latency_ms?: number; speech_ms?: number; stt_confidence?: number } = {};
  const TEN_MINUTES_MS = 600_000;
  if (typeof t.latency_ms === "number" && Number.isFinite(t.latency_ms) && t.latency_ms >= 0 && t.latency_ms <= TEN_MINUTES_MS) {
    out.latency_ms = Math.round(t.latency_ms);
  }
  if (typeof t.speech_ms === "number" && Number.isFinite(t.speech_ms) && t.speech_ms >= 0 && t.speech_ms <= TEN_MINUTES_MS) {
    out.speech_ms = Math.round(t.speech_ms);
  }
  if (typeof t.stt_confidence === "number" && Number.isFinite(t.stt_confidence) && t.stt_confidence >= 0 && t.stt_confidence <= 1) {
    out.stt_confidence = Math.round(t.stt_confidence * 1000) / 1000;
  }
  return out;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { token, action, transcript, interviewId, timing } = body;

    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const payload = verifyInterviewToken(token);

    // Each turn costs an Anthropic call plus, downstream, a synthesis and a
    // transcription. 60/hr sits far above the 15-question cap while still
    // bounding a loop.
    const limited = await enforceRateLimit(
      `interview:turn:${payload.candidate_id}`,
      LIMITS.interviewTurn
    );
    if (limited) return limited;

    const supabase = createSupabaseServiceClient();

    const { data: candidate, error: candidateError } = await supabase
      .from("candidates")
      // years_experience is read by the consistency rule in Alex's prompt — it
      // compares what the candidate SAYS in the interview against what they
      // claimed on the application.
      .select("id, display_name, country, role_category, english_written_tier, bio, us_client_experience, years_experience")
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

      // The transcript is appended to the conversation and the WHOLE
      // conversation is re-sent to Anthropic on every subsequent turn, so an
      // oversized answer is billed once per remaining question, not once.
      // Real candidate answers average 387 characters.
      const MAX_TRANSCRIPT_CHARS = 5000;
      if (typeof transcript !== "string" || transcript.length > MAX_TRANSCRIPT_CHARS) {
        return NextResponse.json(
          { error: `transcript must be a string of at most ${MAX_TRANSCRIPT_CHARS} characters` },
          { status: 400 }
        );
      }
      return await handleRespond(supabase, candidate, interviewId, transcript, sanitizeTiming(timing));
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
  // Only resume a RECENT interview. There was no age bound, so a candidate
  // whose session broke months ago was dropped back into it every time they
  // pressed Start, with no way to begin again — five such rows exist in
  // production, the oldest 138 days, one of them past the 15-question cap.
  // ai_interviews has no updated_at column, so this keys on created_at.
  // COUPLED TO THE PLATFORM'S TOKEN EXPIRY. The platform mints the interview
  // token at 8h (Staffva-platform-main, src/lib/interviewToken.ts) specifically
  // to outlive this window — every route here verifies that token, so a resume
  // window longer than the token's life promises something the candidate cannot
  // do. It was 6h against a 1h token. If this number grows, grow the mint first.
  const STALE_AFTER_HOURS = 6;
  const staleCutoff = new Date(Date.now() - STALE_AFTER_HOURS * 3600_000).toISOString();

  // Retire anything older before looking, so the candidate falls through to a
  // fresh interview rather than being pinned. failed_technical is the same
  // state used for interviews parked for human review.
  await supabase
    .from("ai_interviews")
    .update({ status: "failed_technical" })
    .eq("candidate_id", candidate.id)
    .eq("status", "in_progress")
    .lt("created_at", staleCutoff);

  const { data: existing } = await supabase
    .from("ai_interviews")
    .select("id")
    .eq("candidate_id", candidate.id)
    .eq("status", "in_progress")
    .gte("created_at", staleCutoff)
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
      // The whole conversation, so a resuming candidate sees the answers they
      // already gave instead of one orphaned question with no context.
      conversation,
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
    { role: "interviewer", text: openingMessage, at: new Date().toISOString() },
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
    // Explicitly null. The column defaults to now() + 3 days, and this row is
    // written when the interview STARTS — so merely beginning an interview
    // armed a three-day lockout. A candidate whose interview then broke was
    // refused a retry by handleStart's own gate, with nothing to appeal to.
    // The retake window is set on failure, by the scoring route, which is the
    // only place that knows whether one is warranted.
    next_retake_available_at: null,
  });

  return NextResponse.json({
    interviewId,
    response: openingMessage,
    isComplete: false,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function handleRespond(supabase: any, candidate: Record<string, unknown>, interviewId: string, transcript: string, timing: { latency_ms?: number; speech_ms?: number; stt_confidence?: number }) {
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
  conversation.push({ role: "candidate", text: transcript, at: new Date().toISOString(), ...timing });

  // Persist the answer NOW, before the model call. The Anthropic client allows
  // 25s with one retry, so the call alone can consume most of this route's 60s
  // budget — and the only other write happens after it returns. A function
  // killed at maxDuration therefore erased an answer the candidate had already
  // given and could not give again, since the client never re-sends. Writing
  // the question costs a second UPDATE; losing the answer costs the candidate
  // a question they are scored on.
  await supabase
    .from("ai_interviews")
    .update({ transcript: conversation })
    .eq("id", interviewId);

  const questionsAsked = conversation.filter((e: ConversationEntry) => e.role === "interviewer").length;

  // Get attempt number for retake awareness
  const { data: attemptData } = await supabase
    .from("interview_attempts")
    .select("attempt_number")
    .eq("ai_interview_id", interviewId)
    .maybeSingle();
  const attemptNumber = attemptData?.attempt_number || 1;

  let claudeResponse;
  try {
    claudeResponse = await getClaudeResponse(candidate, conversation, questionsAsked, attemptNumber);
  } catch {
    // getClaudeResponse only rethrows configuration failures — a retired model
    // id, a revoked key. Every candidate is hitting this, so stop the interview
    // here instead of burning fifteen turns of paid speech synthesis and
    // transcription to build a transcript that cannot be scored.
    //
    // status stays 'in_progress' deliberately. An earlier version of this block
    // wrote 'error', which is not in ai_interviews_status_check
    // ('in_progress' | 'completed' | 'failed_technical') — so Postgres rejected
    // the whole UPDATE, the result was never checked, and the transcript in the
    // same statement was discarded too. The comment claimed the answers were
    // saved; they were not. Leaving the row 'in_progress' is also what lets
    // handleStart resume it, which 'failed_technical' would not.
    const { error: saveError } = await supabase
      .from("ai_interviews")
      .update({ transcript: conversation })
      .eq("id", interviewId);

    if (saveError) {
      await recordVendorFailure({
        vendor: "anthropic",
        operation: "interview.session.saveOnFatal",
        error: saveError,
        fatal: true,
        context: { interviewId },
      });
    }

    return NextResponse.json(
      {
        error:
          "The interview service is unavailable right now. Your answers have been saved — please try again shortly.",
        retryable: true,
      },
      { status: 503 }
    );
  }

  conversation.push({ role: "interviewer", text: claudeResponse.text, at: new Date().toISOString() });

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
    const client = new Anthropic({
      // conversation turn — must return well inside the route 60s budget. The SDK default is 10 minutes, far beyond the
      // platform function limit, so a slow call would be killed mid-flight.
      // 25s x 2 attempts left only ~8s of the 60s budget for the database
      // work either side, and a function killed there loses the turn. One
      // attempt leaves 33s of headroom; a transient failure already has a
      // recovery path — the candidate is asked to repeat their answer, and
      // the answer itself is now persisted before this call.
      timeout: 25000,
      maxRetries: 0,
    });

    // Alex may wrap up after MIN_QUESTIONS; at MAX_QUESTIONS the interview ends
    // regardless of what the model says.
    //
    // This is now the ONLY interview — the human-conducted second interview has
    // been removed — so the floor rose from 8 to 10, or 12 for specialised
    // roles. See lib/interviewDepth: Alex ended at the floor essentially every
    // time under the old settings, so the floor, not the ceiling, is what sets
    // interview length.
    const { minQuestions: MIN_QUESTIONS, maxQuestions: MAX_QUESTIONS, specialised } =
      interviewDepthFor(candidate.role_category as string | null);
    const canComplete = questionsAsked >= MIN_QUESTIONS;

    const retakeNote = attemptNumber > 1 ? "\n\nRETAKE NOTICE: This is attempt number " + attemptNumber + " for this candidate. They have taken this interview before. You MUST ask DIFFERENT questions than a typical first interview. Use alternative question angles, different scenarios, and fresh technical questions. Do not repeat standard opening questions. Vary your approach significantly so the candidate cannot rely on memorized answers from their previous attempt." : "";

    const systemPrompt = "You are Alex, a professional AI interviewer for StaffVA. You are conducting a voice-based skills interview.\n\nCANDIDATE PROFILE:\n- Name: " + candidate.display_name + "\n- Role: " + candidate.role_category + "\n- Country: " + candidate.country + "\n- English Level: Written " + candidate.english_written_tier + "\n- US Client Experience: " + (candidate.us_client_experience ? "Yes" : "No") + "\n- Bio: " + (candidate.bio || "Not provided") + retakeNote + "\n\nTHIS IS THE ONLY INTERVIEW. There is no second interview and no human recruiter will speak to this candidate afterwards. Everything the marketplace needs to decide about them has to come out of this conversation, so do not leave a doubt unresolved on the assumption someone else will follow it up.\n\nINTERVIEW RULES:\n1. You are having a VOICE conversation. Keep responses natural and conversational. Do not use bullet points, numbered lists, or markdown.\n2. Ask one question at a time. Never ask multiple questions in one response.\n3. Start with universal questions about professional experience, then move to role-specific technical questions." + (specialised ? " This is a specialised role. Test actual domain knowledge, not familiarity: ask about specific tools, processes, regulations or standards the work requires, and about a real decision they had to make." : "") + "\n4. After every answer, evaluate: Was it specific enough? Did it answer the question? Does it contradict earlier statements? If any fail, ask a follow-up before moving on.\n5. If an answer is vague, ask for specifics. If it contradicts an earlier answer, call it out professionally.\n6. PROBE EXPERIENCE CLAIMS FOR EVIDENCE. Anyone can claim years of experience. Ask for numbers, outcomes, timelines and the names of tools they actually used. If they say they managed something, ask how many, for how long, and what happened when it went wrong.\n7. TEST PROFESSIONALISM AND ACCOUNTABILITY DIRECTLY. At least once, ask about a mistake they made or a conflict with a client or manager, and listen for whether they take ownership or blame others. Note how they speak about past employers.\n8. CHECK CONSISTENCY. Their stated profile says " + candidate.years_experience + " years of experience as a " + candidate.role_category + ". If what they describe does not match that, probe it rather than ignoring it.\n9. You MUST ask at least " + MIN_QUESTIONS + " questions before you may end the interview. You have asked " + questionsAsked + " so far." + (canComplete ? " You may now end the interview when you have enough data. If any answer is still unresolved, use a remaining question on it rather than closing early." : " You MUST continue asking questions. Do NOT end the interview yet.") + "\n10. Be warm but professional. Not robotic, not overly casual.\n11. Never reveal scores during the interview.\n12. Speak as if the candidate is listening to your voice.\n13. NEVER combine a follow-up question with closing statements in the same response. If you ask a follow-up question, wait for the answer before closing the interview.\n\nRESPONSE FORMAT: Reply with ONLY your spoken words. Do not include any JSON, curly braces, or metadata. Just say what Alex would say out loud.";

    const messages = conversation.map((entry: ConversationEntry) => ({
      role: (entry.role === "interviewer" ? "assistant" : "user") as "assistant" | "user",
      content: entry.text,
    }));

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      // Thinking off for the live conversational turn. max_tokens caps thinking
      // AND text together, so adaptive thinking would eat the budget for Alex's
      // spoken reply — and this turn is latency-critical: the candidate is
      // waiting in silence. The scoring path disables it too — the rationale is
      // argued in full in interview/score/route.ts. Sonnet 5 accepts an
      // explicit disable.
      thinking: { type: "disabled" },
      system: systemPrompt,
      messages,
    });

    // Select the TEXT block rather than assuming index 0 — see the thinking
    // note above; a thinking block can arrive first with empty text.
    const content = response.content.find((b) => b.type === "text");
    if (!content) {
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
    // If the response contains a question mark, Alex is still interviewing — never close when a question is open
    const containsQuestion = text.includes("?");

    const saidClosingPhrase =
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
      (lower.includes("take care") && questionsAsked >= 10);

    // Hard backstop. This MUST sit outside the !containsQuestion guard: it was
    // previously inside it, so an interviewer turn that ended in a question
    // (i.e. most of them) suppressed the cap too and the interview could run
    // forever — never completing, never scoring, and never redirecting the
    // candidate. That also made a missing ANTHROPIC_API_KEY unrecoverable,
    // because the fallback turn ends in "?".
    const reachedQuestionCap = questionsAsked >= MAX_QUESTIONS;

    const isComplete =
      reachedQuestionCap || (canComplete && !containsQuestion && saidClosingPhrase);

    return { text, isComplete };
  } catch (err) {
    const fatal = isFatalVendorError(err);

    await recordVendorFailure({
      vendor: "anthropic",
      operation: "interview.session.turn",
      error: err,
      fatal,
      context: { questionsAsked, attemptNumber },
    });

    // A retired model id, a revoked key or a bad request will hit every single
    // turn for every candidate. Answering "I had a brief technical issue" here
    // is what hid a ten-week outage: the interview limped to MAX_QUESTIONS,
    // produced a transcript of nothing but apologies, and was then scored --
    // while still paying ElevenLabs and Deepgram for every turn. Surface it.
    if (fatal) {
      throw err;
    }

    // Transient (429, 5xx, timeout). Asking the candidate to repeat is a
    // reasonable recovery, and the failure is now on record either way.
    return {
      text: "I had a brief technical issue. Could you please repeat your last answer?",
      isComplete: false,
    };
  }
}
