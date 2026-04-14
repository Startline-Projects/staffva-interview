"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface InterviewData {
  id: string;
  candidate_id: string;
  role_category: string;
  overall_score: number;
  badge_level: string;
  technical_knowledge_score: number;
  problem_solving_score: number;
  communication_score: number;
  experience_depth_score: number;
  professionalism_score: number;
  ai_notes: string;
  improvement_feedback: string;
  second_interview_overall: number | null;
  second_interview_technical: number | null;
  second_interview_problem: number | null;
  second_interview_communication: number | null;
  second_interview_experience: number | null;
  second_interview_professionalism: number | null;
  second_interview_feedback: string | null;
  second_interview_ai_notes: string | null;
  combined_score: number | null;
  combined_recommendation: string | null;
  combined_recommendation_reason: string | null;
  speaking_level: string | null;
  pre_interview_guide: string | null;
  second_interview_status: string | null;
}

interface CandidateData {
  display_name: string;
  country: string;
  role_category: string;
  voice_recording_1_url: string | null;
  voice_recording_2_url: string | null;
}

interface ScoreResult {
  second_technical: number;
  second_problem: number;
  second_communication: number;
  second_experience: number;
  second_professionalism: number;
  second_overall: number;
  combined_score: number;
  recommendation: string;
  recommendation_reason: string;
  feedback: string;
  ai_notes: string;
}

interface Props {
  interviewId: string;
  initialInterview: InterviewData;
  initialCandidate: CandidateData | null;
}

