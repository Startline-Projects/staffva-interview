import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { interviewId, speakingLevel } = body;

    if (!interviewId || !speakingLevel) {
      return NextResponse.json(
        { error: "Missing required fields: interviewId, speakingLevel" },
        { status: 400 }
      );
    }

    // Verify recruiter is authenticated
    const supabaseAuth = await createSupabaseServerClient();
    const { data: { user } } = await supabaseAuth.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const role = user.user_metadata?.interview_role;
    const recruiterName = user.user_metadata?.interview_name || "Recruiter";
    const recruiterEmail = user.email || "";

    if (role !== "admin" && role !== "recruiter") {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const supabase = createSupabaseServiceClient();

    // Load the interview
    const { data: interview, error: fetchError } = await supabase
      .from("ai_interviews")
      .select("*")
      .eq("id", interviewId)
      .single();

    if (fetchError || !interview) {
      return NextResponse.json({ error: "Interview not found" }, { status: 404 });
    }

    // Must be scored already
    if (!interview.second_interview_overall) {
      return NextResponse.json({ error: "Second interview has not been scored yet" }, { status: 400 });
    }

    // Save speaking level to ai_interviews
    const { error: updateError } = await supabase
      .from("ai_interviews")
      .update({ speaking_level: speakingLevel })
      .eq("id", interviewId);

    if (updateError) {
      return NextResponse.json({ error: "Failed to save speaking level: " + updateError.message }, { status: 500 });
    }

    // Update speaking_level on candidates table (syncs to staffva.com)
    try {
      await supabase
        .from("candidates")
        .update({ speaking_level: speakingLevel.toLowerCase() })
        .eq("id", interview.candidate_id);
    } catch (err) {
      console.error("Failed to update speaking_level on candidates:", err);
    }

    // Load candidate for email
    const { data: candidate } = await supabase
      .from("candidates")
      .select("id, display_name, role_category, country, email")
      .eq("id", interview.candidate_id)
      .single();

    // NOW send Sam notification email with speaking level included
    try {
      await sendSamNotificationEmail(interview, candidate, speakingLevel, recruiterName, recruiterEmail);
    } catch (err) {
      console.error("Failed to send Sam notification email:", err);
    }

    return NextResponse.json({ saved: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to confirm speaking level";
    console.error("Confirm speaking level error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function sendSamNotificationEmail(
  interview: Record<string, unknown>,
  candidate: Record<string, unknown> | null,
  speakingLevel: string,
  recruiterName: string,
  recruiterEmail: string
) {
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);

  const displayName = (candidate?.display_name as string) || "Candidate";
  const roleCategory = (candidate?.role_category as string) || (interview.role_category as string) || "";
  const country = (candidate?.country as string) || "Unknown";
  const candidateId = (candidate?.id as string) || (interview.candidate_id as string) || "";

  const recommendation = (interview.combined_recommendation as string) || "hold";
  const recBadge = recommendation.toUpperCase();
  const holdWarning = recommendation === "hold"
    ? `<p style="font-weight:bold;color:#d97706;font-size:16px;">ACTION REQUIRED: This candidate is on hold. Review and decide within 48 hours.</p>`
    : "";

  const staffvaUrl = process.env.NEXT_PUBLIC_STAFFVA_URL || "https://staffva.com";

  const subject = `Second Interview Scored — ${displayName} — ${roleCategory} — ${recBadge} — Combined ${interview.combined_score}/100`;

  const html = `
${holdWarning}
<h2>Second Interview Scored</h2>
<p><strong>Candidate:</strong> ${displayName}</p>
<p><strong>Role:</strong> ${roleCategory}</p>
<p><strong>Country:</strong> ${country}</p>
<p><strong>Recruiter:</strong> ${recruiterName} (${recruiterEmail})</p>
<p><strong>Speaking Level:</strong> ${speakingLevel}</p>

<h3>Scores</h3>
<table border="1" cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:600px;">
  <tr style="background:#1a1a2e;color:#fff;">
    <th>Dimension</th>
    <th>First Interview</th>
    <th>Second Interview</th>
  </tr>
  <tr>
    <td>Technical Knowledge</td>
    <td>${interview.technical_knowledge_score}/20</td>
    <td>${interview.second_interview_technical}/20</td>
  </tr>
  <tr>
    <td>Problem Solving</td>
    <td>${interview.problem_solving_score}/20</td>
    <td>${interview.second_interview_problem}/20</td>
  </tr>
  <tr>
    <td>Communication</td>
    <td>${interview.communication_score}/20</td>
    <td>${interview.second_interview_communication}/20</td>
  </tr>
  <tr>
    <td>Experience Depth</td>
    <td>${interview.experience_depth_score}/20</td>
    <td>${interview.second_interview_experience}/20</td>
  </tr>
  <tr>
    <td>Professionalism</td>
    <td>${interview.professionalism_score}/20</td>
    <td>${interview.second_interview_professionalism}/20</td>
  </tr>
  <tr style="font-weight:bold;">
    <td>Overall</td>
    <td>${interview.overall_score}/100</td>
    <td>${interview.second_interview_overall}/100</td>
  </tr>
</table>

<h3>Combined Score: ${interview.combined_score}/100</h3>
<p><strong>First Interview Badge:</strong> ${interview.badge_level}</p>
<p><strong>Recommendation:</strong> <span style="font-weight:bold;color:${recommendation === "pass" ? "#22c55e" : recommendation === "hold" ? "#d97706" : "#ef4444"}">${recBadge}</span></p>

<h3>Recommendation Reason</h3>
<p>${interview.combined_recommendation_reason || ""}</p>

<h3>AI Feedback</h3>
<p>${((interview.second_interview_feedback as string) || "").replace(/\n/g, "<br>")}</p>

<h3>AI Notes</h3>
<p>${((interview.second_interview_ai_notes as string) || "").replace(/\n/g, "<br>")}</p>

<hr>
<p><a href="${staffvaUrl}/candidates/${candidateId}">View StaffVA Profile</a></p>
<p><a href="https://interview.staffva.com/recruiter/candidate/${interview.id}/second-interview">View Full Second Interview Scorecard</a></p>
`;

  await resend.emails.send({
    from: "StaffVA Interviews <notifications@staffva.com>",
    to: "sam@glostaffing.com",
    subject,
    html,
  });
}
