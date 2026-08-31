// A production build for VERIFICATION — the one you run to check a change compiles cleanly,
// as opposed to the one Vercel runs to deploy. Two differences from `npm run build`, both of
// which exist because of the same trap.
//
// WHY THIS EXISTS
// ---------------
// `react-scripts` caches ESLint results in `node_modules/.cache/.eslintcache`, and a CRA dev
// server (`npm start`) shares that directory with the build. If both are running, the dev server
// keeps writing its own entries back underneath the build, so the build lints against a stale
// snapshot and reports errors that are not in the code. The symptom is not always the documented
// `'X' is defined but never used` — a stale entry equally produces **`'X' is not defined`**
// against an import sitting plainly at the top of the file, which reads exactly like a real
// mistake and is what cost two rounds in S661.
//
// The trap has a second half worth knowing: `rm -rf node_modules/.cache` FAILS while the dev
// server holds `babel-loader` open (`Directory not empty`), which reads as "clearing the cache
// did not help" and sends you back to hunting a phantom. Only the one file needs to go, and
// removing it does not disturb the running dev server.
//
// So: if a build reports an error you cannot reproduce by reading the file, run this instead of
// deleting things by hand. If it STILL reports the error, the error is real.
//
// WHY IT IS NOT `npm run build`
// -----------------------------
// `build` is what Vercel runs. It must stay a plain `react-scripts build` — a deploy has no dev
// server to race with, and a deploy script that deletes caches is a deploy script doing something
// surprising. This is the local-verification path only.
//
// WHY IT IS A SCRIPT AND NOT A ONE-LINE npm ENTRY
// -----------------------------------------------
// The obvious `rimraf ... && cross-env CI=true react-scripts build` needs two devDependencies
// this project does not have (`rimraf` is present only transitively, so it can disappear on any
// install). `rm -f` + a `VAR=value` prefix is POSIX-only and this is a Windows machine, where an
// npm script runs under cmd.exe unless configured otherwise. Node is guaranteed present — npm
// runs on it — so doing it in Node costs nothing and works on both.

import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cache = join(root, 'node_modules', '.cache', '.eslintcache')

// `force` makes a missing file a no-op rather than a throw — the common case on a clean checkout.
rmSync(cache, { force: true })

// CI=true is what turns CRA's warnings into build failures, which is the entire point of a
// verification build: an unused import or a missing hook dependency should stop the run here
// rather than reach a deploy. `shell: true` is what lets `react-scripts` resolve from
// node_modules/.bin, which npm puts on PATH for a script it invokes.
const result = spawnSync('react-scripts', ['build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CI: 'true' },
  shell: true,
})

if (result.error) {
  console.error('\nCould not start react-scripts:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
