import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  name: string;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) return null;

  const role = user.user_metadata?.interview_role;
  const name = user.user_metadata?.interview_name || user.user_metadata?.name || "User";

  if (!role) return null;

  return {
    id: user.id,
    email: user.email || "",
    role,
    name,
  };
}
