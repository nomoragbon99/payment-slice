"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// The Cancel control: a button, a confirmation step and an optional reason, wired to POST /api/subscription/cancel.
// The cancellation itself is not built yet (that endpoint answers 501), so for now the person is told so.
export function CancelPlan() {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onConfirm() {
    setPending(true);
    setMessage(null);
    try {
      const trimmed = reason.trim();
      const response = await fetch("/api/subscription/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(trimmed ? { reason: trimmed } : {}),
      });
      const body = await response.json().catch(() => null);
      if (response.status === 401) {
        router.push("/sign-in?next=%2Fbilling");
        return;
      }
      setMessage(response.status === 501 ? "Cancelling a plan isn't available yet." : (body?.error?.message ?? "Something went wrong. Please try again."));
    } catch {
      setMessage("Couldn't reach the server. Check your connection and try again.");
    }
    setPending(false);
  }

  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} className="rounded border border-gray-300 px-3 py-2 text-gray-900">
        Cancel plan
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm">Are you sure you want to cancel your plan?</p>
      <label className="flex flex-col gap-1 text-sm">
        Reason (optional)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          className="w-full rounded border border-gray-300 px-3 py-2 text-gray-900"
        />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={onConfirm} disabled={pending} className="rounded bg-red-700 px-3 py-2 text-white disabled:opacity-60">
          {pending ? "Cancelling..." : "Yes, cancel my plan"}
        </button>
        <button type="button" onClick={() => setConfirming(false)} disabled={pending} className="rounded border border-gray-300 px-3 py-2 text-gray-900">
          Keep my plan
        </button>
      </div>
      {message && (
        <p role="alert" className="text-sm text-red-700">
          {message}
        </p>
      )}
    </div>
  );
}
