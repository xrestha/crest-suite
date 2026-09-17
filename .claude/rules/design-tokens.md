---
paths:
  - "src/index.css"
  - "src/context/ThemeContext.js"
  - "src/context/themeTokenParity.test.js"
  - "src/pages/Settings.js"
  - "DESIGN.md"
  - ".impeccable/config.json"
---

# Theme tokens, presets and the design hook

Split out of `.claude/rules/design-system.md` word for word (S770 context pass, 2026-09-17), so it loads where tokens and presets are defined rather than on every page.

### A file-scoped hook ignore must match the path the HOOK prints, not the file on disk (S763)

The design hook reported two radius findings in `src/modules/pos/guestmenu/GuestMenu.css` — **a file
that does not exist**. The real one is `guestMenu.css`, lowercase, in git and in the `import`; the
hook derives the stylesheet path from the component name (`GuestMenu.jsx` → `GuestMenu.css`), and a
case-insensitive Windows filesystem happily opens the real file under that spelling. It had even
printed the same finding twice, once per casing, which is the tell.

The consequence is quiet and lasting: **S759 had already added ignores for exactly those two values**,
correctly reasoned and correctly scoped — to the real lowercase filename. They never matched, so the
finding was re-raised in every session that touched the guest menu, and each one triaged it again
from scratch. An ignore that does not match is indistinguishable from an ignore nobody wrote.

Two rules:

- **Scope to the DIRECTORY with a wildcard** (`src/modules/pos/guestmenu/**`), not to a basename. It
  is immune to the casing the hook happens to print, and it is what the sanctioned exception actually
  is. (Since S767 that directory's entry is value-specific: `50%` only, for the food mark's dot — the guest pages are square now, so any other corner there is drift.)
- **Never take the per-value form for a file-scoped exception.** `ignore-value design-system-radius
  8px` with no `--file` exempts 8px **product-wide** and quietly defeats the Modernist zero-radius
  rule everywhere. The narrowest ignore is the one scoped to the thing that is genuinely exempt.

After adding one, confirm the finding actually stops — a config entry is not evidence that the
matcher agreed with it.

## A saved theme pins the user to the preset as it was, so a corrected token never ships (S620)

`switchPreset` persists the **full** colours object to `localStorage`, and `loadSaved` merged
`saved.colors` over the preset defaults. That merge existed to protect a snapshot taken before a new
field (e.g. `cardShadow`) was added — but it also meant anyone who had ever picked a theme carried a
frozen copy of it, so **fixing a palette value shipped to new installs only.** Found while
correcting the dark text ladder, which would otherwise have reached almost nobody.

`updateColor` flips the key to `'custom'` the moment anything is changed, so a saved blob under a
**preset** key is always an unedited snapshot — its colours are pure redundancy. Preset keys now
resolve fresh from `PRESETS`, which also subsumes what the merge was written for. Only `'custom'`
still merges, because there the saved values genuinely are the user's own edits.

The corollary for any future palette work: **a token is not shipped until `loadSaved` will hand it
to an existing user.** Check that path before assuming a colour change is live.

## A token lives in four layers and only one of them ships (S627)

`ThemeContext.js`'s `PRESETS` is the only layer a user ever sees. `DESIGN.md`'s **frontmatter** is
the normative machine-readable copy, its **prose** is what a human or an agent actually reads, and
`.impeccable/design.json` is generated from both. A value that moves has to reach all four, or the
lower three describe a product that no longer exists — and because nothing renders from them,
**nothing fails when they are wrong.** That is the whole difficulty: this class of drift has no
symptom.

Found by refreshing the sidecar, not by any audit. S620 swapped `text2`/`text3` in the code and
rewrote the Colors prose but left the **frontmatter** on the pre-swap pairing, so the normative
layer contradicted both the code it describes and its own prose 290 lines below; the sidecar had
inherited the inversion. The same pass found all five `*-text` variants in the sidecar holding
*Light* preset values captured before S608's colour-blindness retune — `redText`/`amberText` still
at the exact ΔE 3.2 pair that retune existed to eliminate — and `accent-ink` holding **purple's**
hex outright.

Two checks whenever a preset value moves:

