// Asserts that the four layers a design token lives in agree with each other:
//   PRESETS in src/context/ThemeContext.js  (the only layer a user ever sees)
//   DESIGN.md frontmatter                   (the normative machine-readable copy)
//   DESIGN.md prose                         (what a human or an agent actually reads)
//   .impeccable/design.json                 (generated from both)
//
// .claude/rules/design-system.md records why this exists and why it had to become a script: a
// value that moves has to reach all four, nothing RENDERS from the lower three, so nothing fails
// when they are wrong. That class of drift has no symptom. Five wrong values survived two sidecar
// refreshes before anyone diffed them by hand.
//
// Written during the S689 Modernist re-theme, which moved every colour at once — the pass that
// most needed it. It caught one real gap on its first run (a new button-label type role with no
// typographyMeta entry). Run it after ANY preset change:  node scripts/check-design-layers.mjs
//
// Deliberately NOT wired into build:verify. It reads three files that a normal feature branch
// never touches, and a check that fails for reasons unrelated to your change is a check people
// learn to skip.

// The four-layer integrity check from .claude/rules/design-system.md, written as assertions rather
// than as a reading pass. A clean run is what says the narrow path was sufficient; without it the
// only way to be sure is a full rewrite.
import fs from 'fs';

const md = fs.readFileSync('DESIGN.md', 'utf8').replace(/\r\n/g, '\n');
const fm = md.slice(4, md.indexOf('\n---', 4));
const side = JSON.parse(fs.readFileSync('.impeccable/design.json', 'utf8'));
const ctx = fs.readFileSync('src/context/ThemeContext.js', 'utf8');

const fail = [];
const ok = [];

// --- 1. every frontmatter colour has a colorMeta entry, and canonical agrees -------------------
const colorsBlock = fm.slice(fm.indexOf('colors:'), fm.indexOf('typography:'));
const fmColors = [...colorsBlock.matchAll(/^ {2}([a-z0-9-]+): "([^"]+)"/gm)].map(m => [m[1], m[2]]);
const cm = side.extensions.colorMeta;
let missing = 0, mismatched = 0;
for (const [k, v] of fmColors) {
  if (!cm[k]) { missing++; continue; }
  if (cm[k].canonical !== v) { mismatched++; fail.push(`colorMeta.${k}.canonical ${cm[k].canonical} != frontmatter ${v}`); }
}
missing === 0 ? ok.push(`${fmColors.length}/${fmColors.length} frontmatter colours carry a colorMeta entry`)
              : fail.push(`${missing} frontmatter colours have no colorMeta entry`);
if (!mismatched) ok.push('every colorMeta.canonical equals its frontmatter value');

// --- 2. every frontmatter type role has a typographyMeta entry ---------------------------------
const typoBlock = fm.slice(fm.indexOf('typography:'), fm.indexOf('rounded:'));
const fmTypes = [...typoBlock.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map(m => m[1]);
const tm = side.extensions.typographyMeta;
const tMissing = fmTypes.filter(t => !tm[t]);
tMissing.length === 0 ? ok.push(`${fmTypes.length}/${fmTypes.length} type roles carry a typographyMeta entry`)
                      : fail.push(`typographyMeta missing: ${tMissing.join(', ')}`);

// --- 3. every mapped token equals PRESETS.dark ------------------------------------------------
const darkBlock = ctx.slice(ctx.indexOf('  dark: {'), ctx.indexOf('  light: {'));
const preset = Object.fromEntries([...darkBlock.matchAll(/(\w+): '([^']+)'/g)].map(m => [m[1], m[2]]));
const MAP = {
  'accent-red': 'accent', 'accent-red-hover': 'accentHover', 'accent-text': 'accentText',
  'accent-ink': 'accentInk', 'ink-bg': 'bg', 'ink-card': 'card', 'ink-sidebar': 'sidebar',
  'ink-border': 'border', 'ink-border-lt': 'borderLt', 'input-bg': 'inputBg',
  'table-hover': 'tableHover', 'focus-ring': 'focusRing',
  'text-primary': 'text1', 'text-secondary': 'text2', 'text-tertiary': 'text3',
  'signal-success': 'green', 'signal-danger': 'red', 'signal-warning': 'amber', 'signal-categorical': 'purple',
};
const fmMap = Object.fromEntries(fmColors);
let drift = 0;
for (const [tok, key] of Object.entries(MAP)) {
  if (fmMap[tok] !== preset[key]) { drift++; fail.push(`${tok}: DESIGN.md ${fmMap[tok]} != PRESETS.dark.${key} ${preset[key]}`); }
}
if (!drift) ok.push(`${Object.keys(MAP).length}/${Object.keys(MAP).length} mapped tokens equal PRESETS.dark`);

// --- 4. focus-outline resolves from accentInk, as ThemeContext does ---------------------------
fmMap['focus-outline'] === preset.accentInk
  ? ok.push('focus-outline resolves from accentInk, matching applyTheme')
  : fail.push(`focus-outline ${fmMap['focus-outline']} != accentInk ${preset.accentInk}`);

// --- 5. the radius scale really is closed at zero ---------------------------------------------
const roundedBlock = fm.slice(fm.indexOf('rounded:'), fm.indexOf('spacing:'));
const radii = [...roundedBlock.matchAll(/^ {2}(\w+): "([^"]+)"/gm)].map(m => m[2]);
radii.every(r => r === '0')
  ? ok.push(`radius scale closed at 0 (${radii.length} steps)`)
  : fail.push(`non-zero radius steps in frontmatter: ${radii.filter(r => r !== '0').join(', ')}`);

console.log('PASS');
for (const o of ok) console.log('  ✓ ' + o);
if (fail.length) {
  console.log('FAIL');
  for (const f of fail) console.log('  ✗ ' + f);
  process.exit(1);
}
