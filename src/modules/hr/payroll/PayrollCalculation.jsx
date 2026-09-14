import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, Fragment, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import { BS_MONTHS, daysInBsMonth } from '../../../utils/bsCalendar'
import { calcAmount, isSsfContributor } from './payrollCompute'
import { slabsFor } from './tds'
import {
  fetchYtdMap, fetchApprovedTadaMap, dueAdvances, payslipDrift, buildPayrollRows,
  fetchPayrollEmployees, fetchEmployeesByIds, FRESHNESS_INPUT_FIELDS,
} from './payrollData'
import { ATTENDANCE_STATUSES, OT_MULTIPLIER, SSF_CAP } from '../payrollConstants'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { firstError } from '../../../shared/queryError'
import { nepalBsLong, nepalDateLong } from '../../../shared/nepalTime'
import RowDisclosure from '../../../components/RowDisclosure'
import ReportLoadError from '../../../components/ReportLoadError'

const fmt = nprInt
const num = v => parseFloat(v) || 0
const pct = rate => `${Math.round(rate * 100)}%`

// The chip box every name-cell flag shares. `display: inline-flex` + no rule on the Tip wrapper
// (S691): as a flex item Tip's inline wrapper stretches and hangs its dashed rule below the chip.
const TIP_CHIP = { display: 'inline-flex', borderBottom: 'none', cursor: 'help' }
const chipStyle = (token, textToken) => ({
  fontSize: 10, fontWeight: 700, color: `var(${textToken})`, borderRadius: 0, padding: '1px 6px',
  background: `color-mix(in srgb, var(${token}) 10%, transparent)`,
  border: `1px solid color-mix(in srgb, var(${token}) 30%, transparent)`,
})

function Section({ title, children }) {
  return (
    <div className="calc-section" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-accent-ink)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  )
}

