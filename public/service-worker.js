const CACHE_NAME = 'crest-v108';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.add('/'))
  );
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
    // Navigation requests: network first, fall back to cached root shell
    event.respondWith(
      fetch(event.request)
        .then(res => {
          const toCache = res.clone(); // clone synchronously before any async op
          caches.open(CACHE_NAME).then(c => c.put(event.request, toCache));
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
          caches.open(CACHE_NAME).then(c => c.put(event.request, toCache));
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
  try { data = event.data ? event.data.json() : {}; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title || 'Crest HR', {
      body: data.body || '',
      icon: '/logo192.png',
      data: { url: data.url || '/hr/self-service' },
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/hr/self-service';
  event.waitUntil(clients.openWindow(url));
});
