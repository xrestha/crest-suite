#!/usr/bin/env node
// T2a — The route table, generated, and the plan-lock check it exists for (S879).
//
// WHY GENERATED
// -------------
// The old README route table was hand-written and rotted: no HR routes, no Group Console, no kitchen
// board, no guest menu. A hand-kept table is a value that moves, embedded in a permanent document.
// So ROUTES.md is written by this script from the three files that actually decide access, and
// `--check` (the default) fails when the committed file differs from what the code says today.
//
// THE CHECK IS WORTH MORE THAN THE TABLE
// --------------------------------------
// A plan-gated feature is written in three places (CLAUDE.md, "three edits in one change"):
//   1. its key's set in src/context/AuthContext.js (STARTER_KEYS / GROWTH_KEYS / PRO_KEYS), which is
//      what hasFeature() and therefore the MENU's visibility read;
//   2. `minPlan` on its PremiumGate in src/App.js, which is what the ROUTE lets through
//      (PremiumGate passes on plan rank >= minPlan OR hasFeature(key));
//   3. `minPlan` on its nav item in src/components/Layout.js, which is what the lock badge and the
//      upgrade teaser read.
// When they disagree, a page is reachable but hidden, or visible but blocked, and nothing failed
// loudly. This script fails on every such disagreement, and on a menu link to a route that does
// not exist. It is a text parser over three known files, not a JS evaluator: if one of them changes
// shape so that it cannot find what it needs, it fails and says which file, rather than passing.
//
// Usage: `node scripts/check-routes.mjs` checks (run by check:docs and build:verify);
//        `node scripts/check-routes.mjs --write` (npm run routes:write) rewrites ROUTES.md.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const APP = 'src/App.js'
const LAYOUT = 'src/components/Layout.js'
const AUTH = 'src/context/AuthContext.js'
const OUT = 'ROUTES.md'
const WRITE = process.argv.includes('--write')

const read = rel => readFileSync(join(root, rel), 'utf8')
const lineOf = (src, index) => src.slice(0, index).split('\n').length
const shapeError = (file, what) => {
  console.error(`check-routes: could not find ${what} in ${file}. The file changed shape; update scripts/check-routes.mjs.`)
  process.exit(1)
}

const TIERS = ['starter', 'growth', 'pro']
const TIER_LABEL = { starter: 'Starter', growth: 'Growth', pro: 'Pro', suite: 'Suite Pro', pos: 'POS module' }

// ── 1. The plan lists (AuthContext.js) ──────────────────────────────────────
function readKeySets(src) {
  const tierOf = {}
  const sets = [['STARTER_KEYS', 'starter'], ['GROWTH_KEYS', 'growth'], ['PRO_KEYS', 'pro'],
    ['SUITE_KEYS', 'suite'], ['POS_MODULE_KEYS', 'pos']]
  for (const [name, tier] of sets) {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
    if (!m) shapeError(AUTH, name)
    // Comments inside the sets quote other keys while explaining a move; only code counts.
    const body = m[1].replace(/\/\/.*$/gm, '')
    for (const [, key] of body.matchAll(/'([a-z0-9_]+)'/g)) {
      if (tierOf[key]) {
        console.error(`check-routes: '${key}' is in two plan lists in ${AUTH} (${tierOf[key]} and ${tier}).`)
        process.exit(1)
      }
      tierOf[key] = tier
    }
  }
  return tierOf
}

// ── 2. The routes (App.js) ──────────────────────────────────────────────────
const GATES = new Set(['Route', 'ModuleGate', 'PremiumGate', 'ProtectedRoute', 'TillOutletGate', 'Layout'])