- **Grep the token name across `DESIGN.md` and confirm frontmatter, prose and `PRESETS` agree.**
  The frontmatter carries the **Dark** default by convention, and on a dark preset every `*-text`
  variant resolves to its own base colour (`applyTheme` does `t.greenText || t.green`) — so a
  variant sharing its base's hex up there is correct, not a redundancy to clean up.
- **Re-run `/impeccable document` so the sidecar is regenerated rather than left describing the
  previous palette.** `context.mjs` reports sidecar staleness, but it only compares timestamps: it
  cannot see a value that is merely wrong, which is how five of them survived two refreshes.

**`/impeccable document` defaults to SIDECAR ONLY (S645), and the full rewrite is the user's call
to make (S662).** Its playbook offers three paths and the destructive one is the default reading: a
full run re-extracts tokens from the code and **rewrites `DESIGN.md`**. That is safe for an
auto-generated file and expensive here, so the command stops and asks. **Answer its stop-and-ask
with "sidecar only" unless the user says otherwise** — the playbook sanctions the narrow path
explicitly (*"If the user only asks to refresh the sidecar, preserve DESIGN.md and write only
`.impeccable/design.json`"*). Present the trade honestly and let them choose; do not refuse the
rewrite, and do not perform it unasked.

Two things make the narrow refresh cheap and safe. **Diff before regenerating**: the sidecar's
`rules` array is extracted more broadly than the `**The X Rule.**` pattern, so a naive re-extract
silently drops the rest — compare and append instead. And **verify `colorMeta` against
`ThemeContext`**, because that is the one check the staleness hint cannot perform and the S627
finding above is exactly what it misses.

**The middle path is usually the right answer, and it now has a name (S668).** Neither of the two
the paragraph above frames: refresh the sidecar, *and* edit `DESIGN.md` surgically wherever the
code has moved past it — no re-extraction, no rewrite. The useful result of running it end to end
was how little there was to do. Every integrity assertion passed: 51/51 frontmatter colours carry a
`colorMeta` entry and 17/17 type roles a `typographyMeta` one, every `canonical` equals its
frontmatter value, every mapped token equals `PRESETS.dark`, the four `*-text` variants plus
`accent-ink` and `focus-outline` all resolve to their dark fallbacks, and the do's, don'ts and key
characteristics were already verbatim-identical to the prose. The entire drift was **one rule the
code had acquired and the file had never been told about**, plus two `typographyMeta` purposes.

**Those checks are now a script: `node scripts/check-design-layers.mjs` (S689).** It asserts every
frontmatter colour has a `colorMeta` entry and that its `canonical` matches, every type role has a
`typographyMeta` entry, every mapped token equals `PRESETS.dark`, that `focus-outline` resolves from
`accentInk` the way `applyTheme` does, and that the radius scale is closed. Written during the
Modernist re-theme — the pass that moved every colour at once and so most needed it — and it caught
a real gap on its first run: a new `button-label` type role with no sidecar entry. Deliberately NOT
in `build:verify`; it reads three files an ordinary feature branch never touches, and a check that
fails for reasons unrelated to your change is one people learn to skip. Run it after any preset move.

**Write those checks as assertions, not as a reading pass.** They run in seconds against
`DESIGN.md`'s frontmatter, the sidecar and `ThemeContext.js`, and they are the only thing that
catches the S627 class of defect at all. A clean pass is worth as much as a find — it is what
tells you the narrow path was sufficient, instead of leaving a rewrite as the only way to be sure.
Assert the counts across the edit too: the sidecar's `rules`, `dos`, `donts`, `colorMeta`,
`typographyMeta`, `shadows`, `motion` and `breakpoints` should come out unchanged except where you
meant to add, which is what proves nothing was silently dropped.

**When a full rewrite IS chosen, the risk is not what it deletes — it is what it silently stops
covering (S662, 2026-08-31, the one time it has been run).** The rewrite went from 1,022 lines to
~900, which was the point; the real damage was in the machine layer, where three omissions each
turned working, deliberate code into apparent drift, and none of them announced itself:

- **The type ramp narrowed from 16 roles to 8.** The frontmatter is what the detector checks a
  literal against, so documenting only the roles a designer reasons in made real *tokenised* sizes
  (`--font-size-micro` 10px, `--font-size-chevron` 9px) read as off-ramp. Keep the complete ramp in
  the frontmatter and the readable subset in the prose — that split is what the spec is for.
- **Whole palettes vanished**: the 13-token print grayscale ramp and the guest menu's 14-token
  bone-and-pine set. Both are real, reused, deliberately theme-independent scales.
- **A sanctioned exception lost its rationale.** The sidebar's `width`/`margin-left` collapse
  animation was recorded in `.impeccable/config.json`'s `ignoreValues`, but the *reason* lived only
  in DESIGN.md — so the config entry survived and the argument did not. (Both entries were
  removed in S691 along with the animation itself: an exemption that no longer exempts anything is
  a claim the next reader has to go and disprove.)

So: after any rewrite, **re-derive coverage rather than re-reading the prose.** Diff the old and new
frontmatter key sets, grep `config.json`'s ignore reasons for `DESIGN.md` and confirm each still has
a home, and check that every frontmatter token has a `colorMeta`/`typographyMeta` entry (a
completeness assertion, not a spot check). The hook found all three of these within minutes of the
rewrite landing, which is the argument for editing a UI file straight afterwards rather than
committing the docs alone.

**`:root` parity is now a test, not a habit** (`src/context/themeTokenParity.test.js`). It asserts
every `--theme-*` in `Layout.css`'s `:root` block equals its `PRESETS.dark` field, and fails if a
preset gains a colour that `:root` never declares. It exists because that block drifted twice
(2026-08-12's `#6b7280`/alpha pair; S620's text2/text3 role swap, live for eleven days) and **the
failure has no symptom** — the wrong values are overwritten milliseconds later, so nothing looks
broken and no other test fails. Verified by re-introducing the S620 inversion and watching three
assertions fail. Adding a colour field to a preset now requires adding it to that test's `TOKEN_OF`
map, which is deliberate: that is where "does `:root` need this too?" gets asked.

## The accent is three tokens, and the Theme tab only offered one of them (S739)

Settings → Theme exposes 10 swatches over a palette of ~20, which is a reasonable editing surface —
but `accentInk`, `accentHover` and `focusRing` all hang off the accent and **both presets author
`accentInk` explicitly**. `updateColor` is handed the RESOLVED colours object, so
`{ ...colors, accent: next }` wrote the PREVIOUS accent's ink into the custom theme as if it had been
chosen: the buttons changed colour and every accent-coloured piece of TEXT — active tab, links, the
⬢ mark, and `--theme-focus-outline`, which resolves from `accentInk` too — stayed the old hue
permanently, with no control anywhere to correct it. Set the accent to green on Modernist Light and
the accent text stays `#7c1405` crimson. That is the One Accent Rule broken by the only control the
product offers for it.

`updateColor` re-derives all three now (`legibleInk`/`hoverOf`/`tintOf`, exported from
`ThemeContext.js` so they are testable over hex). Three things that matter if they are ever retuned:

- **`accentHover` and `focusRing` have NO fallback in `applyTheme`**, unlike the five `*-text`
  variants. Leaving either undefined on a custom theme unsets the CSS variable, and every rule
  reading it then resolves to nothing — a broken hover, not a flat one. A derived token must always
  be written, never deleted.
- **The ink is derived by measurement, not by a fixed darkening step.** `legibleInk(accent, card)`
  mixes toward black (or toward white on a dark card) until the pair clears 4.5:1, and returns the
  accent unchanged when it already does. Verified over real inputs: green on Light 1.88 → 4.71,
  yellow 1.26 → 4.59, navy on Night 1.53 → 4.58. It gives up at pure black/white rather than
  looping, because an accent on a mid-grey card can have no legible version of itself.
- **A derived ink is not as good as an authored one, and the UI says so.** The presets' inks are
  hand-tuned for AA on three grounds AND for red-green colour blindness (S608/S683); a derivation
  only clears the contrast half. `switchPreset` resolves from `PRESETS` and never goes through this
  path, so a preset keeps its authored values — and the Theme tab now states plainly that a custom
  palette is not contrast-checked, with Reset beside it.

**The general shape: a control that edits one token of a derived cluster must re-derive the cluster,
or it leaves the product in a state no other control can reach.** Before adding a swatch, check
`applyTheme` for which tokens fall back and which do not.
