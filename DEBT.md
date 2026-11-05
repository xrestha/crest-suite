# Technical debt register

Known shortcuts and leftovers in the code. Each one works today, is left as it is on purpose, and names the event that should make someone deal with it.
When an entry is paid off, delete it from this file and record the payoff in the CHANGELOG entry of the session that paid it.

---

## 1. The build tool, Create React App, is no longer maintained

**What it is.** The app is built and tested with Create React App (`react-scripts` 5 in `package.json`), which the React team deprecated in February 2025. It gets no new releases, so the webpack, Babel, ESLint and Jest 27 inside it stay where they are. React 19 runs on it without trouble. Vercel deploys with a plain `npm run build` (`react-scripts build`), and ESLint runs inside that build: there is no separate lint script, and `npm run build:verify` makes every lint warning fail.

**What it already costs.** Jest 27 needed two workarounds before a component test could run at all: the `jest.moduleNameMapper` block in `package.json` (react-router-dom 7 points Jest at a file it does not ship) and the `TextEncoder` shim in `src/setupTests.js`. It cannot load ESM-only packages in tests either, which is why the legal pages render their markdown with a small hand-written component instead of `react-markdown`. `scripts/build-verify.mjs` exists partly because a running CRA dev server rewrites the ESLint cache underneath a build.

**Why it is left.** Moving to another build tool (Vite is the usual choice) is a large change no client would see, it would land in the middle of a launch, and CLAUDE.md's Stack line records the setup as CRA with "no Vite". Nothing is blocked today.

**Owner decision (2026-11-05, S890, asked in plain words): leave it until the trigger below.**

**Trigger:** When an upgrade you actually need cannot be installed or built under `react-scripts` 5 (a security fix in code that ships to the browser, or a library the product needs), plan the migration as its own change, with the owner's approval and the CLAUDE.md Stack line updated in the same change. The new setup must still fail the build on a lint error, and `npm run build` must stay what Vercel runs. An `npm audit` warning is not the trigger on its own: read the dependency path it prints first, because the ones that trace back to `react-scripts` are usually build and dev-server tooling that never reaches the browser.

**Where to look:** `package.json` (`react-scripts`, `scripts`, `jest`), `src/setupTests.js`, `scripts/build-verify.mjs`, `.claude/rules/legal-documents.md` (the "Two Jest fixes" section).

---

## 2. The food tables were extracted once, from a PDF, by Python scripts

**What it is.** `src/data/foodTables.json` (the nutrition library's 1,115 Nepal and Indian foods, S884) is built by three Python scripts in `scripts/food-tables/`, the only Python in the repo. The Nepal half is read out of the 2012 PDF with `pdftotext`, by page position, and 332 display names (wrapped, misspelt or unclear in the book) are set by hand in a CSV. The 225 Nepal-to-Indian pairs that supply sugar and sodium were judged one by one. Nothing in `npm` or CI runs any of it; the reviewed CSVs and the JSON are committed.

**Why it is left.** Both books are fixed editions, so the extraction runs once per edition. A Node port would add nothing a reader can see.

**Owner decision (2026-11-05, S890): leave the scripts in Python.** A rewrite would change nothing anyone sees.

**Trigger:** When either table publishes a new edition, or a figure in the library is reported wrong. Re-run the README's rebuild steps, diff the CSVs and re-check the pairs, rather than editing the JSON.

**Where to look:** `scripts/food-tables/README.md` (sources, rebuild, review rules), the CSVs beside it, `src/data/nutritionSeed.test.js` (the invariants a rebuild must keep).
