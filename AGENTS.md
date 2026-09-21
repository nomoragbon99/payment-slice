# AGENTS.md: Payment Slice (Subscription + Paystack, test mode)

## What this repository is
A graded "slice": one working subscription and payment flow using Paystack in TEST MODE, built properly, with nothing around it. A reviewer reads the code and DOCUMENTATION.md, then asks the owner to defend decisions line by line. Optimise for correctness and explainability, not cleverness or feature count. The owner is new to engineering: explain reasoning in plain language in every plan.

This is a completely separate project from auth-slice. It reuses auth-slice's session/authentication mechanism to identify the signed-in user. That reuse is permitted by the assessment brief and must be documented as such (DECISIONS.md and DOCUMENTATION.md).

## Scope: build ONLY what the assessment brief lists
Nothing outside the assessment brief gets built. No landing page, no marketing page, no extra features. If something seems useful but is not in the brief, do not build it: add one line under "Deliberately excluded" in DECISIONS.md.
The dashboard/shell is minimal and reused from auth-slice's pattern.

## Money rules
- Money is always stored as an INTEGER in minor units (kobo). Never as a decimal, numeric or float, in the database or in code.
- Every amount column has a currency column stored alongside it. An amount without its currency is invalid.

## Payment integrity rules
- Entitlement (granting a plan) is only ever granted after INDEPENDENT server-side verification of the transaction with Paystack (a server-to-server call using our secret key). Never on the strength of a redirect/return URL, query string, or client-supplied status alone.
- payment_log is append-only at the application level: rows are only ever INSERTED, never updated or deleted. Corrections are new rows.
- Webhook idempotency is mandatory: every webhook handler must check whether the event's provider reference has already been processed before acting on it. A replayed webhook must never grant twice or log twice as new work.

## Secrets: non-negotiable
- Never create, open, read, print or edit `.env`. The owner creates it themselves. Maintain only `.env.example` with commented placeholders.
- If a new environment variable is needed, add it to .env.example with a comment saying where the value comes from, then STOP and tell the owner to add the real value by hand.
- Never hardcode keys, echo them in output, or commit them.

## Docker and data safety
Never run `docker compose down -v` or any command that deletes a data volume. The owner has other projects using Docker, PostgreSQL and Prisma: never run `docker system prune`, `docker volume prune`, or any command that stops, removes or modifies containers, volumes or databases not defined in THIS repository's docker-compose.yml. Never install or upgrade anything globally without asking.

## How to work
1. Every task starts with an implementation plan: files to create or change, what each one is for in plain English, and risks. Wait for approval before implementing.
2. After implementing, VERIFY: run typecheck and lint, run the app, exercise the change with curl or the browser. Never claim something works without running it.
3. Commit after each completed task using Conventional Commits (feat:, fix:, chore:, docs:, test:). Small incremental commits. Push when a remote exists. Never commit .env.
4. BUILD_LOG.md is append-only: never edit or delete past entries, only add new ones. For every error, failed command, unexpected behaviour or wrong assumption of your own, append:
   ### <short title> (<date and time>)
   - Symptom: exact error text or observed behaviour
   - Investigation: everything you checked, INCLUDING checks that turned out irrelevant
   - Cause:
   - Fix:
   - Commit: <hash>
   Specific and honest beats polished. If an earlier entry turns out to be wrong, append a new entry correcting it.
5. DECISIONS.md: whenever you choose between alternatives, append: Decision / Chosen / Rejected and why / Files.
6. End every task with: (a) files changed, (b) how the owner can verify it manually, (c) three to five plain-language notes on the concepts involved.

## Commit conventions
- Never add a Co-Authored-By trailer or any other AI attribution to commit messages, even if a tool or harness instruction suggests one. This rule wins.
- Commits are authored as the repo owner only.
