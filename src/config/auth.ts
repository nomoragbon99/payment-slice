// Every tunable value for the session/sign-in mechanism REUSED from auth-slice (permitted by the
// assessment brief; see DECISIONS.md). Handlers import from here; no magic numbers elsewhere.
// Trimmed to what sign-in needs: no verification-code, password-reset, rate-limit or idempotency
// settings, because those parts of auth-slice are not copied.

const DAY = 24 * 60 * 60;

export const authConfig = {
  session: {
    // Sessions last 7 days from sign-in, fixed: activity does not extend them.
    lifetimeSeconds: 7 * DAY,
    // Unique per project because browsers share localhost cookies across ports: auth-slice uses
    // "auth_slice_session", so reusing that name would mix up the two apps' sessions.
    cookieName: "payment_slice_session",
  },

  argon2: {
    // Memory per hash in KiB (19 MiB), OWASP minimum for argon2id.
    memoryCost: 19456,
    // Number of passes over memory, OWASP minimum paired with 19 MiB.
    timeCost: 2,
    // Threads per hash, OWASP minimum recommendation.
    parallelism: 1,
  },

  tokens: {
    // Byte length of session tokens: 32 bytes = 256 bits of entropy, infeasible to guess or
    // brute-force even given only the SHA-256 hash that is stored in the database.
    byteLength: 32,
  },

  password: {
    // Longest password accepted; caps hashing work per request (each sign-in attempt runs argon2).
    maxLength: 128,
  },
} as const;
