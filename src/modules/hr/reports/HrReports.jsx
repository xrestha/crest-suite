import { nprInt } from '../../../shared/nepalMoney'
import { useState, useEffect, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Tabs from '../../../components/Tabs'
import RunStatusBadge from '../payroll/RunStatusBadge'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, getBsToday } from '../../../utils/bsCalendar'
import { fiscalYearOf, retirementRelief } from '../payroll/tds'
import { DEFAULT_BONUS_MONTH, bonusFiscalYear, fetchFinalizedBonuses } from '../payroll/bonusTax'
import { SSF_CAP, SSF_EMPLOYEE_PCT, SSF_EMPLOYER_PCT, SSF_DEPOSIT_DAY } from '../payrollConstants'
import { isSsfContributor } from '../payroll/payrollCompute'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'

const fmt = nprInt
// A date-only string parsed as LOCAL midnight — `new Date('YYYY-MM-DD')` is UTC midnight, a day early
// for any viewer west of UTC.
const fmtDate = d => d ? new Date(String(d).slice(0, 10) + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

// The SSF base a contribution was actually worked out on — employee 11% + employer 20% ÷ 31%. The
// challan printed min(basic, cap), which is the contract basic for a monthly employee with unpaid
// days and the DAY RATE for a daily worker (754 against a month of contributions), so SOSYS was
// handed a base that did not produce the deposit beside it (S752).
const ssfBaseOf = (employee, employer) => Math.round((num(employee) + num(employer)) / (SSF_EMPLOYEE_PCT + SSF_EMPLOYER_PCT))
// What a payslip's tax was worked out on: earned pay (gross − absence + overtime) less the employee's
// SSF and CIT. The sheet subtracted neither the absence deduction nor CIT (S752).
const payslipTaxable = s => num(s.gross) - num(s.absence_deduction) + num(s.ot_amount) - num(s.ssf_employee) - num(s.retirement_contribution)
// A finalized Final Settlement's exit payments — taxed as a lump sum on top of the final month.
const settlementLump = s => num(s.gratuity) + num(s.leave_encashment) + num(s.festival_pro) + num(s.notice_pay)

// A finalized Festival Allowance or Incentive row, named the way an owner reads it (S751).
const bonusMonthOf = b => b.bs_month || DEFAULT_BONUS_MONTH
function bonusLabel(b) {
  return b.source === 'festival'
    ? `Festival allowance — ${b.festival_name || 'unnamed'}`
    : `Incentive — ${b.run_label || 'unnamed'}`
}
const bonusPaidIn = b => `${BS_MONTHS[bonusMonthOf(b) - 1]} ${b.bs_year}`
const num = v => parseFloat(v) || 0

const RETIRE_SOON_DAYS = 180
// Retirement status from a retirement_date (AD): retired (past) / soon (≤180d) / null.
function retireInfo(dateStr) {
  if (!dateStr) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const d = new Date(dateStr); d.setHours(0, 0, 0, 0)
  const days = Math.round((d - today) / 86400000)
  if (days < 0)               return { retired: true, label: 'Retired',       color: 'var(--theme-red-text)', bg: 'color-mix(in srgb, var(--theme-red) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-red) 20%, transparent)' }
  if (days <= RETIRE_SOON_DAYS) return { soon: true,  label: 'Retiring soon', color: 'var(--theme-accent-ink)', bg: 'color-mix(in srgb, var(--theme-accent) 10%, transparent)', border: 'color-mix(in srgb, var(--theme-accent) 20%, transparent)' }
  return null
}

export default function HrReports() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods,   setPeriods]   = useState([])
  const [period,    setPeriod]    = useState(null)
  const [run,       setRun]       = useState(null)
  const [payslips,  setPayslips]  = useState([])
  const [employees, setEmployees] = useState([])
  const [ytdTds,    setYtdTds]    = useState({})   // employee_id -> tds withheld this FY up to this month: finalized payslips + finalized bonuses
  // Finalized Festival Allowances and Incentives whose PAY MONTH is the selected period (S751).
  // Their tax is withheld that month and has to be deposited with the month's salary TDS; before
  // S751 this page read hr_payslips alone, so the TDS sheet never mentioned it.
  const [monthBonuses, setMonthBonuses] = useState([])
  // Finalized Final Settlements whose final month is the selected period (S752). A settled leaver is
  // not on that month's payroll, so their final month's SSF and tax — and the tax on their exit
  // payments — reached no filing sheet at all.
  const [monthSettlements, setMonthSettlements] = useState([])
  const [loading,   setLoading]   = useState(true)
  // S612 silent-zero rule: a failed read must render as a failure, never as "no payroll run" or
  // a challan of zeros — these are figures an accountant files on.
  const [loadError, setLoadError] = useState(null)
  const [tab,       setTab]       = useState('summary')
  const [rosterRetiringOnly, setRosterRetiringOnly] = useState(false)
  const [certFy,      setCertFy]      = useState(null)   // { fyStart, label }
  const [certEmpId,   setCertEmpId]   = useState('')
  const [certSlips,   setCertSlips]   = useState([])
  const [certBonuses, setCertBonuses] = useState([])   // finalized festival allowances + incentives in certFy (S751)
  const [certSettlements, setCertSettlements] = useState([])   // finalized Final Settlements in certFy (S752)
  const [certLoading, setCertLoading] = useState(false)
  const [certError,   setCertError]   = useState(null)   // cert tab has its own load lifecycle
  const [clientName,  setClientName]  = useState('')
  const [clientPan,   setClientPan]   = useState('')
  const [clientInfoError, setClientInfoError] = useState(null)

  const empMap = Object.fromEntries(employees.map(e => [e.id, e]))
  const nameById = Object.fromEntries(employees.map(e => [e.id, e.full_name]))

  useEffect(() => {
    if (!clientId) return
    async function init() {
      // Claimed for the client first, so a slower load for the previous client cannot land here.
      const initKey = `client:${clientId}`
      periodReq.begin(initKey)
      setLoading(true)
      setLoadError(null)
      // A switch to a client with no periods must not keep the previous client's payroll on screen.
      setPeriod(null); setRun(null); setPayslips([]); setYtdTds({}); setMonthBonuses([]); setMonthSettlements([])
      setCertEmpId(''); setCertSlips([]); setCertBonuses([]); setCertSettlements([])
      const { data: p, error: pErr } = await scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
      if (!periodReq.isCurrent(initKey)) return
      if (pErr) { setLoadError(pErr); setLoading(false); return }
      setPeriods(p || [])
      // Employee master loads independently of any payroll run (powers the Roster tab).
      const { data: emps, error: empErr } = await scopedFrom('hr_employees', 'id, full_name, employee_code, department, designation, employment_type, supervisor_id, retirement_date, join_date, pay_basis, bank_name, bank_account_no, bank_branch, ssf_no, ssf_enrolled, pan_no, life_insurance_premium, health_insurance_premium, status')
        .order('full_name')
      if (!periodReq.isCurrent(initKey)) return
      if (empErr) { setLoadError(empErr); setLoading(false); return }
      setEmployees(emps || [])
      const open = (p || []).find(x => x.status === 'open') || (p || [])[0]
      // Claim before loading (S721 rule): once a period change has run, the ref is never null again,
      // so an admin client switch re-running init() would otherwise have every setter in loadAll
      // skipped as "stale" and show the previous client's TDS sheet under the new one.
      if (open) {
        periodReq.begin(open.id); setPeriod(open); await loadAll(open.id, open)
        if (!periodReq.isCurrent(open.id)) return
      }
      setLoading(false)
    }
    init()
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Company name and PAN for the TDS certificate header. settings.vat_number IS Nepal's PAN (same
  // field the Tax Invoice and the payslip letterhead already print). Both are RESET on a client
  // switch and a failed read is kept as an error: the PAN used to be set only when present and never
  // cleared, so an operator moving from a client with a PAN to one without printed the first
  // client's PAN on the second's certificate (S752).
  useEffect(() => {
    if (!clientId) return
    let cancelled = false
    setClientName(''); setClientPan(''); setClientInfoError(null)
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('vat_number').eq('client_id', clientId).maybeSingle(),
    ]).then(results => {
      if (cancelled) return
      const err = firstError(results)
      if (err) { setClientInfoError(err); return }
      setClientName(results[0].data?.name || '')
      setClientPan(results[1].data?.vat_number || '')
    })
    return () => { cancelled = true }
  }, [clientId])

  // Fetch finalized payslips AND finalized festival allowances / incentives for the selected FY +
  // employee (TDS Certificate tab). A bonus is income the employer withheld tax on exactly like a
  // payslip, so a certificate built from payslips alone understated both the income and the tax
  // (S751). Either read failing fails the certificate — half a tax record is not a smaller one.
  useEffect(() => {
    if (tab !== 'cert' || !certFy || !certEmpId) { setCertSlips([]); setCertBonuses([]); setCertSettlements([]); return }
    let cancelled = false   // an employee/FY switch mid-read must not land the previous one's record
    setCertLoading(true)
    setCertError(null)
    Promise.all([
      scopedFrom('hr_payslips', '*, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
        .eq('employee_id', certEmpId)
        .eq('hr_payroll_runs.status', 'finalized'),
      fetchFinalizedBonuses(scopedFrom),
      scopedFrom('hr_final_settlements', '*').eq('employee_id', certEmpId).eq('status', 'finalized'),
    ]).then(([{ data, error }, bonusRes, settleRes]) => {
        if (cancelled) return
        // S612: a failed read must not render as "no finalized payslips found for this FY" —
        // that sentence is a claim about the employee's tax record.
        const err = error || bonusRes.error || settleRes.error
        if (err) { setCertError(err); setCertSlips([]); setCertBonuses([]); setCertSettlements([]); setCertLoading(false); return }
        setCertSettlements((settleRes.data || []).filter(s => s.settle_bs_year
          && fiscalYearOf(s.settle_bs_year, s.settle_bs_month).fyStart === certFy.fyStart))
        const bonuses = (bonusRes.data || [])
          .filter(b => b.employee_id === certEmpId && bonusFiscalYear(b).fyStart === certFy.fyStart)
          .sort((a, b) => (bonusFiscalYear(a).monthInFy - bonusFiscalYear(b).monthInFy) || bonusLabel(a).localeCompare(bonusLabel(b)))
        setCertBonuses(bonuses)
        const slips = (data || [])
          .filter(r => {
            const mp = r.hr_payroll_runs?.monthly_periods
            if (!mp) return false
            const { fyStart } = fiscalYearOf(mp.bs_year, mp.bs_month)
            return fyStart === certFy.fyStart
          })
          .sort((a, b) => {
            const fa = fiscalYearOf(a.hr_payroll_runs.monthly_periods.bs_year, a.hr_payroll_runs.monthly_periods.bs_month)
            const fb = fiscalYearOf(b.hr_payroll_runs.monthly_periods.bs_year, b.hr_payroll_runs.monthly_periods.bs_month)
            return fa.monthInFy - fb.monthInFy
          })
        setCertSlips(slips)
        setCertLoading(false)
      })
    return () => { cancelled = true }
  }, [tab, certFy, certEmpId, clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadAll(periodId, p) {
    setLoadError(null)
    // Started here, awaited at the bottom. The YTD read filters on nothing but the fiscal year `p`
    // falls in — it does not need the run or its payslips — so waiting out those two round trips
    // before issuing it was pure serialisation. It is also the page's biggest read (every finalized
    // payslip the client has, paged), so it is the one worth overlapping.
    const ytdPromise = loadYtd(p, periodId)
    const [{ data: runRow, error: runErr }, { data: settled, error: settleErr }] = await Promise.all([
      scopedFrom('hr_payroll_runs').eq('period_id', periodId).maybeSingle(),
      scopedFrom('hr_final_settlements', '*').eq('status', 'finalized')
        .eq('settle_bs_year', p.bs_year).eq('settle_bs_month', p.bs_month),
    ])
    if (!periodReq.isCurrent(periodId)) { await ytdPromise; return }   // superseded by a newer period selection
    // S612 silent-zero rule: a failed read here would wear the "no payroll run this period"
    // empty state — and the challan/TDS sheets on this page are figures an accountant files on.
    if (runErr || settleErr) { setLoadError(runErr || settleErr); setRun(null); setPayslips([]); setMonthSettlements([]); await ytdPromise; return }
    setMonthSettlements(settled || [])
    setRun(runRow || null)
    if (runRow) {
      const { data: slips, error: slipErr } = await scopedFrom('hr_payslips').eq('run_id', runRow.id)
      if (!periodReq.isCurrent(periodId)) { await ytdPromise; return }
      if (slipErr) { setLoadError(slipErr); setPayslips([]); await ytdPromise; return }
      setPayslips(slips || [])
    } else {
      setPayslips([])
    }
    await ytdPromise
  }

  // YTD TDS per employee: sum tds from finalized payslips in the same fiscal year, up to this period.
  // `periodId` is only for the staleness check: this now runs CONCURRENTLY with the run/payslip
  // reads rather than after them, so it needs its own `isCurrent` guard — without one, arrowing
  // through the period list could land an older fiscal year's YTD map under a newer period's
  // figures, which is exactly the overlapping-load race useLatestRequest exists to stop.
  async function loadYtd(p, periodId) {
    if (!p) { setYtdTds({}); setMonthBonuses([]); return }
    const cur = fiscalYearOf(p.bs_year, p.bs_month)
    // Finalized festival allowances and incentives are read alongside (S751): their tax belongs in
    // "withheld so far this year" from the month they are paid in, and the ones paid IN this month
    // are tax the owner has to deposit for it.
    const bonusPromise = fetchFinalizedBonuses(scopedFrom)
    // Finalized settlements' tax counts toward "withheld this year" too (S752).
    const settlePromise = fetchAllRows(() => scopedFrom('hr_final_settlements', 'id, employee_id, month_tds, lump_tds, settle_bs_year, settle_bs_month')
      .eq('status', 'finalized').order('id'))
    // Paged. The fiscal-year narrowing happens in JS below, so this reads EVERY finalized
    // payslip the client has ever had — one row per employee per month, for as long as they have
    // run payroll — not just this FY's. Unpaged it silently stopped at PostgREST's 1000-row cap
    // (~20 staff x 4 years), and a truncated map understates YTD TDS on the TDS certificate and
    // the challan sheet, which is a figure an accountant files on. Same shape and same fix as
    // payrollData.js's fetchYtdMap; `.order('id')` is the unique tiebreaker fetchAllRows requires.
    const { data, error } = await fetchAllRows(() =>
      scopedFrom('hr_payslips', 'employee_id, tds, hr_payroll_runs!inner(status, monthly_periods!inner(bs_year, bs_month))')
        .eq('hr_payroll_runs.status', 'finalized')
        .order('id'))
    const [bonusRes, settleRes] = await Promise.all([bonusPromise, settlePromise])
    if (periodId !== undefined && !periodReq.isCurrent(periodId)) return
    // A failed read must not zero every YTD TDS figure on the filing sheets (S612) — and a failed
    // bonus read must not quietly drop the bonus tax from them either, which would print a smaller
    // deposit that looks exactly like a month with no bonuses (S751).
    const readErr = error || bonusRes.error || settleRes.error
    if (readErr) { setLoadError(readErr); setYtdTds({}); setMonthBonuses([]); return }
    const map = {}
    ;(data || []).forEach(r => {
      if (r.hr_payroll_runs?.status !== 'finalized') return
      const mp = r.hr_payroll_runs?.monthly_periods
      if (!mp) return
      const fy = fiscalYearOf(mp.bs_year, mp.bs_month)
      if (fy.fyStart !== cur.fyStart || fy.monthInFy > cur.monthInFy) return
      map[r.employee_id] = (map[r.employee_id] || 0) + (r.tds || 0)
    })
    ;(settleRes.data || []).forEach(s => {
      if (!s.settle_bs_year) return
      const fy = fiscalYearOf(s.settle_bs_year, s.settle_bs_month)
      if (fy.fyStart !== cur.fyStart || fy.monthInFy > cur.monthInFy) return
      map[s.employee_id] = (map[s.employee_id] || 0) + num(s.month_tds) + num(s.lump_tds)
    })
    const inMonth = []
    ;(bonusRes.data || []).forEach(b => {
      const fy = bonusFiscalYear(b)
      if (fy.fyStart !== cur.fyStart || fy.monthInFy > cur.monthInFy) return
      map[b.employee_id] = (map[b.employee_id] || 0) + num(b.tds)
      if (b.bs_year === p.bs_year && bonusMonthOf(b) === p.bs_month) inMonth.push(b)
    })
    setYtdTds(map)
    setMonthBonuses(inMonth)
  }

  async function handlePeriodChange(id) {
    periodReq.begin(id)   // claim the page before any await
    const p = periods.find(x => x.id === id); if (!p) return
    setPeriod(p); setLoading(true)
    await loadAll(id, p)
    // Only the load still current may clear the loading state. A superseded one used to, which let
    // Export write the previous month's figures under this month's filename while the newer read
    // was still in flight (S752).
    if (periodReq.isCurrent(id)) setLoading(false)
  }

  const periodLabel = period ? `${BS_MONTHS[period.bs_month - 1]} ${period.bs_year}` : '—'
  const fileLabel = period ? `${BS_MONTHS[period.bs_month - 1]}-${period.bs_year}` : ''
  const finalized = run?.status === 'finalized'

  // ── Derived rows ────────────────────────────────────────────────────────────
  const rows = payslips.map(s => ({ s, emp: empMap[s.employee_id] || {} }))
  // Who is on the challan is decided by what was DEDUCTED, not by today's employee record (S752): a
  // number added in Magh put a zero-contribution row on Kartik's challan, and unticking the flag
  // dropped a worker whose 11% had been withheld. A finalized settlement's final month joins it.
  const ssfRows = [
    ...rows.filter(({ s }) => num(s.ssf_employee) + num(s.ssf_employer) > 0)
      .map(({ s, emp }) => ({ id: s.id, name: emp.full_name || '(employee no longer on file)', ssfNo: emp.ssf_no || '', employee: num(s.ssf_employee), employer: num(s.ssf_employer), settlement: false })),
    ...monthSettlements.filter(st => num(st.month_ssf_employee) + num(st.month_ssf_employer) > 0)
      .map(st => ({ id: st.id, name: st.employee_name || empMap[st.employee_id]?.full_name || '(employee no longer on file)', ssfNo: st.ssf_no || empMap[st.employee_id]?.ssf_no || '', employee: num(st.month_ssf_employee), employer: num(st.month_ssf_employer), settlement: true })),
  ]
  // Enrolled today but nothing deducted this month — almost always a missing SSF number.
  const noSsfCount = rows.filter(({ s, emp }) => emp.ssf_enrolled && !isSsfContributor(emp) && num(s.ssf_employee) === 0).length

  const runState = run ? (finalized ? 'FINALIZED' : 'DRAFT — figures may change') : 'no payroll run'
  // Every export states what it covers, including whether the run was a draft: a bank file or a
  // challan exported from a draft used to be indistinguishable from a finalized one (S752).
  async function downloadSheet(data, sheet, ext = 'xlsx', { scoped = true } = {}) {
    const XLSX = await import('xlsx')
    const scope = `${clientName || 'Payroll'} — ${sheet} — ${scoped ? `${periodLabel} — payroll ${runState}` : `as of ${fmtDate(new Date().toISOString().slice(0, 10))}`}`
    const ws = ext === 'csv' ? XLSX.utils.json_to_sheet(data) : XLSX.utils.aoa_to_sheet([[scope], []])
    if (ext !== 'csv') XLSX.utils.sheet_add_json(ws, data, { origin: 'A3' })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, sheet)
    // A bank CSV must stay machine-readable (no scope line), so a draft says so in its file name.
    const draftTag = ext === 'csv' && run && !finalized ? '_DRAFT' : ''
    XLSX.writeFile(wb, `${sheet.replace(/\s+/g, '_').toLowerCase()}${scoped ? `_${fileLabel}` : ''}${draftTag}.${ext}`, ext === 'csv' ? { bookType: 'csv' } : undefined)
  }

  // Summary totals. Gross is earned pay (after absence), so Gross − Deductions + TADA = Net Payable;
  // the advance cut was missing from Deductions and the absence deduction was counted as a cost.
  const tot = rows.reduce((a, { s }) => {
    a.gross += num(s.gross) - num(s.absence_deduction) + num(s.ot_amount)
    a.ded   += num(s.ssf_employee) + num(s.other_deductions) + num(s.tds) + num(s.advance_deduction)
    a.tada  += num(s.tada_amount)
    a.net   += num(s.net_pay)
    a.empCost += num(s.gross) - num(s.absence_deduction) + num(s.ot_amount) + num(s.ssf_employer)
    return a
  }, { gross: 0, ded: 0, tada: 0, net: 0, empCost: 0 })

  // Department breakdown
  const deptMap = {}
  rows.forEach(({ s, emp }) => {
    const d = emp.department || '—'
    const e = deptMap[d] || { dept: d, count: 0, gross: 0, ded: 0, net: 0 }
    e.count += 1; e.gross += num(s.gross) - num(s.absence_deduction) + num(s.ot_amount)
    e.ded += num(s.ssf_employee) + num(s.other_deductions) + num(s.tds) + num(s.advance_deduction)
    e.net += num(s.net_pay)
    deptMap[d] = e
  })
  const depts = Object.values(deptMap).sort((a, b) => b.net - a.net)

  const ssfTotals = ssfRows.reduce((a, r) => {
    a.base += ssfBaseOf(r.employee, r.employer); a.emp += r.employee; a.empr += r.employer; a.total += r.employee + r.employer
    return a
  }, { base: 0, emp: 0, empr: 0, total: 0 })

  // TDS sheet: one row per employee who was paid salary OR a finalized bonus this month (S751).
  // A bonus paid in a month with no payroll run yet — or to someone not on this run — still has tax
  // to deposit, so it gets a row of its own rather than vanishing with the payslip it lacks.
  // "Withheld this year" is finalized payslips + finalized bonuses up to this month; a DRAFT run's
  // own tax is added on top, because the finalized map cannot contain it yet (it used to fall back
  // to the draft tax only when the map was empty, so month 3 of a draft year dropped month 3).
  const tdsRows = (() => {
    const byEmp = new Map()
    const rowFor = id => {
      if (!byEmp.has(id)) byEmp.set(id, { id, emp: empMap[id] || {}, s: null, st: null, bonuses: [], bonusAmount: 0, bonusTds: 0, exitAmount: 0, exitTds: 0 })
      return byEmp.get(id)
    }
    rows.forEach(({ s }) => { rowFor(s.employee_id).s = s })
    monthBonuses.forEach(b => {
      const r = rowFor(b.employee_id)
      r.bonuses.push(b); r.bonusAmount += num(b.amount); r.bonusTds += num(b.tds)
    })
    // A settled leaver's final month is their salary line; their exit payments are a line of their own.
    monthSettlements.forEach(st => {
      const r = rowFor(st.employee_id)
      r.st = st; r.exitAmount += settlementLump(st); r.exitTds += num(st.lump_tds)
    })
    return [...byEmp.values()].map(r => {
      const salaryTds = (r.s ? num(r.s.tds) : 0) + (r.st ? num(r.st.month_tds) : 0)
      const taxable = r.s || r.st
        ? (r.s ? payslipTaxable(r.s) : 0) + (r.st ? num(r.st.partial_salary) - num(r.st.month_ssf_employee) - num(r.st.month_retirement_contribution) : 0)
        : null
      return {
        ...r,
        name: r.emp.full_name || r.st?.employee_name || '(employee no longer on file)',
        pan: r.emp.pan_no || '',
        taxable,
        salaryTds,
        monthTds: salaryTds + r.bonusTds + r.exitTds,
        // ytdTds already carries finalized settlements; only a DRAFT run's own tax is added on top.
        ytd: (ytdTds[r.id] || 0) + (r.s && !finalized ? num(r.s.tds) : 0),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  })()
  const tdsTotals = tdsRows.reduce((a, r) => {
    a.salaryTds += r.salaryTds; a.bonusAmount += r.bonusAmount; a.bonusTds += r.bonusTds
    a.exitAmount += r.exitAmount; a.exitTds += r.exitTds
    a.monthTds += r.monthTds; a.ytd += r.ytd
    return a
  }, { salaryTds: 0, bonusAmount: 0, bonusTds: 0, exitAmount: 0, exitTds: 0, monthTds: 0, ytd: 0 })
  const hasMonthBonuses = monthBonuses.length > 0
  const hasMonthSettlements = monthSettlements.length > 0

  const TABS = [
    { id: 'roster',   label: 'Employee Directory' },
    { id: 'summary',  label: 'Payroll Summary' },
    { id: 'ssf',      label: 'SSF Challan' },
    { id: 'bank',     label: 'Bank Transfer' },
    { id: 'tds',      label: 'TDS Report' },
    { id: 'cert',     label: 'TDS Certificate' },
  ]

  const fyOptions = useMemo(() => {
    const seen = new Set()
    const result = []
    periods.forEach(p => {
      const { fyStart } = fiscalYearOf(p.bs_year, p.bs_month)
      if (!seen.has(fyStart)) {
        seen.add(fyStart)
        result.push({ fyStart, label: `${fyStart}/${String(fyStart + 1).slice(-2)}` })
      }
    })
    return result.sort((a, b) => b.fyStart - a.fyStart)
  }, [periods])

  // Roster = employee master directory (independent of any payroll run).
  const rosterRows = (rosterRetiringOnly
    ? employees.filter(e => !!retireInfo(e.retirement_date))
    : employees)
  const retiringCount = employees.filter(e =>
    (e.status === 'active' || e.status === 'probation') && retireInfo(e.retirement_date)?.soon).length

  if (!hasHrAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      {/* The certificate is a document of its own fiscal year: this month's header and its Draft chip
          used to print above it. */}
      <div className={`page-header page-header--split${tab === 'cert' ? ' no-print' : ''}`}>
        <div>
          <h1 className="page-title">HR Reports</h1>
          <p className="page-subtitle">
            Payroll filing & disbursement — {periodLabel}
            {run && <RunStatusBadge finalized={finalized} />}
          </p>
        </div>
        <select aria-label="Period" className="form-select no-print" value={period?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
          {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : (
        <>
          <Tabs idBase="hr-reports" label="HR reports" className="no-print" style={{ marginBottom: 18 }}
            tabs={TABS.map(t => ({ key: t.id, label: t.label }))} active={tab} onChange={setTab} />

          {/* ── TDS CERTIFICATE (independent of any period/run) ── */}
          {tab === 'cert' && (
            <div>
              <div className="card no-print" style={{ padding: '16px 20px', marginBottom: 16, display: 'flex', gap: 20, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Fiscal Year</div>
                    <select aria-label="Fiscal year" className="form-select" value={certFy?.fyStart || ''} onChange={e => {
                      const opt = fyOptions.find(f => f.fyStart === parseInt(e.target.value))
                      setCertFy(opt || null); setCertSlips([]); setCertBonuses([])
                    }}>
                      <option value="">Select FY…</option>
                      {fyOptions.map(f => <option key={f.fyStart} value={f.fyStart}>FY {f.label} (B.S.)</option>)}
                    </select>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 4 }}>Employee</div>
                    <select aria-label="Employee" className="form-select" value={certEmpId} onChange={e => { setCertEmpId(e.target.value); setCertSlips([]); setCertBonuses([]) }}>
                      <option value="">Select employee…</option>
                      {employees.map(e => <option key={e.id} value={e.id}>{e.full_name}{e.employee_code ? ` (${e.employee_code})` : ''}</option>)}
                    </select>
                  </div>
                </div>
                {(certSlips.length > 0 || certBonuses.length > 0 || certSettlements.length > 0) && !certLoading && !certError && !clientInfoError && (
                  <button className="btn btn-primary" style={{ marginLeft: 'auto' }} onClick={() => printWithTitle(`TDS Certificate - ${empMap[certEmpId]?.full_name || ''} - FY ${certFy.label}`)}>🖨 Print Certificate</button>
                )}
              </div>
              {(!certFy || !certEmpId) ? (
                <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text2)' }}>Select a fiscal year and employee above to generate the TDS certificate.</div>
              ) : certError || clientInfoError ? (
                // The employer's name and PAN are on the certificate: a failed read of them is a failed
                // certificate, not one with a blank PAN line.
                <ReportLoadError error={certError || clientInfoError} />
              ) : certLoading ? (
                <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text2)' }}>Loading…</div>
              ) : certSlips.length === 0 && certBonuses.length === 0 && certSettlements.length === 0 ? (
                <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text2)' }}>No finalized payslips, festival allowances, incentives or final settlement found for this employee in FY {certFy.label}.</div>
              ) : (
                <TdsCertificate emp={empMap[certEmpId] || {}} slips={certSlips} bonuses={certBonuses} settlements={certSettlements} fy={certFy} clientName={clientName} clientPan={clientPan} />
              )}
            </div>
          )}

          {/* ── ROSTER (employee master — independent of payroll run) ── */}
          {tab === 'roster' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--theme-border)', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>Employee Directory</span>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                    {employees.length} employee{employees.length !== 1 ? 's' : ''}
                    {retiringCount > 0 && <span> · <span style={{ color: 'var(--theme-accent-ink)' }}>{retiringCount} retiring within 180 days</span></span>}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="no-print">
                  <button type="button" className={`tab-btn${rosterRetiringOnly ? ' tab-btn--active' : ''}`} aria-pressed={rosterRetiringOnly} onClick={() => setRosterRetiringOnly(v => !v)}>Retiring soon</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                    rosterRows.map(e => ({
                      Code: e.employee_code || '', Name: e.full_name, Department: e.department || '', Designation: e.designation || '',
                      Supervisor: e.supervisor_id ? (nameById[e.supervisor_id] || '') : '',
                      'Join Date': fmtDate(e.join_date), 'Retirement Date': e.retirement_date ? fmtDate(e.retirement_date) : '', Status: e.status,
                    })), 'Employee Directory', 'xlsx', { scoped: false })}>⬇ Export</button>
                </div>
              </div>
              {rosterRows.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>No employees{rosterRetiringOnly ? ' retiring soon' : ''}.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Designation</th><th>Supervisor</th><th>Join Date</th><th>Retirement</th><th style={{ textAlign: 'center' }}>Status</th></tr></thead>
                    <tbody>
                      {rosterRows.map(e => {
                        const r = retireInfo(e.retirement_date)
                        return (
                          <tr key={e.id}>
                            <td style={{ color: 'var(--theme-accent-ink)', fontWeight: 700, fontSize: 12 }}>{e.employee_code || '—'}</td>
                            <td style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>{e.full_name}</td>
                            <td style={{ color: 'var(--theme-text3)' }}>{e.department || '—'}</td>
                            <td style={{ color: 'var(--theme-text3)' }}>{e.designation || '—'}</td>
                            <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>{e.supervisor_id ? (nameById[e.supervisor_id] || '—') : '—'}</td>
                            <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{fmtDate(e.join_date)}</td>
                            <td style={{ fontSize: 12 }}>
                              {e.retirement_date ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                  <span style={{ color: 'var(--theme-text2)' }}>{fmtDate(e.retirement_date)}</span>
                                  {r && <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 0, color: r.color, background: r.bg, border: `1px solid ${r.border}` }}>{r.label}</span>}
                                </span>
                              ) : <span style={{ color: 'var(--theme-text2)' }}>—</span>}
                            </td>
                            <td style={{ textAlign: 'center', color: 'var(--theme-text3)', fontSize: 12 }}>{e.status.charAt(0).toUpperCase() + e.status.slice(1)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* The TDS sheet still renders with no run when a finalized bonus was paid this month —
              that tax is due whether or not salary has been run yet (S751). */}
          {tab !== 'roster' && tab !== 'cert' && (!period ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text2)' }}>No periods yet for this client.</div>
          ) : !run && !((tab === 'tds' && (hasMonthBonuses || hasMonthSettlements)) || (tab === 'ssf' && hasMonthSettlements)) ? (
            <div className="card" style={{ padding: 40, textAlign: 'center' }}>
              <div aria-hidden="true" style={{ fontSize: 24, marginBottom: 12 }}>📊</div>
              <div style={{ fontSize: 14, color: 'var(--theme-text1)', marginBottom: 6 }}>No payroll run for {periodLabel}</div>
              <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Generate and finalize payroll in HR → Payroll first, then its reports appear here.</div>
            </div>
          ) : (
            <>
              {/* Printed too: a draft challan or TDS sheet on paper must say it is a draft. */}
              {run && !finalized && (
                <div role="alert" style={{ marginBottom: 14, padding: '10px 14px', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)', borderRadius: 0, fontSize: 12, color: 'var(--theme-amber-text)' }}>
                  ⚠ DRAFT — this payroll is not finalized and its figures may change. Finalize it in Payroll before filing or paying.
                </div>
              )}
              {hasMonthSettlements && (tab === 'ssf' || tab === 'tds') && (
                <div style={{ marginBottom: 14, padding: '10px 14px', border: '1px solid var(--theme-border)', fontSize: 12, color: 'var(--theme-text2)' }}>
                  Includes the final month of {monthSettlements.length} finalized Final Settlement{monthSettlements.length === 1 ? '' : 's'} ({monthSettlements.map(s => s.employee_name || 'a leaver').join(', ')}) — paid through the settlement, not this payroll run.
                </div>
              )}

          {/* ── SUMMARY ── */}
          {tab === 'summary' && (
            <div>
              <div className="stat-grid stat-grid--compact" style={{ marginBottom: 28 }}>
                {[
                  { label: 'Total Earned',   value: tot.gross,   color: 'var(--theme-accent-ink)', tip: 'Pay actually earned across all payslips: gross, less absence and unpaid days, plus overtime.' },
                  { label: 'Total Deductions', value: tot.ded,   color: 'var(--theme-red-text)', tip: 'Employee SSF + salary deductions (CIT, etc.) + TDS + advance recoveries.' },
                  { label: 'Net Payable',    value: tot.net,     color: 'var(--theme-green-text)', tip: tot.tada > 0 ? `Total take-home pay to disburse: earned − deductions + NPR ${fmt(tot.tada)} of travel claims (TADA) paid with the salary.` : 'Total take-home pay to disburse: earned − deductions.' },
                  { label: 'Employer Cost',  value: tot.empCost, color: 'var(--theme-text3)', tip: 'What the business spends on salary: pay earned + employer SSF (20%). Travel claims are reimbursements and are not included.' },
                ].map(s => (
                  <div key={s.label} className="card" style={{ padding: '16px 18px' }}>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                      <Tip text={s.tip} width={250}>{s.label}</Tip>
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: s.color }}>NPR {fmt(s.value)}</div>
                  </div>
                ))}
              </div>

              <div className="card" style={{ padding: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--theme-border)' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>By Department</span>
                  <button className="btn btn-ghost no-print" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                    depts.map(d => ({ Department: d.dept, Headcount: d.count, 'Earned (NPR)': Math.round(d.gross), 'Deductions (NPR)': Math.round(d.ded), 'Net (NPR)': Math.round(d.net) })),
                    'Payroll Summary')}>⬇ Export</button>
                </div>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Department</th><th style={{ textAlign: 'right' }}>Headcount</th><th style={{ textAlign: 'right' }}>Earned</th><th style={{ textAlign: 'right' }}>Deductions</th><th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}><Tip text="Take-home pay, including any travel claims paid with the salary." width={220}>Net</Tip></th></tr></thead>
                    <tbody>
                      {depts.map(d => (
                        <tr key={d.dept}>
                          <td style={{ color: 'var(--theme-text1)' }}>{d.dept}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{d.count}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(d.gross)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmt(d.ded)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{fmt(d.net)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                      <td style={{ color: 'var(--theme-text2)' }}>Total</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{rows.length}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(tot.gross)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>−{fmt(tot.ded)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmt(tot.net)}</td>
                    </tr></tfoot>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── SSF CHALLAN ── */}
          {tab === 'ssf' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--theme-border)' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>SSF Challan — {periodLabel}</span>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                    Total to deposit: <strong style={{ color: 'var(--theme-accent-ink)' }}>NPR {fmt(ssfTotals.total)}</strong>
                    {' '}· due by the {SSF_DEPOSIT_DAY}th of the following month
                    {noSsfCount > 0 && <span> · {noSsfCount} enrolled employee{noSsfCount > 1 ? 's' : ''} with no SSF number, so nothing was deducted</span>}
                  </div>
                </div>
                <button className="btn btn-ghost no-print" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                  ssfRows.map(r => ({ 'SSF No': r.ssfNo, Employee: r.name, 'Paid through': r.settlement ? 'Final settlement' : 'Payroll', 'SSF Basic': ssfBaseOf(r.employee, r.employer), 'Employee 11%': r.employee, 'Employer 20%': r.employer, 'Total 31%': r.employee + r.employer })),
                  'SSF Challan')}>⬇ Export</button>
              </div>
              <div className="no-print" style={{ padding: '10px 18px', fontSize: 11, color: 'var(--theme-text2)', borderBottom: '1px solid var(--theme-border)', background: 'color-mix(in srgb, var(--theme-text2) 6%, transparent)' }}>
                SSF's SOSYS portal (Collection screen) has no bulk-upload option — confirmed against the official SOSYS manual, entries are typed in one employee at a time. Use this sheet as your reference while entering SOSYS's Collection grid: type each row's <strong>SSF No</strong> and <strong>SSF Basic</strong> — SOSYS calculates the deposit itself, which should match this sheet's <strong>Total 31%</strong>.
              </div>
              {ssfRows.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>No SSF was deducted from anyone in {periodLabel}.</div>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>SSF No</th><th>Employee</th><th style={{ textAlign: 'right' }}><Tip text={`The basic the contribution was actually worked out on — the basic earned this month (less unpaid days), or what a daily or hourly worker earned — capped at NPR ${fmt(SSF_CAP)}. This is the figure to type into SOSYS.`} width={260}>SSF Basic</Tip></th><th style={{ textAlign: 'right' }}><Tip text={`SSF deducted from the employee's pay: 11% of the SSF basic (capped at NPR ${fmt(SSF_CAP)}).`} width={250}>Employee 11%</Tip></th><th style={{ textAlign: 'right' }}><Tip text={`SSF paid by the company on top of salary: 20% of the SSF basic (capped at NPR ${fmt(SSF_CAP)}).`} width={260}>Employer 20%</Tip></th><th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}><Tip text="Total SSF deposit to submit = Employee 11% + Employer 20%." width={240}>Total 31%</Tip></th></tr></thead>
                    <tbody>
                      {ssfRows.map(r => (
                        <tr key={r.id}>
                          <td style={{ color: r.ssfNo ? 'var(--theme-text3)' : 'var(--theme-amber-text)', fontSize: 12 }}>{r.ssfNo || '⚠ no SSF number on file'}</td>
                          <td style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>
                            {r.name}
                            {r.settlement && <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--theme-text2)' }}>final month · Final Settlement</div>}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(ssfBaseOf(r.employee, r.employer))}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(r.employee)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(r.employer)}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{fmt(r.employee + r.employer)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                      <td colSpan={2} style={{ color: 'var(--theme-text2)' }}>Total — {ssfRows.length}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(ssfTotals.base)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(ssfTotals.emp)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(ssfTotals.empr)}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmt(ssfTotals.total)}</td>
                    </tr></tfoot>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* ── BANK TRANSFER ── */}
          {tab === 'bank' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--theme-border)' }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>Salary Disbursement — {periodLabel}</span>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>Total: <strong style={{ color: 'var(--theme-green-text)' }}>NPR {fmt(tot.net)}</strong></div>
                </div>
                <div style={{ display: 'flex', gap: 8 }} className="no-print">
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => downloadSheet(bankData(), 'Bank Transfer')}>⬇ Excel</button>
                  <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => downloadSheet(bankData(), 'Bank Transfer', 'csv')}>⬇ CSV</button>
                </div>
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Employee</th><th>Bank</th><th>Account No</th><th style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>Net Pay</th></tr></thead>
                  <tbody>
                    {rows.map(({ s, emp }) => {
                      const missing = !emp.bank_name || !emp.bank_account_no
                      return (
                        <tr key={s.id}>
                          <td style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>{emp.full_name}</td>
                          <td style={{ color: missing ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>{emp.bank_name || '⚠ missing'}</td>
                          <td style={{ color: missing ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>{emp.bank_account_no || '⚠ missing'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-green-text)', fontWeight: 600 }}>{fmt(s.net_pay)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)' }}>Total — {rows.length}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{fmt(tot.net)}</td>
                  </tr></tfoot>
                </table>
              </div>
            </div>
          )}

          {/* ── TDS ── */}
          {tab === 'tds' && (
            <div className="card" style={{ padding: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px', borderBottom: '1px solid var(--theme-border)', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>TDS / Income Tax — {periodLabel}</span>
                  <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                    Income tax to deposit for this month: <strong style={{ color: 'var(--theme-accent-ink)' }}>NPR {fmt(tdsTotals.monthTds)}</strong>
                    {hasMonthBonuses && <span> · includes NPR {fmt(tdsTotals.bonusTds)} withheld from festival allowances and incentives paid this month</span>}
                    {hasMonthSettlements && <span> · includes NPR {fmt(tdsTotals.exitTds)} withheld from final settlement exit payments</span>}
                  </div>
                </div>
                <button className="btn btn-ghost no-print" style={{ fontSize: 12 }} onClick={() => downloadSheet(
                  tdsRows.map(r => ({
                    Employee: r.name, PAN: r.pan,
                    'Taxable salary (month)': r.taxable === null ? '' : Math.round(r.taxable),
                    'Tax on salary (month)': r.salaryTds,
                    'Festival allowance & incentives paid (month)': r.bonusAmount,
                    'Paid as': r.bonuses.map(bonusLabel).join('; '),
                    'Tax on festival allowance & incentives (month)': r.bonusTds,
                    'Exit payments — final settlement (month)': r.exitAmount,
                    'Tax on exit payments (month)': r.exitTds,
                    'Total tax to deposit (month)': r.monthTds,
                    'Tax withheld so far this fiscal year': r.ytd,
                  })),
                  'TDS Report')}>⬇ Export</button>
              </div>
              {!run && (
                <div style={{ padding: '10px 18px', fontSize: 11, color: 'var(--theme-text2)', borderBottom: '1px solid var(--theme-border)' }}>
                  No payroll run for {periodLabel} yet, so no payroll salary tax is listed — only tax already withheld on festival allowances, incentives and final settlements paid this month.
                </div>
              )}
              {tdsRows.length === 0 ? (
                <div style={{ padding: 28, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>No one was paid salary, a festival allowance or an incentive in {periodLabel}.</div>
              ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Employee</th><th>PAN</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Taxable salary this month = pay earned (gross − absence and unpaid days + overtime) − employee SSF − CIT / provident fund. The same figure the month's tax was worked out on." width={270}>Taxable salary</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Income tax (TDS) taken out of this month's payslip." width={240}>Tax on salary</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Festival allowances (e.g. Dashain) and incentives that were finalized with this month as their pay month. They are paid separately from the payslip, but they are income all the same." width={280}>Festival allowance &amp; incentives</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Income tax (TDS) withheld from those festival allowances and incentives. It is due for deposit with this month's salary tax." width={270}>Tax on them</Tip></th>
                    {hasMonthSettlements && <th style={{ textAlign: 'right' }}><Tip text="Gratuity, leave encashment, festival share and notice pay paid in a Final Settlement finalized for this month, and the tax withheld on them." width={280}>Exit payments / tax</Tip></th>}
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}><Tip text="Everything withheld from this employee this month: tax on salary + tax on festival allowances and incentives. This is what you deposit with the Inland Revenue Department for the month." width={290}>Total to deposit</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="Income tax withheld from this employee so far this fiscal year (from Shrawan), up to and including this month — finalized payslips plus finalized festival allowances and incentives. If this month's payroll is still a draft, its tax is included too." width={300}>Withheld this year</Tip></th>
                  </tr></thead>
                  <tbody>
                    {tdsRows.map(r => (
                      <tr key={r.id}>
                        <td style={{ color: 'var(--theme-text1)', fontWeight: 600 }}>{r.name}</td>
                        <td style={{ color: 'var(--theme-text3)', fontSize: 12 }}>{r.pan || '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{r.taxable === null ? '—' : fmt(r.taxable)}</td>
                        <td style={{ textAlign: 'right', color: r.salaryTds > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{r.salaryTds > 0 ? fmt(r.salaryTds) : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                          {r.bonusAmount > 0 ? fmt(r.bonusAmount) : '—'}
                          {r.bonuses.length > 0 && <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{r.bonuses.map(b => b.source === 'festival' ? (b.festival_name || 'Festival') : (b.run_label || 'Incentive')).join(' · ')}</div>}
                        </td>
                        <td style={{ textAlign: 'right', color: r.bonusTds > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{r.bonusTds > 0 ? fmt(r.bonusTds) : '—'}</td>
                        {hasMonthSettlements && (
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                            {r.exitAmount > 0 ? fmt(r.exitAmount) : '—'}
                            {r.exitTds > 0 && <div style={{ fontSize: 10, color: 'var(--theme-red-text)' }}>tax {fmt(r.exitTds)}</div>}
                          </td>
                        )}
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{r.monthTds > 0 ? fmt(r.monthTds) : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(r.ytd)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                    <td colSpan={3} style={{ color: 'var(--theme-text2)' }}>Total — {tdsRows.length}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmt(tdsTotals.salaryTds)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(tdsTotals.bonusAmount)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmt(tdsTotals.bonusTds)}</td>
                    {hasMonthSettlements && <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(tdsTotals.exitAmount)}<div style={{ fontSize: 10, color: 'var(--theme-red-text)' }}>tax {fmt(tdsTotals.exitTds)}</div></td>}
                    <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmt(tdsTotals.monthTds)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>{fmt(tdsTotals.ytd)}</td>
                  </tr></tfoot>
                </table>
              </div>
              )}
            </div>
          )}
            </>
          ))}
        </>
      )}
    </div>
  )

  function bankData() {
    return rows.map(({ s, emp }) => ({ Name: emp.full_name, Bank: emp.bank_name || '', 'Account No': emp.bank_account_no || '', Amount: s.net_pay }))
  }
}

function TdsCertificate({ emp, slips, bonuses = [], settlements = [], fy, clientName, clientPan }) {
  const fmtN = nprInt
  const today = getBsToday()
  const issuedDate = `${BS_MONTHS[today.month - 1]} ${today.day}, ${today.year} B.S.`

  // Salary figures (finalized payslips, and a Final Settlement's final month) and one-off payments
  // (finalized festival allowances and incentives, and a settlement's exit payments) are totalled
  // separately and then together (S751/S752): all of it is employment income the employer withheld
  // tax on, and the certificate's Total TDS Withheld is a claim the employee files on.
  //
  // Income is what was EARNED — gross less the absence deduction, plus overtime. The certificate
  // counted gross, so every unpaid day raised the stated income above what tax was worked out on.
  const salary = slips.reduce((a, s) => {
    a.gross += num(s.gross) - num(s.absence_deduction) + num(s.ot_amount)
    a.ssf   += num(s.ssf_employee)
    a.retirement += num(s.retirement_contribution)
    a.tds   += num(s.tds)
    return a
  }, { gross: 0, ssf: 0, retirement: 0, tds: 0 })
  settlements.forEach(st => {
    salary.gross += num(st.partial_salary)
    salary.ssf   += num(st.month_ssf_employee)
    salary.retirement += num(st.month_retirement_contribution)
    salary.tds   += num(st.month_tds)
  })
  const exitPay = settlements.reduce((a, st) => { a.amount += settlementLump(st); a.tds += num(st.lump_tds); return a }, { amount: 0, tds: 0 })
  const bonus = bonuses.reduce((a, b) => {
    a.amount += num(b.amount)
    a.tds    += num(b.tds)
    return a
  }, { amount: 0, tds: 0 })
  bonus.amount += exitPay.amount
  bonus.tds    += exitPay.tds
  const oneOffCount = bonuses.length + settlements.filter(st => settlementLump(st) > 0).length
  const totals = { gross: salary.gross + bonus.amount, ssf: salary.ssf, tds: salary.tds + bonus.tds }
  const monthCount = slips.length + settlements.length
  // SSF and CIT / provident fund share ONE relief, capped at NPR 5,00,000 or a third of income — the
  // cap monthly payroll withholds by (tds.js retirementRelief, S748). The certificate took SSF off
  // uncapped and CIT not at all, so for anyone saving into CIT it stated a higher taxable income than
  // the tax actually withheld was worked out on (S751).
  const retirementPaid = salary.ssf + salary.retirement
  const retirementOff  = retirementRelief(retirementPaid, totals.gross)

  // The premiums the year's tax was actually worked out with: the latest payslip or settlement of the
  // year that stored them (S753). The employee record is only the fallback for a year paid before
  // payslips kept them — reading it first let this year's edit rewrite last year's certificate.
  const monthKey = (y, m) => (Number(y) || 0) * 12 + (Number(m) || 0)
  const storedIns = [
    ...slips.map(s => ({ ym: monthKey(s.hr_payroll_runs?.monthly_periods?.bs_year, s.hr_payroll_runs?.monthly_periods?.bs_month), life: s.life_insurance_premium, health: s.health_insurance_premium })),
    ...settlements.map(st => ({ ym: monthKey(st.settle_bs_year, st.settle_bs_month), life: st.life_insurance_premium, health: st.health_insurance_premium })),
  ].filter(x => x.life != null || x.health != null).sort((a, b) => b.ym - a.ym)[0]
  const insSource = storedIns || { life: emp.life_insurance_premium, health: emp.health_insurance_premium }
  const lifeIns   = Math.min(parseFloat(insSource.life)   || 0, 40000)
  const healthIns = Math.min(parseFloat(insSource.health) || 0, 20000)
  const insTotal  = lifeIns + healthIns
  const taxable   = Math.max(0, totals.gross - retirementOff - insTotal)

  const card = { background: 'var(--theme-bg)', borderRadius: 0, border: '1px solid var(--theme-border)', padding: '14px 16px' }

  return (
    <div className="card">

      {/* Title */}
      <div style={{ textAlign: 'center', marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--theme-border)' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 4 }}>Certificate of Tax Deducted at Source</div>
        <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Nepal Income Tax Act, 2058 · Fiscal Year {fy.label} B.S.</div>
      </div>

      {/* Employer / Employee */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 24 }}>
        <div style={card}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Employer</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 6 }}>{clientName || '—'}</div>
          <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>PAN: <span style={{ color: clientPan ? 'var(--theme-text1)' : 'var(--theme-text2)' }}>{clientPan || '_______________'}</span></div>
        </div>
        <div style={card}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Employee</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)', marginBottom: 4 }}>{emp.full_name}</div>
          {(emp.designation || emp.department) && (
            <div style={{ fontSize: 12, color: 'var(--theme-text3)', marginBottom: 4 }}>
              {[emp.designation, emp.department].filter(Boolean).join(' · ')}
            </div>
          )}
          {emp.employee_code && <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Code: {emp.employee_code}</div>}
          <div style={{ fontSize: 12, color: 'var(--theme-text2)', marginTop: 2 }}>PAN: <span style={{ color: emp.pan_no ? 'var(--theme-text2)' : 'var(--theme-accent-ink)' }}>{emp.pan_no || '⚠ not on file'}</span></div>
        </div>
      </div>

      {/* Month-wise table */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>Month-wise Income & TDS</div>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Month</th>
                <th style={{ textAlign: 'right' }}><Tip text="Pay earned in the month: gross, less absence and unpaid days, plus overtime." width={240}>Income Earned</Tip></th>
                <th style={{ textAlign: 'right' }}>SSF Deducted</th>
                <th style={{ textAlign: 'right' }}><Tip text="CIT / provident fund contributions, which reduce taxable income within the same cap as SSF." width={240}>CIT / PF</Tip></th>
                <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>TDS Withheld</th>
              </tr>
            </thead>
            <tbody>
              {monthCount === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--theme-text2)', textAlign: 'center' }}>No finalized payslips this fiscal year — only festival allowances or incentives were paid.</td></tr>
              )}
              {slips.map(s => {
                const mp = s.hr_payroll_runs.monthly_periods
                return (
                  <tr key={s.id}>
                    <td>{BS_MONTHS[mp.bs_month - 1]} {mp.bs_year}</td>
                    <td style={{ textAlign: 'right' }}>{fmtN(num(s.gross) - num(s.absence_deduction) + num(s.ot_amount))}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{num(s.ssf_employee) > 0 ? fmtN(s.ssf_employee) : '—'}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{num(s.retirement_contribution) > 0 ? fmtN(s.retirement_contribution) : '—'}</td>
                    <td style={{ textAlign: 'right', color: num(s.tds) > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{num(s.tds) > 0 ? fmtN(s.tds) : '—'}</td>
                  </tr>
                )
              })}
              {settlements.map(st => (
                <tr key={st.id}>
                  <td>{BS_MONTHS[st.settle_bs_month - 1]} {st.settle_bs_year}<div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>final month · Final Settlement</div></td>
                  <td style={{ textAlign: 'right' }}>{fmtN(st.partial_salary)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{num(st.month_ssf_employee) > 0 ? fmtN(st.month_ssf_employee) : '—'}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{num(st.month_retirement_contribution) > 0 ? fmtN(st.month_retirement_contribution) : '—'}</td>
                  <td style={{ textAlign: 'right', color: num(st.month_tds) > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{num(st.month_tds) > 0 ? fmtN(st.month_tds) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                <td style={{ color: 'var(--theme-text2)' }}>{oneOffCount > 0 ? 'Salary total' : 'Total'} ({monthCount} month{monthCount !== 1 ? 's' : ''})</td>
                <td style={{ textAlign: 'right' }}>{fmtN(salary.gross)}</td>
                <td style={{ textAlign: 'right' }}>{fmtN(salary.ssf)}</td>
                <td style={{ textAlign: 'right' }}>{salary.retirement > 0 ? fmtN(salary.retirement) : '—'}</td>
                <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmtN(salary.tds)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Festival allowances and incentives — paid outside the payslip, taxed all the same (S751) */}
      {oneOffCount > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Festival Allowances, Incentives &amp; Exit Payments</div>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 10 }}>
            Paid separately from the monthly payslip. Each is employment income, and the tax withheld from it is included in the totals below.
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Payment</th>
                  <th>Paid in</th>
                  <th style={{ textAlign: 'right' }}>Income</th>
                  <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>TDS Withheld</th>
                </tr>
              </thead>
              <tbody>
                {bonuses.map(b => (
                  <tr key={`${b.source}-${b.id}`}>
                    <td>{bonusLabel(b)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{bonusPaidIn(b)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtN(num(b.amount))}</td>
                    <td style={{ textAlign: 'right', color: num(b.tds) > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{num(b.tds) > 0 ? fmtN(num(b.tds)) : '—'}</td>
                  </tr>
                ))}
                {settlements.filter(st => settlementLump(st) > 0).map(st => (
                  <tr key={`settle-${st.id}`}>
                    <td>Final settlement — gratuity, leave, festival share, notice</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{BS_MONTHS[st.settle_bs_month - 1]} {st.settle_bs_year}</td>
                    <td style={{ textAlign: 'right' }}>{fmtN(settlementLump(st))}</td>
                    <td style={{ textAlign: 'right', color: num(st.lump_tds) > 0 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>{num(st.lump_tds) > 0 ? fmtN(st.lump_tds) : '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--theme-border)' }}>
                  <td colSpan={2} style={{ color: 'var(--theme-text2)' }}>One-off payments total ({oneOffCount})</td>
                  <td style={{ textAlign: 'right' }}>{fmtN(bonus.amount)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmtN(bonus.tds)}</td>
                </tr>
                <tr style={{ fontWeight: 700 }}>
                  <td colSpan={2} style={{ color: 'var(--theme-text1)' }}>Total for the year — salary + one-off payments</td>
                  <td style={{ textAlign: 'right' }}>{fmtN(totals.gross)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmtN(totals.tds)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Taxable computation + TDS summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, marginBottom: 32 }}>
        <div style={card}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>Taxable Income Computation</div>
          {[
            ...(oneOffCount > 0 ? [
              { label: `Salary & overtime earned (${monthCount} month${monthCount !== 1 ? 's' : ''})`, value: salary.gross, neg: false },
              { label: 'Add: Festival allowances, incentives & exit payments', value: bonus.amount, neg: false, sub: `${oneOffCount} payment${oneOffCount !== 1 ? 's' : ''}` },
            ] : []),
            { label: 'Total Gross Income',               value: totals.gross, neg: false },
            { label: salary.retirement > 0 ? 'Less: SSF + CIT / provident fund' : 'Less: SSF Employee Contribution', value: retirementOff, neg: true,
              sub: retirementOff < retirementPaid - 0.5 ? `paid NPR ${fmtN(retirementPaid)} — relief capped at NPR 5,00,000 or a third of income` : (salary.retirement > 0 ? `SSF NPR ${fmtN(salary.ssf)} + CIT NPR ${fmtN(salary.retirement)}` : undefined) },
            ...(lifeIns > 0 ? [{ label: `Less: Life Insurance (cap NPR 40,000)`, value: lifeIns, neg: true, sub: `declared NPR ${fmtN(parseFloat(insSource.life)||0)}${storedIns ? '' : ' (from the employee record — no payslip this year stored it)'}` }] : []),
            ...(healthIns > 0 ? [{ label: `Less: Health Insurance (cap NPR 20,000)`, value: healthIns, neg: true, sub: `declared NPR ${fmtN(parseFloat(insSource.health)||0)}${storedIns ? '' : ' (from the employee record — no payslip this year stored it)'}` }] : []),
          ].map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '5px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                {r.label}
                {r.sub && <div style={{ fontSize: 10, color: 'var(--theme-text2)' }}>{r.sub}</div>}
              </span>
              <span style={{ fontSize: 12, color: r.neg ? 'var(--theme-red-text)' : 'var(--theme-text1)', whiteSpace: 'nowrap', paddingLeft: 12 }}>
                {r.neg ? '− ' : ''}NPR {fmtN(r.value)}
              </span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, marginTop: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>Annual Taxable Income</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>NPR {fmtN(taxable)}</span>
          </div>
        </div>

        <div style={card}>
          <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>TDS Summary</div>
          {[
            { label: 'Finalized months',      value: String(monthCount) },
            ...(oneOffCount > 0 ? [
              { label: 'Tax withheld from salary', value: `NPR ${fmtN(salary.tds)}` },
              { label: 'Tax withheld from one-off payments', value: `NPR ${fmtN(bonus.tds)}` },
            ] : []),
            { label: 'SSF Contributor',        value: isSsfContributor(emp) ? 'Yes' : salary.ssf > 0 ? 'Contributed this year' : 'No' },
            { label: 'Employee PAN',           value: emp.pan_no || '—' },
          ].map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: '1px solid var(--theme-border-lt)' }}>
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{r.label}</span>
              <span style={{ fontSize: 12, color: 'var(--theme-text1)' }}>{r.value}</span>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, paddingTop: 12, borderTop: '2px solid var(--theme-border)' }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>Total TDS Withheld</span>
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--theme-red-text)' }}>NPR {fmtN(totals.tds)}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 6, lineHeight: 1.5 }}>
            Deposited by employer with the Inland Revenue Department, Nepal.
          </div>
        </div>
      </div>

      {/* Signature block */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '28px 60px', paddingTop: 20, borderTop: '1px solid var(--theme-border)' }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginBottom: 40 }}>Issued on: {issuedDate}</div>
          <div style={{ borderTop: '1px solid var(--theme-text2)', paddingTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text1)' }}>{clientName || '_______________'}</div>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>Authorised Signatory · Employer</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div style={{ borderTop: '1px solid var(--theme-text2)', paddingTop: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--theme-text1)' }}>{emp.full_name}</div>
            <div style={{ fontSize: 11, color: 'var(--theme-text2)' }}>Employee Acknowledgement</div>
          </div>
        </div>
      </div>

    </div>
  )
}
