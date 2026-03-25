"use client";

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

interface Props {
  interviewId: string;
  currentStatus: string;
}

export default function InterviewStatusUpdater({ interviewId, currentStatus }: Props) {
  const [status, setStatus] = useState(currentStatus);
  const [saving, setSaving] = useState(false);

  async function updateStatus(newStatus: string) {
    setSaving(true);
    const supabase = createSupabaseBrowserClient();

    const { error } = await supabase
      .from("ai_interviews")
      .update({ second_interview_status: newStatus })
      .eq("id", interviewId);

    if (!error) {
      setStatus(newStatus);
    }
    setSaving(false);
  }

  const options = [
    { value: "pending", label: "Pending", color: "bg-gray-700 text-gray-300" },
    { value: "scheduled", label: "Scheduled", color: "bg-blue-700 text-blue-100" },
    { value: "completed", label: "Completed", color: "bg-green-700 text-green-100" },
  ];

  return (
    <div className="flex gap-3">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => updateStatus(opt.value)}
          disabled={saving || status === opt.value}
          className={
            "px-4 py-2 rounded-lg text-sm font-medium transition-colors " +
            (status === opt.value
              ? opt.color + " ring-2 ring-white/30"
              : "bg-gray-800 text-gray-500 hover:text-white")
          }
        >
          {opt.label}
        </button>
      ))}
      {saving && <span className="text-gray-500 text-sm self-center">Saving...</span>}
    </div>
  );
}
