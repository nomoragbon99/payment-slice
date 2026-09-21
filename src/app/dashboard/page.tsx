import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { SignOutButton } from "./SignOutButton";

// Layer 2 of 2: the real check. getCurrentUser() looks the session up in the database, so a
// missing, forged, expired, or signed-out session all end up here as "no user" -- proxy.ts
// (layer 1) only ever ruled out the single case of no cookie at all.
// force-dynamic: this page's content depends entirely on who's asking, so it must never be
// cached or statically served -- every visit re-runs the real check from scratch.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-gray-50 px-4">
      <p className="text-lg text-gray-900">You are signed in as {user.name}.</p>
      <p className="flex gap-4 text-sm">
        <Link href="/plans" className="text-blue-600 underline">
          Plans
        </Link>
        <Link href="/billing" className="text-blue-600 underline">
          Billing
        </Link>
      </p>
      <SignOutButton />
    </div>
  );
}
