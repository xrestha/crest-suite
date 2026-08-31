// The badge class for a staff member's ACCESS LEVEL, shared by all three staff screens.
//
// Access level is a CATEGORICAL axis, not a status one — a Supervisor is not a "warning" and a
// Staff account is not "healthy". All three levels therefore use `badge-yellow`, the accent-tinted
// categorical tag (the same treatment the Department tag on HR Employees uses); the rank itself is
// carried by the label text, which is what a reader actually needs. Signal green/amber stay
// reserved for real status.
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
export const STAFF_LEVEL_BADGE = { staff: 'badge-yellow', supervisor: 'badge-yellow', manager: 'badge-yellow' }

// The fallback for an account with no level on that module at all — no access is genuinely inert,
// which is the one thing on this axis that is not a peer of the others.
export const STAFF_LEVEL_BADGE_NONE = 'badge-gray'
