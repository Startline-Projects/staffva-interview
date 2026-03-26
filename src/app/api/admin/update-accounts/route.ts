import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const results: { step: string; status: string; error?: string }[] = [];

  // STEP 1: Find Abigail's user ID in Supabase Auth
  const { data: { users } } = await supabase.auth.admin.listUsers();
  const abigail = users?.find(u => u.email === "ops@glostaffing.com");

  if (!abigail) {
    return NextResponse.json({ error: "Abigail account (ops@glostaffing.com) not found" }, { status: 404 });
  }

  // STEP 2: Update Abigail's email in Supabase Auth
  try {
    const { error } = await supabase.auth.admin.updateUserById(abigail.id, {
      email: "abbybacon2327@gmail.com",
    });
    if (error) throw error;
    results.push({ step: "Update Abigail email in Auth", status: "success" });
  } catch (err) {
    results.push({ step: "Update Abigail email in Auth", status: "error", error: String(err) });
  }

  // STEP 3: Update Abigail's email in interviewer_delegation
  try {
    const { error } = await supabase
      .from("interviewer_delegation")
      .update({ interviewer_email: "abbybacon2327@gmail.com" })
      .eq("interviewer_email", "ops@glostaffing.com")
      .eq("interviewer_name", "Abigail");
    if (error) throw error;
    results.push({ step: "Update Abigail email in delegation", status: "success" });
  } catch (err) {
    results.push({ step: "Update Abigail email in delegation", status: "error", error: String(err) });
  }

  // STEP 4: Send Abigail notification email
  try {
    await resend.emails.send({
      from: "StaffVA Interview System <noreply@staffva.com>",
      to: "abbybacon2327@gmail.com",
      subject: "Your StaffVA Interview System login email has been updated",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a2e;">StaffVA Interview System</h2>
          <p>Hi Abigail,</p>
          <p>Your StaffVA Interview System login email has been changed to <strong>abbybacon2327@gmail.com</strong>.</p>
          <p>Use this email going forward to log into <a href="https://interview.staffva.com/login">interview.staffva.com</a>.</p>
          <p>Your password remains the same.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
          <p style="color: #888; font-size: 12px;">StaffVA Interview System — interview.staffva.com</p>
        </div>
      `,
    });
    results.push({ step: "Send Abigail notification", status: "sent" });
  } catch (err) {
    results.push({ step: "Send Abigail notification", status: "error", error: String(err) });
  }

  // STEP 5: Create Leyan's account in Supabase Auth
  try {
    const { data: existingLeyan } = await supabase.auth.admin.listUsers();
    const leyanExists = existingLeyan?.users?.find(u => u.email === "ops@glostaffing.com");

    if (leyanExists) {
      // ops@glostaffing.com was freed up by Abigail's email change, but Auth might cache
      // Try creating fresh
      const { error } = await supabase.auth.admin.createUser({
        email: "ops@glostaffing.com",
        password: "Interview@Leyan2026",
        email_confirm: true,
        user_metadata: {
          interview_role: "recruiter",
          interview_name: "Leyan",
        },
      });
      if (error) throw error;
    } else {
      const { error } = await supabase.auth.admin.createUser({
        email: "ops@glostaffing.com",
        password: "Interview@Leyan2026",
        email_confirm: true,
        user_metadata: {
          interview_role: "recruiter",
          interview_name: "Leyan",
        },
      });
      if (error) throw error;
    }
    results.push({ step: "Create Leyan account", status: "success" });
  } catch (err) {
    results.push({ step: "Create Leyan account", status: "error", error: String(err) });
  }

  // STEP 6: Add Leyan to interviewer_delegation for Support and Admin
  try {
    const { error } = await supabase
      .from("interviewer_delegation")
      .insert({
        company_id: "staffva",
        role_category: "Support and Admin",
        interviewer_name: "Leyan",
        interviewer_email: "ops@glostaffing.com",
        alternating: false,
      });
    if (error) throw error;
    results.push({ step: "Add Leyan to delegation", status: "success" });
  } catch (err) {
    results.push({ step: "Add Leyan to delegation", status: "error", error: String(err) });
  }

  // STEP 7: Remove Abigail from Support and Admin (Leyan takes over)
  try {
    const { error } = await supabase
      .from("interviewer_delegation")
      .delete()
      .eq("interviewer_name", "Abigail")
      .eq("role_category", "Support and Admin");
    if (error) throw error;
    results.push({ step: "Remove Abigail from Support and Admin", status: "success" });
  } catch (err) {
    results.push({ step: "Remove Abigail from Support and Admin", status: "error", error: String(err) });
  }

  // STEP 8: Send Leyan credential email
  try {
    await resend.emails.send({
      from: "StaffVA Interview System <noreply@staffva.com>",
      to: "ops@glostaffing.com",
      subject: "Your StaffVA Interview System access is ready",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a2e;">StaffVA Interview System</h2>
          <p>Hi Leyan,</p>
          <p>Your access to the StaffVA AI Interview System has been created.</p>
          <table style="margin: 20px 0; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 16px; font-weight: bold; background: #f5f5f5;">Login URL</td>
              <td style="padding: 8px 16px;"><a href="https://interview.staffva.com/login">interview.staffva.com/login</a></td>
            </tr>
            <tr>
              <td style="padding: 8px 16px; font-weight: bold; background: #f5f5f5;">Email</td>
              <td style="padding: 8px 16px;">ops@glostaffing.com</td>
            </tr>
            <tr>
              <td style="padding: 8px 16px; font-weight: bold; background: #f5f5f5;">Temporary Password</td>
              <td style="padding: 8px 16px; font-family: monospace;">Interview@Leyan2026</td>
            </tr>
          </table>
          <p><strong>Log in and change your password immediately from the account menu.</strong></p>
          <p>Your dashboard shows admin and VA candidates assigned to you who have passed the AI interview and are ready for a second interview.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
          <p style="color: #888; font-size: 12px;">StaffVA Interview System — interview.staffva.com</p>
        </div>
      `,
    });
    results.push({ step: "Send Leyan credentials", status: "sent" });
  } catch (err) {
    results.push({ step: "Send Leyan credentials", status: "error", error: String(err) });
  }

  // STEP 9: Send summary to Sam
  try {
    await resend.emails.send({
      from: "StaffVA Interview System <noreply@staffva.com>",
      to: "sam@glostaffing.com",
      subject: "Account changes — Abigail email updated + Leyan account created",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a2e;">Account Changes Summary</h2>
          <h3>Change 1: Abigail's email updated</h3>
          <ul>
            <li>Old email: ops@glostaffing.com</li>
            <li>New email: abbybacon2327@gmail.com</li>
            <li>Role categories: Sales and Outreach (alternating)</li>
            <li>Removed from: Support and Admin (transferred to Leyan)</li>
          </ul>
          <h3>Change 2: Leyan account created</h3>
          <ul>
            <li>Email: ops@glostaffing.com</li>
            <li>Temp password: Interview@Leyan2026</li>
            <li>Role: recruiter</li>
            <li>Assigned: Support and Admin</li>
          </ul>
          <p>Both users have been notified via email.</p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #eee;" />
          <p style="color: #888; font-size: 12px;">StaffVA Interview System — interview.staffva.com</p>
        </div>
      `,
    });
    results.push({ step: "Send Sam summary", status: "sent" });
  } catch (err) {
    results.push({ step: "Send Sam summary", status: "error", error: String(err) });
  }

  return NextResponse.json({ results });
}
