import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import EmployeeForm from './EmployeeForm'

const STATUS_COLORS = {
  active:      { color: '#34d399', bg: 'rgba(52,211,153,0.1)',  border: 'rgba(52,211,153,0.2)'  },
  probation:   { color: '#c9a84c', bg: 'rgba(201,168,76,0.1)', border: 'rgba(201,168,76,0.2)'  },
  resigned:    { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' },
  terminated:  { color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' },
  inactive:    { color: '#6b7280', bg: 'rgba(107,114,128,0.1)', border: 'rgba(107,114,128,0.2)' },
}

const EMP_TYPES = {
  permanent:  'Permanent',
  probation:  'Probation',
  contract:   'Contract',
  part_time:  'Part-time',
}

const RETIRE_SOON_DAYS = 180

// Retirement status from a retirement_date (AD string): retired (past) / soon (≤180d) / null.
function retireInfo(dateStr) {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0)
  const days = Math.round((d - today) / 86400000)
  if (days < 0)               return { retired: true, label: 'Retired',       color: '#f87171', bg: 'rgba(248,113,113,0.1)', border: 'rgba(248,113,113,0.2)' }
  if (days <= RETIRE_SOON_DAYS) return { soon: true,  label: 'Retiring soon', color: '#c9a84c', bg: 'rgba(201,168,76,0.1)', border: 'rgba(201,168,76,0.2)', days }
  return { future: true, days }
}

function fmtDate(dateStr) {
  return dateStr ? new Date(dateStr).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
}

export default function EmployeeList() {
  const { clientId, profile } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [employees, setEmployees] = useState([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [statusFilter, setStatus] = useState('all')
  const [supFilter, setSupFilter] = useState('all')
  const [retiringOnly, setRetiringOnly] = useState(false)
  const [drawerOpen, setDrawer]   = useState(false)
  const [editing, setEditing]     = useState(null)

  useEffect(() => {
    if (effectiveClientId) fetchEmployees()
  }, [effectiveClientId]) // eslint-disable-line

  async function fetchEmployees() {
    setLoading(true)
    const { data } = await supabase
      .from('hr_employees')
      .select('*')
      .eq('client_id', effectiveClientId)
      .order('full_name')
    setEmployees(data || [])
    setLoading(false)
  }

  function openAdd() { setEditing(null); setDrawer(true) }
  function openEdit(emp) { setEditing(emp); setDrawer(true) }
  function closeDrawer() { setDrawer(false); setEditing(null) }

  // Resolve supervisor names + the set of employees actually used as a supervisor (for the filter).
  const nameById = Object.fromEntries(employees.map(e => [e.id, e.full_name]))
  const supervisorList = employees
    .filter(e => employees.some(x => x.supervisor_id === e.id))
    .sort((a, b) => a.full_name.localeCompare(b.full_name))

  const filtered = employees.filter(e => {
    const matchSearch = !search ||
      e.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (e.employee_code || '').toLowerCase().includes(search.toLowerCase()) ||
      (e.department || '').toLowerCase().includes(search.toLowerCase()) ||
      (e.designation || '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || e.status === statusFilter
    const matchSup = supFilter === 'all'
      || (supFilter === 'none' ? !e.supervisor_id : e.supervisor_id === supFilter)
    const matchRetire = !retiringOnly || !!retireInfo(e.retirement_date)?.soon
    return matchSearch && matchStatus && matchSup && matchRetire
  })

  const total      = employees.length
  const active     = employees.filter(e => e.status === 'active').length
  const probation  = employees.filter(e => e.status === 'probation').length
  const payrollAmt = employees
    .filter(e => e.status === 'active' || e.status === 'probation')
    .reduce((s, e) => s + parseFloat(e.basic_salary || 0), 0)
  // Active/probation employees retiring within the next 180 days.
  const retiringSoon = employees.filter(e =>
    (e.status === 'active' || e.status === 'probation') && retireInfo(e.retirement_date)?.soon).length

  return (
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-subtitle">Employee master — personal info, employment details, salary and banking</p>
        </div>
      </div>

      {/* Stat cards */}
      <div className="stat-grid" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Employees</div>
          <div className="stat-value">{total}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Active</div>
          <div className="stat-value" style={{ color: '#34d399' }}>{active}</div>
          {probation > 0 && <div className="stat-sub" style={{ color: '#c9a84c' }}>{probation} on probation</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Sum of basic salary for all active and probation employees. Full payroll (with allowances, SSF, TDS) is computed during payroll run." width={260}>
              Basic Payroll / Month
            </Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 16 }}>
            NPR {Math.round(payrollAmt).toLocaleString('en-NP')}
          </div>
          <div className="stat-sub">basic salary only</div>
        </div>
        <div className="stat-card" style={retiringSoon > 0 ? { cursor: 'pointer' } : undefined} onClick={() => retiringSoon > 0 && setRetiringOnly(v => !v)}>
          <div className="stat-label">
            <Tip text="Active or probation employees whose retirement date falls within the next 180 days. Click to filter." width={260}>
              Retiring Soon
            </Tip>
          </div>
          <div className="stat-value" style={{ color: retiringSoon > 0 ? '#c9a84c' : '#34d399' }}>{retiringSoon}</div>
          <div className="stat-sub">within 180 days</div>
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          style={{
            background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6,
            padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 260
          }}
          placeholder="Search name, code, department…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="tab-bar" style={{ marginBottom: 0 }}>
          {['all','active','probation','resigned','terminated','inactive'].map(s => (
            <button
              key={s}
              className={`tab-btn${statusFilter === s ? ' tab-btn--active' : ''}`}
              onClick={() => setStatus(s)}
            >
              {s === 'all' ? 'All' : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        {supervisorList.length > 0 && (
          <select
            className="form-select"
            value={supFilter}
            onChange={e => setSupFilter(e.target.value)}
            title="Filter by reporting supervisor"
          >
            <option value="all">All supervisors</option>
            <option value="none">No supervisor</option>
            {supervisorList.map(s => <option key={s.id} value={s.id}>{s.full_name}</option>)}
          </select>
        )}
        <button
          className={`tab-btn${retiringOnly ? ' tab-btn--active' : ''}`}
          onClick={() => setRetiringOnly(v => !v)}
          title="Show only employees retiring within 180 days"
        >
          Retiring soon
        </button>
      </div>

      {/* Table */}
      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">👤</div>
          <p className="empty-state-text">
            {employees.length === 0
              ? 'No employees yet. Add your first employee to get started.'
              : 'No employees match the current filter.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Designation</th>
                <th>Department</th>
                <th>Supervisor</th>
                <th>Type</th>
                <th>
                  <Tip text="Date joined." width={160}>Join Date</Tip>
                </th>
                <th>
                  <Tip text="Expected retirement date (DOB + 60, SSF pension age). Flags employees retiring within 180 days." width={280}>Retirement</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="Basic salary per month in NPR. Does not include allowances." width={220}>Basic (NPR)</Tip>
                </th>
                <th style={{ textAlign: 'center' }}>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(e => {
                const s = STATUS_COLORS[e.status] || STATUS_COLORS.inactive
                return (
                  <tr key={e.id}>
                    <td style={{ color: 'var(--theme-accent)', fontWeight: 700, fontSize: 12 }}>
                      {e.employee_code || '—'}
                    </td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{e.full_name}</td>
                    <td style={{ color: 'var(--theme-text2)' }}>{e.designation || '—'}</td>
                    <td>{e.department
                      ? <span className="badge badge-yellow">{e.department}</span>
                      : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                    </td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                      {e.supervisor_id ? (nameById[e.supervisor_id] || '—') : '—'}
                    </td>
                    <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>
                      {EMP_TYPES[e.employment_type] || e.employment_type}
                    </td>
                    <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>
                      {fmtDate(e.join_date)}
                    </td>
                    <td style={{ fontSize: 12 }}>
                      {(() => {
                        const r = retireInfo(e.retirement_date)
                        if (!e.retirement_date) return <span style={{ color: 'var(--theme-text3)' }}>—</span>
                        return (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ color: 'var(--theme-text3)' }}>{fmtDate(e.retirement_date)}</span>
                            {r && (r.soon || r.retired) && (
                              <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 4, color: r.color, background: r.bg, border: `1px solid ${r.border}` }}>
                                {r.label}
                              </span>
                            )}
                          </span>
                        )
                      })()}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {parseFloat(e.basic_salary || 0).toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        color: s.color, background: s.bg, border: `1px solid ${s.border}`,
                      }}>
                        {e.status.charAt(0).toUpperCase() + e.status.slice(1)}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: 11, padding: '3px 10px' }}
                        onClick={() => openEdit(e)}
                      >
                        Edit
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {drawerOpen && (
        <EmployeeForm
          clientId={effectiveClientId}
          employee={editing}
          onSave={() => { closeDrawer(); fetchEmployees() }}
          onClose={closeDrawer}
        />
      )}

      <Fab onClick={openAdd} label="+ Add Employee" show={!drawerOpen} />
    </div>
  )
}
