import { useState, useEffect } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import {
  SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT,
  MIN_WAGE_MONTHLY, MIN_BASIC_MONTHLY,
  PAY_BASES, minRateFor,
} from '../payrollConstants'

const DEARNESS_MIN  = 7380
const QUICK_EARNINGS   = ['Housing Allowance', 'Transport', 'Medical Allowance', 'Food Allowance', 'Grade Pay']
const QUICK_DEDUCTIONS = ['CIT / Provident Fund', 'Advance Recovery', 'Other Deduction']

// Plain-language notes for the quick-add deduction chips. CIT in particular is an acronym a
// restaurant owner has no reason to know, so it gets the full "what it is + a real example".
const QUICK_DEDUCTION_TIPS = {
  'CIT / Provident Fund': 'CIT = Citizen Investment Trust — a government-run retirement savings account. Each month a fixed amount is held back from the employee\'s salary and paid into their own CIT (or provident fund) account, which they get back with interest when they retire or leave. Example: your head chef on NPR 30,000 basic saves NPR 3,000 a month — enter 3,000 here and it comes off their pay every month and reduces their taxable income. Only add this for staff who have actually opened a CIT or provident fund account.',
}

const TABS = [
  { key: 'salary', label: 'Salary' },
  { key: 'bank',   label: 'Bank / SSF' },
]

const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6,
  padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%',
  fontFamily: 'inherit',
}
const lbl  = { fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4, display: 'block', letterSpacing: '0.02em' }
const row  = { display: 'flex', gap: 12 }
const col  = { flex: 1, display: 'flex', flexDirection: 'column' }

function calcAmount(comp, basic) {
  const v = parseFloat(comp.value) || 0
  if (comp.calc_type === 'percent_of_basic') return Math.round((parseFloat(basic) || 0) * v / 100)
  return Math.round(v)
}

const fmt = n => Math.round(n || 0).toLocaleString('en-NP')