// No Tip/hover here on purpose — this panel is also what gets printed, and a hover tooltip
// never renders on paper. Any number that needs explaining gets its own visible row instead
// (an `op` operator prefix like "×"/"÷"/"+" reads as a step in a running calculation) or a
// small always-visible `hint` caption underneath.
function Line({ label, value, op, hint, strong, color }) {
  return (
    <div className="calc-line" style={{ padding: '3px 0', borderBottom: '1px dotted var(--theme-border-lt)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5 }}>
        <span style={{ color: 'var(--theme-text2)' }}>{op ? `${op} ${label}` : label}</span>
        <span style={{ color: color || 'var(--theme-text1)', fontWeight: strong ? 700 : 400, whiteSpace: 'nowrap' }}>{value}</span>
      </div>
      {hint && <div style={{ fontSize: 10, color: 'var(--theme-text3)' }}>{hint}</div>}
    </div>
  )
}

// The tax bands a year's taxable income falls through, with the tax each one charges — the same
// walk as tds.js's applySlabs (which only returns the sum), so the rows add up to Annual Tax (S751).
function slabBands(taxable, slabs, isSsf) {
  const out = []
  let prev = 0
  for (const s of slabs) {
    if (taxable <= prev) break
    const band = Math.min(taxable, s.upTo) - prev
    const waived = !!(s.first && isSsf)
    out.push({ from: prev, upTo: s.upTo, band, rate: s.rate, waived, tax: band * (waived ? 0 : s.rate) })
    prev = s.upTo
  }
  return out
}

function bandLabel(b, i) {
  if (i === 0) return `First NPR ${fmt(b.upTo)} at ${pct(b.rate)}`
  if (b.upTo === Infinity) return `Above NPR ${fmt(b.from)} at ${pct(b.rate)}`
  return `Next NPR ${fmt(b.upTo - b.from)} at ${pct(b.rate)}`
}

// What moved between a draft payslip and today's calculation, named — so the Stale tooltip can say
// "Overtime NPR 1,200 → NPR 1,800" instead of claiming net pay changed when it may not have (S751).
// Mirrors payslipDrift's own checks; that function answers WHETHER, this one says WHAT.
const DRIFT_LABELS = {
  gross: 'Gross salary', ot_amount: 'Overtime', absence_deduction: 'Absence deduction', ssf_employee: 'SSF',
  other_deductions: 'Other deductions', advance_deduction: 'Advance cut', retirement_contribution: 'CIT / retirement contribution',
}
const idKey = ids => (Array.isArray(ids) ? [...ids].sort().join(',') : '')
const differ = (a, b) => Math.round(num(a)) !== Math.round(num(b))

function driftParts(stored, live) {
  const parts = FRESHNESS_INPUT_FIELDS
    .filter(f => differ(stored[f], live[f]))
    .map(f => `${DRIFT_LABELS[f] || f} NPR ${fmt(num(stored[f]))} → NPR ${fmt(num(live[f]))}`)
  const idsMoved = idKey(stored.tada_claim_ids) !== idKey(live.tada_claim_ids)
  if (idsMoved || differ(stored.tada_amount, live.tada_amount)) {
    parts.push(`Travel claims (TADA) NPR ${fmt(num(stored.tada_amount))} → NPR ${fmt(num(live.tada_amount))}${idsMoved ? ' (a different set of approved claims)' : ''}`)
  }
  if (differ(stored.tds, live.tds) && !stored.tds_overridden) {
    parts.push(`Income tax (TDS) NPR ${fmt(num(stored.tds))} → NPR ${fmt(num(live.tds))}`)
  }
  return parts
}

// A draft (or not-yet-generated) month: the full live working, from buildPayrollRows' detail.
function CalcDetail({ row, monthDays, advances, ytd }) {
  const { emp, comps, breakdown: b, tdsBreakdown, tdsCapped, advanceDue, tada, slip } = row
  const t = b.tally
  // Callers pass dueAdvances(advances, period): open AND past the first recovery month, so an
  // advance issued this month is not counted here while the deduction line below shows nothing
  // for it. Filtering on `status` alone counted advances the run was not recovering.
  const empAdvances = advances.filter(a => a.employee_id === emp.id)
  const fyLabel = `${tdsBreakdown.fyStart % 100}/${(tdsBreakdown.fyStart + 1) % 100}`
  const earningComps = comps.filter(c => c.type === 'earning')
  const monthActual = slip.gross + slip.ot_amount - slip.absence_deduction
  const bands = slabBands(tdsBreakdown.annualTaxable, slabsFor(tdsBreakdown.fyStart, emp.marital_status === 'married'), tdsBreakdown.isSsf)
  const ytdBonus = num(ytd?.bonus)
  const ytdBonusWithheld = num(ytd?.bonusWithheld)
  const advanceOwed = Math.max(0, advanceDue - slip.advance_deduction)
  const cut = b.otherDeductionsCut || 0

  return (
    <div className="calc-detail-grid" style={{ padding: '18px 22px', background: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 36px' }}>
      <div>
        <Section title="Attendance Tally">
          {ATTENDANCE_STATUSES.map(s => (
            <Line key={s.key} label={s.label} value={t[s.key] || 0} />
          ))}
          <Line
            label="Total Days" strong
            value={ATTENDANCE_STATUSES.reduce((sum, s) => sum + (t[s.key] || 0), 0)}
            hint={b.basis === 'monthly'
              ? `Marked days only. Days left unmarked on the sheet are PAID for monthly staff — only absences, unpaid leave and half days take pay off (this month has ${monthDays} days).`
              : 'Marked days only. Daily and hourly staff are paid for the days and hours marked — an unmarked day pays nothing.'}
          />
          <Line label="Hours Worked" value={(t.sumHours || 0).toFixed(1)} />
        </Section>

        {b.basis === 'monthly' && (
          <Section title="Gross Salary">
            <Line label="Basic Salary" value={`NPR ${fmt(emp.basic_salary)}`} />
            {earningComps.map(c => (
              <Line key={c.id} label={c.name || 'Allowance'} op="+" value={`NPR ${fmt(calcAmount(c, emp.basic_salary))}`} />
            ))}
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent-ink)" hint="The full month's salary before anything is taken off." />
          </Section>
        )}
        {b.basis === 'daily' && (
          <Section title="Gross (Daily)">
            <Line label="Present Days" value={t.present || 0} />
            <Line label="Half-day × 0.5" op="+" value={((t.half_day || 0) * 0.5).toFixed(2)} />
            <Line label="Paid Leave Days" op="+" value={t.paid_leave || 0} />
            <Line label="Half-day Paid Leave × 0.5" op="+" value={((t.half_paid_leave || 0) * 0.5).toFixed(2)} />
            <Line label="Holiday Days (paid)" op="+" value={t.holiday || 0} />
            <Line label="Worked Days" op="=" value={`${b.workedDays.toFixed(2)} days`} strong />
            <Line label="Daily Rate" value={`NPR ${fmt(b.dailyRate)}`} />
            <Line label="Worked Days" op="×" value={`${b.workedDays.toFixed(2)} days`} />
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent-ink)" />
          </Section>
        )}
        {b.basis === 'hourly' && (
          <Section title="Gross (Hourly)">
            <Line label="Hours Worked" value={(t.sumHours || 0).toFixed(2)} />
            <Line label="OT Hours (paid in Overtime below)" op="−" value={((t.sumHours || 0) - (b.regularHours ?? t.sumHours ?? 0)).toFixed(2)} />
            <Line label="Paid Leave × 8h" op="+" value={((t.paid_leave || 0) * 8).toFixed(2)} />
            <Line label="Half-day Paid Leave × 4h" op="+" value={((t.half_paid_leave || 0) * 4).toFixed(2)} />
            <Line label="Holiday × 8h" op="+" value={((t.holiday || 0) * 8).toFixed(2)} />
            <Line label="Paid Hours" op="=" value={`${b.paidHours.toFixed(2)} hrs`} strong />
            <Line label="Hourly Rate" value={`NPR ${fmt(b.hourlyRate)}`} />
            <Line label="Paid Hours" op="×" value={`${b.paidHours.toFixed(2)} hrs`} />
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong color="var(--theme-accent-ink)" />
          </Section>
        )}

        {b.basis === 'monthly' && (
          <Section title="Absence Deduction">
            <Line label="Absent Days" value={t.absent || 0} />
            <Line label="Unpaid Leave Days" op="+" value={t.unpaid_leave || 0} />
            <Line label="Half-day × 0.5" op="+" value={((t.half_day || 0) * 0.5).toFixed(2)} />
            <Line label="Half-day Unpaid Leave × 0.5" op="+" value={((t.half_unpaid_leave || 0) * 0.5).toFixed(2)} />
            {b.preJoinDays > 0 && <Line label="Not Yet Joined Days" op="+" value={b.preJoinDays} hint="Days this month before the employee's join date" />}
            {b.postExitDays > 0 && <Line label="Days after last working day" op="+" value={b.postExitDays} hint="Days this month after the employee's last working day (their end date)" />}
            <Line label="Unpaid Days" op="=" value={`${b.unpaidDays.toFixed(2)} days`} strong />
            <Line label="Gross" value={`NPR ${fmt(b.gross)}`} />
            <Line label="Days in Month" op="÷" value={monthDays} />
            <Line label="Per-Day Rate" op="=" value={`NPR ${fmt(b.perDay)}`} strong />
            <Line label="Per-Day Rate" value={`NPR ${fmt(b.perDay)}`} />
            <Line label="Unpaid Days" op="×" value={`${b.unpaidDays.toFixed(2)} days`} />
            <Line label="Absence Deduction" op="=" value={`− NPR ${fmt(slip.absence_deduction)}`} strong color="var(--theme-red-text)" />
          </Section>
        )}

        <Section title="Overtime — Attendance Sheet">
          <Line label="Attendance OT Hours (paid)" value={`${(b.otAttendanceHrs || 0).toFixed(1)}h`} />
          {(b.otSupersededHrs || 0) > 0 && (
            <Line
              label="Not paid — superseded"
              value={`${b.otSupersededHrs.toFixed(1)}h`}
              hint="Typed on the attendance sheet for days that also have an approved Overtime entry. The approved entry is what gets paid for those days, so these hours are excluded rather than added."
            />
          )}
          <Line label="Hourly Rate" op="×" value={`NPR ${fmt(b.hourlyRate)}`} />
          <Line label="OT Multiplier" op="×" value={`${OT_MULTIPLIER}×`} />
          <Line label="Attendance OT Amount" op="=" value={`NPR ${fmt(b.otAttendanceAmt)}`} strong color="var(--theme-green-text)" />
        </Section>

        <Section title="Overtime — Approved Entries (Overtime module)">
          <Line label="Approved OT Hours" value={`${(b.otApprovedHrs || 0).toFixed(1)}h`} hint="From the Overtime module's approval workflow. Where a day appears in both places this is the figure that gets paid, and it is the only route to the holiday 2× rate." />
          <Line label="Approved OT Amount" op="=" value={`NPR ${fmt(b.otApprovedAmt)}`} strong color="var(--theme-green-text)" />
          <Line label="Total OT paid" value={`${((b.otAttendanceHrs || 0) + (b.otApprovedHrs || 0)).toFixed(1)}h → NPR ${fmt(slip.ot_amount)}`} strong color="var(--theme-green-text)" />
        </Section>
      </div>

      <div>
        {/* Gated on isSsfContributor(emp), the engine's own test (S751): gated on the flag alone,
            an enrolled employee with no SSF number printed "× 11% = − NPR 0" as though a real
            contribution had been worked out. */}
        {isSsfContributor(emp) ? (
          <Section title="SSF">
            {b.basis === 'monthly' && (
              <>
                <Line label="Basic Salary" value={`NPR ${fmt(emp.basic_salary)}`} />
                <Line label="Paid Fraction" op="×" value={`${(b.paidFraction * 100).toFixed(1)}%`} hint="1 − (Unpaid Days ÷ Days in Month)" />
              </>
            )}
            <Line label="SSF Base" op={b.basis === 'monthly' ? '=' : undefined} value={`NPR ${fmt(b.ssfBase)}`} hint={`Capped at NPR ${fmt(SSF_CAP)}`} />
            <Line label="Employee Rate" op="×" value="11%" />
            <Line label="Employee SSF" op="=" value={`− NPR ${fmt(slip.ssf_employee)}`} strong color="var(--theme-red-text)" />
            <Line label="Employer SSF (20%)" value={`NPR ${fmt(slip.ssf_employer)}`} color="var(--theme-text2)" hint="Paid by the business on top of salary — not taken from the employee's pay." />
          </Section>
        ) : emp.ssf_enrolled ? (
          <Section title="SSF">
            <Line label="SSF number missing — nothing deducted" value="NPR 0" color="var(--theme-amber-text)" hint="Marked as enrolled in SSF, but no SSF number is on file, so no contribution is taken and the 1% tax band is not waived. Add the number in Pay Setup." />
          </Section>
        ) : null}

        <Section title={`Income tax (TDS) — FY ${fyLabel}, month ${tdsBreakdown.monthInFy} of 12`}>
          <Line label="Gross" value={`NPR ${fmt(slip.gross)}`} />
          <Line label="Overtime" op="+" value={`NPR ${fmt(slip.ot_amount)}`} hint="Overtime pay is taxed like salary." />
          <Line label="Absence Deduction" op="−" value={`NPR ${fmt(slip.absence_deduction)}`} hint="Tax is on the pay actually earned, not the contract figure." />
          <Line label="This month's pay" op="=" value={`NPR ${fmt(monthActual)}`} strong />
          <Line
            label="Paid in earlier months this year"
            value={`NPR ${fmt(tdsBreakdown.ytdGross)}`}
            hint={ytdBonus > 0
              ? `From finalized payslips this fiscal year, incl. festival/bonus NPR ${fmt(ytdBonus)}.`
              : 'From finalized payslips earlier this fiscal year.'}
          />
          <Line label="This month's pay" op="+" value={`NPR ${fmt(monthActual)} × ${tdsBreakdown.monthsAtCurrent}`} hint={`Assumed for the ${tdsBreakdown.monthsAtCurrent} months left in the year (including this one).`} />
          <Line label="Expected income for the year" op="=" value={`NPR ${fmt(tdsBreakdown.annualGross)}`} strong />
          <Line label="Retirement savings (SSF + CIT)" op="−" value={`NPR ${fmt(tdsBreakdown.retirementDeduction)}`} hint="SSF plus CIT / provident fund lower taxable income, together up to NPR 5,00,000 or a third of income." />
          <Line label="Insurance premiums" op="−" value={`NPR ${fmt(tdsBreakdown.insuranceDeduction)}`} hint="Life (up to NPR 40,000) and health (up to NPR 20,000) premiums lower taxable income." />
          <Line label="Taxable income for the year" op="=" value={`NPR ${fmt(tdsBreakdown.annualTaxable)}`} strong />
          {bands.length === 0 ? (
            <Line label="Tax bands" value="NPR 0" hint="Nothing taxable this year." />
          ) : bands.map((band, i) => (
            <Line
              key={i}
              label={bandLabel(band, i)}
              op={i === 0 ? undefined : '+'}
              value={`NPR ${fmt(band.tax)}`}
              hint={band.waived
                ? `NPR ${fmt(band.band)} of the year's income falls here — waived because this employee pays into SSF.`
                : `NPR ${fmt(band.band)} of the year's income falls here.`}
            />
          ))}
          <Line label="Tax for the year" op="=" value={`NPR ${fmt(tdsBreakdown.annualTax)}`} strong />
          <Line label="Tax due by this month" value={`NPR ${fmt(tdsBreakdown.cumulativeDue)}`} hint={`The year's tax spread evenly over the months paid: month ${tdsBreakdown.monthsEmployedSoFar} of ${tdsBreakdown.monthsEmployedTotal}.`} />
          <Line
            label="Already withheld this year" op="−"
            value={`NPR ${fmt(tdsBreakdown.ytdWithheld)}`}
            hint={ytdBonusWithheld > 0 ? `incl. NPR ${fmt(ytdBonusWithheld)} withheld on festival/bonus payments.` : undefined}
          />
          <Line label="This month's income tax (TDS)" op="=" value={`− NPR ${fmt(tdsBreakdown.tds)}`} strong color="var(--theme-red-text)" />
          {tdsCapped > 0 && (
            <Line
              label="Withheld this month" value={`− NPR ${fmt(slip.tds)}`} strong color="var(--theme-red-text)"
              hint={`Pay left after SSF and fixed deductions only covered NPR ${fmt(slip.tds)}. The NPR ${fmt(tdsCapped)} not withheld is picked up by later months' tax.`}
            />
          )}
        </Section>

        <Section title="Advance & TADA">
          <Line label="Advances in recovery this month" value={empAdvances.length} hint="Recovery starts the month after an advance is issued" />
          <Line label="Advance cut due" value={`NPR ${fmt(advanceDue)}`} hint="Each advance's instalment, or what is left of it if less." />
          <Line
            label="Advance cut taken" value={`− NPR ${fmt(slip.advance_deduction)}`} color="var(--theme-red-text)"
            hint={advanceOwed > 0 ? `NPR ${fmt(advanceOwed)} of the advance cut is still owed — taken by later cuts. Pay left after tax was not enough for the whole instalment.` : undefined}
          />
          <Line label="Travel claims paid by this payroll" value={tada.ids.length} hint="Approved claims whose trip ended by the end of this month." />
          <Line label="TADA Reimbursement" value={`+ NPR ${fmt(slip.tada_amount)}`} color="var(--theme-green-text)" />
        </Section>

        <Section title="Net Pay">
          <Line label="Gross" value={`NPR ${fmt(slip.gross)}`} />
          <Line label="OT" op="+" value={`NPR ${fmt(slip.ot_amount)}`} color="var(--theme-green-text)" />
          <Line label="Absence" op="−" value={`NPR ${fmt(slip.absence_deduction)}`} color="var(--theme-red-text)" />
          <Line label="SSF" op="−" value={`NPR ${fmt(slip.ssf_employee)}`} color="var(--theme-red-text)" />
          <Line
            label="Other Deductions" op="−" value={`NPR ${fmt(slip.other_deductions)}`} color="var(--theme-red-text)"
            hint={[
              slip.retirement_contribution > 0 ? `incl. CIT / provident fund NPR ${fmt(slip.retirement_contribution)}` : null,
              cut > 0 ? `The fixed deductions (NPR ${fmt(slip.other_deductions + cut)}) were reduced by NPR ${fmt(cut)} so take-home pay did not go below zero.` : null,
            ].filter(Boolean).join('. ') || undefined}
          />
          <Line label="Income tax (TDS)" op="−" value={`NPR ${fmt(slip.tds)}`} color="var(--theme-red-text)" />
          <Line label="Advance" op="−" value={`NPR ${fmt(slip.advance_deduction)}`} color="var(--theme-red-text)" />
          <Line label="TADA" op="+" value={`NPR ${fmt(slip.tada_amount)}`} color="var(--theme-green-text)" />
          <Line label="Net Pay" op="=" value={`NPR ${fmt(slip.net_pay)}`} strong color="var(--theme-accent-ink)" />
        </Section>
      </div>
    </div>
  )
}

// A stored payslip explained as it was paid (decision 12, S751). Nothing here is recomputed: a
// finalized month is locked, and today's salaries, attendance or tax data may no longer be what
// that month was paid on — so a fresh calculation could disagree with the money that actually moved.
function StoredDetail({ slip, intro }) {
  const basis = slip.pay_basis || 'monthly'
  const claims = Array.isArray(slip.tada_claim_ids) ? slip.tada_claim_ids.length : 0
  const retirement = num(slip.retirement_contribution)
  const grossHint = basis === 'daily'
    ? `${num(slip.worked_days).toFixed(2)} days paid × daily rate NPR ${fmt(num(slip.basic))}.`
    : basis === 'hourly'
      ? `Hours paid × hourly rate NPR ${fmt(num(slip.basic))}.`
      : `Basic NPR ${fmt(num(slip.basic))} plus allowances NPR ${fmt(num(slip.allowances))} — the full month's salary before anything is taken off.`
  return (
    <div style={{ padding: '14px 22px 18px', background: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)' }}>
      <div style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, marginBottom: 12 }}>{intro}</div>
      <div className="calc-detail-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 36px' }}>
        <div>
          <Section title="Pay">
            <Line label="Gross" value={`NPR ${fmt(num(slip.gross))}`} strong hint={grossHint} />
            <Line label="Overtime" op="+" value={`NPR ${fmt(num(slip.ot_amount))}`} color="var(--theme-green-text)" hint={num(slip.ot_hours) > 0 ? `${num(slip.ot_hours).toFixed(1)} hours of overtime.` : 'No overtime paid.'} />
            {basis === 'monthly' && (
              <Line
                label="Absence" op="−" value={`NPR ${fmt(num(slip.absence_deduction))}`} color="var(--theme-red-text)"
                hint={slip.unpaid_days != null
                  ? `${num(slip.unpaid_days).toFixed(2)} unpaid days (absences, unpaid leave, half days, and days not yet joined or after leaving) at the month's per-day rate.`
                  : 'Paid before the number of unpaid days was recorded, so no day count is stored.'}
              />
            )}
            <Line label="Days present" value={num(slip.present_days).toFixed(1)} hint="Half days count as half." />
          </Section>
        </div>
        <div>
          <Section title="Deductions & take-home">
            <Line
              label="SSF (11%)" op="−" value={`NPR ${fmt(num(slip.ssf_employee))}`} color="var(--theme-red-text)"
              hint={num(slip.ssf_employee) > 0
                ? `The employee's Social Security Fund contribution. The business added NPR ${fmt(num(slip.ssf_employer))} (20%) on top, which was not taken from pay.`
                : 'No SSF taken — not enrolled, or no SSF number on file when this was paid.'}
            />
            <Line
              label="Other deductions" op="−" value={`NPR ${fmt(num(slip.other_deductions))}`} color="var(--theme-red-text)"
              hint={retirement > 0
                ? `Fixed deductions from Pay Setup, incl. CIT / provident fund NPR ${fmt(retirement)}, which also lowered taxable income.`
                : 'Fixed deductions from Pay Setup.'}
            />
            <Line
              label="Income tax (TDS)" op="−" value={`NPR ${fmt(num(slip.tds))}`} color="var(--theme-red-text)"
              hint={slip.tds_overridden
                ? 'Typed by hand on the Payroll page before the month was finalized.'
                : 'Withheld from this month\'s pay, based on the employee\'s expected income for the year.'}
            />
            <Line label="Advance cut" op="−" value={`NPR ${fmt(num(slip.advance_deduction))}`} color="var(--theme-red-text)" hint="Recovered towards an advance or loan." />
            <Line label="TADA" op="+" value={`NPR ${fmt(num(slip.tada_amount))}`} color="var(--theme-green-text)" hint={claims > 0 ? `${claims} travel claim${claims === 1 ? '' : 's'} reimbursed — not taxed.` : 'No travel claims on this payslip.'} />
            <Line label="Net pay" op="=" value={`NPR ${fmt(num(slip.net_pay))}`} strong color="var(--theme-accent-ink)" />
          </Section>
        </div>
      </div>
    </div>
  )
}

const FINALIZED_INTRO = 'This month is finalized, so these are the figures that were paid. The detailed working is not recomputed here, because salaries, attendance or tax data may have changed since — a fresh calculation today could disagree with what was actually paid.'

export default function PayrollCalculation() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods,    setPeriods]    = useState([])
  const [period,     setPeriod]     = useState(null)
  const [employees,  setEmployees]  = useState([])
  const [settled,    setSettled]    = useState([])
  const [storedEmps, setStoredEmps] = useState({})
  const [components, setComponents] = useState([])
  const [attendance, setAttendance] = useState([])
  const [otEntries,  setOtEntries]  = useState([])
  const [advances,   setAdvances]   = useState([])
  const [repayments, setRepayments] = useState([])
  const [ytdMap,     setYtdMap]     = useState({})
  const [tadaMap,    setTadaMap]    = useState({})
  const [run,        setRun]        = useState(null)
  const [payslips,   setPayslips]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [expandedId, setExpandedId] = useState(null)
  const [printRow,   setPrintRow]   = useState(null)
  const [loadError,  setLoadError]  = useState(null)

  useEffect(() => {
    // A switched client starts from nothing, not from the previous client's month.
    setPeriods([]); setPeriod(null); setExpandedId(null); setLoadError(null)
    // No client yet (an operator not viewing one) — nothing will ever load, so don't sit on Loading….
    if (!clientId) { setLoading(false); return }
    // Claimed before the first await (S721): a client switch re-runs this on a mounted page whose
    // guard still holds the old client's period id, and without a fresh claim the new client's
    // loads were discarded as stale — or the old client's late load landed under the new label.
    const initKey = periodReq.begin(`init:${clientId}`)
    async function init() {
      setLoading(true)
      const { data: p, error: pErr } = await scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      if (!periodReq.isCurrent(initKey)) return
      if (pErr) { setLoadError(pErr); setLoading(false); return }
      setPeriods(p || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      if (open) {
        periodReq.begin(open.id)
        setPeriod(open)
        await loadAll(open)
        if (!periodReq.isCurrent(open.id)) return   // a period change took the page over
      }
      setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  function clearData() {
    setEmployees([]); setSettled([]); setStoredEmps({}); setPayslips([]); setRun(null)
  }

  // Read-only — this page never writes to hr_payroll_runs/hr_payslips. A draft month (or one with
  // no run) is computed live by buildPayrollRows, the exact function Payroll Run generates from, over
  // the same fetchPayrollEmployees list, so the two pages cannot disagree about who is paid or how
  // much (S751). A FINALIZED month is shown from its stored payslips, as paid (decision 12).
  async function loadAll(p) {
    const results = await Promise.all([
      fetchPayrollEmployees(scopedFrom, p),
      // Paged, as on Payroll Run: a few rows per employee, and a truncated read silently drops
      // allowances and deductions from the live figures this page is trusted to check against.
      fetchAllRows(() => scopedFrom('hr_salary_components').order('id')),
      // Paged — one row per employee per day crosses the silent 1000-row cap at ~34 staff, and a
      // truncated read silently zeroes daily/hourly pay (S529).
      fetchAllRows(() => scopedFrom('hr_attendance').eq('period_id', p.id).order('id')),
      // bs_day is load-bearing, not display data: computePayslip uses it to suppress
      // attendance-sheet OT on days an approved entry already covers (approved supersedes).
      scopedFrom('hr_overtime_entries', 'employee_id, bs_day, ot_hours, ot_type')
        .eq('bs_year', p.bs_year).eq('bs_month', p.bs_month).eq('status', 'approved'),
      // Paged — both are unfiltered lifetime ledgers, and a truncated repayments read makes advances
      // look less repaid than they are. `.order('id')` is the unique tiebreaker.
      fetchAllRows(() => scopedFrom('hr_advances').order('issued_date').order('id')),
      fetchAllRows(() => scopedFrom('hr_advance_repayments').order('id')),
      scopedFrom('hr_payroll_runs').eq('period_id', p.id).maybeSingle(),
      // An empty YTD map is a legitimate value — the fiscal year's first month — so a failed read
      // does not look like a failure: every TDS would be recomputed as a fresh starter's and the
      // stored run judged stale against it.
      fetchYtdMap(scopedFrom, p),
      fetchApprovedTadaMap(scopedFrom, p),
    ])
    if (!periodReq.isCurrent(p.id)) return   // superseded by a newer period selection
    // This page exists to be trusted against Payroll Run before someone Generates or Finalizes, so
    // nothing is rendered until every read is known good — a silently-empty read would show
    // confident figures computed from nothing and judge every stored payslip against them.
    const failed = firstError(results)
    if (failed) { clearData(); setLoadError(failed); return }
    const [
      { data: who }, { data: comps }, { data: att }, { data: ot },
      { data: advs }, { data: reps }, { data: runRow }, { data: ytd }, { data: tada },
    ] = results

    let slips = []
    let extra = {}
    if (runRow) {
      const slipRes = await scopedFrom('hr_payslips').eq('run_id', runRow.id)
      if (!periodReq.isCurrent(p.id)) return   // S751: this await had no guard
      if (slipRes.error) { clearData(); setLoadError(firstError([slipRes])); return }
      slips = slipRes.data || []
      // A stored payslip can name someone the payroll list no longer carries — a leaver since
      // settled, or someone not employed that month. Resolve their names rather than print nothing.
      const known = new Set([...who.employees, ...who.settled].map(e => e.id))
      const unknownIds = slips.map(s => s.employee_id).filter(id => !known.has(id))
      if (unknownIds.length > 0) {
        const nameRes = await fetchEmployeesByIds(scopedFrom, unknownIds)
        if (!periodReq.isCurrent(p.id)) return
        if (nameRes.error) { clearData(); setLoadError(firstError([nameRes])); return }
        extra = Object.fromEntries((nameRes.data || []).map(e => [e.id, e]))
      }
    }

    setLoadError(null)
    setEmployees(who.employees)
    setSettled(who.settled)
    setStoredEmps(extra)
    setComponents(comps || [])
    setAttendance(att || [])
    setOtEntries(ot || [])
    setAdvances(advs || [])
    setRepayments(reps || [])
    setRun(runRow || null)
    setPayslips(slips)
    setYtdMap(ytd || {})
    setTadaMap(tada || {})
  }

  async function handlePeriodChange(id) {
    periodReq.begin(id)   // claim the page before any await
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setExpandedId(null); setLoading(true)
    await loadAll(p)
    if (periodReq.isCurrent(id)) setLoading(false)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'
  const monthDays = period ? daysInBsMonth(period.bs_year, period.bs_month) : 0
  const isFinalized = run?.status === 'finalized'
  // The advances this month is recovering — the same dueAdvances() filter buildAdvanceMap applies,
  // so the breakdown panel's count cannot disagree with the deduction beside it.
  const dueNow = useMemo(() => (period ? dueAdvances(advances, period) : []), [advances, period])

  // The live payroll, memoized: this page's only interactive state is `expandedId`/`printRow`, and
  // opening one employee's panel must not re-run the whole month's payroll for everyone. Skipped on
  // a finalized month, which shows what was paid instead.
  const liveRows = useMemo(() => {
    if (!period || isFinalized) return []
    return buildPayrollRows({ runId: run?.id ?? null, period, employees, components, attendance, otEntries, advances, repayments, ytdMap, tadaMap })
  }, [period, isFinalized, run, employees, components, attendance, otEntries, advances, repayments, ytdMap, tadaMap])

  const rows = useMemo(() => {
    if (!period) return []
    const empById = new Map([...employees, ...settled].map(e => [e.id, e]))
    const settledIds = new Set(settled.map(e => e.id))
    const empFor = id => empById.get(id) || storedEmps[id] || null
    const byName = (a, b) => (a.emp?.full_name || '').localeCompare(b.emp?.full_name || '')

    if (isFinalized) {
      return payslips
        .map(s => ({ kind: 'stored', key: `slip:${s.id}`, emp: empFor(s.employee_id), stored: s }))
        .sort(byName)
    }

    const storedByEmp = new Map(payslips.map(s => [s.employee_id, s]))
    const liveIds = new Set()
    const live = liveRows.map(({ payslip, detail }) => {
      liveIds.add(detail.emp.id)
      const stored = storedByEmp.get(detail.emp.id) || null
      // Same comparison Payroll Run's Finalize gate uses, from the same function, so the badge here
      // and the block there can never disagree.
      const drift = payslipDrift(stored, payslip)
      return {
        kind: 'live', key: detail.emp.id, ...detail, slip: payslip, stored,
        // A run exists but never picked this employee up (added after the last Generate).
        missing: !!run && !stored,
        stale: drift === 'moved',
        overridden: drift === 'overridden',
        moved: drift === 'moved' ? driftParts(stored, payslip) : [],
      }
    })
    // Stored payslips for people this month's payroll no longer covers — settled by a Final
    // Settlement, or not employed on any day of it. They used to be dropped from the page entirely
    // while Regenerate deleted them, so the change was invisible until it had happened (S751).
    const orphans = payslips
      .filter(s => !liveIds.has(s.employee_id))
      .map(s => ({ kind: 'orphan', key: `slip:${s.id}`, emp: empFor(s.employee_id), stored: s, settledOut: settledIds.has(s.employee_id) }))
      .sort(byName)
    return [...live, ...orphans]
  }, [period, isFinalized, liveRows, payslips, employees, settled, storedEmps, run])

  const flaggedCount = isFinalized ? 0 : rows.filter(r => r.stale || r.missing || r.kind === 'orphan').length
  const totals = useMemo(() => {
    const src = isFinalized ? rows.map(r => r.stored) : rows.filter(r => r.kind === 'live').map(r => r.slip)
    return src.reduce((a, s) => {
      a.gross   += num(s.gross)
      a.ot      += num(s.ot_amount)
      a.absence += num(s.absence_deduction)
      a.ssf     += num(s.ssf_employee)
      a.tds     += num(s.tds)
      a.advance += num(s.advance_deduction)
      a.tada    += num(s.tada_amount)
      a.net     += num(s.net_pay)
      return a
    }, { gross: 0, ot: 0, absence: 0, ssf: 0, tds: 0, advance: 0, tada: 0, net: 0 })
  }, [rows, isFinalized])
  // Every stored payslip in the run, including any for people no longer on the list — that is what
  // the run would pay if finalized now.
  const totalStored = payslips.length > 0 ? payslips.reduce((s, p) => s + num(p.net_pay), 0) : null
  const runStatusLabel = !run ? 'No Payroll run yet'
    : isFinalized ? 'Finalized — as paid'
      : (flaggedCount > 0 ? 'Draft — review before finalizing' : 'Draft — matches this calculation')

  function handlePrint(row) {
    setPrintRow(row)
    setTimeout(() => { printWithTitle(`Payroll Calculation - ${row.emp?.full_name || 'Employee'} - ${periodLabel}`); setPrintRow(null) }, 60)
  }

  function renderDetail(row) {
    if (row.kind === 'live') return <CalcDetail row={row} monthDays={monthDays} advances={dueNow} ytd={ytdMap[row.emp.id]} />
    if (row.kind === 'stored') return <StoredDetail slip={row.stored} intro={FINALIZED_INTRO} />
    return (
      <StoredDetail
        slip={row.stored}
        intro={`This payslip is in the draft run, but this employee is not on this month's payroll any more${row.settledOut ? ' — a finalized Final Settlement already pays their last month' : ''}. Regenerate will remove it. The figures below are the stored payslip, not a calculation.`}
      />
    )
  }

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  const cardMsg = text => <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>{text}</div>
  const colCount = isFinalized ? 10 : 11
  const statCards = isFinalized ? [
    { label: 'Total Gross', value: `NPR ${fmt(totals.gross)}`, color: 'var(--theme-accent-ink)', tip: 'Sum of gross on the finalized payslips — what was paid, not a recalculation.' },
    { label: 'Total Net Pay', value: `NPR ${fmt(totals.net)}`, color: 'var(--theme-green-text)', tip: 'Sum of net pay on the finalized payslips — the take-home that was paid.' },
    { label: 'Payslips', value: rows.length, color: 'var(--theme-text1)', tip: 'Payslips in the finalized run for this month.' },
    { label: 'Payroll Run Status', value: runStatusLabel, color: 'var(--theme-text1)', tip: 'This month is locked. Figures are shown as paid; to change them, reopen the run on the Payroll page.' },
  ] : [
    { label: 'Total Gross', value: `NPR ${fmt(totals.gross)}`, color: 'var(--theme-accent-ink)', tip: 'Sum of gross calculated now, across everyone on this month\'s payroll.' },
    { label: 'Total Net Pay', value: `NPR ${fmt(totals.net)}`, color: 'var(--theme-green-text)', tip: 'Sum of take-home calculated now — compare against Payroll Run\'s Net Payable.' },
    { label: 'Flagged for Review', value: flaggedCount, color: flaggedCount > 0 ? 'var(--theme-amber-text)' : 'var(--theme-text2)', tip: 'Employees whose stored Payroll payslip no longer matches this calculation, who have no payslip in the run, or whose payslip is for someone no longer on this month\'s payroll.' },
    { label: 'Payroll Run Status', value: runStatusLabel, color: 'var(--theme-text1)', tip: 'Whether a Payroll run exists for this month, and whether it still matches what is calculated here.' },
  ]

  return (
    <div>
      <div className={printRow ? 'no-print' : ''}>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Payroll Calculation</h1>
          <p className="page-subtitle">Verify the numbers behind Payroll, one employee at a time — {periodLabel}</p>
        </div>
        <select aria-label="Period" className="form-select" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
          {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
        </select>
      </div>

      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 16, lineHeight: 1.6 }}>
        {isFinalized
          ? 'This month\'s payroll is finalized. Every figure below is the stored payslip exactly as it was paid — nothing is recalculated. Open a row to see what each figure means.'
          : 'Every number here is calculated now from current Attendance, Roster, Overtime and Advances data — the same functions Payroll Run uses. It never writes anything; use it to check the math (or find out whether the actual Payroll page has gone stale) before you Generate/Regenerate/Finalize.'}
      </div>

      {loading ? (
        cardMsg('Loading…')
      ) : loadError ? (
        /* Before the empty-state branches, deliberately. A failed read leaves `employees` empty, so
           without this the page would tell an operator to go add employees they already have. */
        <ReportLoadError error={loadError} />
      ) : !clientId ? (
        cardMsg('Choose a client to see its payroll calculation.')
      ) : periods.length === 0 ? (
        cardMsg('No months set up yet — create one in Periods.')
      ) : rows.length === 0 ? (
        cardMsg(isFinalized
          ? 'This month\'s payroll was finalized with no payslips.'
          : 'No employees on this month\'s payroll. Add employees in HR → Employees, or check their join and end dates.')
      ) : (
        <>
          <div className="stat-grid">
            {statCards.map(s => (
              <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                  <Tip text={s.tip} width={260}>{s.label}</Tip>
                </div>
                <div style={{ fontSize: 17, fontWeight: 700, color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>

          {!isFinalized && settled.length > 0 && (
            <div className="card" style={{ padding: '10px 16px', marginBottom: 14, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
              Not on this month's payroll: <strong style={{ color: 'var(--theme-text1)' }}>{settled.map(e => e.full_name).join(', ')}</strong> — a finalized Final Settlement already pays {settled.length === 1 ? 'their' : 'each of their'} last month, so no payslip is calculated here.
            </div>
          )}

          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 32 }} />
                    <th>Employee</th>
                    <th style={{ textAlign: 'right' }}>Gross</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Overtime pay this month — from the attendance sheet plus approved Overtime entries combined." width={260}>OT</Tip></th>
                    <th style={{ textAlign: 'right' }}>Absence</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Social Security Fund — the employee's 11% contribution, taken from pay." width={260}>SSF</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Income tax (TDS) — withheld from this month's pay, based on the employee's expected income for the year." width={280}>TDS</Tip></th>
                    <th style={{ textAlign: 'right' }}>Advance</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Travel & Daily Allowance — trip expenses reimbursed on this payslip. Not taxed." width={270}>TADA</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{isFinalized ? 'Net Pay (as paid)' : 'Net Pay (now)'}</th>
                    {!isFinalized && <th><Tip text="The net pay stored on the Payroll page's draft run for this employee." width={240}>Payroll Page</Tip></th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const { kind, emp, stored } = row
                    const f = kind === 'live' ? row.slip : kind === 'stored' ? stored : null
                    const name = emp?.full_name || 'Employee record not found'
                    const expanded = expandedId === row.key
                    const toggle = () => setExpandedId(expanded ? null : row.key)
                    const cell = (value, sign, colorToken) => (
                      <td style={{ textAlign: 'right', color: f && value > 0 ? `var(${colorToken})` : 'var(--theme-text2)' }}>
                        {f && value > 0 ? `${sign}${fmt(value)}` : '—'}
                      </td>
                    )
                    return (
                      <Fragment key={row.key}>
                        <tr style={{ cursor: 'pointer' }} onClick={toggle}>
                          {/* The row click stays for the mouse; the disclosure button is the
                              keyboard and screen-reader path into the calculation (S682). */}
                          <td style={{ textAlign: 'center' }}>
                            <RowDisclosure expanded={expanded} onToggle={toggle}
                              label={`${expanded ? 'Hide' : 'Show'} calculation for ${name}`} />
                          </td>
                          <td>
                            <div style={{ fontWeight: 600, color: emp ? 'var(--theme-text1)' : 'var(--theme-text2)', fontSize: 13 }}>{name}</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 2, alignItems: 'center' }}>
                              {emp?.employee_code && <span style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{emp.employee_code}</span>}
                              {kind === 'live' && (row.breakdown.otSupersededHrs || 0) > 0 && (
                                <Tip style={TIP_CHIP} text={`This employee has OT in both places. ${row.breakdown.otSupersededHrs.toFixed(1)} hr typed on the attendance sheet was superseded by an approved Overtime entry for the same day and is not paid — expand the row to see the split.`} width={300}>
                                  <span style={chipStyle('--theme-text2', '--theme-text2')}>OT superseded</span>
                                </Tip>
                              )}
                              {kind === 'live' && row.missing && (
                                <Tip style={TIP_CHIP} text="This employee has no payslip in the current Payroll run for this month — Regenerate to include them before finalizing." width={280}>
                                  <span style={chipStyle('--theme-red', '--theme-red-text')}>⚠ Missing</span>
                                </Tip>
                              )}
                              {kind === 'live' && row.stale && (
                                <Tip
                                  style={TIP_CHIP} width={320}
                                  text={`Changed since the run was last Generated/Regenerated: ${row.moved.join('; ')}. ${Math.round(num(stored.net_pay)) === Math.round(row.slip.net_pay)
                                    ? `Net pay still comes out the same (NPR ${fmt(num(stored.net_pay))}), but the figures inside it do not — Regenerate so the payslip shows the right split.`
                                    : `Net pay: NPR ${fmt(num(stored.net_pay))} stored on the Payroll page, NPR ${fmt(row.slip.net_pay)} now — Regenerate to update it.`}`}
                                >
                                  <span style={chipStyle('--theme-red', '--theme-red-text')}>⚠ Stale</span>
                                </Tip>
                              )}
                              {/* Not a warning: the stored TDS was typed by hand on the Payroll page
                                  (tds_overridden) and every computed figure still matches. */}
                              {kind === 'live' && row.overridden && (
                                <Tip style={TIP_CHIP} text={`Income tax (TDS) on this payslip was typed by hand on the Payroll page (NPR ${fmt(num(stored.tds))}; this calculation gives NPR ${fmt(row.slip.tds)}). Every other figure matches. That is a deliberate edit, not stale data.`} width={300}>
                                  <span style={chipStyle('--theme-text2', '--theme-text2')}>Adjusted</span>
                                </Tip>
                              )}
                              {kind === 'orphan' && (
                                <Tip
                                  style={TIP_CHIP} width={300}
                                  text={row.settledOut
                                    ? 'A finalized Final Settlement already pays this employee\'s last month, so this month\'s payroll no longer includes them. Regenerating the draft removes this payslip.'
                                    : 'This employee is not employed on any day of this month any more (check their join date and last working day). Regenerating the draft removes this payslip.'}
                                >
                                  <span style={chipStyle('--theme-amber', '--theme-amber-text')}>Not on this month's payroll any more — Regenerate will remove it</span>
                                </Tip>
                              )}
                            </div>
                          </td>
                          {kind === 'orphan' ? (
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>—</td>
                          ) : (
                            <td style={{ textAlign: 'right' }}>{fmt(num(f.gross))}</td>
                          )}
                          {cell(num(f?.ot_amount), '+', '--theme-green-text')}
                          {cell(num(f?.absence_deduction), '−', '--theme-red-text')}
                          {cell(num(f?.ssf_employee), '−', '--theme-red-text')}
                          {cell(num(f?.tds), '−', '--theme-red-text')}
                          {cell(num(f?.advance_deduction), '−', '--theme-purple-text')}
                          {cell(num(f?.tada_amount), '+', '--theme-green-text')}
                          <td style={{ textAlign: 'right', color: f ? 'var(--theme-accent-ink)' : 'var(--theme-text2)', fontWeight: 700 }}>{f ? fmt(num(f.net_pay)) : '—'}</td>
                          {!isFinalized && (
                            <td style={{ fontSize: 11, color: stored ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>{stored ? `NPR ${fmt(num(stored.net_pay))}` : 'not generated'}</td>
                          )}
                        </tr>
                        {expanded && (
                          <tr>
                            <td colSpan={colCount} style={{ padding: 0 }}>
                              <div style={{ padding: '10px 22px 0', background: 'var(--theme-bg)', borderTop: '1px solid var(--theme-border)', display: 'flex', justifyContent: 'flex-end' }}>
                                <button className="btn btn-ghost" style={{ fontSize: 11 }} onClick={() => handlePrint(row)}>🖨 Print</button>
                              </div>
                              {renderDetail(row)}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td />
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>Total — {isFinalized ? rows.length : rows.filter(r => r.kind === 'live').length}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(totals.gross)}</td>
                    <td style={{ textAlign: 'right', color: totals.ot > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{totals.ot > 0 ? `+${fmt(totals.ot)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.absence > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{totals.absence > 0 ? `−${fmt(totals.absence)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.ssf > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{totals.ssf > 0 ? `−${fmt(totals.ssf)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.tds > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{totals.tds > 0 ? `−${fmt(totals.tds)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.advance > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text2)' }}>{totals.advance > 0 ? `−${fmt(totals.advance)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: totals.tada > 0 ? 'var(--theme-green-text)' : 'var(--theme-text2)' }}>{totals.tada > 0 ? `+${fmt(totals.tada)}` : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 15 }}>{fmt(totals.net)}</td>
                    {!isFinalized && (
                      <td style={{ fontSize: 11, color: 'var(--theme-text2)' }}>{totalStored !== null ? `NPR ${fmt(totalStored)}` : '—'}</td>
                    )}
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
      </div>

      {printRow && (
        // Explicit padding here, not relying on the app's normal page padding — @media print
        // zeroes .main-content's padding (Layout.css) so other pages can control their own
        // print margins precisely, which otherwise leaves print-only content flush to the edge.
        <div className="print-only" style={{ padding: '28px 36px' }}>
          <h1 style={{ fontSize: 20, marginBottom: 2 }}>Payroll Calculation</h1>
          <div style={{ fontSize: 13, marginBottom: 2 }}>{printRow.emp?.full_name || 'Employee record not found'}{printRow.emp?.employee_code ? ` (${printRow.emp.employee_code})` : ''}</div>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 14 }}>
            {periodLabel}{printRow.kind === 'stored' ? ' — as paid' : ''} — printed {nepalBsLong(new Date()) || nepalDateLong(new Date())}
          </div>
          {renderDetail(printRow)}
        </div>
      )}
    </div>
  )
}
