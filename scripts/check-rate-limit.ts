// Proves the sliding-window rate limiter against the real local database: under heavy concurrency
// exactly `max` attempts succeed, regardless of WHEN in a clock period they arrive.
//
// Run with: npm run check:rate-limit
//
// Every key starts with "check-rate-limit:" so this script only ever touches its own rows, and it
// deletes them before and after. It refuses to run against a non-local database.
import { db } from "../src/lib/db";
import { consume, type ConsumeResult } from "../src/lib/security/rate-limit";

const url = process.env.DATABASE_URL;
if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at a local database.");
  process.exit(1);
}

const WINDOW = 600; // seconds, the production window (10 minutes)
const MAX = 5; // the production limit
const PREFIX = "check-rate-limit:";
const runId = Date.now().toString(36);
let keyCounter = 0;
const newKey = (label: string) => `${PREFIX}${runId}:${++keyCounter}:${label}`;

let failures = 0;
let warnings = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  -> " + detail : ""}`);
}
function warn(name: string, detail = "") {
  warnings++;
  console.log(`WARN  ${name}${detail ? "  -> " + detail : ""}`);
}

const cleanup = () => db.$executeRaw`DELETE FROM rate_limit_attempts WHERE key LIKE ${PREFIX + "%"}`;
const rowCount = async (key: string) =>
  (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM rate_limit_attempts WHERE key = ${key}`)[0].n;
const oldestAt = async (key: string) =>
  (await db.$queryRaw<{ t: Date | null }[]>`SELECT min(at) AS t FROM rate_limit_attempts WHERE key = ${key}`)[0].t;

// Plants attempts that happened `ages` seconds ago (by the database clock).
async function seed(key: string, ages: number[]) {
  for (const age of ages) {
    await db.$executeRaw`
      INSERT INTO rate_limit_attempts (key, at)
      VALUES (${key}, clock_timestamp() - (${age}::double precision * interval '1 second'))`;
  }
}
const burst = (key: string, n: number, limit = { windowSeconds: WINDOW, max: MAX }) =>
  Promise.all(Array.from({ length: n }, () => consume(key, limit)));
const allowedOf = (results: ConsumeResult[]) => results.filter((r) => r.allowed).length;

// A deliberately WRONG limiter used only as a negative control: the same count-then-insert, but
// WITHOUT the advisory lock. `pauseMs` widens the gap between the count and the insert.
async function lockFreeConsume(key: string, limit: { windowSeconds: number; max: number }, pauseMs: number) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM rate_limit_attempts
      WHERE key = ${key} AND at > clock_timestamp() - (${limit.windowSeconds}::double precision * interval '1 second')`;
    if (pauseMs) await tx.$executeRaw`SELECT pg_sleep(${pauseMs / 1000})`;
    if (rows[0].count < limit.max) {
      await tx.$executeRaw`INSERT INTO rate_limit_attempts (key) VALUES (${key})`;
      return true;
    }
    return false;
  });
}

