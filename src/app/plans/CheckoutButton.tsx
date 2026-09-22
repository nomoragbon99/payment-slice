"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { BillingInterval } from "@/config/plans";
import { interpretCheckoutResponse } from "@/lib/billing/checkout-client";

// Starts a checkout through the existing POST /api/checkout (the client sends only the interval, never an amount)
// and sends the browser to the Paystack payment page it returns.
export function CheckoutButton({ interval, label }: { interval: BillingInterval; label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setMessage(null);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billingInterval: interval }),
      });
      const body = await response.json().catch(() => null);
      const outcome = interpretCheckoutResponse(response.status, body, response.headers.get("retry-after"));

      if (outcome.action === "redirect") {
        // A full-page navigation to Paystack's own site (not a Next.js route). Stay in the "pending" state while the
        // browser leaves.
        window.location.href = outcome.url;
        return;
      }
      if (outcome.action === "sign_in") {
        router.push("/sign-in?next=%2Fplans");
        return;
      }
      setMessage(outcome.text);
    } catch {
      setMessage("Couldn't reach the server. Check your connection and try again.");
    }
    setPending(false);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="whitespace-nowrap rounded-md bg-[var(--signal)] px-3.5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {pending ? "Starting..." : label}
      </button>
      {message && (
        <p role="alert" className="max-w-[16rem] text-right text-xs text-[var(--slate)]">
          {message}
        </p>
      )}
    </div>
  );
}
