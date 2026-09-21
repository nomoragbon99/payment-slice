import type { BillingInterval } from "@/config/plans";
import { db } from "@/lib/db";

// What plan a person is on, decided in ONE place so /plans and /billing can never disagree.
//
// "No subscription row" means the free plan (see DECISIONS.md). A row means Pro ONLY while its status is
// 'active' AND its period has not ended yet. Everything else (no row, a period that ended, past due, canceled)
// is the Free plan again; `reason` says why, so the billing page can tell the person.

export type SubscriptionRow = {
  billingInterval: string;
  status: string;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
};

export type PlanView =
  | { kind: "free"; reason: "never_subscribed" | "expired" | "past_due" | "canceled"; endedOn?: Date }
  | { kind: "pro"; interval: BillingInterval; activeUntil: Date; endsAtPeriodEnd: boolean };

export function describeSubscription(row: SubscriptionRow | null, now: Date): PlanView {
  if (!row) return { kind: "free", reason: "never_subscribed" };

  if (row.status === "active") {
    // Strictly greater: a period that ends exactly now has ended.
    if (row.currentPeriodEnd.getTime() > now.getTime()) {
      return {
        kind: "pro",
        interval: row.billingInterval === "yearly" ? "yearly" : "monthly",
        activeUntil: row.currentPeriodEnd,
        endsAtPeriodEnd: row.cancelAtPeriodEnd,
      };
    }
    return { kind: "free", reason: "expired", endedOn: row.currentPeriodEnd };
  }
  if (row.status === "past_due") return { kind: "free", reason: "past_due", endedOn: row.currentPeriodEnd };
  return { kind: "free", reason: "canceled", endedOn: row.currentPeriodEnd };
}

export async function getPlanView(userId: string, now: Date = new Date()): Promise<PlanView> {
  const row = await db.subscription.findUnique({
    where: { userId },
    select: { billingInterval: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  return describeSubscription(row, now);
}
