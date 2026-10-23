const CACHE_NAME = 'crest-v475';

// Two caches, because this origin serves two kinds of file (S855, PERF-4).
//
// CACHE_NAME holds the shell ('/') and the UNHASHED files: /manifest.json, /staff.webmanifest, the
// icons, /print-station-tick.js. Their names never change, so the only way a new copy reaches a
// device is a new cache: CACHE_NAME is bumped on every release and `activate` deletes the old one.
// The bump is also what makes this script differ byte for byte, which is how the browser, and
// src/shared/releaseWatch.js on a till, learns that a release exists. Keep bumping it.
//
// STATIC_CACHE holds everything under /static/. CRA puts a hash of the content in each of those
// names, so a name that survives from one build to the next is the same bytes, and this cache is
// NEVER bumped. Until S855 these files sat in CACHE_NAME too, and every release deleted all of them:
// a till on a slow link downloaded the whole app again after each deploy, chunks that had not
// changed included.
//
// What STATIC_CACHE keeps is decided per release. Install records the new build's /static/ list from
// /asset-manifest.json; activate keeps the files of the new build AND of the build before it, and
// deletes the rest. The previous build stays because skipWaiting + clients.claim put a tab still
// running it under this worker at once, and Vercel answers that build's hashes with a 404, so the
// cached copy is the only one left. Older than that, the reload in src/shared/chunkReload.js is the
// answer.
//
// The prune fails safe, and here safe means KEEP. No list for the new build (an install that could
// not read the manifest), a list that does not name its own entrypoints, or no list for the build
// before (the first release with this worker, or one that could not read the manifest) each skip
// it, and a later release prunes instead.
const STATIC_CACHE = 'crest-static';

// The worker's own bookkeeping rows, kept inside STATIC_CACHE. They are not files: the fetch handler
// passes anything under this prefix straight to the network, so a page is never answered from them.
const SW_META = '/__crest-sw/';
const PENDING_KEY = `${SW_META}manifest-pending`; // the installing build, until it activates
const BUILDS_KEY = `${SW_META}builds`; // { current, previous }: the two builds STATIC_CACHE keeps

// The browser holds every fetch on this origin until `activate` settles, so the tidy-up gets a
// bound. Past it, activation goes ahead and the tidy-up carries on behind.
const TIDY_TIME_LIMIT_MS = 8000;

const toPath = f => (f.startsWith('/') ? f : `/${f}`);
const isStaticPath = p => p.startsWith('/static/');
const isHtml = res => (res.headers.get('content-type') || '').toLowerCase().includes('text/html');

// What may enter STATIC_CACHE from the network. `basic` for the reason the navigation branch below
// gives. Never HTML: a host that answered a missing hash with its index.html would otherwise leave a
// web page stored under a script name, in the one cache no release washes out.
const isStorableStatic = res => !!res && res.ok && res.type === 'basic' && !isHtml(res);

const jsonResponse = value =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

async function readJson(cache, key) {
  try {
    const res = await cache.match(key);
    return res ? await res.json() : null;
  } catch (_) {
    return null;
  }
}

// A build as CRA's asset manifest describes it: its /static/ files (the `files` values) and its
// entrypoints. Stamped with CACHE_NAME, so `activate` can tell its own build from a stale one.
function buildRecord(manifest) {
  const strings = list => list.filter(f => typeof f === 'string').map(toPath);
  return {
    version: CACHE_NAME,
    files: strings(Object.values(manifest.files || {})).filter(isStaticPath),
    entrypoints: strings(manifest.entrypoints || []),
  };
}

// The set of paths a record vouches for, or null when it cannot be trusted to prune against: missing,
// empty, or not even naming its own entrypoints.
function keepSet(record) {
  if (!record || !Array.isArray(record.files) || !Array.isArray(record.entrypoints)) return null;
  const files = new Set(record.files.filter(f => typeof f === 'string' && isStaticPath(f)));
  if (files.size === 0 || record.entrypoints.length === 0) return null;
  return record.entrypoints.every(f => files.has(f)) ? files : null;
}