export default function SecondInterviewClient({ interviewId, initialInterview, initialCandidate }: Props) {
  const router = useRouter();
  const interview = initialInterview;
  const candidate = initialCandidate;

  const [error, setError] = useState("");

  // Form state
  const [transcript, setTranscript] = useState("");
  const [scoring, setScoring] = useState(false);

  // Results state — pre-populate if already scored
  const [results, setResults] = useState<ScoreResult | null>(() => {
    if (interview.second_interview_overall) {
      return {
        second_technical: interview.second_interview_technical!,
        second_problem: interview.second_interview_problem!,
        second_communication: interview.second_interview_communication!,
        second_experience: interview.second_interview_experience!,
        second_professionalism: interview.second_interview_professionalism!,
        second_overall: interview.second_interview_overall,
        combined_score: interview.combined_score!,
        recommendation: interview.combined_recommendation!,
        recommendation_reason: interview.combined_recommendation_reason!,
        feedback: interview.second_interview_feedback!,
        ai_notes: interview.second_interview_ai_notes!,
      };
    }
    return null;
  });

  const [firstInterview] = useState<Record<string, number> | null>(() => {
    if (interview.second_interview_overall) {
      return {
        overall_score: interview.overall_score,
        technical_knowledge_score: interview.technical_knowledge_score,
        problem_solving_score: interview.problem_solving_score,
        communication_score: interview.communication_score,
        experience_depth_score: interview.experience_depth_score,
        professionalism_score: interview.professionalism_score,
      };
    }
    return null;
  });

  // Speaking level state (post-scoring)
  const [speakingLevel, setSpeakingLevel] = useState(interview.speaking_level || "");
  const [savingSpeaking, setSavingSpeaking] = useState(false);
  const [speakingConfirmed, setSpeakingConfirmed] = useState(!!interview.speaking_level);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    if (!transcript.trim()) {
      setError("Please paste the interview transcript");
      return;
    }

    setError("");
    setScoring(true);

    try {
      const res = await fetch("/api/recruiter/score-second-interview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interviewId,
          transcript: transcript.trim(),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Scoring failed");
        setScoring(false);
        return;
      }

      setResults(data.scores);
    } catch {
      setError("Network error — try again");
    }
    setScoring(false);
  }

  async function handleConfirmSpeakingLevel() {
    if (!speakingLevel) {
      setError("Please select a speaking level");
      return;
    }

    setError("");
    setSavingSpeaking(true);

    try {
      const res = await fetch("/api/recruiter/confirm-speaking-level", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interviewId, speakingLevel }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to save speaking level");
        setSavingSpeaking(false);
        return;
      }

      setSpeakingConfirmed(true);
    } catch {
      setError("Network error — try again");
    }
    setSavingSpeaking(false);
  }

  const badgeColors: Record<string, string> = {
    exceptional: "bg-amber-700 text-amber-100",
    proficient: "bg-amber-600/50 text-amber-200",
    developing: "bg-gray-600 text-gray-200",
    not_ready: "bg-gray-700 text-gray-400",
  };

  const recColors: Record<string, string> = {
    pass: "bg-green-900 text-green-300 border-green-700",
    hold: "bg-amber-900 text-amber-300 border-amber-700",
    reject: "bg-red-900 text-red-300 border-red-700",
  };

  // ===== RESULTS VIEW (after scoring) =====
  if (results && (firstInterview || interview)) {
    const fi = firstInterview || {
      overall_score: interview.overall_score,
      technical_knowledge_score: interview.technical_knowledge_score,
      problem_solving_score: interview.problem_solving_score,
      communication_score: interview.communication_score,
      experience_depth_score: interview.experience_depth_score,
      professionalism_score: interview.professionalism_score,
    };

    const dimensions = [
      { label: "Technical Knowledge", first: fi.technical_knowledge_score, second: results.second_technical },
      { label: "Problem Solving", first: fi.problem_solving_score, second: results.second_problem },
      { label: "Communication", first: fi.communication_score, second: results.second_communication },
      { label: "Experience Depth", first: fi.experience_depth_score, second: results.second_experience },
      { label: "Professionalism", first: fi.professionalism_score, second: results.second_professionalism },
    ];

    return (
      <div className="min-h-screen bg-gray-950 text-white">
        <div className="max-w-4xl mx-auto py-8 px-4">
          <button
            onClick={() => router.push("/recruiter")}
            className="text-gray-500 hover:text-white text-sm mb-6 inline-block"
          >
            &larr; Back to dashboard
          </button>

          <h1 className="text-2xl font-bold mb-1">Second Interview Results</h1>
          <p className="text-gray-500 mb-8">{candidate?.display_name} — {interview?.role_category}</p>

          {/* Combined Scorecard */}
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h2 className="font-semibold mb-4">Combined Scorecard</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-800">
                    <th className="text-left py-2 text-gray-400">Dimension</th>
                    <th className="text-center py-2 text-gray-400">First Interview</th>
                    <th className="text-center py-2 text-gray-400">Second Interview</th>
                  </tr>
                </thead>
                <tbody>
                  {dimensions.map((d) => (
                    <tr key={d.label} className="border-b border-gray-800/50">
                      <td className="py-3">{d.label}</td>
                      <td className="text-center font-mono">{d.first}/20</td>
                      <td className="text-center font-mono">{d.second}/20</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="py-3">Overall</td>
                    <td className="text-center font-mono">{fi.overall_score}/100</td>
                    <td className="text-center font-mono">{results.second_overall}/100</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Combined Score + Recommendation */}
          <div className="bg-gray-900 rounded-xl p-6 mb-6 text-center">
            <p className="text-gray-400 text-sm mb-1">Combined Score</p>
            <p className="text-5xl font-bold mb-4">{results.combined_score}/100</p>
            <span className={"inline-block px-6 py-2 rounded-full text-lg font-bold border " + (recColors[results.recommendation] || "bg-gray-800 text-gray-300")}>
              {results.recommendation.toUpperCase()}
            </span>
          </div>

          {/* Recommendation Reason */}
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h3 className="font-semibold mb-2">Recommendation Reason</h3>
            <p className="text-gray-400 text-sm leading-relaxed">{results.recommendation_reason}</p>
          </div>

          {/* AI Feedback */}
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h3 className="font-semibold mb-2">AI Feedback</h3>
            <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-line">{results.feedback}</p>
          </div>

          {/* AI Notes */}
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h3 className="font-semibold mb-2">AI Notes</h3>
            <p className="text-gray-400 text-sm leading-relaxed whitespace-pre-line">{results.ai_notes}</p>
          </div>

          {/* Speaking Level Assignment — shown AFTER scoring */}
          <div className="bg-gray-900 rounded-xl p-6 mb-6 border-2 border-amber-700">
            <h2 className="font-semibold mb-4">Speaking Level Assignment</h2>

            {/* Audio players for original recordings */}
            {(candidate?.voice_recording_1_url || candidate?.voice_recording_2_url) && (
              <div className="mb-6 space-y-4">
                <p className="text-gray-400 text-sm">
                  Listen to the original recordings and review the second interview above, then assign the speaking level.
                </p>
                {candidate?.voice_recording_1_url && (
                  <div>
                    <p className="text-gray-500 text-xs mb-1">Oral Reading</p>
                    <audio controls className="w-full" preload="none">
                      <source src={candidate.voice_recording_1_url} />
                    </audio>
                  </div>
                )}
                {candidate?.voice_recording_2_url && (
                  <div>
                    <p className="text-gray-500 text-xs mb-1">Self-Introduction</p>
                    <audio controls className="w-full" preload="none">
                      <source src={candidate.voice_recording_2_url} />
                    </audio>
                  </div>
                )}
              </div>
            )}

            {speakingConfirmed ? (
              <div>
                <span className="inline-block px-4 py-2 rounded-full bg-blue-900 text-blue-300 font-medium text-lg">
                  {speakingLevel}
                </span>
                <p className="text-green-400 text-sm mt-3">
                  Speaking level saved. Sam has been notified.
                </p>
              </div>
            ) : (
              <div>
                <select
                  value={speakingLevel}
                  onChange={(e) => setSpeakingLevel(e.target.value)}
                  className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-amber-600 mb-4"
                >
                  <option value="">Select speaking level...</option>
                  <option value="Fluent">Fluent</option>
                  <option value="Proficient">Proficient</option>
                  <option value="Conversational">Conversational</option>
                  <option value="Basic">Basic</option>
                </select>

                <div className="space-y-3 text-sm mb-6">
                  <div className="bg-gray-800 rounded-lg p-3">
                    <p className="font-medium text-green-400">Fluent</p>
                    <p className="text-gray-500">No translation pauses. Professional vocabulary. Could be placed on a US client call day one.</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-3">
                    <p className="font-medium text-blue-400">Proficient</p>
                    <p className="text-gray-500">Occasional word-search pauses. Accent present but no comprehension difficulty. Fully professional.</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-3">
                    <p className="font-medium text-amber-400">Conversational</p>
                    <p className="text-gray-500">Noticeable grammar errors. Active listening required. Back-office roles only.</p>
                  </div>
                  <div className="bg-gray-800 rounded-lg p-3">
                    <p className="font-medium text-red-400">Basic</p>
                    <p className="text-gray-500">Frequent comprehension gaps. Do not advance regardless of score.</p>
                  </div>
                </div>

                {error && (
                  <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 mb-4">
                    <p className="text-red-400 text-sm">{error}</p>
                  </div>
                )}

                <button
                  onClick={handleConfirmSpeakingLevel}
                  disabled={savingSpeaking || !speakingLevel}
                  className="w-full py-3 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl font-semibold transition-colors"
                >
                  {savingSpeaking ? "Saving..." : "Confirm Speaking Level"}
                </button>
              </div>
            )}
          </div>

          {/* Footer note */}
          {speakingConfirmed && (
            <div className="text-center py-6">
              <p className="text-gray-600 text-sm">
                Sam has been notified and will review within 48 hours.
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ===== SCORING FORM VIEW =====
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <button
          onClick={() => router.push("/recruiter")}
          className="text-gray-500 hover:text-white text-sm mb-6 inline-block"
        >
          &larr; Back to dashboard
        </button>

        <h1 className="text-2xl font-bold mb-1">Score Second Interview</h1>
        <p className="text-gray-500 mb-8">{candidate?.display_name} — {interview?.role_category}</p>

        {/* SECTION A — Candidate Summary */}
        <div className="bg-gray-900 rounded-xl p-6 mb-6">
          <h2 className="font-semibold mb-4">Candidate Summary</h2>
          <div className="grid md:grid-cols-2 gap-4 mb-4">
            <div>
              <p className="text-gray-500 text-xs">Name</p>
              <p className="font-medium">{candidate?.display_name}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs">Country</p>
              <p className="font-medium">{candidate?.country}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs">Role Category</p>
              <p className="font-medium">{interview?.role_category}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs">First Interview Score</p>
              <p className="font-medium">{interview?.overall_score}/100</p>
            </div>
          </div>

          <div className="flex items-center gap-2 mb-4">
            <span className="text-gray-500 text-xs">Badge:</span>
            <span className={"px-3 py-1 rounded-full text-xs font-medium " + (badgeColors[interview?.badge_level || ""] || "bg-gray-700")}>
              {interview?.badge_level}
            </span>
          </div>

          {/* First interview dimension scores */}
          <div className="border-t border-gray-800 pt-4 mb-4">
            <p className="text-gray-500 text-xs mb-2">First Interview Scores</p>
            <div className="grid grid-cols-5 gap-2 text-center text-sm">
              {[
                { label: "Technical", score: interview?.technical_knowledge_score },
                { label: "Problem Solving", score: interview?.problem_solving_score },
                { label: "Communication", score: interview?.communication_score },
                { label: "Experience", score: interview?.experience_depth_score },
                { label: "Professionalism", score: interview?.professionalism_score },
              ].map((d) => (
                <div key={d.label} className="bg-gray-800 rounded-lg p-2">
                  <p className="text-gray-500 text-xs">{d.label}</p>
                  <p className="font-bold">{d.score}/20</p>
                </div>
              ))}
            </div>
          </div>

          {/* AI Notes from first interview */}
          {interview?.ai_notes && (
            <div className="border-t border-gray-800 pt-4 mb-4">
              <p className="text-gray-500 text-xs mb-1">AI Notes (First Interview)</p>
              <p className="text-gray-400 text-sm">{interview.ai_notes}</p>
            </div>
          )}

          {/* Suggested focus areas */}
          {interview?.improvement_feedback && (
            <div className="border-t border-gray-800 pt-4">
              <p className="text-gray-500 text-xs mb-1">Suggested Focus Areas for Second Interview</p>
              <p className="text-gray-400 text-sm">{interview.improvement_feedback}</p>
            </div>
          )}
        </div>

        {/* SECTION — Pre-Interview Guide */}
        <div className="bg-gray-900 rounded-xl p-6 mb-6 border border-gray-800">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold">Pre-Interview Guide</h2>
            {interview?.pre_interview_guide && (
              <button
                type="button"
                onClick={() => {
                  const printWindow = window.open("", "_blank");
                  if (printWindow) {
                    printWindow.document.write(
                      "<html><head><title>Pre-Interview Guide — " +
                        (candidate?.display_name || "Candidate") +
                        "</title>" +
                        "<style>body { font-family: 'Courier New', Courier, monospace; font-size: 13px; line-height: 1.6; padding: 40px; white-space: pre-wrap; color: #1a1a1a; max-width: 800px; } @media print { body { padding: 20px; } }</style>" +
                        "</head><body>" +
                        (interview.pre_interview_guide ?? "")
                          .replace(/&/g, "&amp;")
                          .replace(/</g, "&lt;")
                          .replace(/>/g, "&gt;") +
                        "</body></html>"
                    );
                    printWindow.document.close();
                    printWindow.print();
                  }
                }}
                className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-sm text-gray-300 transition-colors flex items-center gap-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                Print Guide
              </button>
            )}
          </div>
          {interview?.pre_interview_guide ? (
            <pre className="whitespace-pre-wrap text-gray-300 text-sm leading-relaxed font-mono bg-gray-800/50 rounded-lg p-4 max-h-[600px] overflow-y-auto">
              {interview.pre_interview_guide}
            </pre>
          ) : (
            <div className="text-center py-8">
              <p className="text-gray-500 text-sm">
                Guide is being generated — refresh in a moment.
              </p>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit}>
          {/* SECTION B — Transcript Upload */}
          <div className="bg-gray-900 rounded-xl p-6 mb-6">
            <h2 className="font-semibold mb-2">Transcript Upload</h2>
            <p className="text-gray-500 text-sm mb-4">
              Paste your complete Gemini transcript and interview notes here
            </p>
            <textarea
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-amber-600 resize-y"
              style={{ minHeight: "200px" }}
              placeholder="Include everything — questions asked, candidate answers, your personal observations, and any flags you noted during the call."
              required
            />
            <p className="text-gray-600 text-xs mt-2">
              Include everything — questions asked, candidate answers, your personal observations, and any flags you noted during the call.
            </p>
          </div>

          {/* Error display */}
          {error && (
            <div className="bg-red-900/30 border border-red-800 rounded-lg p-4 mb-6">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={scoring}
            className="w-full py-4 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-700 disabled:text-gray-500 rounded-xl font-semibold text-lg transition-colors"
          >
            {scoring ? "Scoring second interview... this takes 20-30 seconds." : "Score Second Interview"}
          </button>
        </form>
      </div>
    </div>
  );
}
