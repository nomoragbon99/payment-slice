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

### Wrong assumption: AUTH_SECRET signs session cookies (2026-09-21 06:20)
- Symptom: while reading auth-slice's session code to plan the sign-in copy, sessions turned out to be plain random tokens with only a SHA-256 stored, with no signing anywhere. My .env.example comment ("Server-only secret used to sign session cookies ... same pattern as auth-slice") described something auth-slice does not do.
- Investigation: read auth-slice src/lib/auth/session.ts and tokens.ts, then ran `git grep AUTH_SECRET|getAuthSecret|hmacCode` over auth-slice's src and scripts. Every use is through hmacCode(), which keys the HMAC of the emailed verification codes (signup, resend-code, verify-email routes, plus the check-security-core script). Nothing in session creation or validation touches it. Not checked: auth-slice's own documentation files, which I did not read for what they say about it.
- Cause: my own assumption. The task description called AUTH_SECRET "reused pattern from auth-slice, for session cookies" and I wrote that into .env.example without opening auth-slice's code to confirm it.
- Fix: removed AUTH_SECRET from .env.example (we do not copy email verification, so it would be unused). The owner's local .env may still contain the line; it is harmless because nothing reads it.
- Commit: ae56d24

### Sign-in verification: two test-input mistakes and a server that was not mine (2026-09-21 07:15)
- Symptom: (1) the open-redirect check printed `"/evil.example" -> /evil.example` where I meant to test `/\evil.example`; (2) the dashboard check printed "You are signed in as " with no name; (3) my dev server log said `Error: listen EADDRINUSE: address already in use :::3002`, yet every request to port 3002 succeeded.
- Investigation: (1) the backslash was lost between my command and the TypeScript file (a lone backslash before "e" is just "e" in a JS string), so the guard was tested against a plain path, which it correctly allowed. Reran with the character built from String.fromCharCode(92): all 9 cases pass, including "/\evil.example" being refused. (2) React inserts an HTML comment between the text and the interpolated name, so grep for "signed in as [A-Za-z ]*" stopped early; grepping for "Alice Test" finds it (1 occurrence) and the text reads "You are signed in as Alice Test." (3) Get-NetTCPConnection on port 3002 plus the process command line showed an `npm run dev` (PID 37296, node 41256, started 05:17) already listening in this same project folder. It was not started by me; my own start attempt was the one that failed and exited. It hot-reloads the same code and reads the same .env, so the tests were valid against it. I did not stop it because it is not mine.
- Cause: (1) and (2) my own test commands were wrong, not the app. (3) a dev server left running by the owner.
- Fix: corrected the tests; no application change was needed. Sign-in checks then all passed against the running server: wrong password and unknown email give the identical 401 with indistinguishable timing (about 0.03s each); foreign Origin gets 403; bad JSON or fields get 400; a correct sign-in sets payment_slice_session with HttpOnly and SameSite=lax and a 7-day expiry; the sessions row id is the SHA-256 of the cookie value (64 chars vs the 43-char token, raw value not stored); /dashboard shows the name with the cookie and redirects to /sign-in without it, with a forged cookie, with auth-slice's cookie name, after the session expires (the expired row is deleted) and after sign-out (replaying the old cookie is refused). Sessions table left at 0 rows. The sign-in form's client-side behaviour (typing and clicking) was NOT exercised in a browser, only its server-rendered page and the API.
- Commit: deb8dd2

### npm warns that some install scripts were not run (2026-09-21 06:25)
- Symptom: after `npm install`, warnings like "npm warn allow-scripts 3 packages have install scripts not yet covered by allowScripts: prisma@7.10.0 (preinstall ...), unrs-resolver, @prisma/engines (postinstall ...)" and, after adding tsx, "esbuild@0.28.2 (postinstall: node install.js)".
- Investigation: checked that the things depending on those scripts still work: `prisma generate` and `prisma migrate dev` ran, `tsx scripts/seed.ts` ran and wrote three users, and @node-rs/argon2 hashed and verified passwords. So the skipped scripts were not needed here. Not checked: whether a fresh clone on another machine behaves the same.
- Cause: newer npm asks for an explicit allow-list before running dependencies' install scripts; none has been approved in this project.
- Fix: none; I did not run `npm approve-scripts`. Revisit if a fresh clone fails to install or generate.
- Commit: deb8dd2

