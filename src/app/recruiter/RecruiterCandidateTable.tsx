"use client";

import { useRouter } from "next/navigation";
import type { CandidateRow } from "./page";

type Status = "awaiting" | "pending_speaking" | "complete";

function deriveStatus(row: CandidateRow): Status {
  if (!row.secondInterviewStatus || row.secondInterviewStatus !== "completed") {
    return "awaiting";
  }
  if (!row.speakingLevel) {
    return "pending_speaking";
  }
  return "complete";
}

const statusConfig: Record<Status, { label: string; color: string }> = {
  awaiting: {
    label: "Awaiting Second Interview",
    color: "bg-orange-900/60 text-orange-300 border-orange-700",
  },
  pending_speaking: {
    label: "Pending Speaking Level",
    color: "bg-amber-900/60 text-amber-300 border-amber-700",
  },
  complete: {
    label: "Complete",
    color: "bg-green-900/60 text-green-300 border-green-700",
  },
};

const actionConfig: Record<Status, { label: string }> = {
  awaiting: { label: "View Candidate" },
  pending_speaking: { label: "Assign Speaking Level" },
  complete: { label: "View Results" },
};

const badgeColors: Record<string, string> = {
  exceptional: "bg-amber-700 text-amber-100",
  proficient: "bg-amber-600/50 text-amber-200",
  developing: "bg-gray-600 text-gray-200",
  not_ready: "bg-gray-700 text-gray-400",
};

interface Props {
  recruiterName: string;
  candidates: CandidateRow[];
}

export default function RecruiterCandidateTable({ recruiterName, candidates }: Props) {
  const router = useRouter();

  const awaitingCount = candidates.filter((c) => deriveStatus(c) === "awaiting").length;
  const pendingSpeakingCount = candidates.filter((c) => deriveStatus(c) === "pending_speaking").length;
  const completeCount = candidates.filter((c) => deriveStatus(c) === "complete").length;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">My Candidates</h1>
        <p className="text-gray-500 text-sm">{recruiterName}</p>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
          <p className="text-gray-500 text-xs mb-1">Total Assigned</p>
          <p className="text-3xl font-bold">{candidates.length}</p>
        </div>
        <div className="bg-gray-900 rounded-xl p-5 border border-orange-900/50">
          <p className="text-orange-400 text-xs mb-1">Awaiting Second Interview</p>
          <p className="text-3xl font-bold text-orange-300">{awaitingCount}</p>
        </div>
        <div className="bg-gray-900 rounded-xl p-5 border border-amber-900/50">
          <p className="text-amber-400 text-xs mb-1">Pending Speaking Level</p>
          <p className="text-3xl font-bold text-amber-300">{pendingSpeakingCount}</p>
        </div>
        <div className="bg-gray-900 rounded-xl p-5 border border-green-900/50">
          <p className="text-green-400 text-xs mb-1">Complete</p>
          <p className="text-3xl font-bold text-green-300">{completeCount}</p>
        </div>
      </div>

      {/* Empty State */}
      {candidates.length === 0 ? (
        <div className="bg-gray-900 rounded-xl p-12 text-center border border-gray-800">
          <p className="text-gray-500">
            No candidates assigned yet. Your assigned role categories will appear here once candidates complete their AI interview.
          </p>
        </div>
      ) : (
        /* Candidate Table */
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800 text-gray-500 text-xs uppercase tracking-wide">
                  <th className="text-left py-3 px-4">Candidate</th>
                  <th className="text-left py-3 px-4">Country</th>
                  <th className="text-left py-3 px-4">Role</th>
                  <th className="text-center py-3 px-4">First Interview</th>
                  <th className="text-center py-3 px-4">Status</th>
                  <th className="text-right py-3 px-4">Action</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => {
                  const status = deriveStatus(c);
                  const config = statusConfig[status];
                  const action = actionConfig[status];

                  return (
                    <tr
                      key={c.interviewId}
                      className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <p className="font-medium">{c.displayName}</p>
                        {/* Guide indicator for awaiting status */}
                        {status === "awaiting" && (
                          <div className="flex items-center gap-1.5 mt-1">
                            <span
                              className={
                                "inline-block w-2 h-2 rounded-full " +
                                (c.preInterviewGuide ? "bg-green-500" : "bg-gray-600")
                              }
                            />
                            <span className="text-xs text-gray-500">
                              {c.preInterviewGuide ? "Guide ready" : "Guide pending"}
                            </span>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-gray-400">{c.country}</td>
                      <td className="py-3 px-4 text-gray-400">{c.roleCategory}</td>
                      <td className="py-3 px-4 text-center">
                        <span className="font-mono font-bold">{c.overallScore}/100</span>
                        <span
                          className={
                            "ml-2 inline-block px-2 py-0.5 rounded-full text-xs font-medium " +
                            (badgeColors[c.badgeLevel] || "bg-gray-700")
                          }
                        >
                          {c.badgeLevel}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span
                          className={
                            "inline-block px-3 py-1 rounded-full text-xs font-medium border " +
                            config.color
                          }
                        >
                          {config.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right">
                        <button
                          onClick={() =>
                            router.push(
                              "/recruiter/candidate/" + c.interviewId + "/second-interview"
                            )
                          }
                          className="px-4 py-1.5 bg-amber-600 hover:bg-amber-700 rounded-lg text-xs font-medium transition-colors"
                        >
                          {action.label}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
