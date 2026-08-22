import { Fragment, useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const PAGE_SIZE = 500

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
  // POS module
  pos_orders:             'POS Order',
  pos_credit_notes:       'Credit Note',
  // User & client management
  profiles:               'User',
  clients:                'Client Account',
  feature_flags:          'Feature Flags',
}

// `color` here is pure badge TEXT (`bg` is its own key), so it takes the -text variants — the
// base tokens measured 3.04–3.61:1 at 11px/700 on Rosé Dawn (S574). The bg tints stay literal
// rgba per DESIGN.md's documented pattern (alpha fill + full-opacity signal text).
const ACTION_STYLE = {
  INSERT: { label: 'Added',   color: 'var(--theme-green-text)', bg: 'rgba(52,211,153,0.12)' },
  UPDATE: { label: 'Updated', color: 'var(--theme-purple-text)', bg: 'rgba(167,139,250,0.12)' },
  DELETE: { label: 'Deleted', color: 'var(--theme-red-text)', bg: 'rgba(248,113,113,0.12)' },
}

// Columns that churn on nearly every write (housekeeping timestamps, PIN-lockout counters
// bumped on every login attempt, session keep-alive) or that must never reach the UI at all
// (the anon-facing POS device secret) — never worth showing as a "change".
const IGNORE_KEYS = new Set([
  'id', 'created_at', 'updated_at', 'client_id',
  'pos_pin_failed_attempts', 'pos_pin_locked_until',
  'hr_pin_failed_attempts', 'hr_pin_locked_until', 'last_seen_at',
  'pos_device_secret',
])

// Table-specific noise on top of the global list — fields that legitimately change on almost
// every touch of that row but aren't themselves the audit-worthy event (e.g. a bill reprint
// bumping print_count while status/discount/void stay the same).
const TABLE_EXTRA_IGNORE = {
  pos_orders: new Set(['covers', 'print_count', 'comp_print_count']),
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
}

function fieldLabel(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key]
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

const CURRENCY_KEY = /rate|amount|price|total|gross|net|basic|value|cost|discount|paid|tendered|allowance|deduction|ssf|tds|salary/i
const DATE_KEY = /_at$|_date$/i

