# Decisions

## Decisions

### Repository layout
- Decision: whether payments-slice is its own repository or a folder inside the parent repo at C:\Users\HP\Documents\build-assessments.
- Chosen: standalone repository at payments-slice/, initialised with its own .git, default branch main.
- Rejected and why: committing into the parent repo — rejected because the assessment should be reviewable on its own, same as auth-slice. The parent repo is left untouched.
- Files: .git/, .gitignore

### Reuse of auth-slice's session mechanism
- Decision: how this slice identifies the signed-in user.
- Chosen: reuse auth-slice's session/authentication mechanism. The assessment brief permits this; it will be documented as such in DOCUMENTATION.md.
- Rejected and why: building a second, separate authentication system — out of scope for this slice and would duplicate work the brief lets us reuse.
- Files: (to be filled in when implemented)

## Deliberately excluded
(none yet)
