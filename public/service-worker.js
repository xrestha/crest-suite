const CACHE_NAME = 'crest-v271';

// The app shell: the document, plus the ONE js/css pair every route boots through. CRA emits
// their hashed names into /asset-manifest.json at build time, which is the only way this
// hand-written worker can know them.
//
// Precaching them is what makes "offline" mean anything here. Before S731 the install cached '/'
// alone — so offline, the document loaded, asked for a main.<hash>.js that had never been fetched
// under the CURRENT CACHE_NAME, and rendered a blank white page. And because CACHE_NAME is bumped
// on EVERY deploy and `activate` purges every other cache, that was the state after every single
// deploy until the user next opened the app online. The worker was advertising an offline mode it
// did not have.
//
// Deliberately just the entrypoints, not all 283 files in the manifest: the route chunks are 3.5 MB
// and this same worker is installed by every diner who scans a table QR code. What this buys is the
// difference between a white screen and an app that boots and can explain itself — a route whose
// own chunk was never fetched still cannot render, and AppErrorBoundary says so in those words.
async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  try {
    await cache.add('/');
  } catch (_) {
    // Installing while offline. The fetch handler falls back to whatever the previous version
    // left behind; failing the whole install here would leave the app with no worker at all.
  }
  try {
    const res = await fetch('/asset-manifest.json', { cache: 'no-cache' });
    if (!res.ok) return;
    const manifest = await res.json();
    const entrypoints = (manifest.entrypoints || []).map(f => (f.startsWith('/') ? f : `/${f}`));
    // One at a time and individually caught: addAll() rejects as a unit, so a single 404 would
    // throw away the entrypoint that did fetch.
    await Promise.all(entrypoints.map(url => cache.add(url).catch(() => {})));
  } catch (_) {
    // No manifest (offline, or a build that did not emit one). The on-demand branch below still
    // caches these files the first time they are fetched, exactly as before.
  }
}

self.addEventListener('install', event => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
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
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static assets (JS, CSS, images): cache first, fetch on miss
  event.respondWith(
    caches.match(event.request).then(cached => {
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
