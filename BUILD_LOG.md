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
