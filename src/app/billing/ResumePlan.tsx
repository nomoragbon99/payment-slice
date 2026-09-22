"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Lets someone undo a cancellation while their period has not ended yet, wired to POST /api/subscription/resume.
// Shown only in the "will end on <date>" state (see billing/page.tsx); once the period lapses this control is
// gone and the page shows the Free plan instead, because there is nothing left to resume.
export function ResumePlan() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/subscription/resume", { method: "POST" });
      if (response.status === 401) {
        router.push("/sign-in?next=%2Fbilling");
        return;
      }
      if (response.ok) {
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => null);
      setMessage(body?.error?.message ?? "Something went wrong. Please try again.");
    } catch {
      setMessage("Couldn't reach the server. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--mist)] disabled:opacity-50"
      >
        {pending ? "Keeping your plan..." : "Keep my plan"}
      </button>
      {message && (
        <p role="alert" className="text-sm text-[var(--slate)]">
          {message}
        </p>
      )}
    </div>
  );
}
