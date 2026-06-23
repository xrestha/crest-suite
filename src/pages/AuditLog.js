import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'

const TABLE_LABELS = {
  purchase_entries: 'Purchase',
  vendor_returns:   'Return',
  opening_stock:    'Opening Stock',
  closing_stock:    'Closing Stock',
  wastages:         'Wastage',
  monthly_periods:  'Period',
  items:            'Item Master',
  // HR module
  hr_employees:           'Employee',
  hr_salary_components:   'Salary',
  hr_attendance:          'Attendance',
  hr_payroll_runs:        'Payroll Run',
  hr_payslips:            'Payslip',
  hr_festival_allowances: 'Festival',
  hr_leave_types:         'Leave Type',
  hr_leave_requests:      'Leave Request',
  // User management
  profiles:               'User',
}

const ACTION_STYLE = {
  INSERT: { label: 'Added',   color: '#34d399', bg: 'rgba(52,211,153,0.12)' },
  UPDATE: { label: 'Updated', color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
  DELETE: { label: 'Deleted', color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
}


function getSummary(log) {
  const d = log.new_data || log.old_data
  if (!d) return '—'
  switch (log.table_name) {
    case 'purchase_entries':
      return `Qty: ${parseFloat(d.qty || 0).toLocaleString()} · Rate: NPR ${parseFloat(d.rate || 0).toLocaleString()}`
    case 'vendor_returns':
      return `Qty: ${parseFloat(d.qty || 0).toLocaleString()}`
    case 'opening_stock':
      return `Qty: ${parseFloat(d.qty || 0).toLocaleString()}`
    case 'closing_stock':
      return `Physical: ${parseFloat(d.physical_qty || 0).toLocaleString()}`
    case 'wastages':
      return `Qty: ${parseFloat(d.qty || 0).toLocaleString()}`
    case 'monthly_periods':
      if (log.action === 'UPDATE' && log.old_data && log.new_data)
        return `${log.old_data.status} → ${log.new_data.status}`
      return `Status: ${d.status}`
    case 'items': {
      const name = d.name || '—'
      if (log.action === 'UPDATE' && log.old_data && log.new_data) {
        const parts = []
        if (log.old_data.name !== log.new_data.name) parts.push(`Name: ${log.old_data.name} → ${log.new_data.name}`)
        if (parseFloat(log.old_data.rate) !== parseFloat(log.new_data.rate)) parts.push(`Rate: NPR ${parseFloat(log.old_data.rate || 0).toLocaleString()} → NPR ${parseFloat(log.new_data.rate || 0).toLocaleString()}`)
        if (log.old_data.uom !== log.new_data.uom) parts.push(`UOM: ${log.old_data.uom} → ${log.new_data.uom}`)
        return parts.length ? `${name} · ${parts.join(' · ')}` : `${name} (updated)`
      }
      return `${name} · ${d.uom || ''} · NPR ${parseFloat(d.rate || 0).toLocaleString()}`
    }
    case 'hr_employees':
      return `${d.full_name || '—'}${d.designation ? ' · ' + d.designation : ''}${d.status ? ' · ' + d.status : ''}`
    case 'hr_salary_components':
      return `${d.name || '—'}: ${d.calc_type === 'percent_of_basic' ? (d.value || 0) + '%' : 'NPR ' + parseFloat(d.value || 0).toLocaleString()}`
    case 'hr_attendance':
      return `Day ${d.bs_day}: ${d.status}`
    case 'hr_payroll_runs':
      if (log.action === 'UPDATE' && log.old_data && log.new_data) return `${log.old_data.status} → ${log.new_data.status}`
      return `Status: ${d.status || '—'}`
    case 'hr_payslips':
      return `Net: NPR ${parseFloat(d.net_pay || 0).toLocaleString()}`
    case 'hr_festival_allowances':
      return `${d.festival_name || 'Festival'} ${d.bs_year || ''}: NPR ${parseFloat(d.amount || 0).toLocaleString()}`
    case 'hr_leave_types':
      return `${d.name || '—'}${d.annual_quota ? ' · ' + d.annual_quota + ' days' : ''}`
    case 'hr_leave_requests':
      return `${d.status || '—'} · ${d.days || 0} day(s)`
    case 'profiles':
      if (log.action === 'UPDATE' && log.old_data && log.new_data) {
        const parts = []
        if (log.old_data.role !== log.new_data.role) parts.push(`role: ${log.old_data.role} → ${log.new_data.role}`)
        if (log.old_data.client_id !== log.new_data.client_id) parts.push('client changed')
        return `${d.full_name || '—'}${parts.length ? ' · ' + parts.join(' · ') : ''}`
      }
      return `${d.full_name || '—'}${d.role ? ' · ' + d.role : ''}`
    default:
      return '—'
  }
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
  { area: 'Payroll Run',   icon: '💵', ops: 'Status change',       note: 'Payroll run draft / finalize' },
  { area: 'Festival',      icon: '🎉', ops: 'Add · Edit · Delete', note: 'Festival allowance entries' },
  { area: 'Leave Type',    icon: '🏖️', ops: 'Add · Edit · Delete', note: 'Leave entitlement definitions' },
  { area: 'Leave Request', icon: '🗓️', ops: 'Add · Edit · Delete', note: 'Leave applications & approvals' },
  { area: 'User',          icon: '⊛',  ops: 'Add · Edit · Delete', note: 'Client login created / reassigned / removed' },
]

export default function AuditLog() {
  const { loading: authLoading } = useAuth()
  const [logs, setLogs]             = useState([])
  const [clients, setClients]       = useState([])
  const [loading, setLoading]       = useState(true)
  const [filterClient, setFilterClient] = useState('all')
  const [filterArea, setFilterArea]     = useState('all')
  const [filterTime, setFilterTime]     = useState('7d')
  const [helpOpen, setHelpOpen]         = useState(false)

  useEffect(() => { if (!authLoading) init() }, [authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    const { data: c } = await supabase.from('clients').select('id, name').order('name')
    setClients(c || [])
    await fetchLogs('all', 'all', '7d')
  }

  async function fetchLogs(client, area, time) {
    setLoading(true)
    let q = supabase.from('audit_logs').select('*').order('created_at', { ascending: false }).limit(500)

    if (client !== 'all') q = q.eq('client_id', client)
    if (area   !== 'all') q = q.eq('table_name', area)

    if (time !== 'all') {
      const start = new Date()
      if (time === 'today') start.setHours(0, 0, 0, 0)
      else if (time === '7d')  start.setDate(start.getDate() - 7)
      else if (time === '30d') start.setDate(start.getDate() - 30)
      q = q.gte('created_at', start.toISOString())
    }

    const { data } = await q
    setLogs(data || [])
    setLoading(false)
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
    if (!window.confirm(
      `Delete ${logs.length} audit log entries (${timeLabel}, ${clientLabel})?\n\nThis cannot be undone.`
    )) return

    let cutoff = null
    if (filterTime !== 'all') {
      const start = new Date()
      if (filterTime === 'today') start.setHours(0, 0, 0, 0)
      else if (filterTime === '7d')  start.setDate(start.getDate() - 7)
      else if (filterTime === '30d') start.setDate(start.getDate() - 30)
      cutoff = start.toISOString()
    }
    const { error } = await supabase.rpc('admin_clear_audit_logs', {
      p_client_id:  filterClient !== 'all' ? filterClient : null,
      p_table_name: filterArea   !== 'all' ? filterArea   : null,
      p_cutoff:     cutoff,
    })
    if (error) { alert('Error: ' + error.message); return }
    await fetchLogs(filterClient, filterArea, filterTime)
  }

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Audit Log</h1>
          <p className="page-subtitle">Track all data changes across clients</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {logs.length > 0 && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}
              onClick={clearLogs}
            >
              ✕ Clear Logs
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => fetchLogs(filterClient, filterArea, filterTime)}>↻ Refresh</button>
        </div>
      </div>

      {/* Help panel */}
      <div style={{ marginBottom: 20 }}>
        <button
          onClick={() => setHelpOpen(o => !o)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13, padding: 0 }}
        >
          <span style={{ fontSize: 15 }}>{helpOpen ? '▾' : '▸'}</span>
          What does the Audit Log record?
        </button>
        {helpOpen && (
          <div style={{ marginTop: 12, background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 8, overflow: 'hidden' }}>
            <div className="table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #2a2f3d' }}>
                  <th style={{ textAlign: 'left', padding: '8px 14px', color: '#6b7280', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Area</th>
                  <th style={{ textAlign: 'left', padding: '8px 14px', color: '#6b7280', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Operations tracked</th>
                  <th style={{ textAlign: 'left', padding: '8px 14px', color: '#6b7280', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {HELP_ITEMS.map((h, i) => (
                  <tr key={h.area} style={{ borderBottom: i < HELP_ITEMS.length - 1 ? '1px solid #1e2330' : 'none' }}>
                    <td style={{ padding: '9px 14px', color: '#e8e0d0', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <span style={{ marginRight: 7, color: '#c9a84c' }}>{h.icon}</span>{h.area}
                    </td>
                    <td style={{ padding: '9px 14px', color: '#34d399', fontFamily: 'monospace', fontSize: 12 }}>{h.ops}</td>
                    <td style={{ padding: '9px 14px', color: '#9ca3af' }}>{h.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div style={{ padding: '10px 14px', borderTop: '1px solid #2a2f3d', color: '#6b7280', fontSize: 12 }}>
              Logs are written by database triggers — they capture all changes regardless of which user or device made them. HR and client-login changes are tracked; sales, vendors, and recipes are not.
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="form-select" value={filterClient} onChange={e => applyFilter(e.target.value, filterArea, filterTime)}>
          <option value="all">All Clients</option>
          {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="form-select" value={filterArea} onChange={e => applyFilter(filterClient, e.target.value, filterTime)}>
          <option value="all">All Areas</option>
          {Object.entries(TABLE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="form-select" value={filterTime} onChange={e => applyFilter(filterClient, filterArea, e.target.value)}>
          <option value="today">Today</option>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="all">All time</option>
        </select>
        <span style={{ fontSize: 13, color: '#6b7280' }}>
          {loading ? 'Loading…' : `${logs.length} entries`}
        </span>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ whiteSpace: 'nowrap' }}>Time</th>
                <th>Client</th>
                <th>User</th>
                <th style={{ textAlign: 'center' }}>Action</th>
                <th>Area</th>
                <th>Summary</th>
              </tr>
            </thead>
            <tbody>
              {!loading && logs.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: '#6b7280', padding: 32 }}>
                    No entries found for the selected filters.
                  </td>
                </tr>
              )}
              {logs.map(log => {
                const act = ACTION_STYLE[log.action] || { label: log.action, color: '#6b7280', bg: 'rgba(107,114,128,0.12)' }
                return (
                  <tr key={log.id}>
                    <td style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' }}>{fmtTime(log.created_at)}</td>
                    <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{log.client_name || '—'}</td>
                    <td style={{ color: '#9ca3af', fontSize: 13 }}>{log.user_name || '—'}</td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: act.color, background: act.bg, padding: '2px 10px', borderRadius: 10, whiteSpace: 'nowrap' }}>
                        {act.label}
                      </span>
                    </td>
                    <td style={{ color: '#c9a84c', fontSize: 13 }}>{TABLE_LABELS[log.table_name] || log.table_name}</td>
                    <td style={{ fontSize: 13, color: '#9ca3af' }}>{getSummary(log)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
