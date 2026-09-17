import { nprInt } from '../../../shared/nepalMoney'
import { calcAmount, isSsfContributor } from './payrollCompute'
import { slabsFor } from './tds'
import { FRESHNESS_INPUT_FIELDS } from './payrollData'
import { ATTENDANCE_STATUSES, OT_MULTIPLIER, SSF_CAP } from '../payrollConstants'

// How one employee's pay was worked out, step by step — the breakdown that used to be the whole of
// the /hr/calculation page (S768). That page recomputed the same register Payroll already shows,
// through the same buildPayrollRows(), so the explanation of a figure lived one route away from the
// figure. It is Payroll's expandable row now; this file is only the panels.
//
// Two panels, and which one a row gets is the whole design (decision 12, S751):
//   CalcDetail   — a draft month: the full live working, from buildPayrollRows' `detail`.
//   StoredDetail — a finalized month: the stored payslip AS PAID, never recomputed, because today's
//                  salaries, attendance or tax data may no longer be what that month was paid on.

const fmt = nprInt
const num = v => parseFloat(v) || 0
const pct = rate => `${Math.round(rate * 100)}%`

function Section({ title, children }) {
  return (
    <div className="calc-section" style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>{title}</div>
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

export function driftParts(stored, live) {
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
export function CalcDetail({ row, monthDays, advances, ytd }) {
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
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong hint="The full month's salary before anything is taken off." />
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
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong />
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
            <Line label="Gross" op="=" value={`NPR ${fmt(slip.gross)}`} strong />
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
            <Line label="Absence Deduction" op="=" value={`− NPR ${fmt(slip.absence_deduction)}`} strong />
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
          <Line label="Attendance OT Amount" op="=" value={`NPR ${fmt(b.otAttendanceAmt)}`} strong />
        </Section>

        <Section title="Overtime — Approved Entries (Overtime module)">
          <Line label="Approved OT Hours" value={`${(b.otApprovedHrs || 0).toFixed(1)}h`} hint="From the Overtime module's approval workflow. Where a day appears in both places this is the figure that gets paid, and it is the only route to the holiday 2× rate." />
          <Line label="Approved OT Amount" op="=" value={`NPR ${fmt(b.otApprovedAmt)}`} strong />
          <Line label="Total OT paid" value={`${((b.otAttendanceHrs || 0) + (b.otApprovedHrs || 0)).toFixed(1)}h → NPR ${fmt(slip.ot_amount)}`} strong />
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
            <Line label="Employee SSF" op="=" value={`− NPR ${fmt(slip.ssf_employee)}`} strong />
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
          <Line label="This month's income tax (TDS)" op="=" value={`− NPR ${fmt(tdsBreakdown.tds)}`} strong />
          {tdsCapped > 0 && (
            <Line
              label="Withheld this month" value={`− NPR ${fmt(slip.tds)}`} strong
              hint={`Pay left after SSF and fixed deductions only covered NPR ${fmt(slip.tds)}. The NPR ${fmt(tdsCapped)} not withheld is picked up by later months' tax.`}
            />
          )}
        </Section>

        <Section title="Advance & TADA">
          <Line label="Advances in recovery this month" value={empAdvances.length} hint="Recovery starts the month after an advance is issued" />
          <Line label="Advance cut due" value={`NPR ${fmt(advanceDue)}`} hint="Each advance's instalment, or what is left of it if less." />
          <Line
            label="Advance cut taken" value={`− NPR ${fmt(slip.advance_deduction)}`}
            hint={advanceOwed > 0 ? `NPR ${fmt(advanceOwed)} of the advance cut is still owed — taken by later cuts. Pay left after tax was not enough for the whole instalment.` : undefined}
          />
          <Line label="Travel claims paid by this payroll" value={tada.ids.length} hint="Approved claims whose trip ended by the end of this month." />
          <Line label="TADA Reimbursement" value={`+ NPR ${fmt(slip.tada_amount)}`} />
        </Section>

        <Section title="Net Pay">
          <Line label="Gross" value={`NPR ${fmt(slip.gross)}`} />
          <Line label="OT" op="+" value={`NPR ${fmt(slip.ot_amount)}`} />
          <Line label="Absence" op="−" value={`NPR ${fmt(slip.absence_deduction)}`} />
          <Line label="SSF" op="−" value={`NPR ${fmt(slip.ssf_employee)}`} />
          <Line
            label="Other Deductions" op="−" value={`NPR ${fmt(slip.other_deductions)}`}
            hint={[
              slip.retirement_contribution > 0 ? `incl. CIT / provident fund NPR ${fmt(slip.retirement_contribution)}` : null,
              cut > 0 ? `The fixed deductions (NPR ${fmt(slip.other_deductions + cut)}) were reduced by NPR ${fmt(cut)} so take-home pay did not go below zero.` : null,
            ].filter(Boolean).join('. ') || undefined}
          />
          <Line label="Income tax (TDS)" op="−" value={`NPR ${fmt(slip.tds)}`} />
          <Line label="Advance" op="−" value={`NPR ${fmt(slip.advance_deduction)}`} />
          <Line label="TADA" op="+" value={`NPR ${fmt(slip.tada_amount)}`} />
          <Line label="Net Pay" op="=" value={`NPR ${fmt(slip.net_pay)}`} strong />
        </Section>
      </div>
    </div>
  )
}

// A stored payslip explained as it was paid (decision 12, S751). Nothing here is recomputed: a
// finalized month is locked, and today's salaries, attendance or tax data may no longer be what
// that month was paid on — so a fresh calculation could disagree with the money that actually moved.
export function StoredDetail({ slip, intro }) {
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
            <Line label="Overtime" op="+" value={`NPR ${fmt(num(slip.ot_amount))}`} hint={num(slip.ot_hours) > 0 ? `${num(slip.ot_hours).toFixed(1)} hours of overtime.` : 'No overtime paid.'} />
            {basis === 'monthly' && (
              <Line
                label="Absence" op="−" value={`NPR ${fmt(num(slip.absence_deduction))}`}
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
              label="SSF (11%)" op="−" value={`NPR ${fmt(num(slip.ssf_employee))}`}
              hint={num(slip.ssf_employee) > 0
                ? `The employee's Social Security Fund contribution. The business added NPR ${fmt(num(slip.ssf_employer))} (20%) on top, which was not taken from pay.`
                : 'No SSF taken — not enrolled, or no SSF number on file when this was paid.'}
            />
            <Line
              label="Other deductions" op="−" value={`NPR ${fmt(num(slip.other_deductions))}`}
              hint={retirement > 0
                ? `Fixed deductions from Pay Setup, incl. CIT / provident fund NPR ${fmt(retirement)}, which also lowered taxable income.`
                : 'Fixed deductions from Pay Setup.'}
            />
            <Line
              label="Income tax (TDS)" op="−" value={`NPR ${fmt(num(slip.tds))}`}
              hint={slip.tds_overridden
                ? 'Typed by hand on the Payroll page before the month was finalized.'
                : 'Withheld from this month\'s pay, based on the employee\'s expected income for the year.'}
            />
            <Line label="Advance cut" op="−" value={`NPR ${fmt(num(slip.advance_deduction))}`} hint="Recovered towards an advance or loan." />
            <Line label="TADA" op="+" value={`NPR ${fmt(num(slip.tada_amount))}`} hint={claims > 0 ? `${claims} travel claim${claims === 1 ? '' : 's'} reimbursed — not taxed.` : 'No travel claims on this payslip.'} />
            <Line label="Net pay" op="=" value={`NPR ${fmt(num(slip.net_pay))}`} strong />
          </Section>
        </div>
      </div>
    </div>
  )
}

export const FINALIZED_INTRO = 'This month is finalized, so these are the figures that were paid. The detailed working is not recomputed here, because salaries, attendance or tax data may have changed since — a fresh calculation today could disagree with what was actually paid.'

// A stored draft payslip for someone this month's payroll no longer covers.
export const orphanIntro = settledOut => `This payslip is in the draft run, but this employee is not on this month's payroll any more${settledOut ? ' — a finalized Final Settlement already pays their last month' : ''}. Regenerate will remove it. The figures below are the stored payslip, not a calculation.`
