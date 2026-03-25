"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, useRef, useCallback, Suspense } from "react";
import LiveInterview from "@/components/LiveInterview";

interface Candidate {
  id: string;
  display_name: string;
  country: string;
  role_category: string;
  english_written_tier: string;
  speaking_level: string;
  bio: string;
  us_client_experience: boolean;
}

type MicStatus = "idle" | "requesting" | "granted" | "denied";
type AudioTestStatus = "idle" | "recording" | "recorded" | "playing";
type PageState = "briefing" | "interview";

function InterviewContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token");

  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageState, setPageState] = useState<PageState>("briefing");

  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [audioTestStatus, setAudioTestStatus] = useState<AudioTestStatus>("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioUrlRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!token) {
      setError("No interview token provided. Please access this page from your StaffVA dashboard.");
      setLoading(false);
      return;
    }

    fetch(`/api/auth/verify?token=${token}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.error) {
          if (data.error === "jwt expired" || data.error === "jwt malformed" || data.error === "Token expired") {
            setError("Your interview link has expired. Please return to staffva.com and click 'Start AI Interview' again to get a new link.");
          } else if (data.error === "Candidate not found") {
            setError("We couldn't find your profile. Please return to staffva.com and try again.");
          } else {
            setError(data.error);
          }
        } else {
          setCandidate(data.candidate);
        }
      })
      .catch(() => setError("Failed to verify your identity. Please try again."))
      .finally(() => setLoading(false));
  }, [token]);

  const requestMicrophone = useCallback(async () => {
    setMicStatus("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setMicStatus("granted");
    } catch {
      setMicStatus("denied");
    }
  }, []);

  const startRecording = useCallback(() => {
    if (!streamRef.current) return;
    audioChunksRef.current = [];
    const mediaRecorder = new MediaRecorder(streamRef.current);
    mediaRecorderRef.current = mediaRecorder;
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) audioChunksRef.current.push(event.data);
    };
    mediaRecorder.onstop = () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = URL.createObjectURL(audioBlob);
      setAudioTestStatus("recorded");
    };
    mediaRecorder.start();
    setAudioTestStatus("recording");
    setRecordingSeconds(0);
    timerRef.current = setInterval(() => {
      setRecordingSeconds((prev) => {
        if (prev >= 29) {
          mediaRecorderRef.current?.stop();
          if (timerRef.current) clearInterval(timerRef.current);
          return 30;
        }
        return prev + 1;
      });
    }, 1000);
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  const playRecording = useCallback(() => {
    if (!audioUrlRef.current) return;
    const audio = new Audio(audioUrlRef.current);
    audioRef.current = audio;
    setAudioTestStatus("playing");
    audio.onended = () => setAudioTestStatus("recorded");
    audio.play();
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      audioRef.current?.pause();
    };
  }, []);

  const handleStartInterview = () => {
    setPageState("interview");
  };

  const micReady = micStatus === "granted";
  const audioTestPassed = audioTestStatus === "recorded" || audioTestStatus === "playing";

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <p className="text-lg">Verifying your identity...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <div className="text-center max-w-md">
          <h1 className="text-2xl font-bold text-red-400 mb-4">Access Denied</h1>
          <p className="text-gray-400">{error}</p>
        </div>
      </div>
    );
  }

  // Live interview view
  if (pageState === "interview" && token && candidate && streamRef.current) {
    return (
      <LiveInterview
        token={token}
        candidateName={candidate.display_name}
        roleCategory={candidate.role_category}
        mediaStream={streamRef.current}
      />
    );
  }

  const firstName = candidate?.display_name?.split(" ")[0] || "there";

  // Briefing view
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold mb-2">Welcome, {firstName}</h1>
          <p className="text-gray-400 text-lg">AI Skills Interview — {candidate?.role_category}</p>
        </div>

        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h2 className="text-xl font-semibold mb-3">What to Expect</h2>
          <p className="text-gray-400 leading-relaxed">
            You will have a voice conversation with Alex, our AI interviewer. Alex will ask you
            questions about your experience and skills related to your role. The interview typically
            takes 10 to 20 minutes. Speak naturally — this is a conversation, not a test with
            right or wrong answers.
          </p>
        </div>

        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Before You Start</h2>
          <div className="space-y-4">
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-8 h-8 bg-amber-600 rounded-full flex items-center justify-center text-sm font-bold">1</span>
              <div>
                <p className="font-medium">Find a quiet place</p>
                <p className="text-gray-400 text-sm">Background noise affects transcription accuracy. Use a quiet room with a door if possible.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-8 h-8 bg-amber-600 rounded-full flex items-center justify-center text-sm font-bold">2</span>
              <div>
                <p className="font-medium">Speak clearly and in full sentences</p>
                <p className="text-gray-400 text-sm">Take your time. Complete thoughts score better than rushed fragments.</p>
              </div>
            </div>
            <div className="flex gap-3">
              <span className="flex-shrink-0 w-8 h-8 bg-amber-600 rounded-full flex items-center justify-center text-sm font-bold">3</span>
              <div>
                <p className="font-medium">Be specific about your experience with real examples</p>
                <p className="text-gray-400 text-sm">Name real tools, real projects, real outcomes. Specific answers always score higher than generic ones.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Microphone Check</h2>

          {micStatus === "idle" && (
            <button onClick={requestMicrophone} className="w-full py-3 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium transition-colors">
              Allow Microphone Access
            </button>
          )}

          {micStatus === "requesting" && (
            <p className="text-gray-400 text-center py-3">Requesting microphone access...</p>
          )}

          {micStatus === "denied" && (
            <div className="text-center">
              <p className="text-red-400 mb-2">Microphone access was denied.</p>
              <p className="text-gray-500 text-sm">Please allow microphone access in your browser settings and reload the page.</p>
            </div>
          )}

          {micStatus === "granted" && (
            <div>
              <p className="text-green-400 mb-4">Microphone access granted.</p>

              {audioTestStatus === "idle" && (
                <div>
                  <p className="text-gray-400 text-sm mb-3">
                    Record a short audio test to make sure your microphone is working. Say anything — this is not part of the interview.
                  </p>
                  <button onClick={startRecording} className="w-full py-3 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition-colors">
                    Start Audio Test
                  </button>
                </div>
              )}

              {audioTestStatus === "recording" && (
                <div className="text-center">
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <span className="w-3 h-3 bg-red-500 rounded-full animate-pulse" />
                    <span className="text-red-400 font-medium">Recording... {recordingSeconds}s</span>
                  </div>
                  <button onClick={stopRecording} className="w-full py-3 bg-red-600 hover:bg-red-700 rounded-lg font-medium transition-colors">
                    Stop Recording
                  </button>
                </div>
              )}

              {(audioTestStatus === "recorded" || audioTestStatus === "playing") && (
                <div className="space-y-3">
                  <p className="text-green-400 text-sm">Audio test recorded. Play it back to confirm.</p>
                  <div className="flex gap-3">
                    <button onClick={playRecording} disabled={audioTestStatus === "playing"} className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-lg font-medium transition-colors">
                      {audioTestStatus === "playing" ? "Playing..." : "Play Back"}
                    </button>
                    <button onClick={startRecording} className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg font-medium transition-colors">
                      Re-record
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <button
          disabled={!micReady || !audioTestPassed}
          onClick={handleStartInterview}
          className="w-full py-4 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl text-lg font-bold transition-colors"
        >
          Start Interview
        </button>

        {!micReady && (
          <p className="text-gray-600 text-sm text-center mt-3">Complete the microphone check above to start your interview.</p>
        )}
        {micReady && !audioTestPassed && (
          <p className="text-gray-600 text-sm text-center mt-3">Record an audio test to confirm your microphone works.</p>
        )}
      </div>
    </div>
  );
}

export default function InterviewPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <p className="text-lg">Loading...</p>
      </div>
    }>
      <InterviewContent />
    </Suspense>
  );
}
