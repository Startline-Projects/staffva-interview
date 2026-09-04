"use client";

import { roleTaskFor, TASK_LABELS, type TaskKey } from "@/lib/roleTask";

/**
 * What the candidate is told about their task before the interview starts.
 *
 * This card renders from the SAME roleTaskFor call the serve route acts on, so
 * what we promise here and what we hand over later cannot drift. Atlas has that
 * bug — its tips card falls back to the engineering copy while its router falls
 * through to the closing, so an unmapped role is promised a live coding task and
 * then given no task at all.
 *
 * When the router was not confident, the card says so. A candidate who does
 * something we did not guess deserves to know we guessed, and to hear it before
 * the task rather than after it.
 */

const COPY: Record<TaskKey, { heading: string; body: string; tips: string[] }> = {
  triage: {
    heading: "You'll handle a real client request",
    body: "Partway through, a forwarded client email appears on screen. You'll pull out the details that matter — who, when, how much, which reference — and then decide what to do with the six other things that landed behind it.",
    tips: [
      "Everything you need is on the page. Nothing is from memory, and nothing needs research.",
      "One item asks you to convert a US meeting time into your own. Take the extra ten seconds.",
      "Deciding something the client should decide counts against you. So does escalating something you could just do.",
      "There is no penalty for a defensible judgement call — several items accept more than one answer.",
    ],
  },
  reconcile: {
    heading: "You'll check a batch of records against its source",
    body: "Partway through, twelve lines appear alongside the document they should match. Some of them are wrong. You'll flag those, say what's wrong, and type what the value should be.",
    tips: [
      "Not every line that looks odd is an error. Flagging a correct line costs you as much as missing a wrong one.",
      "The source above the table is the truth. Where they disagree, the source wins.",
      "You are not asked to fix the underlying document — just to say what the line should read.",
      "Work down the rows in order. It is faster than scanning for what jumps out.",
    ],
  },
  review: {
    heading: "You'll read a document against itself",
    body: "Partway through, a short document appears — an intake packet, a set of case facts, a policy extract. Somewhere in it, it contradicts itself. You'll click the sentence where you notice each problem and say what kind it is.",
    tips: [
      "Everything you need is on the page. You are not being asked to know the law.",
      "Read it twice. The contradictions are between sentences, not inside them.",
      "Flagging a sentence that is fine costs you half a point, so don't spray.",
      "At the end the client asserts something. Check it against the document before you agree.",
    ],
  },
};

export default function Iv2RoleTips({ roleCategory }: { roleCategory: string | null }) {
  const match = roleTaskFor(roleCategory);
  const copy = COPY[match.key];

  return (
    <div className="bg-gray-900 rounded-xl p-6 mb-6">
      <div className="text-xs uppercase tracking-widest text-amber-500 mb-2">
        {match.confident && roleCategory ? roleCategory : "Your task"} ·{" "}
        {TASK_LABELS[match.key]}
      </div>
      <h2 className="text-xl font-semibold mb-3">{copy.heading}</h2>
      <p className="text-gray-400 leading-relaxed mb-4">{copy.body}</p>
      <ul className="space-y-2 text-gray-400 text-sm leading-relaxed list-disc pl-5">
        {copy.tips.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      {!match.confident && (
        <p className="mt-4 pt-4 border-t border-gray-800 text-sm text-gray-500 leading-relaxed">
          We matched you to a general assistant task rather than a specialist one. If the
          work you do is closer to bookkeeping or document review, say so at the start —
          it will not count against you.
        </p>
      )}
    </div>
  );
}
