import { redirect } from "next/navigation";

interface PageProps {
  searchParams: Promise<{ token?: string }>;
}

export default async function Home({ searchParams }: PageProps) {
  const params = await searchParams;

  // If a signed JWT token is present, route to the interview flow
  if (params.token) {
    redirect("/interview?token=" + encodeURIComponent(params.token));
  }

  // The ?candidate=<uuid> branch is gone. It minted a valid interview token for
  // any candidate id, with no session and no ownership check — and candidate
  // ids are not secret: the public browse policy makes approved candidates
  // readable by anon. So anyone could mint a token and drive the interview
  // endpoints, which each cost an Anthropic call, an ElevenLabs synthesis and a
  // Deepgram transcription. It also meant the per-candidate rate limits bounded
  // nothing in aggregate, since an attacker could simply pick a new id.
  //
  // The platform now mints the token itself, where the session already proves
  // the caller owns the profile, and links here with ?token= — the same path
  // the candidate dashboard already used.
  redirect("/login");
}
