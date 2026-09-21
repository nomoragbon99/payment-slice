// Seeds three TEST users so sign-in can be exercised without a sign-up flow (sign-up is not part of
// this slice). Safe to re-run: users are matched by email, and re-running resets the test password.
//
// Run with: npm run db:seed   (loads DATABASE_URL from .env via `tsx --env-file=.env`)
//
// These are fake accounts with a fixed, publicly documented password, so this script refuses to run
// against anything but a local database.
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword } from "../src/lib/auth/password";

// Fixed on purpose (see DECISIONS.md): committed test-only credentials for a local database.
const SEED_PASSWORD = "payment-slice-test-1";

const SEED_USERS = [
  { email: "alice@example.com", name: "Alice Test" },
  { email: "bob@example.com", name: "Bob Test" },
  { email: "carol@example.com", name: "Carol Test" },
];

function assertLocalDatabase(url: string | undefined): string {
  if (!url) throw new Error("DATABASE_URL is not set. Add it to .env (see .env.example).");
  if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed test users when NODE_ENV=production.");
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Refusing to seed test users into a non-local database (host: ${host}).`);
  }
  return url;
}

async function main() {
  const connectionString = assertLocalDatabase(process.env.DATABASE_URL);
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const passwordHash = await hashPassword(SEED_PASSWORD);
    for (const user of SEED_USERS) {
      await db.user.upsert({
        where: { email: user.email },
        create: { ...user, passwordHash },
        update: { name: user.name, passwordHash },
      });
      console.log(`seeded ${user.email}`);
    }
    console.log(`Done. Test password for all three: ${SEED_PASSWORD}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
