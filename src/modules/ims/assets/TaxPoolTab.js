import { nprInt } from '../../../shared/nepalMoney'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import ActionError, { asActionError } from '../../../components/ActionError'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { settleWithin } from '../../../utils/withTimeout'
import { getBsFiscalYear, getBsFiscalYearStart, getBsToday, formatAd, formatAdAsBs, daysInBsMonth } from '../../../utils/bsCalendar'
import { nepalBsLong, nepalTime } from '../../../shared/nepalTime'
import { loadProfileNames } from '../../../shared/profileNames'
import { getFiscalYearAdRange } from '../reports/vendorBalanceHelpers'
import { printWithTitle } from '../../../utils/printTitle'
import { priorPoolRun, buildTaxPoolLines, schedulesToPostAgain, postedLinePayload, POOLS_AD } from './taxPoolCompute'
import { POOL_LABELS, POOL_EXAMPLES, POOL_RATES, DISCLAIMER_TEXT } from './taxPoolConstants'
import TaxPoolOpeningsCard from './TaxPoolOpeningsCard'
import { readRegister, answerLost, refusedWith, ASSET_CALL_MS } from './assetReads'

const poolTip = pool => pool === 'E'
  ? POOL_EXAMPLES.E
  : `${POOL_EXAMPLES[pool]} — depreciated at ${Math.round(POOL_RATES[pool] * 100)}% a year under Nepal tax rules.`

const fmt = nprInt
const n = v => parseFloat(v) || 0

// "Every pool opens at 0" / "Pools B, D open at 0" — the COSTS-5 banner names only the pools that do.
const poolsOpeningAtZero = pools => pools.length === POOLS_AD.length
  ? 'Pools A–D open at 0'
  : `${pools.length === 1 ? 'Pool' : 'Pools'} ${pools.join(', ')} ${pools.length === 1 ? 'opens' : 'open'} at 0`

// "B" / "B and D" / "A, B and D"
const joinAnd = items => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

// The BS year a short fiscal-year label starts in: "83/84" → 2083.
const fyStartOfLabel = label => { const m = /^(\d{1,2})\//.exec(label || ''); return m ? 2000 + Number(m[1]) : null }

// S849 (ASSETS-11): the year being worked out and the three before it. Next year was offered too,
// and a schedule posted for it locked that year's typed openings months before it began; it can
// never be posted meaningfully, so it is gone. A year opened from "Schedules to post again" that is
// older than these is added, so the select can show it.
function fyOptionsAround(currentFyStart, shown) {
  const years = [currentFyStart, currentFyStart - 1, currentFyStart - 2, currentFyStart - 3]
  if (shown != null && !years.includes(shown)) years.push(shown)
  return years.sort((a, b) => b - a)
}

const amberBox = {
  marginBottom: 12, padding: '10px 14px', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)',
  border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)',
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', borderRadius: 'var(--radius-sm)',
}
const fine = { margin: '10px 0 0', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)' }

// Why a posted year is listed under "Schedules to post again" (S849, ASSETS-9), as one sentence.
// It is also the reason a re-post carries in its notes ("Posted again: …"), which keeps that post
// apart from the two-minute duplicate refusal and puts the reason on the run.
function repostReason(item, names) {
  const w = item.why
  if (w.kind === 'correction') {
    const cs = w.corrections
    const first = cs[0]
    const who = names?.[first.corrected_by] || 'a login that has since been removed'
    const when = nepalBsLong(first.corrected_at) || 'an unknown date'
    const figure = c => {
      const wdv = `${c.old_opening_wdv == null ? 'none' : fmt(c.old_opening_wdv)} → ${fmt(c.new_opening_wdv)}`
      const oldRep = c.old_repair_carry_forward == null ? 0 : n(c.old_repair_carry_forward)
      const rep = Math.abs(oldRep - n(c.new_repair_carry_forward)) > 0.005
        ? ` (repair carried forward ${c.old_repair_carry_forward == null ? 'none' : fmt(oldRep)} → ${fmt(c.new_repair_carry_forward)})`
        : ''
      return wdv + rep
    }
    const what = cs.length === 1
      ? `Pool ${first.pool}'s opening for FY ${item.fiscalYear} was corrected on ${when} by ${who}: ${figure(first)}.`
      : `The openings of Pools ${joinAnd(cs.map(c => c.pool))} for FY ${item.fiscalYear} were corrected on ${when} by ${who}: ${cs.map(c => `${c.pool} ${figure(c)}`).join('; ')}.`
    return `${what} Reason: ${first.reason}`
  }
  if (w.kind === 'reposted') {
    return `FY ${w.priorLabel} was posted again on ${nepalBsLong(w.at) || 'a later date'}, so FY ${item.fiscalYear} would now open from different figures.`
  }
  return `FY ${item.fiscalYear}'s posted opening values no longer match what it would open from today.`
}

