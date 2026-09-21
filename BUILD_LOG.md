# Build Log

Append-only. Every error, surprise or wrong assumption during the build. Raw material for DOCUMENTATION.md.

### Port-search grep hung past the 120s tool timeout (2026-09-21 02:55)
- Symptom: `grep -rnE "555[0-9]|5432|5433|300[0-9]" ... ai-slice records-slice auth-slice` did not finish within 120s and was moved to the background. The first command in the same call (per-file grep of package.json, docker-compose.yml, .env.example) had already returned the answer.
- Investigation: checked that ai-slice and records-slice are empty folders (ls -a shows only . and ..), so they were not the slow part. The recursive grep in auth-slice walked node_modules and .next; my `grep -v node_modules` filter only removes lines from the output and does not stop grep from reading those folders. The background run later completed with exit code 0 and only listed auth-slice's own docs and config files, which added nothing new.
- Cause: my own command scanned huge folders. It was not a problem with the repos.
- Fix: none needed for the result; for future searches use --exclude-dir=node_modules --exclude-dir=.next so grep skips them. No files were changed.
- Commit: b4cdcba (scaffold commit; no code change was required for this entry)

### npm audit reports 4 high-severity findings after install (2026-09-21 03:10)
- Symptom: `npm install` printed "4 high severity vulnerabilities". `npm audit` names deepmerge-ts (<8.0.0, reached through @prisma/config and prisma) and mysql2 (<=3.23.0).
- Investigation: both sit under the pinned prisma 7.10.0 dev tooling, the same version auth-slice pins. The suggested fix is `npm audit fix --force`, a breaking upgrade. Not checked: whether either package is loaded at runtime by this app (this app uses Postgres only and does not use MySQL).
- Cause: transitive dependencies of the Prisma CLI, not code in this repo.
- Fix: none applied. Did not run `--force`, to keep versions identical to auth-slice; to be revisited if the Prisma pin is bumped.
- Commit: b4cdcba

### Prisma client was stale after `prisma migrate dev` (2026-09-21 03:41)
- Symptom: while testing the ORM against payment_log, `db.paymentLog` was undefined: "TypeError: Cannot read properties of undefined (reading 'deleteMany')" (and 'count').
- Investigation: `prisma migrate dev` reported "Your database is now in sync with your schema", so the database was fine. Checked `prisma migrate status` (up to date) and `prisma migrate diff` (no difference). Neither of those looks at the generated client. The client in src/generated/prisma had been generated at scaffold time from an empty schema (no models), and Prisma 7's `migrate dev` no longer runs `generate` automatically. Also irrelevant but checked: earlier failure of `node --experimental-strip-types` on the generated client was a separate problem (extensionless imports in generated code), fixed by running the throwaway script through `npx tsx`.
- Cause: my wrong assumption that migrate dev regenerates the client. auth-slice's `db:migrate` script is `prisma migrate dev && prisma generate` for exactly this reason, and this repo copied that script but I ran the bare command by hand.
- Fix: ran `npx prisma generate`. Use `npm run db:migrate` (which chains generate) instead of the bare command.
- Commit: ba3e51e

### Append-only trigger error surfaced as "Foreign key constraint violated" (2026-09-21 03:44)
- Symptom: Prisma Client `paymentLog.update(...)` was rejected with "Foreign key constraint violated", which is not what happened.
- Investigation: the rejection was correct (my trigger fired) but the message was wrong. A plain-SQL TRUNCATE showed the real text "payment_log is append-only: TRUNCATE is not allowed". An UPDATE of the amount column cannot violate a foreign key, so the trigger had to be the source. The trigger raised SQLSTATE 23001 (restrict_violation).
- Cause: Prisma maps SQLSTATE 23001 to its foreign-key error (P2003). I chose that code because it sounded right ("restricted operation") without checking how Prisma reports it.
- Fix: new migration 20260921034500_payment_log_trigger_error_code re-creates the function with the default raise_exception code (P0001); Prisma now shows "payment_log is append-only: UPDATE is not allowed (add a new row instead)". A new migration was used because the first was already applied.
- Commit: ba3e51e

