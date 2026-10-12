// Table names on one floor (S817 4i, FLOOR-KITCHEN-8; owner decision D20).
//
// Two tables in service never share a name: two KOTs both saying "Table 3" cannot be told apart by a
// runner, and Reservations, Covers and the Bill Register then show two of them. The database holds it
// with a unique index on (client_id, lower(btrim(name))) over tables NOT out of service
// (pos_tables_client_name_live_key, migration 20261012120000). A retired (Inactive) table is left
// out, because retiring a table and adding a new one under the same name is still the only way to a
// new QR code (GUEST-7, closed as accepted). These are the page's copy, so POS Setup names the clash
// before saving rather than after the database refuses it.

// The name as the index compares it: spaces at either end and capitals ignored.
export const tableNameKey = name => String(name ?? '').trim().toLowerCase()

const inService = t => t?.status !== 'inactive'

// The table in service already carrying this name, or null. `exceptId` is the table being edited.
export function tableNameClash(name, tables, exceptId = null) {
  const key = tableNameKey(name)
  if (!key) return null
  return (tables || []).find(t => t.id !== exceptId && inService(t) && tableNameKey(t.name) === key) || null
}

// The names Quick Setup would create: "Table 1", "Table 2", …
export function quickSetupNames({ prefix, start, count }) {
  const p = String(prefix ?? '').trim()
  const s = parseInt(start, 10) || 1
  const n = Math.max(0, parseInt(count, 10) || 0)
  return Array.from({ length: n }, (_, i) => `${p} ${s + i}`)
}

// Which of those names a table in service already has, in the batch's order.
export function quickSetupClashes(names, tables) {
  return (names || []).filter(n => tableNameClash(n, tables))
}

// Quick Setup's Start: one past the highest number already used with this prefix (any table, a
// retired one included, so a new batch never reads as a second "Table 4"). 1 when none is.
export function nextQuickSetupStart(prefix, tables) {
  const p = tableNameKey(prefix)
  if (!p) return 1
  let max = 0
  for (const t of tables || []) {
    const key = tableNameKey(t.name)
    if (!key.startsWith(`${p} `)) continue
    const rest = key.slice(p.length + 1).trim()
    if (/^\d+$/.test(rest)) max = Math.max(max, parseInt(rest, 10))
  }
  return max + 1
}
