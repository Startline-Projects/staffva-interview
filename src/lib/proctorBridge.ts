/**
 * Bridge between LiveInterview and the proctor gate wrapping it: the
 * interview learns its ai_interviews row id mid-flight, and the gate owns
 * the recording session that must bind to it. Mirror of the platform's
 * src/lib/proctorBridge.ts.
 */

type ProctorListener = {
  linkAttempt?: (attemptId: string) => void;
};

let listener: ProctorListener = {};

export function registerProctorListener(l: ProctorListener): () => void {
  listener = l;
  return () => {
    listener = {};
  };
}

export function proctorLinkAttempt(attemptId: string): void {
  listener.linkAttempt?.(attemptId);
}
