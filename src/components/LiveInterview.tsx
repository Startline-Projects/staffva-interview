"use client";

import { useState, useRef, useEffect } from "react";

interface LiveInterviewProps {
  token: string;
  candidateName: string;
  roleCategory: string;
  mediaStream: MediaStream;
}

type InterviewPhase = "starting" | "ai_speaking" | "listening" | "processing" | "complete";

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

  // Voice Activity Detection refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadFrameRef = useRef<number | null>(null);
  const lastSpeechTimeRef = useRef<number>(0);

  // Auto-scroll conversation
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation, currentTranscript]);

  // Play AI audio from the TTS endpoint
  async function playAIAudio(text: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        const response = await fetch("/api/interview/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, text }),
        });

        if (!response.ok) {
          // If TTS fails, skip audio and continue
          console.error("TTS failed, skipping audio");
          resolve();
          return;
        }

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        audio.onended = () => {
          URL.revokeObjectURL(audioUrl);
          resolve();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(audioUrl);
          resolve(); // Don't reject — just skip audio
        };

        await audio.play();
      } catch {
        resolve(); // Don't block the flow if audio fails
      }
    });
  }

  // Transcribe audio using Deepgram server-side
  async function transcribeAudio(audioBlob: Blob): Promise<string> {
    try {
      const formData = new FormData();
      formData.append("audio", audioBlob);
      formData.append("token", token);

      const response = await fetch("/api/interview/transcribe", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Transcription failed");

      const data = await response.json();
      return data.transcript || "";
    } catch {
      return "";
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
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || "Session error");
      }

      const data = await response.json();

      if (!mountedRef.current) return;

      // Add AI response to conversation
      setConversation((prev) => [...prev, { role: "interviewer", text: data.response }]);

      if (data.isComplete) {
        setPhase("complete");
        setStatusText("Interview complete. Alex is wrapping up...");
        await playAIAudio(data.response);

        // Score the interview
        setStatusText("Generating your scorecard... This takes about 30 seconds.");
        try {
          await fetch("/api/interview/score", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token, interviewId: currentInterviewId }),
          });
        } catch {
          // Scoring error — still redirect, scoring can be retried
        }

        setStatusText("Your results are ready. Redirecting...");
        setTimeout(() => {
          window.location.href = "/interview/results?id=" + currentInterviewId + "&token=" + token;
        }, 2000);
      } else {
        // Play AI response then start listening again
        setPhase("ai_speaking");
        setStatusText("Alex is speaking...");
        await playAIAudio(data.response);
        if (mountedRef.current) {
          startListening();
        }
      }
    } catch (err) {
      console.error("sendResponse error:", err);
      setStatusText("Something went wrong. Trying to continue...");
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

        // Send audio to Deepgram for transcription
        const transcript = await transcribeAudio(audioBlob);

        if (!transcript || transcript.trim().length === 0) {
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
        });

        if (!response.ok) {
          const err = await response.json();
          setStatusText(err.error || "Failed to start interview");
          return;
        }

        const data = await response.json();
        if (!mountedRef.current) return;

        interviewIdRef.current = data.interviewId;
        setConversation([{ role: "interviewer", text: data.response }]);

        // Play Alex's opening message
        setPhase("ai_speaking");
        setStatusText("Alex is speaking...");
        await playAIAudio(data.response);

        if (mountedRef.current) {
          startListening();
        }
      } catch {
        if (mountedRef.current) setStatusText("Failed to start interview. Please reload the page.");
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
