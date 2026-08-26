"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState, Suspense } from "react";

interface InterviewResult {
  id: string;
  // 'failed_technical' means the interview was parked for review rather than
  // failed. The scorecard fields are still populated — the score is computed
  // and kept before the parking decision — so this is the ONLY field that
  // distinguishes the two.
  status: string;
  overall_score: number;
  badge_level: string;
  technical_knowledge_score: number;
  problem_solving_score: number;
  communication_score: number;
  experience_depth_score: number;
  professionalism_score: number;
  technical_knowledge_feedback: string;
  problem_solving_feedback: string;
  communication_feedback: string;
  experience_depth_feedback: string;
  professionalism_feedback: string;
  strengths: string;
  weaknesses: string;
  improvement_feedback: string;
  perfect_score_path: string;
  passed: boolean;
  role_category: string;
}

interface Candidate {
  display_name: string;
  role_category: string;
}

function ResultsContent() {
  const searchParams = useSearchParams();
  const interviewId = searchParams.get("id");
  const token = searchParams.get("token");

  const [result, setResult] = useState<InterviewResult | null>(null);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!interviewId || !token) {
      setError("Missing interview ID or token.");
      setLoading(false);
      return;
    }

    let pollCount = 0;
    let pollTimer: NodeJS.Timeout | null = null;

    async function loadResults() {
      try {
        // Load candidate info
        const authRes = await fetch("/api/auth/verify?token=" + token);
        const authData = await authRes.json();
        if (authData.candidate) setCandidate(authData.candidate);

        // Load interview results
        const res = await fetch("/api/interview/results?id=" + interviewId + "&token=" + token);
        const data = await res.json();

        if (data.error) {
          setError(data.error);
          setLoading(false);
        } else if (data.interview && data.interview.overall_score) {
          // Scores are ready
          setResult(data.interview);
          setLoading(false);
        } else {
          // Scores not ready yet — poll up to 12 times (60 seconds)
          pollCount++;
          if (pollCount <= 12) {
            setError(null);
            pollTimer = setTimeout(loadResults, 5000);
          } else {
            setError("Scoring is taking longer than expected. Please refresh the page in a minute.");
            setLoading(false);
          }
        }
      } catch {
        setError("Failed to load results.");
        setLoading(false);
      }
    }

    loadResults();

    return () => {
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [interviewId, token]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <p className="text-lg mb-2">Generating your scorecard...</p>
          <p className="text-gray-500 text-sm">This usually takes 20-30 seconds.</p>
        </div>
      </div>
    );
  }

  if (error || !result) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <div className="text-center">
          <h1 className="text-2xl font-bold text-red-400 mb-2">Results Not Available</h1>
          <p className="text-gray-500">{error || "Interview results not found."}</p>
        </div>
      </div>
    );
  }

  const firstName = candidate?.display_name?.split(" ")[0] || "there";

  const badgeLabels: Record<string, string> = {
    exceptional: "AI Interviewed — Expert",
    proficient: "AI Interviewed — Proficient",
    developing: "AI Interviewed — Developing",
    not_ready: "Not Ready",
  };

  const badgeColors: Record<string, string> = {
    exceptional: "bg-amber-700 text-amber-100",
    proficient: "bg-amber-600/50 text-amber-200",
    developing: "bg-gray-600 text-gray-200",
    not_ready: "bg-gray-700 text-gray-400",
  };

  // Parked for review: the transcript was largely our own silence, so the
  // scorecard below was deliberately not acted on. Showing it anyway would do
  // the exact harm the parking exists to prevent — telling someone they failed
  // an interview they were never actually heard in. The old page showed the
  // failing score, the negative feedback, and "you can retake in 3 days", which
  // was also untrue: parking writes no interview_attempts row, so there is no
  // cooldown and they can start again immediately.
  if (result.status === "failed_technical") {
    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <div className="max-w-2xl mx-auto px-6 py-12">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold mb-2">We could not hear you, {firstName}</h1>
            <p className="text-gray-400">
              This was a problem on our side, not with your answers.
            </p>
          </div>

          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <p className="text-gray-300 mb-4">
              Most of your answers did not reach us — our system recorded silence
              where your responses should have been. We are not scoring this
              interview, because a score based on audio we failed to capture
              would not say anything about you.
            </p>
            <p className="text-gray-300">
              A member of our team is reviewing it. You do not need to wait for
              them: you can retake the interview now, and there is no penalty and
              no waiting period.
            </p>
          </div>

          <div className="bg-gray-900 rounded-xl p-6">
            <h2 className="text-xl font-semibold mb-3">Before you retake</h2>
            <ul className="text-gray-400 space-y-2 list-disc list-inside">
              <li>Use headphones if you have them — this prevents most audio problems.</li>
              <li>Check that your browser is allowed to use your microphone.</li>
              <li>Find somewhere quiet with a stable internet connection.</li>
            </ul>
            <a
              href="/interview"
              className="inline-block mt-6 bg-amber-600 hover:bg-amber-500 text-white font-semibold px-6 py-3 rounded-lg transition-colors"
            >
              Retake the interview
            </a>
          </div>
        </div>
      </div>
    );
  }

  const dimensions = [
    { label: "Technical Knowledge", score: result.technical_knowledge_score, feedback: result.technical_knowledge_feedback },
    { label: "Problem Solving & Judgment", score: result.problem_solving_score, feedback: result.problem_solving_feedback },
    { label: "Communication Clarity", score: result.communication_score, feedback: result.communication_feedback },
    { label: "Experience Depth", score: result.experience_depth_score, feedback: result.experience_depth_feedback },
    { label: "Professionalism & Reliability", score: result.professionalism_score, feedback: result.professionalism_feedback },
  ];

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto px-6 py-12">
        {/* Header */}
        <div className="text-center mb-8">
          {result.passed ? (
            <div>
              <h1 className="text-3xl font-bold mb-2">Congratulations, {firstName}!</h1>
              <p className="text-gray-400">You have advanced to a second interview.</p>
            </div>
          ) : (
            <div>
              <h1 className="text-3xl font-bold mb-2">Thank you, {firstName}</h1>
              <p className="text-gray-400">Your interview results are below.</p>
            </div>
          )}
        </div>

        {/* Overall score */}
        <div className="bg-gray-900 rounded-xl p-6 mb-6 text-center">
          <p className="text-5xl font-bold mb-2">{result.overall_score}/100</p>
          <span className={"inline-block px-4 py-2 rounded-full text-sm font-medium " + (badgeColors[result.badge_level] || "bg-gray-700")}>
            {badgeLabels[result.badge_level] || result.badge_level}
          </span>
        </div>

        {/* Dimension breakdown */}
        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h2 className="text-xl font-semibold mb-4">Score Breakdown</h2>
          <div className="space-y-4">
            {dimensions.map((dim) => (
              <div key={dim.label}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm">{dim.label}</span>
                  <span className="font-bold">{dim.score}/20</span>
                </div>
                <div className="w-full bg-gray-800 rounded-full h-2 mb-1">
                  <div
                    className="bg-amber-600 h-2 rounded-full"
                    style={{ width: (dim.score / 20 * 100) + "%" }}
                  />
                </div>
                <p className="text-gray-500 text-sm">{dim.feedback}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Strengths */}
        {result.strengths && (
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2 text-green-400">Your Strengths</h2>
            <p className="text-gray-400">{result.strengths}</p>
          </div>
        )}

        {/* Areas to improve */}
        {result.weaknesses && (
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2 text-amber-400">Areas to Improve</h2>
            <p className="text-gray-400">{result.weaknesses}</p>
          </div>
        )}

        {/* Improvement feedback */}
        {result.improvement_feedback && (
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2">How to Improve</h2>
            <p className="text-gray-400">{result.improvement_feedback}</p>
          </div>
        )}

        {/* Path to 100% */}
        {result.perfect_score_path && (
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h2 className="text-xl font-semibold mb-2">Path to 100%</h2>
            <p className="text-gray-400">{result.perfect_score_path}</p>
          </div>
        )}

        {/* Next steps */}
        <div className="bg-gray-900 rounded-xl p-6">
          <h2 className="text-xl font-semibold mb-2">Next Steps</h2>
          {result.passed ? (
            <p className="text-gray-400">
              A member of our team will contact you to schedule your second interview.
              Check your email for details about your assigned interviewer.
            </p>
          ) : (
            <p className="text-gray-400">
              You can retake your interview in 3 days. Use that time to practice the areas
              listed above. Your new score will replace this one on your profile.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-950 text-white">
        <p className="text-lg">Loading...</p>
      </div>
    }>
      <ResultsContent />
    </Suspense>
  );
}
