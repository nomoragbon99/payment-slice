import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/http";

// Together with the session cookie's SameSite=Lax, this is the CSRF defence: SameSite=Lax
// stops the cookie being sent on most cross-site requests, and this check catches the rest
// (e.g. a same-site subdomain, or a browser with an unusual SameSite implementation) by
// requiring the request's own declared Origin to match this app's origin.
export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("Origin");
  if (!origin) {
    // No Origin header at all: some legitimate same-origin requests omit it. Nothing to check.
    return null;
  }

  const appUrl = process.env.APP_URL;
  const expectedOrigin = appUrl ? new URL(appUrl).origin : null;

  if (origin !== expectedOrigin) {
    return errorResponse(403, "FORBIDDEN_ORIGIN", "This request's origin is not allowed.");
  }

  return null;
}
