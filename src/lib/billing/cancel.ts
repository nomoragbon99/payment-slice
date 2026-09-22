import type { PrismaClient } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { describeSubscription } from "@/lib/billing/subscription";

// Cancel and resume both act on the CALLER's own row only (found by userId, never an id supplied by the request),
// and both re-derive eligibility from describeSubscription() -- the exact function /billing and /plans use to decide
// what a person sees -- so "can this be cancelled/resumed" can never drift from what the page already told them.
//
// Cancellation retains access until the period ends: this only ever sets cancel_at_period_end = true. `status`
// stays 'active' for the whole remaining period, which is what makes describeSubscription() keep reporting Pro
// until current_period_end passes -- there is no cron and none is needed, because entitlement is decided by
// comparing current_period_end to now() on every read, not by a stored flag that something has to flip.
//
// status = 'canceled' is a RESERVED value: the CHECK constraint and describeSubscription() both handle it, but
// nothing in this app ever writes it. It is left for a future admin action (an immediate revoke), not produced
// by this feature, which by design never cuts access off early.

export type CancelResult = { outcome: "canceled"; endsOn: Date } | { outcome: "not_subscribed" } | { outcome: "already_canceled" };
export type ResumeResult = { outcome: "resumed" } | { outcome: "not_canceled" };

export async function cancelSubscription(userId: string, reason: string | undefined, client: PrismaClient = db): Promise<CancelResult> {
  const row = await client.subscription.findUnique({
    where: { userId },
    select: { billingInterval: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  const view = describeSubscription(row, new Date());

  if (view.kind !== "pro") return { outcome: "not_subscribed" };
  if (view.endsAtPeriodEnd) return { outcome: "already_canceled" };

  await client.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: true, cancellationReason: reason ?? null },
  });
  return { outcome: "canceled", endsOn: view.activeUntil };
}

export async function resumeSubscription(userId: string, client: PrismaClient = db): Promise<ResumeResult> {
  const row = await client.subscription.findUnique({
    where: { userId },
    select: { billingInterval: true, status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  const view = describeSubscription(row, new Date());

  // Only reachable while still in-period and set to end: once the period has lapsed there is nothing to resume
  // (describeSubscription would already report Free, and the person would checkout fresh instead).
  if (view.kind !== "pro" || !view.endsAtPeriodEnd) return { outcome: "not_canceled" };

  // The CHECK on cancellation_reason requires cancel_at_period_end (or status='canceled'), so the reason is
  // cleared in the SAME write that clears the flag -- never left orphaned.
  await client.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: false, cancellationReason: null },
  });
  return { outcome: "resumed" };
}
