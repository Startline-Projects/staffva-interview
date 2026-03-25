import { Resend } from "resend";

interface InterviewData {
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
  passed: boolean;
  role_category: string;
  transcript: Array<{ role: string; text: string }>;
  ai_notes: string;
  candidate_id: string;
}

interface CandidateData {
  display_name: string;
  email?: string;
}

const badgeLabels: Record<string, string> = {
  exceptional: "AI Interviewed — Expert",
  proficient: "AI Interviewed — Proficient",
  developing: "AI Interviewed — Developing",
  not_ready: "Not Ready",
};

function dimensionRow(label: string, score: number, feedback: string): string {
  return "<tr><td style='padding:8px;border:1px solid #333;'>" + label + "</td><td style='padding:8px;border:1px solid #333;text-align:center;font-weight:bold;'>" + score + "/20</td><td style='padding:8px;border:1px solid #333;color:#999;'>" + feedback + "</td></tr>";
}

export async function sendCandidateResultsEmail(candidate: CandidateData, interview: InterviewData) {
  if (!candidate.email) return;

  const resend = new Resend(process.env.RESEND_API_KEY);
  const firstName = candidate.display_name.split(" ")[0];

  const subject = interview.passed
    ? "Your StaffVA interview results — you advanced"
    : "Your StaffVA interview results and next steps";

  const opening = interview.passed
    ? "<p>Congratulations. Your AI interview is complete and you have advanced to a second interview with our team.</p>"
    : "<p>Thank you for completing your StaffVA AI interview. Your results are below.</p>";

  const nextSteps = interview.passed
    ? "<p><strong>What happens next:</strong> A member of our team will contact you to schedule your second interview. Watch your email for details.</p>"
    : "<p><strong>Retake available:</strong> You can retake your interview in 3 days. Use that time to practice the areas listed above. Your new score will replace this one.</p>";

  const html = "<div style='font-family:Arial,sans-serif;max-width:600px;'>" +
    "<h2>Hi " + firstName + ",</h2>" +
    opening +
    "<h3>Your Score: " + interview.overall_score + " out of 100 — " + (badgeLabels[interview.badge_level] || interview.badge_level) + "</h3>" +
    "<table style='width:100%;border-collapse:collapse;margin:16px 0;'>" +
    "<tr style='background:#1a1a2e;color:white;'><th style='padding:8px;border:1px solid #333;'>Dimension</th><th style='padding:8px;border:1px solid #333;'>Score</th><th style='padding:8px;border:1px solid #333;'>Feedback</th></tr>" +
    dimensionRow("Technical Knowledge", interview.technical_knowledge_score, interview.technical_knowledge_feedback) +
    dimensionRow("Problem Solving", interview.problem_solving_score, interview.problem_solving_feedback) +
    dimensionRow("Communication", interview.communication_score, interview.communication_feedback) +
    dimensionRow("Experience Depth", interview.experience_depth_score, interview.experience_depth_feedback) +
    dimensionRow("Professionalism", interview.professionalism_score, interview.professionalism_feedback) +
    "</table>" +
    (interview.strengths ? "<h3 style='color:#4ade80;'>Strengths</h3><p>" + interview.strengths + "</p>" : "") +
    (interview.weaknesses ? "<h3 style='color:#f59e0b;'>Areas to Improve</h3><p>" + interview.weaknesses + "</p>" : "") +
    (interview.improvement_feedback ? "<h3>How to Improve</h3><p>" + interview.improvement_feedback + "</p>" : "") +
    (interview.perfect_score_path ? "<h3>Path to 100%</h3><p>" + interview.perfect_score_path + "</p>" : "") +
    nextSteps +
    "</div>";

  await resend.emails.send({
    from: "StaffVA Interview System <noreply@staffva.com>",
    to: candidate.email,
    subject,
    html,
  });
}

export async function sendDelegationEmail(
  candidate: CandidateData,
  interview: InterviewData,
  recruiterName: string,
  recruiterEmail: string
) {
  const resend = new Resend(process.env.RESEND_API_KEY);

  const transcriptHtml = (interview.transcript || []).map((entry) => {
    const speaker = entry.role === "interviewer" ? "<strong>Alex:</strong>" : "<strong>" + candidate.display_name + ":</strong>";
    return "<p>" + speaker + " " + entry.text + "</p>";
  }).join("");

  const html = "<div style='font-family:Arial,sans-serif;max-width:700px;'>" +
    "<h2>New candidate ready for second interview</h2>" +
    "<table style='margin:16px 0;'>" +
    "<tr><td style='padding:4px 12px 4px 0;color:#999;'>Candidate:</td><td><strong>" + candidate.display_name + "</strong></td></tr>" +
    "<tr><td style='padding:4px 12px 4px 0;color:#999;'>Role:</td><td>" + interview.role_category + "</td></tr>" +
    "<tr><td style='padding:4px 12px 4px 0;color:#999;'>Score:</td><td><strong>" + interview.overall_score + "/100</strong> — " + (badgeLabels[interview.badge_level] || interview.badge_level) + "</td></tr>" +
    "</table>" +
    "<h3>Scorecard</h3>" +
    "<table style='width:100%;border-collapse:collapse;margin:16px 0;'>" +
    "<tr style='background:#1a1a2e;color:white;'><th style='padding:8px;border:1px solid #333;'>Dimension</th><th style='padding:8px;border:1px solid #333;'>Score</th><th style='padding:8px;border:1px solid #333;'>Feedback</th></tr>" +
    dimensionRow("Technical Knowledge", interview.technical_knowledge_score, interview.technical_knowledge_feedback) +
    dimensionRow("Problem Solving", interview.problem_solving_score, interview.problem_solving_feedback) +
    dimensionRow("Communication", interview.communication_score, interview.communication_feedback) +
    dimensionRow("Experience Depth", interview.experience_depth_score, interview.experience_depth_feedback) +
    dimensionRow("Professionalism", interview.professionalism_score, interview.professionalism_feedback) +
    "</table>" +
    (interview.ai_notes ? "<h3>AI Interviewer Notes</h3><p>" + interview.ai_notes + "</p>" : "") +
    (interview.improvement_feedback ? "<h3>Suggested Focus Areas for Second Interview</h3><p>" + interview.improvement_feedback + "</p>" : "") +
    "<h3>Full Transcript</h3>" +
    "<div style='background:#f5f5f5;padding:16px;border-radius:8px;max-height:500px;overflow:auto;'>" + transcriptHtml + "</div>" +
    "<p style='margin-top:16px;'><a href='" + (process.env.NEXT_PUBLIC_STAFFVA_URL || "https://staffva.com") + "/candidate/" + interview.candidate_id + "'>View full StaffVA profile</a></p>" +
    "</div>";

  await resend.emails.send({
    from: "StaffVA Interview System <noreply@staffva.com>",
    to: recruiterEmail,
    subject: "New candidate ready for second interview — " + interview.role_category + " — " + interview.overall_score + "% — " + (badgeLabels[interview.badge_level] || interview.badge_level),
    html,
  });
}
