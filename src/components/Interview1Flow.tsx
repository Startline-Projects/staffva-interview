"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import StaffvaLogo from "@/components/landing/StaffvaLogo";
import { useIv1Proctor } from "@/components/useIv1Proctor";
import "@/app/landing.css";
import "@/app/atlas-auth.css";

/**
 * Interview 1 — the Atlas behavioral interview. Structured turns served by
 * the server one at a time: typed greeting, then per question a prep
 * window (thinking encouraged, mic locked), an answer window (manual
 * record toggle), and at most one adaptive follow-up. The orb is the
 * interviewer's presence; the question text is the caption.
 */

type Stage =
  | "consent"
  | "preflight"
  | "rules"
  | "scan"
  | "start"
  | "greeting"
  | "question"
  | "closing"
  | "post"
  | "already_passed"
  | "retake_locked"
  | "camera_denied"
  | "error";

interface Turn {
  id: string;
  text: string;
  prepSeconds: number;
  answerSeconds: number;
  isFollowUp: boolean;
}

// Elapsed, not a countdown: the only real limits are per question, and a
// prominent 24:30 deadline that nothing enforces is a lie that also rushes
// people. Atlas's global clock was set-dressing.
const TYPE_MS_PER_CHAR = 30;
const MIN_RECORDING_MS = 2_000;

const SCAN_STAGES = [
  { at: 600, text: "Start turning slowly to your left…" },
  { at: 2000, text: "Keep going — about a quarter turn…" },
  { at: 3400, text: "Halfway there — keep it steady…" },
  { at: 4800, text: "Almost all the way around…" },
  { at: 6200, text: "Done — thanks. The scan is recorded." },
];

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Orb({ state, size }: { state: "listening" | "thinking" | "speaking"; size?: number }) {
  return (
    <div
      className={`ai-orb ${state}`}
      aria-hidden
      style={size ? { width: size, height: size } : undefined}
    >
      <div className="ai-orb-ring outer"></div>
      <div className="ai-orb-ring"></div>
      <div className="ai-orb-core"></div>
    </div>
  );
}

