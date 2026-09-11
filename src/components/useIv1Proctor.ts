"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PROCTOR_CONSENT_VERSION } from "@/lib/proctorConsent";

/**
 * The proctor-session protocol for Interview 1's Atlas flow — the same
 * server contract ProctorGate speaks (consent → session → 10s chunks + 12s
 * frames → end exactly once), token-authenticated, restructured as a hook
 * so the Atlas UI owns the screens. The stream carries video AND audio:
 * the proctor recording can hear the room, and the same mic track feeds
 * the per-question answer recordings.
 *
 * The gate's rule stands: this records and uploads; it never judges.
 */

const FRAME_INTERVAL_MS = 12_000;
const CHUNK_MS = 10_000;

export function useIv1Proctor(token: string) {
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const attemptIdRef = useRef<string | null>(null);
  const chunkNRef = useRef(0);
  const frameNRef = useRef(0);
  const cameraLostCountRef = useRef(0);
  const frameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const endedRef = useRef(false);
  const [cameraLost, setCameraLost] = useState(false);
  /** True while a per-question answer recorder is running, so a camera
   * reconnect knows not to retire the mic track underneath it. */
  const answerRecordingRef = useRef(false);
  /** Mic tracks replaced by a reconnect while an answer was recording —
   * stopped as soon as that recorder finishes, and swept by endSession. */
  const retiredAudioRef = useRef<MediaStreamTrack[]>([]);
  const releaseRetiredAudio = useCallback(() => {
    retiredAudioRef.current.forEach((t) => {
      try {
        t.stop();
      } catch {
        /* already ended */
      }
    });
    retiredAudioRef.current = [];
  }, []);
  const videoElsRef = useRef<Set<HTMLVideoElement>>(new Set());

  const attachToEls = useCallback(() => {
    if (!streamRef.current) return;
    for (const el of videoElsRef.current) {
      if (el.srcObject !== streamRef.current) el.srcObject = streamRef.current;
    }
  }, []);

  const registerVideo = useCallback(
    (el: HTMLVideoElement | null) => {
      if (!el) return;
      videoElsRef.current.add(el);
      attachToEls();
    },
    [attachToEls]
  );

  const acquire = useCallback(async (): Promise<boolean> => {
    if (streamRef.current) return true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
        audio: true,
      });
      streamRef.current = stream;
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          cameraLostCountRef.current++;
          setCameraLost(true);
        };
      });
      attachToEls();
      return true;
    } catch {
      return false;
    }
  }, [attachToEls]);

  const hasTracks = useCallback(
    () => ({
      video: !!streamRef.current?.getVideoTracks().some((t) => t.readyState === "live"),
      audio: !!streamRef.current?.getAudioTracks().some((t) => t.readyState === "live"),
    }),
    []
  );

  const upload = useCallback(
    async (kind: "chunk" | "frame", n: number, blob: Blob) => {
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
          /* dropped; gaps make the review suspicious, never invisible */
        }
      }
    },
    [token]
  );

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
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
      const video = [...videoElsRef.current].find((el) => el.videoWidth > 0);
      if (!video) return;
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
  }, [upload]);

  const isConsented = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/proctor/consent?token=${encodeURIComponent(token)}`);
      const data = await res.json().catch(() => ({}));
      return data.consented === true;
    } catch {
      return false;
    }
  }, [token]);

  const recordConsent = useCallback(async (): Promise<boolean> => {
    const res = await fetch("/api/proctor/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 2.1 adds room audio to the Interview 2 recording. Interview 1 already
      // captured and disclosed it, so nothing changes here except the stamp —
      // but the stamp has to move together or one app writes a version the
      // consent route rejects.
      body: JSON.stringify({ token, version: PROCTOR_CONSENT_VERSION }),
    });
    return res.ok;
  }, [token]);

  const startSession = useCallback(async (): Promise<boolean> => {
    if (!streamRef.current) return false;
    const res = await fetch("/api/proctor/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.sessionId) return false;
    sessionIdRef.current = data.sessionId;
    startRecording();
    return true;
  }, [token, startRecording]);

  const linkAttempt = useCallback((interviewId: string) => {
    attemptIdRef.current = interviewId;
  }, []);

  /** A separate audio-only recorder over the shared mic track, for the
   * per-question answers. Returns a stopper resolving with the blob. */
  const recordAnswer = useCallback((): { stop: () => Promise<Blob> } | null => {
    const audioTrack = streamRef.current?.getAudioTracks().find((t) => t.readyState === "live");
    if (!audioTrack) return null;
    const answerStream = new MediaStream([audioTrack]);
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(answerStream, {
      mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm",
    });
    let settle: ((b: Blob) => void) | null = null;
    let settled = false;
    const finish = () => {
      if (settled || !settle) return;
      settled = true;
      answerRecordingRef.current = false;
      releaseRetiredAudio();
      settle(new Blob(chunks, { type: "audio/webm" }));
    };
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
      // The final chunk can arrive AFTER onstop. Resolving on onstop alone
      // handed back a blob assembled before this ran — see below.
      if (rec.state === "inactive") finish();
    };
    // A TIMESLICE. rec.start() with no argument delivers every byte in a
    // single dataavailable during stop(), so nothing is banked until the
    // recorder is already closing; start(1000) accumulates a chunk a second
    // while they speak. This is what the skills interview does, and that one
    // has worked 54 times.
    //
    // WHAT IS PROVEN AND WHAT IS NOT. Proven in production: the first two
    // answers ever recorded here were 0-byte objects in storage, Deepgram
    // rejected them as "corrupt or unsupported data", and both turns were
    // written to the transcript as "[No response detected]". NOT proven: that
    // the missing timeslice is the cause. Chromium reproduces none of it —
    // no-timeslice, shared-track and cloned-track all return ~40KB there — so
    // the trigger is specific to the candidate's browser or device and is
    // still unidentified. These two changes make the recorder behave like the
    // one that works; the guards that actually protect the candidate are in
    // Interview1Flow (a 0-byte blob is never submitted) and in the answer
    // route (a failed transcription is never written as silence).
    rec.start(1000);
    answerRecordingRef.current = true;
    return {
      stop: () =>
        new Promise<Blob>((resolve) => {
          settle = resolve;
          // Backstop: whichever of the two arrives last wins, and if the
          // final dataavailable never comes we still return what we have
          // rather than hanging the answer.
          rec.onstop = () => setTimeout(finish, 200);
          try {
            rec.stop();
          } catch {
            finish();
          }
        }),
    };
  }, [releaseRetiredAudio]);

  /**
   * Why can't we record right now — or null when we can.
   *
   * recordAnswer() returns null for three different reasons and the UI was
   * asserting one of them ("your microphone disconnected"), which is a guess
   * and was sometimes simply false. Same defect as reporting a database
   * outage as "candidate not found": name the real cause or say you don't
   * know, never invent a specific one.
   */
  const micProblem = useCallback(
    (): "no_stream" | "no_track" | "track_ended" | null => {
      const stream = streamRef.current;
      if (!stream) return "no_stream";
      const audio = stream.getAudioTracks();
      if (audio.length === 0) return "no_track";
      if (!audio.some((t) => t.readyState === "live")) return "track_ended";
      return null;
    },
    []
  );

  const reconnectCamera = useCallback(async (): Promise<boolean> => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15 } },
        audio: true,
      });
      try {
        if (recorderRef.current && recorderRef.current.state !== "inactive") {
          recorderRef.current.stop();
        }
      } catch {
        /* replaced below */
      }
      // Stop only the VIDEO tracks of the old stream. Killing the audio
      // track would silently end an answer recording in flight — the
      // candidate is mid-sentence and the blob would close early.
      streamRef.current?.getVideoTracks().forEach((t) => t.stop());
      const oldAudio = streamRef.current?.getAudioTracks() || [];
      streamRef.current = stream;
      // Retire the old mic only once the new stream is live and nothing is
      // recording from it.
      if (answerRecordingRef.current) {
        // Mid-answer: the recorder is still reading this track, so it can
        // only be retired once the recorder stops. Parked, never orphaned.
        retiredAudioRef.current.push(...oldAudio);
      } else {
        oldAudio.forEach((t) => t.stop());
      }
      stream.getVideoTracks().forEach((track) => {
        track.onended = () => {
          cameraLostCountRef.current++;
          setCameraLost(true);
        };
      });
      attachToEls();
      if (sessionIdRef.current) startRecording();
      setCameraLost(false);
      return true;
    } catch {
      return false;
    }
  }, [attachToEls, startRecording]);

  const endSession = useCallback(() => {
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
    releaseRetiredAudio();
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
  }, [token, releaseRetiredAudio]);

  useEffect(() => {
    window.addEventListener("pagehide", endSession);
    return () => {
      window.removeEventListener("pagehide", endSession);
      endSession();
    };
  }, [endSession]);

  return {
    acquire,
    micProblem,
    hasTracks,
    isConsented,
    recordConsent,
    startSession,
    linkAttempt,
    recordAnswer,
    registerVideo,
    reconnectCamera,
    endSession,
    cameraLost,
  };
}
