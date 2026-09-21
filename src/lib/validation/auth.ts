import { z } from "zod";
import { authConfig } from "@/config/auth";

// z.email() (not the deprecated z.string().email()) is Zod 4's current top-level email
// validator. Trim/lowercase run first so " Foo@Bar.com " and "foo@bar.com" validate and land
// as the same value -- matching the users_email_lowercase_trimmed CHECK in the database.
const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: "Enter a valid email address." }));

export const signInSchema = z.object({
  email,
  // No minimum here: an existing account's real password is whatever it is, and the actual
  // check is against the stored hash, not a length rule. The maximum matters regardless --
  // without it, a client could submit an arbitrarily long string to be argon2-hashed on every
  // sign-in attempt.
  password: z
    .string()
    .min(1, "Password is required.")
    .max(authConfig.password.maxLength, `Password must be ${authConfig.password.maxLength} characters or fewer.`),
});
export type SignInInput = z.infer<typeof signInSchema>;
