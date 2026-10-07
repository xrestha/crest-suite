// The badge class for a staff member's ACCESS LEVEL, shared by all three staff screens.
//
// Access level is a CATEGORICAL axis, not a status one — a Supervisor is not a "warning" and a
// Staff account is not "healthy". All three levels therefore use `badge-gray`, the category chip,
// and the rank itself is carried by the label text, which is what a reader actually needs. Signal
// green/amber stay reserved for real status.
//
// Until S804 this was `badge-yellow`, the accent-tinted category tag. Since S689 the accent is red
// on both Modernist presets, so every rank on every staff screen sat in the colour of a refused
// request. IMS had already moved its categories to grey (S796) and missed this file because it is
// shared; HR moved in S804 and took IMS and POS with it, by owner decision, since the point of the
// file is that the three cannot disagree.
//
// It lives here because the identical decision was made three times independently and drifted.
// HR settled it first; POS was still on the old green/amber/brass ladder eighteen sessions later
// (fixed S661) and IMS eighteen sessions after that (S661 follow-up) — so on one product, a
// Supervisor was simultaneously amber in two modules and brass in the third, and amber is what
// those same modules use for "needs attention". Nothing failed; three files simply had to be
// remembered together and were not. A fourth module gets this for free.
//
// The parallel is `src/shared/operatingBands.js` (S660): one definition for a thing several
// surfaces render, because a colour decision made twice is a colour decision that will be made a
// third way.
export const STAFF_LEVEL_BADGE = { staff: 'badge-gray', supervisor: 'badge-gray', manager: 'badge-gray' }

// The fallback for a level this map does not know. Since S804 it matches the ranks; the label
// beside it is what says what it is.
export const STAFF_LEVEL_BADGE_NONE = 'badge-gray'