export default function Interview1Flow({
  token,
  firstName,
}: {
  token: string;
  firstName: string;
}) {
  const proctor = useIv1Proctor(token);

  const [stage, setStage] = useState<Stage>("consent");
  const [consentChecked, setConsentChecked] = useState(false);
  const [rulesChecked, setRulesChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fatalError, setFatalError] = useState("");

  // preflight
  const [pfState, setPfState] = useState<Record<string, "idle" | "checking" | "passed" | "failed">>(
    { webcam: "idle", mic: "idle", connection: "idle" }
  );
  const [pfDone, setPfDone] = useState(false);
  const [pfFailed, setPfFailed] = useState(false);

  // scan
  const [scanText, setScanText] = useState("Start rotating slowly…");
  const [scanDone, setScanDone] = useState(false);

  // runner
  const [interviewId, setInterviewId] = useState("");
  const [greeting, setGreeting] = useState("");
  const [typedChars, setTypedChars] = useState(0);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [turnIndex, setTurnIndex] = useState(0);
  const [total, setTotal] = useState(5);
  const [phase, setPhase] = useState<"prep" | "answer">("prep");
  const [phaseLeft, setPhaseLeft] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [recState, setRecState] = useState<"idle" | "recording" | "saving">("idle");
  const [uploadFailed, setUploadFailed] = useState(false);
  const [retakeAt, setRetakeAt] = useState("");

  const phaseDeadlineRef = useRef(0);
  const globalDeadlineRef = useRef(0);
  const recorderRef = useRef<{ stop: () => Promise<Blob> } | null>(null);
  const recStartRef = useRef(0);
  const turnRef = useRef<Turn | null>(null);
  const phaseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadFailedRef = useRef(false);
  const submittingTurnRef = useRef(false);
  const failedBlobRef = useRef<Blob | null>(null);

  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);
  useEffect(() => {
    uploadFailedRef.current = uploadFailed;
  }, [uploadFailed]);

  // ═══ Preflight (real checks) ═══
  const runPreflight = useCallback(async () => {
    setPfDone(false);
    setPfFailed(false);
    setPfState({ webcam: "checking", mic: "idle", connection: "idle" });
    const ok = await proctor.acquire();
    if (!ok) {
      setStage("camera_denied");
      return;
    }
    const tracks = proctor.hasTracks();
    setPfState((s) => ({ ...s, webcam: tracks.video ? "passed" : "failed", mic: "checking" }));
    await new Promise((r) => setTimeout(r, 1200));
    setPfState((s) => ({ ...s, mic: tracks.audio ? "passed" : "failed", connection: "checking" }));
    let online = false;
    try {
      const ping = await fetch("/favicon.ico", { cache: "no-store", method: "HEAD" });
      online = ping.ok || ping.status < 500;
    } catch {
      online = false;
    }
    setPfState((s) => ({ ...s, connection: online ? "passed" : "failed" }));
    if (tracks.video && tracks.audio && online) setPfDone(true);
    else setPfFailed(true);
  }, [proctor]);

  useEffect(() => {
    if (stage === "preflight") runPreflight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // ═══ Scan ═══
  useEffect(() => {
    if (stage !== "scan") return;
    setScanDone(false);
    setScanText("Start rotating slowly…");
    const timers = SCAN_STAGES.map((s) => setTimeout(() => setScanText(s.text), s.at));
    timers.push(setTimeout(() => setScanDone(true), 6800));
    return () => timers.forEach(clearTimeout);
  }, [stage]);

  // ═══ Consent / rules handlers ═══
  async function handleConsent() {
    if (!consentChecked || busy) return;
    setBusy(true);
    setError("");
    const ok = await proctor.recordConsent();
    setBusy(false);
    if (!ok) {
      setError("We couldn't record your consent — try again.");
      return;
    }
    setStage("preflight");
  }

  async function handleRules() {
    if (!rulesChecked || busy) return;
    setBusy(true);
    setError("");
    const ok = await proctor.startSession();
    setBusy(false);
    if (!ok) {
      setError("We couldn't start the proctored session — try again.");
      return;
    }
    setStage("scan");
  }

  // ═══ Start: open the session ═══
  async function handleStart() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/interview1/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action: "start" }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.alreadyPassed) {
        setStage("already_passed");
        return;
      }
      if (res.status === 403 && data.error?.includes("Retake")) {
        setRetakeAt(data.error);
        setStage("retake_locked");
        return;
      }
      if (!res.ok || !data.interviewId || !data.question) {
        setError(data.error || "We couldn't start the interview. Try again in a moment.");
        return;
      }
      // Only now — a card state (already passed, retake locked, error) must
      // never be trapped in a fullscreen page with no way out.
      document.documentElement.requestFullscreen?.().catch(() => {});
      proctor.linkAttempt(data.interviewId);
      setInterviewId(data.interviewId);
      setGreeting(data.greeting);
      setTotal(data.total);
      setTurn(data.question);
      setTurnIndex(data.index ?? data.answered ?? 0);
      globalDeadlineRef.current = Date.now();
      setTypedChars(0);
      setStage("greeting");
    } catch {
      setError("We couldn't reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  // ═══ Greeting type-out ═══
  useEffect(() => {
    if (stage !== "greeting" || !greeting) return;
    if (typedChars >= greeting.length) return;
    const t = setTimeout(() => setTypedChars((n) => n + 1), TYPE_MS_PER_CHAR);
    return () => clearTimeout(t);
  }, [stage, greeting, typedChars]);

  // ═══ Global clock (display) ═══
  useEffect(() => {
    if (stage !== "greeting" && stage !== "question" && stage !== "closing") return;
    const t = setInterval(() => {
      setElapsed(Math.round((Date.now() - globalDeadlineRef.current) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [stage]);

  // ═══ Per-turn phase timers (deadline-based) ═══
  // ONE interval, owned by this effect through a ref, for both phases. The
  // answer phase used to start its own local interval that cleared only at
  // zero — it survived into the NEXT question and fired a stale submitTurn
  // there, eating that question's recording.
  const stopPhaseTimer = useCallback(() => {
    if (phaseTimerRef.current) {
      clearInterval(phaseTimerRef.current);
      phaseTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (stage !== "question" || !turn) return;
    setPhase("prep");
    setRecState("idle");
    setError("");
    phaseDeadlineRef.current = Date.now() + turn.prepSeconds * 1000;
    setPhaseLeft(turn.prepSeconds);
    stopPhaseTimer();
    phaseTimerRef.current = setInterval(() => {
      const left = Math.round((phaseDeadlineRef.current - Date.now()) / 1000);
      setPhaseLeft(left);
      if (left <= 0) {
        stopPhaseTimer();
        beginAnswerPhase(turn);
      }
    }, 400);
    return stopPhaseTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, turn?.id]);

  function beginAnswerPhase(q: Turn) {
    setPhase("answer");
    phaseDeadlineRef.current = Date.now() + q.answerSeconds * 1000;
    setPhaseLeft(q.answerSeconds);
    stopPhaseTimer();
    phaseTimerRef.current = setInterval(() => {
      const left = Math.round((phaseDeadlineRef.current - Date.now()) / 1000);
      setPhaseLeft(left);
      if (left <= 0) {
        stopPhaseTimer();
        // The upload-retry overlay owns the screen when it is up — the
        // clock must not submit a turn out from under it.
        if (uploadFailedRef.current) return;
        // Time's up: keep whatever was recorded (or submit the silence —
        // an unanswered turn is a real result, and the interview moves on).
        void submitTurn(q, true);
      }
    }, 400);
  }

  async function handleRecordToggle() {
    const q = turnRef.current;
    if (!q || phase !== "answer") return;
    if (recState === "recording") {
      if (Date.now() - recStartRef.current < MIN_RECORDING_MS) {
        setError("Give it a couple of seconds — we need enough audio to hear you.");
        return;
      }
      // The answer is in — the clock has nothing left to do, and letting it
      // run through the upload risks a stale timeout submit for this turn.
      stopPhaseTimer();
      await submitTurn(q, false);
      return;
    }
    if (recState !== "idle") return;
    const rec = proctor.recordAnswer();
    if (!rec) {
      setError("Your microphone disconnected. Reconnect it to continue.");
      return;
    }
    recorderRef.current = rec;
    recStartRef.current = Date.now();
    setRecState("recording");
  }

  const submitTurn = useCallback(
    async (q: Turn, fromTimeout: boolean, retryBlob?: Blob) => {
      if (submittingTurnRef.current) return;
      submittingTurnRef.current = true;
      setRecState("saving");
      let blob: Blob;
      if (retryBlob) {
        blob = retryBlob;
      } else if (recorderRef.current) {
        const rec = recorderRef.current;
        recorderRef.current = null;
        blob = await rec.stop();
      } else {
        blob = new Blob([], { type: "audio/webm" });
      }
      void fromTimeout;

      const form = new FormData();
      form.append("token", token);
      form.append("interviewId", interviewId);
      form.append("questionId", q.id);
      form.append("audio", blob, "answer.webm");

      let ok = false;
      let data: {
        done?: boolean;
        question?: Turn | null;
        index?: number;
        total?: number;
        error?: string;
      } = {};
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch("/api/interview1/answer", { method: "POST", body: form });
          data = await res.json().catch(() => ({}));
          if (res.ok) {
            ok = true;
            break;
          }
          if (res.status === 409) {
            // Out of sync (double submit / resume race) — re-sync via session.
            ok = true;
            data = { done: false, question: null };
            break;
          }
          if (res.status < 500) break;
        } catch {
          /* retry */
        }
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      }
      submittingTurnRef.current = false;

      if (!ok) {
        // The answer blob is HELD — surface the retry, never a silent zero.
        // The clock stops while the overlay is up: the candidate is not
        // losing answer time to our network failure.
        stopPhaseTimer();
        failedBlobRef.current = blob;
        setUploadFailed(true);
        setRecState("idle");
        return;
      }
      failedBlobRef.current = null;
      setUploadFailed(false);

      if (data.done) {
        setStage("closing");
        return;
      }
      if (data.question) {
        setRecState("idle");
        setTimeout(() => {
          setTurn(data.question!);
          setTurnIndex(data.index ?? 0);
          if (data.total) setTotal(data.total);
        }, 400);
        return;
      }

      // ── 409 resync ──
      // Only a genuine out-of-sync (the server already has this turn) gets
      // here. Two rules learned the hard way:
      //   1. The resync must READ, never create. Posting to the session
      //      route would deal a whole new interview + attempt row whenever
      //      no in-progress one is open — a fresh plan, a bypassed retake
      //      gate, and the finished interview orphaned.
      //   2. Anything that is not a clear answer ("here is your next turn",
      //      "you are finished") is an ERROR, not a completion. Treating a
      //      429/500 as "done" scored a half-finished interview.
      try {
        const res = await fetch(
          `/api/interview1/state?token=${encodeURIComponent(token)}&interviewId=${encodeURIComponent(interviewId)}`
        );
        const s = await res.json().catch(() => ({}));
        if (!res.ok) {
          setFatalError("We lost your place in the interview. Reload this page — your answers are saved.");
          setStage("error");
          return;
        }
        if (s.question) {
          setRecState("idle");
          setTurn(s.question);
          setTurnIndex(s.index ?? 0);
          if (s.total) setTotal(s.total);
          return;
        }
        if (s.done) {
          setStage("closing");
          return;
        }
        setFatalError("We lost your place in the interview. Reload this page — your answers are saved.");
        setStage("error");
      } catch {
        setFatalError("We lost your place in the interview. Reload this page — your answers are saved.");
        setStage("error");
      }
    },
    [interviewId, token]
  );

  async function retryFailedUpload() {
    const q = turnRef.current;
    const blob = failedBlobRef.current;
    if (!q || !blob || busy) return;
    setBusy(true);
    await submitTurn(q, false, blob);
    setBusy(false);
    // If it failed again the overlay stays up (submitTurn re-held the blob);
    // a success advanced the turn, which restarts the clock in the effect.
  }

  // ═══ Closing → score → post ═══
  useEffect(() => {
    if (stage !== "closing") return;
    fetch("/api/interview/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, interviewId }),
    }).catch(() => {});
    const t = setTimeout(() => {
      document.exitFullscreen?.().catch(() => {});
      proctor.endSession();
      setStage("post");
    }, 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  useEffect(() => {
    if (stage !== "post") return;
    const t = setTimeout(() => {
      window.location.href = `/interview/results?id=${interviewId}&token=${encodeURIComponent(token)}`;
    }, 2800);
    return () => clearTimeout(t);
  }, [stage, interviewId, token]);

  const BACK_ARROW = (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M7.5 2.5 4 6l3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  const platformUrl = process.env.NEXT_PUBLIC_STAFFVA_URL || "https://staffva.com";

  // ═══ Fullscreen runner stages ═══
  if (stage === "greeting" || stage === "question" || stage === "closing") {
    return (
      <div className="lp lp-auth">
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Geist:wght@300..900&family=Geist+Mono:wght@400..600&display=swap"
          rel="stylesheet"
        />
        <div className="test-fullscreen" role="dialog" aria-label="Interview 1 in progress">
          <header className="test-topbar">
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span className="test-rec-badge">Recording</span>
            </div>
            <div className="test-progress-indicator">
              <span className="q-count">
                <span>{stage === "greeting" ? 0 : turnIndex + 1}</span>/<span>{total}</span>
              </span>
              <span className="test-timer" title="Time elapsed">{fmtClock(elapsed)}</span>
            </div>
          </header>
          <div className="test-progress-bar">
            <div
              className="test-progress-bar-fill"
              style={{
                width:
                  stage === "closing" ? "100%" : `${((stage === "greeting" ? 0 : turnIndex) / total) * 100}%`,
              }}
            ></div>
          </div>
          <div className="test-body">
            {stage === "greeting" && (
              <div className="test-question-card">
                <div className="ai-greeting-card">
                  <div className="ai-orb-stage">
                    <Orb state={typedChars >= greeting.length ? "listening" : "speaking"} />
                    <div className="ai-orb-label">
                      Your interviewer · {typedChars >= greeting.length ? "ready" : "introducing"}
                    </div>
                  </div>
                  <div className="ai-greeting-text">
                    {/* The caret is a "still talking" signal — it has to stop
                        when Alex does, or it reads as more text coming. */}
                    <span
                      className={typedChars < greeting.length ? "ai-greeting-typing" : undefined}
                    >
                      {greeting.slice(0, typedChars)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ai-greeting-start-btn"
                    disabled={typedChars < greeting.length}
                    onClick={() => setStage("question")}
                  >
                    I&apos;m ready
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {stage === "question" && turn && (
              <div className="test-question-card">
                {turn.isFollowUp && <div className="followup-ribbon">Follow-up</div>}
                <div className="interview-phase-strip">
                  <span className={`phase-pill${phase === "prep" ? " active" : " done"}`}>
                    <span>Prep</span>
                  </span>
                  <span className={`phase-pill${phase === "answer" ? " active" : ""}`}>
                    <span>Answer</span>
                  </span>
                </div>
                <div className="interview-question-row">
                  <Orb state={phase === "prep" ? "thinking" : "listening"} size={64} />
                  <div className="interview-q-text">{turn.text}</div>
                </div>
                <div className="mic-record-area" style={{ padding: "18px 0 4px" }}>
                  <button
                    type="button"
                    className={`mic-record-btn${recState === "recording" ? " recording" : ""}`}
                    disabled={phase === "prep" || recState === "saving"}
                    style={phase === "prep" ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
                    aria-label={recState === "recording" ? "Stop recording" : "Record your response"}
                    onClick={handleRecordToggle}
                  >
                    {recState === "recording" ? (
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
                        <rect x="9" y="9" width="10" height="10" rx="2" fill="currentColor" />
                      </svg>
                    ) : (
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden>
                        <rect x="10.5" y="4" width="7" height="13" rx="3.5" stroke="currentColor" strokeWidth="2" />
                        <path d="M6.5 13a7.5 7.5 0 0 0 15 0M14 20.5V24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    )}
                  </button>
                  <div className="mic-waveform" aria-hidden>
                    {Array.from({ length: 9 }, (_, i) => (
                      <span key={i}></span>
                    ))}
                  </div>
                  <div className="mic-record-label">
                    {recState === "saving"
                      ? "Saved — next question coming up"
                      : recState === "recording"
                        ? "Recording… tap again when done"
                        : phase === "prep"
                          ? "Prep time — gathering thoughts is encouraged"
                          : "Answer time — tap to begin recording"}
                  </div>
                </div>
                <div className="interview-timer-strip">
                  <div className={`interview-timer-cell${phase === "prep" ? " active" : " done"}`}>
                    <span className="tc-label">Prep</span>
                    <span className="tc-time">{phase === "prep" ? fmtClock(phaseLeft) : "0:00"}</span>
                  </div>
                  <div
                    className={`interview-timer-cell${phase === "answer" ? " active" : ""}${phase === "answer" && phaseLeft <= 15 ? " warning" : ""}`}
                  >
                    <span className="tc-label">Answer</span>
                    <span className="tc-time">
                      {phase === "answer" ? fmtClock(phaseLeft) : fmtClock(turn.answerSeconds)}
                    </span>
                  </div>
                </div>
                {error && (
                  <p style={{ color: "var(--amber)", fontSize: "13px", textAlign: "center", marginTop: "12px" }}>
                    {error}
                  </p>
                )}
              </div>
            )}

            {stage === "closing" && (
              <div className="test-question-card">
                <div className="interview-closing">
                  <Orb state="speaking" size={100} />
                  <div className="ai-orb-label">Your interviewer · closing</div>
                  <h2 className="state-title" style={{ color: "var(--paper)", marginTop: "24px", fontSize: "24px" }}>
                    Thanks, {firstName}.
                  </h2>
                  <p className="state-subtitle" style={{ color: "rgba(251, 248, 242, 0.7)" }}>
                    Your interview has been submitted. Uploading now…
                  </p>
                </div>
              </div>
            )}

            {uploadFailed && (
              <div className="test-paused-overlay">
                <div className="test-paused-card">
                  <h2>That answer didn&apos;t save</h2>
                  <p>
                    Your connection hiccuped — your recording is still held in this tab. Retry now;
                    nothing needs re-recording.
                  </p>
                  <button type="button" className="state-action-btn" disabled={busy} onClick={retryFailedUpload}>
                    {busy ? "Saving…" : "Retry saving"}
                  </button>
                </div>
              </div>
            )}

            <div className="test-pip" aria-hidden>
              <div className="pip-indicator">Recording</div>
              <video
                ref={proctor.registerVideo}
                autoPlay
                muted
                playsInline
                style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }}
              />
            </div>
          </div>
        </div>

        {proctor.cameraLost && (
          <div className="test-paused-overlay">
            <div className="test-paused-card">
              <h2>Camera disconnected</h2>
              <p>
                The proctored session requires your camera. Reconnect it to continue — the timers
                keep running, and the interruption is noted in the session record.
              </p>
              <button type="button" className="state-action-btn" onClick={() => proctor.reconnectCamera()}>
                Reconnect camera
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ═══ Card stages ═══
  return (
    <div className="lp lp-auth">
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link
        href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300..900;1,9..144,300..900&family=Geist:wght@300..900&family=Geist+Mono:wght@400..600&display=swap"
        rel="stylesheet"
      />
      <nav className="nav" id="nav">
        <div className="nav-inner">
          <a href={platformUrl} className="logo" aria-label="StaffVA">
            <StaffvaLogo />
          </a>
          <div className="nav-right">
            <a href={`${platformUrl}/candidate/dashboard`} className="signin">Dashboard</a>
          </div>
        </div>
      </nav>

      <main className="page page-narrow">
        <div className="signin-layout" style={{ maxWidth: "560px" }}>
          <header className="signin-header">
            <a href={`${platformUrl}/candidate/dashboard`} className="back-to-dash">
              {BACK_ARROW}
              Back to dashboard
            </a>
            <span className="pipeline-step-indicator">
              <span>StaffVA Pipeline</span>
              <span className="pipe-sep" aria-hidden></span>
              <span className="step-num">Step 6 of 10</span>
            </span>
            <h1 className="display">
              <span className="serif-italic">Interview</span> 1.
            </h1>
            <p className="lead">
              Your first interview. About 10 minutes — communication, problem-solving, and you
              being you.
            </p>
          </header>

          <div className="form-card signin-card">
            {stage === "consent" && (
              <div className="signin-state">
                <div className="consent-card-body">
                  <div className="consent-icon-wrap">
                    <div className="consent-icon recording" aria-hidden>
                      <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                        <rect x="3" y="8" width="15" height="12" rx="2" stroke="currentColor" strokeWidth="2" />
                        <path d="m18 12 6-3v10l-6-3" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </div>
                  <h2 className="consent-title">Interview recording consent</h2>
                  <p className="consent-lead">
                    The session is recorded like a silent call participant — here&apos;s exactly
                    what&apos;s captured.
                  </p>
                  <dl className="consent-block">
                    <dt>What&apos;s recorded</dt>
                    <dd>
                      Continuous <strong>video and audio</strong> from your camera and microphone,
                      your room scan, and your spoken answers — which are transcribed for scoring.
                    </dd>
                    <dt>Why</dt>
                    <dd>
                      To verify it&apos;s you, score your answers fairly, and keep the interview
                      honest — no outside help, no coaching mid-answer.
                    </dd>
                    <dt>Who decides</dt>
                    <dd>
                      Automated scoring produces your result; a person at StaffVA reviews the
                      footage only if integrity signals flag the session.
                    </dd>
                    <dt>How long it&apos;s kept</dt>
                    <dd>
                      Your spoken answers are kept with your application so a reviewer can hear
                      them. The proctor video is deleted after review unless the session is
                      flagged, in which case it is kept until a decision is made and for 7 days
                      after.
                    </dd>
                  </dl>
                  <div className="consent-check-row">
                    <label className="check-row" style={{ fontSize: "13px" }}>
                      <input
                        type="checkbox"
                        checked={consentChecked}
                        onChange={(e) => setConsentChecked(e.target.checked)}
                      />
                      <span className="check-box" aria-hidden></span>
                      <span>I consent to this interview being recorded and proctored as described.</span>
                    </label>
                  </div>
                  {error && (
                    <div className="field-error-text" role="alert" style={{ display: "block", marginBottom: "12px" }}>
                      <span className="err-msg">{error}</span>
                    </div>
                  )}
                  <div className="consent-actions">
                    <button
                      type="button"
                      className={`btn-submit${busy ? " loading" : ""}`}
                      disabled={!consentChecked || busy}
                      onClick={handleConsent}
                    >
                      <span className="submit-label">Start pre-flight checks</span>
                      <span className="spinner" aria-hidden></span>
                    </button>
                    <a href={`${platformUrl}/candidate/dashboard`} className="consent-decline">
                      Not now
                    </a>
                  </div>
                </div>
              </div>
            )}

            {stage === "preflight" && (
              <div className="signin-state">
                <div style={{ textAlign: "center" }}>
                  <div className="camera-step-caption">Pre-flight · 1 of 3</div>
                  <h2 className="state-title" style={{ fontSize: "22px" }}>
                    Running system checks
                  </h2>
                  <p className="state-subtitle">
                    Allow camera and microphone access when your browser asks.
                  </p>
                </div>
                <div className="preflight-webcam-preview" aria-hidden>
                  <video
                    ref={proctor.registerVideo}
                    autoPlay
                    muted
                    playsInline
                    style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }}
                  />
                </div>
                <ul className="preflight-checks" aria-live="polite">
                  {(
                    [
                      ["webcam", "Webcam working"],
                      ["mic", "Microphone working"],
                      ["connection", "Internet connection"],
                    ] as const
                  ).map(([key, label]) => (
                    <li
                      key={key}
                      className={`preflight-check${pfState[key] === "checking" ? " checking" : ""}${pfState[key] === "passed" ? " passed" : ""}`}
                      style={pfState[key] === "failed" ? { borderColor: "var(--danger)" } : undefined}
                    >
                      <span className="preflight-check-icon" aria-hidden></span>
                      <span
                        className="preflight-check-label"
                        style={pfState[key] === "failed" ? { color: "var(--danger)" } : undefined}
                      >
                        {pfState[key] === "failed" ? `${label} — failed` : label}
                      </span>
                      {key === "mic" && (
                        <div className="audio-meter" aria-hidden>
                          <span></span>
                          <span></span>
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="btn-submit"
                  style={{ marginTop: "22px" }}
                  disabled={!pfDone && !pfFailed}
                  onClick={() => (pfDone ? setStage("rules") : runPreflight())}
                >
                  <span className="submit-label">
                    {pfDone ? "Continue to rules" : pfFailed ? "Re-run checks" : "Running checks…"}
                  </span>
                </button>
              </div>
            )}

            {stage === "camera_denied" && (
              <div className="signin-state state-centered">
                <div className="state-icon-xl amber" aria-hidden>
                  <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                    <rect x="3" y="9" width="16" height="13" rx="2" stroke="currentColor" strokeWidth="2" />
                    <path d="m19 13.5 7-3.5v11l-7-3.5" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                    <path d="m5 5 20 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <h2 className="state-title">Camera and microphone required</h2>
                <p className="state-subtitle">
                  The interview is proctored and answered by voice, so we need both. Allow access
                  in your browser&apos;s permissions and try again.
                </p>
                <button type="button" className="state-action-btn" onClick={() => setStage("preflight")}>
                  Try again
                </button>
              </div>
            )}

            {stage === "rules" && (
              <div className="signin-state">
                <div style={{ textAlign: "center" }}>
                  <div className="camera-step-caption">Pre-flight · 2 of 3</div>
                  <h2 className="state-title" style={{ fontSize: "22px" }}>
                    Quick reminder on the rules
                  </h2>
                  <p className="state-subtitle">
                    Same rules as the Proctored English Assessment. Just give a quick ack.
                  </p>
                </div>
                <div className="rules-scroll-wrap">
                  <ol className="rules-list">
                    <li>Stay on camera for the whole interview.</li>
                    <li>
                      Each question gives you <strong>20-25 seconds to think</strong>, then
                      <strong> 90-120 seconds to answer</strong>. Both are on a timer.
                    </li>
                    <li>
                      You may get <strong>one short follow-up</strong> on something you said —
                      20 seconds to think, 60 to answer.
                    </li>
                    <li>You answer by speaking — tap the microphone when you&apos;re ready.</li>
                    <li>No second screens, phones, or notes visible.</li>
                    <li>No other people audible or visible in the room.</li>
                    <li>Don&apos;t read from a script or reference any written material.</li>
                    <li>The whole session is recorded and kept for review.</li>
                    <li className="gentle">
                      Be natural. The timers are generous — most answers land well inside them.
                    </li>
                  </ol>
                </div>
                <label className="check-row" style={{ fontSize: "13px", marginTop: "14px" }}>
                  <input
                    type="checkbox"
                    checked={rulesChecked}
                    onChange={(e) => setRulesChecked(e.target.checked)}
                  />
                  <span className="check-box" aria-hidden></span>
                  <span>Got it. I&apos;m ready to continue.</span>
                </label>
                {error && (
                  <div className="field-error-text" role="alert" style={{ display: "block", marginTop: "10px" }}>
                    <span className="err-msg">{error}</span>
                  </div>
                )}
                <button
                  type="button"
                  className={`btn-submit${busy ? " loading" : ""}`}
                  style={{ marginTop: "16px" }}
                  disabled={!rulesChecked || busy}
                  onClick={handleRules}
                >
                  <span className="submit-label">Continue to environment scan</span>
                  <span className="spinner" aria-hidden></span>
                </button>
              </div>
            )}

            {stage === "scan" && (
              <div className="signin-state">
                <div style={{ textAlign: "center" }}>
                  <div className="camera-step-caption">Pre-flight · 3 of 3</div>
                  <h2 className="state-title" style={{ fontSize: "22px" }}>
                    Quick room scan
                  </h2>
                  <p className="state-subtitle">
                    Slowly turn your camera in a full circle so the whole room is on the recording.
                  </p>
                </div>
                <div className="scan-stage" role="region" aria-label="360-degree environment scan">
                  <video
                    ref={proctor.registerVideo}
                    autoPlay
                    muted
                    playsInline
                    style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", borderRadius: "inherit" }}
                  />
                  <div className="scan-compass" style={{ position: "relative" }}>
                    <span className="n">N</span>
                    <span className="e">E</span>
                    <span className="s">S</span>
                    <span className="w">W</span>
                  </div>
                  <div className="scan-ring" style={{ position: "relative" }}></div>
                  <div className="scan-instruction" style={{ position: "relative" }}>{scanText}</div>
                </div>
                <button
                  type="button"
                  className="btn-submit"
                  style={{ marginTop: "16px" }}
                  disabled={!scanDone}
                  onClick={() => setStage("start")}
                >
                  <span className="submit-label">{scanDone ? "Continue to start" : "Scanning…"}</span>
                </button>
              </div>
            )}

            {stage === "start" && (
              <div className="signin-state state-centered">
                <div className="ai-orb-stage">
                  <Orb state="listening" />
                  <div className="ai-orb-label">
                    Your interviewer · {error ? "unavailable" : "idle"}
                  </div>
                </div>
                {/* A failed start puts an error under this heading — so the
                    heading must stop claiming Alex is ready, or the card
                    contradicts itself in two adjacent lines. */}
                <h2 className="state-title">
                  {error ? "We couldn't reach your interviewer" : "Your interviewer is ready"}
                </h2>
                <p className="state-subtitle">
                  {error
                    ? "This is on our side, not yours."
                    : "You'll get 5 questions. Each one gives you prep time, then answer time — and you may get one short follow-up based on something you say."}
                </p>
                {error && (
                  <div className="field-error-text" role="alert" style={{ display: "block", marginBottom: "12px" }}>
                    <span className="err-msg">{error}</span>
                  </div>
                )}
                <button
                  type="button"
                  className={`btn-submit${busy ? " loading" : ""}`}
                  style={{ marginTop: "10px" }}
                  disabled={busy}
                  onClick={handleStart}
                >
                  <span className="submit-label">
                    {error ? "Try again" : "Meet your interviewer"}
                  </span>
                  <span className="spinner" aria-hidden></span>
                </button>
                <p className="state-fine-print">
                  Need a moment? <a href={`${platformUrl}/candidate/dashboard`}>Come back later</a> —
                  nothing counts against you until you start.
                </p>
              </div>
            )}

            {stage === "post" && (
              <div className="signin-state">
                <div className="post-test-stage">
                  <div className="post-test-icon" aria-hidden>
                    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                      <path d="m8 17 6 6L25 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <h2 className="state-title">Interview submitted</h2>
                  <p className="state-subtitle">
                    Your interview is being scored — usually under a minute. Taking you to your
                    result…
                  </p>
                  <div className="routing-pulse" style={{ marginTop: "24px" }} aria-hidden>
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}

            {stage === "already_passed" && (
              <div className="signin-state state-centered">
                <div className="state-icon-xl" style={{ background: "var(--lime)", color: "var(--ink)" }} aria-hidden>
                  <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                    <path d="m7 16 6 6L24 9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <h2 className="state-title">Interview 1 is already done</h2>
                <p className="state-subtitle">
                  You&apos;ve passed this one. Head back to your dashboard for your next step.
                </p>
                <a href={`${platformUrl}/candidate/dashboard`} className="state-action-btn">
                  Back to dashboard
                </a>
              </div>
            )}

            {stage === "retake_locked" && (
              <div className="signin-state state-centered">
                <div className="state-icon-xl amber" aria-hidden>
                  <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                    <circle cx="15" cy="15" r="11" stroke="currentColor" strokeWidth="2" />
                    <path d="M15 9v6l4 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                <h2 className="state-title">Your retake isn&apos;t open yet</h2>
                <p className="state-subtitle">{retakeAt}</p>
                <a href={`${platformUrl}/candidate/dashboard`} className="state-action-btn">
                  Back to dashboard
                </a>
              </div>
            )}

            {stage === "error" && (
              <div className="signin-state state-centered">
                <div className="state-icon-xl amber" aria-hidden>
                  <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                    <circle cx="15" cy="15" r="11" stroke="currentColor" strokeWidth="2" />
                    <path d="M15 9v4.5M15 18.6v.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </div>
                <h2 className="state-title">Something went wrong</h2>
                <p className="state-subtitle">{fatalError}</p>
                <button type="button" className="state-action-btn" onClick={() => window.location.reload()}>
                  Reload
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