// The schedule as a table. The screen keeps one Additions column (a Tip gives a figure's split);
// paper splits it into its three rates, so the printed row can be checked by hand (ASSETS-10).
// `.print-only` is display:block in print, which a table cell cannot take, so paper gets its own
// table rather than print-only cells.
function PoolTable({ lines, print }) {
  const showWriteOff = lines.some(l => n(l.terminal_deduction) > 0.005 || n(l.balancing_income) > 0.005)
  const sum = key => lines.reduce((s, l) => s + n(l[key]), 0)
  const additions = l => n(l.additions_full) + n(l.additions_two_third) + n(l.additions_one_third)
  const right = { textAlign: 'right' }
  const th = (label, tip, width = 280) => <th style={right}>{print ? label : <Tip text={tip} width={width}>{label}</Tip>}</th>
  return (
    <table className="data-table">
      <thead>
        <tr>
          <th>{print ? 'Pool' : <Tip text="All figures in NPR." width={180}>Pool</Tip>}</th>
          {th('Opening WDV', 'Opening written-down value (WDV): what the pool was worth for tax at the start of the year. It is the closing WDV of last year carried forward, or the value typed in from the tax return of last year.', 300)}
          {th('Repair carried in', "Last year's repair spend above its 7% cap (or the figure typed from last year's tax return), which joins this year's pool at full value (Section 16(3)).")}
          {print ? (
            <>
              <th style={right}>Additions (full rate)</th>
              <th style={right}>Additions (⅔ rate)</th>
              <th style={right}>Additions (⅓ rate)</th>
            </>
          ) : th('Additions', 'Cost of new things bought into this pool this year. Bought by the end of Poush it counts in full; Magh to Chaitra, two-thirds; Baisakh to Ashadh, one-third. Hover a figure for its split.', 300)}
          {th('Disposals', 'Money received from selling or scrapping equipment in this pool during the fiscal year.', 260)}
          {th('Depreciation base', "What the pool's rate is applied to this year: Opening + Repair carried in + Additions at their counted share − Disposals. Never below 0.")}
          {th('Repair (Deductible / Capitalized)', 'Repair and maintenance spend on this pool. The first number is deductible this year, up to 7% of the depreciation base. The second, if shown, joins the pool next year instead.', 300)}
          {th('Depreciation', "The tax-deductible depreciation for this pool this year, at Nepal's statutory rate for that pool. A pool left with less than NPR 2,000 is written off in full.", 260)}
          {showWriteOff && th('Write-off', 'What was left of a pool whose every asset was sold or scrapped this year: deductible this year instead of being depreciated later (Schedule 2 §4(2)).')}
          {showWriteOff && th('Income', "Disposal proceeds above what the pool was worth: business income this year (Schedule 2 §4(1)). A pool's value never goes below 0.")}
          {th('Closing WDV', 'What the pool is worth for tax at the end of the year, and the opening WDV of next year. Opening + Repair carried in + Additions − Disposals − Depreciation − Write-off + Income.', 300)}
        </tr>
      </thead>
      <tbody>
        {lines.map(l => {
          const split = n(l.additions_two_third) + n(l.additions_one_third) > 0.005
          return (
            <tr key={l.pool}>
              <td>{print ? POOL_LABELS[l.pool] : <Tip text={poolTip(l.pool)} width={300}>{POOL_LABELS[l.pool]}</Tip>}</td>
              <td style={right}>{fmt(l.opening_wdv)}</td>
              <td style={right}>{fmt(l.repair_carried_in)}</td>
              {print ? (
                <>
                  <td style={right}>{fmt(l.additions_full)}</td>
                  <td style={right}>{fmt(l.additions_two_third)}</td>
                  <td style={right}>{fmt(l.additions_one_third)}</td>
                </>
              ) : (
                <td style={right}>
                  {split
                    ? <Tip text={`Full rate: NPR ${fmt(l.additions_full)} · ⅔ rate: NPR ${fmt(l.additions_two_third)} · ⅓ rate: NPR ${fmt(l.additions_one_third)}`} width={260}>{fmt(additions(l))}</Tip>
                    : fmt(additions(l))}
                </td>
              )}
              <td style={right}>{fmt(l.disposal_proceeds)}</td>
              <td style={right}>{fmt(l.depreciation_base)}</td>
              <td style={right}>
                {fmt(l.repair_expense_deductible)}{n(l.repair_expense_capitalized) > 0 && ` / ${fmt(l.repair_expense_capitalized)}`}
              </td>
              <td style={right}>{fmt(l.depreciation_amount)}</td>
              {showWriteOff && <td style={right}>{n(l.terminal_deduction) > 0.005 ? fmt(l.terminal_deduction) : '—'}</td>}
              {showWriteOff && <td style={right}>{n(l.balancing_income) > 0.005 ? fmt(l.balancing_income) : '—'}</td>}
              <td style={{ ...right, fontWeight: 600 }}>{fmt(l.closing_wdv)}</td>
            </tr>
          )
        })}
      </tbody>
      <tfoot>
        <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
          <td>Total</td>
          <td style={right}>{fmt(sum('opening_wdv'))}</td>
          <td style={right}>{fmt(sum('repair_carried_in'))}</td>
          {print ? (
            <>
              <td style={right}>{fmt(sum('additions_full'))}</td>
              <td style={right}>{fmt(sum('additions_two_third'))}</td>
              <td style={right}>{fmt(sum('additions_one_third'))}</td>
            </>
          ) : <td style={right}>{fmt(lines.reduce((s, l) => s + additions(l), 0))}</td>}
          <td style={right}>{fmt(sum('disposal_proceeds'))}</td>
          <td></td>
          <td></td>
          <td style={right}>{fmt(sum('depreciation_amount'))}</td>
          {showWriteOff && <td style={right}>{fmt(sum('terminal_deduction'))}</td>}
          {showWriteOff && <td style={right}>{fmt(sum('balancing_income'))}</td>}
          <td style={right}>{fmt(sum('closing_wdv'))}</td>
        </tr>
      </tfoot>
    </table>
  )
}

