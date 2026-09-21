import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { authConfig } from "@/config/auth";

// Layer 1 of 2: a fast, database-free gate. It only checks whether a cookie with the right NAME
// is present -- it never reads or validates the cookie's VALUE, so a forged, expired, or
// already-signed-out cookie still passes through here untouched. The real check (an actual
// database lookup) happens in each protected page itself (layer 2, e.g. dashboard/page.tsx via
// getCurrentUser()); this layer exists only to redirect the common case -- nobody signed in at
// all -- before any page code, or any database query, ever runs.
export function proxy(request: NextRequest) {
  const hasSessionCookie = request.cookies.has(authConfig.session.cookieName);

  if (!hasSessionCookie) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(signInUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard"],
};
