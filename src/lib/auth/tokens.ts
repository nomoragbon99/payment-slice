import { createHash, randomBytes } from "crypto";
import { authConfig } from "@/config/auth";

// A session token is 32 random bytes (256 bits of entropy), so even its plain SHA-256 hash cannot
// be brute-forced. That is why the database stores only the hash and no signing secret (such as
// AUTH_SECRET) is involved: the secrecy lives in the token's randomness, not in a key.
export function generateSessionToken(): string {
  return randomBytes(authConfig.tokens.byteLength).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
