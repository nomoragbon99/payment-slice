import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { PLAN } from "@/config/plans";
import { getCurrentUser } from "@/lib/auth/session";
import { getPlanView, type PlanView } from "@/lib/billing/subscription";
import { formatDate } from "@/lib/format-date";
import { CancelPlan } from "./CancelPlan";

export const metadata: Metadata = { title: "Billing" };

// The page depends on who is asking and on their subscription right now: never cache it.
export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=%2Fbilling");

  const view = await getPlanView(user.id);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-4 py-10">
      <h1 className="text-xl font-semibold">Billing</h1>

      {view.kind === "pro" ? <ProDetails view={view} /> : <FreeDetails view={view} />}

      <p className="flex gap-4 text-sm">
        <Link href="/plans" className="text-blue-600 underline">
          Plans
        </Link>
        <Link href="/dashboard" className="text-blue-600 underline">
          Back to dashboard
        </Link>
      </p>
    </main>
  );
}

function ProDetails({ view }: { view: Extract<PlanView, { kind: "pro" }> }) {
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-gray-500">Plan</dt>
        <dd>
          {PLAN.name} ({view.interval})
        </dd>
        <dt className="text-gray-500">Status</dt>
        <dd>{view.endsAtPeriodEnd ? "Active, will end" : "Active"}</dd>
        {/* There is no automatic renewal: each period is a separate payment, so this says when it ENDS. */}
        <dt className="text-gray-500">{view.endsAtPeriodEnd ? "Ends on" : "Active until"}</dt>
        <dd>{formatDate(view.activeUntil)}</dd>
      </dl>
      {view.endsAtPeriodEnd ? <p className="text-sm text-gray-700">Your plan will end on {formatDate(view.activeUntil)}.</p> : <CancelPlan />}
    </>
  );
}

function FreeDetails({ view }: { view: Extract<PlanView, { kind: "free" }> }) {
  const ended = view.endedOn ? formatDate(view.endedOn) : null;
  const note =
    view.reason === "expired" && ended
      ? `Your Pro plan ended on ${ended}.`
      : view.reason === "past_due"
        ? "Your Pro plan is past due."
        : view.reason === "canceled"
          ? "Your Pro plan was canceled."
          : null;

  return (
    <>
      <p>You&apos;re on the Free plan.</p>
      {note && <p className="text-sm text-gray-700">{note}</p>}
      <p className="text-sm">
        <Link href="/plans" className="text-blue-600 underline">
          See plans
        </Link>
      </p>
    </>
  );
}
