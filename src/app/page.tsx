import { redirect } from "next/navigation";
import { generateInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

interface PageProps {
  searchParams: Promise<{ token?: string; candidate?: string }>;
}

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;

  // If a signed JWT token is present, route to the interview flow
  if (params.token) {
    redirect("/interview?token=" + encodeURIComponent(params.token));
  }

  // If a candidate UUID is present (from StaffVA dashboard),
  // verify the candidate exists, generate a JWT, and redirect
  if (params.candidate) {
    const supabase = createSupabaseServiceClient();
    const { data: candidate } = await supabase
      .from("candidates")
      .select("id")
      .eq("id", params.candidate)
      .single();

    if (candidate) {
      const token = generateInterviewToken(candidate.id);
      redirect("/interview?token=" + encodeURIComponent(token));
    }

    // Invalid candidate ID — redirect to login with error
    redirect("/login?error=invalid_candidate");
  }

  // No token and no candidate — this is a recruiter/admin visiting directly
  redirect("/login");
}
