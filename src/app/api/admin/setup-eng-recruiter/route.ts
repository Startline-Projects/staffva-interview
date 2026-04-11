import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const RECRUITER_EMAIL = "test-recruiter-eng@staffva.com";
const RECRUITER_PASSWORD = "TestRecruiter2026!";
const RECRUITER_NAME = "Test Engineer Recruiter";
const CANDIDATE_EMAIL = "awan@devisnor.com";
const CANDIDATE_ROLE_CATEGORY = "Software Engineer";

export async function POST() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const results: { step: string; status: string; detail?: string }[] = [];

  // ── Step 1: Find or create the auth user ─────────────────────────────
  const { data: { users }, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr || !users) {
    return NextResponse.json({ error: "Failed to list users", detail: String(listErr) }, { status: 500 });
  }

  let recruiterUserId: string;
  const recruiterUser = users.find((u) => u.email === RECRUITER_EMAIL);

  if (recruiterUser) {
    recruiterUserId = recruiterUser.id;
    results.push({ step: "Find auth user", status: "found", detail: recruiterUserId });

    // Grant recruiter role if not already set
    const existingRole = recruiterUser.user_metadata?.interview_role;
    if (existingRole === "recruiter") {
      results.push({ step: "Grant recruiter role", status: "already set" });
    } else {
      const { error: updateErr } = await supabase.auth.admin.updateUserById(recruiterUserId, {
        password: RECRUITER_PASSWORD,
        email_confirm: true,
        user_metadata: {
          ...recruiterUser.user_metadata,
          interview_role: "recruiter",
          interview_name: RECRUITER_NAME,
        },
      });
      if (updateErr) {
        return NextResponse.json({ error: "Failed to update user metadata", detail: String(updateErr) }, { status: 500 });
      }
      results.push({ step: "Grant recruiter role", status: "success" });
    }
  } else {
    // Auth user doesn't exist yet — create it
    const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
      email: RECRUITER_EMAIL,
      password: RECRUITER_PASSWORD,
      email_confirm: true,
      user_metadata: {
        interview_role: "recruiter",
        interview_name: RECRUITER_NAME,
      },
    });
    if (createErr || !newUser.user) {
      return NextResponse.json({ error: "Failed to create auth user", detail: String(createErr) }, { status: 500 });
    }
    recruiterUserId = newUser.user.id;
    results.push({ step: "Create auth user", status: "created", detail: recruiterUserId });
  }

  // ── Step 2: Ensure profiles row exists ───────────────────────────────
  const { data: existingProfile } = await supabase
    .from("profiles")
    .select("id")
    .eq("email", RECRUITER_EMAIL)
    .maybeSingle();

  let profileId: string;
  if (existingProfile) {
    profileId = existingProfile.id;
    results.push({ step: "Ensure profiles row", status: "already exists", detail: profileId });
  } else {
    const { data: newProfile, error: insertErr } = await supabase
      .from("profiles")
      .insert({ id: recruiterUserId, email: RECRUITER_EMAIL, full_name: RECRUITER_NAME })
      .select("id")
      .single();
    if (insertErr) {
      return NextResponse.json({ error: "Failed to insert profile", detail: String(insertErr) }, { status: 500 });
    }
    profileId = newProfile.id;
    results.push({ step: "Ensure profiles row", status: "created", detail: profileId });
  }

  // ── Step 3: Find or create the candidate ─────────────────────────────
  let candidateId: string;
  let roleCategory: string;

  const { data: candidate } = await supabase
    .from("candidates")
    .select("id, display_name, role_category, email")
    .eq("email", CANDIDATE_EMAIL)
    .maybeSingle();

  if (candidate) {
    candidateId = candidate.id;
    roleCategory = candidate.role_category || CANDIDATE_ROLE_CATEGORY;
    results.push({
      step: "Find candidate",
      status: "found",
      detail: `${candidate.display_name} — ${roleCategory}`,
    });
  } else {
    // Candidate doesn't exist yet — create a minimal record
    const { data: newCandidate, error: candInsertErr } = await supabase
      .from("candidates")
      .insert({
        email: CANDIDATE_EMAIL,
        display_name: "Awan (Test Candidate)",
        role_category: CANDIDATE_ROLE_CATEGORY,
        country: "Test",
      })
      .select("id")
      .single();
    if (candInsertErr) {
      return NextResponse.json({ error: "Failed to create candidate", detail: String(candInsertErr) }, { status: 500 });
    }
    candidateId = newCandidate.id;
    roleCategory = CANDIDATE_ROLE_CATEGORY;
    results.push({ step: "Create candidate", status: "created", detail: candidateId });
  }

  // Check for a completed, passed interview
  const { data: interview } = await supabase
    .from("ai_interviews")
    .select("id, role_category, passed, completed_at")
    .eq("candidate_id", candidateId)
    .eq("passed", true)
    .not("completed_at", "is", null)
    .maybeSingle();

  if (interview) {
    roleCategory = interview.role_category || roleCategory;
    results.push({ step: "Verify passed interview", status: "found", detail: interview.id });
  } else {
    results.push({
      step: "Verify passed interview",
      status: "warning",
      detail: "No completed+passed interview found — candidate will not appear in recruiter view until one exists",
    });
  }

  // ── Step 4: Create interviewer_delegation row ────────────────────────
  const { data: existingDelegation } = await supabase
    .from("interviewer_delegation")
    .select("interviewer_email")
    .eq("interviewer_email", RECRUITER_EMAIL)
    .eq("role_category", roleCategory)
    .maybeSingle();

  if (existingDelegation) {
    results.push({ step: "Create interviewer_delegation", status: "already exists" });
  } else {
    const { error: delErr } = await supabase.from("interviewer_delegation").insert({
      interviewer_email: RECRUITER_EMAIL,
      interviewer_name: RECRUITER_NAME,
      role_category: roleCategory,
    });
    if (delErr) {
      return NextResponse.json({ error: "Failed to insert delegation", detail: String(delErr) }, { status: 500 });
    }
    results.push({ step: "Create interviewer_delegation", status: "created", detail: roleCategory });
  }

  // ── Step 5: Create recruiter_assignments row ─────────────────────────
  const { data: existingAssignment } = await supabase
    .from("recruiter_assignments")
    .select("recruiter_id")
    .eq("recruiter_id", profileId)
    .eq("role_category", roleCategory)
    .maybeSingle();

  if (existingAssignment) {
    results.push({ step: "Create recruiter_assignments", status: "already exists" });
  } else {
    const { error: assignErr } = await supabase.from("recruiter_assignments").insert({
      recruiter_id: profileId,
      role_category: roleCategory,
    });
    if (assignErr) {
      return NextResponse.json({ error: "Failed to insert assignment", detail: String(assignErr) }, { status: 500 });
    }
    results.push({ step: "Create recruiter_assignments", status: "created", detail: roleCategory });
  }

  // ── Step 6: Verify scope — only assigned role_category visible ───────
  const { data: allAssignments } = await supabase
    .from("recruiter_assignments")
    .select("role_category")
    .eq("recruiter_id", profileId);

  const { data: allDelegations } = await supabase
    .from("interviewer_delegation")
    .select("role_category")
    .eq("interviewer_email", RECRUITER_EMAIL);

  // Count how many passed candidates exist in this role_category
  const { count: visibleCandidateCount } = await supabase
    .from("ai_interviews")
    .select("id", { count: "exact", head: true })
    .in("role_category", allAssignments?.map((a) => a.role_category) || [])
    .eq("passed", true)
    .not("completed_at", "is", null);

  results.push({
    step: "Assignment scope check",
    status: "info",
    detail: `recruiter_assignments: [${allAssignments?.map((a) => a.role_category).join(", ")}] | interviewer_delegation: [${allDelegations?.map((d) => d.role_category).join(", ")}] | visible candidates: ${visibleCandidateCount ?? 0}`,
  });

  return NextResponse.json({
    message: "Setup complete",
    recruiterEmail: RECRUITER_EMAIL,
    candidateEmail: CANDIDATE_EMAIL,
    roleCategory,
    results,
  });
}
