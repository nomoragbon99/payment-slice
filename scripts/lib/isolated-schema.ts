// A TEMPORARY, isolated copy of the database structure for tests that need rows to be really committed.
//
// payment_log rows can never be deleted (append-only trigger), and concurrency tests cannot use a transaction
// that is rolled back. So this creates a temporary Postgres schema, runs the project's REAL migrations into it
// (real tables, real CHECKs, real partial unique indexes, real append-only trigger), and hands back a client
// whose queries all land there. The caller must call drop() (and does, in a finally block) to remove it.
//
// It NEVER writes to the real tables (public.*): the guard below stops everything, before any test runs, unless
// both kinds of query resolve to the temporary schema. It refuses to run against a non-local database.
import { spawnSync } from "child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client";

export type Isolated = {
  // Every query through this client (model queries AND raw SQL) resolves to the temporary schema.
  db: PrismaClient;
  // A client on the real schema: used ONLY to create and drop the temporary schema and to compare real row counts.
  admin: PrismaClient;
  schema: string;
  realCounts: () => Promise<{ log: number; subs: number; events: number }>;
  // What the safety guard saw, for the caller to print as a check.
  proof: { currentSchema: string; rawSubscriptions: string; rawPaymentLog: string; temporaryUsers: number; realUsers: number };
  // Drops the temporary schema and disconnects `db`. `admin` stays connected so the caller can still compare
  // the real tables afterwards; call close() when finished with it.
  drop: () => Promise<void>;
  close: () => Promise<void>;
};

export async function createIsolatedSchema(prefix: string): Promise<Isolated> {
  const url = process.env.DATABASE_URL;
  if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) {
    throw new Error("Refusing to run: DATABASE_URL must point at a local database.");
  }
  const schema = `${prefix}_${Date.now().toString(36)}`;
  if (!/^check_[a-z_]+_[a-z0-9]+$/.test(schema)) throw new Error("unsafe schema name");

  const admin = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
  const dropSchema = () => admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);

  try {
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);

    // Build it with the REAL migrations (the migration engine takes the schema from the URL).
    const migrateUrl = new URL(url);
    migrateUrl.searchParams.set("schema", schema);
    const deploy = spawnSync("npx", ["prisma", "migrate", "deploy"], {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: migrateUrl.toString() },
    });
    if (deploy.status !== 0) throw new Error(`could not migrate the temporary schema:\n${deploy.stdout}\n${deploy.stderr}`);

    // TWO settings are needed and BOTH matter: the adapter's `schema` makes Prisma's model queries use the
    // temporary schema, while `search_path` makes RAW SQL (unqualified table names) resolve there too. With
    // only the first, raw SQL would silently hit the real public tables.
    const clientUrl = new URL(url);
    clientUrl.searchParams.set("options", `-c search_path=${schema}`);
    const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: clientUrl.toString() }, { schema }) });

    // FATAL guard: if anything can reach the real tables, stop before a single test runs.
    const resolvesTo = async (query: string) => (await db.$queryRawUnsafe<{ s: string }[]>(query))[0].s;
    const namespaceOf = (table: string) => `SELECT n.nspname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('${table}')`;
    const currentSchema = await resolvesTo("SELECT current_schema() AS s");
    const rawSubscriptions = await resolvesTo(namespaceOf("subscriptions"));
    const rawPaymentLog = await resolvesTo(namespaceOf("payment_log"));
    const temporaryUsers = await db.user.count();
    const realUsers = (await admin.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM public.users`))[0].n;
    if (currentSchema !== schema || rawSubscriptions !== schema || rawPaymentLog !== schema || temporaryUsers !== 0) {
      await db.$disconnect();
      throw new Error(`SAFETY STOP: the test client can reach the wrong schema (current=${currentSchema}, raw subscriptions=${rawSubscriptions}, raw payment_log=${rawPaymentLog}, users in the temporary schema=${temporaryUsers}). No test was run.`);
    }

    const realCounts = async () => ({ log: await admin.paymentLog.count(), subs: await admin.subscription.count(), events: await admin.webhookEvent.count() });
    return {
      db,
      admin,
      schema,
      realCounts,
      proof: { currentSchema, rawSubscriptions, rawPaymentLog, temporaryUsers, realUsers },
      drop: async () => {
        await db.$disconnect();
        await dropSchema();
      },
      close: () => admin.$disconnect(),
    };
  } catch (error) {
    await dropSchema().catch(() => {});
    await admin.$disconnect().catch(() => {});
    throw error;
  }
}
