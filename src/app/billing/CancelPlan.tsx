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
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded-md border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--mist)]"
      >
        Cancel plan
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--line)] p-4">
      <p className="text-sm text-[var(--ink)]">Are you sure you want to cancel your plan?</p>
      <label className="flex flex-col gap-1.5 text-sm text-[var(--slate)]">
        Reason (optional)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          className="w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[15px] text-[var(--ink)] outline-none focus:border-[var(--signal)] focus:ring-1 focus:ring-[var(--signal)]"
        />
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className="rounded-md bg-[var(--ink)] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Cancelling..." : "Yes, cancel my plan"}
        </button>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={pending}
          className="rounded-md border border-[var(--line)] px-3.5 py-2 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--mist)] disabled:opacity-50"
        >
          Keep my plan
        </button>
      </div>
      {message && (
        <p role="alert" className="text-sm text-[var(--slate)]">
          {message}
        </p>
      )}
    </div>
  );
}
