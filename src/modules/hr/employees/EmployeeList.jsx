import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
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

export default function EmployeeList() {
  const { clientId, profile } = useAuth()
  const effectiveClientId = clientId || profile?.client_id

  const [employees, setEmployees] = useState([])
  const [loading, setLoading]     = useState(true)
  const [search, setSearch]       = useState('')
  const [statusFilter, setStatus] = useState('all')
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

  const filtered = employees.filter(e => {
    const matchSearch = !search ||
      e.full_name.toLowerCase().includes(search.toLowerCase()) ||
      (e.employee_code || '').toLowerCase().includes(search.toLowerCase()) ||
      (e.department || '').toLowerCase().includes(search.toLowerCase()) ||
      (e.designation || '').toLowerCase().includes(search.toLowerCase())
    const matchStatus = statusFilter === 'all' || e.status === statusFilter
    return matchSearch && matchStatus
  })

  const total      = employees.length
  const active     = employees.filter(e => e.status === 'active').length
  const probation  = employees.filter(e => e.status === 'probation').length
  const payrollAmt = employees
    .filter(e => e.status === 'active' || e.status === 'probation')
    .reduce((s, e) => s + parseFloat(e.basic_salary || 0), 0)

  return (
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Employees</h1>
          <p className="page-subtitle">Employee master — personal info, employment details, salary and banking</p>
        </div>
        <button className="btn btn-primary" onClick={openAdd}>+ Add Employee</button>
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
                <th>Type</th>
                <th>
                  <Tip text="Date joined in BS format." width={160}>Join Date</Tip>
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
                    <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>
                      {EMP_TYPES[e.employment_type] || e.employment_type}
                    </td>
                    <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>
                      {e.join_date ? new Date(e.join_date).toLocaleDateString('en-NP', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
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
    </div>
  )
}
