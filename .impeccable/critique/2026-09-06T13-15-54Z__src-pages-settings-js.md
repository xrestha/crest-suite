---
target: admin-settings-support tab
total_score: 22
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-09-06T13-15-54Z
slug: src-pages-settings-js
---
# Admin → Settings → Support — critique

Method: dual-agent (A: source-only design review · B: detector + live browser measurement, signed-in admin, Dark live + Light via token override, 1280 and 390). Parent re-verified the reseed path, the missing `.form-grid` media rule, and the checkbox stylesheet rule.

## Design Health Score — 22/40 (Acceptable)

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Header "✓ Saved" after a save that reverted the top card; disabled select signalled only by border 1.27→1.08:1 |
| 2 | Match System / Real World | 3 | "Blank keeps the legal support address" leaks an internal term |
| 3 | User Control and Freedom | 1 | No cancel/reset/dirty guard; header Save and client switch both wipe unsaved top-card edits (Settings.js:69 ← SettingsContext.js:148) |
| 4 | Consistency and Standards | 2 | Two btn-primary; checkbox stretched to 454×13 by `.form-field input{width:100%}` (Layout.css:2036); tab strip lacks tablist semantics |
| 5 | Error Prevention | 2 | Emergency select guards excellent; no shape check on 7 fields, no confirm before shipping to 8 surfaces |
| 6 | Recognition Rather Than Recall | 3 | Which Save saves which card is learnable only from two paragraphs |
| 7 | Flexibility and Efficiency | 1 | No <form>/Enter; ~17 tab stops (Tip spans); Data/Theme/Guides tabs unreachable at 390px |
| 8 | Aesthetic and Minimalist Design | 2 | Floor number ×4 on one card; checkbox row visually broken; 141-char intro lines |
| 9 | Error Recovery | 3 | errorLine() output with role=alert; bare span rather than ActionError |
| 10 | Help and Documentation | 3 | Field help strong; no explanation of two-save mechanics; no link to Help → Support |
| **Total** | | **22/40** | **Acceptable** |

## Design Specificity Verdict
Authored for Crest in the copy layer (consequence-naming hints, preview = shipping component via resolveSupportContact); generic in the structural layer (same inline h3/card/grid/tab-strip skeleton as the other nine tabs, brass spent twice). Detector: 0 findings in Settings.js + SupportContactLine.jsx. In-page detector: 26 messages; in-scope: 12 tiny-text (11px hints — false positive, 5.45:1 measured), 2 line-length ~141ch (real), all-caps-body h3, em-dash-overuse (12), skipped-heading h1→h3.

## Priority Issues
- **[P1] Header "Save Changes" reverts the top card's unsaved edits and confirms success.** saveSettings → loadSettings → setPlatformSupport → effect Settings.js:69 reseeds platformForm. Client switch (Settings.js:73) does the same and the empty state tells you to do it. Nearest Save to consultant fields is the wrong one (243px vs 1345px). Fix: seed only on value change / block reseed while dirty; drop header Save on this tab; give the consultant card its own Save. `/impeccable harden`
- **[P1] Emergency checkbox renders as a 454×13 strip, label wraps five lines.** `.form-field input { width:100%; padding:9px 12px }` matches type=checkbox; no checkbox rule anywhere. Both presets. Fix: `.form-check` / `input[type=checkbox]{width:auto;padding:0}` globally, then grep other .form-field checkboxes. `/impeccable polish`
- **[P1] No phone layout.** `.form-grid-2` never collapses (145px columns, placeholders clipped); tab strip scrollWidth 639 in 358px, Data/Theme/Guides outside viewport, unclickable. Fix: collapse rule in the 768 block; `.panel-tab` + tablist as Help.js. `/impeccable adapt`
- **[P2] Copy contradicts layout and admin tab set.** "Save button below" (832) is above; subtitle names Thresholds (not in ADMIN_TABS); floor mobile ×4. `/impeccable clarify`
- **[P2] Keyboard/SR path.** Busy button `disabled` drops focus; select's aria-label dead under aria-labelledby (measured name "Outlet-down emergencies"); Tip spans are tab stops; checkbox announced without subject. `/impeccable harden`

## Persona Red Flags
- Sam: ~17 tab stops to Save; checkbox announced with no subject; focus ring spans full column; no aria-selected on tabs.
- Casey: 145px columns, clipped placeholders, three tabs off-screen, primary Save at top of 2100px page.
- Riley: header Save reverts top card under a green tick; "abc" in Mobile ships to the crash page unwarned.
- Crest operator, first open: blank boxes, preview already shows personal mobile + any-time promise; no "done" state; no way to remove the floor number without a deploy.

## Minor Observations
- All text tiers pass AA both presets (hints 5.45/5.76 on card; caption 6.04/5.20 on ground).
- Preview box bg == page ground in both presets (input-well colour on Dark).
- Classless consultant inputs render identically (`.form-field input`).
- "— pick a client first" duplicates the paragraph.
- Email prefilled from legacy contact_email while Mobile blank; unexplained.
- emergency_enabled default true: on-state hint should say the promise is live for every client.

## Questions to Consider
- Why a page-level Save on a tab that edits two rows?
- What is the exit path for the founder's number, and should "no phone" be expressible?
- Would a saved/unsaved distinction in the preview remove the need to explain two Saves?