function readRoutes(raw) {
  // Blank JSX comments (keeping line breaks) so a brace or a <Route inside one cannot mislead the scan.
  const src = raw.replace(/\{\/\*[\s\S]*?\*\/\}/g, m => m.replace(/[^\n]/g, ' '))
  const layoutAt = src.indexOf('<Route element={<ProtectedRoute><Layout />')
  if (layoutAt < 0) shapeError(APP, 'the signed-in Layout route')
  const routes = []
  for (const start of [...src.matchAll(/<Route\s/g)].map(m => m.index)) {
    // The opening tag ends at the first '>' outside any {…}, which skips the JSX inside element={…}.
    let depth = 0, end = start + 6
    for (; end < src.length; end++) {
      const c = src[end]
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) break
    }
    const tag = src.slice(start, end + 1)
    const path = tag.match(/\bpath="([^"]+)"/)?.[1]
    if (!path) continue
    const r = { path, line: lineOf(src, start), signedIn: start > layoutAt }
    const mod = tag.match(/<ModuleGate module="(\w+)"/)?.[1]
    const anyOf = tag.match(/<ModuleGate anyOf=\{\[([^\]]*)\]\}/)?.[1]
    r.module = mod || (anyOf ? anyOf.replace(/['\s]/g, '').split(',').join('|') : null)
    const premium = tag.match(/<PremiumGate\b([^>]*)>/)?.[1]
    if (premium) {
      r.featureKey = premium.match(/featureKey="(\w+)"/)?.[1] || null
      // PremiumGate's own default when minPlan is left off.
      r.minPlan = premium.match(/minPlan="(\w+)"/)?.[1] || 'growth'
    }
    r.adminOnly = /<ProtectedRoute adminOnly/.test(tag)
    r.tillGate = /<TillOutletGate>/.test(tag)
    r.redirect = tag.match(/<Navigate to="([^"]+)"/)?.[1] || null
    r.page = [...tag.matchAll(/<([A-Z]\w*)/g)].map(m => m[1]).find(n => !GATES.has(n) && n !== 'Navigate') || null
    routes.push(r)
  }
  if (routes.length < 20) shapeError(APP, 'the <Route> list')
  return routes
}

// ── 3. The menu (Layout.js) ─────────────────────────────────────────────────
const SECTION = {
  NAV: 'IMS', REPORTS: 'IMS reports', IMS_GROUPS: 'IMS', IMS_DASHBOARD: 'IMS', SUITE_NAV: 'Crest Suite',
  HR_GROUPS: 'HR', HR_DASHBOARD: 'HR', POS_GROUPS: 'POS', POS_DASHBOARD: 'POS',
  CUSTOMIZATION_GROUPS: 'Customization',
}

function resolveConst(layoutSrc, name) {
  const local = layoutSrc.match(new RegExp(`const ${name} = '([^']+)'`))
  if (local) return local[1]
  const imp = [...layoutSrc.matchAll(/import \{([^}]*)\} from '(\.[^']+)'/g)]
    .find(m => m[1].split(',').map(s => s.trim()).includes(name))
  if (imp) {
    const file = join('src/components', imp[2]).replace(/\\/g, '/') + '.js'
    if (existsSync(join(root, file))) {
      const v = read(file).match(new RegExp(`export const ${name} = '([^']+)'`))
      if (v) return v[1]
    }
  }
  shapeError(LAYOUT, `the value of ${name}`)
}

function readNav(src) {
  const componentAt = src.indexOf('export default function Layout(')
  if (componentAt < 0) shapeError(LAYOUT, 'the Layout component')
  const consts = [...src.matchAll(/^const ([A-Z_]+) = /gm)].map(m => ({ name: m[1], at: m.index }))
  const items = []
  for (const m of src.matchAll(/\{\s*to:\s*('([^']+)'|([A-Z_]+))\s*,([^{}]*)\}/g)) {
    const props = m[4]
    if (!/label:/.test(props)) continue // a palette action such as `home: () => ({ to: … })`
    const to = m[2] || resolveConst(src, m[3])
    const pick = re => props.match(re)?.[1] || null
    const owner = m.index < componentAt
      ? consts.filter(c => c.at < m.index).pop()?.name
      : null
    items.push({
      to,
      line: lineOf(src, m.index),
      label: pick(/label: '([^']+)'/),
      // Links drawn inside the component (the operator panel, Settings) carry their condition in
      // the JSX around them, which a text parser cannot read, so the table says so.
      section: owner ? (SECTION[owner] || owner) : 'Shell',
      inShell: !owner,
      suite: owner === 'SUITE_NAV',
      featureKey: pick(/featureKey: '(\w+)'/),
      minPlan: pick(/minPlan: '(\w+)'/),
      ims: pick(/minImsRole: '(\w+)'/),
      pos: pick(/minPosRole: '(\w+)'/),
      hr: pick(/minHrRole: '(\w+)'/),
      ownerOnly: /ownerOnly: true/.test(props),
      menuPricing: /menuPricingAccess: true/.test(props),
      needsGroup: /needsGroup: true/.test(props),
    })
  }
  if (items.length < 20) shapeError(LAYOUT, 'the nav item lists')
  return items
}

