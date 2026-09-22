"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/signout", { method: "POST" });
      const body = await response.json().catch(() => ({ next: "/sign-in" }));
      router.push(body.next ?? "/sign-in");
      setPending(false);
    } catch {
      // Network failure (offline, DNS, etc.): never fail silently -- show a message and let the
      // button be pressed again, instead of leaving the person with no feedback at all.
      setError("Couldn't sign out. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="rounded-md border border-[var(--line)] px-4 py-2 text-[15px] text-[var(--ink)] transition-colors hover:bg-[var(--mist)] disabled:opacity-50"
      >
        {pending ? "Signing out..." : "Sign out"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-[var(--slate)]">
          {error}
        </p>
      )}
    </div>
  );
}
