// Complete, restorable export of one client's data.
//
// Two artifacts come out of every run, and the pair is the point:
//
//   .xlsx — one sheet per table, for a human. Lossy by nature: jsonb collapses to text, and
//           numeric/date/null round-tripping through a spreadsheet is not faithful.
//   .json — the same data untouched, for restoreClientData.js. This is the actual backup.
//
// Shipping only the .xlsx would produce something that looks like a backup and cannot restore.
//
// Runs entirely in the browser: admin RLS already permits reading any tenant's rows, so no Edge
// Function is involved. It is admin-only by placement (Admin -> Clients), not by its own check.
import { supabase } from '../../../supabaseClient'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { CLIENT_SCOPED_TABLES } from '../../../shared/scopedDb'

// fetchAllRows defaults to 100k. pos_order_items is one row per line per bill, so a busy client
// blows past that — and the failure mode is a SILENT short read, not an error (S528). Every read
// here raises the ceiling explicitly rather than relying on the default.
const MAX_ROWS = 500000

// PostgREST puts .in() lists in the URL, so a few thousand ids becomes a 414. Chunk them.
const IN_CHUNK = 200

// Tables scoped by period_id rather than client_id — reached through this client's own periods.
const PERIOD_SCOPED_TABLES = [
  'purchase_entries', 'sales_entries', 'opening_stock', 'closing_stock',
  'wastages', 'staff_meals', 'budgets',
]

// Tables with neither client_id nor period_id — reached through their parent's ids.
// payable_payments is deliberately absent: it carries its own client_id and is already in
// CLIENT_SCOPED_TABLES, so fetching it here too would duplicate every row.
const PARENT_SCOPED_TABLES = [
  { table: 'recipe_ingredients',   fk: 'recipe_id',      parent: 'recipes' },
  { table: 'purchase_order_items', fk: 'po_id',          parent: 'purchase_orders' },
  { table: 'requisition_lines',    fk: 'requisition_id', parent: 'requisitions' },
  { table: 'hr_tada_claim_items',  fk: 'claim_id',       parent: 'hr_tada_claims' },
]

// Columns holding a profiles.id purely for display. S543 established by grep that none of these
// is ever filtered on — they are resolved for show through get_client_profile_names(). That is
// what makes it safe for restore to null them, and why carrying the NAME alongside preserves
// everything a reader actually wanted.
const ATTRIBUTION_SUFFIX = '_by'
const ATTRIBUTION_EXTRA = ['custodian_user_id', 'supervisor_id']

