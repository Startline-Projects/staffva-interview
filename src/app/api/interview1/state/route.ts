import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  iv1AnsweredIds,
  iv1NextTurn,
  type Iv1Plan,
  type Iv1TranscriptEntry,
} from "@/lib/iv1Session";

/**
 * GET /api/interview1/state?token=&interviewId= — where am I?
 *
 * A READ-ONLY resync for the client. The session route was doing this job
 * and it is a creator: with no in-progress interview open it deals a fresh
 * plan and inserts a new attempt row, so a client that resynced at the
 * wrong moment could mint a second interview, bypass the retake gate, and
 * orphan the one it had just finished. This endpoint only reports.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const interviewId = request.nextUrl.searchParams.get("interviewId");
  if (!token || !interviewId) {
    return NextResponse.json({ error: "Missing token or interviewId" }, { status: 400 });
  }

  let candidateId: string;
  try {
    candidateId = verifyInterviewToken(token).candidate_id;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const supabase = createSupabaseServiceClient();
  const { data: interview } = await supabase
    .from("ai_interviews")
    .select("id, status, transcript, question_plan")
    .eq("id", interviewId)
    .eq("candidate_id", candidateId)
    .eq("kind", "behavioral")
    .maybeSingle();

  if (!interview) {
    return NextResponse.json({ error: "Interview not found" }, { status: 404 });
  }
  if (interview.status !== "in_progress") {
    // completed or parked — either way there is no next turn to serve.
    return NextResponse.json({ done: true, status: interview.status });
  }

  const plan = interview.question_plan as Iv1Plan | null;
  if (!plan?.questionIds?.length) {
    return NextResponse.json({ error: "Interview has no question plan" }, { status: 500 });
  }
  const transcript = (interview.transcript || []) as Iv1TranscriptEntry[];
  const answeredIds = iv1AnsweredIds(transcript);
  const turn = iv1NextTurn(plan, answeredIds);

  return NextResponse.json({
    done: !turn.question,
    total: plan.questionIds.length,
    answered: answeredIds.length,
    ...turn,
  });
}
