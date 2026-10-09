// Shared helpers for the Bloom demo seed: a seeded RNG, stable ids, SQL literals and Nepal time.
// Nothing here talks to the database; build.mjs writes SQL files and apply.mjs runs them.
import { createHash } from 'node:crypto'

// ── Random numbers: one seeded stream per purpose, so adding a feature never reshuffles another ──
export function rngFor(...keyParts) {
  const h = createHash('sha256').update(['bloom-demo', ...keyParts].join('|')).digest()
  let a = h.readUInt32LE(0)
  const next = () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const r = {
    next,
    float: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    chance: p => next() < p,
    pick: arr => arr[Math.floor(next() * arr.length)],
    // weighted pick over [[value, weight], …]
    weighted: pairs => {
      const total = pairs.reduce((s, [, w]) => s + w, 0)
      let x = next() * total
      for (const [v, w] of pairs) { if ((x -= w) <= 0) return v }
      return pairs[pairs.length - 1][0]
    },
    normal: (mean, sd) => {
      const u = 1 - next(), v = next()
      return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    },
    shuffle: arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a },
  }
  return r
}

// ── Stable ids: the same key always gives the same uuid, so SQL files can reference rows by key ──
export function uid(...keyParts) {
  const h = createHash('sha1').update(['bloom-demo-id', ...keyParts].join('|')).digest('hex')
  // Version 4 / variant 1 bits, so it looks like every other id in the table.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// ── SQL literals ────────────────────────────────────────────────────────────────────────────────
export function lit(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`non-finite number in SQL: ${v}`)
    return String(Math.round(v * 1e6) / 1e6)
  }
  if (v instanceof Raw) return v.sql
  if (Array.isArray(v) || typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`
  return `'${String(v).replace(/'/g, "''")}'`
}
export class Raw { constructor(sql) { this.sql = sql } }
export const raw = sql => new Raw(sql)
export const uuidArr = ids => raw(ids.length ? `ARRAY[${ids.map(i => `'${i}'`).join(',')}]::uuid[]` : `'{}'::uuid[]`)
export const textArr = xs => raw(xs.length ? `ARRAY[${xs.map(x => `'${String(x).replace(/'/g, "''")}'`).join(',')}]::text[]` : `'{}'::text[]`)

// One INSERT per table per call, multi-row VALUES, columns taken from the union of row keys.
export function insertSql(table, rows, { onConflict = '' } = {}) {
  if (!rows.length) return ''
  // Keys starting with `_` are the simulation's own working fields, never columns.
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))].filter(c => !c.startsWith('_'))
  const values = rows.map(r => `(${cols.map(c => lit(r[c] === undefined ? null : r[c])).join(', ')})`)
  return `INSERT INTO public.${table} (${cols.join(', ')}) VALUES\n${values.join(',\n')}${onConflict ? '\n' + onConflict : ''};\n`
}

// ── Nepal time ──────────────────────────────────────────────────────────────────────────────────
// Every timestamp is written as a Nepal wall-clock string with its +05:45 offset, so the database
// stores the right instant whatever machine runs this.
export const NPT = '+05:45'
export function ts(adDate, minutesFromMidnight) {
  const m = Math.max(0, Math.round(minutesFromMidnight))
  const hh = String(Math.floor(m / 60)).padStart(2, '0')
  const mm = String(m % 60).padStart(2, '0')
  return `${adDate} ${hh}:${mm}:00${NPT}`
}
export function tsSec(adDate, seconds) {
  const s = Math.max(0, Math.round(seconds))
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${adDate} ${hh}:${mm}:${ss}${NPT}`
}
// Minutes since Nepal midnight right now.
export function nepalNowParts() {
  const now = new Date(Date.now() + (5 * 60 + 45) * 60000)
  return { adDate: now.toISOString().slice(0, 10), minutes: now.getUTCHours() * 60 + now.getUTCMinutes() }
}
// 0 = Sunday … 6 = Saturday, from an AD 'YYYY-MM-DD'.
export const weekdayOf = adDate => new Date(adDate + 'T00:00:00Z').getUTCDay()
export const addDaysAd = (adDate, n) => new Date(Date.parse(adDate + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)

// Money helpers
export const round2 = x => Math.round(x * 100) / 100
export const round4 = x => Math.round(x * 10000) / 10000
