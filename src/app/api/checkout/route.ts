import type { NextRequest } from "next/server";
import { checkoutConfig } from "@/config/checkout";
import { errorResponse, json, validationError } from "@/lib/http";
import { validateSession } from "@/lib/auth/session";
import { initiateCheckout } from "@/lib/checkout/initiate";
import { assertSameOrigin } from "@/lib/security/origin";
import { consume, rateLimitResponse } from "@/lib/security/rate-limit";
import { checkoutRequestSchema } from "@/lib/validation/checkout";

// Starts a subscription purchase and returns the Paystack payment page to send the browser to.
// Order: origin check (CSRF) -> signed in? -> rate limit -> validate body -> initiate.
export async function POST(request: NextRequest) {
  try {
    const originError = assertSameOrigin(request);
    if (originError) return originError;

    const auth = await validateSession();
    if (!auth) return errorResponse(401, "UNAUTHENTICATED", "You must be signed in.");

    // Per signed-in user (see DECISIONS.md). Every attempt counts, including invalid ones and ones
    // that later fail, so a failing Paystack cannot be hammered through this endpoint.
    const limit = await consume(`checkout:user:${auth.user.id}`, checkoutConfig.rateLimit);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return errorResponse(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
    }

    const parsed = checkoutRequestSchema.safeParse(rawBody);
    if (!parsed.success) return validationError(parsed.error);

    const result = await initiateCheckout({
      userId: auth.user.id,
      email: auth.user.email,
      billingInterval: parsed.data.billingInterval,
      appUrl: process.env.APP_URL,
      secretKey: process.env.PAYSTACK_SECRET_KEY,
    });

    if (result.ok) return json(200, { authorizationUrl: result.authorizationUrl });

    switch (result.code) {
      case "ALREADY_SUBSCRIBED":
        return errorResponse(409, "ALREADY_SUBSCRIBED", "You already have an active subscription.");
      case "NOT_CONFIGURED":
        console.error("POST /api/checkout: PAYSTACK_SECRET_KEY or APP_URL is not set in the environment.");
        return errorResponse(500, "INTERNAL_ERROR", "Payments are not available right now.");
      case "PROVIDER_FAILED":
        // Nothing from Paystack's response is passed on: it is stored in payment_log, not shown.
        return errorResponse(
          502,
          "PAYMENT_PROVIDER_UNAVAILABLE",
          "We couldn't start the payment. Please try again shortly.",
        );
    }
  } catch (error) {
    console.error("POST /api/checkout failed:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
}
