"use client";

import { useEffect, useRef, useState } from "react";
import { registerProctorListener } from "@/lib/proctorBridge";

/**
 * The camera-proctor gate for the AI interview — the interview app's twin
 * of the platform's ProctorGate, in this app's dark theme and token auth.
 * Order enforced: versioned consent (skipped when already stamped from the
 * English test), a working camera (hard requirement), then continuous
 * capture while the interview runs: 10s video chunks + a review frame
 * every 12s into the shared private bucket, with the always-visible
 * "Proctored session" indicator. The platform's review cron judges both
 * session kinds; nothing here decides anything about the candidate.
 */

interface Props {
  token: string;
  children: React.ReactNode;
}

const FRAME_INTERVAL_MS = 12_000;
const CHUNK_MS = 10_000;

export default function ProctorGate({ token, children }: Props) {
  const [phase, setPhase] = useState<"checking" | "consent" | "camera" | "live" | "blocked">("checking");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cameraLost, setCameraLost] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const attemptIdRef = useRef<string | null>(null);
  const chunkNRef = useRef(0);
  const frameNRef = useRef(0);
  const cameraLostCountRef = useRef(0);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endedRef = useRef(false);
  const previewRef = useRef<HTMLVideoElement>(null);
  const thumbRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    return registerProctorListener({
      linkAttempt: (id) => {
        attemptIdRef.current = id;
      },
    });
  }, []);

  // Consent may already be stamped from the proctored English test.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      const res = await fetch(`/api/proctor/consent?token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      if (cancelled) return;
      setPhase(data.consented ? "camera" : "consent");
      if (data.consented) requestCameraSilent();
    }
    run().catch(() => {
      if (!cancelled) setPhase("consent");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    function endSession() {
      if (endedRef.current) return;
      endedRef.current = true;
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch {
        /* already stopped */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (frameTimerRef.current) clearInterval(frameTimerRef.current);
      const sid = sessionIdRef.current;
      if (sid) {
        fetch(`/api/proctor/session/${sid}/end`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            attemptId: attemptIdRef.current || undefined,
            cameraLostCount: cameraLostCountRef.current,
          }),
          keepalive: true,
        }).catch(() => {});
      }
    }
    window.addEventListener("pagehide", endSession);
    return () => {
      window.removeEventListener("pagehide", endSession);
      endSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function upload(kind: "chunk" | "frame", n: number, blob: Blob) {
    const sid = sessionIdRef.current;
    if (!sid) return;
    const send = () =>
      fetch(`/api/proctor/session/${sid}/upload?kind=${kind}&n=${n}`, {
        method: "POST",
        headers: { "x-interview-token": token },
        body: blob,
      });
    try {
      const res = await send();
      if (!res.ok && res.status >= 500) await send();
    } catch {
      try {
        await send();
      } catch {
        /* dropped; gaps read as suspicious in review, never invisible */
      }
    }
  }

  function attachStream(stream: MediaStream) {
    streamRef.current = stream;
    if (previewRef.current) previewRef.current.srcObject = stream;
    if (thumbRef.current) thumbRef.current.srcObject = stream;

    stream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        cameraLostCountRef.current++;
        setCameraLost(true);
      };
    });

    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp8")
        ? "video/webm;codecs=vp8"
        : "video/webm",
      videoBitsPerSecond: 400_000,
    });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) upload("chunk", chunkNRef.current++, e.data);
    };
    recorder.start(CHUNK_MS);
    recorderRef.current = recorder;

    if (frameTimerRef.current) clearInterval(frameTimerRef.current);
    frameTimerRef.current = setInterval(() => {
      const video = thumbRef.current;
      if (!video || video.videoWidth === 0) return;
      const canvas = document.createElement("canvas");
      const w = 512;
      canvas.width = w;
      canvas.height = Math.round((video.videoHeight / video.videoWidth) * w);
      canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (blob) upload("frame", frameNRef.current++, blob);
        },
        "image/jpeg",
        0.6
      );
    }, FRAME_INTERVAL_MS);
  }

  async function getCamera(): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
        audio: false,
      });
    } catch {
      return null;
    }
  }

  async function requestCameraSilent() {
    const stream = await getCamera();
    if (stream) {
      streamRef.current = stream;
      if (previewRef.current) previewRef.current.srcObject = stream;
      setPhase("camera");
    } else {
      setPhase("blocked");
    }
  }

  async function requestCamera() {
    setBusy(true);
    setError("");
    await requestCameraSilent();
    setBusy(false);
  }

  async function agreeAndContinue() {
    if (!agreed || busy) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/proctor/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, version: "2.0" }),
    });
    if (!res.ok) {
      setBusy(false);
      setError("Couldn't record your consent — try again.");
      return;
    }
    setBusy(false);
    await requestCamera();
  }

  async function startSession() {
    if (busy || !streamRef.current) return;
    setBusy(true);
    setError("");
    const res = await fetch("/api/proctor/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok || !data.sessionId) {
      setError(data.error || "Couldn't start the proctored session — try again.");
      return;
    }
    sessionIdRef.current = data.sessionId;
    attachStream(streamRef.current);
    setPhase("live");
  }

  async function reconnectCamera() {
    if (busy) return;
    setBusy(true);
    const stream = await getCamera();
    if (stream) {
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch {
        /* replaced below */
      }
      attachStream(stream);
      setCameraLost(false);
    }
    setBusy(false);
  }

  if (phase === "checking") {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center">
        <p className="text-sm text-gray-400">Preparing your proctored session…</p>
      </div>
    );
  }

  if (phase === "consent") {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <div className="max-w-xl mx-auto px-6 py-12">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-8">
            <h1 className="text-lg font-semibold">Before you begin: this session is recorded</h1>
            <p className="mt-2 text-sm text-gray-400">
              To keep StaffVA fair for everyone, assessments are proctored:
            </p>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-gray-300">
              <li>
                <strong className="text-white">Your camera records the whole session.</strong> A
                visible indicator stays on screen while it&apos;s recording.
              </li>
              <li>
                <strong className="text-white">A person makes any decision.</strong> Automated
                checks review the recording and can flag a session, but only a member of the
                StaffVA team can decide an integrity issue, after watching it. If that happens,
                you&apos;ll be told why and shown the recording.
              </li>
              <li>
                <strong className="text-white">Recordings are deleted unless flagged.</strong> If
                your session isn&apos;t flagged, the recording is deleted right after the
                automated review. If it is flagged, it&apos;s kept until a decision is made and
                for 7 days after.
              </li>
              <li>
                Recording happens only with this consent. You can stop here — but proctored
                assessments are required to join the marketplace.
              </li>
            </ul>
            <label className="mt-6 flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              <span>I agree to the recorded, proctored session described above</span>
            </label>
            <button
              onClick={agreeAndContinue}
              disabled={!agreed || busy}
              className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {busy ? "One moment…" : "Continue"}
            </button>
            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  if (phase === "blocked") {
    return (
      <div className="min-h-screen bg-gray-950 text-white flex items-center justify-center px-6">
        <div className="max-w-md rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
          <h1 className="text-lg font-semibold">A working camera is required</h1>
          <p className="mt-2 text-sm leading-relaxed text-gray-400">
            Interviews on StaffVA are proctored, and we couldn&apos;t access a camera — it may be
            missing, in use by another app, or blocked in your browser&apos;s permissions.
            Connect one, allow access, and try again.
          </p>
          <button
            onClick={requestCamera}
            disabled={busy}
            className="mt-5 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {busy ? "Checking…" : "Try again"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "camera") {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <div className="max-w-xl mx-auto px-6 py-12">
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-8">
            <h1 className="text-lg font-semibold">Camera check</h1>
            <p className="mt-2 text-sm text-gray-400">
              Make sure you&apos;re clearly visible and alone. Recording starts when the interview
              begins.
            </p>
            <div className="mt-4 overflow-hidden rounded-lg bg-black">
              <video ref={previewRef} autoPlay muted playsInline className="aspect-video w-full object-cover" />
            </div>
            <button
              onClick={startSession}
              disabled={busy}
              className="mt-5 w-full rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {busy ? "Starting…" : "Begin the proctored interview"}
            </button>
            {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      {children}

      <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-lg border border-gray-700 bg-gray-900 p-2 shadow-lg">
        <video ref={thumbRef} autoPlay muted playsInline className="h-12 w-16 rounded object-cover bg-black" />
        <div className="pr-1">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold text-white">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" aria-hidden />
            Proctored session
          </p>
          <p className="text-[10px] text-gray-400">Camera is recording</p>
        </div>
      </div>

      {cameraLost && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-6 text-center text-white">
            <p className="text-sm font-semibold">Camera disconnected</p>
            <p className="mt-2 text-xs leading-relaxed text-gray-400">
              The proctored session requires your camera. Reconnect it to continue — the
              interruption is noted in the session record.
            </p>
            <button
              onClick={reconnectCamera}
              disabled={busy}
              className="mt-4 rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {busy ? "Reconnecting…" : "Reconnect camera"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