export default function TaxPoolTab() {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const biz = useBizInfo()

  const todayBs = getBsToday()
  const currentFyStart = getBsFiscalYearStart(todayBs.year, todayBs.month)
  const [fyStart, setFyStart] = useState(currentFyStart)
  const [repairExpenses, setRepairExpenses] = useState([])
  const [newExpense, setNewExpense] = useState({ pool: 'A', expense_date: '', amount: '', description: '' })
  // S849 (ASSETS-2): the inputs the preview on screen was built from, kept so ticking "every asset
  // of this pool was sold or scrapped" recomputes the schedule without a re-read. The lines
  // themselves are derived (buildTaxPoolLines), so the figures on screen are always the ones these
  // inputs and ticks give — and the ones Post sends. null = no preview on screen.
  const [previewInputs, setPreviewInputs] = useState(null)
  const [closedPools, setClosedPools] = useState({})
  const [loading, setLoading] = useState(false)
  const [posting, setPosting] = useState(false)
  const [msg, setMsg] = useState('')
  // Errors live apart from `msg` (S658) — see the same split in DepreciationRunTab. `msg` is now
  // only ever the one-line success confirmation beside the Post button.
  const [err, setErr] = useState(null)
  // ASSETS-17: after a post whose answer never arrived, what a fresh read found posted for that year.
  const [recheck, setRecheck] = useState(null)
  // The repair list is an input to the Section 16 cap, so a preview may only be computed from a list
  // that loaded, for the year on screen (S792, COSTS-7). `repairsLoaded` is false while it loads and
  // after a failed read; `repairErr` says why. The read used to keep the PREVIOUS year's list on a
  // failure, and Preview cleared the error, so FY 83/84 could be capped against 82/83's repairs and
  // posted that way.
  const [repairsLoaded, setRepairsLoaded] = useState(false)
  const [repairErr, setRepairErr] = useState(null)
  // Keyed on the FY label: arrowing through the year <select> starts one read per year, and the
  // slowest to land used to win the list.
  const repairReq = useLatestRequest()
  // Bumped whenever an input to the preview changes — the year, or the repair list (added, deleted
  // or re-read). A preview computed from an older version is discarded rather than shown, so Post
  // can never lock figures built from other inputs than the ones on screen (COSTS-7).
  const inputsVersion = useRef(0)
  // S849 (ASSETS-9): the posted years whose schedule no longer matches what they would open from
  // today, oldest first — after a corrected typed opening, or a year posted again out of order.
  const [repost, setRepost] = useState({ list: [], names: {}, error: null })
  const repostSeq = useRef(0)
  // Bumped after a post, so the openings card re-reads which values the new schedule has locked.
  const [cardRefresh, setCardRefresh] = useState(0)

  const fyLabel = getBsFiscalYear(fyStart, 4)
  const canPost = hasImsAccess('manager')

  useEffect(() => { loadRepairExpenses(fyLabel) }, [fyLabel]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadRepost() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const built = useMemo(() => (previewInputs ? buildTaxPoolLines({ ...previewInputs, closedPools }) : null), [previewInputs, closedPools])
  const lines = built ? built.lines : null

  // What the notes over the table say, from the same inputs (S792 COSTS-5/6, D40).
  const notes = useMemo(() => {
    if (!previewInputs || !built) return {}
    const { priorRun, earlierLabel, typedOpenings, priorLabel } = previewInputs
    const zeroPools = priorRun ? [] : POOLS_AD.filter(p => !typedOpenings[p])
    const typedPools = POOLS_AD.filter(p => typedOpenings[p])
    const e = built.poolE
    return {
      openingGap: zeroPools.length ? { priorLabel, earlierLabel, pools: zeroPools } : null,
      openingTyped: !priorRun && (typedPools.length || e.opening_wdv > 0.005) ? { priorLabel, pools: typedPools, eOpening: e.opening_wdv } : null,
      poolEDisposed: e.disposed_value > 0.005 || e.disposal_proceeds > 0.005 ? { value: e.disposed_value, proceeds: e.disposal_proceeds } : null,
      poolECapped: e.scheduled - e.depreciation_amount > 0.005 ? { scheduled: e.scheduled, held: e.depreciation_base } : null,
    }
  }, [previewInputs, built])
  const { openingGap, openingTyped, poolEDisposed, poolECapped } = notes

  // Any change to what a preview is built from throws the preview away.
  function inputsChanged() {
    inputsVersion.current += 1
    setPreviewInputs(null)
  }

  function changeYear(nextStart) {
    repairReq.begin(getBsFiscalYear(nextStart, 4))   // synchronous: the old year's read now loses
    setRepairExpenses([]); setRepairsLoaded(false); setRepairErr(null)
    inputsChanged()
    setClosedPools({}); setRecheck(null); setMsg(''); setErr(null)
    setFyStart(nextStart)
  }

  async function loadRepairExpenses(label) {
    repairReq.begin(label)
    setRepairsLoaded(false); setRepairErr(null)
    const { data, error } = await settleWithin(scopedFrom('assets_repair_expenses').eq('fiscal_year', label).order('expense_date').order('id'), ASSET_CALL_MS, 'Reading the repair expenses')
    if (!repairReq.isCurrent(label)) return
    inputsChanged()
    // A failed read is not "no repairs this year": the Section 16 cap below is measured against
    // this list, so an empty one on error understates the year's repair spend (S683). And it is not
    // last year's list either (COSTS-7): cleared, and Preview refuses until it loads.
    if (error) { setRepairExpenses([]); setRepairErr(asActionError(error, 'operator')); return }
    setRepairExpenses(data || [])
    setRepairsLoaded(true)
  }

  // ASSETS-9: every posted run and line, the typed openings and their corrections, worked out into
  // the years to post again. A few rows per year, so plain reads. The newest call wins.
  async function loadRepost() {
    const seq = ++repostSeq.current
    const results = await Promise.all([
      settleWithin(scopedFrom('assets_tax_pool_runs', 'id, fiscal_year, created_at, posted_at').eq('status', 'posted').order('created_at').order('id'), ASSET_CALL_MS, 'Reading the posted tax schedules'),
      settleWithin(scopedFrom('assets_tax_pool_lines', 'id, run_id, pool, opening_wdv, repair_carried_in, closing_wdv, repair_expense_capitalized').order('id'), ASSET_CALL_MS, 'Reading the posted pool lines'),
      settleWithin(scopedFrom('assets_tax_pool_openings', 'pool, fiscal_year, opening_wdv, repair_carry_forward').order('pool').order('id'), ASSET_CALL_MS, 'Reading the typed opening values'),
      settleWithin(scopedFrom('assets_tax_pool_opening_corrections', 'id, pool, fiscal_year, old_opening_wdv, old_repair_carry_forward, new_opening_wdv, new_repair_carry_forward, reason, corrected_by, corrected_at').order('corrected_at').order('id'), ASSET_CALL_MS, 'Reading the opening corrections'),
    ])
    if (seq !== repostSeq.current) return
    const failed = results.find(r => r.error)
    if (failed) { setRepost({ list: [], names: {}, error: asActionError(failed.error, 'operator') }); return }
    const [runsRes, linesRes, openingsRes, corrRes] = results
    const list = schedulesToPostAgain({ runs: runsRes.data, lines: linesRes.data, openings: openingsRes.data, corrections: corrRes.data })
    const ids = list.flatMap(x => (x.why.kind === 'correction' ? x.why.corrections.map(c => c.corrected_by) : []))
    // A failed names read never hides the list: an unnamed login is worded as such.
    const { map } = ids.length ? await loadProfileNames(supabase, clientId, ids) : { map: {} }
    if (seq !== repostSeq.current) return
    setRepost({ list, names: map, error: null })
  }

  const repairTotalsByPool = useMemo(() => {
    const totals = {}
    repairExpenses.forEach(e => { totals[e.pool] = (totals[e.pool] || 0) + parseFloat(e.amount) })
    return totals
  }, [repairExpenses])

  async function addExpense() {
    setErr(null)
    if (!newExpense.expense_date || !(parseFloat(newExpense.amount) > 0)) {
      setErr('A repair expense needs a date and an amount above zero.')
      return
    }
    // The row is stamped with the SELECTED fiscal year, and the Section 16 cap is measured per
    // year off that stamp — so a repair dated in another year would count against this one's cap
    // and never against its own (S756). Compared as bare date strings, both built by formatAd,
    // so no timezone can move either end.
    const { start: fyStartAd, end: fyEndAd } = getFiscalYearAdRange(fyStart)
    const fyFrom = formatAd(fyStartAd), fyTo = formatAd(fyEndAd)
    if (newExpense.expense_date < fyFrom || newExpense.expense_date > fyTo) {
      // S858: the year's ends are named in BS, the calendar the date was picked in; they were the
      // raw AD strings the comparison uses.
      setErr(`That date is outside FY ${fyLabel} (${formatAdAsBs(fyFrom)} to ${formatAdAsBs(fyTo)}), so it was not added. Pick a date inside the year, or switch the Fiscal Year above to the year the repair belongs to.`)
      return
    }
    // The list is about to change, so a preview on screen no longer matches it (COSTS-7): the one
    // shown before this repair was added would lock a cap that leaves it out.
    inputsChanged()
    const { error } = await scopedInsert('assets_repair_expenses', {
      pool: newExpense.pool, fiscal_year: fyLabel, expense_date: newExpense.expense_date,
      amount: parseFloat(newExpense.amount), description: newExpense.description.trim() || null,
    })
    if (error) {
      const { text, detail } = asActionError(error)
      setErr({ text: `The repair expense was not added, so it is not counting toward this year's Section 16 cap. ${text}`, detail })
      return
    }
    setNewExpense({ pool: 'A', expense_date: '', amount: '', description: '' })
    reloadRepairsFor(fyLabel)
  }

  async function deleteExpense(id) {
    setErr(null)
    inputsChanged()
    const { error } = await scopedDelete('assets_repair_expenses').eq('id', id)
    if (error) { const a = asActionError(error); setErr({ text: 'The repair expense was not deleted — it is still on the list. ' + a.text, detail: a.detail }) }
    reloadRepairsFor(fyLabel)
  }

  // After a write: re-read the year it was made in, unless the year has changed meanwhile — a
  // reload claiming the old year would put its list back under the new one (COSTS-7).
  function reloadRepairsFor(label) {
    if (repairReq.isCurrent(label)) loadRepairExpenses(label)
  }

  async function preview() {
    // COSTS-7: never from a repair list that did not load for this year.
    if (!repairsLoaded) {
      setErr(repairErr
        ? `The repair expenses for FY ${fyLabel} could not be read, so no preview was computed — the Section 16 cap is measured against them. Press Try again under Repair & Maintenance Expenses, then preview.`
        : `The repair expenses for FY ${fyLabel} are still loading. Preview again in a moment.`)
      return
    }
    const version = inputsVersion.current
    const stale = () => {
      if (inputsVersion.current === version) return false
      setErr('The fiscal year or its repair expenses changed while the preview was being worked out, so it was not shown. Press Preview again.')
      setLoading(false)
      return true
    }
    setLoading(true); setMsg(''); setErr(null); setRecheck(null)
    const priorFyLabel = getBsFiscalYear(fyStart - 1, 4)
    // Every posted year, not only the prior one (S792, COSTS-5): one row per posted schedule, so a
    // handful. Knowing whether an EARLIER year was posted is what tells a skipped year — every
    // pool silently opening at 0 — from a business's first year. Read with the typed openings
    // (D40, at most four rows), which the pools open from when the year before has no run. And the
    // register as it is NOW (S849, ASSETS-12): the list loaded when the page opened can be hours
    // old, missing an asset added or sold in another tab since.
    const [runsRes, openingsRes, registerRes] = await Promise.all([
      settleWithin(scopedFrom('assets_tax_pool_runs', 'id, fiscal_year, created_at')
        .eq('status', 'posted').order('created_at', { ascending: false }).order('id'), ASSET_CALL_MS, 'Reading the posted tax schedules'),
      settleWithin(scopedFrom('assets_tax_pool_openings', 'pool, fiscal_year, opening_wdv, repair_carry_forward').order('pool').order('id'), ASSET_CALL_MS, 'Reading the typed opening values'),
      settleWithin(readRegister(scopedFrom), ASSET_CALL_MS, 'Reading the asset register'),
    ])
    if (stale()) return
    // A failed read used to compute every pool's opening WDV as 0 — a preview that read as a
    // first-ever run and could be POSTED as one (S682). Refuse to compute instead.
    const refuse = error => {
      const a = asActionError(error)
      setErr({ text: `Could not read the ${priorFyLabel} tax-pool run, so no preview was computed — every opening WDV would have been wrong. Try again. ` + a.text, detail: a.detail })
      setLoading(false)
    }
    if (runsRes.error) { refuse(runsRes.error); return }
    // A failed read of the typed openings is not "none typed": the pools would open at 0 over values
    // the client entered (D40).
    if (openingsRes.error) {
      const a = asActionError(openingsRes.error)
      setErr({ text: 'Could not read the opening values typed in from last year\'s tax return, so no preview was computed — the pools would have opened at 0. Try again. ' + a.text, detail: a.detail })
      setLoading(false)
      return
    }
    if (registerRes.error) {
      const a = asActionError(registerRes.error)
      setErr({ text: 'Could not read the asset register, so no preview was computed — this year\'s additions and disposals come from it. Try again. ' + a.text, detail: a.detail })
      setLoading(false)
      return
    }
    const openingRows = openingsRes.data || []
    const { priorRun, earlierLabel, typedOpenings } = priorPoolRun({ runs: runsRes.data, fiscalYearStartBs: fyStart, openings: openingRows })
    const priorLinesByPool = {}
    if (priorRun) {
      const { data: priorLines, error: priorLinesErr } = await settleWithin(scopedFrom('assets_tax_pool_lines').eq('run_id', priorRun.id).order('id'), ASSET_CALL_MS, "Reading last year's schedule")
      if (stale()) return
      if (priorLinesErr) { refuse(priorLinesErr); return }
      ;(priorLines || []).forEach(l => { priorLinesByPool[l.pool] = l })
    }

    const { start, end } = getFiscalYearAdRange(fyStart)
    setClosedPools({})
    setPreviewInputs({
      assets: registerRes.data || [], fyStart, fyStartAd: formatAd(start), fyEndAd: formatAd(end),
      priorLinesByPool, typedOpenings, openings: openingRows, repairTotalsByPool,
      // Not inputs to the lines; what the notes over the table say.
      priorRun, earlierLabel, priorLabel: priorFyLabel,
    })
    setLoading(false)
  }

  // Ask each question in turn; the last "yes" goes on to `then`. Each run asks the next one, and
  // useConfirm clears only the dialog that just ran, so the follow-up survives.
  function askInTurn(questions, then) {
    if (questions.length === 0) return then()
    const [q, ...rest] = questions
    askConfirm({ danger: true, ...q, run: () => askInTurn(rest, then) })
  }

  // S792 (COSTS-5): a skipped year locks every pool at an opening of 0, and the posted schedule
  // then carries that into every year after it. A first year opens at 0 legitimately, so only the
  // skipped-year case is asked about; the banner over the table speaks for both. S849 asks three
  // more things first: a year that has not ended (ASSETS-11), assets in no pool (ASSETS-5), and an
  // earlier year whose posted schedule no longer matches its openings (ASSETS-9).
  async function post() {
    if (!lines || !built) return
    // S858: Post stays pressable for a login without the rank (aria-disabled, the S857 Depreciation
    // Runs pattern), so the press says why here instead of a disabled button saying nothing. The
    // post RPC refuses such a login as well; this is the sentence, not the lock.
    if (!canPost) {
      setMsg(''); setRecheck(null)
      setErr('Only a Manager or Owner login can post a tax pool schedule. Ask one of them to post it.')
      return
    }
    setMsg(''); setErr(null); setRecheck(null)
    // The inputs these lines were built from (COSTS-7). Checked again just before the write, since
    // the checks and confirms below leave time for a repair to be added or the year changed. The
    // payload is fixed here: what the confirms describe is what is sent.
    const version = inputsVersion.current
    const label = fyLabel
    const payload = postedLinePayload(lines)
    const listed = repost.list.find(x => x.fiscalYear === label)
    const postNotes = listed ? `Posted again: ${repostReason(listed, repost.names)}` : null
    const questions = []

    if (openingGap?.earlierLabel) {
      questions.push({
        title: `FY ${openingGap.priorLabel} has no posted schedule`,
        body: (
          <p style={{ margin: 0 }}>
            {poolsOpeningAtZero(openingGap.pools)} for FY {label}, because {openingGap.pools.length === 1 ? 'its opening value comes' : 'their opening values come'} from FY {openingGap.priorLabel}, which was never
            posted (FY {openingGap.earlierLabel} was). Posting locks these figures, and next year opens from them. To carry the real
            values forward, post FY {openingGap.priorLabel} first, then preview FY {label} again.
          </p>
        ),
        confirmLabel: openingGap.pools.length === POOLS_AD.length ? 'Post with every pool at 0' : 'Post with those pools at 0',
      })
    }
    if (fyStart >= currentFyStart) {
      questions.push({
        title: `FY ${label} has not ended`,
        body: (
          <p style={{ margin: 0 }}>
            FY {label} has not ended (it runs to {daysInBsMonth(fyStart + 1, 3)} Ashadh {fyStart + 1}). A schedule posted now leaves out
            anything bought, sold or repaired after today, and locks the opening values typed for this year. Post it anyway?
          </p>
        ),
        confirmLabel: 'Post anyway',
      })
    }
    if (built.untracked.length > 0) {
      const count = built.untracked.length
      const cost = built.untracked.reduce((s, a) => s + a.total_cost, 0)
      questions.push({
        title: `${count} ${count === 1 ? 'asset has' : 'assets have'} no tax pool`,
        body: (
          <p style={{ margin: 0 }}>
            {count === 1 ? 'One asset' : `${count} assets`} held during FY {label} (NPR {fmt(cost)} at cost) {count === 1 ? 'is' : 'are'} in no tax pool, so this
            schedule leaves {count === 1 ? 'it' : 'them'} out and locks without {count === 1 ? 'it' : 'them'}. To include {count === 1 ? 'it' : 'them'}, give each a pool on the Register
            (Edit → Tax Pool) and preview again.
          </p>
        ),
        confirmLabel: 'Post without them',
      })
    }
    const earlier = repost.list.filter(x => x.fyShort < fyStart % 100)
    if (earlier.length > 0) {
      const names = earlier.map(x => x.fiscalYear)
      questions.push({
        title: `FY ${names[0]} needs posting again first`,
        body: (
          <p style={{ margin: 0 }}>
            FY {joinAnd(names)}{earlier.length === 1 ? "'s posted schedule no longer matches its" : "'s posted schedules no longer match their"} opening values,
            so FY {label} would open from out-of-date figures. Post FY {names[0]} again first.
          </p>
        ),
        confirmLabel: 'Post anyway',
      })
    } else if (repost.error) {
      // A check that could not run has not passed.
      questions.push({
        title: 'Earlier years could not be checked',
        body: (
          <p style={{ margin: 0 }}>
            Crest could not check whether an earlier year's posted schedule still matches its opening values, so FY {label} might
            open from out-of-date figures. Reload the page to check first, or post anyway.
          </p>
        ),
        confirmLabel: 'Post anyway',
      })
    }
    askInTurn(questions, () => checkAndPost(version, label, payload, postNotes))
  }

  // A fiscal year can be posted twice — there is deliberately no unique constraint, since a
  // correction is a new run — and the next year's opening WDV then reads whichever posted last.
  // Look first, and make a second schedule for the same year a decision naming the first (S756).
  async function checkAndPost(version, label, payload, postNotes) {
    setPosting(true)
    const { data: existing, error: existingErr } = await settleWithin(scopedFrom('assets_tax_pool_runs', 'id, posted_at, created_at')
      .eq('fiscal_year', label).eq('status', 'posted').order('created_at').order('id'), ASSET_CALL_MS, 'Checking for a posted schedule')
    setPosting(false)
    if (existingErr) {
      // A check that could not run has not passed.
      const a = asActionError(existingErr)
      setErr({ text: `Could not check whether FY ${label} already has a posted schedule, so nothing was posted. Try again. ` + a.text, detail: a.detail })
      return
    }
    if (!existing || existing.length === 0) { await submitPost(version, label, payload, postNotes); return }
    askConfirm({
      title: `FY ${label} already has a posted schedule`,
      danger: true,
      body: (
        <p style={{ margin: 0 }}>
          A tax pool schedule for FY {label} was posted on {existing.map(r => nepalBsLong(r.posted_at || r.created_at) || 'an unknown date').join(', ')}.
          {' '}Posting again adds a second locked schedule for the same year beside it; next year's opening values will be taken from this new one. Neither can be edited afterwards.
        </p>
      ),
      confirmLabel: 'Post a second schedule',
      run: () => submitPost(version, label, payload, postNotes),
    })
  }

  async function submitPost(version, label, payload, postNotes) {
    if (inputsVersion.current !== version) {
      setErr('The fiscal year or its repair expenses changed after this preview was made, so nothing was posted. Press Preview again, then Post.')
      return
    }
    setPosting(true); setMsg(''); setErr(null)
    const { error } = await settleWithin(supabase.rpc('post_tax_pool_run', {
      p_client_id: clientId, p_fiscal_year: label, p_lines: payload, p_notes: postNotes,
    }), ASSET_CALL_MS, 'Posting the tax pool schedule')
    setPosting(false)
    if (error) {
      const { text, detail } = asActionError(error)
      // ASSETS-17: no answer is not a refusal. The server may have posted it after the connection
      // dropped, so say so and show what is posted now, instead of "nothing was written".
      if (answerLost(error)) {
        setErr({ text: 'The connection dropped before the server answered, so this schedule may have been posted. The posted schedules for this year were re-read below: check them before posting again.', detail })
        recheckPosted(label); loadRepost(); setCardRefresh(c => c + 1)
        return
      }
      if (refusedWith(error, 'tax_run_duplicate')) {
        setErr({ text: `This schedule for FY ${label} was posted moments ago (from this page or another), so it was not posted again.`, detail })
        recheckPosted(label); loadRepost(); setCardRefresh(c => c + 1)
        return
      }
      // Any other refusal is raised inside the one transaction that would write the schedule.
      setErr({ text: `The pool schedule was not posted, so nothing was written for FY ${label}.

${text}`, detail })
      return
    }
    setMsg('ok:Posted — tax pool schedule locked for FY ' + label)
    setPreviewInputs(null)
    loadRepost(); setCardRefresh(c => c + 1)
  }

  async function recheckPosted(label) {
    const { data, error } = await settleWithin(scopedFrom('assets_tax_pool_runs', 'id, posted_at, created_at')
      .eq('fiscal_year', label).eq('status', 'posted').order('created_at').order('id'), ASSET_CALL_MS, 'Re-reading the posted schedules')
    setRecheck({ label, runs: data || [], error: error ? asActionError(error, 'operator') : null })
  }

  const yearOptions = fyOptionsAround(currentFyStart, fyStart)

  return (
    <div>
      <div style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 12, fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        △ {DISCLAIMER_TEXT}
      </div>

      <p className="no-print" style={{ fontSize: 12, color: 'var(--theme-text2)', lineHeight: 1.6, marginBottom: 20, maxWidth: 760 }}>
        {/* S857: the book-versus-tax sentence moved to the line under the tab row (FixedAssets.js),
            which says it for both tabs; this keeps only what is particular to the tax tab. */}
        This tab is for your <strong style={{ color: 'var(--theme-text1)' }}>annual tax filing</strong>: hand it to your
        accountant, or use it yourself if you file directly. Nepal tax rules do not depreciate each item on its own; every
        asset is grouped into one of five government-defined "pools" (hover a Pool name below for what belongs in it).
      </p>

      <div className="card no-print" style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="form-field">
            <label htmlFor="taxpoo-f1"><Tip text="Nepal's tax year runs mid-July to mid-July (Shrawan to Ashadh) — it doesn't line up with the Jan-Dec calendar year most people think in." width={280}>Fiscal Year</Tip></label>
            <select id="taxpoo-f1" className="form-select" value={fyStart} onChange={e => changeYear(parseInt(e.target.value))}>
              {yearOptions.map(y => <option key={y} value={y}>FY {getBsFiscalYear(y, 4)}</option>)}
            </select>
          </div>
          {/* Pressable while the repair list is not loaded, so the press can say why (COSTS-7). */}
          <button className="btn btn-primary" onClick={preview} disabled={loading} aria-disabled={!repairsLoaded || undefined}>{loading ? 'Computing…' : 'Preview'}</button>
          {lines && (
            // S858: aria-disabled, not disabled, when the login cannot post: a disabled button takes
            // no focus, so this Tip (the one place saying why) was out of reach and the press did
            // nothing. `disabled` is only for a post in flight; post() says what is missing.
            <Tip text={canPost ? "Writes this year's pool schedule and locks it. To correct it, fix the register or repairs and post a second schedule for the same year; next year opens from the latest one." : 'Only a Manager or Owner login can post.'} width={300}>
              <button className="btn btn-primary" onClick={post} disabled={posting} aria-disabled={!canPost ? 'true' : undefined}>{posting ? 'Posting…' : 'Post'}</button>
            </Tip>
          )}
          {lines && (
            // The printed heading names the business, so Print waits for its name (S845).
            <button className="btn btn-ghost" disabled={!biz.ready} onClick={() => printWithTitle(`Tax Depreciation Schedule - FY ${fyLabel}`)}>Print</button>
          )}
          {msg && <span style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>{msg.split(':').slice(1).join(':')}</span>}
        </div>
        {lines && biz.error && (
          <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>The business name for the printed heading could not be read, so Print is held. Reload the page to try again.</p>
        )}
        <ActionError error={err} />
        {recheck && (
          <p role="status" className="note-banner" style={{ margin: '10px 0 0' }}>
            {recheck.error
              ? <>The posted schedules for FY {recheck.label} could not be re-read either, so whether it was posted is not known. Reload the page before posting again. ({recheck.error.text})</>
              : recheck.runs.length === 0
                ? <><strong>None is posted for FY {recheck.label}</strong> as of this re-read.</>
                : <><strong>Posted for FY {recheck.label}</strong> as of this re-read: {recheck.runs.map(r => `${nepalBsLong(r.posted_at || r.created_at) || 'unknown date'}, ${nepalTime(r.posted_at || r.created_at)}`).join('; ')}.</>}
          </p>
        )}
      </div>

      {/* S849 (ASSETS-9): the posted years whose opening values have moved since they were posted. */}
      {(repost.list.length > 0 || repost.error) && (
        <div className="card no-print" style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
            <Tip text="A posted schedule stays as filed. It is listed here when an opening value it used was corrected, or the year before it was posted again, until you post it again." width={320}>Schedules to post again</Tip>
          </h3>
          {repost.error ? (
            <div>
              <ActionError error={{ text: `Could not check whether any posted schedule needs posting again. ${repost.error.text}`, detail: repost.error.detail }} />
              <button className="btn btn-ghost" style={{ marginTop: 8, fontSize: 12 }} onClick={loadRepost}>Try again</button>
            </div>
          ) : (
            <>
              <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 10px', lineHeight: 1.5, maxWidth: 760 }}>
                Post each one again, oldest first: the new schedule is the one the next year opens from. If a tax return was already
                filed from the old figures, ask your accountant whether to amend it.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6 }}>
                {repost.list.map(x => (
                  <li key={x.fiscalYear} style={{ marginBottom: 6 }}>
                    <strong>FY {x.fiscalYear}</strong> — {repostReason(x, repost.names)}{' '}
                    {fyLabel === x.fiscalYear
                      ? <span style={{ color: 'var(--theme-text2)' }}>(on screen now)</span>
                      : <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => changeYear(fyStartOfLabel(x.fiscalYear))}>Open FY {x.fiscalYear}</button>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* D40: last year's closing values, typed once; locked once a posted schedule uses them, and
          correctable after that with a reason (S849, SU7 b). */}
      <TaxPoolOpeningsCard
        fyLabel={fyLabel}
        priorLabel={getBsFiscalYear(fyStart - 1, 4)}
        canEdit={canPost}
        onChanged={inputsChanged}
        onCorrected={loadRepost}
        refreshKey={cardRefresh}
      />

      {/* Repair/maintenance expense ledger — feeds the Section 16 cap check */}
      <div className="card no-print" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 13, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
          <Tip text="Fixing or looking after something you already own, such as servicing an oven or repainting. A brand new item is not a repair: add it as a new asset on the Register tab." width={300}>Repair &amp; Maintenance Expenses</Tip> — FY {fyLabel}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 12px', lineHeight: 1.5 }}>
          Nepal tax law only lets you deduct repair costs up to 7% of a pool's depreciation base for the year — spend more than
          that on repairs for one pool, and the extra joins next year's pool instead of counting this year.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 4 }}>
          <div className="form-field" style={{ gap: 4 }}>
            <label style={{ fontSize: 11 }} htmlFor="taxpoo-f2">Which pool was this equipment in?</label>
            <select id="taxpoo-f2" className="form-select" value={newExpense.pool} onChange={e => setNewExpense(f => ({ ...f, pool: e.target.value }))}>
              {POOLS_AD.map(p => <option key={p} value={p}>{POOL_LABELS[p]}</option>)}
            </select>
          </div>
          {/* BS picker (S858): the stored AD string, as formatAd(bsToAd(...)) hands it back, so the
              in-year check in addExpense compares the same strings it always did. The wrapper holds
              the width a picked date needs, so the row does not jump when one is chosen. */}
          <div style={{ minWidth: 170 }}>
            <BsCalendarPicker ariaLabel="Repair expense date" value={newExpense.expense_date} placeholder="Pick a BS date"
              onChange={v => setNewExpense(f => ({ ...f, expense_date: v }))} />
          </div>
          <input type="number" className="form-input" placeholder="Amount" aria-label="Repair expense amount (NPR)" value={newExpense.amount} onChange={e => setNewExpense(f => ({ ...f, amount: e.target.value }))} style={{ width: 120 }} />
          <input className="form-input" placeholder="Description" aria-label="Repair expense description" value={newExpense.description} onChange={e => setNewExpense(f => ({ ...f, description: e.target.value }))} style={{ flex: 1, minWidth: 160 }} />
          <button className="btn btn-ghost" onClick={addExpense}>+ Add</button>
        </div>
        <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '0 0 12px', fontStyle: 'italic' }}>
          e.g. {POOL_EXAMPLES[newExpense.pool]}
        </p>
        {/* COSTS-7: a failed read shows no list at all — never last year's — and says what it blocks. */}
        {repairErr && (
          <div style={{ marginBottom: 12 }}>
            <ActionError error={{ text: `The repair expenses for FY ${fyLabel} could not be read, so none are listed and Preview is held until they are. ${repairErr.text}`, detail: repairErr.detail }} />
            <button className="btn btn-ghost" style={{ marginTop: 8, fontSize: 12 }} onClick={() => loadRepairExpenses(fyLabel)}>Try again</button>
          </div>
        )}
        {repairExpenses.length > 0 && (
          <div className="table-wrap">
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead><tr><th>Pool</th><th>Date</th><th style={{ textAlign: 'right' }}>Amount</th><th>Description</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {repairExpenses.map(e => (
                  <tr key={e.id}>
                    <td>{e.pool}</td><td style={{ whiteSpace: 'nowrap' }}>{formatAdAsBs(e.expense_date)}</td>
                    <td style={{ textAlign: 'right' }}>{fmt(e.amount)}</td>
                    <td>{e.description || '—'}</td>
                    <td><button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => deleteExpense(e.id)}>Delete</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {lines && (
        <div id="tax-pool-print-area">
          {/* ASSETS-10: paper names the year and the business. */}
          <h2 className="print-only" style={{ fontSize: 16, margin: '0 0 12px', color: 'var(--theme-text1)' }}>
            Tax Depreciation Schedule — FY {fyLabel}{biz.name ? ` — ${biz.name}` : ''}
          </h2>
          {/* S792 (COSTS-5): inside the print area, so a printed schedule carries it too. */}
          {openingGap && (
            <div role="status" style={amberBox}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>△ {poolsOpeningAtZero(openingGap.pools)}.</strong>{' '}
              {openingGap.earlierLabel
                ? <>FY {openingGap.priorLabel} has no posted schedule, so FY {fyLabel} has no closing values to open from — FY {openingGap.earlierLabel} was posted, but its values only reach this year through FY {openingGap.priorLabel}. Switch the Fiscal Year above to {openingGap.priorLabel}, post it, then preview FY {fyLabel} again.</>
                : <>No tax pool schedule is posted for FY {openingGap.priorLabel}, the year before. That is right only if the business owned none of these assets before FY {fyLabel}; if it did, type last year's closing values under Opening values (from last year's tax return) above, then preview again.</>}
            </div>
          )}
          {openingTyped && (
            <p role="status" style={{ margin: '0 0 12px', fontSize: 12, lineHeight: 1.55, color: 'var(--theme-text2)' }}>
              FY {openingTyped.priorLabel} has no posted schedule here, so
              {openingTyped.pools.length > 0 && <> {openingTyped.pools.length === 1 ? 'Pool' : 'Pools'} {openingTyped.pools.join(', ')} {openingTyped.pools.length === 1 ? 'opens' : 'open'} from the values typed in from last year's tax return{openingTyped.eOpening > 0.005 ? ', and' : '.'}</>}
              {openingTyped.eOpening > 0.005 && <> Pool E opens at NPR {fmt(openingTyped.eOpening)}: what its assets' own schedules had not yet claimed, counting any depreciation already taken before Crest.</>}
            </p>
          )}
          {/* S849 (ASSETS-2): an emptied pool whose value goes back to a typed figure is closed only
              when the business says every asset of it went; the default is no. */}
          {built.askDissolve.map(p => (
            <div key={p} className="note-banner no-print" style={{ marginBottom: 12 }}>
              <p style={{ margin: '0 0 6px' }}>
                <strong>Pool {p} has no asset left in the register at the end of FY {fyLabel}</strong>, but its value goes back to a figure
                typed from your tax return, which may include assets bought before Crest. Did the business sell or scrap every Pool {p} asset this year?
              </p>
              <label className="form-check">
                <input type="checkbox" checked={!!closedPools[p]} onChange={e => setClosedPools(c => ({ ...c, [p]: e.target.checked }))} />
                <span>Yes — every Pool {p} asset was sold or scrapped this year: close the pool and deduct what is left.</span>
              </label>
            </div>
          ))}
          <div className="table-wrap no-print">
            <PoolTable lines={lines} />
          </div>
          <div className="print-only">
            <PoolTable lines={lines} print />
          </div>
          {lines.filter(l => n(l.balancing_income) > 0.005).map(l => (
            <p key={`inc-${l.pool}`} style={fine}>
              <strong style={{ color: 'var(--theme-text1)' }}>Pool {l.pool}:</strong> the NPR {fmt(l.disposal_proceeds)} received is NPR {fmt(l.balancing_income)} more
              than the pool was worth. Include NPR {fmt(l.balancing_income)} in business income for FY {fyLabel} (Income Tax Act Schedule 2 §4(1));
              {n(l.closing_wdv) > 0.005
                ? <> the pool closes at NPR {fmt(l.closing_wdv)}, the part of this year's additions that counts from next year.</>
                : <> the pool closes at 0.</>}
            </p>
          ))}
          {lines.filter(l => n(l.terminal_deduction) > 0.005).map(l => (
            <p key={`ter-${l.pool}`} style={fine}>
              <strong style={{ color: 'var(--theme-text1)' }}>Pool {l.pool} closed:</strong> every asset in it was sold or scrapped. The NPR {fmt(l.terminal_deduction)} left
              is deductible in FY {fyLabel} (Schedule 2 §4(2)) instead of being depreciated in later years.
            </p>
          ))}
          {lines.filter(l => n(l.small_balance_written_off) > 0.005).map(l => (
            <p key={`small-${l.pool}`} style={fine}>
              <strong style={{ color: 'var(--theme-text1)' }}>Pool {l.pool}:</strong> the NPR {fmt(l.small_balance_written_off)} left after this year's depreciation
              is under NPR 2,000, so it is written off in full this year (Schedule 2 §2(6)).
            </p>
          ))}
          {built.askDissolve.filter(p => !closedPools[p]).map(p => (
            <p key={`open-${p}`} className="print-only" style={fine}>
              Pool {p}: no asset of this pool is left in Crest's register at the end of FY {fyLabel}, but its value goes back to a figure
              typed from the tax return, so it is kept open (not dissolved).
            </p>
          ))}
          {poolECapped && (
            <p style={fine}>
              Pool E: its assets' own schedules add up to NPR {fmt(poolECapped.scheduled)} this year, but the pool only
              holds NPR {fmt(poolECapped.held)}, so only that much is claimed.
            </p>
          )}
          {/* S792 stage 3: Pool E's Disposals figure is money received, but what leaves that pool is
              the value not yet claimed — say so, or its row cannot be added up. */}
          {poolEDisposed && (
            <p style={fine}>
              Pool E: software or licences sold or written off this year leave the pool at the value not yet
              claimed on them (NPR {fmt(poolEDisposed.value)}) and are not amortized this year. The NPR {fmt(poolEDisposed.proceeds)} received
              for them is shown under Disposals but not taken off the pool, because each Pool E item is claimed on its own schedule;
              ask your accountant how to treat the gain or loss.
            </p>
          )}
          {/* S849 (ASSETS-5): an asset with no pool used to drop out of the schedule without a word. */}
          {built.untracked.length > 0 && (
            <div style={{ ...amberBox, marginTop: 12 }}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>△ Not in any tax pool, so left out of this schedule:</strong>{' '}
              {built.untracked.map(a => `${a.asset_code || '—'} ${a.name} NPR ${fmt(a.total_cost)}`).join('; ')}.
              <span className="no-print"> Give each a pool on the Register (Edit → Tax Pool), then preview again.</span>
            </div>
          )}
          <div className="print-only" style={{ marginTop: 32, fontSize: 10, color: '#aaa', borderTop: '1px solid #eee', paddingTop: 12, textAlign: 'center' }}>
            {DISCLAIMER_TEXT} · Generated by Crest Suite · {nepalBsLong(new Date())}
          </div>
        </div>
      )}
      {confirmEl}
    </div>
  )
}
