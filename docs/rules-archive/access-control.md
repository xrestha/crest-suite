# access-control.md: archived sections

Moved word for word out of .claude/rules/access-control.md in S849 (2026-10-19), to make room for the Suite paywall rule without raising the pages load. This is history and is not auto-loaded: no rules glob matches docs/. The live rule stays in the rules file with a pointer here. Line numbers refer to the rules file before the move.

---

## S683 four gates

_Original lines 258–301 (Four gates, one grammar for "you cannot have this"):_

The critique found four gates with four grammars. `ModuleGate` was three silent
`<Navigate to="/dashboard">` — a client whose HR lapsed clicked HR, landed on the dashboard and was
told nothing. `SuiteGate`'s module-missing card said "Contact your consultant" with no phone, no
email and no link, the only gate not on `useSupportContact()`. `PremiumGate` headlined the PLAN
("Growth Plan Required") and buried the feature the reader had just clicked in a ten-item
paragraph, then offered no way to plans at all. And every upsell CTA went to `/pricing`, which is
declared OUTSIDE `ProtectedRoute` and read no session — a signed-in Growth supervisor landed on a
signed-out marketing page showing "Login →" and "Start Free Trial →".

What holds now, and why each piece is where it is:

- **`ModuleMissingCard`** (`src/components/ModuleMissingCard.jsx`) is what both `ModuleGate` (module
  off) and `SuiteGate` (required module missing) render, in place, inside the shell. It names the
  module, says the data is untouched, and gives the OWNER the `SupportContactLine` buttons — while
  a staff login, who cannot buy anything, is told who can. The one branch that still redirects is
  the station-team one (`STATION_TEAM_HOME`): a kitchen tablet landing on a card is worse than a
  kitchen tablet landing on the KDS.
- **`PremiumGate` names the feature** through `FEATURE_LABELS` in `src/shared/featureCatalog.js` —
  the tier grid moved OUT of `FeatureAccessModal.js` into a data-only file because importing the
  admin modal for its constant would drag it into the main bundle. The "also adds" sentence is
  derived from the same catalog rather than the hand-typed list that had drifted from the grid
  twice. `featureCatalog.test.js` reads `App.js` and `Layout.js` and fails on any routed or
  navigated `featureKey` with no label, so the plan-only headline can never come back for a real
  route.
- **The buyer is the audience for a pitch.** The upgrade teaser and footer chip render for `isOwner`
  only — and since the top-bar move they render in two different places: the full teaser stays in the
  phone drawer, while on desktop the same facts are one row in the account menu (tier name + locked
  count), both computed from the one `upgrade` object in `Layout.js` so they cannot disagree.
  `SuiteGate` and `PremiumGate` show "View plans →" and the contact block to an
  owner and one sentence — *it is switched on for the whole outlet, not per login — ask the account
  owner* — to anyone else. A CTA whose reader cannot act on it is noise where a manager needs the
  nav.
- **`/pricing` reads the session.** Signed in, "Login →" becomes "Back to Crest →", every "Get X" /
  "Add X" / "Start Free Trial" becomes "Ask about X" (a `mailto:` with the plan in the subject), and
  the closing banner asks what to switch on instead of selling a trial to a paying customer. It
  stays outside `ProtectedRoute` on purpose — a visitor must still be able to read it.

The last piece of the same finding — `SUPPORT_PHONE_RAW`, the one unfilled `[[NEEDS VALUE]]` in
the product, which left every one of these surfaces showing email only — closed later in S683 by
making the contact DATA: `settings.support_contact` on the platform row, edited in Settings →
Support, with the founder's mobile as the constant floor. See `support-contact.md`.
