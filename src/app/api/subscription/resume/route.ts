import type { NextRequest } from "next/server";
import { validateSession } from "@/lib/auth/session";
import { resumeSubscription } from "@/lib/billing/cancel";
import { errorResponse, json } from "@/lib/http";
import { assertSameOrigin } from "@/lib/security/origin";

// Lets someone change their mind about a cancellation while their current period has not ended yet. Only reachable
// while cancel_at_period_end is true (resumeSubscription re-derives that from describeSubscription, same as
// cancel); once the period has actually lapsed there is nothing to resume. No rate limit, same reasoning as cancel:
// no external call, no money moves, and hammering it can only flip a boolean.
export async function POST(request: NextRequest) {
  try {
    const originError = assertSameOrigin(request);
    if (originError) return originError;

    const auth = await validateSession();
    if (!auth) return errorResponse(401, "UNAUTHENTICATED", "You must be signed in.");

    const result = await resumeSubscription(auth.user.id);
    switch (result.outcome) {
      case "resumed":
        return json(200, { resumed: true });
      case "not_canceled":
        return errorResponse(409, "NOT_CANCELLED", "Your plan isn't set to end, so there's nothing to resume.");
    }
  } catch (error) {
    console.error("POST /api/subscription/resume failed:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
}
