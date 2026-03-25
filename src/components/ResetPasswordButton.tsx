"use client";

import { useState } from "react";

interface Props {
  recruiterEmail: string;
  recruiterName: string;
}

export default function ResetPasswordButton({ recruiterEmail, recruiterName }: Props) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function handleReset() {
    if (!confirm("Reset password for " + recruiterName + " (" + recruiterEmail + ")?")) return;

    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/admin/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: recruiterEmail }),
      });

      const data = await response.json();

      if (response.ok) {
        setResult("Password reset. Email sent.");
      } else {
        setResult(data.error || "Reset failed");
      }
    } catch {
      setResult("Reset failed");
    }

    setLoading(false);
    setTimeout(() => setResult(null), 5000);
  }

  return (
    <div>
      <button
        onClick={handleReset}
        disabled={loading}
        className="text-xs text-red-400 hover:text-red-300 disabled:text-gray-600"
      >
        {loading ? "Resetting..." : "Reset Password"}
      </button>
      {result && <p className="text-xs text-gray-500 mt-1">{result}</p>}
    </div>
  );
}