// Edits one employee's pay (basic / dearness / allowances / deductions / SSF) + bank details.
// Dearness Allowance is surfaced as its own dedicated field but stored as a salary component.
// Updates hr_employees columns + syncs hr_salary_components (delete-all + re-insert).
export default function PayForm({ employee, onSave, onClose }) {
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [tab, setTab]     = useState('salary')
  const [form, setForm]   = useState({
    pay_basis:       employee.pay_basis || 'monthly',
    basic_salary:    employee.basic_salary ?? '',
    bank_name:       employee.bank_name || '',
    bank_account_no: employee.bank_account_no || '',
    bank_branch:     employee.bank_branch || '',
    ssf_no:                    employee.ssf_no || '',
    ssf_enrolled:              !!(employee.ssf_enrolled),
    life_insurance_premium:    parseFloat(employee.life_insurance_premium) || 0,
    health_insurance_premium:  parseFloat(employee.health_insurance_premium) || 0,
  })
  const [dearness, setDearness]     = useState('')   // stored separately from other components
  const [components, setComponents] = useState([])   // earnings + deductions excluding dearness
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')

  useEffect(() => {
    scopedFrom('hr_salary_components').eq('employee_id', employee.id).order('created_at')
      .then(({ data }) => {
        if (!data) return
        const da = data.find(c => c.name === 'Dearness Allowance' && c.type === 'earning')
        setDearness(da ? String(da.value) : '')
        setComponents(data.filter(c => !(c.name === 'Dearness Allowance' && c.type === 'earning')))
      })
  }, [employee.id, scopedFrom])

  function set(field, value) { setForm(f => ({ ...f, [field]: value })) }

  function addComponent(type, name = '') {
    setComponents(c => [...c, { name, type, calc_type: 'fixed', value: '' }])
  }
  function updateComponent(i, field, value) {
    setComponents(c => c.map((comp, idx) => idx === i ? { ...comp, [field]: value } : comp))
  }
  function removeComponent(i) {
    setComponents(c => c.filter((_, idx) => idx !== i))
  }

  async function handleSave() {
    const invalidComp = components.find(c => !c.name.trim())
    if (invalidComp) { setError('All salary components need a name.'); setTab('salary'); return }
    setError('')
    setSaving(true)

    const { error: err } = await scopedUpdate('hr_employees', {
      pay_basis:       form.pay_basis,
      basic_salary:    parseFloat(form.basic_salary) || 0,
      bank_name:       form.bank_name || null,
      bank_account_no: form.bank_account_no || null,
      bank_branch:     form.bank_branch || null,
      ssf_no:                   form.ssf_no || null,
      ssf_enrolled:             form.ssf_enrolled,
      life_insurance_premium:   parseFloat(form.life_insurance_premium) || 0,
      health_insurance_premium: parseFloat(form.health_insurance_premium) || 0,
    }).eq('id', employee.id)
    if (err) { setError(err.message); setSaving(false); return }

    // Build component rows — dearness first (if set), then the rest.
    await scopedDelete('hr_salary_components').eq('employee_id', employee.id)
    const dearnessVal = parseFloat(dearness) || 0
    const rows = [
      ...(dearnessVal > 0 ? [{
        employee_id: employee.id,
        name: 'Dearness Allowance', type: 'earning', calc_type: 'fixed', value: dearnessVal,
      }] : []),
      ...components.filter(c => c.name.trim()).map(c => ({
        employee_id: employee.id,
        name:        c.name.trim(),
        type:        c.type,
        calc_type:   c.calc_type,
        value:       parseFloat(c.value) || 0,
      })),
    ]
    if (rows.length > 0) {
      const { error: compErr } = await scopedInsert('hr_salary_components', rows)
      if (compErr) { setError(compErr.message); setSaving(false); return }
    }

    setSaving(false)
    onSave()
  }

  // ── Computed values ──────────────────────────────────────────────────────────
  const basic         = parseFloat(form.basic_salary) || 0
  const dearnessAmt   = parseFloat(dearness) || 0
  const earnings      = components.filter(c => c.type === 'earning')
  const deductions    = components.filter(c => c.type === 'deduction')
  const otherEarnings = earnings.reduce((s, c) => s + calcAmount(c, basic), 0)
  const totalDeductions = deductions.reduce((s, c) => s + calcAmount(c, basic), 0)
  const ssf_base      = form.ssf_enrolled ? Math.min(basic, SSF_CAP) : 0
  const ssf_employee  = Math.round(ssf_base * SSF_EMPLOYEE_PCT)
  const ssf_employer  = Math.round(ssf_base * SSF_EMPLOYER_PCT)
  const gross         = basic + dearnessAmt + otherEarnings
  const totalDed      = ssf_employee + totalDeductions
  const net           = gross - totalDed
  const ctc           = gross + ssf_employer

  const isMonthly = (form.pay_basis || 'monthly') === 'monthly'
  const payUnit   = (PAY_BASES.find(p => p.key === form.pay_basis) || PAY_BASES[0]).unit
  const minRate   = minRateFor(form.pay_basis, employee.employment_type)

  // Validation flags
  const basicBelowMin    = isMonthly && basic > 0 && basic < MIN_BASIC_MONTHLY
  const dearnessBelowMin = isMonthly && dearnessAmt > 0 && dearnessAmt < DEARNESS_MIN
  const grossBelowMin    = isMonthly && gross > 0 && gross < MIN_WAGE_MONTHLY
  const rateBelowMin     = !isMonthly && basic > 0 && basic < minRate
  const basicTooLow      = isMonthly && gross > 0 && basic < gross * 0.6

  return (
    <Modal onClose={onClose} title={`Pay Setup — ${employee.full_name}`} maxWidth={780}>
      {employee.designation && (
        <div style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '-10px 0 14px' }}>
          {employee.designation}{employee.department ? ` · ${employee.department}` : ''}
        </div>
      )}

      {/* Full-bleed body: the tab bar, the two-column grid and the footer each carry their own
          24px padding, so they run edge-to-edge inside the Modal card's own 24px padding. */}
      <div style={{ margin: '0 -24px -24px' }}>

        {/* Tabs */}
        <div style={{ padding: '0 24px', borderBottom: '1px solid var(--theme-border)' }}>
          <div className="tab-bar" style={{ marginBottom: 0 }}>
            {TABS.map(t => (
              <button key={t.key} className={`tab-btn${tab === t.key ? ' tab-btn--active' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div>
          {tab === 'salary' && (
            <div style={{ display: 'grid', gridTemplateColumns: basic > 0 ? '1fr 1fr' : '1fr', gap: 0 }}>

              {/* Left column — inputs */}
              <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16, borderRight: basic > 0 ? '1px solid var(--theme-border)' : 'none' }}>

                {/* Pay Basis */}
                <div style={col}>
                  <label style={lbl} htmlFor="pf-pay-basis">
                    <Tip text="Monthly — fixed salary each month. Daily / Hourly — actual pay is computed from attendance records in Payroll." width={300}>Pay Basis</Tip>
                  </label>
                  <select id="pf-pay-basis" style={inp} value={form.pay_basis || 'monthly'} onChange={e => set('pay_basis', e.target.value)}>
                    {PAY_BASES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                </div>

                {/* Basic Salary */}
                <div style={col}>
                  <label style={lbl} htmlFor="pf-basic-salary">
                    <Tip text={isMonthly
                      ? 'Monthly basic salary in NPR. SSF is computed on basic only (capped at NPR 100,000). Minimum NPR 12,170 per Labour Act 2082.'
                      : `Pay rate per ${payUnit} in NPR. Actual pay is computed from attendance in Payroll.`} width={300}>
                      {isMonthly ? 'Basic Salary (NPR / month)' : `Rate (NPR / ${payUnit})`}
                    </Tip>
                  </label>
                  <input id="pf-basic-salary" type="number" min="0" style={inp}
                    placeholder={isMonthly ? 'e.g. 25000' : payUnit === 'day' ? 'e.g. 800' : 'e.g. 110'}
                    value={form.basic_salary}
                    onChange={e => set('basic_salary', e.target.value)} />
                  {basicBelowMin && (
                    <span style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 4 }}>
                      ⚠ Below minimum basic — Nepal requires at least NPR {MIN_BASIC_MONTHLY.toLocaleString('en-NP')} / month.
                    </span>
                  )}
                  {rateBelowMin && (
                    <span style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 4 }}>
                      ⚠ Below minimum wage — Nepal requires at least NPR {minRate.toLocaleString('en-NP')} / {payUnit}.
                    </span>
                  )}
                  {basicTooLow && !basicBelowMin && (
                    <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>
                      ⚠ Basic is below 60% of gross (NPR {Math.round(gross * 0.6).toLocaleString('en-NP')}). Labour Act requires basic ≥ 60% of total pay.
                    </span>
                  )}
                </div>

                {/* Dearness Allowance — monthly only */}
                {isMonthly && (
                  <div style={col}>
                    <label style={lbl} htmlFor="pf-dearness">
                      <Tip text="Statutory dearness allowance (महँगी भत्ता). Minimum NPR 7,380 / month per Labour Act 2082. Separate from basic salary — SSF is not computed on this." width={300}>
                        Dearness Allowance (NPR / month)
                      </Tip>
                    </label>
                    <input id="pf-dearness" type="number" min="0" style={inp}
                      placeholder="e.g. 7380"
                      value={dearness}
                      onChange={e => setDearness(e.target.value)} />
                    {dearnessBelowMin && (
                      <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>
                        ⚠ Below minimum dearness allowance — Nepal requires at least NPR {DEARNESS_MIN.toLocaleString('en-NP')} / month.
                      </span>
                    )}
                    {grossBelowMin && !dearnessBelowMin && (
                      <span style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 4 }}>
                        ⚠ Total gross (NPR {fmt(gross)}) is below the minimum wage of NPR {MIN_WAGE_MONTHLY.toLocaleString('en-NP')} / month.
                      </span>
                    )}
                  </div>
                )}

                {!isMonthly && (
                  <div style={{ padding: '14px 16px', background: 'var(--theme-input-bg)', borderRadius: 8, border: '1px solid var(--theme-border)', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
                    This employee is paid <strong style={{ color: 'var(--theme-text1)' }}>per {payUnit}</strong>. Actual pay each period is calculated from days/hours worked via <strong style={{ color: 'var(--theme-text3)' }}>Attendance → Payroll</strong>. Allowances and deductions are not configured for daily/hourly workers.
                  </div>
                )}

                {/* Other Allowances — monthly only */}
                {isMonthly && (
                  <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-green-text)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Other Allowances</span>
                      <button onClick={() => addComponent('earning')} style={{ background: 'none', border: '1px solid var(--theme-border)', borderRadius: 5, color: 'var(--theme-text3)', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}>+ Add</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {QUICK_EARNINGS.filter(n => !earnings.find(c => c.name === n)).map(n => (
                        <button key={n} onClick={() => addComponent('earning', n)}
                          style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 12, color: 'var(--theme-green-text)', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}>
                          + {n}
                        </button>
                      ))}
                    </div>
                    {earnings.length === 0 && (
                      <div style={{ fontSize: 12, color: 'var(--theme-text2)', padding: '4px 0' }}>No other allowances. Use the chips above to add common ones.</div>
                    )}
                    {earnings.map((comp, i) => {
                      const globalIdx = components.indexOf(comp)
                      const computed  = calcAmount(comp, basic)
                      return (
                        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                          <input style={{ ...inp, flex: 2 }} aria-label={`Allowance ${i + 1} name`} placeholder="Name" value={comp.name} onChange={e => updateComponent(globalIdx, 'name', e.target.value)} />
                          <select style={{ ...inp, flex: 1, padding: '8px 6px' }} aria-label={`Allowance ${i + 1} calculation type`} value={comp.calc_type} onChange={e => updateComponent(globalIdx, 'calc_type', e.target.value)}>
                            <option value="fixed">Fixed NPR</option>
                            <option value="percent_of_basic">% of Basic</option>
                          </select>
                          <input type="number" min="0" style={{ ...inp, flex: 1, textAlign: 'right' }}
                            aria-label={`Allowance ${i + 1} amount`}
                            placeholder={comp.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                            value={comp.value}
                            onChange={e => updateComponent(globalIdx, 'value', e.target.value)} />
                          {comp.calc_type === 'percent_of_basic' && basic > 0 && (
                            <span style={{ fontSize: 11, color: 'var(--theme-text2)', whiteSpace: 'nowrap', minWidth: 56, textAlign: 'right' }}>= {computed.toLocaleString()}</span>
                          )}
                          <button onClick={() => removeComponent(globalIdx)} aria-label={`Remove allowance ${comp.name || i + 1}`} style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}>✕</button>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Deductions — monthly only */}
                {isMonthly && (
                  <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-red-text)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Deductions</span>
                      <button onClick={() => addComponent('deduction')} style={{ background: 'none', border: '1px solid var(--theme-border)', borderRadius: 5, color: 'var(--theme-text3)', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}>+ Add</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {QUICK_DEDUCTIONS.filter(n => !deductions.find(c => c.name === n)).map(n => {
                        const chip = (
                          <button onClick={() => addComponent('deduction', n)}
                            style={{ background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 12, color: 'var(--theme-red-text)', fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}>
                            + {n}
                          </button>
                        )
                        return QUICK_DEDUCTION_TIPS[n]
                          ? <Tip key={n} text={QUICK_DEDUCTION_TIPS[n]} width={330}>{chip}</Tip>
                          : <span key={n}>{chip}</span>
                      })}
                    </div>
                    {/* SSF auto row */}
                    {basic > 0 && form.ssf_enrolled && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: 'var(--theme-input-bg)', borderRadius: 6, marginBottom: 6, border: '1px solid var(--theme-border)' }}>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                          <Tip text="11% of basic salary deducted from the employee each month. Mandatory under SSF Act. Basic is capped at NPR 100,000 for SSF calculation." width={280}>
                            SSF — Employee (11%){basic > SSF_CAP ? ' · capped' : ''} · auto
                          </Tip>
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 500 }}>NPR {ssf_employee.toLocaleString('en-NP')}</span>
                      </div>
                    )}
                    {basic > 0 && !form.ssf_enrolled && (
                      <div style={{ padding: '7px 10px', fontSize: 12, color: 'var(--theme-text2)' }}>
                        <Tip text="Enable SSF Enrolled in the Bank / SSF tab to apply the 11% employee / 20% employer SSF deduction." width={280}>
                          SSF not enrolled — no SSF deduction applied
                        </Tip>
                      </div>
                    )}
                    {deductions.map((comp, i) => {
                      const globalIdx = components.indexOf(comp)
                      const computed  = calcAmount(comp, basic)
                      return (
                        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                          <input style={{ ...inp, flex: 2 }} aria-label={`Deduction ${i + 1} name`} placeholder="Name" value={comp.name} onChange={e => updateComponent(globalIdx, 'name', e.target.value)} />
                          <select style={{ ...inp, flex: 1, padding: '8px 6px' }} aria-label={`Deduction ${i + 1} calculation type`} value={comp.calc_type} onChange={e => updateComponent(globalIdx, 'calc_type', e.target.value)}>
                            <option value="fixed">Fixed NPR</option>
                            <option value="percent_of_basic">% of Basic</option>
                          </select>
                          <input type="number" min="0" style={{ ...inp, flex: 1, textAlign: 'right' }}
                            aria-label={`Deduction ${i + 1} amount`}
                            placeholder={comp.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                            value={comp.value}
                            onChange={e => updateComponent(globalIdx, 'value', e.target.value)} />
                          {comp.calc_type === 'percent_of_basic' && basic > 0 && (
                            <span style={{ fontSize: 11, color: 'var(--theme-text2)', whiteSpace: 'nowrap', minWidth: 56, textAlign: 'right' }}>= {computed.toLocaleString()}</span>
                          )}
                          <button onClick={() => removeComponent(globalIdx)} aria-label={`Remove deduction ${comp.name || i + 1}`} style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}>✕</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Right column — live summary (only when basic is set) */}
              {basic > 0 && isMonthly && (
                <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Monthly Summary</p>
                  <div style={{ background: 'var(--theme-input-bg)', borderRadius: 8, border: '1px solid var(--theme-border)', overflow: 'hidden' }}>
                    {[
                      { label: 'Basic Salary',           value: basic,          indent: false, color: 'var(--theme-text1)' },
                      dearnessAmt > 0 && { label: 'Dearness Allowance', value: dearnessAmt, indent: true,  color: 'var(--theme-green-text)' },
                      otherEarnings > 0 && { label: `Other Allowances${earnings.length > 0 ? ` (${earnings.length})` : ''}`, value: otherEarnings, indent: true, color: 'var(--theme-green-text)' },
                      { label: 'Gross Earnings',         value: gross,          indent: false, color: 'var(--theme-text1)', bold: true, separator: true },
                      form.ssf_enrolled && { label: `SSF Employee (11%${basic > SSF_CAP ? ' · capped' : ''})`, value: -ssf_employee, indent: true, color: 'var(--theme-red-text)' },
                      ...deductions.map(c => ({ label: c.name || 'Deduction', value: -calcAmount(c, basic), indent: true, color: 'var(--theme-red-text)' })),
                      { label: 'Net (Cash in Hand)',      value: net,            indent: false, color: 'var(--theme-accent-ink)', bold: true, big: true, separator: true },
                      { label: 'Cost to Company (CTC)',  value: ctc,            indent: false, color: 'var(--theme-text1)', bold: true, big: true, separator: true, bg: 'color-mix(in srgb, var(--theme-text1) 5%, transparent)' },
                      form.ssf_enrolled && { label: 'Employer SSF (20%)', value: ssf_employer, indent: true,  color: 'var(--theme-text2)', note: 'paid by company' },
                    ].filter(Boolean).map((r, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: r.big ? '12px 16px' : '7px 16px',
                        borderTop: r.separator ? '1px solid var(--theme-border)' : 'none',
                        background: r.bg || (r.big ? 'rgba(201,168,76,0.05)' : 'transparent'),
                      }}>
                        <span style={{ fontSize: r.big ? 13 : 12, color: r.indent ? 'var(--theme-text2)' : 'var(--theme-text3)', paddingLeft: r.indent ? 12 : 0, fontWeight: r.bold ? 700 : 400 }}>
                          {r.label}{r.note ? <span style={{ fontSize: 10, color: 'var(--theme-text2)', marginLeft: 6 }}>({r.note})</span> : null}
                        </span>
                        <span style={{ fontSize: r.big ? 15 : 13, color: r.color, fontWeight: r.bold ? 700 : 400 }}>
                          {r.value < 0 ? '− ' : ''}NPR {Math.abs(r.value).toLocaleString('en-NP')}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Compliance notice */}
                  {(basicBelowMin || dearnessBelowMin || grossBelowMin) && (
                    <div style={{ padding: '12px 14px', background: 'rgba(248,113,113,0.06)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 8, fontSize: 12, color: 'var(--theme-red-text)', lineHeight: 1.6 }}>
                      <strong>Minimum wage check (FY 2083/84)</strong>
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ color: basic >= MIN_BASIC_MONTHLY ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                          {basic >= MIN_BASIC_MONTHLY ? '✓' : '✗'} Basic ≥ NPR {MIN_BASIC_MONTHLY.toLocaleString('en-NP')} &nbsp;
                          <span style={{ color: 'var(--theme-text2)' }}>(yours: {fmt(basic)})</span>
                        </div>
                        <div style={{ color: dearnessAmt >= 7380 ? 'var(--theme-green-text)' : 'var(--theme-amber-text)' }}>
                          {dearnessAmt >= 7380 ? '✓' : '⚠'} Dearness ≥ NPR 7,380 &nbsp;
                          <span style={{ color: 'var(--theme-text2)' }}>(yours: {fmt(dearnessAmt)})</span>
                        </div>
                        <div style={{ color: gross >= MIN_WAGE_MONTHLY ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                          {gross >= MIN_WAGE_MONTHLY ? '✓' : '✗'} Gross ≥ NPR {MIN_WAGE_MONTHLY.toLocaleString('en-NP')} &nbsp;
                          <span style={{ color: 'var(--theme-text2)' }}>(yours: {fmt(gross)})</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* All clear */}
                  {!basicBelowMin && !dearnessBelowMin && !grossBelowMin && gross > 0 && (
                    <div style={{ padding: '10px 14px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: 8, fontSize: 12, color: 'var(--theme-green-text)' }}>
                      ✓ Meets Nepal minimum wage requirements (FY 2083/84)
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── BANK / SSF ── */}
          {tab === 'bank' && (
            <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={col}>
                <label style={lbl} htmlFor="pf-bank-name">
                  <Tip text="Bank where salary will be deposited. Used to generate the bank transfer list during payroll disbursement." width={240}>Bank Name</Tip>
                </label>
                <input id="pf-bank-name" style={inp} placeholder="e.g. NIC Asia Bank, Laxmi Sunrise" value={form.bank_name} onChange={e => set('bank_name', e.target.value)} />
              </div>
              <div style={row}>
                <div style={{ ...col, flex: 2 }}>
                  <label style={lbl} htmlFor="pf-bank-account">Account No.</label>
                  <input id="pf-bank-account" style={inp} placeholder="Bank account number" value={form.bank_account_no} onChange={e => set('bank_account_no', e.target.value)} />
                </div>
                <div style={col}>
                  <label style={lbl} htmlFor="pf-bank-branch">Branch</label>
                  <input id="pf-bank-branch" style={inp} placeholder="e.g. Thamel" value={form.bank_branch} onChange={e => set('bank_branch', e.target.value)} />
                </div>
              </div>
              <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 20 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>SSF Details</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  {/* Toggle switch */}
                  <button type="button" role="switch" aria-checked={form.ssf_enrolled} aria-label="SSF Enrolled"
                    onClick={() => set('ssf_enrolled', !form.ssf_enrolled)}
                    style={{ position: 'relative', width: 42, height: 24, borderRadius: 12, cursor: 'pointer', flexShrink: 0, padding: 0, border: 'none', background: form.ssf_enrolled ? 'var(--theme-accent)' : 'var(--theme-border)', transition: 'background 0.2s' }}>
                    <span style={{ position: 'absolute', top: 3, left: form.ssf_enrolled ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                  </button>
                  <span style={{ fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }} onClick={() => set('ssf_enrolled', !form.ssf_enrolled)}>
                    <Tip text="SSF enrolled employees have 11% deducted from their salary and 20% contributed by the employer. Enable this for employees registered under Nepal's Social Security Fund." width={300}>SSF Enrolled</Tip>
                  </span>
                  {form.ssf_enrolled && <span style={{ fontSize: 11, color: 'var(--theme-green-text)', marginLeft: 'auto' }}>11% emp · 20% employer</span>}
                </div>
                {form.ssf_enrolled && (
                  <div style={col}>
                    <label style={lbl} htmlFor="pf-ssf-no">
                      <Tip text="SSF registration number. Required for SSF challan export in HR Reports. Leave blank until the employee's registration is confirmed." width={280}>SSF No.</Tip>
                    </label>
                    <input id="pf-ssf-no" style={inp} placeholder="SSF registration number" value={form.ssf_no} onChange={e => set('ssf_no', e.target.value)} />
                  </div>
                )}
              </div>

              {/* Insurance premium TDS deductions */}
              <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 20 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 6px' }}>Tax Deduction Declarations</p>
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 14px', lineHeight: 1.6 }}>
                  Annual insurance premiums declared by the employee. Reduces taxable income before TDS is computed each month.
                </p>
                <div style={row}>
                  <div style={col}>
                    <label style={lbl} htmlFor="pf-life-insurance">
                      <Tip text="Annual life insurance premium paid by the employee. Deductible up to NPR 40,000/year under Nepal Income Tax Act 2058, Section 12. Enter actual premium — excess above 40,000 is ignored." width={300}>Life Insurance Premium (NPR / year)</Tip>
                    </label>
                    <input id="pf-life-insurance" type="number" min="0" style={inp}
                      placeholder="0  (cap: NPR 40,000)"
                      value={form.life_insurance_premium || ''}
                      onChange={e => set('life_insurance_premium', e.target.value)} />
                    {parseFloat(form.life_insurance_premium) > 40000 && (
                      <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>Capped at NPR 40,000 — excess ignored in TDS.</span>
                    )}
                  </div>
                  <div style={col}>
                    <label style={lbl} htmlFor="pf-health-insurance">
                      <Tip text="Annual health insurance premium paid by the employee. Deductible up to NPR 20,000/year under Nepal Income Tax Act 2058, Section 12. Enter actual premium — excess above 20,000 is ignored." width={300}>Health Insurance Premium (NPR / year)</Tip>
                    </label>
                    <input id="pf-health-insurance" type="number" min="0" style={inp}
                      placeholder="0  (cap: NPR 20,000)"
                      value={form.health_insurance_premium || ''}
                      onChange={e => set('health_insurance_premium', e.target.value)} />
                    {parseFloat(form.health_insurance_premium) > 20000 && (
                      <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>Capped at NPR 20,000 — excess ignored in TDS.</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
          {error && <span role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', marginRight: 'auto' }}>{error}</span>}
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>

      </div>
    </Modal>
  )
}
