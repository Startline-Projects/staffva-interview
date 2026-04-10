import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/get-session-user";
import DashboardNav from "@/components/DashboardNav";

export default async function RecruiterLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  if (!user) {
    redirect("/login");
  }

  if (user.role !== "recruiter" && user.role !== "admin") {
    redirect("/login");
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <DashboardNav user={user} />
      <main className="max-w-7xl mx-auto px-6 py-8">
        {children}
      </main>
    </div>
  );
}
