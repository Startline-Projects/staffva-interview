/**
 * How the role-task result reaches the scorer — and why it does not yet.
 *
 * The task ships in SHADOW. It runs, it scores, it stores, and the scoring
 * model is shown nothing at all. `TASK_EVIDENCE_ENABLED` is unset by default,
 * and turning it on is a one-line flip once there is a real distribution to
 * look at.
 *
 * That is not caution for its own sake. StaffVA has shipped an unvalidated
 * instrument that rejected people before: the English test's 100 grammar items
 * went live with 17 of them having two defensible answers, 52% of candidates
 * got those wrong, and 23 of the 45 candidates it rejected would have passed on
 * a regrade. A brand-new task, hand-authored, scored by brand-new code, with no
 * observed distribution, has exactly that risk profile. So it watches first.
 *
 * When it is switched on, the asymmetry below is the rule: the task may RESCUE
 * a candidate, never condemn one. That is the same shape the silence guard
 * already uses — it computes the score, keeps it, and uses the flag only to
 * WITHHOLD an adverse action, never to create one.
 */

export interface TaskEvidence {
  status: string | null;
  key: string | null;
  variant: string | null;
  scorePct: number | null;
  missed: string[];
  elapsedMs: number | null;
  mappingConfident: boolean | null;
  mappingRule: string | null;
}

export function taskEvidenceEnabled(): boolean {
  return process.env.TASK_EVIDENCE_ENABLED === "true";
}

/**
 * The block that goes into the scoring system prompt.
 *
 * Deliberately FACTUAL — counts, names, elapsed — and never prose the model
 * has to interpret. It also never contains the candidate's own typed text: that
 * is untrusted input, it is already fenced in the transcript, and repeating it
 * here unfenced would reopen the hole the fencing closed.
 */
export function buildTaskEvidenceBlock(ev: TaskEvidence | null): string {
  if (!taskEvidenceEnabled()) return "";

  // Absence of evidence is not evidence. An interview where the task was never
  // served, or was abandoned, or failed to score, must cost the candidate
  // nothing — most of those are our failure, not theirs.
  if (!ev || ev.status !== "scored" || ev.scorePct === null) {
    return (
      "\n\nTASK EVIDENCE: none.\n" +
      "No role-task result exists for this interview. This is normal and is " +
      "usually our doing, not the candidate's. Do NOT infer anything from its " +
      "absence, do not mention it, and score the conversation exactly as you " +
      "would have without this line."
    );
  }

  const parts = [
    "\n\nTASK EVIDENCE (objective, computed by StaffVA — not a model judgement):",
    `- Task: ${ev.key} (${ev.variant})`,
    `- Score: ${ev.scorePct}% correct`,
  ];
  if (ev.elapsedMs) parts.push(`- Time taken: ${Math.round(ev.elapsedMs / 1000)}s`);
  if (ev.missed.length) parts.push(`- Got wrong: ${ev.missed.slice(0, 8).join("; ")}`);
  if (ev.mappingConfident === false) {
    parts.push(
      "- NOTE: we could not confidently match this candidate's role, so they " +
        "were given the general assistant task rather than a specialist one. " +
        "Weight this result LOWER accordingly."
    );
  }
  parts.push(
    "",
    // This clause used to read "where they disagree, the task result is the
    // better evidence", which is symmetric — and the review was right that it
    // contradicts the contract this file states two screens up. The code-side
    // adjustment can only rescue; a symmetric prompt let the same unvalidated
    // instrument mark somebody DOWN through the model instead, out the back
    // door, with none of the asymmetry that makes shadow mode safe.
    "How to use it: this is the only part of this interview that was measured " +
      "rather than judged, and it is a NEW instrument with no validated track " +
      "record. Use it in ONE direction only. A strong task result is real " +
      "evidence of competence and may raise a dimension the conversation left " +
      "you unsure about. A weak task result is NOT evidence of incompetence — " +
      "it may be our task, our wording or our clock at fault — and must not " +
      "lower any dimension below what the conversation alone supports. Do not " +
      "restate the score or name individual task items anywhere in your " +
      "feedback fields; those fields are shown to the candidate, who may retake."
  );
  return parts.join("\n");
}

/**
 * The code-side consequence, once evidence is on.
 *
 * v1 is one-sided ON PURPOSE. A strong task result can pull a borderline
 * candidate back for a human look; a weak one can never push anyone out. Until
 * there is a distribution, an unvalidated instrument does not get to reject
 * anybody.
 */
export function taskAdjustment(
  conversationPassed: boolean,
  ev: TaskEvidence | null
): { flagForReview: boolean; note: string | null } {
  if (!taskEvidenceEnabled()) return { flagForReview: false, note: null };
  if (!ev || ev.status !== "scored" || ev.scorePct === null) {
    return { flagForReview: false, note: null };
  }
  if (conversationPassed && ev.scorePct < 40) {
    // They talk a better game than they work. Still passes — but somebody
    // should see this before the profile goes in front of a client.
    return {
      flagForReview: true,
      note: `Task/interview mismatch: passed the conversation but scored ${ev.scorePct}% on the ${ev.key} task.`,
    };
  }
  if (!conversationPassed && ev.scorePct >= 70) {
    // The measured instrument disagrees with the judged one, in the
    // candidate's favour. Never auto-reject over that.
    return {
      flagForReview: true,
      note: `Task/interview mismatch: did not pass the conversation but scored ${ev.scorePct}% on the ${ev.key} task — worth a human look before this stands.`,
    };
  }
  return { flagForReview: false, note: null };
}
