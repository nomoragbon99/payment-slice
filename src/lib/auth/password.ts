import { hash, verify, type Options } from "@node-rs/argon2";
import { authConfig } from "@/config/auth";

// @node-rs/argon2 declares Algorithm as an ambient const enum, which TypeScript can't
// reference by name under this project's isolatedModules setting -- 2 is Argon2id, per the
// library's own type declarations.
const ARGON2ID = 2;

const argon2Options: Options = {
  algorithm: ARGON2ID,
  memoryCost: authConfig.argon2.memoryCost,
  timeCost: authConfig.argon2.timeCost,
  parallelism: authConfig.argon2.parallelism,
};

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, argon2Options);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    // Only the password matters here -- @node-rs/argon2 reads the cost parameters back out
    // of the stored hash string itself, so passing argon2Options again is unnecessary.
    return await verify(hashed, plain);
  } catch {
    // A malformed/foreign hash string throws in the underlying library. Treat that the same
    // as "wrong password" rather than letting a corrupted row 500 the request.
    return false;
  }
}