// The app shell: the document, plus the ONE js/css pair every route boots through. CRA emits
// their hashed names into /asset-manifest.json at build time, which is the only way this
// hand-written worker can know them.
//
// Precaching them is what makes "offline" mean anything here. Before S731 the install cached '/'
// alone — so offline, the document loaded, asked for a main.<hash>.js that had never been fetched,
// and rendered a blank white page, which was the state after every deploy until the user next
// opened the app online. The worker was advertising an offline mode it did not have.
//
// Deliberately just the entrypoints, not every file in the manifest: the route chunks run to
// megabytes and this same worker is installed by every diner who scans a table QR code. What this
// buys is the difference between a white screen and an app that boots and can explain itself — a
// route whose own chunk was never fetched still cannot render, and AppErrorBoundary says so in
// those words.
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  const statics = await caches.open(STATIC_CACHE);
  // A list left by an earlier install that never activated must not be read as this build's.
  await statics.delete(PENDING_KEY).catch(() => {});
  try {
    await cache.add('/');
  } catch (_) {
    // Installing while offline. The navigation fallback reads whatever '/' is left; failing the
    // whole install here would leave the app with no worker at all.
  }
  try {
    const res = await fetch('/asset-manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const record = buildRecord(await res.json());
    // One at a time and individually caught: addAll() rejects as a unit, so a single 404 would
    // throw away the entrypoint that did fetch.
    await Promise.all(record.entrypoints.map(url => precacheEntrypoint(url, cache, statics)));
    await statics.put(PENDING_KEY, jsonResponse(record));
  } catch (_) {
    // No manifest (offline, or a build that did not emit one). The on-demand branches below still
    // cache these files the first time they are fetched, and with no list `activate` prunes nothing.
  }
}

