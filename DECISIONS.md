# Decisions

## Decisions

### Repository layout
- Decision: whether payment-slice is its own repository or a folder inside the parent repo at C:\Users\HP\Documents\build-assessments.
- Chosen: standalone repository at payment-slice/, initialised with its own .git, default branch main.
- Rejected and why: committing into the parent repo — rejected because the assessment should be reviewable on its own, same as auth-slice. The parent repo is left untouched.
- Files: .git/, .gitignore

### Reuse of auth-slice's session mechanism
- Decision: how this slice identifies the signed-in user.
- Chosen: reuse auth-slice's session/authentication mechanism. The assessment brief permits this; it will be documented as such in DOCUMENTATION.md.
- Rejected and why: building a second, separate authentication system — out of scope for this slice and would duplicate work the brief lets us reuse.
- Files: (to be filled in when implemented)

### Flutterwave integration: official SDK vs direct REST calls
- Decision: how the server talks to Flutterwave.
- Chosen: call the Flutterwave v3 REST API directly with fetch, no SDK. Endpoints: POST /v3/payments (hosted checkout), GET /v3/transactions/verify_by_reference (server-side verification), all with the secret key as a Bearer token.
- Rejected and why: flutterwave-node-v3 1.4.1 (official, published 2026-06-17). Its source has no call to POST /v3/payments (no hosted checkout) and no webhook verification, so it covers only one of the three needs; it has no TypeScript types; it pulls in axios, winston, joi, q, md5 and node-forge; and since 1.4.0 it sends telemetry (transaction reference, amount, currency) to a third-party monitoring service. The older flutterwave-node was last published in 2023.
- Files: (none yet; applies to the future src/lib/flutterwave code)

### Flutterwave API version
- Decision: which Flutterwave API generation to target.
- Chosen: v3 (secret key + public key + webhook secret hash).
- Rejected and why: v4, which uses different credentials (OAuth client id and secret). Not investigated in depth; v3 is what the documented hosted checkout, verification and `verif-hash` webhook flow use.
- Files: .env.example

### Webhook authenticity check and encryption key
- Decision: how to authenticate webhooks, and whether an encryption key is needed.
- Chosen: compare the `verif-hash` header to FLUTTERWAVE_WEBHOOK_SECRET_HASH (a shared secret, not an HMAC signature, per Flutterwave's v3 docs), then still re-verify the transaction with the API before granting anything. No encryption key variable: in the SDK source it is used only to encrypt card data for direct charges, which this slice does not do.
- Rejected and why: trusting the header alone (a shared secret can leak, and our rule is that entitlement follows independent verification); adding FLUTTERWAVE_ENCRYPTION_KEY "just in case" (unused config invites confusion).
- Files: .env.example

### Local ports
- Decision: host ports for this project so it never collides with other local projects.
- Chosen: app 3002, Postgres 5434, Prisma Studio 5557. Studio is pinned in the db:studio script because an unpinned Studio picks a random port. 5555 is auth-slice's Studio and 5556 is used by another local project.
- Rejected and why: default ports 3000/5432/5555 (already used by other projects on this machine).
- Files: package.json, docker-compose.yml, .env.example

### Scaffold written by hand, not create-next-app
- Decision: how to create the Next.js project.
- Chosen: write the config files by hand, mirroring auth-slice's versions and settings (Next 16.3.5, React 19.2.8, Prisma 7.10.0, Zod 4, Tailwind 4, TypeScript strict), including next.config.ts `agentRules: false` so `next dev` never rewrites AGENTS.md.
- Rejected and why: create-next-app, because it requires an empty folder and this one already holds git history and project docs; it also would not pin the same versions as auth-slice.
- Files: package.json, tsconfig.json, eslint.config.mjs, next.config.ts, postcss.config.mjs, prisma.config.ts

## Deliberately excluded
(none yet)
