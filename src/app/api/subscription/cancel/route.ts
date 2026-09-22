import { z } from "zod";
import type { NextRequest } from "next/server";
import { validateSession } from "@/lib/auth/session";
import { cancelSubscription } from "@/lib/billing/cancel";
import { errorResponse, json, validationError } from "@/lib/http";
import { assertSameOrigin } from "@/lib/security/origin";

// Marks the signed-in person's subscription to end at the close of the current period; it never cuts access off
// early (cancelSubscription only ever sets cancel_at_period_end, never status). No rate limit: this only ever
// writes two columns on the caller's own already-loaded row, makes no external call, and cannot grant, extend or
// steal a subscription -- hammering it can, at worst, flip cancel_at_period_end back and forth, and resume undoes
// that. Same-origin plus the session requirement is the whole defence, same reasoning as sign-in.
const cancelRequestSchema = z.strictObject({
  reason: z.string().trim().min(1, "Reason must not be empty.").max(500, "Reason must be 500 characters or fewer.").optional(),
});

export async function POST(request: NextRequest) {
  try {
    const originError = assertSameOrigin(request);
    if (originError) return originError;

    const auth = await validateSession();
    if (!auth) return errorResponse(401, "UNAUTHENTICATED", "You must be signed in.");

    let rawBody: unknown = {};
    const text = await request.text();
    if (text.length > 0) {
      try {
        rawBody = JSON.parse(text);
      } catch {
        return errorResponse(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
      }
    }
    const parsed = cancelRequestSchema.safeParse(rawBody);
    if (!parsed.success) return validationError(parsed.error);

    const result = await cancelSubscription(auth.user.id, parsed.data.reason);
    switch (result.outcome) {
      case "canceled":
        return json(200, { endsOn: result.endsOn.toISOString() });
      case "not_subscribed":
        return errorResponse(409, "NOT_SUBSCRIBED", "You don't have an active plan to cancel.");
      case "already_canceled":
        return errorResponse(409, "ALREADY_CANCELLED", "Your plan is already set to end.");
    }
  } catch (error) {
    console.error("POST /api/subscription/cancel failed:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
}
