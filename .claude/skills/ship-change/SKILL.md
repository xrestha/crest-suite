---
name: ship-change
description: Close out a change for commit. Bump CACHE_NAME and APP_VERSION together, update Help and the module guides, write the CHANGELOG entry and index, run build:verify reading its real exit code, mirror docs, commit as type(S###).
---

# Ship a change

Run these in order once a change is ready to commit. A step whose condition does not apply is skipped, and the summary says which steps were skipped and why.

1. **Scope.** Run `git status --short`. Everything listed must belong to this change; anything else stays unstaged. For a new page, report or module feature, run the `new-feature-checklist` skill first.
2. **Service worker and app version.** If users should receive any JS or CSS change, bump `CACHE_NAME` in `public/service-worker.js` and `APP_VERSION` in `src/shared/appVersion.js` to the same new value. Read the current value from the file. `src/shared/appVersion.test.js` fails if the two disagree. Docs-only changes skip this step.
3. **Help and guides.** If what a user sees or does has changed, update `src/pages/Help.js` and the matching guide data in `src/pages/settings/` (`imsGuideData.js`, `hrGuideData.js`, `posGuideData.js`, `suiteGuideData.js`, `customizationGuideData.js`). They drift silently.
4. **Tests.** Run the test files beside what changed, through the Bash tool, reading the exit code as the `CLAUDE.md` Commands rule requires:
   `npx react-scripts test --watchAll=false <pattern> > /tmp/test.log 2>&1; echo "exit=$?"; tail -40 /tmp/test.log`
5. **CHANGELOG.** Prepend a `### S### — YYYY-MM-DD — <headline>` entry to the newest `CHANGELOG/S###-S###.md`, never `README.md`. Say what changed, how it was verified, and whether there was a service-worker bump, a migration or an Edge Function deploy. Then run `npm run changelog:index`.
6. **Build.** Through the Bash tool, in exactly this shape:
   `npm run build:verify > /tmp/build.log 2>&1; echo "exit=$?"; tail -40 /tmp/build.log`
   Never pipe the build into `tail`: a pipeline reports `tail`'s exit code, so a failed build reads as exit 0 (S693). Continue only on `exit=0`. `build:verify` runs `check:docs` too; when only docs changed, `npm run check:docs` in the same redirect shape is enough.
7. **Stage and mirror.** `git add` the files from step 1 and those changed in steps 2–5, then run `npm run mirror:docs`. It copies tracked `.md` files to the E: drive, so new ones must be staged first.
8. **Commit.** List the staged files for the user (`git diff --cached --stat`), then commit as `type(S###): <what changed>` with the attribution trailer. Write the message to a file and use `git commit -F <file>`, because a quoted `-m` in this shell breaks on apostrophes. Commit only when the user has asked for a commit, and push only when asked ("PI").
