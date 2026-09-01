import { NextRequest, NextResponse } from "next/server";
import { verifyInterviewToken } from "@/lib/auth/verify-token";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

// Interview sessions run up to ~25 minutes: ~150 chunks / ~125 frames.
// Triple-ish headroom; beyond it uploads drop (202) rather than erroring —
// a truncated recording reads as suspicious in review, so the cap can't
// hide a session's end.
const MAX_CHUNKS = 400;
const MAX_FRAMES = 300;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 400 * 1024;

/** Width/height from a JPEG's SOF marker; null if it isn't a sane JPEG. */
function jpegDimensions(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 12 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * POST /api/proctor/session/[id]/upload?kind=chunk|frame&n=N
 * Raw body; interview token in the x-interview-token header (binary body
 * leaves no room for a JSON field). Candidate-owned recording sessions only.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = req.headers.get("x-interview-token");
  if (!token) return NextResponse.json({ error: "Missing token" }, { status: 401 });
  let candidateId: string;
  try {
    candidateId = verifyInterviewToken(token).candidate_id;
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const kind = req.nextUrl.searchParams.get("kind");
  const n = parseInt(req.nextUrl.searchParams.get("n") || "", 10);
  if ((kind !== "chunk" && kind !== "frame") || !Number.isInteger(n) || n < 0 || n > 100000) {
    return NextResponse.json({ error: "Bad params" }, { status: 400 });
  }

  const supabase = createSupabaseServiceClient();
  const { data: session } = await supabase
    .from("proctor_sessions")
    .select("id, candidate_id, storage_prefix, chunk_count, frame_count, review_status")
    .eq("id", id)
    .single();
  if (!session || session.candidate_id !== candidateId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (session.review_status !== "recording") {
    return NextResponse.json({ error: "Session ended" }, { status: 409 });
  }

  const body = Buffer.from(await req.arrayBuffer());
  const maxBytes = kind === "chunk" ? MAX_CHUNK_BYTES : MAX_FRAME_BYTES;
  if (body.length === 0 || body.length > maxBytes) {
    return NextResponse.json({ error: "Bad size" }, { status: 413 });
  }
  if (kind === "frame") {
    const dims = jpegDimensions(body);
    if (!dims || dims.w > 1024 || dims.h > 1024 || dims.w < 16 || dims.h < 16) {
      return NextResponse.json({ error: "Bad frame" }, { status: 415 });
    }
  }

  const count = kind === "chunk" ? session.chunk_count : session.frame_count;
  const cap = kind === "chunk" ? MAX_CHUNKS : MAX_FRAMES;
  if (count >= cap) return NextResponse.json({ dropped: true }, { status: 202 });

  const path =
    kind === "chunk"
      ? `${session.storage_prefix}/video/chunk-${String(n).padStart(5, "0")}.webm`
      : `${session.storage_prefix}/frames/frame-${String(n).padStart(5, "0")}.jpg`;

  const { error: upErr } = await supabase.storage
    .from("proctor-recordings")
    .upload(path, body, {
      contentType: kind === "chunk" ? "video/webm" : "image/jpeg",
      upsert: true,
    });
  if (upErr) return NextResponse.json({ error: "Upload failed" }, { status: 502 });

  await supabase
    .from("proctor_sessions")
    .update(kind === "chunk" ? { chunk_count: count + 1 } : { frame_count: count + 1 })
    .eq("id", id);

  return NextResponse.json({ ok: true });
}