// ── The mismatch check ──────────────────────────────────────────────────────
function findMismatches(routes, nav, tierOf) {
  const out = []
  const routeAt = new Map(routes.map(r => [r.path, r]))
  const say = (where, text) => out.push(`${where}: ${text}`)

  for (const r of routes.filter(x => x.featureKey !== undefined)) {
    const at = `${APP}:${r.line} ${r.path}`
    const tier = tierOf[r.featureKey]
    if (!r.featureKey) say(at, 'PremiumGate has no featureKey.')
    else if (!tier) say(at, `feature key '${r.featureKey}' is in no plan list in ${AUTH}.`)
    else if (!TIERS.includes(tier)) say(at, `PremiumGate on '${r.featureKey}', a ${TIER_LABEL[tier]} key; that axis has its own gate.`)
    else if (tier !== r.minPlan) say(at, `the page asks for ${TIER_LABEL[r.minPlan]}, but '${r.featureKey}' is in the ${TIER_LABEL[tier]} list.`)
  }

  for (const n of nav) {
    const at = `${LAYOUT}:${n.line} ${n.to}`
    const r = routeAt.get(n.to)
    if (!r) { say(at, `the menu links "${n.label}" to a page that does not exist in ${APP}.`); continue }
    if (n.suite && (n.featureKey || n.minPlan)) say(at, 'a Crest Suite menu item carries a featureKey or minPlan; SuiteGate sells it in place.')
    if (n.minPlan && !n.featureKey) say(at, `the menu shows a ${TIER_LABEL[n.minPlan] || n.minPlan} lock with no featureKey behind it.`)
    if (n.featureKey) {
      const tier = tierOf[n.featureKey]
      const menuPlan = n.minPlan || 'starter'
      if (!tier) say(at, `feature key '${n.featureKey}' is in no plan list in ${AUTH}.`)
      else if (TIERS.includes(tier) && tier !== menuPlan) {
        say(at, `the menu shows ${TIER_LABEL[menuPlan]}${n.minPlan ? '' : ' (no minPlan)'}, but '${n.featureKey}' is in the ${TIER_LABEL[tier]} list.`)
      }
      if (r.featureKey && r.featureKey !== n.featureKey) say(at, `the menu uses '${n.featureKey}' but the page uses '${r.featureKey}'.`)
      if (!r.featureKey && TIERS.includes(tier) && tier !== 'starter') {
        say(at, `the menu hides "${n.label}" below ${TIER_LABEL[tier]}, but the page has no plan gate, so the address opens it on any plan.`)
      }
    } else if (r.featureKey && TIERS.includes(tierOf[r.featureKey]) && tierOf[r.featureKey] !== 'starter') {
      say(at, `the menu offers "${n.label}" on every plan, but the page needs ${TIER_LABEL[tierOf[r.featureKey]]}.`)
    }
  }
  return out
}

// ── ROUTES.md ───────────────────────────────────────────────────────────────
const RANK = { staff: 'staff', supervisor: 'supervisor+', manager: 'manager' }

function menuCell(items) {
  if (!items.length) return 'Not in the menu'
  const seen = new Set()
  for (const n of items) {
    const who = []
    if (n.ownerOnly) who.push('Owner')
    if (n.menuPricing) who.push('Owner, IMS or POS manager')
    if (n.ims) who.push(`IMS ${RANK[n.ims] || n.ims}`)
    if (n.pos) who.push(`POS ${RANK[n.pos] || n.pos}`)
    if (n.hr) who.push(`HR ${RANK[n.hr] || n.hr}`)
    if (n.needsGroup) who.push('groups only')
    const fallback = n.inShell ? 'condition set where the link is drawn' : 'everyone'
    seen.add(`${n.section}: ${who.length ? who.join(', ') : fallback}`)
  }
  return [...seen].join('; ')
}

function planCell(r, tierOf, suite) {
  if (suite) return 'Suite Pro (checked inside the page)'
  if (!r.featureKey) return ''
  const tier = tierOf[r.featureKey]
  return `${TIER_LABEL[tier] || '?'} (\`${r.featureKey}\`)`
}

function notesCell(r) {
  const notes = []
  if (r.redirect) notes.push(`Redirects to \`${r.redirect}\``)
  if (r.module && r.module.includes('|')) notes.push(`Either module: ${r.module.split('|').map(m => m.toUpperCase()).join(' or ')}`)
  if (r.tillGate) notes.push('Till outlet check (TillOutletGate)')
  if (r.path === '*') notes.push('Any unknown address')
  return notes.join('; ')
}

const esc = s => String(s).replace(/\|/g, '\\|')
const row = cells => `| ${cells.map(c => esc(c || '')).join(' | ')} |`

