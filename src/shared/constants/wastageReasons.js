// The reason vocabulary for the IMS Daily Wastage log — the ONE definition (S726).
//
// `wastages.reason` is free text with no CHECK constraint, and the Wastage Report's By-Reason
// breakdown builds its groups from whatever strings come back. So this list is not enforced
// anywhere: it is the only thing standing between the report and a pile of near-duplicate
// spellings. Adding an option needs no migration; RENAMING one orphans every row already written
// under the old string, which will then sit beside the new one in the report forever.
//
// The reasons are chosen for what they imply the operator should DO — a fridge failure, a burnt
// pan and a mis-keyed order all end as discarded food, but the fix is a repair, a training session
// and a POS habit respectively. A reason that does not change anybody's next action is noise.
//
// Two exclusions are deliberate and must stay excluded, because both would deduct the same stock
// twice: STAFF MEALS (their own table and tab; computeUsed() already subtracts them separately)
// and SUPPLIER RETURNS (already netted inside Net Purchases). A generic "stock adjustment" is
// excluded for a different reason — it turns wastage into a fudge factor for forcing a physical
// count to tie, which is the exact signal Variance and Shrinkage exist to catch.

export const WASTAGE_REASON_GROUPS = [
  {
    group: 'Storage & shelf life',
    reasons: ['Spoilage', 'Expiry', 'Power / equipment failure', 'Contamination'],
  },
  {
    group: 'Kitchen & prep',
    // "Trim / prep loss" is knife yield — peeling, deboning, portioning. "Remnants / crumbs" is the
    // unsellable last of a pack or batch (bread heels, nacho dust). Different causes, different fixes.
    reasons: ['Over-prep', 'Trim / prep loss', 'Remnants / crumbs', 'Cooking error', 'Recipe testing', 'Staff training'],
  },
  {
    group: 'Damage & handling',
    reasons: ['Breakage', 'Spillage'],
  },
  {
    group: 'Supplier & receiving',
    // The vendor-attributable bucket: these are the rows worth taking to a supplier conversation.
    reasons: ['Damaged on delivery', 'Quality reject'],
  },
  {
    group: 'Service & floor',
    // "Wrong order" is the kitchen firing the wrong thing; "Customer return" is the guest rejecting
    // the right thing. Same bin, different conversation.
    reasons: ['Customer return', 'Wrong order', 'Sampling / giveaway'],
  },
  {
    group: 'Loss & other',
    // Logging theft here moves it OUT of the unexplained gap ShrinkageReport measures — which is the
    // more honest figure, and why that report's copy says "unlogged theft".
    reasons: ['Theft / pilferage', 'Other'],
  },
]

// Flat list, in group order. For prose, counts, and anything that does not render the headings.
export const WASTAGE_REASONS = WASTAGE_REASON_GROUPS.flatMap(g => g.reasons)

// Stock.js uses this for both the initial form value and the insert fallback, so a null reason and
// an untouched dropdown agree. It must remain a member of WASTAGE_REASONS — the test asserts it.
export const DEFAULT_WASTAGE_REASON = 'Other'
