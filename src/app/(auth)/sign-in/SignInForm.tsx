"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInSchema } from "@/lib/validation/auth";
import { getSafeRedirectPath } from "@/lib/security/safe-redirect";

const INPUT_CLASSES =
  "w-full rounded-md border border-[var(--line)] bg-[var(--paper)] px-3 py-2 text-[15px] text-[var(--ink)] outline-none focus:border-[var(--signal)] focus:ring-1 focus:ring-[var(--signal)]";

// Deliberately small: the same Zod schema the server uses checks the fields here first (instant
// feedback), then the server checks again (the server is the one that actually counts).
export function SignInForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = signInSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check your details and try again.");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        setError(body?.error?.message ?? "Something went wrong. Please try again.");
        setPending(false);
        return;
      }

      // ?next= is only honoured if it is a path on this site (open-redirect check).
      router.push(getSafeRedirectPath(searchParams.get("next"), body?.next ?? "/dashboard"));
    } catch {
      setError("Couldn't reach the server. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 px-4">
      <h1 className="text-xl font-semibold text-[var(--ink)]">Sign in</h1>
      {error && (
        <p role="alert" className="rounded-md border border-[var(--line)] bg-[var(--mist)] px-3 py-2 text-sm text-[var(--ink)]">
          {error}
        </p>
      )}
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5 text-sm text-[var(--slate)]">
          Email
          <input
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={INPUT_CLASSES}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-[var(--slate)]">
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={INPUT_CLASSES}
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="mt-2 rounded-md bg-[var(--signal)] px-4 py-2.5 text-[15px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
