import { iv1QuestionById } from "@/lib/iv1Questions";

/** Shared shapes + turn logic for the Interview 1 routes. Lives outside the
 * route files because route modules may only export handlers. */

export interface Iv1TranscriptEntry {
  role: "interviewer" | "candidate";
  text: string;
  at?: string;
  qid?: string;
  stt_confidence?: number | null;
}

export interface Iv1Plan {
  questionIds: string[];
  followUp?: { afterQuestionId: string; text: string } | null;
}

export function iv1ClientQuestion(id: string, isFollowUp = false, followUpText?: string) {
  const q = iv1QuestionById(id);
  if (!q) return null;
  return {
    id: isFollowUp ? `${id}#followup` : id,
    text: isFollowUp ? followUpText || "" : q.text,
    prepSeconds: isFollowUp ? 20 : q.prepSeconds,
    answerSeconds: isFollowUp ? 60 : q.answerSeconds,
    isFollowUp,
  };
}

/** Given the plan and the answered turn ids, what comes next? */
export function iv1NextTurn(plan: Iv1Plan, answeredIds: string[]) {
  for (const qid of plan.questionIds) {
    if (!answeredIds.includes(qid)) {
      return { question: iv1ClientQuestion(qid), index: plan.questionIds.indexOf(qid) };
    }
    if (
      plan.followUp &&
      plan.followUp.afterQuestionId === qid &&
      !answeredIds.includes(`${qid}#followup`)
    ) {
      return {
        question: iv1ClientQuestion(qid, true, plan.followUp.text),
        index: plan.questionIds.indexOf(qid),
      };
    }
  }
  return { question: null, index: plan.questionIds.length };
}

export function iv1AnsweredIds(transcript: Iv1TranscriptEntry[]): string[] {
  return transcript.filter((e) => e.role === "candidate" && e.qid).map((e) => e.qid as string);
}

/** Is this error message a TOKEN problem (401) rather than ours (500)?
 * Deliberately narrow: a bare "malformed" also appears in Postgres errors
 * ("malformed array literal"), which are not the candidate's to fix. */
export function isTokenError(message: string): boolean {
  return /\bjwt\b|\btoken\b|jwt expired|jwt malformed|invalid signature/i.test(message);
}
