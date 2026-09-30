// Checks that validateSession()'s session+user lookup is really one SQL statement now, not two.
//
// Background: db.session.findUnique({ include: { user: {...} } }) without an explicit
// relationLoadStrategy compiles, by Prisma's default ("query"), to TWO separate SQL statements
// (one on sessions, one on users via `WHERE user_id IN (...)`), joined together in application
// memory -- not a database-level JOIN, despite what the old comment above this call used to
// claim. relationLoadStrategy: "join" makes it a real single Postgres JOIN.
//
// This proves both sides in one run: the SAME underlying query via fetchSessionWithUser() (the
// function validateSession() actually calls), plus each relationLoadStrategy forced explicitly
// for contrast/documentation.
//
// Run with: npm run check:session-query-count
import { randomUUID } from "crypto";
import { inspect } from "util";
import { db } from "../src/lib/db";
import { fetchSessionWithUser } from "../src/lib/auth/session";
import { generateSessionToken, sha256Hex } from "../src/lib/auth/tokens";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}

// PrismaClient has $on but no $off (confirmed by reading its runtime source), so ONE listener is
// registered for the whole script run; each measurement resets the counter immediately before
// its call instead of adding/removing a listener.
let count = 0;
db.$on("query", () => {
  count++;
});
async function measure(run: () => Promise<unknown>): Promise<number> {
  count = 0;
  await run();
  return count;
}

async function main() {
  const email = `check-session-query-count-${randomUUID()}@example.com`;
  const user = await db.user.create({ data: { email, name: "Query Count Check", passwordHash: "not-a-real-hash" } });
  const token = generateSessionToken();
  const sessionId = sha256Hex(token);
  await db.session.create({ data: { id: sessionId, userId: user.id, expiresAt: new Date(Date.now() + 3600_000) } });

  try {
    console.log('== the real production code path (fetchSessionWithUser, relationLoadStrategy: "join") ==');
    const prodCount = await measure(() => fetchSessionWithUser(sessionId));
    check("fetchSessionWithUser issues exactly 1 SQL statement (one real Postgres JOIN)", prodCount === 1, `saw ${prodCount}`);

    console.log("\n== for contrast: the same query shape with each strategy forced explicitly ==");
    const withStrategy = (strategy: "query" | "join") =>
      db.session.findUnique({
        where: { id: sessionId },
        relationLoadStrategy: strategy,
        include: { user: { select: { id: true, name: true, email: true } } },
      });

    const queryStrategyCount = await measure(() => withStrategy("query"));
    check(
      'relationLoadStrategy: "query" issues 2 SQL statements (the old, default behaviour -- what the original "one query" comment got wrong)',
      queryStrategyCount === 2,
      `saw ${queryStrategyCount}`,
    );

    const joinStrategyCount = await measure(() => withStrategy("join"));
    check('relationLoadStrategy: "join" issues 1 SQL statement (a real database-level JOIN)', joinStrategyCount === 1, `saw ${joinStrategyCount}`);

    check("the join strategy issues fewer SQL statements than the query strategy", joinStrategyCount < queryStrategyCount, `${joinStrategyCount} vs ${queryStrategyCount}`);
  } finally {
    await db.session.deleteMany({ where: { userId: user.id } });
    await db.user.delete({ where: { id: user.id } });
  }

  const left = await db.user.count({ where: { email } });
  check("the throwaway user and session are gone", left === 0);
  await finish();
}

async function finish() {
  await db.$disconnect();
  console.log(failures ? `\n${failures} FAILED` : "\nall passed");
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  process.stderr.write(inspect(error) + "\n");
  await db.$disconnect();
  process.exit(1);
});
