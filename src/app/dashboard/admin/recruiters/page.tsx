import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/get-session-user";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import ResetPasswordButton from "@/components/ResetPasswordButton";
import Link from "next/link";

interface RecruiterRow {
  email: string;
  name: string;
  categories: string[];
  lastSignIn: string | null;
}

export default async function RecruitersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/dashboard");

  const supabase = createSupabaseServiceClient();

  // Get all delegations
  const { data: delegations } = await supabase
    .from("interviewer_delegation")
    .select("interviewer_email, interviewer_name, role_category");

  // Group by recruiter email
  const recruiterMap: Record<string, { name: string; categories: string[] }> = {};
  for (const d of delegations || []) {
    if (!recruiterMap[d.interviewer_email]) {
      recruiterMap[d.interviewer_email] = { name: d.interviewer_name, categories: [] };
    }
    recruiterMap[d.interviewer_email].categories.push(d.role_category);
  }

  // Get auth users for last sign in
  const { data: authData } = await supabase.auth.admin.listUsers();
  const authUsers = authData?.users || [];

  // Build recruiter rows
  // The four per-recruiter tallies that used to sit here (Total / Pending /
  // Scheduled / Completed) counted the second-interview status column. All 57
  // rows held 'pending' and none was ever anything else, so those columns
  // reported a workload that never existed. The page's real value is the roster,
  // the last login and the password reset, all of which are untouched.
  const rows: RecruiterRow[] = Object.entries(recruiterMap).map(([email, info]) => {
    const authUser = authUsers.find((u: { email?: string }) => u.email === email);

    return {
      email,
      name: info.name,
      categories: info.categories,
      lastSignIn: authUser?.last_sign_in_at || null,
    };
  });

  return (
    <div>
      <div className="mb-6">
        <Link href="/dashboard/admin" className="text-gray-500 hover:text-white text-sm mb-4 inline-block">&larr; Back to all interviews</Link>
        <h2 className="text-2xl font-bold">Recruiters</h2>
        <p className="text-gray-500 mt-1">{rows.length} recruiters configured</p>
      </div>

      <div className="bg-gray-900 rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-800 text-left text-sm text-gray-500">
              <th className="px-5 py-3">Recruiter</th>
              <th className="px-5 py-3">Categories</th>
              <th className="px-5 py-3">Last Login</th>
              <th className="px-5 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.email} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                <td className="px-5 py-4">
                  <p className="font-medium">{row.name}</p>
                  <p className="text-gray-500 text-xs">{row.email}</p>
                </td>
                <td className="px-5 py-4">
                  <div className="flex flex-wrap gap-1">
                    {row.categories.map((c) => (
                      <span key={c} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">{c}</span>
                    ))}
                  </div>
                </td>
                <td className="px-5 py-4 text-xs text-gray-500">
                  {row.lastSignIn ? new Date(row.lastSignIn).toLocaleString() : "Never"}
                </td>
                <td className="px-5 py-4">
                  <ResetPasswordButton recruiterEmail={row.email} recruiterName={row.name} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
