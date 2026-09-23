import type { NextRequest } from "next/server";
import { checkoutConfig } from "@/config/checkout";
import { errorResponse, json } from "@/lib/http";
import { validateSession } from "@/lib/auth/session";
import { initiateUpgrade } from "@/lib/checkout/initiate";
import { assertSameOrigin } from "@/lib/security/origin";
import { consume, rateLimitResponse } from "@/lib/security/rate-limit";

// Starts a Pro monthly -> Pro yearly upgrade at the prorated price initiateUpgrade computes, and returns
// the Paystack payment page for it, same response shape as POST /api/checkout. No request body: unlike
// /api/checkout there is no interval to choose (yearly is the only upgrade target) and no amount to send
// (the server computes and never trusts one). Rate limited the same as /api/checkout: this calls Paystack.
export async function POST(request: NextRequest) {
  try {
    const originError = assertSameOrigin(request);
    if (originError) return originError;

    const auth = await validateSession();
    if (!auth) return errorResponse(401, "UNAUTHENTICATED", "You must be signed in.");

    const limit = await consume(`upgrade:user:${auth.user.id}`, checkoutConfig.rateLimit);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const result = await initiateUpgrade({
      userId: auth.user.id,
      email: auth.user.email,
      appUrl: process.env.APP_URL,
      secretKey: process.env.PAYSTACK_SECRET_KEY,
    });

    if (result.ok) return json(200, { authorizationUrl: result.authorizationUrl });

    switch (result.code) {
      case "NOT_ELIGIBLE":
        switch (result.reason) {
          case "not_subscribed":
          case "lapsed":
            return errorResponse(409, "NOT_SUBSCRIBED", "You don't have an active plan to upgrade.");
          case "already_yearly":
            return errorResponse(409, "ALREADY_YEARLY", "You're already on the yearly plan.");
          case "cancelled":
            return errorResponse(409, "PLAN_ENDING", "Keep your plan first, then you can upgrade to yearly.");
        }
        break;
      case "NOT_CONFIGURED":
        console.error("POST /api/subscription/upgrade: PAYSTACK_SECRET_KEY or APP_URL is not set in the environment.");
        return errorResponse(500, "INTERNAL_ERROR", "Payments are not available right now.");
      case "PROVIDER_FAILED":
        return errorResponse(502, "PAYMENT_PROVIDER_UNAVAILABLE", "We couldn't start the payment. Please try again shortly.");
    }
  } catch (error) {
    console.error("POST /api/subscription/upgrade failed:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
}
