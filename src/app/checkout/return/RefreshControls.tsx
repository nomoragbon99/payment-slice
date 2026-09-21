"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

// Re-runs the server page so it can ask again. With `auto`, it does so by itself every `intervalMs`,
// at most `maxRefreshes` times (a payment that is confirmed but not yet activated usually settles within
// seconds), then stops and says so instead of hammering Paystack forever. The manual button always works.
// State survives router.refresh(), so the count is not reset by each refresh.
export function RefreshControls({
  auto,
  intervalMs,
  maxRefreshes,
}: {
  auto: boolean;
  intervalMs: number;
  maxRefreshes: number;
}) {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [pending, startTransition] = useTransition();
  const exhausted = auto && count >= maxRefreshes;

  useEffect(() => {
    if (!auto || count >= maxRefreshes) return;
    const timer = setTimeout(() => {
      setCount((c) => c + 1);
      startTransition(() => router.refresh());
    }, intervalMs);
    return () => clearTimeout(timer);
  }, [auto, count, intervalMs, maxRefreshes, router]);

  return (
    <div className="flex flex-col items-center gap-2">
      {auto && !exhausted && <p className="text-sm text-gray-600">Checking again automatically...</p>}
      {exhausted && (
        <p className="text-sm text-gray-600">
          This is taking longer than usual. Your payment is safe. Please check again in a minute.
        </p>
      )}
      <button
        type="button"
        disabled={pending}
        onClick={() => startTransition(() => router.refresh())}
        className="rounded border border-gray-300 px-3 py-2 text-gray-900 disabled:opacity-60"
      >
        {pending ? "Checking..." : "Check again"}
      </button>
    </div>
  );
}
