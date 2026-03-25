import { redirect } from "next/navigation";

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;

  // If a candidate token is present, route to the interview flow
  if (params.token) {
    redirect("/interview?token=" + encodeURIComponent(params.token));
  }

  // No token — this is a recruiter/admin visiting directly
  redirect("/login");
}
