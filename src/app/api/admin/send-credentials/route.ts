import { NextResponse } from "next/server";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

const recruiters = [
  { name: "Manar", email: "careers@globalstaffing.asia", password: "Interview@Manar2026" },
  { name: "Ranim", email: "hr@glostaffing.com", password: "Interview@Ranim2026" },
  { name: "Jerome", email: "support@glostaffing.com", password: "Interview@Jerome2026" },
  { name: "Abigail", email: "ops@glostaffing.com", password: "Interview@Abigail2026" },
  { name: "Shelly", email: "marketing@glostaffing.com", password: "Interview@Shelly2026" },
  { name: "Ibraheem", email: "zak@glostaffing.com", password: "Interview@Ibraheem2026" },
  { name: "Eslam", email: "info@glostaffing.com", password: "Interview@Eslam2026" },
];

export async function POST() {
  const results = [];

  for (const r of recruiters) {
    try {
      await resend.emails.send({
        from: "StaffVA Interview System <noreply@staffva.com>",
        to: r.email,
        subject: "Your StaffVA Interview System access is ready",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #1a1a2e;">StaffVA Interview System</h2>
            <p>Hi ${r.name},</p>
            <p>Your access to the StaffVA AI Interview System has been created.</p>
            <table style="margin: 20px 0; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 16px; font-weight: bold; background: #f5f5f5;">Login URL</td>
                <td style="padding: 8px 16px;"><a href="https://interview.staffva.com/login">interview.staffva.com/login</a></td>
              </tr>
              <tr>
                <td style="padding: 8px 16px; font-weight: bold; background: #f5f5f5;">Email</td>
                <td style="padding: 8px 16px;">${r.email}</td>
              </tr>
              <tr>
                <td style="padding: 8px 16px; font-weight: bold; background: #f5f5f5;">Temporary Password</td>
                <td style="padding: 8px 16px; font-family: monospace;">${r.password}</td>
              </tr>
            </table>
            <p><strong>Log in and change your password immediately from the account menu.</strong></p>
            <p>Your dashboard shows candidates in your assigned categories who have passed the AI interview and are ready for a second interview with you.</p>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
            <p style="color: #888; font-size: 12px;">StaffVA Interview System — interview.staffva.com</p>
          </div>
        `,
      });
      results.push({ email: r.email, status: "sent" });
    } catch (err) {
      results.push({ email: r.email, status: "error", error: String(err) });
    }
  }

  // Send summary to Sam
  const summaryRows = recruiters.map(r =>
    `<tr>
      <td style="padding: 6px 12px; border: 1px solid #ddd;">${r.name}</td>
      <td style="padding: 6px 12px; border: 1px solid #ddd;">${r.email}</td>
      <td style="padding: 6px 12px; border: 1px solid #ddd; font-family: monospace;">${r.password}</td>
    </tr>`
  ).join("");

  try {
    await resend.emails.send({
      from: "StaffVA Interview System <noreply@staffva.com>",
      to: "sam@glostaffing.com",
      subject: "StaffVA Interview System — All recruiter accounts created",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a2e;">Recruiter Account Summary</h2>
          <p>All 7 recruiter accounts have been created and credential emails sent.</p>
          <table style="margin: 20px 0; border-collapse: collapse; width: 100%;">
            <thead>
              <tr style="background: #1a1a2e; color: white;">
                <th style="padding: 8px 12px; text-align: left;">Name</th>
                <th style="padding: 8px 12px; text-align: left;">Email</th>
                <th style="padding: 8px 12px; text-align: left;">Temp Password</th>
              </tr>
            </thead>
            <tbody>
              ${summaryRows}
            </tbody>
          </table>
          <p><strong>Login URL:</strong> <a href="https://interview.staffva.com/login">interview.staffva.com/login</a></p>
          <p><strong>Your admin login:</strong> sam@glostaffing.com / Interview@Admin2026</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
          <p style="color: #888; font-size: 12px;">StaffVA Interview System — interview.staffva.com</p>
        </div>
      `,
    });
    results.push({ email: "sam@glostaffing.com", status: "summary_sent" });
  } catch (err) {
    results.push({ email: "sam@glostaffing.com", status: "error", error: String(err) });
  }

  return NextResponse.json({ results });
}
