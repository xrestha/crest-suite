import { useState, useEffect } from 'react'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import {
  SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT,
  MIN_WAGE_MONTHLY, MIN_BASIC_MONTHLY, MIN_BASIC_PCT_OF_GROSS,
  PAY_BASES, minRateFor,
} from '../payrollConstants'

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
  pay_basis: 'monthly',
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

const QUICK_EARNINGS   = ['Housing Allowance', 'Transport', 'Medical Allowance', 'Food Allowance', 'Grade Pay']
const QUICK_DEDUCTIONS = ['CIT / Provident Fund', 'Advance Recovery', 'Other Deduction']

const inp = {
  background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 6,
  padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: '100%',
  fontFamily: 'inherit',
}
const lbl = { fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'block', letterSpacing: '0.02em' }
const row = { display: 'flex', gap: 12 }
const col = { flex: 1, display: 'flex', flexDirection: 'column' }

function calcAmount(comp, basic) {
  const v = parseFloat(comp.value) || 0
  if (comp.calc_type === 'percent_of_basic') return Math.round((parseFloat(basic) || 0) * v / 100)
  return Math.round(v)
}

export default function EmployeeForm({ clientId, employee, onSave, onClose }) {
  const isEdit = !!employee
  const [tab, setTab]         = useState('personal')
  const [form, setForm]       = useState(isEdit ? { ...EMPTY, ...employee } : { ...EMPTY })
  const [components, setComponents] = useState([])
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState('')
  const [splitOpen, setSplitOpen]   = useState(false)
  const [grossInput, setGrossInput] = useState('')
  const [basicPct, setBasicPct]     = useState(60)

  useEffect(() => {
    if (!isEdit) return
    supabase
      .from('hr_salary_components')
      .select('*')
      .eq('employee_id', employee.id)
      .order('created_at')
      .then(({ data }) => { if (data) setComponents(data) })
  }, [isEdit, employee?.id])

  function set(field, value) { setForm(f => ({ ...f, [field]: value })) }

  function addComponent(type, name = '') {
    setComponents(c => [...c, { name, type, calc_type: 'fixed', value: '' }])
  }

  // Split a gross figure into basic (basicPct%) + one editable allowance (remainder).
  function applySplit() {
    const gross = parseFloat(grossInput) || 0
    if (gross <= 0) return
    const pct = Math.max(60, Math.min(100, parseFloat(basicPct) || 60))
    let newBasic = Math.round(gross * pct / 100)
    // Never split below the statutory minimum basic when gross meets minimum wage.
    if (gross >= MIN_WAGE_MONTHLY && newBasic < MIN_BASIC_MONTHLY) newBasic = MIN_BASIC_MONTHLY
    const remainder = gross - newBasic
    set('basic_salary', String(newBasic))
    setComponents(c => {
      const earnings = c.filter(x => x.type === 'earning')
      const deductions = c.filter(x => x.type === 'deduction')
      // Reuse an existing "Other Allowances" line if present, else prepend one.
      const otherIdx = earnings.findIndex(x => x.name === 'Other Allowances')
      const otherRow = { name: 'Other Allowances', type: 'earning', calc_type: 'fixed', value: remainder > 0 ? String(remainder) : '' }
      const newEarnings = otherIdx >= 0
        ? earnings.map((x, i) => i === otherIdx ? { ...x, calc_type: 'fixed', value: String(remainder) } : x)
        : (remainder > 0 ? [otherRow, ...earnings] : earnings)
      return [...newEarnings, ...deductions]
    })
    setSplitOpen(false)
  }

  function updateComponent(i, field, value) {
    setComponents(c => c.map((comp, idx) => idx === i ? { ...comp, [field]: value } : comp))
  }

  function removeComponent(i) {
    setComponents(c => c.filter((_, idx) => idx !== i))
  }

  async function handleSave() {
    if (!form.full_name.trim()) { setError('Full name is required.'); setTab('personal'); return }
    if (!form.join_date)        { setError('Join date is required.'); setTab('employment'); return }
    const invalidComp = components.find(c => !c.name.trim())
    if (invalidComp) { setError('All salary components need a name.'); setTab('salary'); return }
    setError('')
    setSaving(true)

    const payload = {
      ...form,
      client_id:      clientId,
      full_name:      form.full_name.trim(),
      basic_salary:   parseFloat(form.basic_salary) || 0,
      gender:         form.gender         || null,
      date_of_birth:  form.date_of_birth  || null,
      end_date:       form.end_date       || null,
      pan_no:         form.pan_no         || null,
      citizenship_no: form.citizenship_no || null,
    }

    let empId = employee?.id
    if (isEdit) {
      const { error: err } = await supabase.from('hr_employees').update(payload).eq('id', empId)
      if (err) { setError(err.message); setSaving(false); return }
    } else {
      const { data, error: err } = await supabase.from('hr_employees').insert(payload).select('id').single()
      if (err) { setError(err.message); setSaving(false); return }
      empId = data.id
    }

    // Sync salary components — delete-all + re-insert
    await supabase.from('hr_salary_components').delete().eq('employee_id', empId)
    if (components.length > 0) {
      const rows = components
        .filter(c => c.name.trim())
        .map(c => ({
          client_id:   clientId,
          employee_id: empId,
          name:        c.name.trim(),
          type:        c.type,
          calc_type:   c.calc_type,
          value:       parseFloat(c.value) || 0,
        }))
      if (rows.length > 0) {
        const { error: compErr } = await supabase.from('hr_salary_components').insert(rows)
        if (compErr) { setError(compErr.message); setSaving(false); return }
      }
    }

    setSaving(false)
    onSave()
  }

  async function handleDeactivate() {
    if (!window.confirm(`Mark ${employee.full_name} as inactive?`)) return
    await supabase.from('hr_employees').update({ status: 'inactive' }).eq('id', employee.id)
    onSave()
  }

  async function handleDelete() {
    if (!window.confirm(`Delete ${employee.full_name}? This cannot be undone.`)) return
    if (!window.confirm(`Are you sure? All data for ${employee.full_name} will be permanently deleted.`)) return
    const { error: err } = await supabase.from('hr_employees').delete().eq('id', employee.id)
    if (err) { setError(err.message); return }
    onSave()
  }

  // ── Salary tab computed values ───────────────────────────────────────────
  const basic       = parseFloat(form.basic_salary) || 0
  const earnings    = components.filter(c => c.type === 'earning')
  const deductions  = components.filter(c => c.type === 'deduction')
  const totalEarnings   = earnings.reduce((s, c)   => s + calcAmount(c, basic), 0)
  const totalDeductions = deductions.reduce((s, c) => s + calcAmount(c, basic), 0)
  const ssf_base        = Math.min(basic, SSF_CAP)
  const ssf_employee    = Math.round(ssf_base * SSF_EMPLOYEE_PCT)
  const ssf_employer    = Math.round(ssf_base * SSF_EMPLOYER_PCT)
  const gross    = basic + totalEarnings
  const totalDed = ssf_employee + totalDeductions
  const net      = gross - totalDed

  // Pay basis drives which salary UI + which legal minimum applies.
  const isMonthly = (form.pay_basis || 'monthly') === 'monthly'
  const payUnit   = (PAY_BASES.find(p => p.key === form.pay_basis) || PAY_BASES[0]).unit
  const minRate   = minRateFor(form.pay_basis, form.employment_type)
  // Monthly only: Labour Act basic ≥ 60% of gross.
  const basicTooLow = isMonthly && gross > 0 && basic < gross * MIN_BASIC_PCT_OF_GROSS
  // Below the statutory minimum for this pay basis.
  const belowMinRate  = basic > 0 && basic < minRate
  const belowMinGross = isMonthly && gross > 0 && gross < MIN_WAGE_MONTHLY

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={onClose} />
      <div style={{
        position: 'relative', width: 520, maxWidth: '100vw',
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

            {/* Pay basis */}
            <div style={col}>
              <label style={lbl}>
                <Tip text="Monthly — fixed salary. Daily / Hourly — paid per day or hour worked; actual pay is computed from attendance in Payroll (coming soon)." width={300}>Pay Basis</Tip>
              </label>
              <select style={inp} value={form.pay_basis || 'monthly'} onChange={e => set('pay_basis', e.target.value)}>
                {PAY_BASES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
              </select>
            </div>

            {/* Quick split from gross — monthly only */}
            {isMonthly && (
            <div style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 8, overflow: 'hidden' }}>
              <button
                onClick={() => setSplitOpen(o => !o)}
                style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'none', border: 'none', padding: '10px 14px', cursor: 'pointer', color: '#9ca3af', fontSize: 12 }}
              >
                <span>
                  <Tip text="Enter a total/gross salary and we'll split it into basic and allowances. You can edit everything afterwards." width={300}>
                    ⚡ Split from gross salary
                  </Tip>
                </span>
                <span style={{ color: '#6b7280' }}>{splitOpen ? '▲' : '▼'}</span>
              </button>
              {splitOpen && (
                <div style={{ padding: '0 14px 14px' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
                    <div style={{ flex: 2 }}>
                      <label style={lbl}>Gross / Total (NPR / month)</label>
                      <input type="number" min="0" style={inp} placeholder="e.g. 30000" value={grossInput} onChange={e => setGrossInput(e.target.value)} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label style={lbl}>
                        <Tip text="Basic as a % of gross. Minimum 60% by Labour Act. Higher basic = higher SSF." width={260}>Basic %</Tip>
                      </label>
                      <select style={inp} value={basicPct} onChange={e => setBasicPct(parseInt(e.target.value, 10))}>
                        <option value={60}>60%</option>
                        <option value={70}>70%</option>
                        <option value={80}>80%</option>
                        <option value={100}>100%</option>
                      </select>
                    </div>
                  </div>
                  {parseFloat(grossInput) > 0 && (
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8 }}>
                      → Basic <strong style={{ color: '#e8e0d0' }}>NPR {Math.round((parseFloat(grossInput) || 0) * basicPct / 100).toLocaleString('en-NP')}</strong>
                      {' · '}Other Allowances <strong style={{ color: '#34d399' }}>NPR {Math.round((parseFloat(grossInput) || 0) * (100 - basicPct) / 100).toLocaleString('en-NP')}</strong>
                    </div>
                  )}
                  <button
                    onClick={applySplit}
                    disabled={!(parseFloat(grossInput) > 0)}
                    className="btn btn-primary"
                    style={{ marginTop: 10, fontSize: 12, opacity: parseFloat(grossInput) > 0 ? 1 : 0.5 }}
                  >
                    Apply split
                  </button>
                  <div style={{ fontSize: 10, color: '#4b5563', marginTop: 8, lineHeight: 1.5 }}>
                    Fills the fields below — rename or split "Other Allowances" into Housing / Transport / etc. afterwards. SSF is computed on basic only, so a higher basic % means higher SSF contribution.
                  </div>
                </div>
              )}
            </div>
            )}

            {/* Basic salary / rate */}
            <div style={col}>
              <label style={lbl}>
                <Tip text={isMonthly
                  ? 'Monthly basic salary in NPR. SSF is computed on basic (capped at NPR 100,000): employee 11%, employer 20%.'
                  : `Pay rate per ${payUnit} in NPR. Actual pay is computed from attendance in Payroll (coming soon).`} width={300}>
                  {isMonthly ? 'Basic Salary (NPR / month)' : `Rate (NPR / ${payUnit})`}
                </Tip>
              </label>
              <input type="number" min="0" style={inp} placeholder={isMonthly ? 'e.g. 25000' : payUnit === 'day' ? 'e.g. 800' : 'e.g. 110'} value={form.basic_salary} onChange={e => set('basic_salary', e.target.value)} />
              {belowMinRate && (
                <span style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>
                  ⚠ Below minimum wage — Nepal requires at least NPR {minRate.toLocaleString('en-NP')} / {payUnit}{isMonthly ? ' basic' : ''}.
                </span>
              )}
              {!belowMinRate && belowMinGross && (
                <span style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>
                  ⚠ Gross below minimum wage — Nepal requires at least NPR {MIN_WAGE_MONTHLY.toLocaleString('en-NP')} / month for full-time staff.
                </span>
              )}
              {basicTooLow && (
                <span style={{ fontSize: 11, color: '#c9a84c', marginTop: 4 }}>
                  ⚠ Basic is below 60% of gross (NPR {Math.round(gross * MIN_BASIC_PCT_OF_GROSS).toLocaleString('en-NP')}). Labour Act requires basic ≥ 60% of total pay.
                </span>
              )}
            </div>

            {/* Non-monthly: defer pay computation to payroll */}
            {!isMonthly && (
              <div style={{ padding: '14px 16px', background: '#0f1117', borderRadius: 8, border: '1px solid #2a2f3d', fontSize: 12, color: '#6b7280', lineHeight: 1.6 }}>
                This employee is paid <strong style={{ color: '#e8e0d0' }}>per {payUnit}</strong>. Their actual pay each period is calculated from days/hours worked — that comes from the <strong style={{ color: '#9ca3af' }}>Attendance</strong> and <strong style={{ color: '#9ca3af' }}>Payroll</strong> modules (coming soon). Monthly allowances, deductions, and SSF are not configured here for hourly/daily workers.
              </div>
            )}

            {/* ── Allowances (monthly only) ── */}
            {isMonthly && <>
            <div style={{ borderTop: '1px solid #2a2f3d', paddingTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Allowances</span>
                <button
                  onClick={() => addComponent('earning')}
                  style={{ background: 'none', border: '1px solid #2a2f3d', borderRadius: 5, color: '#9ca3af', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}
                >+ Add</button>
              </div>

              {/* Quick-add chips */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {QUICK_EARNINGS.filter(n => !earnings.find(c => c.name === n)).map(n => (
                  <button key={n} onClick={() => addComponent('earning', n)}
                    style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 12, color: '#34d399', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}>
                    + {n}
                  </button>
                ))}
              </div>

              {earnings.length === 0 && (
                <div style={{ fontSize: 12, color: '#4b5563', padding: '8px 0' }}>No allowances added. Use the chips above to add common ones.</div>
              )}
              {earnings.map((comp, i) => {
                const globalIdx = components.indexOf(comp)
                const computed = calcAmount(comp, basic)
                return (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      style={{ ...inp, flex: 2 }} placeholder="Name" value={comp.name}
                      onChange={e => updateComponent(globalIdx, 'name', e.target.value)}
                    />
                    <select
                      style={{ ...inp, flex: 1, padding: '8px 6px' }}
                      value={comp.calc_type}
                      onChange={e => updateComponent(globalIdx, 'calc_type', e.target.value)}
                    >
                      <option value="fixed">Fixed NPR</option>
                      <option value="percent_of_basic">% of Basic</option>
                    </select>
                    <input
                      type="number" min="0"
                      style={{ ...inp, flex: 1, textAlign: 'right' }}
                      placeholder={comp.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                      value={comp.value}
                      onChange={e => updateComponent(globalIdx, 'value', e.target.value)}
                    />
                    {comp.calc_type === 'percent_of_basic' && basic > 0 && (
                      <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap', minWidth: 60, textAlign: 'right' }}>
                        = {computed.toLocaleString()}
                      </span>
                    )}
                    <button onClick={() => removeComponent(globalIdx)} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}>✕</button>
                  </div>
                )
              })}
            </div>

            {/* ── Deductions ── */}
            <div style={{ borderTop: '1px solid #2a2f3d', paddingTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: '#f87171', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Deductions</span>
                <button
                  onClick={() => addComponent('deduction')}
                  style={{ background: 'none', border: '1px solid #2a2f3d', borderRadius: 5, color: '#9ca3af', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}
                >+ Add</button>
              </div>

              {/* Quick-add chips */}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {QUICK_DEDUCTIONS.filter(n => !deductions.find(c => c.name === n)).map(n => (
                  <button key={n} onClick={() => addComponent('deduction', n)}
                    style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 12, color: '#f87171', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}>
                    + {n}
                  </button>
                ))}
              </div>

              {/* SSF auto-row — always shown when basic > 0 */}
              {basic > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: '#0f1117', borderRadius: 6, marginBottom: 6, border: '1px solid #2a2f3d' }}>
                  <span style={{ fontSize: 12, color: '#6b7280' }}>
                    <Tip text="11% of basic salary deducted from employee each month. Mandatory under SSF Act. Basic is capped at NPR 100,000 for SSF." width={280}>
                      SSF — Employee (11%) · auto{basic > SSF_CAP ? ' · capped' : ''}
                    </Tip>
                  </span>
                  <span style={{ fontSize: 13, color: '#e8e0d0', fontWeight: 500 }}>NPR {ssf_employee.toLocaleString('en-NP')}</span>
                </div>
              )}

              {deductions.map((comp, i) => {
                const globalIdx = components.indexOf(comp)
                const computed = calcAmount(comp, basic)
                return (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      style={{ ...inp, flex: 2 }} placeholder="Name" value={comp.name}
                      onChange={e => updateComponent(globalIdx, 'name', e.target.value)}
                    />
                    <select
                      style={{ ...inp, flex: 1, padding: '8px 6px' }}
                      value={comp.calc_type}
                      onChange={e => updateComponent(globalIdx, 'calc_type', e.target.value)}
                    >
                      <option value="fixed">Fixed NPR</option>
                      <option value="percent_of_basic">% of Basic</option>
                    </select>
                    <input
                      type="number" min="0"
                      style={{ ...inp, flex: 1, textAlign: 'right' }}
                      placeholder={comp.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                      value={comp.value}
                      onChange={e => updateComponent(globalIdx, 'value', e.target.value)}
                    />
                    {comp.calc_type === 'percent_of_basic' && basic > 0 && (
                      <span style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'nowrap', minWidth: 60, textAlign: 'right' }}>
                        = {computed.toLocaleString()}
                      </span>
                    )}
                    <button onClick={() => removeComponent(globalIdx)} style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}>✕</button>
                  </div>
                )
              })}
            </div>

            {/* ── Net Summary ── */}
            {basic > 0 && (
              <div style={{ borderTop: '1px solid #2a2f3d', paddingTop: 14 }}>
                <p style={{ margin: '0 0 10px', fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Monthly Summary</p>
                <div style={{ background: '#0f1117', borderRadius: 8, border: '1px solid #2a2f3d', overflow: 'hidden' }}>
                  {[
                    { label: 'Basic Salary',        value: basic,           indent: false, color: '#e8e0d0' },
                    earnings.length > 0 && { label: `Allowances (${earnings.length})`, value: totalEarnings, indent: true, color: '#34d399' },
                    { label: 'Gross Earnings',       value: gross,           indent: false, color: '#e8e0d0', bold: true, separator: true },
                    { label: 'SSF Employee (11%)',   value: -ssf_employee,   indent: true,  color: '#f87171' },
                    ...deductions.map(c => ({ label: c.name || 'Deduction', value: -calcAmount(c, basic), indent: true, color: '#f87171' })),
                    { label: 'Net Salary',           value: net,             indent: false, color: '#c9a84c', bold: true, big: true, separator: true },
                    { label: 'Employer SSF (20%)',   value: ssf_employer,    indent: true,  color: '#6b7280', note: 'paid by company' },
                  ].filter(Boolean).map((r, i) => (
                    <div key={i} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: r.big ? '12px 16px' : '7px 16px',
                      borderTop: r.separator ? '1px solid #2a2f3d' : 'none',
                      background: r.big ? 'rgba(201,168,76,0.05)' : 'transparent',
                    }}>
                      <span style={{ fontSize: r.big ? 13 : 12, color: r.indent ? '#6b7280' : '#9ca3af', paddingLeft: r.indent ? 12 : 0, fontWeight: r.bold ? 700 : 400 }}>
                        {r.label}{r.note ? <span style={{ fontSize: 10, color: '#4b5563', marginLeft: 6 }}>({r.note})</span> : null}
                      </span>
                      <span style={{ fontSize: r.big ? 15 : 13, color: r.color, fontWeight: r.bold ? 700 : 400 }}>
                        {r.value < 0 ? '−' : ''} NPR {Math.abs(r.value).toLocaleString('en-NP')}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </>}
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
          <div style={{ display: 'flex', gap: 8 }}>
            {isEdit && employee.status === 'active' && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleDeactivate}>
                Deactivate
              </button>
            )}
            {isEdit && (
              <button className="btn btn-ghost" style={{ fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.25)' }} onClick={handleDelete}>
                Delete
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
