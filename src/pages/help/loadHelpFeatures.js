// The Module Guide's five feature lists, fetched as chunks of their own (PERF-9, S876).
//
// Help.js was ~538 KB, and ~430 KB of it was these lists, which only the Module Guide tab and the
// search box read. Getting Started, the tab /help opens on, needs none of them, so the page now
// paints first and fetches them when the Module Guide opens, when the search box is used, or once
// the browser is idle after the first paint, whichever comes first.
//
// One promise per page load, shared by every caller, so the five files are requested once however
// many of those fire. A failed fetch (offline, or a deploy that replaced the files) clears it, so the
// next call (the page's Try again) asks again rather than replaying the same failure. Nothing eager
// may import the list files directly, or they ride back into the bundle: loadHelpFeatures.test.js
// checks every source file for a static import of them.
let pending = null
let loaded = null

export function loadHelpFeatures() {
  if (!pending) {
    const request = Promise.all([
      import('./imsFeatures'),
      import('./suiteFeatures'),
      import('./hrFeatures'),
      import('./posFeatures'),
      import('./adminFeatures'),
    ]).then(([ims, suite, hr, pos, admin]) => {
      loaded = {
        IMS_FEATURES: ims.IMS_FEATURES,
        IMS_FEATURE_TIERS: ims.IMS_FEATURE_TIERS,
        SUITE_FEATURES: suite.SUITE_FEATURES,
        HR_FEATURES: hr.HR_FEATURES,
        POS_FEATURES: pos.POS_FEATURES,
        ADMIN_FEATURES: admin.ADMIN_FEATURES,
      }
      return loaded
    })
    pending = request
    // Attached first, so it has run before any caller's own failure handler does.
    request.catch(() => { pending = null })
  }
  return pending
}

// The lists if they have already arrived, else null. A second visit to /help in the same session
// starts with them in hand instead of showing the loading line for a frame.
export function loadedHelpFeatures() {
  return loaded
}
