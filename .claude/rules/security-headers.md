---
paths:
  - "vercel.json"
  - "public/service-worker.js"
  - "public/index.html"
  - "src/utils/usdaNutrition.js"
  - "src/index.js"
---

# Security headers and Content-Security-Policy

Migrated from the root `CLAUDE.md` (S663). The one rule that stays resident there is that
**adding any new third-party API call requires adding its origin to `connect-src`, or it fails
silently in production and works fine in dev.** Everything below is the reasoning behind the
header set, which lives in `vercel.json` and cannot be commented in place.
**Security headers live in `vercel.json`, and that file cannot carry comments** — it is strict JSON validated against Vercel's schema, which rejects any unknown property, so the usual `"//": "why"` trick fails the *build* rather than being ignored (found the hard way: the first deploy of these headers errored with ``headers[1].headers[0]` should NOT have additional property `//``). The rationale therefore lives here:

- **`script-src 'self'` with no `'unsafe-inline'`** is only viable because the production build emits a single external `<script src=/static/js/main.*.js>` and no inline runtime chunk — verified against real build output, and re-checkable with `grep -o "<script[^>]*>" build/index.html`. If a future CRA/webpack change starts inlining the runtime, every page will fail to boot with a CSP violation in the console; the fix is `INLINE_RUNTIME_CHUNK=false`, **not** adding `'unsafe-inline'` back.
- **`style-src` does allow inline**: the Google Fonts stylesheet is an external `<link>`, and chart/UI libraries inject `<style>` elements at runtime. React's own `style={{}}` prop sets CSSOM properties directly and is not subject to CSP at all.
- **`X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`, not `DENY`/`'none'` (corrected S604).** Both shipped at their strictest in the S531 review, and `DENY` blocks framing *including same-origin* — which silently killed **Admin → Guest Menu Preview**, whose whole design is an `<iframe src>` of the real public route so the preview is byte-for-byte what a guest sees rather than a second component to keep in sync. It had never worked in production and nobody knew, because `vercel.json` headers do not apply to the CRA dev server: on localhost the preview renders perfectly, so every review of that page passed. **Anything verified only on `npm start` is unverified against the header stack** — reach for `curl -I` on the deployed URL. The relaxation is deliberate and small: `'self'` permits only our own origin to frame us, and clickjacking requires an *attacker-controlled* framing page, which `'self'` grants nobody. An attacker who could serve a page from our origin already has XSS, at which point framing is moot. Both keys had to move together — modern browsers prefer `frame-ancestors` and older ones honour `X-Frame-Options`, so leaving either at its strictest keeps the frame blocked. Note this does **not** affect `PosOrders.jsx`'s bill-preview iframe, which uses `srcDoc` (no HTTP response, so neither header is consulted) and is instead governed by the parent's `style-src 'unsafe-inline'`.
- **`connect-src` is the control that matters most** — it is the exfiltration boundary. Supabase (REST + realtime websocket + storage) plus the two nutrition APIs (`usdaNutrition.js`, `NutritionEditorModal.jsx`), and nothing else. `wa.me` is only ever a navigation target, never fetched, so it needs no entry. **Adding any new third-party API call requires adding its origin here or it fails silently in production and works fine in dev.**
- The print/KOT windows are unaffected: their templates are script-free, and `w.print()` is called from the *opener*, not from inline script in the written document.
- **A service worker inherits the CSP served with its own script**, so `public/service-worker.js` is bound by the same `connect-src` — any `fetch()` it makes to an origin not on that list is blocked. Combined with `cache.put()` rejecting on opaque cross-origin responses, that made intercepting third-party requests strictly lose-lose, so the fetch handler now returns early on `url.origin !== self.location.origin` (which also subsumes the older Supabase-specific skip). Don't reintroduce cross-origin handling there.
