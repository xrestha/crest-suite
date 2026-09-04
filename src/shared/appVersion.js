// The one place the running build's identifier lives — read by AppErrorBoundary's "Copy details"
// so a crash report names which bundle it happened on (S673).
//
// Mirrors the only monotonic build marker that already existed in this codebase,
// public/service-worker.js's CACHE_NAME — deliberately not a REACT_APP_ env var (silently empty
// locally, and nothing fails when it's unset) and not `caches.keys()` read at runtime (async,
// absent in dev since src/index.js unregisters the service worker there, and reports the CACHED
// version rather than the one actually running — actively misleading on the one screen where the
// running version is the fact that matters).
//
// Bump this in the SAME commit as CACHE_NAME in public/service-worker.js.
// appVersion.test.js reads that file off disk and fails if the two disagree — the
// legalHash.test.js pattern: a test that fails when you forget, not a comment that trusts you to
// remember.
export const APP_VERSION = 'crest-v189'
