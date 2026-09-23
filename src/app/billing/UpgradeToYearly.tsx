"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Shows the prorated price billing/page.tsx already computed server-side (quoteUpgrade) and, on
// confirm, POSTs to /api/subscription/upgrade, which recomputes the same quote fresh and starts a
// real Paystack checkout for it -- the price shown here is never itself sent to the server.
export function UpgradeToYearly({ priceText }: { priceText: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/subscription/upgrade", { method: "POST" });
      if (response.status === 401) {
        router.push("/sign-in?next=%2Fbilling");
        return;
      }
      const body = await response.json().catch(() => null);
      if (response.ok && typeof body?.authorizationUrl === "string") {
        window.location.href = body.authorizationUrl;
        return;
      }
      setMessage(body?.error?.message ?? "Something went wrong. Please try again.");
    } catch {
      setMessage("Couldn't reach the server. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--line)] pt-4">
      <p className="text-sm text-[var(--slate)]">Switch to yearly and pay {priceText} now, effective today.</p>
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="self-start rounded-md border border-[var(--line)] px-4 py-2 text-sm text-[var(--ink)] transition-colors hover:bg-[var(--mist)] disabled:opacity-50"
      >
        {pending ? "Starting..." : "Upgrade to yearly"}
      </button>
      {message && (
        <p role="alert" className="text-sm text-[var(--slate)]">
          {message}
        </p>
      )}
    </div>
  );
}
