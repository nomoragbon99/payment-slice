import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAmountKobo, PLAN, type BillingInterval } from "@/config/plans";
import { getCurrentUser } from "@/lib/auth/session";
import { getPlanView, type PlanView } from "@/lib/billing/subscription";
import { formatDate } from "@/lib/format-date";
import { formatMoney } from "@/lib/format-money";
import { CheckoutButton } from "./CheckoutButton";

export const metadata: Metadata = { title: "Plans" };

// The page depends on who is asking and on their subscription right now: never cache it.
export const dynamic = "force-dynamic";

export default async function PlansPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/sign-in?next=%2Fplans");

  const view = await getPlanView(user.id);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-4 py-10">
      <h1 className="text-xl font-semibold">Plans</h1>

      <PlanCard name="Free" price="Free" current={view.kind === "free"} />
      <PaidCard interval="monthly" view={view} />
      <PaidCard interval="yearly" view={view} />

      <p className="flex gap-4 text-sm">
        <Link href="/billing" className="text-blue-600 underline">
          Billing
        </Link>
        <Link href="/dashboard" className="text-blue-600 underline">
          Back to dashboard
        </Link>
      </p>
    </main>
  );
}

function PaidCard({ interval, view }: { interval: BillingInterval; view: PlanView }) {
  const price = `${formatMoney(getAmountKobo(interval), PLAN.currency)} / ${interval === "monthly" ? "month" : "year"}`;
  const name = `${PLAN.name} (${interval})`;
  const current = view.kind === "pro" && view.interval === interval;

  let action: React.ReactNode = null;
  if (!current) {
    action =
      view.kind === "pro" ? (
        // POST /api/checkout answers 409 while a plan is active (so nobody pays twice by accident), so do not offer a
        // button that would fail: say when it becomes available.
        <p className="text-sm text-gray-600">Available when your current plan ends on {formatDate(view.activeUntil)}.</p>
      ) : (
        <CheckoutButton interval={interval} label={`Choose ${name}`} />
      );
  }

  return (
    <PlanCard name={name} price={price} current={current} detail={current && view.kind === "pro" ? `Active until ${formatDate(view.activeUntil)}` : undefined}>
      {action}
    </PlanCard>
  );
}

function PlanCard({
  name,
  price,
  current,
  detail,
  children,
}: {
  name: string;
  price: string;
  current: boolean;
  detail?: string;
  children?: React.ReactNode;
}) {
  return (
    <section aria-current={current ? "true" : undefined} className={`rounded border px-4 py-3 ${current ? "border-blue-600" : "border-gray-300"}`}>
      <h2 className="font-medium">
        {name} {current && <span className="ml-2 rounded bg-blue-600 px-2 py-0.5 text-xs text-white">Current plan</span>}
      </h2>
      <p className="text-sm text-gray-700">{price}</p>
      {detail && <p className="text-sm text-gray-700">{detail}</p>}
      {children && <div className="mt-2">{children}</div>}
    </section>
  );
}
