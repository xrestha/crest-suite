import { Fragment, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'
import ReportLoadError from '../components/ReportLoadError'
import ConfirmModal from '../components/ConfirmModal'
import RowDisclosure from '../components/RowDisclosure'
import ActionError, { asActionError } from '../components/ActionError'
import { useLatestRequest } from '../shared/hooks/useLatestRequest'
import { nepalBsLong, nepalCivilDate, nepalDateLong, nepalTime, nepalTime24 } from '../shared/nepalTime'
import { NPR_LOCALE } from '../shared/nepalMoney'
import { formatAd } from '../utils/bsCalendar'

const PAGE_SIZE = 500

// Every table carrying a log_audit() trigger, plus the two rows written by hand: admin-user-ops'
// PIN reveal (`staff_pin_vault` / VIEW) and a purge's own record (`audit_logs` / PURGE). A table
// missing here still renders, but under its raw name and absent from the Area filter — which is
// how the three fixed-asset tables and the PIN reveals came to be unfilterable (S745).
const TABLE_LABELS = {
  purchase_entries: 'Purchase',
  vendor_returns:   'Return',
  opening_stock:    'Opening Stock',
  closing_stock:    'Closing Stock',
  wastages:         'Wastage',
  monthly_periods:  'Period',
  items:            'Item Master',
  // HR module
  hr_final_settlements: 'Final Settlement',
  hr_employees:           'Employee',
  hr_salary_components:   'Salary',
  hr_attendance:          'Attendance',
  hr_payroll_runs:        'Payroll Run',
  hr_payslips:            'Payslip',
  hr_festival_allowances: 'Festival',
  hr_leave_types:         'Leave Type',
  hr_leave_requests:      'Leave Request',
  hr_holiday_calendar:    'Holiday',   // audited since S748 — a holiday's type sets the 2× OT rate
  // audited since S749 — an approved entry is pay; a shift type decides Generate from Roster;
  // a swap approval changes who works a day
  hr_overtime_entries:    'Overtime',
  hr_shift_types:         'Shift Type',
  hr_shift_swap_requests: 'Shift Swap',
  // audited since S751 — every one of these moves money: an advance and its write-off, a repayment,
  // a bonus amount or type, a travel claim's approval and payment
  hr_advances:            'Advance / Loan',
  hr_advance_repayments:  'Advance Repayment',
  hr_incentives:          'Incentive',
  hr_incentive_configs:   'Incentive Type',
  hr_tada_claims:         'TADA Claim',
  // POS module
  pos_orders:             'POS Order',
  pos_credit_notes:       'Credit Note',
  // audited since S754 — a closed shift is the signed drawer count, and a cash movement (a refund
  // on a credit note included) is money leaving or entering that drawer
  pos_shifts:             'POS Shift',
  pos_cash_movements:     'Cash Movement',
  // Crest Suite
  assets_register:          'Fixed Asset',
  assets_depreciation_runs: 'Depreciation Run',
  assets_tax_pool_runs:     'Tax Pool Run',
  // User & client management
  profiles:               'User',
  staff_pin_vault:        'Staff PIN',
  clients:                'Client Account',
  feature_flags:          'Feature Flags',
  audit_logs:             'Audit Log',
}

// `color` here is pure badge TEXT (`bg` is its own key), so it takes the -text variants — the
// base tokens measured 3.04–3.61:1 at 11px/700 on Rosé Dawn (S574).
const ACTION_STYLE = {
  INSERT: { label: 'Added',   color: 'var(--theme-green-text)', bg: 'color-mix(in srgb, var(--theme-green) 12%, transparent)' },
  UPDATE: { label: 'Updated', color: 'var(--theme-purple-text)', bg: 'color-mix(in srgb, var(--theme-purple) 12%, transparent)' },
  DELETE: { label: 'Deleted', color: 'var(--theme-red-text)', bg: 'color-mix(in srgb, var(--theme-red) 12%, transparent)' },
  // A PIN reveal changes nothing, so it is a categorical tag rather than a signal colour.
  VIEW:   { label: 'Viewed',  color: 'var(--theme-accent-ink)', bg: 'color-mix(in srgb, var(--theme-accent) 12%, transparent)' },
  PURGE:  { label: 'Purged',  color: 'var(--theme-red-text)', bg: 'color-mix(in srgb, var(--theme-red) 12%, transparent)' },
}

// Columns that churn on nearly every write (housekeeping timestamps, PIN-lockout counters
// bumped on every login attempt, session keep-alive) or that must never reach the UI at all
// (the anon-facing POS device secret) — never worth showing as a "change". log_audit() skips a
// write whose ONLY change is one of these; this list also hides them on rows that changed
// something else, and on rows written before the trigger learned to skip them.
const IGNORE_KEYS = new Set([
  'id', 'created_at', 'updated_at', 'client_id',
  'pos_pin_failed_attempts', 'pos_pin_locked_until',
  'hr_pin_failed_attempts', 'hr_pin_locked_until',
  'ims_pin_failed_attempts', 'ims_pin_locked_until', 'last_seen_at',
  'pos_device_secret',
])

// Table-specific noise on top of the global list — fields that legitimately change on almost
// every touch of that row but aren't themselves the audit-worthy event (e.g. a bill reprint
// bumping print_count while status/discount/void stay the same).
const TABLE_EXTRA_IGNORE = {
  // items_version (S754) is bumped by save_pos_order_items on every cart save — the optimistic lock
  // between two tablets, not an event. log_audit() skips a write that changes only it.
  pos_orders: new Set(['covers', 'print_count', 'comp_print_count', 'items_version']),
}

const FIELD_LABELS = {
  uom: 'UOM', pan: 'PAN', vat_amount: 'VAT',
  ims_role: 'IMS Role', hr_role: 'HR Role', pos_role: 'POS Role',
  pos_team: 'POS Team', pos_discount_limit: 'Discount Limit %', pos_allow_void: 'Allow Void',
  pos_job_title: 'POS Job Title', ims_job_title: 'IMS Job Title', hr_job_title: 'HR Job Title',
  hr_self_service: 'Self-Service', hr_self_service_email: 'Self-Service Email',
  ot_hours: 'OT Hours', ot_amount: 'OT Amount', ssf_employer: 'SSF (Employer)', ssf_employee: 'SSF (Employee)',
  bs_day: 'BS Day', bs_year: 'BS Year', bs_month: 'BS Month',
  ims_enabled: 'IMS Enabled', hr_enabled: 'HR Enabled', pos_enabled: 'POS Enabled',
  suite_plan: 'Suite Plan', hr_plan: 'HR Plan', pos_plan: 'POS Plan',
  is_premium: 'Premium', is_trial: 'Trial',
  close_type: 'Close Type', close_reason: 'Close Reason', discount_amount: 'Discount',
  discount_reason: 'Discount Reason', invoice_no: 'Invoice No.', invoice_fy: 'Invoice FY',
  credit_note_no: 'Credit Note No.',
  older_than_days: 'Older Than (days)', deleted: 'Entries Deleted',
}

function fieldLabel(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// Checked in this order, and the order is the fix (S745). The money pattern alone matched
// `pos_discount_limit` (a percentage), `unpaid_days` and `ssf_gratuity_pct`, so a 10% discount cap
// read "NPR 10" and three unpaid days read "NPR 3".
const PERCENT_KEY = /(_pct|_percent|_limit)$/i
const COUNT_KEY   = /(days|hours|count|qty|quantity|_no|year|month|months|deleted)$/i
const MONEY_KEY   = /rate|amount|price|total|gross|net|basic|value|cost|discount|paid|tendered|allowance|deduction|ssf|tds|salary/i
const STAMP_KEY   = /(_at|^cutoff)$/i
const DATE_ONLY   = /^\d{4}-\d{2}-\d{2}$/

const moneyFmt = new Intl.NumberFormat(NPR_LOCALE, { maximumFractionDigits: 2 })
const plainFmt = new Intl.NumberFormat(NPR_LOCALE, { maximumFractionDigits: 3 })

/** "18 Bhadra 2083 · 07:42 PM" — the day and clock time in Nepal, whatever the viewer's timezone. */
function fmtStamp(ts) {
  const day = nepalBsLong(ts) || nepalDateLong(ts)
  return day ? `${day} · ${nepalTime(ts)}` : '—'
}

function formatValue(key, val) {
  if (val === null || val === undefined || val === '') return '—'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (typeof val === 'number') {
    if (PERCENT_KEY.test(key)) return `${plainFmt.format(val)}%`
    if (COUNT_KEY.test(key))   return plainFmt.format(val)
    if (MONEY_KEY.test(key))   return `NPR ${moneyFmt.format(val)}`
    return plainFmt.format(val)
  }
  if (typeof val === 'string') {
    // A bare date column (join_date, end_date) is a calendar day, not an instant: parsing it as a
    // timestamp made it UTC midnight and printed a 05:45 clock time on a date of birth.
    if (DATE_ONLY.test(val)) return val
    if (STAMP_KEY.test(key) && !isNaN(Date.parse(val))) return fmtStamp(val)
    return val.length > 80 ? val.slice(0, 80) + '…' : val
  }
  if (typeof val === 'object') {
    const s = JSON.stringify(val)
    return s.length > 60 ? s.slice(0, 60) + '…' : s
  }
  return String(val)
}

// The single source of truth for "what changed" — every table, past and future, gets this for
// free instead of needing its own hand-written case. Keyed on which snapshots EXIST rather than on
// the action name, so the hand-written VIEW and PURGE rows (new_data only) list their contents.
function diffFields(log) {
  const ignore = new Set([...IGNORE_KEYS, ...(TABLE_EXTRA_IGNORE[log.table_name] || [])])
  const o = log.old_data
  const n = log.new_data
  if (!o) {
    const d = n || {}
    return Object.keys(d).filter(k => !ignore.has(k) && d[k] !== null && d[k] !== '').map(k => ({ key: k, to: d[k] }))
  }
  if (!n) {
    return Object.keys(o).filter(k => !ignore.has(k) && o[k] !== null && o[k] !== '').map(k => ({ key: k, from: o[k] }))
  }
  const keys = new Set([...Object.keys(o), ...Object.keys(n)])
  const changed = []
  keys.forEach(k => {
    if (ignore.has(k)) return
    if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) changed.push({ key: k, from: o[k], to: n[k] })
  })
  return changed
}

function fieldText(f) {
  if (!('from' in f)) return `${fieldLabel(f.key)}: ${formatValue(f.key, f.to)}`
  if (!('to' in f))   return `${fieldLabel(f.key)}: ${formatValue(f.key, f.from)}`
  return `${fieldLabel(f.key)}: ${formatValue(f.key, f.from)} → ${formatValue(f.key, f.to)}`
}

function summaryText(log, cap) {
  const fields = diffFields(log)
  if (fields.length === 0) return log.action === 'UPDATE' ? '(no tracked field changed)' : '—'
  if (!cap) return fields.map(fieldText).join(' · ')
  const shown = fields.slice(0, cap).map(fieldText)
  const extra = fields.length > cap ? ` +${fields.length - cap} more` : ''
  return shown.join(' · ') + extra
}

// A row with no user_id was written with no signed-in user behind it — an Edge Function on the
// service role (admin-user-ops' staff and client operations, the trial purge job). It used to
// render "—", indistinguishable from a field nobody filled in.
function userLabel(log) {
  if (log.user_name) return log.user_name
  return log.user_id ? 'Unnamed login' : 'System'
}

const DAY_MS = 86400000

// The lower bound of the time filter. "Today" is today IN NEPAL: it used to be the browser's local
// midnight, which for an operator abroad cut the day 5h45m off from the dates on screen.
function windowStart(time) {
  if (time === 'all') return null
  if (time === 'today') {
    const d = nepalCivilDate(new Date())
    return d ? `${formatAd(d)}T00:00:00+05:45` : null
  }
  const days = time === '30d' ? 30 : 7
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

const TIME_LABELS = { today: 'today', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all time' }

const PURGE_OPTIONS = [
  { days: 90,  label: '90 days' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' },
  { days: 730, label: '2 years' },
]

const HELP_ITEMS = [
  { area: 'Purchase',      icon: '↓', ops: 'Add · Edit · Delete', note: 'Every purchase entry change per client' },
  { area: 'Return',        icon: '↩', ops: 'Add · Edit · Delete', note: 'Vendor returns against purchase entries' },
  { area: 'Opening Stock', icon: '□', ops: 'Add · Edit · Delete', note: 'Opening stock qty entries per period' },
  { area: 'Closing Stock', icon: '□', ops: 'Add · Edit · Delete', note: 'Physical closing count entries' },
  { area: 'Wastage',       icon: '✕', ops: 'Add · Edit · Delete', note: 'Wastage entries per period' },
  { area: 'Period',        icon: '◷', ops: 'Status · Rename',     note: 'Logged when a period is opened, closed or relabelled to a different BS month' },
  { area: 'Item Master',   icon: '≡', ops: 'Add · Edit · Delete', note: 'Item name, UOM, rate — shows what changed on edits' },
  { area: 'Employee',      icon: '👤', ops: 'Add · Edit · Delete', note: 'HR employee master records' },
  { area: 'Salary',        icon: '₨', ops: 'Add · Edit · Delete', note: 'Salary components per employee' },
  { area: 'Attendance',    icon: '🕘', ops: 'Add · Edit · Delete', note: 'Daily attendance status per employee' },
  { area: 'Payroll Run',   icon: '💵', ops: 'Status change',       note: 'Payroll run draft / finalize' },
  { area: 'Payslip',       icon: '🧾', ops: 'Add · Edit · Delete', note: 'Generated payslips per payroll run' },
  { area: 'Festival',      icon: '🎉', ops: 'Add · Edit · Delete', note: 'Festival allowance entries' },
  { area: 'Leave Type',    icon: '🏖️', ops: 'Add · Edit · Delete', note: 'Leave entitlement definitions' },
  { area: 'Leave Request', icon: '🗓️', ops: 'Add · Edit · Delete', note: 'Leave applications & approvals' },
  { area: 'Holiday',       icon: '📆', ops: 'Add · Edit · Delete', note: 'Holiday Calendar entries — a public holiday sets the 2× overtime rate' },
  { area: 'Final Settlement', icon: '📄', ops: 'Add · Edit · Delete', note: 'Final settlement drafts, finalisation and reopening' },
  { area: 'POS Order',     icon: '🧮', ops: 'Status change',       note: 'Void, discount, close type, invoice no. and credit settlement — not every item edit or bill reprint' },
  { area: 'Credit Note',   icon: '↩', ops: 'Add',                 note: 'Credit notes issued against a closed POS invoice' },
  { area: 'Fixed Asset',   icon: '🏷', ops: 'Add · Edit · Delete', note: 'Fixed asset register, depreciation runs and tax pool runs (Crest Suite)' },
  { area: 'User',          icon: '⊛',  ops: 'Add · Edit · Delete', note: 'Client login created / reassigned / removed, incl. per-staff POS/IMS/HR role & permission changes' },
  { area: 'Staff PIN',     icon: '🔑', ops: 'View',                note: 'An admin revealed a staff PIN from Admin → Clients → Staff PINs — who looked, at which account. Never the PIN itself' },
  { area: 'Client Account', icon: '🏢', ops: 'Add · Edit · Delete', note: 'Plan tier, module enable/disable, trial & subscription dates — the Admin Clients page itself' },
  { area: 'Feature Flags', icon: '🚩', ops: 'Add · Edit · Delete', note: 'Admin-granted feature overrides above a client\'s plan tier' },
  { area: 'Audit Log',     icon: '🗑', ops: 'Purge',               note: 'Old entries deleted from this log — who, which clients, the cutoff and how many' },
]

export default function AuditLog() {
  const { loading: authLoading } = useAuth()
  const [logs, setLogs]             = useState([])
  const [clients, setClients]       = useState([])
  const [clientsError, setClientsError] = useState(false)
  const [loading, setLoading]       = useState(true)
  const [loadError, setLoadError]   = useState(null) // a failed read is not an empty trail
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore]       = useState(false)
  const [filterClient, setFilterClient] = useState('all')
  const [filterArea, setFilterArea]     = useState('all')
  const [filterTime, setFilterTime]     = useState('7d')
  const [filterUser, setFilterUser]     = useState('all')
  const [search, setSearch]             = useState('')
  const [helpOpen, setHelpOpen]         = useState(false)
  const [expandedId, setExpandedId]     = useState(null)
  const [purgeOpen, setPurgeOpen]       = useState(false)
  const [purgeDays, setPurgeDays]       = useState(365)
  const [purging, setPurging]           = useState(false)
  const [purgeError, setPurgeError]     = useState(null)
  const [purgeMsg, setPurgeMsg]         = useState('')
  // Every filter is a closed <select>, which fires `change` on each arrow keypress — so arrowing
  // through the client list starts one load per client and the last response to LAND won the
  // table, under whichever label was selected last (S601's shape).
  const req = useLatestRequest()

  useEffect(() => { if (!authLoading) init() }, [authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    fetchLogs('all', 'all', '7d')
    const { data: c, error } = await supabase.from('clients').select('id, name').order('name')
    setClientsError(!!error)
    setClients(c || [])
  }

  // Ordered and paged by `id`, not `created_at`. Every row one transaction writes shares its
  // created_at (now() is the transaction's start), so a Save All over 300 closing counts or a
  // purchase bill's lines are one timestamp — and the old `.lt('created_at', cursor)` cursor
  // skipped whatever part of such a group fell after a page boundary. `id` is a sequence: unique,
  // and it is the primary key, so the newest-first scan uses an index instead of sorting the table.
  function baseQuery(client, area, time) {
    let q = supabase.from('audit_logs').select('*').order('id', { ascending: false })
    if (client !== 'all') q = q.eq('client_id', client)
    if (area   !== 'all') q = q.eq('table_name', area)
    const start = windowStart(time)
    if (start) q = q.gte('created_at', start)
    return q
  }

  async function fetchLogs(client, area, time) {
    const key = req.begin(`${client}|${area}|${time}`)
    setLoading(true)
    setLoadingMore(false)
    setExpandedId(null)
    const { data, error } = await baseQuery(client, area, time).limit(PAGE_SIZE)
    if (!req.isCurrent(key)) return
    setLoading(false)
    // A failed read is not "No entries found for the selected filters" — on the audit trail that
    // reads as an assurance that nothing happened (S682).
    if (error) { setLoadError(error); setLogs([]); setHasMore(false); return }
    setLoadError(null)
    setLogs(data || [])
    setHasMore((data || []).length === PAGE_SIZE)
  }

  async function loadMore() {
    if (!logs.length) return
    const key = `${filterClient}|${filterArea}|${filterTime}`
    if (!req.isCurrent(key)) return
    setLoadingMore(true)
    const cursor = logs[logs.length - 1].id
    const { data, error } = await baseQuery(filterClient, filterArea, filterTime).lt('id', cursor).limit(PAGE_SIZE)
    // A filter changed while this page was in flight: its rows belong to the previous filter.
    if (!req.isCurrent(key)) return
    setLoadingMore(false)
    if (error) { setLoadError(error); return }
    setLogs(prev => [...prev, ...(data || [])])
    setHasMore((data || []).length === PAGE_SIZE)
  }

  function applyFilter(client, area, time) {
    setFilterClient(client)
    setFilterArea(area)
    setFilterTime(time)
    fetchLogs(client, area, time)
  }

  const clientName = id => clients.find(c => c.id === id)?.name || 'the selected client'

  function openPurge() {
    setPurgeError(null)
    setPurgeMsg('')
    setPurgeOpen(true)
  }

  // Retention, never erasure (decided 2026-09-14). The server computes the cutoff from now() and
  // refuses anything under 90 days, so this dialog cannot be talked into deleting recent history,
  // and the purge writes its own audit row. The Area/User/search filters play no part in it: a
  // purge is by age and client only, which is exactly what the dialog says.
  async function runPurge() {
    setPurging(true)
    setPurgeError(null)
    const { data: deleted, error } = await supabase.rpc('admin_purge_audit_logs', {
      p_older_than_days: purgeDays,
      p_client_id: filterClient !== 'all' ? filterClient : null,
    })
    setPurging(false)
    if (error) { setPurgeError(asActionError(error)); return }
    const scope = filterClient !== 'all' ? `for ${clientName(filterClient)}` : 'across all clients'
    const label = PURGE_OPTIONS.find(o => o.days === purgeDays)?.label || `${purgeDays} days`
    setPurgeMsg(`${plainFmt.format(deleted ?? 0)} ${deleted === 1 ? 'entry' : 'entries'} older than ${label} deleted ${scope}. The deletion is recorded in the log.`)
    setPurgeOpen(false)
    fetchLogs(filterClient, filterArea, filterTime)
  }

  // User/search are applied client-side over whatever's currently loaded — same 500-per-page
  // window the table itself already worked within, just narrowed further without a round trip.
  const userOptions = Array.from(new Set(logs.map(userLabel))).sort()
  const q = search.trim().toLowerCase()
  const visibleLogs = logs.filter(log => {
    if (filterUser !== 'all' && userLabel(log) !== filterUser) return false
    if (!q) return true
    const haystack = [
      userLabel(log), log.client_name, TABLE_LABELS[log.table_name] || log.table_name,
      log.record_id, summaryText(log),
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(q)
  })
  const narrowed = filterUser !== 'all' || !!q

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const rows = visibleLogs.map(log => ({
      'Date (BS)': nepalBsLong(log.created_at),
      'Date (AD)': nepalDateLong(log.created_at),
      'Time (Nepal)': nepalTime24(log.created_at),
      Client: log.client_name || '—',
      User: userLabel(log),
      Action: ACTION_STYLE[log.action]?.label || log.action,
      Area: TABLE_LABELS[log.table_name] || log.table_name,
      Details: summaryText(log),
      'Record ID': log.record_id || '',
    }))
    // The workbook leaves the page, so it carries its own scope: which filters produced it, and
    // that it holds only the rows that were loaded when it was exported.
    const scope = [
      ['Audit Log export'],
      ['Client', filterClient !== 'all' ? clientName(filterClient) : 'All clients'],
      ['Area', filterArea !== 'all' ? (TABLE_LABELS[filterArea] || filterArea) : 'All areas'],
      ['Time range', TIME_LABELS[filterTime]],
      ['User filter', filterUser !== 'all' ? filterUser : 'None'],
      ['Search', q || 'None'],
      ['Rows', `${visibleLogs.length} of ${logs.length} loaded${hasMore ? ' — more exist that were not loaded' : ''}`],
      ['Times', 'Nepal time (Asia/Kathmandu)'],
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Audit Log')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scope), 'Scope')
    const today = nepalCivilDate(new Date())
    XLSX.writeFile(wb, `audit-log-${today ? formatAd(today) : 'export'}.xlsx`)
  }

  const purgeScope = filterClient !== 'all' ? <strong>{clientName(filterClient)}</strong> : <strong>every client</strong>

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-subtitle">Every audited change across clients, newest first. Times are Nepal time.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {visibleLogs.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={exportExcel}>⬇ Export</button>
          )}
          <Tip text="Delete entries older than a chosen age (90 days at the least). Recent history cannot be deleted, and every deletion is itself recorded here." width={260}>
            <button type="button" className="btn btn-danger" onClick={openPurge}>🗑 Delete old entries</button>
          </Tip>
          <button type="button" className="btn btn-ghost" onClick={() => fetchLogs(filterClient, filterArea, filterTime)}>↻ Refresh</button>
        </div>
      </div>

      {purgeMsg && (
        <p role="status" style={{ fontSize: 12, margin: '0 0 12px', color: 'var(--theme-green-text)' }}>{purgeMsg}</p>
      )}

      {/* Help panel */}
      <div style={{ marginBottom: 20 }}>
        <button
          type="button"
          aria-expanded={helpOpen}
          aria-controls="audit-help"
          onClick={() => setHelpOpen(o => !o)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--theme-text2)', fontSize: 13, padding: 0 }}
        >
          <span aria-hidden="true" style={{ fontSize: 15 }}>{helpOpen ? '▾' : '▸'}</span>
          What does the Audit Log record?
        </button>
        {helpOpen && (
          <div id="audit-help" style={{ marginTop: 12, background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 0, overflow: 'hidden' }}>
            <div className="table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--theme-border)' }}>
                  <th style={{ textAlign: 'left', padding: '8px 14px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Area</th>
                  <th style={{ textAlign: 'left', padding: '8px 14px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Operations tracked</th>
                  <th style={{ textAlign: 'left', padding: '8px 14px', color: 'var(--theme-text2)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {HELP_ITEMS.map((h, i) => (
                  <tr key={h.area} style={{ borderBottom: i < HELP_ITEMS.length - 1 ? '1px solid var(--theme-border-lt)' : 'none' }}>
                    <td style={{ padding: '9px 14px', color: 'var(--theme-text1)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <span aria-hidden="true" style={{ marginRight: 7, color: 'var(--theme-accent-ink)' }}>{h.icon}</span>{h.area}
                    </td>
                    <td style={{ padding: '9px 14px', color: 'var(--theme-green-text)', fontFamily: 'monospace', fontSize: 12 }}>{h.ops}</td>
                    <td style={{ padding: '9px 14px', color: 'var(--theme-text3)' }}>{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--theme-border)', color: 'var(--theme-text2)', fontSize: 12, lineHeight: 1.6 }}>
              Logs are written by database triggers — they capture all changes regardless of which user or device made them.
              Sales entries, vendors, recipes, and individual POS line items/prints are not tracked; a POS order is tracked for its status/void/discount/invoice transitions only, not every item added or removed while the bill is still open.
              <strong> System</strong> in the User column means the change was made by a server process with no signed-in user attached — an admin operation run through the server, or the trial purge job.
              Open any row's details to see every changed field, not just the first few.
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <label htmlFor="audit-filter-client" className="sr-only">Filter by client</label>
        <select id="audit-filter-client" className="form-select" value={filterClient} onChange={e => applyFilter(e.target.value, filterArea, filterTime)}>
          <option value="all">All Clients</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label htmlFor="audit-filter-area" className="sr-only">Filter by area</label>
        <select id="audit-filter-area" className="form-select" value={filterArea} onChange={e => applyFilter(filterClient, e.target.value, filterTime)}>
          <option value="all">All Areas</option>
          {Object.entries(TABLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <label htmlFor="audit-filter-time" className="sr-only">Filter by time range</label>
        <select id="audit-filter-time" className="form-select" value={filterTime} onChange={e => applyFilter(filterClient, filterArea, e.target.value)}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
        <label htmlFor="audit-filter-user" className="sr-only">Filter by user</label>
        <select id="audit-filter-user" className="form-select" value={filterUser} onChange={e => setFilterUser(e.target.value)}>
          <option value="all">All Users</option>
          {userOptions.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <label htmlFor="audit-search" className="sr-only">Search audit log entries</label>
        <input
          id="audit-search"
          type="search"
          className="form-input form-input--auto"
          placeholder="Search client, user, field, record ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 'auto' }}>
          {loading ? 'Loading…' : `${visibleLogs.length}${visibleLogs.length !== logs.length ? ` of ${logs.length}` : ''} entries${hasMore ? '+' : ''}`}
        </span>
      </div>
      {clientsError && (
        <p role="alert" style={{ fontSize: 12, margin: '-12px 0 16px', color: 'var(--theme-amber-text)' }}>
          The client list could not be loaded, so the client filter only offers All Clients. Refresh the page to try again.
        </p>
      )}
      {narrowed && hasMore && !loading && (
        <p style={{ fontSize: 12, margin: '-12px 0 16px', color: 'var(--theme-text2)' }}>
          The User filter and search only look through the {logs.length} entries loaded so far. Load more below to search further back.
        </p>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ whiteSpace: 'nowrap' }}><Tip text="The BS date and the time in Nepal when the change was written, whatever timezone this computer is in. The export carries the AD date too." width={240}>Time</Tip></th>
                <th><Tip text="The client property this change belongs to." width={200}>Client</Tip></th>
                <th><Tip text="Who made the change. System means a server process with no signed-in user — an admin operation run through the server, or the trial purge job." width={260}>User</Tip></th>
                <th style={{ textAlign: 'center' }}><Tip text="Added = new record created. Updated = existing record changed. Deleted = record removed. Viewed = a staff PIN was revealed. Purged = old entries were deleted from this log." width={280}>Action</Tip></th>
                <th><Tip text="The module or table the change was made in — e.g. Purchase, Item Master, Payslip." width={240}>Area</Tip></th>
                <th><Tip text="Every field that changed, old value → new value. Open the row to see the full list." width={280}>Details</Tip></th>
              </tr>
            </thead>
            <tbody>
              {!loading && loadError && (
                <tr>
                  <td colSpan={6} style={{ padding: 0 }}><ReportLoadError error={loadError} /></td>
                </tr>
              )}
              {!loading && !loadError && visibleLogs.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 32 }}>
                    {logs.length === 0
                      ? `No audit entries for ${filterClient !== 'all' ? clientName(filterClient) : 'any client'}${filterArea !== 'all' ? ` in ${TABLE_LABELS[filterArea] || filterArea}` : ''} in ${TIME_LABELS[filterTime]}.`
                      : hasMore
                        ? `None of the ${logs.length} entries loaded so far match. Load more below to search further back.`
                        : 'No entry matches the User filter or search.'}
                  </td>
                </tr>
              )}
              {!loadError && visibleLogs.map(log => {
                const act = ACTION_STYLE[log.action] || { label: log.action, color: 'var(--theme-text2)', bg: 'color-mix(in srgb, var(--theme-text2) 10%, transparent)' }
                const fields = diffFields(log)
                const isOpen = expandedId === log.id
                const detailId = `audit-detail-${log.id}`
                const hasBefore = fields.some(f => 'from' in f)
                const hasAfter = fields.some(f => 'to' in f)
                return (
                  <Fragment key={log.id}>
                    <tr>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }} title={nepalDateLong(log.created_at)}>{fmtStamp(log.created_at)}</td>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{log.client_name || '—'}</td>
                      <td style={{ color: 'var(--theme-text3)', fontSize: 13, fontStyle: log.user_name ? 'normal' : 'italic' }}>{userLabel(log)}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: act.color, background: act.bg, padding: '2px 10px', borderRadius: 'var(--radius-sm)', whiteSpace: 'nowrap' }}>
                          {act.label}
                        </span>
                      </td>
                      <td style={{ color: 'var(--theme-accent-ink)', fontSize: 13 }}>{TABLE_LABELS[log.table_name] || log.table_name}</td>
                      <td
                        style={{ fontSize: 13, color: 'var(--theme-text3)', cursor: fields.length ? 'pointer' : 'default' }}
                        onClick={() => fields.length && setExpandedId(isOpen ? null : log.id)}
                      >
                        {fields.length > 0 && (
                          <span style={{ marginRight: 6 }}>
                            <RowDisclosure
                              expanded={isOpen}
                              controls={detailId}
                              label={`${isOpen ? 'Hide' : 'Show'} every changed field`}
                              onToggle={() => setExpandedId(isOpen ? null : log.id)}
                            />
                          </span>
                        )}
                        {summaryText(log, 3)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr id={detailId}>
                        <td colSpan={6} style={{ background: 'var(--theme-input-bg)', padding: '10px 14px 14px 40px' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--theme-text2)', fontWeight: 600 }}>Field</th>
                                {hasBefore && <th style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--theme-text2)', fontWeight: 600 }}>Before</th>}
                                {hasAfter && <th style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--theme-text2)', fontWeight: 600 }}>After</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {fields.map(f => (
                                <tr key={f.key}>
                                  <td style={{ padding: '4px 10px', color: 'var(--theme-text1)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fieldLabel(f.key)}</td>
                                  {hasBefore && <td style={{ padding: '4px 10px', color: 'var(--theme-red-text)' }}>{'from' in f ? formatValue(f.key, f.from) : ''}</td>}
                                  {hasAfter && <td style={{ padding: '4px 10px', color: 'var(--theme-green-text)' }}>{'to' in f ? formatValue(f.key, f.to) : ''}</td>}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--theme-text3)' }}>Record ID: {log.record_id || '—'}</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {hasMore && !loadError && (
          <div style={{ padding: 14, textAlign: 'center', borderTop: '1px solid var(--theme-border)' }}>
            <button type="button" className="btn btn-ghost" onClick={loadMore} disabled={loadingMore || loading}>
              {loadingMore ? 'Loading…' : `Load next ${PAGE_SIZE}`}
            </button>
          </div>
        )}
      </div>

      {purgeOpen && (
        <ConfirmModal
          title="Delete old audit entries"
          confirmLabel="Delete old entries"
          busyLabel="Deleting…"
          danger
          busy={purging}
          onConfirm={runPurge}
          onCancel={() => setPurgeOpen(false)}
        >
          <div className="form-field" style={{ marginBottom: 12 }}>
            <label htmlFor="audit-purge-days">Delete entries older than</label>
            <select id="audit-purge-days" className="form-select" value={purgeDays} onChange={e => setPurgeDays(Number(e.target.value))} disabled={purging}>
              {PURGE_OPTIONS.map(o => <option key={o.days} value={o.days}>{o.label}</option>)}
            </select>
          </div>
          <p style={{ margin: '0 0 8px' }}>
            Every entry for {purgeScope} written more than {PURGE_OPTIONS.find(o => o.days === purgeDays)?.label} ago is
            permanently removed. This cannot be undone.
          </p>
          <p style={{ margin: '0 0 8px' }}>
            Entries from the last 90 days can never be deleted, and this deletion is itself recorded in the log. The Area,
            User and search filters do not narrow it — only age{filterClient !== 'all' ? ' and the client' : ''}.
          </p>
          <ActionError error={purgeError} />
        </ConfirmModal>
      )}
    </div>
  )
}
