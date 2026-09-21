import { cookies } from "next/headers";
import { authConfig } from "@/config/auth";
import { db } from "@/lib/db";
import { generateSessionToken, sha256Hex } from "./tokens";

export type SafeUser = {
  id: string;
  name: string;
  email: string;
};

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + authConfig.session.lifetimeSeconds * 1000);

  // Only the hash is stored -- the raw token exists only in the cookie, so a database read
  // (backup, leaked dump) never hands out anything usable as a live session.
  await db.session.create({
    data: { id: sha256Hex(token), userId, expiresAt },
  });

  return { token, expiresAt };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(authConfig.session.cookieName, token, {
    // JavaScript can never read this cookie, so it can't be exfiltrated by an XSS payload.
    httpOnly: true,
    // Only sent over HTTPS once deployed; in local dev there is no TLS to require.
    secure: process.env.NODE_ENV === "production",
    // Not sent on cross-site requests (e.g. a form on another site posting here); together
    // with assertSameOrigin this is the CSRF defence.
    sameSite: "lax",
    // Sent on every route in the app, not just the one that set it.
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete({ name: authConfig.session.cookieName, path: "/" });
}

export async function validateSession(): Promise<{ session: { id: string }; user: SafeUser } | null> {
  const store = await cookies();
  const token = store.get(authConfig.session.cookieName)?.value;
  if (!token) return null;

  const sessionId = sha256Hex(token);

  // One query fetches the session together with the fields of its user this app is allowed
  // to expose -- never passwordHash, never anything not listed here.
  const session = await db.session.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        select: { id: true, name: true, email: true },
      },
    },
  });

  if (!session) return null;

  if (session.expiresAt <= new Date()) {
    // Self-cleaning: an expired session is deleted the moment something tries to use it,
    // so no separate cron job is needed to sweep expired rows for this slice's scale.
    await db.session.delete({ where: { id: sessionId } }).catch(() => {
      // Already gone (e.g. a concurrent request deleted it first) -- fine, the end state is
      // the same either way.
    });
    return null;
  }

  return { session: { id: session.id }, user: session.user };
}

export async function invalidateSession(sessionId: string): Promise<void> {
  await db.session.delete({ where: { id: sessionId } }).catch(() => {
    // Already gone -- deleting a session that no longer exists is not an error for the caller.
  });
}

// Convenience wrapper for server components that just need to know who's signed in.
export async function getCurrentUser(): Promise<SafeUser | null> {
  const result = await validateSession();
  return result?.user ?? null;
}
