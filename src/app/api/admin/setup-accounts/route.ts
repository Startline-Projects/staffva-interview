import { NextResponse } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Resend } from "resend";

const ACCOUNTS = [
  { email: "sam@glostaffing.com", password: "Interview@Admin2026", role: "admin", name: "Sam" },
  { email: "careers@globalstaffing.asia", password: "Interview@Manar2026", role: "recruiter", name: "Manar" },
  { email: "hr@glostaffing.com", password: "Interview@Ranim2026", role: "recruiter", name: "Ranim" },
  { email: "support@glostaffing.com", password: "Interview@Jerome2026", role: "recruiter", name: "Jerome" },
  { email: "ops@glostaffing.com", password: "Interview@Abigail2026", role: "recruiter", name: "Abigail" },
  { email: "marketing@glostaffing.com", password: "Interview@Shelly2026", role: "recruiter", name: "Shelly" },
  { email: "zak@glostaffing.com", password: "Interview@Ibraheem2026", role: "recruiter", name: "Ibraheem" },
  { email: "info@glostaffing.com", password: "Interview@Eslam2026", role: "recruiter", name: "Eslam" },
];

export async function POST() {
  try {
    const supabase = createSupabaseServiceClient();
    const resend = new Resend(process.env.RESEND_API_KEY);

    const results: Array<{ email: string; status: string; error?: string }> = [];
    const adminSummaryLines: string[] = [];

    for (const account of ACCOUNTS) {
      try {
        // Try to create user, if exists update their metadata
        const { error: createError } = await supabase.auth.admin.createUser({
          email: account.email,
          password: account.password,
          email_confirm: true,
          user_metadata: {
            role: account.role,
            name: account.name,
            interview_role: account.role,
          },
        });

        if (createError && createError.message.includes("already")) {
          // User exists — find them and update metadata + password
          const { data: userList } = await supabase.auth.admin.listUsers();
          const existingUser = userList?.users?.find((u: { email?: string }) => u.email === account.email);

          if (existingUser) {
            await supabase.auth.admin.updateUserById(existingUser.id, {
              password: account.password,
              user_metadata: {
                ...existingUser.user_metadata,
                interview_role: account.role,
                interview_name: account.name,
              },
            });
            results.push({ email: account.email, status: "updated", error: undefined });
          } else {
            results.push({ email: account.email, status: "error", error: "User exists but not found in list" });
            continue;
          }
        } else if (createError) {
          results.push({ email: account.email, status: "error", error: createError.message });
          continue;
        } else {
          results.push({ email: account.email, status: "created", error: undefined });
        }
        adminSummaryLines.push(account.name + " — " + account.email + " — " + account.password + " — " + account.role);

        // Send credential email to the user
        if (account.role === "recruiter") {
          await resend.emails.send({
            from: "StaffVA Interview System <noreply@staffva.com>",
            to: account.email,
            subject: "Your StaffVA Interview System access is ready",
            html: "<p>Hi " + account.name + ",</p>" +
              "<p>Your access to the StaffVA AI Interview System has been created.</p>" +
              "<p><strong>Login URL:</strong> interview.staffva.com/login<br>" +
              "<strong>Email:</strong> " + account.email + "<br>" +
              "<strong>Temporary password:</strong> " + account.password + "</p>" +
              "<p>Log in and change your password immediately from the account menu.</p>" +
              "<p>Your dashboard shows candidates in your assigned categories who have passed the AI interview and are ready for a second interview with you.</p>",
          });
        }

        // Small delay to avoid rate limiting
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        results.push({ email: account.email, status: "error", error: msg });
      }
    }

    // Send summary email to admin
    if (adminSummaryLines.length > 0) {
      await resend.emails.send({
        from: "StaffVA Interview System <noreply@staffva.com>",
        to: "sam@glostaffing.com",
        subject: "StaffVA Interview System — All accounts created",
        html: "<p>The following accounts have been created:</p>" +
          "<table border='1' cellpadding='8' cellspacing='0' style='border-collapse:collapse;'>" +
          "<tr><th>Name</th><th>Email</th><th>Temp Password</th><th>Role</th></tr>" +
          adminSummaryLines.map((line) => {
            const parts = line.split(" — ");
            return "<tr><td>" + parts[0] + "</td><td>" + parts[1] + "</td><td>" + parts[2] + "</td><td>" + parts[3] + "</td></tr>";
          }).join("") +
          "</table>",
      });
    }

    return NextResponse.json({ results });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Setup failed";
    console.error("Setup accounts error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
