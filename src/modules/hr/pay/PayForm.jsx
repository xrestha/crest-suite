import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useMemo } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import Modal from '../../../components/Modal'
import { errorLine } from '../../../shared/errorText'
import {
  SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT,
  MIN_WAGE_MONTHLY, MIN_BASIC_MONTHLY, MIN_DEARNESS_MONTHLY, MIN_BASIC_PCT_OF_GROSS,
  PAY_BASES, minRateFor,
} from '../payrollConstants'
import { isSsfContributor } from '../payroll/payrollCompute'
import { NOT_SAVED_RLS } from '../employees/employeeFormData'
import { useIsOwnEmployee } from '../ownRecord'

const CIT_CHIP = 'CIT / Provident Fund'
const QUICK_EARNINGS   = ['Housing Allowance', 'Transport', 'Medical Allowance', 'Food Allowance', 'Grade Pay']
// "Advance Recovery" was a chip here until S791: a deduction by that name cut pay every month
// without touching the advance, while payroll recovers every advance itself from its own
// instalment (dueAdvances) — so the money was taken twice, and kept being taken after the advance
// was repaid (found in hss-suite, re-analysis #25). Advances are recovered only by payroll.
const QUICK_DEDUCTIONS = [CIT_CHIP, 'Other Deduction']

// Plain-language notes for the quick-add deduction chips. CIT in particular is an acronym a
// restaurant owner has no reason to know, so it gets the full "what it is + a real example".
const QUICK_DEDUCTION_TIPS = {
  [CIT_CHIP]: 'CIT = Citizen Investment Trust — a government-run retirement savings account. Each month a fixed amount is held back from the employee\'s salary and paid into their own CIT (or provident fund) account, which they get back with interest when they retire or leave. Example: your head chef on NPR 30,000 basic saves NPR 3,000 a month — enter 3,000 here and it comes off their pay every month. Payroll also takes it off their taxable income, together with SSF, up to NPR 5,00,000 a year or a third of their income, whichever is lower. Only add this for staff who have actually opened a CIT or provident fund account.',
}

const TABS = [
  { key: 'salary', label: 'Salary' },
  { key: 'bank',   label: 'Bank / SSF' },
]

const lbl  = { fontSize: 12, color: 'var(--theme-text2)', marginBottom: 4, display: 'block', letterSpacing: '0.02em' }
const row  = { display: 'flex', gap: 12, flexWrap: 'wrap' }
const col  = { flex: 1, display: 'flex', flexDirection: 'column' }
// A field inside a `row`: a 200px basis, so the pair wraps onto two lines on a phone instead of
// squeezing both boxes (S803). `col` itself stays basis-0 — it is also a child of column stacks.
const rowCol = { ...col, flex: '1 1 200px', minWidth: 0 }
// One allowance / deduction line: name, how it is worked out, amount, ✕. Bases rather than bare
// flex weights, so on a phone the amount drops to a second line instead of the type select
// shrinking to "Fix…" (S803).
const compRow = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }

function calcAmount(comp, basic) {
  const v = parseFloat(comp.value) || 0
  if (comp.calc_type === 'percent_of_basic') return Math.round((parseFloat(basic) || 0) * v / 100)
  return Math.round(v)
}

