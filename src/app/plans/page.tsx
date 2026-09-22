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
    <main className="mx-auto flex min-h-screen max-w-[440px] flex-col gap-6 px-4 py-14">
      <h1 className="text-xl font-semibold text-[var(--ink)]">Plans</h1>

      <div className="overflow-hidden rounded-lg border border-[var(--line)]">
        <PlanRow name="Free" price="Free" current={view.kind === "free"} />
        <PaidRow interval="monthly" view={view} />
        <PaidRow interval="yearly" view={view} />
      </div>

      <p className="flex gap-5 text-sm">
        <Link href="/billing" className="text-[var(--signal)] hover:underline">
          Billing
        </Link>
        <Link href="/dashboard" className="text-[var(--signal)] hover:underline">
          Back to dashboard
        </Link>
      </p>
    </main>
  );
}

function PaidRow({ interval, view }: { interval: BillingInterval; view: PlanView }) {
  const price = `${formatMoney(getAmountKobo(interval), PLAN.currency)} / ${interval === "monthly" ? "month" : "year"}`;
  const name = `${PLAN.name} (${interval})`;
  const current = view.kind === "pro" && view.interval === interval;

  let action: React.ReactNode = null;
  if (!current) {
    action =
      view.kind === "pro" ? (
        // POST /api/checkout answers 409 while a plan is active (so nobody pays twice by accident), so do not offer a
        // button that would fail: say when it becomes available.
        <p className="max-w-[16rem] text-right text-xs text-[var(--slate)]">Available {formatDate(view.activeUntil)}</p>
      ) : (
        <CheckoutButton interval={interval} label={`Choose ${interval}`} />
      );
  }

  return (
    <PlanRow
      name={name}
      price={price}
      current={current}
      detail={current && view.kind === "pro" ? `Active until ${formatDate(view.activeUntil)}` : undefined}
    >
      {action}
    </PlanRow>
  );
}

function PlanRow({
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
    <section
      aria-current={current ? "true" : undefined}
      className={`flex items-center justify-between gap-4 border-b border-[var(--line)] px-5 py-4 last:border-b-0 ${
        current ? "border-l-2 border-l-[var(--signal)] bg-[var(--mist)]" : "border-l-2 border-l-transparent"
      }`}
    >
      <div>
        <h2 className="text-[15px] font-semibold text-[var(--ink)]">{name}</h2>
        <p className="tnum text-sm text-[var(--slate)]">{price}</p>
        {detail && <p className="tnum mt-0.5 text-xs text-[var(--slate)]">{detail}</p>}
      </div>
      <div className="shrink-0">
        {current ? <span className="text-xs font-medium text-[var(--signal)]">Current plan</span> : children}
      </div>
    </section>
  );
}
