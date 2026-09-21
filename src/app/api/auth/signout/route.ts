import type { NextRequest } from "next/server";
import { errorResponse, json } from "@/lib/http";
import { clearSessionCookie, invalidateSession, validateSession } from "@/lib/auth/session";
import { assertSameOrigin } from "@/lib/security/origin";

export async function POST(request: NextRequest) {
  try {
    const originError = assertSameOrigin(request);
    if (originError) return originError;

    const auth = await validateSession();
    if (auth) await invalidateSession(auth.session.id);
    await clearSessionCookie();

    // Always 200: signing out when already signed out is a success, not an error.
    return json(200, { next: "/sign-in" });
  } catch (error) {
    console.error("POST /api/auth/signout failed:", error);
    return errorResponse(500, "INTERNAL_ERROR", "Something went wrong. Please try again.");
  }
}
