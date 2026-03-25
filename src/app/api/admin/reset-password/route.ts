import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Resend } from "resend";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  try {
    const { email } = await request.json();

    if (!email) {
      return NextResponse.json({ error: "Missing email" }, { status: 400 });
    }

    const supabase = createSupabaseServiceClient();

    // Find the user
    const { data: userList } = await supabase.auth.admin.listUsers();
    const targetUser = userList?.users?.find((u: { email?: string }) => u.email === email);

    if (!targetUser) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Generate secure random password
    const newPassword = "Reset@" + crypto.randomBytes(4).toString("hex").toUpperCase() + "!";

    // Update password
    const { error: updateError } = await supabase.auth.admin.updateUserById(targetUser.id, {
      password: newPassword,
    });

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    const recruiterName = targetUser.user_metadata?.interview_name || targetUser.user_metadata?.name || "Team member";
    const resend = new Resend(process.env.RESEND_API_KEY);

    // Email to recruiter
    await resend.emails.send({
      from: "StaffVA Interview System <noreply@staffva.com>",
      to: email,
      subject: "Your StaffVA Interview System password has been reset",
      html: "<p>Hi " + recruiterName + ",</p>" +
        "<p>Your StaffVA Interview System password has been reset by the administrator.</p>" +
        "<p><strong>Your new temporary password is:</strong> " + newPassword + "</p>" +
        "<p>Login at <a href='https://interview.staffva.com/login'>interview.staffva.com/login</a> and change your password immediately from the account menu.</p>",
    });

    // Confirmation email to admin
    await resend.emails.send({
      from: "StaffVA Interview System <noreply@staffva.com>",
      to: "sam@glostaffing.com",
      subject: "Password reset confirmation — " + email,
      html: "<p>Password reset completed for:</p>" +
        "<p><strong>Account:</strong> " + recruiterName + " (" + email + ")<br>" +
        "<strong>New temporary password:</strong> " + newPassword + "</p>",
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reset failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