async function main() {
  await cleanup();

  console.log("== 1. many simultaneous attempts, one key: exactly 5 succeed ==");
  {
    let worst = 0;
    let bad = 0;
    for (let trial = 0; trial < 10; trial++) {
      const key = newKey("burst50");
      const results = await burst(key, 50);
      const allowed = allowedOf(results);
      worst = Math.max(worst, allowed);
      if (allowed !== MAX || (await rowCount(key)) !== MAX) bad++;
    }
    check("10 trials of 50 simultaneous attempts: every trial allowed exactly 5 and stored exactly 5 rows", bad === 0, `worst allowed=${worst}, bad trials=${bad}`);
  }
  {
    const key = newKey("sequential-remaining");
    const seen: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await consume(key, { windowSeconds: WINDOW, max: MAX });
      seen.push(r.allowed ? `ok(rem ${r.remaining})` : `denied(${r.retryAfterSeconds}s)`);
    }
    check("sequential: 5 allowed with remaining 4,3,2,1,0 then denied", seen.slice(0, 5).join(" ") === "ok(rem 4) ok(rem 3) ok(rem 2) ok(rem 1) ok(rem 0)" && seen[5].startsWith("denied") && seen[6].startsWith("denied"), seen.join(", "));
  }

  console.log("\n== 2. timing independence: history planted at different ages, then 20 simultaneous attempts ==");
  // ages are seconds ago. Anything younger than 600 s counts; older does not (and is deleted).
  const cases: { name: string; ages: number[] }[] = [
    { name: "no history", ages: [] },
    { name: "1 attempt 1 s ago", ages: [1] },
    { name: "THE INCIDENT: 1 attempt 6 minutes ago, then a burst", ages: [360] },
    { name: "3 attempts inside (1 s, 5 min, 598 s ago)", ages: [1, 300, 598] },
    { name: "1 attempt just OUTSIDE the window (602 s ago)", ages: [602] },
    { name: "3 attempts outside (602, 700, 900 s ago)", ages: [602, 700, 900] },
    { name: "2 inside + 2 outside", ages: [100, 200, 650, 800] },
    { name: "window already full (5 attempts spread over 500 s)", ages: [100, 200, 300, 400, 500] },
    { name: "5 attempts, all 598 s ago (about to expire)", ages: [598, 598, 598, 598, 598] },
  ];
  for (const c of cases) {
    const key = newKey("timing");
    await seed(key, c.ages);
    const inside = c.ages.filter((a) => a < WINDOW - 1); // 598 s counts; margins of 2 s keep the test itself stable
    const expectedAllowed = Math.max(0, MAX - inside.length);
    const results = await burst(key, 20);
    const allowed = allowedOf(results);
    check(`${c.name}: allowed exactly ${expectedAllowed}`, allowed === expectedAllowed, `allowed=${allowed}`);
    const rows = await rowCount(key);
    check(`${c.name}: rows stored = attempts inside the window + allowed (${inside.length + expectedAllowed}), outside ones deleted`, rows === inside.length + expectedAllowed, `rows=${rows}`);
    const denied = results.filter((r) => !r.allowed);
    if (denied.length) {
      // The block lifts when the oldest attempt inside the window turns 600 s old.
      const seenAges = c.ages.filter((a) => a < WINDOW);
      const expectedRetry = seenAges.length ? WINDOW - Math.max(...seenAges) : WINDOW; // if only new rows exist the oldest is ~now
      const spread = Math.max(...denied.map((d) => d.retryAfterSeconds)) - Math.min(...denied.map((d) => d.retryAfterSeconds));
      const got = denied[0].retryAfterSeconds;
      check(`${c.name}: Retry-After is when the oldest attempt leaves the window (~${expectedRetry}s)`, Math.abs(got - expectedRetry) <= 3 && spread <= 2, `got ${got}s, spread ${spread}s`);
    }
  }

  console.log("\n== 3. the exact scenario that exposed the fixed window, one request at a time ==");
  {
    const key = newKey("incident-sequential");
    await seed(key, [360]); // the attempt made 6 minutes earlier (12:57 in the manual test)
    const out: boolean[] = [];
    for (let i = 0; i < 6; i++) out.push((await consume(key, { windowSeconds: WINDOW, max: MAX })).allowed);
    const successes = out.filter(Boolean).length;
    check("1 attempt 6 min ago + 6 quick attempts: only 4 of the 6 succeed (5 in any 10 minutes, never 6)", successes === 4 && out.slice(0, 4).every(Boolean) && !out[4] && !out[5], out.map((o) => (o ? "ok" : "429")).join(" "));
  }

  console.log("\n== 4. denied attempts are not stored: hammering does not extend the block ==");
  {
    const key = newKey("hammer");
    await burst(key, 5); // fill the window
    const before = await consume(key, { windowSeconds: WINDOW, max: MAX });
    const oldestBefore = await oldestAt(key);
    const hammer = await burst(key, 100);
    const after = await consume(key, { windowSeconds: WINDOW, max: MAX });
    const oldestAfter = await oldestAt(key);
    check("100 further simultaneous attempts are all denied", allowedOf(hammer) === 0 && before.allowed === false);
    check("still exactly 5 rows stored (nothing added by denied attempts)", (await rowCount(key)) === MAX);
    check("oldest stored attempt unchanged", oldestBefore?.getTime() === oldestAfter?.getTime());
    check("Retry-After did not grow (it only shrinks as time passes)", after.retryAfterSeconds <= before.retryAfterSeconds && before.retryAfterSeconds - after.retryAfterSeconds <= 3, `${before.retryAfterSeconds}s -> ${after.retryAfterSeconds}s`);
  }

  console.log("\n== 5. keys are independent ==");
  {
    const a = newKey("user-a");
    const b = newKey("user-b");
    const [ra, rb] = await Promise.all([burst(a, 20), burst(b, 20)]);
    check("two users bursting at the same moment each get exactly 5", allowedOf(ra) === MAX && allowedOf(rb) === MAX, `a=${allowedOf(ra)} b=${allowedOf(rb)}`);
  }
  {
    const key = newKey("other-limits");
    const r = await burst(key, 10, { windowSeconds: 60, max: 2 });
    check("the limit and window come from the caller (max 2 / 60 s -> exactly 2)", allowedOf(r) === 2);
  }

  console.log("\n== 6. negative control: the same race WITHOUT the lock lets too many through ==");
  {
    const TRIALS = 20;
    const CONCURRENT = 30;
    async function trialsFor(label: string, run: (key: string) => Promise<boolean>) {
      const counts: number[] = [];
      for (let t = 0; t < TRIALS; t++) {
        const key = newKey(label);
        const results = await Promise.all(Array.from({ length: CONCURRENT }, () => run(key)));
        counts.push(results.filter(Boolean).length);
      }
      return counts;
    }
    const limit = { windowSeconds: WINDOW, max: MAX };
    const locked = await trialsFor("locked", async (k) => (await consume(k, limit)).allowed);
    check(`WITH the lock: ${TRIALS} trials x ${CONCURRENT} simultaneous, never more than 5 allowed`, Math.max(...locked) === MAX && Math.min(...locked) === MAX, `allowed per trial: min ${Math.min(...locked)}, max ${Math.max(...locked)}`);
    const plain = await trialsFor("lockfree", (k) => lockFreeConsume(k, limit, 0));
    const wide = await trialsFor("lockfree-wide", (k) => lockFreeConsume(k, limit, 20));
    const plainOver = plain.filter((n) => n > MAX).length;
    const wideOver = wide.filter((n) => n > MAX).length;
    console.log(`      lock-free, no pause:            allowed per trial max ${Math.max(...plain)}, ${plainOver}/${TRIALS} trials exceeded 5`);
    console.log(`      lock-free, 20 ms count->insert: allowed per trial max ${Math.max(...wide)}, ${wideOver}/${TRIALS} trials exceeded 5`);
    if (plainOver + wideOver > 0) check("the test can fail: the lock-free version exceeded 5 in at least one trial", true, `no pause ${plainOver}/${TRIALS}, 20 ms pause ${wideOver}/${TRIALS}`);
    else warn("negative control INCONCLUSIVE: the lock-free version never exceeded 5, so this run does not prove the test has teeth");
  }

  await cleanup();
  const left = (await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM rate_limit_attempts WHERE key LIKE ${PREFIX + "%"}`)[0].n;
  check("no rows left behind by this script", left === 0, `left=${left}`);

  await db.$disconnect();
  console.log(`\n${failures ? failures + " FAILED" : "all passed"}${warnings ? `, ${warnings} warning(s)` : ""}`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
