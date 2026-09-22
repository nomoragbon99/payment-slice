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
    <main className="mx-auto flex min-h-screen max-w-[440px] flex-col gap-6 px-4 py-14">
      <h1 className="text-xl font-semibold text-[var(--ink)]">Billing</h1>

      <div className="rounded-lg border border-[var(--line)] p-5">{view.kind === "pro" ? <ProDetails view={view} /> : <FreeDetails view={view} />}</div>

      <p className="flex gap-5 text-sm">
        <Link href="/plans" className="text-[var(--signal)] hover:underline">
          Plans
        </Link>
        <Link href="/dashboard" className="text-[var(--signal)] hover:underline">
          Back to dashboard
        </Link>
      </p>
    </main>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-[var(--line)] py-2.5 last:border-b-0">
      <dt className="text-sm text-[var(--slate)]">{label}</dt>
      <dd className="tnum text-sm font-medium text-[var(--ink)]">{value}</dd>
    </div>
  );
}

function ProDetails({ view }: { view: Extract<PlanView, { kind: "pro" }> }) {
  return (
    <div className="flex flex-col gap-4">
      <dl>
        <Row label="Plan" value={`${PLAN.name} (${view.interval})`} />
        <Row label="Status" value={view.endsAtPeriodEnd ? "Active, will end" : "Active"} />
        {/* There is no automatic renewal: each period is a separate payment, so this says when it ENDS. */}
        <Row label={view.endsAtPeriodEnd ? "Ends on" : "Active until"} value={formatDate(view.activeUntil)} />
      </dl>
      {view.endsAtPeriodEnd ? (
        <p className="text-sm text-[var(--slate)]">Your plan will end on {formatDate(view.activeUntil)}.</p>
      ) : (
        <CancelPlan />
      )}
    </div>
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
    <div className="flex flex-col gap-2">
      <p className="text-[15px] text-[var(--ink)]">You&apos;re on the Free plan.</p>
      {note && <p className="text-sm text-[var(--slate)]">{note}</p>}
      <p className="mt-1 text-sm">
        <Link href="/plans" className="text-[var(--signal)] hover:underline">
          See plans
        </Link>
      </p>
    </div>
  );
}