### Postgres rounds a fractional amount into the integer column (2026-09-21 03:37)
- Symptom: not an error. Inserting the amount 12.5 into payment_log.amount (integer) succeeded and stored 13.
- Investigation: expected a rejection; tested it on purpose in the constraint check. Postgres casts a numeric literal to integer by rounding, so no error is raised. Did not check the pg driver/Prisma path: Prisma's Int type is validated client-side and would reject 12.5 before it reaches the database, but raw SQL and any other client would not.
- Cause: my assumption that an integer column rejects decimals was wrong at the database level.
- Fix: no schema change is possible (a CHECK cannot see the original value once it is cast). Recorded in DECISIONS.md: the app must validate integer amounts with Zod before insert and convert Flutterwave's major-unit amounts to kobo in exactly one place.
- Commit: ba3e51e

### Correction: wrong commit hash in three entries above (2026-09-21 03:52)
- Symptom: the entries "Prisma client was stale...", "Append-only trigger error surfaced as ..." and "Postgres rounds a fractional amount..." cite `Commit: ba3e51e`, which does not exist in the pushed history.
- Investigation: `git log` shows the schema commit is 70682a6. I had written the hash into the log, then run `git commit --amend --no-edit` to include that edit, and amending gives the commit a new hash. Checked that origin/main is at 70682a6, so the correct hash is the pushed one.
- Cause: my own sequencing. Recording a commit's hash and then amending that same commit invalidates the hash.
- Fix: this correcting entry (the log is append-only, so the old lines stay). Rule for myself: never amend after recording a hash; commit the log entry in a follow-up commit.
- Commit: see this entry's own follow-up commit in git log

### Switch from Flutterwave to Paystack before any integration code existed (2026-09-21 05:10)
- Symptom: the Flutterwave account's webhook URL is set per account and that account was shared with another live project, so webhooks for this slice and for the other project could reach the wrong handler. Found while planning webhook handling, before any provider integration code was written; only the schema, .env.example and research existed.
- Investigation: compared the two providers' SDK and webhook models. (1) The Paystack official SDK @paystack/paystack-sdk: newest release 1.2.1 (2026-08-24) is an empty shell (tarball has no dist or src, main points at a missing file); 1.2.0 works but is 1.9 MB of generated code with no webhook verification; no telemetry in it (unlike the Flutterwave SDK). Decision: fetch, no SDK. (2) Paystack webhooks use HMAC-SHA512 over the raw body keyed with the secret key (x-paystack-signature), so there is no separate webhook secret and PAYSTACK_PUBLIC_KEY is not needed for a server-started redirect flow. (3) paystack.com/docs answered HTTP 403 to my fetcher, and two other doc mirrors did not resolve, so webhook details rest on search excerpts, two independent guides and the official OpenAPI spec, not on Paystack's own page. Still to check against a real test-mode webhook. (4) I repeated a mistake already logged above: a recursive grep through the project (`grep -rn ... | grep -v node_modules`) scanned node_modules and hung past the 120s tool timeout. Switched to `git grep`, which only searches tracked files. (5) Prisma refused to generate the rename migration ("environment is non-interactive") because it saw DROP COLUMN plus ADD COLUMN, i.e. data loss, so the migration was written by hand with RENAME COLUMN.
- Cause: the shared-account webhook collision described in Symptom (the owner's reason for the switch; not something found in code). Prisma's rename handling and the grep hang were tool behaviour I had already been warned about or could have predicted.
- Fix: new migration 20260921050000_provider_neutral_columns (renames the column, adds provider TEXT NOT NULL with CHECK IN ('paystack') and no default, rebuilds both unique indexes to include provider). The applied init migration was not edited. Constraint check script updated for the renamed column and provider: 74 checks pass (the original 64 plus 10 for provider, the rename and unknown_tx_ref), and each rejection was confirmed to name the intended constraint. prisma migrate diff reports no drift. .env.example, AGENTS.md (three lines) and the page description now say Paystack. The owner's local .env still has the old FLUTTERWAVE_* names and needs PAYSTACK_SECRET_KEY added by hand.
- Commit: f959872