function isAttributionColumn(key) {
  return key.endsWith(ATTRIBUTION_SUFFIX) || ATTRIBUTION_EXTRA.includes(key)
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

// Every read goes through here so the row cap, the ordering guarantee and the error shape are
// identical across all ~65 tables. `.order('id')` is the unique tiebreaker fetchAllRows requires —
// without it, paging can repeat a row on one page and drop it from the next.
async function readAll(table, applyFilter) {
  const { data, error } = await fetchAllRows(
    () => applyFilter(supabase.from(table).select('*')).order('id'),
    { maxRows: MAX_ROWS },
  )
  if (error) throw new Error(`${table}: ${error.message}`)
  return data || []
}

async function readByIds(table, fkCol, ids) {
  if (ids.length === 0) return []
  const out = []
  for (const part of chunk(ids, IN_CHUNK)) {
    out.push(...await readAll(table, q => q.in(fkCol, part)))
  }
  return out
}

// Adds `<col>_name` beside every attribution UUID. CLAUDE.md's S435 rule: a frozen artifact that
// stores a raw UUID where a person's name belongs is a real bug, because the lookup table it
// pointed at may not exist by the time anyone reads the artifact — which is exactly the case
// after a client delete.
function withAttributionNames(rows, nameById) {
  return rows.map(row => {
    let augmented = null
    for (const key of Object.keys(row)) {
      if (!isAttributionColumn(key) || !row[key]) continue
      const name = nameById[row[key]]
      if (!name) continue
      if (!augmented) augmented = { ...row }
      augmented[`${key}_name`] = name
    }
    return augmented || row
  })
}

// Excel caps sheet names at 31 chars and forbids : \ / ? * [ ]. Table names here are all safe
// and the longest (assets_depreciation_schedule) is 28, but truncation collides silently and a
// duplicate name throws mid-workbook, so both are handled rather than assumed.
function sheetNamer() {
  const used = new Set()
  return function nameFor(table) {
    const base = table.replace(/[:\\/?*[\]]/g, '_').slice(0, 31)
    if (!used.has(base)) { used.add(base); return base }
    for (let i = 2; ; i++) {
      const candidate = `${base.slice(0, 31 - String(i).length - 1)}~${i}`
      if (!used.has(candidate)) { used.add(candidate); return candidate }
    }
  }
}

// A spreadsheet cell cannot hold an object. Without this, monthly_owner_reports.snapshot — the
// single richest thing in the export — renders as "[object Object]" in every row.
function flattenForSheet(rows) {
  return rows.map(row => {
    const flat = {}
    for (const [k, v] of Object.entries(row)) {
      flat[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
    }
    return flat
  })
}

/**
 * @param clientId  the client to export
 * @param onProgress optional (label, done, total) => void
 * @returns { data, manifest, xlsxBlob, jsonBlob }
 */
export async function exportClientData(clientId, onProgress = () => {}) {
  if (!clientId) throw new Error('exportClientData: clientId is required')

  const data = {}
  const steps = CLIENT_SCOPED_TABLES.length + PERIOD_SCOPED_TABLES.length + PARENT_SCOPED_TABLES.length + 3
  let done = 0
  const step = label => onProgress(label, ++done, steps)

  // Display names for every attribution UUID, resolved once. get_client_profile_names is the
  // supported way to read other people's names — profiles_select RLS is self-or-admin only, so
  // this also keeps working if the export is ever run by a non-admin path.
  const { data: names } = await supabase.rpc('get_client_profile_names', { p_client_id: clientId })
  const nameById = Object.fromEntries((names || []).map(n => [n.id, n.full_name]))
  step('staff names')

  // The client row, its settings, its account roster and the encrypted PIN vault.
  const [{ data: clientRow }, { data: settingsRows }, { data: profileRows }, { data: vaultRows }] = await Promise.all([
    supabase.from('clients').select('*').eq('id', clientId).single(),
    supabase.from('settings').select('*').eq('client_id', clientId),
    // The roster restore re-provisions from. Password material is never selected — there is none
    // to select; GoTrue holds it and it is not exportable at any privilege level.
    supabase.from('profiles')
      .select('id, full_name, role, client_id, pos_role, pos_team, pos_discount_limit, pos_allow_void, ' +
              'pos_email, ims_role, ims_job_title, hr_role, hr_job_title, hr_self_service, ' +
              'hr_self_service_email, hr_employee_id, pos_job_title')
      .eq('client_id', clientId),
    // Ciphertext only. The AES-GCM key lives in app_secrets and never enters this file, so these
    // rows are inert on disk — but they let a restore give POS/Self-Service staff their original
    // PINs back instead of re-issuing every till code by hand.
    supabase.from('staff_pin_vault').select('user_id, client_id, kind, pin_cipher, updated_at').eq('client_id', clientId),
  ])
  if (!clientRow) throw new Error('Client not found, or not readable by this account.')
  data.clients = [clientRow]
  data.settings = settingsRows || []
  data.profiles = profileRows || []
  data.staff_pin_vault = vaultRows || []
  step('client record')

  for (const table of CLIENT_SCOPED_TABLES) {
    data[table] = withAttributionNames(await readAll(table, q => q.eq('client_id', clientId)), nameById)
    step(table)
  }

  const periodIds = (data.monthly_periods || []).map(p => p.id)
  for (const table of PERIOD_SCOPED_TABLES) {
    data[table] = withAttributionNames(await readByIds(table, 'period_id', periodIds), nameById)
    step(table)
  }

  for (const { table, fk, parent } of PARENT_SCOPED_TABLES) {
    const parentIds = (data[parent] || []).map(r => r.id)
    data[table] = withAttributionNames(await readByIds(table, fk, parentIds), nameById)
    step(table)
  }

  const generatedAt = new Date().toISOString()
  const manifest = {
    schema: 'crest-client-export',
    version: 1,
    generatedAt,
    clientId,
    clientName: clientRow.name,
    // Per-table row counts. This is what lets a restore PROVE it brought everything back, rather
    // than merely finishing without an error.
    counts: Object.fromEntries(Object.entries(data).map(([t, rows]) => [t, rows.length])),
    totalRows: Object.values(data).reduce((sum, rows) => sum + rows.length, 0),
    notes: [
      'staff_pin_vault holds AES-GCM ciphertext only; the key stays in the database.',
      'client_secrets and audit_logs are deliberately excluded.',
      '*_by_name columns are resolved at export time and are not database columns.',
      'The .json artifact is the restorable one. The .xlsx is for reading.',
    ],
  }
  step('manifest')

  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const nameFor = sheetNamer()
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(
      Object.entries(manifest.counts).map(([table, rows]) => ({ Table: table, Rows: rows })),
    ),
    nameFor('_manifest'),
  )
  for (const [table, rows] of Object.entries(data)) {
    if (rows.length === 0) continue // an empty sheet per unused table buries the real ones
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flattenForSheet(rows)), nameFor(table))
  }
  const xlsxBlob = new Blob(
    [XLSX.write(wb, { bookType: 'xlsx', type: 'array' })],
    { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  )
  const jsonBlob = new Blob([JSON.stringify({ manifest, data }, null, 2)], { type: 'application/json' })
  step('workbook')

  return { data, manifest, xlsxBlob, jsonBlob }
}