function render(routes, nav, tierOf) {
  const navFor = path => nav.filter(n => n.to === path)
  const suitePaths = new Set(nav.filter(n => n.suite).map(n => n.to))
  const groups = [
    ['Crest IMS', r => r.module === 'ims' || r.module === 'ims|pos'],
    ['Crest HR', r => r.module === 'hr'],
    ['Crest POS', r => r.module === 'pos'],
    ['Crest Customization', r => r.module === 'customization'],
  ]
  const lines = [
    '# Routes',
    '',
    '<!-- Generated by scripts/check-routes.mjs. Do not edit by hand: run `npm run routes:write`. -->',
    '',
    `Every address in the app and what stands in front of it, generated from \`${APP}\` (the page's own`,
    `gates), \`${LAYOUT}\` (the menu) and \`${AUTH}\` (the plan lists). \`npm run check:docs\` and`,
    '`build:verify` fail when this file is out of date, or when a page\'s plan disagrees between those',
    'three files.',
    '',
    '- **Plan** is the IMS plan the page needs, with its feature key. Blank means no plan gate.',
    '- **Menu** is where the menu offers the page and to whom. It is not a guard: a page that must',
    '  refuse a rank checks it itself (CLAUDE.md, "A nav item hidden by role is not a guard").',
    '- A page in more than one menu is listed once, with each menu.',
    '',
    '## Before sign-in',
    '',
    row(['Address', 'Page', 'Notes']),
    row(['---', '---', '---']),
    ...routes.filter(r => !r.signedIn).map(r => row([`\`${r.path}\``, r.page, notesCell(r)])),
  ]

  const signedIn = routes.filter(r => r.signedIn)
  const placed = new Set()
  const table = (title, list, intro) => {
    lines.push('', `## ${title}`, '')
    if (intro) lines.push(intro, '')
    lines.push(row(['Address', 'Page', 'Plan', 'Menu', 'Notes']), row(['---', '---', '---', '---', '---']))
    for (const r of list) {
      placed.add(r)
      lines.push(row([`\`${r.path}\``, r.page, planCell(r, tierOf, suitePaths.has(r.path)), menuCell(navFor(r.path)), notesCell(r)]))
    }
  }

  table('Crest Suite Pro', signedIn.filter(r => suitePaths.has(r.path)),
    'Sold per outlet on its own axis. SuiteGate inside each page offers it in place instead of redirecting.')
  table('Crest operator', signedIn.filter(r => r.adminOnly && !placed.has(r)),
    'Crest staff only (`ProtectedRoute adminOnly`).')
  for (const [title, test] of groups) {
    table(title, signedIn.filter(r => !placed.has(r) && test(r)), `Needs the module switched on (ModuleGate).`)
  }
  table('Every signed-in login', signedIn.filter(r => !placed.has(r)),
    'No module gate. Each page decides for itself who may see what.')
  lines.push('')
  return lines.join('\n')
}

// ── Run ─────────────────────────────────────────────────────────────────────
const tierOf = readKeySets(read(AUTH))
const routes = readRoutes(read(APP))
const nav = readNav(read(LAYOUT))
const text = render(routes, nav, tierOf)
const mismatches = findMismatches(routes, nav, tierOf)

let failed = false
if (mismatches.length) {
  failed = true
  console.error(`check-routes: ${mismatches.length} plan lock(s) disagree between ${AUTH}, ${APP} and ${LAYOUT}:`)
  for (const m of mismatches) console.error(`  - ${m}`)
  console.error('Moving a feature between plans takes all three edits in one change (CLAUDE.md, Hard rules: access control).')
}

const outPath = join(root, OUT)
if (WRITE) {
  writeFileSync(outPath, text)
  console.log(`check-routes: wrote ${OUT} (${routes.length} routes, ${nav.length} menu items).`)
} else {
  const current = existsSync(outPath) ? readFileSync(outPath, 'utf8').replace(/\r\n/g, '\n') : null
  if (current !== text) {
    failed = true
    if (current === null) console.error(`check-routes: ${OUT} does not exist.`)
    else {
      const a = current.split('\n'), b = text.split('\n')
      const at = a.findIndex((l, i) => l !== b[i])
      console.error(`check-routes: ${OUT} is out of date (first difference at line ${at + 1}):`)
      console.error(`  file:     ${a[at] ?? '(end of file)'}`)
      console.error(`  the code: ${b[at] ?? '(end of file)'}`)
    }
    console.error('Run `npm run routes:write` and commit ROUTES.md with the change.')
  } else if (!failed) {
    console.log(`check-routes: ROUTES.md is current and every plan lock agrees (${routes.length} routes).`)
  }
}
process.exit(failed ? 1 : 0)