function formatValue(key, val) {
  if (val === null || val === undefined || val === '') return '—'
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (typeof val === 'number') {
    if (CURRENCY_KEY.test(key)) return `NPR ${val.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    return val.toLocaleString()
  }
  if (typeof val === 'string') {
    if (DATE_KEY.test(key) && !isNaN(Date.parse(val))) return fmtTime(val)
    return val.length > 80 ? val.slice(0, 80) + '…' : val
  }
  if (typeof val === 'object') {
    const s = JSON.stringify(val)
    return s.length > 60 ? s.slice(0, 60) + '…' : s
  }
  return String(val)
}

// The single source of truth for "what changed" — every table, past and future, gets this for
// free instead of needing its own hand-written case (the gap that left profile edits like
// pos_discount_limit/pos_allow_void showing no detail at all).
function diffFields(log) {
  const ignore = new Set([...IGNORE_KEYS, ...(TABLE_EXTRA_IGNORE[log.table_name] || [])])
  if (log.action === 'INSERT') {
    const d = log.new_data || {}
    return Object.keys(d).filter(k => !ignore.has(k) && d[k] !== null && d[k] !== '').map(k => ({ key: k, to: d[k] }))
  }
  if (log.action === 'DELETE') {
    const d = log.old_data || {}
    return Object.keys(d).filter(k => !ignore.has(k) && d[k] !== null && d[k] !== '').map(k => ({ key: k, from: d[k] }))
  }
  const o = log.old_data || {}
  const n = log.new_data || {}
  const keys = new Set([...Object.keys(o), ...Object.keys(n)])
  const changed = []
  keys.forEach(k => {
    if (ignore.has(k)) return
    if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) changed.push({ key: k, from: o[k], to: n[k] })
  })
  return changed
}

function fieldText(log, f) {
  if (log.action === 'INSERT') return `${fieldLabel(f.key)}: ${formatValue(f.key, f.to)}`
  if (log.action === 'DELETE') return `${fieldLabel(f.key)}: ${formatValue(f.key, f.from)}`
  return `${fieldLabel(f.key)}: ${formatValue(f.key, f.from)} → ${formatValue(f.key, f.to)}`
}

function summaryText(log, cap) {
  const fields = diffFields(log)
  if (fields.length === 0) return log.action === 'UPDATE' ? '(no tracked field changed)' : '—'
  if (!cap) return fields.map(f => fieldText(log, f)).join(' · ')
  const shown = fields.slice(0, cap).map(f => fieldText(log, f))
  const extra = fields.length > cap ? ` +${fields.length - cap} more` : ''
  return shown.join(' · ') + extra
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

const HELP_ITEMS = [
  { area: 'Purchase',      icon: '↓', ops: 'Add · Edit · Delete', note: 'Every purchase entry change per client' },
  { area: 'Return',        icon: '↩', ops: 'Add · Edit · Delete', note: 'Vendor returns against purchase entries' },
  { area: 'Opening Stock', icon: '□', ops: 'Add · Edit · Delete', note: 'Opening stock qty entries per period' },
  { area: 'Closing Stock', icon: '□', ops: 'Add · Edit · Delete', note: 'Physical closing count entries' },
  { area: 'Wastage',       icon: '✕', ops: 'Add · Edit · Delete', note: 'Wastage entries per period' },
  { area: 'Period',        icon: '◷', ops: 'Status change only',  note: 'Logged when period is opened or closed' },
  { area: 'Item Master',  icon: '≡', ops: 'Add · Edit · Delete', note: 'Item name, UOM, rate — shows what changed on edits' },
  { area: 'Employee',      icon: '👤', ops: 'Add · Edit · Delete', note: 'HR employee master records' },
  { area: 'Salary',        icon: '₿',  ops: 'Add · Edit · Delete', note: 'Salary components per employee' },
  { area: 'Attendance',    icon: '🕘', ops: 'Add · Edit · Delete', note: 'Daily attendance status per employee' },
  { area: 'Payroll Run',   icon: '💵', ops: 'Status change',       note: 'Payroll run draft / finalize' },
  { area: 'Payslip',       icon: '🧾', ops: 'Add · Edit · Delete', note: 'Generated payslips per payroll run' },
  { area: 'Festival',      icon: '🎉', ops: 'Add · Edit · Delete', note: 'Festival allowance entries' },
  { area: 'Leave Type',    icon: '🏖️', ops: 'Add · Edit · Delete', note: 'Leave entitlement definitions' },
  { area: 'Leave Request', icon: '🗓️', ops: 'Add · Edit · Delete', note: 'Leave applications & approvals' },
  { area: 'POS Order',     icon: '🧮', ops: 'Status change',       note: 'Void, discount, close type, invoice no. and credit settlement — not every item edit or bill reprint' },
  { area: 'Credit Note',   icon: '↩', ops: 'Add',                 note: 'Credit notes issued against a closed POS invoice' },
  { area: 'User',          icon: '⊛',  ops: 'Add · Edit · Delete', note: 'Client login created / reassigned / removed, incl. per-staff POS/IMS/HR role & permission changes' },
  { area: 'Client Account', icon: '🏢', ops: 'Add · Edit · Delete', note: 'Plan tier, module enable/disable, trial & subscription dates — the Admin Clients page itself' },
  { area: 'Feature Flags', icon: '🚩', ops: 'Add · Edit · Delete', note: 'Admin-granted feature overrides above a client\'s plan tier' },
]

export default function AuditLog() {
  const { loading: authLoading } = useAuth()
  const [logs, setLogs]             = useState([])
  const [clients, setClients]       = useState([])
  const [loading, setLoading]       = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore]       = useState(false)
  const [filterClient, setFilterClient] = useState('all')
  const [filterArea, setFilterArea]     = useState('all')
  const [filterTime, setFilterTime]     = useState('7d')
  const [filterUser, setFilterUser]     = useState('all')
  const [clearMsg, setClearMsg]         = useState('')
  const [search, setSearch]             = useState('')
  const [helpOpen, setHelpOpen]         = useState(false)
  const [expandedId, setExpandedId]     = useState(null)

  useEffect(() => { if (!authLoading) init() }, [authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    const { data: c } = await supabase.from('clients').select('id, name').order('name')
    setClients(c || [])
    await fetchLogs('all', 'all', '7d')
  }

  function baseQuery(client, area, time) {
    let q = supabase.from('audit_logs').select('*').order('created_at', { ascending: false })
    if (client !== 'all') q = q.eq('client_id', client)
    if (area   !== 'all') q = q.eq('table_name', area)
    if (time !== 'all') {
      const start = new Date()
      if (time === 'today') start.setHours(0, 0, 0, 0)
      else if (time === '7d')  start.setDate(start.getDate() - 7)
      else if (time === '30d') start.setDate(start.getDate() - 30)
      q = q.gte('created_at', start.toISOString())
    }
    return q
  }

  async function fetchLogs(client, area, time) {
    setLoading(true)
    setExpandedId(null)
    const { data } = await baseQuery(client, area, time).limit(PAGE_SIZE)
    setLogs(data || [])
    setHasMore((data || []).length === PAGE_SIZE)
    setLoading(false)
  }

  async function loadMore() {
    if (!logs.length) return
    setLoadingMore(true)
    const cursor = logs[logs.length - 1].created_at
    const { data } = await baseQuery(filterClient, filterArea, filterTime).lt('created_at', cursor).limit(PAGE_SIZE)
    setLogs(prev => [...prev, ...(data || [])])
    setHasMore((data || []).length === PAGE_SIZE)
    setLoadingMore(false)
  }

  function applyFilter(client, area, time) {
    setFilterClient(client)
    setFilterArea(area)
    setFilterTime(time)
    fetchLogs(client, area, time)
  }

  async function clearLogs() {
    const timeLabel = { today: 'today', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all time' }[filterTime]
    const clientLabel = filterClient !== 'all'
      ? `for "${clients.find(c => c.id === filterClient)?.name}"`
      : 'for all clients'
    // The confirm must describe what the RPC actually deletes: time + client + AREA. It used to
    // omit the Area filter it applied, and said nothing about the User/search narrowing it does
    // NOT apply — an operator filtered to one user, seeing 12 rows, was deleting the whole
    // time+client+area window (S574).
    const areaLabel = filterArea !== 'all' ? `, area "${TABLE_LABELS[filterArea] || filterArea}"` : ', all areas'
    const ignoredNote = (filterUser !== 'all' || search.trim())
      ? '\n\n⚠ The User filter and search box do NOT narrow what is deleted — everything in the range above goes.'
      : ''
    if (!window.confirm(
      `Delete ${logs.length}${hasMore ? '+' : ''} audit log entries (${timeLabel}, ${clientLabel}${areaLabel})?${ignoredNote}\n\nThis cannot be undone.`
    )) return

    let cutoff = null
    if (filterTime !== 'all') {
      const start = new Date()
      if (filterTime === 'today') start.setHours(0, 0, 0, 0)
      else if (filterTime === '7d')  start.setDate(start.getDate() - 7)
      else if (filterTime === '30d') start.setDate(start.getDate() - 30)
      cutoff = start.toISOString()
    }
    const { data: deletedCount, error } = await supabase.rpc('admin_clear_audit_logs', {
      p_client_id:  filterClient !== 'all' ? filterClient : null,
      p_table_name: filterArea   !== 'all' ? filterArea   : null,
      p_cutoff:     cutoff,
    })
    // Inline like every other failure on this page — this was the scope's only bare alert().
    // And the RPC returns how many rows went; discarding it left the operator with no statement
    // of what a destructive action on the audit trail actually did.
    if (error) { setClearMsg('error:Clear failed: ' + error.message); return }
    setClearMsg(`ok:${(deletedCount ?? 0).toLocaleString()} audit log entries deleted (${timeLabel}, ${clientLabel}${areaLabel}).`)
    await fetchLogs(filterClient, filterArea, filterTime)
  }

  // User/search are applied client-side over whatever's currently loaded — same 500-per-page
  // window the table itself already worked within, just narrowed further without a round trip.
  const userOptions = Array.from(new Set(logs.map(l => l.user_name).filter(Boolean))).sort()
  const q = search.trim().toLowerCase()
  const visibleLogs = logs.filter(log => {
    if (filterUser !== 'all' && log.user_name !== filterUser) return false
    if (!q) return true
    const haystack = [
      log.user_name, log.client_name, TABLE_LABELS[log.table_name] || log.table_name,
      log.record_id, summaryText(log),
    ].filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(q)
  })

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const rows = visibleLogs.map(log => ({
      Time: fmtTime(log.created_at),
      Client: log.client_name || '—',
      User: log.user_name || '—',
      Action: ACTION_STYLE[log.action]?.label || log.action,
      Area: TABLE_LABELS[log.table_name] || log.table_name,
      Details: summaryText(log),
      'Record ID': log.record_id || '',
    }))
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Log')
    XLSX.writeFile(wb, `audit-log-${new Date().toISOString().slice(0, 10)}.xlsx`)
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-subtitle">Track all data changes across clients</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {visibleLogs.length > 0 && (
            <button className="btn btn-ghost" onClick={exportExcel}>⬇ Export</button>
          )}
          {logs.length > 0 && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'rgba(248,113,113,0.3)' }}
              onClick={clearLogs}
            >
              ✕ Clear Logs
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => fetchLogs(filterClient, filterArea, filterTime)}>↻ Refresh</button>
        </div>
      </div>

      {clearMsg && (
        <p role={clearMsg.startsWith('ok:') ? 'status' : 'alert'}
          style={{ fontSize: 12, margin: '0 0 12px', color: clearMsg.startsWith('ok:') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
          {clearMsg.replace(/^(ok|error):/, '')}
        </p>
      )}

      {/* Help panel */}
      <div style={{ marginBottom: 20 }}>
        <button
          onClick={() => setHelpOpen(o => !o)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--theme-text2)', fontSize: 13, padding: 0 }}
        >
          <span style={{ fontSize: 15 }}>{helpOpen ? '▾' : '▸'}</span>
          What does the Audit Log record?
        </button>
        {helpOpen && (
          <div style={{ marginTop: 12, background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 8, overflow: 'hidden' }}>
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
                      <span style={{ marginRight: 7, color: 'var(--theme-accent)' }}>{h.icon}</span>{h.area}
                    </td>
                    <td style={{ padding: '9px 14px', color: 'var(--theme-green-text)', fontFamily: 'monospace', fontSize: 12 }}>{h.ops}</td>
                    <td style={{ padding: '9px 14px', color: 'var(--theme-text3)' }}>{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{ padding: '10px 14px', borderTop: '1px solid var(--theme-border)', color: 'var(--theme-text2)', fontSize: 12 }}>
              Logs are written by database triggers — they capture all changes regardless of which user or device made them.
              Sales entries, vendors, recipes, and individual POS line items/prints are not tracked; a POS order is tracked for its status/void/discount/invoice transitions only, not every item added or removed while the bill is still open.
              Click any row's Details cell to see every changed field, not just the first few.
            </div>
          </div>
        )}
      </div>

      {/* .sr-only labels + ids: these five controls had no accessible name at all — a screen
          reader announced four unlabelled comboboxes whose only "name" was the selected value.
          The S569 htmlFor sweep matched .form-field files and this page's bare .form-select
          controls fell outside its shape (S574). Pattern from AdminDashboardOverview.jsx. */}
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
          className="form-select"
          placeholder="Search client, user, field, record ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 'auto' }}>
          {loading ? 'Loading…' : `${visibleLogs.length}${visibleLogs.length !== logs.length ? ` of ${logs.length}` : ''} entries${hasMore ? '+' : ''}`}
        </span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ whiteSpace: 'nowrap' }}><Tip text="BS date and time (Nepal time) when the action was recorded." width={220}>Time</Tip></th>
                <th><Tip text="The client property this change belongs to." width={200}>Client</Tip></th>
                <th><Tip text="Name of the user who performed the action." width={220}>User</Tip></th>
                <th style={{ textAlign: 'center' }}><Tip text="Added = new record created. Updated = existing record changed. Deleted = record removed." width={260}>Action</Tip></th>
                <th><Tip text="The module or table the change was made in — e.g. Purchase, Recipe, Stock." width={240}>Area</Tip></th>
                <th><Tip text="Every field that changed, old value → new value. Click to expand the full list." width={280}>Details</Tip></th>
              </tr>
            </thead>
            <tbody>
              {!loading && visibleLogs.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 32 }}>
                    No entries found for the selected filters.
                  </td>
                </tr>
              )}
              {visibleLogs.map(log => {
                const act = ACTION_STYLE[log.action] || { label: log.action, color: 'var(--theme-text2)', bg: 'rgba(138,146,163,0.10)' }
                const fields = diffFields(log)
                const isOpen = expandedId === log.id
                return (
                  <Fragment key={log.id}>
                    <tr>
                      <td style={{ fontSize: 12, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{fmtTime(log.created_at)}</td>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{log.client_name || '—'}</td>
                      <td style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{log.user_name || '—'}</td>
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
                        {fields.length > 0 && <span style={{ marginRight: 6, color: 'var(--theme-text2)' }}>{isOpen ? '▾' : '▸'}</span>}
                        {summaryText(log, 3)}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={6} style={{ background: 'var(--theme-input-bg)', padding: '10px 14px 14px 40px' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--theme-text2)', fontWeight: 600 }}>Field</th>
                                {log.action !== 'INSERT' && <th style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--theme-text2)', fontWeight: 600 }}>Before</th>}
                                {log.action !== 'DELETE' && <th style={{ textAlign: 'left', padding: '4px 10px', color: 'var(--theme-text2)', fontWeight: 600 }}>After</th>}
                              </tr>
                            </thead>
                            <tbody>
                              {fields.map(f => (
                                <tr key={f.key}>
                                  <td style={{ padding: '4px 10px', color: 'var(--theme-text1)', fontWeight: 600, whiteSpace: 'nowrap' }}>{fieldLabel(f.key)}</td>
                                  {log.action !== 'INSERT' && <td style={{ padding: '4px 10px', color: 'var(--theme-red-text)' }}>{formatValue(f.key, f.from)}</td>}
                                  {log.action !== 'DELETE' && <td style={{ padding: '4px 10px', color: 'var(--theme-green-text)' }}>{formatValue(f.key, f.to)}</td>}
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
        {hasMore && (
          <div style={{ padding: 14, textAlign: 'center', borderTop: '1px solid var(--theme-border)' }}>
            <button className="btn btn-ghost" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : `Load next ${PAGE_SIZE}`}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
