"use client";

import { useState, useRef, useEffect } from "react";
import { proctorLinkAttempt } from "@/lib/proctorBridge";

interface LiveInterviewProps {
  token: string;
  candidateName: string;
  roleCategory: string;
  mediaStream: MediaStream;
}

// Client-side deadlines, each a little above the route's own maxDuration
// (session 60s, tts 30s, transcribe 30s). Without these a fetch could hang
// indefinitely on a stalled connection, leaving the candidate staring at
// static text with no spinner and no way forward.
const SESSION_TIMEOUT_MS = 65_000;
const TTS_TIMEOUT_MS = 35_000;
const TRANSCRIBE_TIMEOUT_MS = 35_000;

// A gateway timeout returns an HTML body, so response.json() throws and the
// real status is lost — which is how a slow server turned into "please reload"
// with no explanation. Read the status first, and only parse when there is
// JSON to parse.
async function readError(response: Response): Promise<string> {
  if (response.status === 504 || response.status === 502) {
    return "The interview service took too long to respond.";
  }
  if (response.status === 429) {
    // The server computes the true seconds until the window resets and sends
    // it both ways. Telling the candidate to "wait a moment" when it is
    // actually forty minutes is what makes them reload in a loop.
    try {
      const body = await response.json();
      const seconds = Number(body.retryAfterSeconds ?? response.headers.get("Retry-After"));
      if (Number.isFinite(seconds) && seconds > 0) {
        const minutes = Math.ceil(seconds / 60);
        return `You have reached the limit for this hour. Your progress is saved — please come back in about ${minutes} minute${minutes === 1 ? "" : "s"} and resume.`;
      }
    } catch {
      // fall through to the generic message
    }
    return "Too many requests. Please wait a few minutes before continuing.";
  }
  try {
    const body = await response.json();
    return body.error || `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

type InterviewPhase = "starting" | "ai_speaking" | "listening" | "processing" | "complete" | "audio_failed" | "start_failed" | "interrupted";

interface ConversationEntry {
  role: "interviewer" | "candidate";
  text: string;
}

export default function LiveInterview({ token, candidateName, roleCategory, mediaStream }: LiveInterviewProps) {
  const [phase, setPhase] = useState<InterviewPhase>("starting");
  const [conversation, setConversation] = useState<ConversationEntry[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState("");
  const [statusText, setStatusText] = useState("Starting your interview...");

  // Use refs for values accessed inside callbacks to avoid stale closures
  const interviewIdRef = useRef<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
  const hardTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const isRecordingRef = useRef(false);
  const mountedRef = useRef(true);
  // Bounds the re-record loop. Without it, a persistently failing transcription
  // sends the candidate round the same answer indefinitely with no exit.
  const consecutiveFailuresRef = useRef(0);
  // A 403 (retake gate) or 404 cannot be retried — reloading only makes the
  // candidate redo the microphone grant and the audio test to get the same
  // answer, for up to three days.
  const startFailStatusRef = useRef<number | null>(null);

  // Voice Activity Detection refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const lastSpeechTimeRef = useRef<number>(0);
  // Turn timing, measured here because only the browser knows when the mic
  // opened and when speech actually began. Sent to the server as ADVISORY
  // data — it bounds-checks and records them, and stamps its own clock as the
  // authoritative axis. A turn with no measured speech sends latency null and
  // speech 0, which is itself signal (the "[No response detected]" path).
  const listenStartedAtRef = useRef<number>(0);
  const firstSpeechAtRef = useRef<number | null>(null);
  const turnTimingRef = useRef<{ latency_ms?: number; speech_ms?: number; stt_confidence?: number }>({});

  // Auto-scroll conversation
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation, currentTranscript]);

  // Play AI audio from the TTS endpoint
  // Resolves true only if the candidate actually HEARD the question.
  //
  // Every failure path used to resolve silently, and the caller then opened the
  // microphone on a 4.5-second fuse. Measured consequence: 29.1% of candidates
  // had their FIRST answer recorded as "[No response detected]" — decaying to
  // 5.7% by turn four, which is the signature of people not being ready rather
  // than a vendor outage. Those turns are scored as though the candidate said
  // nothing, and interviews with three or more of them average 15 points lower.
  async function playAIAudio(text: string): Promise<boolean> {
    return new Promise(async (resolve) => {
      try {
        const response = await fetch("/api/interview/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, text }),
          signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
        });

        if (!response.ok) {
          console.error("TTS failed, skipping audio");
          resolve(false);
          return;
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          resolve(true);
        };
        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          resolve(false);
        };

        // Rejects under browser autoplay policy when user activation has been
        // lost across the awaits — a real and silent cause of the above.
        await audio.play();
      } catch {
        resolve(false);
      }
    });
  }

  // Transcribe audio using Deepgram server-side.
  // Returns ok:false for a FAILURE (network error, 5xx, token expiry) as
  // distinct from ok:true with an empty transcript, which means the candidate
  // genuinely said nothing. Previously both collapsed to "" and were sent to
  // the interviewer as "[No response detected]", so a transient failure
  // permanently discarded a real answer and was scored as silence.
  async function transcribeAudio(
    audioBlob: Blob
  ): Promise<{ ok: boolean; transcript: string; status?: number }> {
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob);
      formData.append("token", token);

      const response = await fetch("/api/interview/transcribe", {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });

      // The status matters: a 429 will not clear on a retry, and retrying
      // it is what turns a brief limit into a loop the candidate cannot exit.
      if (!response.ok) return { ok: false, transcript: "", status: response.status };

      const data = await response.json();
      // Attach the server-measured transcription confidence to this turn's
      // timing payload so it lands on the same transcript entry.
      if (typeof data.stt_confidence === "number") {
        turnTimingRef.current = { ...turnTimingRef.current, stt_confidence: data.stt_confidence };
      }
      return { ok: true, transcript: data.transcript || "" };
    } catch {
      return { ok: false, transcript: "" };
    }
  }

  // Send candidate response to session API and get AI's next response
  async function sendResponse(transcript: string) {
    try {
      setPhase("processing");
      setStatusText("Alex is thinking...");

      const currentInterviewId = interviewIdRef.current;

      const response = await fetch("/api/interview/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          action: "respond",
          interviewId: currentInterviewId,
          transcript,
          timing: turnTimingRef.current,
        }),
        signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
      });

      if (!response.ok) {
        const failure = new Error(await readError(response)) as Error & { status?: number };
        failure.status = response.status;
        throw failure;
      }

      const data = await response.json();

      if (!mountedRef.current) return;

      // A turn completed end to end. This is the ONLY point that proves the
      // whole pipeline works, so it is the only place the failure count may be
      // cleared. It used to be cleared on a bare TRANSCRIPTION success instead
      // — a different vendor on a different route — which wiped the counter
      // before every retry of the session call that was actually failing. See
      // the note at the reset site below.
      consecutiveFailuresRef.current = 0;

      // Add AI response to conversation
      setConversation((prev) => [...prev, { role: "interviewer", text: data.response }]);

      if (data.isComplete) {
        setPhase("complete");
        setStatusText("Interview complete. Alex is wrapping up...");
        await playAIAudio(data.response);

        // Trigger scoring in the background — the API returns immediately
        // and processes via next/server after()
        setStatusText("Generating your scorecard...");
        try {
          await fetch("/api/interview/score", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, interviewId: currentInterviewId }),
          });
        } catch {
          // Even if the request fails, redirect — results page will poll
        }

        // Redirect to results page which polls until scores are ready
        setStatusText("Redirecting to your results...");
        setTimeout(() => {
          window.location.href = "/interview/results?id=" + currentInterviewId + "&token=" + token;
        }, 2000);
      } else {
        // Play AI response then start listening again
        setPhase("ai_speaking");
        setStatusText("Alex is speaking...");
        const heard = await playAIAudio(data.response);

        if (!mountedRef.current) return;

        if (!heard) {
          setPhase("audio_failed");
          setStatusText(
            "We could not play the audio. Please read Alex's question above, then press I'm Ready to answer."
          );
          return;
        }

        startListening();
      }
    } catch (err) {
      console.error("sendResponse error:", err);
      if (!mountedRef.current) return;

      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : "Something went wrong.";

      // The interview is already finished server-side. Re-recording can never
      // succeed; send them to their results, which the scoring sweep will fill.
      if (status === 400 && interviewIdRef.current) {
        window.location.href =
          "/interview/results?id=" + interviewIdRef.current + "&token=" + token;
        return;
      }

      // 429 (hourly limit) and 503 (the fatal-vendor stop) are both real stops.
      // Re-recording through them burns paid transcription for nothing — which
      // is exactly what the 503 path was added to prevent, and the client was
      // undoing it.
      if (status === 429 || status === 503 || status === 403 || status === 404) {
        setPhase("interrupted");
        setStatusText(message);
        return;
      }

      // Genuinely transient: retry, but bounded.
      consecutiveFailuresRef.current += 1;
      if (consecutiveFailuresRef.current >= 3) {
        setPhase("interrupted");
        setStatusText(message + " Your progress is saved — press Resume to continue.");
        return;
      }

      setStatusText(message + " Trying to continue...");
      setTimeout(() => {
        if (mountedRef.current) startListening();
      }, 2000);
    }
  }

  // Start recording candidate's response
  function startListening() {
    if (isRecordingRef.current) return;

    audioChunksRef.current = [];

    let mimeType = "audio/webm";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "audio/mp4";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = "";
      }
    }

    const options = mimeType ? { mimeType } : undefined;
    const mediaRecorder = new MediaRecorder(mediaStream, options);
    mediaRecorderRef.current = mediaRecorder;
    isRecordingRef.current = true;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorder.start(1000);
    setPhase("listening");
    setStatusText("Listening... Speak your answer");
    setCurrentTranscript("");

    // Voice Activity Detection using Web Audio API
    // Resets silence timer every time speech is detected
    const SILENCE_THRESHOLD = 4500; // 4.5 seconds of silence = end of turn
    const HARD_TIMEOUT = 45000;     // 45 second safety net
    const SPEECH_LEVEL = 15;        // Audio level threshold (0-255)

    lastSpeechTimeRef.current = Date.now();
    listenStartedAtRef.current = Date.now();
    firstSpeechAtRef.current = null;

    // Set up AudioContext and AnalyserNode
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    const audioContext = audioContextRef.current;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    analyserRef.current = analyser;

    const source = audioContext.createMediaStreamSource(mediaStream);
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    // Monitor audio levels via requestAnimationFrame
    function checkAudioLevel() {
      if (!isRecordingRef.current) return;

      analyser.getByteFrequencyData(dataArray);
      // Average volume across frequency bins
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const average = sum / dataArray.length;

      if (average > SPEECH_LEVEL) {
        // Speech detected — reset silence timer
        lastSpeechTimeRef.current = Date.now();
        if (firstSpeechAtRef.current === null) {
          firstSpeechAtRef.current = Date.now();
        }
      }

      vadFrameRef.current = requestAnimationFrame(checkAudioLevel);
    }
    vadFrameRef.current = requestAnimationFrame(checkAudioLevel);

    // Check silence duration every 500ms
    silenceTimerRef.current = setInterval(() => {
      if (!isRecordingRef.current) return;
      const silenceDuration = Date.now() - lastSpeechTimeRef.current;

      if (silenceDuration >= SILENCE_THRESHOLD) {
        // 4.5 seconds of genuine silence — end turn
        stopListeningAndProcess();
      } else if (silenceDuration >= 2500) {
        setStatusText("Take your time. I am listening.");
      }
    }, 500);

    // Hard timeout safety net — 45 seconds max per answer
    hardTimeoutRef.current = setTimeout(() => {
      if (isRecordingRef.current) {
        stopListeningAndProcess();
      }
    }, HARD_TIMEOUT);
  }

  // Stop recording and send to transcription
  async function stopListeningAndProcess() {
    if (!isRecordingRef.current) return;
    isRecordingRef.current = false;

    // Freeze this turn's timing before anything async happens. lastSpeechTime
    // is "the last moment speech was heard", so speech duration is onset to
    // last-heard; latency is mic-open to onset.
    const firstSpeech = firstSpeechAtRef.current;
    turnTimingRef.current = firstSpeech === null
      ? { speech_ms: 0 }
      : {
          latency_ms: Math.max(0, firstSpeech - listenStartedAtRef.current),
          speech_ms: Math.max(0, lastSpeechTimeRef.current - firstSpeech),
        };

    // Clean up all timers and VAD
    if (silenceTimerRef.current) {
      clearInterval(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    if (hardTimeoutRef.current) {
      clearTimeout(hardTimeoutRef.current);
      hardTimeoutRef.current = null;
    }
    if (vadFrameRef.current) {
      cancelAnimationFrame(vadFrameRef.current);
      vadFrameRef.current = null;
    }

    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive") return;

    return new Promise<void>((resolve) => {
      recorder.onstop = async () => {
        setPhase("processing");
        setStatusText("Processing your answer...");

        const mimeType = recorder.mimeType || "audio/webm";
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });

        // Send audio to Deepgram for transcription. Retry once on failure —
        // most failures here are transient, and the candidate's answer is
        // still in memory, so a retry is free.
        let result = await transcribeAudio(audioBlob);
        // Never retry a 429 — it will not clear, and the retry is what spends
        // the remaining budget.
        if (!result.ok && result.status !== 429) {
          setStatusText("Still processing your answer...");
          result = await transcribeAudio(audioBlob);
        }

        if (!result.ok) {
          // Transcription is broken, NOT silence. Do not fabricate a
          // "[No response detected]" turn — that would burn the question and
          // be scored as though the candidate said nothing.
          if (result.status === 429) {
            // Re-recording here would spin until the top of the hour with no
            // way out and no explanation. Stop and tell them the truth.
            setPhase("interrupted");
            setStatusText(
              "You have reached the limit for this hour. Your progress is saved — press Resume to continue."
            );
            resolve();
            return;
          }

          // Bound the loop even for genuinely transient failures, so a
          // persistently failing upstream cannot re-record indefinitely.
          consecutiveFailuresRef.current += 1;
          if (consecutiveFailuresRef.current >= 3) {
            setPhase("interrupted");
            setStatusText(
              "We are having trouble processing audio right now. Your progress is saved — press Resume to continue."
            );
            resolve();
            return;
          }

          setStatusText("Sorry — we could not process that answer. Please say it again.");
          if (mountedRef.current) startListening();
          resolve();
          return;
        }

        // NOT reset here any more. This point means Deepgram transcribed
        // something; it says nothing about whether the interview turn will
        // succeed. Both sendResponse call sites below sit after this line with
        // nothing touching the ref in between, so the counter was always 0 on
        // entry to sendResponse — its increment made it exactly 1, and its
        // `>= 3` bound could never be true. The session-side guard was
        // unreachable code, and repeated 500/502/504/timeout failures retried
        // without limit, each iteration paying for another transcription of
        // silence and appending another junk turn to the stored transcript.
        //
        // The transcription guard just above is unaffected: it early-returns
        // before reaching here, so its own increments still accumulate.

        const transcript = result.transcript;

        if (!transcript || transcript.trim().length === 0) {
          // Genuine silence — the candidate said nothing audible.
          setStatusText("I did not catch that. Let me move to the next question.");
          await sendResponse("[No response detected]");
        } else {
          setCurrentTranscript(transcript);
          setConversation((prev) => [...prev, { role: "candidate", text: transcript }]);
          await sendResponse(transcript);
        }
        resolve();
      };
      recorder.stop();
    });
  }

  // Initialize interview
  useEffect(() => {
    mountedRef.current = true;

    async function startInterview() {
      try {
        setPhase("starting");
        setStatusText("Starting your interview...");

        const response = await fetch("/api/interview/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, action: "start" }),
          signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
        });

        if (!response.ok) {
          // readError handles the gateway-timeout case, whose body is HTML —
          // response.json() threw on it, which is how a slow start became the
          // generic "please reload" with the real reason lost.
          //
          // A distinct phase from audio_failed: that one's control resumes
          // listening, which would be meaningless here because no interview
          // exists yet.
          startFailStatusRef.current = response.status;
          setPhase("start_failed");
          setStatusText(await readError(response));
          return;
        }

        const data = await response.json();
        if (!mountedRef.current) return;

        interviewIdRef.current = data.interviewId;
        // The proctor gate wrapping this interview binds its recording to
        // the ai_interviews row it covered.
        if (data.interviewId) proctorLinkAttempt(data.interviewId);
        // On resume the server sends the full prior conversation; on a fresh
        // start there is only the opening question.
        setConversation(
          Array.isArray(data.conversation) && data.conversation.length > 0
            ? data.conversation
            : [{ role: "interviewer", text: data.response }]
        );

        // Play Alex's opening message
        setPhase("ai_speaking");
        setStatusText("Alex is speaking...");
        const heard = await playAIAudio(data.response);

        if (!mountedRef.current) return;

        if (!heard) {
          // Do not open the microphone on a timer they cannot hear. The
          // question is already on screen; let them read it and say when ready.
          setPhase("audio_failed");
          setStatusText(
            "We could not play the audio. Please read Alex's question above, then press I'm Ready to answer."
          );
          return;
        }

        startListening();
      } catch (err) {
        if (!mountedRef.current) return;
        startFailStatusRef.current = null; // network/timeout — retryable
        setPhase("start_failed");
        setStatusText(
          err instanceof DOMException && err.name === "TimeoutError"
            ? "The interview service did not respond in time."
            : "We could not start your interview."
        );
      }
    }

    startInterview();

    return () => {
      mountedRef.current = false;
      if (silenceTimerRef.current) clearInterval(silenceTimerRef.current);
      if (hardTimeoutRef.current) clearTimeout(hardTimeoutRef.current);
      if (vadFrameRef.current) cancelAnimationFrame(vadFrameRef.current);
      if (mediaRecorderRef.current?.state === "recording") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const firstName = candidateName.split(" ")[0];

  return (
    <div className="min-h-screen bg-gray-950 text-white flex flex-col">
      {/* Top bar */}
      <div className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div>
          <h1 className="font-semibold">StaffVA AI Interview</h1>
          <p className="text-gray-500 text-sm">{firstName} — {roleCategory}</p>
        </div>
        <div className="flex items-center gap-2">
          {phase === "listening" && (
            <span className="flex items-center gap-2 text-red-400 text-sm">
              <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
              Recording
            </span>
          )}
          {phase === "ai_speaking" && (
            <span className="text-amber-400 text-sm">Alex is speaking</span>
          )}
          {phase === "processing" && (
            <span className="text-blue-400 text-sm">Processing...</span>
          )}
          {phase === "audio_failed" && (
            <span className="text-amber-400 text-sm">Audio unavailable</span>
          )}
          {phase === "start_failed" && (
            <span className="text-red-400 text-sm">Could not start</span>
          )}
          {phase === "interrupted" && (
            <span className="text-amber-400 text-sm">Paused</span>
          )}
          {phase === "complete" && (
            <span className="text-green-400 text-sm">Complete</span>
          )}
        </div>
      </div>

      {/* Conversation area */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
        {conversation.map((entry, i) => (
          <div
            key={i}
            className={`max-w-[80%] ${entry.role === "interviewer" ? "mr-auto" : "ml-auto"}`}
          >
            <div className="text-xs text-gray-600 mb-1">
              {entry.role === "interviewer" ? "Alex" : firstName}
            </div>
            <div
              className={`rounded-xl px-4 py-3 ${
                entry.role === "interviewer"
                  ? "bg-gray-800 text-gray-200"
                  : "bg-amber-900/30 text-amber-100"
              }`}
            >
              {entry.text}
            </div>
          </div>
        ))}

        {currentTranscript && phase === "listening" && (
          <div className="max-w-[80%] ml-auto">
            <div className="text-xs text-gray-600 mb-1">{firstName} (live)</div>
            <div className="rounded-xl px-4 py-3 bg-amber-900/20 text-amber-200/70 italic">
              {currentTranscript}
            </div>
          </div>
        )}

        <div ref={conversationEndRef} />
      </div>

      {/* Bottom controls */}
      <div className="border-t border-gray-800 px-6 py-4">
        <div className="text-center">
          <p className="text-gray-400 text-sm mb-3">{statusText}</p>

          {phase === "listening" && (
            <button
              onClick={stopListeningAndProcess}
              className="px-10 py-4 bg-amber-600 hover:bg-amber-700 rounded-xl font-semibold text-lg transition-colors"
            >
              Done
            </button>
          )}

          {phase === "audio_failed" && (
            <button
              onClick={startListening}
              className="px-10 py-4 bg-amber-600 hover:bg-amber-700 rounded-xl font-semibold text-lg transition-colors"
            >
              I&apos;m Ready
            </button>
          )}

          {phase === "start_failed" &&
            startFailStatusRef.current !== 403 &&
            startFailStatusRef.current !== 404 && (
              <button
                onClick={() => window.location.reload()}
                className="px-10 py-4 bg-amber-600 hover:bg-amber-700 rounded-xl font-semibold text-lg transition-colors"
              >
                Retry
              </button>
            )}

          {phase === "start_failed" &&
            (startFailStatusRef.current === 403 || startFailStatusRef.current === 404) && (
              <a
                href="https://staffva.com/candidate/dashboard"
                className="inline-block px-10 py-4 bg-gray-700 hover:bg-gray-600 rounded-xl font-semibold text-lg transition-colors"
              >
                Back to StaffVA
              </a>
            )}

          {phase === "interrupted" && (
            <button
              onClick={() => window.location.reload()}
              className="px-10 py-4 bg-amber-600 hover:bg-amber-700 rounded-xl font-semibold text-lg transition-colors"
            >
              Resume Interview
            </button>
          )}

          {phase === "complete" && (
            <p className="text-green-400 font-medium">
              Redirecting to your results...
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
