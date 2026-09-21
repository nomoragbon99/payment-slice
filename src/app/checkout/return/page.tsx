import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { checkoutConfig } from "@/config/checkout";
import { getCurrentUser } from "@/lib/auth/session";
import { getReturnStatus, pickReference, type OrderSummary, type ReturnState } from "@/lib/checkout/return-status";
import { formatMoney } from "@/lib/format-money";
import { RefreshControls } from "./RefreshControls";

export const metadata: Metadata = { title: "Payment status", robots: { index: false } };

// This page depends entirely on who is asking and on Paystack's answer right now: never cache it.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ reference?: string | string[]; trxref?: string | string[] }>;

// Where the person is sent to try again: the plans page, where a checkout is started.
const TRY_AGAIN_HREF = "/plans";

// This page decides NOTHING itself. Arriving here from a redirect proves nothing: the reference in the URL only
// names a payment. getReturnStatus() hands it to fulfilTransaction(), the same function the webhook uses, which
// asks Paystack directly and activates the plan only if Paystack confirms exactly the order we recorded. The page
// then reports what it found: whichever of the webhook and this visit comes first does the work, the other
// finds it done.
export default async function CheckoutReturnPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;

  const user = await getCurrentUser();
  if (!user) {
    // proxy.ts only checks that a cookie exists; a forged or expired one ends up here. Keep the query string
    // so the reference is not lost by signing in.
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, v);
    }
    const next = `/checkout/return${query.size ? `?${query}` : ""}`;
    redirect(`/sign-in?next=${encodeURIComponent(next)}`);
  }

  const state = await getReturnStatus({
    userId: user.id,
    reference: pickReference(params),
    secretKey: process.env.PAYSTACK_SECRET_KEY,
  });

  const view = describe(state);
  const { intervalMs, maxRefreshes } = checkoutConfig.returnPage.autoRefresh;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-4 py-10">
      <div role="status" aria-live="polite" className={`rounded border px-4 py-4 ${view.tone}`}>
        <h1 className="text-lg font-semibold">{view.title}</h1>
        <p className="mt-1 text-sm">{view.message}</p>
      </div>

      {"order" in state && <OrderDetails order={state.order} />}

      {view.refresh && <RefreshControls auto={view.refresh === "auto"} intervalMs={intervalMs} maxRefreshes={maxRefreshes} />}

      <div className="flex justify-center gap-4 text-sm">
        {view.tryAgain && (
          <Link href={TRY_AGAIN_HREF} className="text-blue-600 underline">
            Try again
          </Link>
        )}
        <Link href="/dashboard" className="text-blue-600 underline">
          Back to dashboard
        </Link>
      </div>
    </main>
  );
}

function OrderDetails({ order }: { order: OrderSummary }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-gray-700">
      <dt className="text-gray-500">Plan</dt>
      <dd>
        {order.planName} ({order.billingInterval})
      </dd>
      <dt className="text-gray-500">Amount</dt>
      <dd>{formatMoney(order.amountKobo, order.currency)}</dd>
      <dt className="text-gray-500">Reference</dt>
      <dd className="break-all font-mono text-xs">{order.txRef}</dd>
    </dl>
  );
}

const GOOD = "border-green-200 bg-green-50 text-green-900";
const WAIT = "border-blue-200 bg-blue-50 text-blue-900";
const BAD = "border-red-200 bg-red-50 text-red-900";
const NEUTRAL = "border-gray-200 bg-gray-50 text-gray-900";

type View = { title: string; message: string; tone: string; refresh?: "auto" | "manual"; tryAgain?: boolean };

// All wording is ours. Nothing from Paystack's response is ever shown to the person.
function describe(state: ReturnState): View {
  switch (state.kind) {
    case "successful":
      return { title: "Payment successful", message: `Your ${state.order.planName} plan is active. Thank you.`, tone: GOOD };
    case "activating":
      return {
        title: "Payment confirmed",
        message: "We've confirmed your payment and are activating your subscription. This usually takes a few seconds.",
        tone: WAIT,
        refresh: "auto",
      };
    case "processing":
      return { title: "Payment still processing", message: "Your payment is still being processed. We'll keep checking.", tone: WAIT, refresh: "auto" };
    case "not_completed":
      return { title: "Payment not completed", message: "You didn't complete the payment, so no payment was taken.", tone: NEUTRAL, tryAgain: true };
    case "failed":
      return { title: "Payment failed", message: "The payment didn't go through. You can try again.", tone: BAD, tryAgain: true };
    case "reversed":
      return { title: "Payment reversed", message: "This payment was reversed. If you weren't expecting that, please contact support with the reference below.", tone: BAD, tryAgain: true };
    case "mismatch":
      return {
        title: "We couldn't match this payment",
        message: "We couldn't match this payment to your order. Please don't pay again; contact support and quote the reference below.",
        tone: BAD,
      };
    case "cannot_check":
      return {
        title: "We couldn't check your payment right now",
        message:
          state.reason === "rate_limited"
            ? `You've checked a lot in a short time. Nothing has been lost. Please try again in ${formatWait(state.retryAfterSeconds)}.`
            : "Nothing has been lost. Please try again in a moment.",
        tone: NEUTRAL,
        refresh: "manual",
      };
    case "unknown":
      return { title: "We can't find that payment", message: "This link doesn't match a payment on your account.", tone: NEUTRAL, tryAgain: true };
  }
}

function formatWait(seconds: number | undefined): string {
  if (!seconds || seconds < 60) return `${seconds ?? 60} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}
