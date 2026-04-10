"use client";

import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface DashboardNavProps {
  user: {
    name: string;
    email: string;
    role: string;
  };
}

export default function DashboardNav({ user }: DashboardNavProps) {
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <nav className="border-b border-gray-800 px-6 py-4">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-6">
          <h1 className="font-bold text-lg">StaffVA Interviews</h1>
          {user.role === "admin" && (
            <div className="flex gap-4 text-sm">
              <a href="/dashboard/admin" className="text-gray-400 hover:text-white transition-colors">All Interviews</a>
              <a href="/dashboard/admin/recruiters" className="text-gray-400 hover:text-white transition-colors">Recruiters</a>
            </div>
          )}
          {user.role === "recruiter" && (
            <div className="flex gap-4 text-sm">
              <a href="/recruiter" className="text-gray-400 hover:text-white transition-colors">My Candidates</a>
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-gray-500">{user.name} ({user.role})</span>
          <a href="/dashboard/change-password" className="text-sm text-gray-400 hover:text-white transition-colors">
            Change Password
          </a>
          <button
            onClick={handleSignOut}
            className="text-sm text-gray-400 hover:text-red-400 transition-colors"
          >
            Sign Out
          </button>
        </div>
      </div>
    </nav>
  );
}
