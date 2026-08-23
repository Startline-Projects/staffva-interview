import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSessionUser } from "@/lib/auth/get-session-user";
import { Resend } from "resend";
import crypto from "crypto";

export async function POST(request: NextRequest) {
  try {
    // Admin only. This route resets an arbitrary user's password via the
    // service role; previously it had no auth at all, so anyone could reset
    // any account's password (including an admin's) by posting their email.
    const sessionUser = await getSessionUser();
    if (!sessionUser || sessionUser.role !== "admin") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

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

    // resend.emails.send RESOLVES with { data, error } — it does not throw. So
    // awaiting it without inspecting the result meant a rejected send looked
    // exactly like a delivered one. The password has already been changed at
    // this point and this email is the only copy of the new one, so that
    // silently locked the account holder out for good.
    const { error: recruiterMailError } = await resend.emails.send({
      from: "StaffVA Interview System <noreply@staffva.com>",
      to: email,
      subject: "Your StaffVA Interview System password has been reset",
      html: "<p>Hi " + recruiterName + ",</p>" +
        "<p>Your StaffVA Interview System password has been reset by the administrator.</p>" +
        "<p><strong>Your new temporary password is:</strong> " + newPassword + "</p>" +
        "<p>Login at <a href='https://interview.staffva.com/login'>interview.staffva.com/login</a> and change your password immediately from the account menu.</p>",
    });

    if (recruiterMailError) {
      return NextResponse.json(
        {
          error:
            "The password was reset, but the email to the account holder could not be sent — they are now locked out. Reset again once email delivery is working.",
          detail: recruiterMailError.message,
        },
        { status: 500 }
      );
    }

    // Notification only — non-fatal, and not the only route to the password.
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
