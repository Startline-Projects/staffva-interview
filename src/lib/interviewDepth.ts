/**
 * How many questions the AI interview should ask, by role.
 *
 * This is now the ONLY interview. The second, human-conducted interview has been
 * removed: StaffVA is a marketplace rather than a staffing agency, and a step
 * that needs a recruiter on a call does not survive contact with thousands of
 * candidates. Everything the second interview was for — probing experience
 * claims for specificity, checking consistency, testing professionalism and
 * accountability — has moved into this one.
 *
 * Depth scales with how specialised the role is. A Paralegal or a Bookkeeper has
 * domain knowledge worth probing; a Data Entry Specialist mostly does not, and
 * asking twelve questions to establish that wastes the candidate's time and a
 * measurable amount of text-to-speech.
 *
 * Cost note, since ElevenLabs is the binding constraint on concurrency: the
 * interview previously ran to ~9 questions and ~3,334 TTS characters. At 12 it
 * is roughly a third more, so a 10,000-candidate campaign moves from ~7.4M
 * characters to ~9.9M. Uniformly asking everyone twelve would have cost more
 * again for no extra signal on the simpler roles.
 */

/** Role groups whose work carries domain knowledge worth probing in depth. */
const SPECIALISED_ROLES = new Set<string>([
  // Legal
  "Paralegal", "Legal Assistant", "Legal Secretary", "Litigation Support", "Contract Reviewer",
  // Accounting & Finance
  "Bookkeeper", "Accounts Payable Specialist", "Accounts Receivable Specialist",
  "Payroll Specialist", "Tax Preparer", "Financial Analyst",
  // Medical
  "Medical Billing Specialist", "Medical Administrative Assistant",
  "Insurance Verification Specialist", "Dental Office Administrator",
  // Tech
  "Software Developer", "Web Developer", "Mobile Developer", "UI/UX Designer",
  "DevOps Engineer", "Data Analyst", "QA Engineer", "IT Support", "Software Engineer",
  "Full Stack Developer", "Frontend Developer", "Backend Developer",
  "LLM Engineer", "AI Engineer",
  // Creative — judged on craft, and claims are checkable against a portfolio
  "Graphic Designer", "Video Editor",
]);

export type InterviewDepth = {
  minQuestions: number;
  maxQuestions: number;
  specialised: boolean;
};

/**
 * Ten questions for general roles, twelve for specialised ones.
 *
 * min and max are deliberately close. Alex ended at the floor essentially every
 * time under the old 8/15 settings — measured at ~9 questions — so the ceiling
 * was never the operative number and a wide band just adds cost variance. The
 * floor is what actually sets interview length; the two extra questions of
 * headroom exist so a genuinely unresolved answer can be followed up rather than
 * cut off mid-thread.
 */
export function interviewDepthFor(roleCategory: string | null | undefined): InterviewDepth {
  const specialised = !!roleCategory && SPECIALISED_ROLES.has(roleCategory);
  return specialised
    ? { minQuestions: 12, maxQuestions: 14, specialised: true }
    : { minQuestions: 10, maxQuestions: 12, specialised: false };
}