const fmt = nprInt

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
  // 'loading' | 'ok' | 'failed'. Save is refused until 'ok', and that is the whole defence against
  // a real loss: Save deletes every component and re-inserts what the form holds, so a Save made
  // before this read landed — or after it failed — sent an EMPTY set and wiped the employee's
  // dearness allowance, allowances and deductions (S748). The read used to be `if (!data) return`.
  const [compsState, setCompsState] = useState('loading')
  const [compsError, setCompsError] = useState('')
  const [saving, setSaving]         = useState(false)
  const [error, setError]           = useState('')
  // Your own pay is the Owner's to set (S798 3a, H2): the database refuses it (hr_own_pay), so the
  // form opens read-only rather than offering a Save it would refuse. The Owner and operator are exempt.
  const isOwnEmployee = useIsOwnEmployee(useMemo(() => ({ [employee.id]: employee }), [employee]))
  const isOwn = isOwnEmployee(employee.id)

  useEffect(() => {
    let live = true
    setCompsState('loading'); setCompsError('')
    scopedFrom('hr_salary_components').eq('employee_id', employee.id).order('created_at')
      .then(({ data, error: readErr }) => {
        if (!live) return
        if (readErr) { setCompsState('failed'); setCompsError(errorLine(readErr)); return }
        const rows = data || []
        const da = rows.find(c => c.name === 'Dearness Allowance' && c.type === 'earning')
        setDearness(da ? String(da.value) : '')
        setComponents(rows.filter(c => !(c.name === 'Dearness Allowance' && c.type === 'earning')))
        setCompsState('ok')
      })
    return () => { live = false }
  }, [employee.id, scopedFrom])

  function set(field, value) { setForm(f => ({ ...f, [field]: value })) }

  function addComponent(type, name = '') {
    // The CIT chip arrives already marked as a retirement contribution; a hand-added deduction does
    // not, because payroll takes a marked one off taxable income and that must be a choice.
    setComponents(c => [...c, { name, type, calc_type: 'fixed', value: '', retirement_fund: type === 'deduction' && name === CIT_CHIP }])
  }
  function updateComponent(i, field, value) {
    setComponents(c => c.map((comp, idx) => idx === i ? { ...comp, [field]: value } : comp))
  }
  function removeComponent(i) {
    setComponents(c => c.filter((_, idx) => idx !== i))
  }

  async function handleSave() {
    if (isOwn) return
    if (compsState !== 'ok') {
      setError(compsState === 'loading'
        ? 'Still loading this employee\'s allowances — wait a moment, then Save.'
        : 'This employee\'s allowances and deductions could not be loaded, so nothing was saved: saving now would erase them. Close and reopen to try again.')
      return
    }
    const invalidComp = components.find(c => !c.name.trim())
    if (invalidComp) { setError('All salary components need a name.'); setTab('salary'); return }
    setError('')
    setSaving(true)

    const { data: savedRows, error: err } = await scopedUpdate('hr_employees', {
      pay_basis:       form.pay_basis,
      basic_salary:    parseFloat(form.basic_salary) || 0,
      bank_name:       form.bank_name || null,
      bank_account_no: form.bank_account_no || null,
      bank_branch:     form.bank_branch || null,
      ssf_no:                   form.ssf_no || null,
      ssf_enrolled:             form.ssf_enrolled,
      life_insurance_premium:   parseFloat(form.life_insurance_premium) || 0,
      health_insurance_premium: parseFloat(form.health_insurance_premium) || 0,
    }).eq('id', employee.id).select('id')
    if (err) { setError('The pay details were not saved. ' + errorLine(err)); setSaving(false); return }
    // A write RLS refuses is 0 rows and no error — writes here need HR manager rank (S798) — so an
    // unchecked count read as saved and went on to replace the allowances below.
    if (!savedRows?.length) { setError('The pay details were not saved. ' + NOT_SAVED_RLS); setSaving(false); return }

    // Build component rows — dearness first (if set), then the rest. Delete-then-insert: once the
    // delete has landed the employee has NO components until the insert does, so each half names
    // the state it leaves behind (S682).
    const { error: delErr } = await scopedDelete('hr_salary_components').eq('employee_id', employee.id)
    if (delErr) { setError('Basic pay and bank details were saved, but the salary components were not updated — they are still the previous set. Save again. ' + errorLine(delErr)); setSaving(false); return }
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
        retirement_fund: c.type === 'deduction' && !!c.retirement_fund,
      })),
    ]
    if (rows.length > 0) {
      const { error: compErr } = await scopedInsert('hr_salary_components', rows)
      if (compErr) { setError('The salary components were cleared but could not be re-saved — this employee currently has NO allowances or deductions on record. Save again now. ' + errorLine(compErr)); setSaving(false); return }
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
  // Payroll's own SSF rule: the switch AND a registration number (isSsfContributor). The preview
  // used the switch alone, so an enrolled employee with no number showed 11% coming off that
  // payroll never takes — a Net here NPR 2,750 lower than the payslip at 25,000 basic.
  const ssfActive     = isSsfContributor(form)
  const ssfNoMissing  = !!form.ssf_enrolled && !ssfActive
  const ssf_base      = ssfActive ? Math.min(basic, SSF_CAP) : 0
  const ssf_employee  = Math.round(ssf_base * SSF_EMPLOYEE_PCT)
  const ssf_employer  = Math.round(ssf_base * SSF_EMPLOYER_PCT)
  const gross         = basic + dearnessAmt + otherEarnings
  const totalDed      = ssf_employee + totalDeductions
  const net           = gross - totalDed
  const ctc           = gross + ssf_employer

  const isMonthly = (form.pay_basis || 'monthly') === 'monthly'
  const showSummary = basic > 0 && isMonthly
  const payUnit   = (PAY_BASES.find(p => p.key === form.pay_basis) || PAY_BASES[0]).unit
  const minRate   = minRateFor(form.pay_basis, employee.employment_type)

  // Validation flags
  const basicBelowMin    = isMonthly && basic > 0 && basic < MIN_BASIC_MONTHLY
  const dearnessBelowMin = isMonthly && dearnessAmt > 0 && dearnessAmt < MIN_DEARNESS_MONTHLY
  const grossBelowMin    = isMonthly && gross > 0 && gross < MIN_WAGE_MONTHLY
  const rateBelowMin     = !isMonthly && basic > 0 && basic < minRate
  const basicTooLow      = isMonthly && gross > 0 && basic < gross * MIN_BASIC_PCT_OF_GROSS

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
          <Tabs idBase="pay-form" label="Pay setup sections" tabs={TABS} active={tab} onChange={setTab} style={{ marginBottom: 0 }} />
        </div>

        {/* Body. A fieldset so your own record's inputs, chips and remove buttons go read-only together. */}
        <fieldset disabled={isOwn} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          {isOwn && (
            <div role="status" className="note-banner" style={{ margin: '16px 24px 0' }}>
              <strong>This is your own pay.</strong> The Owner sets your own pay, bank and SSF details, so you can read them here but not change them.
            </div>
          )}
          {tab === 'salary' && (
            // One condition for the grid and the pane it makes room for (S803): the grid used to split
            // whenever basic was set, while the summary renders only for monthly pay, so a daily or
            // hourly employee's form sat in half the dialog beside an empty column.
            <div className={`split-pane${showSummary ? '' : ' split-pane--single'}`}>

              {/* Left column — inputs */}
              <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>

                {compsState === 'failed' && (
                  <div role="alert" style={{ padding: '10px 14px', fontSize: 12, lineHeight: 1.6, color: 'var(--theme-red-text)', background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)' }}>
                    This employee's allowances and deductions could not be loaded, so Save is off — saving now would erase them. Close and reopen to try again.
                    <div style={{ marginTop: 4, fontSize: 11, color: 'var(--theme-text3)' }}>{compsError}</div>
                  </div>
                )}

                {/* Pay Basis */}
                <div style={col}>
                  <label style={lbl} htmlFor="pf-pay-basis">
                    <Tip text="Monthly — fixed salary each month. Daily / Hourly — actual pay is computed from attendance records in Payroll." width={300}>Pay Basis</Tip>
                  </label>
                  <select id="pf-pay-basis" className="form-select" style={{ width: '100%' }} value={form.pay_basis || 'monthly'} onChange={e => set('pay_basis', e.target.value)}>
                    {PAY_BASES.map(p => <option key={p.key} value={p.key}>{p.label}</option>)}
                  </select>
                </div>

                {/* Basic Salary */}
                <div style={col}>
                  <label style={lbl} htmlFor="pf-basic-salary">
                    <Tip text={isMonthly
                      ? 'Monthly basic salary in NPR. SSF is computed on basic only (capped at NPR 100,000). Minimum NPR 12,170 — the minimum wage fixed from Shrawan 2082 under the Labour Act 2074.'
                      : `Pay rate per ${payUnit} in NPR. Actual pay is computed from attendance in Payroll.`} width={300}>
                      {isMonthly ? 'Basic Salary (NPR / month)' : `Rate (NPR / ${payUnit})`}
                    </Tip>
                  </label>
                  <input id="pf-basic-salary" type="number" min="0" className="form-input"
                    placeholder={isMonthly ? 'e.g. 25000' : payUnit === 'day' ? 'e.g. 800' : 'e.g. 110'}
                    value={form.basic_salary}
                    onChange={e => set('basic_salary', e.target.value)} />
                  {basicBelowMin && (
                    <span style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 4 }}>
                      ⚠ Below minimum basic — Nepal requires at least NPR {fmt(MIN_BASIC_MONTHLY)} / month.
                    </span>
                  )}
                  {rateBelowMin && (
                    <span style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 4 }}>
                      ⚠ Below minimum wage — Nepal requires at least NPR {fmt(minRate)} / {payUnit}.
                    </span>
                  )}
                  {basicTooLow && !basicBelowMin && (
                    <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>
                      ⚠ Basic is below 60% of gross (NPR {fmt(gross * 0.6)}). Labour Act requires basic ≥ 60% of total pay.
                    </span>
                  )}
                </div>

                {/* Dearness Allowance — monthly only */}
                {isMonthly && (
                  <div style={col}>
                    <label style={lbl} htmlFor="pf-dearness">
                      <Tip text="Statutory dearness allowance (महँगी भत्ता). Minimum NPR 7,380 / month — part of the minimum wage fixed from Shrawan 2082. Separate from basic salary — SSF is not computed on this." width={300}>
                        Dearness Allowance (NPR / month)
                      </Tip>
                    </label>
                    <input id="pf-dearness" type="number" min="0" className="form-input"
                      placeholder="e.g. 7380"
                      value={dearness}
                      onChange={e => setDearness(e.target.value)} />
                    {dearnessBelowMin && (
                      <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>
                        ⚠ Below minimum dearness allowance — Nepal requires at least NPR {fmt(MIN_DEARNESS_MONTHLY)} / month.
                      </span>
                    )}
                    {grossBelowMin && !dearnessBelowMin && (
                      <span style={{ fontSize: 11, color: 'var(--theme-red-text)', marginTop: 4 }}>
                        ⚠ Total gross (NPR {fmt(gross)}) is below the minimum wage of NPR {fmt(MIN_WAGE_MONTHLY)} / month.
                      </span>
                    )}
                  </div>
                )}

                {!isMonthly && (
                  <div style={{ padding: '14px 16px', background: 'var(--theme-input-bg)', borderRadius: 0, border: '1px solid var(--theme-border)', fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
                    This employee is paid <strong style={{ color: 'var(--theme-text1)' }}>per {payUnit}</strong>. Actual pay each period is calculated from days/hours worked via <strong style={{ color: 'var(--theme-text3)' }}>Attendance → Payroll</strong>. Allowances and deductions are not configured for daily/hourly workers.
                  </div>
                )}

                {/* Other Allowances — monthly only */}
                {isMonthly && (
                  <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Other Allowances</span>
                      <button type="button" className="btn btn-ghost btn-sm" aria-label="Add an allowance" onClick={() => addComponent('earning')}>+ Add</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {QUICK_EARNINGS.filter(n => !earnings.find(c => c.name === n)).map(n => (
                        <button key={n} type="button" className="btn btn-ghost btn-sm" aria-label={`Add ${n}`} onClick={() => addComponent('earning', n)}>
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
                        <div key={i} style={{ ...compRow, marginBottom: 6 }}>
                          <input className="form-input" style={{ flex: '2 1 140px', minWidth: 0 }} aria-label={`Allowance ${i + 1} name`} placeholder="Name" value={comp.name} onChange={e => updateComponent(globalIdx, 'name', e.target.value)} />
                          <select className="form-select" style={{ flex: '1 1 104px', minWidth: 0, padding: '8px 6px' }} aria-label={`Allowance ${i + 1} calculation type`} value={comp.calc_type} onChange={e => updateComponent(globalIdx, 'calc_type', e.target.value)}>
                            <option value="fixed">Fixed NPR</option>
                            <option value="percent_of_basic">% of Basic</option>
                          </select>
                          <input type="number" min="0" className="form-input" style={{ flex: '1 1 80px', minWidth: 0, textAlign: 'right' }}
                            aria-label={`Allowance ${i + 1} amount`}
                            placeholder={comp.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                            value={comp.value}
                            onChange={e => updateComponent(globalIdx, 'value', e.target.value)} />
                          {comp.calc_type === 'percent_of_basic' && basic > 0 && (
                            <span style={{ fontSize: 11, color: 'var(--theme-text2)', whiteSpace: 'nowrap', minWidth: 56, textAlign: 'right' }}>= {fmt(computed)}</span>
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
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Deductions</span>
                      <button type="button" className="btn btn-ghost btn-sm" aria-label="Add a deduction" onClick={() => addComponent('deduction')}>+ Add</button>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                      {QUICK_DEDUCTIONS.filter(n => !deductions.find(c => c.name === n)).map(n => {
                        const chip = (
                          <button type="button" className="btn btn-ghost btn-sm" aria-label={`Add ${n}`} onClick={() => addComponent('deduction', n)}>
                            + {n}
                          </button>
                        )
                        return QUICK_DEDUCTION_TIPS[n]
                          ? <Tip key={n} text={QUICK_DEDUCTION_TIPS[n]} width={330}>{chip}</Tip>
                          : <span key={n}>{chip}</span>
                      })}
                    </div>
                    {/* SSF auto row */}
                    {basic > 0 && ssfActive && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', background: 'var(--theme-input-bg)', borderRadius: 0, marginBottom: 6, border: '1px solid var(--theme-border)' }}>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                          <Tip text="11% of basic salary deducted from the employee each month. Mandatory under SSF Act. Basic is capped at NPR 100,000 for SSF calculation." width={280}>
                            SSF — Employee (11%){basic > SSF_CAP ? ' · capped' : ''} · auto
                          </Tip>
                        </span>
                        <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 500 }}>NPR {fmt(ssf_employee)}</span>
                      </div>
                    )}
                    {basic > 0 && ssfNoMissing && (
                      <div style={{ padding: '7px 10px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
                        ⚠ SSF is switched on but there is no SSF No. yet — payroll deducts no SSF (and charges the 1% social security tax) until the number is entered on the Bank / SSF tab.
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
                        <div key={i} style={{ marginBottom: 8 }}>
                        <div style={compRow}>
                          <input className="form-input" style={{ flex: '2 1 140px', minWidth: 0 }} aria-label={`Deduction ${i + 1} name`} placeholder="Name" value={comp.name} onChange={e => updateComponent(globalIdx, 'name', e.target.value)} />
                          <select className="form-select" style={{ flex: '1 1 104px', minWidth: 0, padding: '8px 6px' }} aria-label={`Deduction ${i + 1} calculation type`} value={comp.calc_type} onChange={e => updateComponent(globalIdx, 'calc_type', e.target.value)}>
                            <option value="fixed">Fixed NPR</option>
                            <option value="percent_of_basic">% of Basic</option>
                          </select>
                          <input type="number" min="0" className="form-input" style={{ flex: '1 1 80px', minWidth: 0, textAlign: 'right' }}
                            aria-label={`Deduction ${i + 1} amount`}
                            placeholder={comp.calc_type === 'percent_of_basic' ? '%' : 'NPR'}
                            value={comp.value}
                            onChange={e => updateComponent(globalIdx, 'value', e.target.value)} />
                          {comp.calc_type === 'percent_of_basic' && basic > 0 && (
                            <span style={{ fontSize: 11, color: 'var(--theme-text2)', whiteSpace: 'nowrap', minWidth: 56, textAlign: 'right' }}>= {fmt(computed)}</span>
                          )}
                          <button onClick={() => removeComponent(globalIdx)} aria-label={`Remove deduction ${comp.name || i + 1}`} style={{ background: 'none', border: 'none', color: 'var(--theme-text2)', fontSize: 16, cursor: 'pointer', flexShrink: 0, padding: '0 4px' }}>✕</button>
                        </div>
                        {/* S748: payroll takes a marked deduction off taxable income, inside the cap it
                            shares with SSF. A checkbox rather than a name match, because the owner
                            names these rows and a guess would move real tax. */}
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--theme-text2)', marginTop: 4, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!comp.retirement_fund} onChange={e => updateComponent(globalIdx, 'retirement_fund', e.target.checked)} />
                          <Tip text="Tick for CIT, provident fund or another approved retirement fund. Payroll then takes this deduction off the employee's taxable income, together with SSF, up to NPR 5,00,000 a year or a third of their income, whichever is lower. Leave unticked for anything else. Advances are never a deduction here: payroll recovers them itself from Advances & Loans." width={300}>
                            Retirement fund — reduces taxable income
                          </Tip>
                        </label>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* Right column — live summary (only when basic is set) */}
              {showSummary && (
                <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <p style={{ margin: '0 0 8px', fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Monthly Summary</p>
                  <p style={{ margin: '-4px 0 4px', fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.5 }}>
                    A full month with no absences. Income tax (TDS), overtime, advance recovery and TADA are worked out in Payroll each month, so the payslip's take-home figure will differ.
                  </p>
                  <div style={{ background: 'var(--theme-input-bg)', borderRadius: 0, border: '1px solid var(--theme-border)', overflow: 'hidden' }}>
                    {[
                      { label: 'Basic Salary',           value: basic,          indent: false, color: 'var(--theme-text1)' },
                      dearnessAmt > 0 && { label: 'Dearness Allowance', value: dearnessAmt, indent: true,  color: 'var(--theme-text1)' },
                      otherEarnings > 0 && { label: `Other Allowances${earnings.length > 0 ? ` (${earnings.length})` : ''}`, value: otherEarnings, indent: true, color: 'var(--theme-text1)' },
                      { label: 'Gross Earnings',         value: gross,          indent: false, color: 'var(--theme-text1)', bold: true, separator: true },
                      ssfActive && { label: `SSF Employee (11%${basic > SSF_CAP ? ' · capped' : ''})`, value: -ssf_employee, indent: true, color: 'var(--theme-text1)' },
                      ...deductions.map(c => ({ label: c.name || 'Deduction', value: -calcAmount(c, basic), indent: true, color: 'var(--theme-text1)' })),
                      { label: 'Net before income tax',    value: net,            indent: false, color: 'var(--theme-text1)', bold: true, big: true, separator: true },
                      { label: 'Cost to Company (CTC)',  value: ctc,            indent: false, color: 'var(--theme-text1)', bold: true, big: true, separator: true, bg: 'color-mix(in srgb, var(--theme-text1) 5%, transparent)' },
                      ssfActive && { label: 'Employer SSF (20%)', value: ssf_employer, indent: true,  color: 'var(--theme-text2)', note: 'paid by company' },
                    ].filter(Boolean).map((r, i) => (
                      <div key={i} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: r.big ? '12px 16px' : '7px 16px',
                        borderTop: r.separator ? '1px solid var(--theme-border)' : 'none',
                        background: r.bg || (r.big ? 'color-mix(in srgb, var(--theme-text1) 5%, transparent)' : 'transparent'),
                      }}>
                        <span style={{ fontSize: r.big ? 13 : 12, color: r.indent ? 'var(--theme-text2)' : 'var(--theme-text3)', paddingLeft: r.indent ? 12 : 0, fontWeight: r.bold ? 700 : 400 }}>
                          {r.label}{r.note ? <span style={{ fontSize: 10, color: 'var(--theme-text2)', marginLeft: 6 }}>({r.note})</span> : null}
                        </span>
                        <span style={{ fontSize: r.big ? 15 : 13, color: r.color, fontWeight: r.bold ? 700 : 400 }}>
                          {r.value < 0 ? '− ' : ''}NPR {fmt(Math.abs(r.value))}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Compliance notice */}
                  {(basicBelowMin || dearnessBelowMin || grossBelowMin) && (
                    <div style={{ padding: '12px 14px', background: 'color-mix(in srgb, var(--theme-red) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 20%, transparent)', borderRadius: 0, fontSize: 12, color: 'var(--theme-red-text)', lineHeight: 1.6 }}>
                      <strong>Minimum wage check (FY 2083/84)</strong>
                      <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ color: basic >= MIN_BASIC_MONTHLY ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                          {basic >= MIN_BASIC_MONTHLY ? '✓' : '✗'} Basic ≥ NPR {fmt(MIN_BASIC_MONTHLY)} &nbsp;
                          <span style={{ color: 'var(--theme-text2)' }}>(yours: {fmt(basic)})</span>
                        </div>
                        <div style={{ color: dearnessAmt >= MIN_DEARNESS_MONTHLY ? 'var(--theme-green-text)' : 'var(--theme-amber-text)' }}>
                          {dearnessAmt >= MIN_DEARNESS_MONTHLY ? '✓' : '⚠'} Dearness ≥ NPR {fmt(MIN_DEARNESS_MONTHLY)} &nbsp;
                          <span style={{ color: 'var(--theme-text2)' }}>(yours: {fmt(dearnessAmt)})</span>
                        </div>
                        <div style={{ color: gross >= MIN_WAGE_MONTHLY ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                          {gross >= MIN_WAGE_MONTHLY ? '✓' : '✗'} Gross ≥ NPR {fmt(MIN_WAGE_MONTHLY)} &nbsp;
                          <span style={{ color: 'var(--theme-text2)' }}>(yours: {fmt(gross)})</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* All clear */}
                  {!basicBelowMin && !dearnessBelowMin && !grossBelowMin && gross > 0 && (
                    <div style={{ padding: '10px 14px', background: 'color-mix(in srgb, var(--theme-green) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 15%, transparent)', borderRadius: 0, fontSize: 12, color: 'var(--theme-green-text)' }}>
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
                <input id="pf-bank-name" className="form-input" placeholder="e.g. NIC Asia Bank, Laxmi Sunrise" value={form.bank_name} onChange={e => set('bank_name', e.target.value)} />
              </div>
              <div style={row}>
                <div style={{ ...rowCol, flex: '2 1 200px' }}>
                  <label style={lbl} htmlFor="pf-bank-account">Account No.</label>
                  <input id="pf-bank-account" className="form-input" placeholder="Bank account number" value={form.bank_account_no} onChange={e => set('bank_account_no', e.target.value)} />
                </div>
                <div style={rowCol}>
                  <label style={lbl} htmlFor="pf-bank-branch">Branch</label>
                  <input id="pf-bank-branch" className="form-input" placeholder="e.g. Thamel" value={form.bank_branch} onChange={e => set('bank_branch', e.target.value)} />
                </div>
              </div>
              <div style={{ borderTop: '1px solid var(--theme-border)', paddingTop: 20 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 12px' }}>SSF Details</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  {/* Toggle switch */}
                  {/* Off-track is slate (text3), not the border token — on Light the border is
                      #ddd6cf and a white knob on it measured ~1.2:1, so the switch's state was
                      unreadable. The knob is the card colour, which contrasts with both tracks on
                      both presets (S682). */}
                  <button type="button" id="pay-ssf-enrolled" role="switch" aria-checked={form.ssf_enrolled} aria-label="SSF Enrolled"
                    onClick={() => set('ssf_enrolled', !form.ssf_enrolled)}
                    style={{ position: 'relative', width: 42, height: 24, borderRadius: 'var(--radius-full)', cursor: 'pointer', flexShrink: 0, padding: 0, border: 'none', background: form.ssf_enrolled ? 'var(--theme-accent)' : 'var(--theme-text3)', transition: 'background 0.2s' }}>
                    <span style={{ position: 'absolute', top: 3, left: form.ssf_enrolled ? 21 : 3, width: 18, height: 18, borderRadius: 0, background: 'var(--theme-card)', transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' }} />
                  </button>
                  {/* The caption is a <label> for the switch rather than a second, mouse-only onClick. */}
                  <label htmlFor="pay-ssf-enrolled" style={{ fontSize: 13, color: 'var(--theme-text1)', cursor: 'pointer' }}>
                    <Tip text="SSF enrolled employees have 11% deducted from their salary and 20% contributed by the employer. Enable this for employees registered under Nepal's Social Security Fund." width={300}>SSF Enrolled</Tip>
                  </label>
                  {form.ssf_enrolled && <span style={{ fontSize: 11, color: 'var(--theme-green-text)', marginLeft: 'auto' }}>11% emp · 20% employer</span>}
                </div>
                {form.ssf_enrolled && (
                  <div style={col}>
                    <label style={lbl} htmlFor="pf-ssf-no">
                      <Tip text="SSF registration number. Payroll deducts SSF only once this is entered — with the switch on and this blank, no SSF comes off and the 1% social security tax is charged instead. It is also what the SSF challan in HR Reports files under." width={280}>SSF No.</Tip>
                    </label>
                    <input id="pf-ssf-no" className="form-input" placeholder="SSF registration number" value={form.ssf_no} onChange={e => set('ssf_no', e.target.value)} />
                    {ssfNoMissing && (
                      <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>
                        ⚠ Until this is entered, payroll deducts no SSF for this employee and charges the 1% social security tax instead.
                      </span>
                    )}
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
                  <div style={rowCol}>
                    <label style={lbl} htmlFor="pf-life-insurance">
                      <Tip text="Annual life insurance premium paid by the employee. Deductible up to NPR 40,000/year under Nepal Income Tax Act 2058, Section 12. Enter actual premium — excess above 40,000 is ignored." width={300}>Life Insurance Premium (NPR / year)</Tip>
                    </label>
                    <input id="pf-life-insurance" type="number" min="0" className="form-input"
                      placeholder="0  (cap: NPR 40,000)"
                      value={form.life_insurance_premium || ''}
                      onChange={e => set('life_insurance_premium', e.target.value)} />
                    {parseFloat(form.life_insurance_premium) > 40000 && (
                      <span style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 4 }}>Capped at NPR 40,000 — excess ignored in TDS.</span>
                    )}
                  </div>
                  <div style={rowCol}>
                    <label style={lbl} htmlFor="pf-health-insurance">
                      <Tip text="Annual health insurance premium paid by the employee. Deductible up to NPR 20,000/year under Nepal Income Tax Act 2058, Section 12. Enter actual premium — excess above 20,000 is ignored." width={300}>Health Insurance Premium (NPR / year)</Tip>
                    </label>
                    <input id="pf-health-insurance" type="number" min="0" className="form-input"
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
        </fieldset>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--theme-border)', display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
          {error && <span role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', marginRight: 'auto' }}>{error}</span>}
          <button className="btn btn-ghost" onClick={onClose}>{isOwn ? 'Close' : 'Cancel'}</button>
          {!isOwn && <button className="btn btn-primary" onClick={handleSave} disabled={saving || compsState !== 'ok'}>{saving ? 'Saving…' : compsState === 'loading' ? 'Loading…' : 'Save'}</button>}
        </div>

      </div>
    </Modal>
  )
}
