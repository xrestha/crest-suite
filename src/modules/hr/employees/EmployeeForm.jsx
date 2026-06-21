import { useState } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'

const EMPTY = {
  employee_code: '',
  full_name: '',
  gender: '',
  date_of_birth: '',
  pan_no: '',
  citizenship_no: '',
  designation: '',
  department: '',
  employment_type: 'permanent',
  join_date: '',
  end_date: '',
  status: 'active',
  phone: '',
  email: '',
  address: '',
  emergency_contact_name: '',
  emergency_contact_phone: '',
  bank_name: '',
  bank_account_no: '',
  bank_branch: '',
  ssf_no: '',
  basic_salary: '',
  notes: '',
}

const TABS = [
  { key: 'personal',   label: 'Personal'   },
  { key: 'employment', label: 'Employment' },
  { key: 'salary',     label: 'Salary'     },
  { key: 'bank',       label: 'Bank / SSF' },
]

const inp = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6,
  padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: '100%',
  fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'block', letterSpacing: '0.02em' }
const row = { display: 'flex', gap: 12 }
const col = { flex: 1, display: 'flex', flexDirection: 'column' }

export default function EmployeeForm({ clientId, employee, onSave, onClose }) {
  const isEdit = !!employee
  const [tab, setTab]     = useState('personal')
  const [form, setForm]   = useState(isEdit ? { ...EMPTY, ...employee } : { ...EMPTY })
  const [saving, setSaving] = useState(false)
  const [error, setError]   = useState('')

  function set(field, value) { setForm(f => ({ ...f, [field]: value })) }

  async function handleSave() {
    if (!form.full_name.trim()) { setError('Full name is required.'); setTab('personal'); return }
    if (!form.join_date)        { setError('Join date is required.'); setTab('employment'); return }
    setError('')
    setSaving(true)

    const payload = {
      ...form,
      client_id:     clientId,
      full_name:     form.full_name.trim(),
      basic_salary:  parseFloat(form.basic_salary) || 0,
      date_of_birth: form.date_of_birth || null,
      end_date:      form.end_date || null,
    }

    const { error: err } = isEdit
      ? await supabase.from('hr_employees').update(payload).eq('id', employee.id)
      : await supabase.from('hr_employees').insert(payload)

    setSaving(false)
    if (err) { setError(err.message); return }
    onSave()
  }

  async function handleDeactivate() {
    if (!window.confirm(`Mark ${employee.full_name} as inactive?`)) return
    await supabase.from('hr_employees').update({ status: 'inactive' }).eq('id', employee.id)
    onSave()
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={onClose} />
      <div style={{
        position: 'relative', width: 480, maxWidth: '100vw',
        background: '#141820', borderLeft: '1px solid #2a2f3d',
        display: 'flex', flexDirection: 'column',
      }}>

        {/* Header */}
        <div style={{ padding: '20px 24px 0', borderBottom: '1px solid #2a2f3d', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 16, color: '#e8e0d0' }}>
              {isEdit ? `Edit — ${employee.full_name}` : 'Add Employee'}
            </h2>
            <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 18, cursor: 'pointer' }}>✕</button>
          </div>
          <div className="tab-bar" style={{ marginBottom: 0 }}>
            {TABS.map(t => (
              <button key={t.key} className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* ── PERSONAL ── */}
          {tab === 'personal' && <>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Auto-generated if left blank (e.g. EMP-001). You can set a custom code." width={240}>Employee Code</Tip>
              </label>
              <input style={inp} placeholder="EMP-001 (optional)" value={form.employee_code} onChange={e => set('employee_code', e.target.value)} />
            </div>
            <div style={col}>
              <label style={lbl}>Full Name <span style={{ color: '#f87171' }}>*</span></label>
              <input style={inp} placeholder="As per citizenship / PAN" value={form.full_name} onChange={e => set('full_name', e.target.value)} />
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Gender</label>
                <select style={inp} value={form.gender} onChange={e => set('gender', e.target.value)}>
                  <option value="">Select</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div style={col}>
                <label style={lbl}>
                  <Tip text="Date of birth in AD. Used for age and retirement calculations." width={220}>Date of Birth (AD)</Tip>
                </label>
                <input type="date" style={inp} value={form.date_of_birth} onChange={e => set('date_of_birth', e.target.value)} />
              </div>
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>
                  <Tip text="PAN number from IRD. Required for TDS computation." width={220}>PAN No.</Tip>
                </label>
                <input style={inp} placeholder="9-digit PAN" value={form.pan_no} onChange={e => set('pan_no', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>National Identity No.</label>
                <input style={inp} placeholder="NID / Citizenship No." value={form.citizenship_no} onChange={e => set('citizenship_no', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl}>Phone</label>
              <input style={inp} placeholder="98XXXXXXXX" value={form.phone} onChange={e => set('phone', e.target.value)} />
            </div>
            <div style={col}>
              <label style={lbl}>Email</label>
              <input type="email" style={inp} placeholder="employee@email.com" value={form.email} onChange={e => set('email', e.target.value)} />
            </div>
            <div style={col}>
              <label style={lbl}>Address</label>
              <input style={inp} placeholder="District, ward, tole" value={form.address} onChange={e => set('address', e.target.value)} />
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Emergency Contact Name</label>
                <input style={inp} placeholder="Name" value={form.emergency_contact_name} onChange={e => set('emergency_contact_name', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>Emergency Contact Phone</label>
                <input style={inp} placeholder="98XXXXXXXX" value={form.emergency_contact_phone} onChange={e => set('emergency_contact_phone', e.target.value)} />
              </div>
            </div>
          </>}

          {/* ── EMPLOYMENT ── */}
          {tab === 'employment' && <>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Designation</label>
                <input style={inp} placeholder="e.g. Head Chef, Cashier" value={form.designation} onChange={e => set('designation', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>Department</label>
                <input style={inp} placeholder="e.g. Kitchen, FOH, Admin" value={form.department} onChange={e => set('department', e.target.value)} />
              </div>
            </div>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Permanent — no end date. Probation — first 3–6 months. Contract — defined end date. Part-time — paid per day/hour." width={280}>Employment Type</Tip>
              </label>
              <select style={inp} value={form.employment_type} onChange={e => set('employment_type', e.target.value)}>
                <option value="permanent">Permanent</option>
                <option value="probation">Probation</option>
                <option value="contract">Contract</option>
                <option value="part_time">Part-time</option>
              </select>
            </div>
            <div style={row}>
              <div style={col}>
                <label style={lbl}>Join Date (AD) <span style={{ color: '#f87171' }}>*</span></label>
                <input type="date" style={inp} value={form.join_date} onChange={e => set('join_date', e.target.value)} />
              </div>
              {(form.employment_type === 'contract' || form.employment_type === 'part_time') && (
                <div style={col}>
                  <label style={lbl}>Contract End Date (AD)</label>
                  <input type="date" style={inp} value={form.end_date} onChange={e => set('end_date', e.target.value)} />
                </div>
              )}
            </div>
            <div style={col}>
              <label style={lbl}>Status</label>
              <select style={inp} value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="active">Active</option>
                <option value="probation">Probation</option>
                <option value="inactive">Inactive</option>
                <option value="resigned">Resigned</option>
                <option value="terminated">Terminated</option>
              </select>
            </div>
            <div style={col}>
              <label style={lbl}>Notes</label>
              <textarea
                rows={3}
                style={{ ...inp, resize: 'vertical' }}
                placeholder="Any notes about this employee's employment…"
                value={form.notes}
                onChange={e => set('notes', e.target.value)}
              />
            </div>
          </>}

          {/* ── SALARY ── */}
          {tab === 'salary' && <>
            <div style={{ padding: '12px 14px', background: '#0f1117', borderRadius: 8, border: '1px solid #2a2f3d', fontSize: 12, color: '#6b7280', lineHeight: 1.6 }}>
              Only basic salary is stored here. Full salary components (HRA, transport, medical) will be configured in Salary Structure — coming next session.
            </div>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Monthly basic salary in NPR. SSF is computed on basic: employee 11%, employer 20%." width={280}>Basic Salary (NPR / month)</Tip>
              </label>
              <input type="number" min="0" style={inp} placeholder="e.g. 25000" value={form.basic_salary} onChange={e => set('basic_salary', e.target.value)} />
            </div>
            {parseFloat(form.basic_salary) > 0 && (
              <div style={{ padding: '14px 16px', background: '#0f1117', borderRadius: 8, border: '1px solid #2a2f3d' }}>
                <p style={{ margin: '0 0 10px', fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>SSF Preview</p>
                {[
                  { label: 'Basic Salary',           value: parseFloat(form.basic_salary),        indent: false, red: false, bold: false },
                  { label: 'Employee SSF (11%)',      value: parseFloat(form.basic_salary) * 0.11, indent: true,  red: true,  bold: false },
                  { label: 'Employer SSF (20%)',      value: parseFloat(form.basic_salary) * 0.20, indent: true,  red: false, bold: false },
                  { label: 'Total SSF Contribution',  value: parseFloat(form.basic_salary) * 0.31, indent: false, red: false, bold: true  },
                ].map(r => (
                  <div key={r.label} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                    <span style={{ color: r.indent ? '#6b7280' : '#9ca3af', paddingLeft: r.indent ? 12 : 0 }}>{r.label}</span>
                    <span style={{ fontWeight: r.bold ? 700 : 400, color: r.red ? '#f87171' : r.bold ? '#c9a84c' : '#e8e0d0' }}>
                      NPR {Math.round(r.value).toLocaleString('en-NP')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>}

          {/* ── BANK / SSF ── */}
          {tab === 'bank' && <>
            <div style={col}>
              <label style={lbl}>
                <Tip text="Bank where salary will be deposited. Used to generate bank transfer list during payroll." width={240}>Bank Name</Tip>
              </label>
              <input style={inp} placeholder="e.g. NIC Asia Bank, Laxmi Sunrise" value={form.bank_name} onChange={e => set('bank_name', e.target.value)} />
            </div>
            <div style={row}>
              <div style={{ ...col, flex: 2 }}>
                <label style={lbl}>Account No.</label>
                <input style={inp} placeholder="Bank account number" value={form.bank_account_no} onChange={e => set('bank_account_no', e.target.value)} />
              </div>
              <div style={col}>
                <label style={lbl}>Branch</label>
                <input style={inp} placeholder="e.g. Thamel" value={form.bank_branch} onChange={e => set('bank_branch', e.target.value)} />
              </div>
            </div>
            <div style={{ marginTop: 8, borderTop: '1px solid #2a2f3d', paddingTop: 20 }}>
              <p style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>SSF Details</p>
              <div style={col}>
                <label style={lbl}>
                  <Tip text="SSF registration number. Required for SSF challan generation. Leave blank until registration is complete." width={280}>SSF No.</Tip>
                </label>
                <input style={inp} placeholder="SSF registration number" value={form.ssf_no} onChange={e => set('ssf_no', e.target.value)} />
              </div>
            </div>
          </>}

        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid #2a2f3d', display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            {isEdit && employee.status === 'active' && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleDeactivate}>
                Deactivate
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {error && <span style={{ fontSize: 12, color: '#f87171' }}>{error}</span>}
            <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Employee'}
            </button>
          </div>
        </div>

      </div>
    </div>
  )
}