### A ~180-line shell command failed to parse and wrote nothing (2026-09-21 09:05)
- Symptom: `/usr/bin/bash: -c: line 177: unexpected EOF while looking for matching `''` when I tried to create five source files (plans.ts, checkout.ts, rate-limit.ts, payment-log.ts, paystack/client.ts) with shell heredocs in one command.
- Investigation: checked `git status` and looked for each target file: none existed, so the whole command had failed to parse before running anything and there was nothing half-written to clean up. Did NOT find which line caused the quoting problem (the heredocs used a quoted terminator, so the content should have been literal); I did not bisect it.
- Cause: unknown quoting problem inside one very long command of my own making.
- Fix: created the files with the file-writing tool instead of shell heredocs. All five were then typechecked and unit-checked before committing.
- Commit: f8949d6

### My own edit script corrupted scripts/check-checkout.ts, and one check I wrote could never fail (2026-09-21 09:40)
- Symptom: after adding a before/after row-count check, `tsc` reported `scripts/check-checkout.ts(208,29): error TS1002: Unterminated string literal` and `npm run check:checkout` failed with `Transform failed with 1 error ... Unterminated string literal`.
- Investigation: read the file around line 200: the tail of the script had been duplicated, with a `console.log("` string cut in half by a newline. My node edit located a section with `indexOf` and sliced the file around it; the search text did not match (it contained an escaped newline written differently in the file), so indexOf returned -1 and the slice boundaries were wrong. Separately, re-reading the original last check showed `check("...", left === 0 || true, ...)`, which passes whatever the value is.
- Cause: my mistake in both cases: an unchecked indexOf result in a scripted edit, and a placeholder assertion written as always-true.
- Fix: repaired the tail by hand with an exact-text edit, and replaced the always-true check with a real one: the payment_log row count is read before the run and must be identical after it (it was 0 and 0). All 66 checks then passed.
- Commit: 7cacc43

### Plain GET of the Paystack payment page returned 403 (2026-09-21 09:55)
- Symptom: after the real test-mode call returned an authorizationUrl on checkout.paystack.com, `curl` of that URL got HTTP 403.
- Investigation: the same URL had just been produced by Paystack's own API for a valid test transaction with a matching reference, and the endpoint answered 200 with both real calls. Not checked: whether the page renders in a browser, or whether the 403 is bot protection on non-browser clients (a likely explanation, not confirmed).
- Cause: unknown; not proven to be a problem with our request.
- Fix: none. The owner should open the URL in a browser during the manual test to confirm the payment page loads. I do not claim it does.
- Commit: 7cacc43

### Fixed-window rate limit let 6 checkout requests through in the owner's manual test (2026-09-21 13:15)
- Symptom: the owner's browser test showed 6 successful POST /api/checkout responses before the first 429; the limit is 5 per 10 minutes.
- Investigation: read rate_limit_buckets and payment_log (read-only). alice had two counter rows: window 12:50:00-13:00:00 count 1, and window 13:00:00-13:10:00 count 6. payment_log held her six initiated rows at 12:57:18.194 and 13:03:07.488, :09.136, :10.498, :11.985, :13.649. So one attempt landed in the old window and five in the new one; the sixth attempt of the new window made the counter 6 and was rejected (the counter counts rejected attempts too). Ruled out: her earlier testing counting towards the new window (it would have reduced her allowance, not raised it); a restart resetting anything (the counters live in the database); an off-by-one in the check (allowed means count <= 5, the sixth was blocked). The two rows from 08:42 were my own earlier real Paystack calls, in a much older window, and are irrelevant. Not checked: nothing further needed; the numbers fully explain the result.
- Cause: my design choice of a fixed window, not a coding error. Fixed windows reset on clock boundaries, so an attempt just before a boundary is forgotten a moment later. I had written this down as a known limit (up to 2x at a boundary) but judged it minor, and my own concurrency and API checks all ran inside a single window, so they could not show it.
- Fix: decided to replace it with an exact sliding window (see DECISIONS.md, "Rate limiting: exact sliding window replaces the fixed window"). Implementation, migration and tests follow in later commits; this entry gets a follow-up when they are verified.
- Commit: 7cacc43 (where the behaviour was introduced); the fix will be a later commit

### Follow-up: sliding-window rate limit built and verified (2026-09-21 14:20)
- Symptom: continues "Fixed-window rate limit let 6 checkout requests through in the owner's manual test".
- Investigation: the exact incident was reproduced and re-run against the new limiter in three ways. (1) scripts/check-rate-limit.ts, 39 checks, all pass: 10 trials of 50 simultaneous attempts allowed exactly 5 each time and stored exactly 5 rows; with one attempt planted 6 minutes ago, a burst of 20 allowed exactly 4 and Retry-After was 240 s; the same scenario one request at a time gave ok ok ok ok 429 429; history planted at 1 s, 5 min, 598 s (inside) and 602 s, 700 s, 900 s (outside) always gave the count a simple reference calculation predicts, with outside rows deleted; 100 extra simultaneous attempts against a full window stored nothing, left the oldest row untouched and did not increase Retry-After; two users bursting at once each got exactly 5. (2) Negative control: the same count-then-insert without the lock let up to 10-13 attempts through in 20 of 20 trials (no artificial pause) and 20 of 20 with a 20 ms pause; with the lock every trial allowed exactly 5. (3) Through the real endpoint: with one attempt planted 6 minutes ago, 6 quick requests gave 400 400 400 400 429 429 (Retry-After 239), 5 rows stored (the 2 denied stored nothing); 8 simultaneous requests gave 5x400 and 3x429. Not tested: behaviour when the database itself is unreachable (the code is written to fail closed, but I did not simulate an outage); more than about 100 simultaneous attempts for one key.
- Cause: n/a, see the first entry.
- Fix: migration 20260921140000_sliding_window_rate_limit (creates rate_limit_attempts, drops rate_limit_buckets; the older migration is untouched) and the consume() rewrite. These went in one commit because dropping the old model breaks the old code, so a migration-only commit would not have typechecked. That is a small deviation from the four-commit split I described.
- Commit: 89e84ce (limiter and migration), a59bd23 (check scripts)

### Wrong claim: the old rate_limit_buckets table was empty when it was dropped (2026-09-21 14:05)
- Symptom: my plan said "the table is empty right now" and the migration's comment says "it was empty when this was written". Running `SELECT count(*)` just before applying it returned 2.
- Investigation: the 2 rows were alice's counters from the owner's manual browser test (window 12:50-13:00 count 1, window 13:00-13:10 count 6) created after I had last emptied the table. I noticed the 2, but the migration was already written and I applied it anyway because the rows were disposable counters for windows that had already ended. Not checked: nothing further needed; no other consumer read this table.
- Cause: I stated the table was empty from my earlier cleanup without re-checking after the owner's test, and I did not stop to correct the migration comment before applying it. Editing an applied migration would change its recorded checksum, so the incorrect comment stays in the file.
- Fix: no data of value was lost. This entry is the correction; the comment in migration 20260921140000 is wrong about the table being empty.
- Commit: 89e84ce

### check:checkout failed 28 checks once real rows existed, and I had miscounted its checks (2026-09-21 14:15)
- Symptom: after the rewrite `npm run check:checkout` printed `28 FAILED`, for example `exactly one payment_log row -> rows=8` and `network error: PROVIDER_FAILED, rows = [initiated, failed] -> initiated,initiated,initiated,initiated,initiated,initiated,initiated,initiated,failed`.
- Investigation: every failure was a row-count expectation. The script queried all payment_log rows for alice@example.com and assumed there were none, but alice now had 7 real rows (from the owner's manual test and my earlier real Paystack calls; 8 in the table in total). The 'row count is the same after every case' check still passed, so nothing had been written or lost. Nothing in the failing cases touches rate limiting.
- Cause: a flaw in my test, not in the checkout code: it depended on the database being empty of real payments.
- Fix: each case now creates its own throwaway user inside the rolled-back transaction, so real rows cannot affect it and no seed is needed; added a check that no throwaway users remain. Rerun with the 8 real rows present: 65 checks pass and the table still has 8 rows. Separately, I told the owner earlier that this script had 66 checks; counting properly it had 64 before this change (65 now). That figure was my miscount, not a change in what was tested.
- Commit: a59bd23

### Wrong assumption from the spec: an unknown Paystack reference is a 404 (2026-09-21 16:40)
- Symptom: while planning the return page I relied on Paystack's OpenAPI spec, which says an unknown reference answers 404. A real call for a reference that does not exist answered HTTP 400 with { status: false, message: "Transaction reference not found.", type: "validation_error", code: "transaction_not_found" }. A real call for one of our unpaid initiations answered HTTP 200, outer status true, message "Verification successful", data.status "abandoned".
- Investigation: two exploratory GETs with the test key through a throwaway script that never printed the key (deleted afterwards): one real unpaid reference and one all-zero reference, then a second script with the malformed references 'pslice-../../x y' and a blank, which answer HTTP 400 with code invalid_character_in_reference. Compared with the spec: it lists status values success, failed, abandoned, reversed and a 404 for a missing reference, but says nothing about the amount, currency or id fields, which the real response does carry (amount 300000 integer kobo, currency NGN, id a number).
- Cause: I planned from documentation I could not fully read (paystack.com/docs blocked my fetcher earlier) and from a spec that is wrong or incomplete on this point. The plan I gave the owner said 'unknown reference' would come from Paystack as a 404.
- Fix: the verify client recognises 'not found' as HTTP 400 plus the code transaction_not_found (an HTTP 404 is treated as an ordinary error, and so is the same English message with another code), and only data.status === "success" counts as paid. 33 client and reference-format checks cover this. The page was built after these calls, so no wrong behaviour shipped.
- Commit: c365122

### A test helper silently swallowed 'missing key', and a scripted edit failed again on escaping (2026-09-21 16:45)
- Symptom: `npm run check:checkout-return` printed `FAIL PAYSTACK_SECRET_KEY missing -> cannot_check, nothing called` and `1 FAILED`, while the 'empty key' case beside it passed.
- Investigation: the page logic was not at fault. My helper was declared `run(..., secretKey: string | undefined = SECRET)`, and JavaScript replaces an explicitly passed undefined with the default, so the 'missing key' case was quietly run WITH the real test key and behaved normally. I tried to fix it with a node edit script; it threw `not found` on its search text and applied nothing, because `
` inside my search string did not match the file (the same escaping trap that bit me earlier with backslashes), so my first rerun printed the identical single failure. I then used the exact-text edit tool instead.
- Cause: my own test bug (defaulted parameter) and my own tooling habit (long scripted edits with escape sequences).
- Fix: the helper now takes an options object and checks whether the key was passed at all. Added assertions that captured server log lines never contain the secret key or any Paystack response text. Rerun: 101 checks pass, including the missing-key case. Lesson for myself: prefer the exact-text edit tool over scripted string surgery.
- Commit: d064947

### Cache-Control no-store was not visible in dev mode, and proving it needed the dev server stopped (2026-09-21 16:55)
- Symptom: I had planned 'no-store' for the payment status page, but a signed-in request to the running dev server answered `Cache-Control: no-cache, must-revalidate` even after I set the header in next.config.ts and then in proxy.ts.
- Investigation: the dashboard, which has no such setting, answered identically in dev, so the dev server was overriding whatever we set. To see real behaviour I stopped the dev server (I had started it in this session; the process tree was identified by its command line and only that was killed, with the database container untouched), ran `next build` (succeeded; /checkout/return is a dynamic route) and `next start` on port 3990 (unused). In production the page answered `cache-control: no-store` for both the signed-in page and the signed-out redirect, and /sign-in kept its own static caching. I then removed the duplicate setting from proxy.ts and rebuilt: the config alone still gave no-store on both. Cleared the gitignored .next build output and restarted the dev server on 3002. Not checked: how a browser's back button behaves with this header.
- Cause: Next's dev server sets its own Cache-Control on dynamic pages; production honours the configured header.
- Fix: keep the single setting in next.config.ts; document that dev mode cannot show it. The dev server was briefly down and is back on 3002.
- Commit: a59d908