async function precacheEntrypoint(url, cache, statics) {
  try {
    if (!isStaticPath(url)) {
      await cache.add(url);
      return;
    }
    // A name an earlier build already had is the same file: no download. Before S855 that copy sat
    // in a crest-v* cache, which activate is about to delete, so it is copied across first.
    const kept = await caches.match(url);
    if (kept && kept.ok && !isHtml(kept)) {
      if (!(await statics.match(url))) await statics.put(url, kept);
      return;
    }
    const res = await fetch(url);
    if (isStorableStatic(res)) await statics.put(url, res);
  } catch (_) {
    // This one stays uncached; the fetch handler gets it on first use.
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

// (a) The first release with this worker: the ones before kept /static/ files in their crest-v*
// cache, so copy them across before (b) deletes that cache, or this release downloads them all again.
// A file already in STATIC_CACHE is left as it is.
async function adoptStaticEntries(name, statics) {
  const old = await caches.open(name);
  for (const req of await old.keys()) {
    const url = new URL(req.url);
    if (url.origin !== self.location.origin || !isStaticPath(url.pathname)) continue;
    try {
      if (!(await statics.match(req))) {
        const res = await old.match(req);
        if (res && res.ok && !isHtml(res)) await statics.put(req, res);
      }
      // CACHE_NAME survives (b), so its copy goes here rather than sitting there unread.
      if (name === CACHE_NAME) await old.delete(req);
    } catch (_) {
      // Not copied: fetched again on first use, which is all an old worker ever did.
    }
  }
}

// (c) Keep the new build and the build before it; delete every other /static/ file. Then the new
// build becomes `current` and the old `current` becomes `previous`, in ONE write, so an activation
// cut short cannot leave the two labels describing the same build.
async function pruneStatic(statics) {
  const pending = await readJson(statics, PENDING_KEY);
  const builds = await readJson(statics, BUILDS_KEY);
  const next = pending && pending.version === CACHE_NAME ? pending : null;
  const nextKeep = keepSet(next);
  const prev = builds && builds.current;
  const prevKeep = keepSet(prev);

  if (!nextKeep) {
    // This build's files are unknown, so the next release could not keep them for a tab still
    // running this one. Forget the record: that release keeps everything as well.
    await statics.delete(BUILDS_KEY);
    await statics.delete(PENDING_KEY);
    return;
  }
  if (prevKeep) {
    for (const req of await statics.keys()) {
      const path = new URL(req.url).pathname;
      if (path.startsWith(SW_META) || nextKeep.has(path) || prevKeep.has(path)) continue;
      await statics.delete(req).catch(() => {});
    }
  }
  await statics.put(BUILDS_KEY, jsonResponse({ current: next, previous: prevKeep ? prev : null }));
  await statics.delete(PENDING_KEY);
}

async function tidyCaches() {
  const statics = await caches.open(STATIC_CACHE);
  const names = await caches.keys();
  for (const name of names.filter(n => n !== STATIC_CACHE && n.startsWith('crest-v'))) {
    await adoptStaticEntries(name, statics).catch(() => {});
  }
  // (b) Every other cache goes, as before S855: the unhashed files refresh only this way.
  await Promise.all(
    names.filter(n => n !== CACHE_NAME && n !== STATIC_CACHE).map(n => caches.delete(n).catch(() => false))
  );
  await pruneStatic(statics);
}

// Never rejects and never hangs: a tidy-up that fails or stalls must not cost the release.
function withinTimeLimit(work, ms) {
  let timer;
  const limit = new Promise(resolve => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work.catch(() => {}), limit]).finally(() => clearTimeout(timer));
}

self.addEventListener('activate', event => {
  event.waitUntil(withinTimeLimit(tidyCaches(), TIDY_TIME_LIMIT_MS));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Same-origin only. Returning early hands the request back to the browser's own default
  // handling, which is what we want for everything below.
  //
  // This supersedes the old `hostname.includes('supabase.co')` skip (Supabase is cross-origin, so
  // it is covered by this check) and fixes a real bug it left behind: the Google Fonts stylesheet
  // and its woff2 files fell through to the cache-first branch, where `fetch(event.request)`
  // returns an OPAQUE response for a no-cors cross-origin request. `cache.put()` REJECTS on an
  // opaque response, and `res.ok` is false for one (status 0), so the work could only ever fail —
  // surfacing as the "Uncaught (in promise) TypeError: Failed to fetch at service-worker.js:45"
  // seen during the crest-v56 rollout. Caching a third party's assets was never the intent here.
  //
  // Independently, a service worker inherits the CSP served with its own script, and this app's
  // connect-src (vercel.json) does not list fonts.googleapis.com — so a SW-issued fetch for the
  // font would be blocked there too. Not intercepting it at all sidesteps both problems, and the
  // browser caches fonts perfectly well on its own.
  if (url.origin !== self.location.origin) return;

  // The bookkeeping rows in STATIC_CACHE are not files.
  if (url.pathname.startsWith(SW_META)) return;

  if (event.request.mode === 'navigate') {
    // Navigation requests: network first, fall back to the cached root shell.
    //
    // Every navigation on this origin is answered by the SAME index.html (Vercel rewrites all
    // client-side routes to it), so the response is stored under '/' — the one key the offline
    // fallback below actually reads. Storing it under `event.request` instead, which is what this
    // did before, wrote a separate entry per visited URL that nothing ever read back: dead cache
    // growth, unbounded in the query string, while the shell itself only ever refreshed on a
    // visit to '/'.
    //
    // The `ok`/`basic` test is the other half. There was no status check here at all, so a 5xx or
    // a maintenance page served during a deploy was cached as the offline shell and stayed the
    // offline shell until the next CACHE_NAME bump. `res.type` matters for the same reason it
    // does in the cross-origin note above: a navigation request carries `redirect: 'manual'`, so
    // a redirect resolves to an opaqueredirect response whose status is 0 — `cache.put()` REJECTS
    // on one, and with no catch that surfaced as an unhandled rejection in the worker.
    event.respondWith(
      fetch(event.request)
        .then(res => {
          if (res.ok && res.type === 'basic') {
            const toCache = res.clone(); // clone synchronously before any async op
            caches.open(CACHE_NAME)
              .then(c => c.put('/', toCache))
              .catch(() => {});
          }
          return res;
        })
        // This release's shell first: an activate cut short by its time limit can leave an older
        // cache, and caches.match() searches the oldest first.
        .catch(() => caches.match('/', { cacheName: CACHE_NAME }).then(hit => hit || caches.match('/')))
    );
    return;
  }

  // Content-hashed build files (JS, CSS, fonts): cache first against the cache no release clears.
  if (isStaticPath(url.pathname)) {
    event.respondWith(
      caches.match(event.request, { cacheName: STATIC_CACHE })
        .catch(() => undefined)
        .then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(res => {
            if (isStorableStatic(res)) {
              const toCache = res.clone(); // clone synchronously before any async op
              caches.open(STATIC_CACHE).then(c => c.put(event.request, toCache)).catch(() => {});
            }
            return res;
          });
        })
    );
    return;
  }

  // Unhashed files (the manifests, icons, print-station-tick.js): cache first, fetch on miss, in
  // CACHE_NAME only, so they refresh when a release replaces it.
  event.respondWith(
    caches.match(event.request, { cacheName: CACHE_NAME }).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res.ok) {
          const toCache = res.clone(); // clone synchronously before any async op
          caches.open(CACHE_NAME).then(c => c.put(event.request, toCache)).catch(() => {});
        }
        return res;
      });
    })
  );
});

