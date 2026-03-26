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

  // STEP 1: Find Abigail's user ID
  const { data: { users } } = await supabase.auth.admin.listUsers();
  const abigail = users?.find(u => u.email === "ops@glostaffing.com" || u.email === "abbybacon2327@gmail.com");

  if (!abigail) {
    return NextResponse.json({ error: "Abigail account not found" }, { status: 404 });
  }

  // STEP 2: Update Abigail's email — force confirm to skip verification
  if (abigail.email !== "abbybacon2327@gmail.com") {
    try {
      const { error } = await supabase.auth.admin.updateUserById(abigail.id, {
        email: "abbybacon2327@gmail.com",
        email_confirm: true,
      });
      if (error) throw error;
      results.push({ step: "Update Abigail email in Auth", status: "success" });
    } catch (err) {
      results.push({ step: "Update Abigail email in Auth", status: "error", error: String(err) });
    }
  } else {
    results.push({ step: "Update Abigail email in Auth", status: "already done" });
  }

  // STEP 3: Create Leyan account
  const leyanExists = users?.find(u => u.email === "ops@glostaffing.com");
  if (leyanExists && leyanExists.id !== abigail.id) {
    // Leyan already exists, just update metadata
    try {
      const { error } = await supabase.auth.admin.updateUserById(leyanExists.id, {
        user_metadata: { interview_role: "recruiter", interview_name: "Leyan" },
      });
      if (error) throw error;
      results.push({ step: "Update Leyan metadata", status: "success" });
    } catch (err) {
      results.push({ step: "Update Leyan metadata", status: "error", error: String(err) });
    }
  } else if (!leyanExists || leyanExists.id === abigail.id) {
    // Create fresh — ops@glostaffing.com should now be free
    try {
      const { error } = await supabase.auth.admin.createUser({
        email: "ops@glostaffing.com",
        password: "Interview@Leyan2026",
        email_confirm: true,
        user_metadata: { interview_role: "recruiter", interview_name: "Leyan" },
      });
      if (error) throw error;
      results.push({ step: "Create Leyan account", status: "success" });
    } catch (err) {
      results.push({ step: "Create Leyan account", status: "error", error: String(err) });
    }
  }

  return NextResponse.json({ results });
}
