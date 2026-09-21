import { z } from "zod";
import type { NextRequest } from "next/server";
import { validateSession } from "@/lib/auth/session";
import { errorResponse, validationError } from "@/lib/http";
import { assertSameOrigin } from "@/lib/security/origin";

// PLACEHOLDER. The billing page's Cancel button is wired to this, but the cancellation itself is its own task and
// is not built: after the usual checks it answers 501. What is fixed now is the CONTRACT the next task fills in:
// only a signed-in person, a same-origin request, and an optional reason that fits the database rule
// (1 to 500 characters, see the subscriptions CHECK on cancellation_reason).
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

    return errorResponse(501, "NOT_IMPLEMENTED", "Cancelling a plan is not available yet.");
  } catch (error) {
    console.error("POST /api/subscription/cancel failed:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
}