// Web Push — HR Roster publish/shift-swap notifications (src/utils/webPush.js subscribes,
// supabase/functions/hr-push sends). Payload is always JSON: { title, body, url }.
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    // A non-JSON payload should still reach the employee rather than being dropped silently.
    data = { body: event.data ? event.data.text() : '' };
  }
  // The subscription is made with userVisibleOnly: true, so a push MUST produce a visible
  // notification. Browsers punish a worker that stays silent — repeatedly, and the subscription
  // is eventually revoked — so there is no early return here, only fallback text.
  event.waitUntil(
    self.registration.showNotification(data.title || 'Crest Staff', {
      body: data.body || 'Open the app to see what changed.',
      icon: '/staff192.png',
      badge: '/staff192.png',
      // A shared tag REPLACES an unread notification instead of stacking a second one: publishing
      // a roster twice in a minute should not leave two identical entries on the lock screen.
      //
      // It has to be shared by REPEATS, though, not by everything HR sends. The default was the
      // constant 'crest-hr' and hr-push has never sent a tag of its own, so all four kinds it
      // sends — Roster Published, Shift Swap Request, Shift Swap Update, and a manager's
      // decision — collapsed into one another: a swap request arriving on top of an unread roster
      // notification silently replaced it and the employee never saw the first. Falling back to
      // the title keeps the de-duplication where it was meant to be and separates the rest.
      // hr-push now sends explicit tags; this fallback is what makes an un-redeployed function
      // behave correctly too.
      tag: data.tag || `crest-hr-${data.title || 'general'}`,
      data: { url: data.url || '/hr/self-service' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/hr/self-service';

  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

    // Already on the right screen: bring it forward. Opening a second window over the one the
    // employee already has would lose whatever they were part-way through — a half-typed leave
    // reason, say. openWindow unconditionally (what this did before) does exactly that.
    for (const client of open) {
      if (new URL(client.url).pathname === url && 'focus' in client) return client.focus();
    }
    // Some other screen of the same app is open — reuse that window rather than spawning another.
    if (open.length > 0 && 'navigate' in open[0]) {
      await open[0].focus();
      return open[0].navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
