# Critique ignore list

Findings recorded here are **settled design decisions**, not open defects. `/impeccable critique`
reads this file during setup and drops matching findings silently.

An entry belongs here only when the owner has looked at the finding and decided the current
behaviour is what they want. It is not a place to park work that is merely deferred — a deferred
item stays in the snapshot under `.impeccable/critique/` so it keeps showing up until it is done.

---

## Locked nav items are hidden, not shown with an upgrade chip

**Decided:** 2026-09-16, by the owner, during the `src/modules/ims` critique (snapshot
`2026-09-16T07-48-04Z__src-modules-ims.md`).

**The finding, as it will be re-found.** `isItemVisible()` in `src/components/Layout.js` drops any
nav item whose `featureKey` fails `hasFeature()`, and `renderGroup` then returns `null` for a group
left empty. On a Starter client this removes ~22 of ~40 IMS destinations: **Costing** collapses to
Menu Pricing alone, **Stock Reports** to Wastage Report alone, and **Menu & Vendors** disappears
entirely. `PremiumGate.js` — a written upsell screen with the feature name, the "and N more" list,
the consultant's phone number and a View plans button — is consequently reachable only by typing
the URL, because the command palette filters through the same `isItemVisible`.

A critique will surface this as an inconsistency, because the **Crest Suite** group two hundred
lines below does the opposite: it stays visible for a client who has not bought Suite, carries a
`PRO` chip, and lets `SuiteGate` render an inline upsell in place. The comment there states the
reason in as many words — "a `featureKey` would make the row DISAPPEAR instead of upselling."

**Why it is not a defect.** The two behaviours are deliberately different, and the difference is
what is being sold. Suite is a single add-on sold at owner altitude, so one visible chipped row is
an offer. The plan ladder is ~22 rows across four groups, and showing all of them to a Starter
client is a wall of padlocks on every dropdown they open — the owner's call is that this reads as
a crippled product rather than as an invitation. Hiding is the intended behaviour.

**Do not re-raise** the hiding itself, the empty/collapsed groups that follow from it, or
`PremiumGate`'s unreachability-by-nav. If a future critique finds that a *group label* has become
actively misleading for a tier (a group named "Costing" whose only surviving member is a price
list), that is a labelling question and may be raised as such — but the visibility mechanism is
settled.
