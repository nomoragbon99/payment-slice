import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

// No explicit return type on createPrismaClient(), and no bare `PrismaClient` annotation on the
// global cache below: PrismaClient's $on event names are a generic parameter inferred from the
// literal `log` array passed to its constructor (see src/generated/prisma/internal/class.ts).
// Annotating either as the bare `PrismaClient` type collapses that generic to `never`, which is
// why db.$on("query", ...) would otherwise fail to type-check even though `log` is configured
// below. ReturnType<typeof createPrismaClient> keeps the real, fully-inferred type instead.

// In development Next.js re-imports modules on every change; caching the client on
// globalThis stops each reload from opening a new database connection pool.
const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof createPrismaClient> };

function createPrismaClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    // Emitted as events only (nothing is printed to stdout, so normal app behaviour is
    // unchanged); scripts/check-session-query-count.ts listens on this to count real SQL
    // statements. Unused unless something calls $on -- no runtime cost otherwise.
    log: [{ emit: "event", level: "query" }],
  });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
