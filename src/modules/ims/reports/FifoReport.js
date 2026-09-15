import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import { npr, nprInt } from '../../../shared/nepalMoney'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { loadDeltaExplosion } from '../../../utils/orderLineIngredients'
import { selectDepletingSalesAcrossPeriods } from '../sales/salesDepletion'
import {
  daysUntilExpiry, asOfForWindow, splitReturns,
  anchorToCounts, rollingWindow, sumConsumptionByPeriod, countsFromClosedPeriods, periodMonthIndex,
} from './stockAgeingCalc'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import {
  BS_MONTHS, bsToAd, daysInBsMonth, formatBsDay,
} from '../../../utils/bsCalendar'

const bsLabel = bs => (bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : '—')
const monthLabel = p => (p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : '—')

// Shared word-for-word with Stock Ageing (S756, D19): on screen, in print and in the workbook.
const BASIS = 'Quantities follow your stock counts; ages are estimated from purchase dates, oldest used first.'
const WINDOW_MONTHS = 12

// The date every batch's expiry is measured AGAINST.
//
// WHY (S717): this was `new Date()` unconditionally, while the period selector accepted any past
// month — the exact defect S594 found and fixed on Stock Ageing, still live on its sibling.
// Opening a period closed three months ago aged every surviving batch to TODAY, so a whole month
// of stock read "expired 90d ago", Value at Risk turned red and reported nearly all of it, and
// every row highlighted. It failed silently and in the alarming direction. An expiry report with
// no as-of date is not a document anyone can act on, and this one stated it nowhere — not in the
// subtitle, not in a print header, not in the workbook.
//
// S756 moved the rule into `asOfForWindow` (stockAgeingCalc.js, tested), shared with Stock Ageing:
// the NEWEST period measures to today in Nepal, not only the current BS month. The default view is
// the latest period, which early in a month is last month — and measuring that to its own month
// end reported a batch that expired three days ago as "Expiring in 4d" under Expired 0 ✓.

export default function FifoReport() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { settings } = useSettings()
  const { scopedFrom } = useScopedDb()
  const biz = useBizInfo()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [rows, setRows] = useState([])
  const [asOf, setAsOf] = useState(null)
  const [windowLabel, setWindowLabel] = useState('')
  // The latest closed month whose count the quantities follow, and how many batch-holding items no
  // count reached (S756, D19) — so the basis line is a checkable claim.
  const [latestCount, setLatestCount] = useState(null)
  const [uncountedItems, setUncountedItems] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [filterFlag, setFilterFlag] = useState('all')
  const [filterCat, setFilterCat] = useState('all')
  const [categories, setCategories] = useState([])

  const warningDays = settings?.expiry_warning_days || 7

  // authLoading is a real dependency: a hard load can land here while auth is still resolving, and
  // with [clientId] alone the guard fails once and nothing re-fires (S594).
  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId, authLoading]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const initResults = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('categories').order('sort_order')
    ])
    // A failed read must never render as NoPeriodState or an empty report (S612 silent-zero rule).
    const initFailed = firstError(initResults)
    if (initFailed) { setLoadError(initFailed); setLoading(false); return }
    const [{ data: p }, { data: c }] = initResults
    setPeriods(p || [])
    setCategories(c || [])
    // Fall back to the latest period when none is open — between closing one month and opening the
    // next this page loaded nothing at all and showed its "add expiry dates" empty state instead.
    const initial = (p || []).find(x => x.status === 'open') || (p || [])[0]
    if (initial) {
      periodReq.begin(initial.id)   // claim the page, as the S695 rule says init() should
      setSelectedPeriod(initial)
      await buildReport(initial.id, p || [])
    }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await buildReport(periodId, periods)
    setLoading(false)
  }

  async function buildReport(periodId, allPeriods) {
    setLoadError(null)

    // THE WINDOW (S717). This used to read ONE period's purchases and net that period's WHOLE
    // consumption off them — two compounding errors on a report whose entire job is finding stock
    // that is about to go off:
    //
    //   • A batch bought last month and expiring next week was invisible. Opened on day 3 of an
    //     open period it showed three days of purchases under a confident "Items Tracked". The
    //     long-dated stock this report exists for — tinned, frozen, bottled — is exactly what a
    //     one-month window cannot see.
    //   • The month's whole consumption was eaten off that month's few batches, including the part
    //     of it that actually came off stock carried in from before. The new batches were
    //     over-consumed and expiry exposure was understated, in entirely believable rows.
    //
    // The window is the 12 months UP TO AND INCLUDING the selected one (S756, D19) — it was the
    // fiscal year to date, which reset on Shrawan 1, so long-dated stock bought in Ashadh vanished
    // from the expiry check the day the new year began. Stock carried into it is one undated batch
    // consumed first (below). Selecting a period means "as at the end of that month".
    const selected = (allPeriods || []).find(p => p.id === periodId)
    if (!selected) { setRows([]); setAsOf(null); return }
    const inWindow = rollingWindow(allPeriods, selected, WINDOW_MONTHS)
    const periodIds = inWindow.map(p => p.id)
    if (periodIds.length === 0) { setRows([]); setAsOf(null); return }
    const closedIds = inWindow.filter(p => p.status === 'closed').map(p => p.id)

    const results = await Promise.all([
      // EVERY purchase in the window, not only the ones carrying an expiry date. A batch with no
      // expiry date is still stock on the shelf and still absorbs its share of consumption —
      // reading only the dated ones made them swallow the undated ones' usage too, so an item
      // bought sometimes with and sometimes without a date under-reported its exposure. They are
      // allocated against, then filtered out of the table below.
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('id, period_id, item_id, qty, rate, bs_day, expiry_date, items(name, uom, categories(name))')
        .in('period_id', periodIds)
        .order('id')),
      // period_id: an off-batch return comes off in ITS month, before that month's count (S756).
      fetchAllRows(() => scopedFrom('vendor_returns', 'purchase_entry_id, item_id, qty, period_id')
        .in('period_id', periodIds).order('id')),
      // Paged (S528/S529): every read below spans up to twelve periods, so all of them are well
      // past PostgREST's silent 1000-row cap — and a truncated read here understates the
      // consumption netted off each batch, overstating expiry exposure with no error to catch.
      fetchAllRows(() => supabase.from('sales_entries')
        .select('period_id, recipe_id, qty_sold, bs_day, source, ingredient_deltas').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('wastages')
        .select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      fetchAllRows(() => supabase.from('staff_meals')
        .select('period_id, item_id, qty').in('period_id', periodIds).order('id')),
      // Only the FIRST period's opening count — that is the stock carried into the window.
      fetchAllRows(() => supabase.from('opening_stock')
        .select('item_id, qty').eq('period_id', periodIds[0]).order('id')),
      // The anchors (S756, D19): closing counts of the window's CLOSED months, paged and chunked.
      // A truncated read is indistinguishable from "not counted", so the estimate would silently
      // stand in for the count.
      fetchAllRowsChunked(closedIds, ids => supabase.from('closing_stock')
        .select('period_id, item_id, physical_qty').in('period_id', ids).order('id')),
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must never flow through the `|| []`s below into a confident report (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setRows([]); return }
    const [
      { data: purchases }, { data: returns }, { data: sales },
      { data: wastages }, { data: staffMeals }, { data: opening }, { data: closing },
    ] = results

    // Returns come off their own purchase line where that line is IN the window; an orphan return,
    // or one against a bill from before the window (S756 — it used to match no batch and vanish),
    // still left the building and is treated as consumption of that item IN ITS MONTH
    // (splitReturns, shared with Stock Ageing).
    const { byEntry: returnedByEntry, byPeriodItem: returnedByPeriodItem } =
      splitReturns(returns, new Set((purchases || []).map(p => p.id)))

    const periodById = Object.fromEntries(inWindow.map(p => [p.id, p]))
    const adDateOf = (pid, bsDay) => {
      const p = periodById[pid]
      if (!p) return null
      // bsToAd returns LOCAL midnight — used here only for ordering and day arithmetic, never
      // serialised (the S550 .toISOString() trap shifts the date by a day at Nepal's +05:45).
      return bsToAd(p.bs_year, p.bs_month, Math.min(Math.max(parseInt(bsDay, 10) || 1, 1), 32))
    }

    const windowStart = adDateOf(periodIds[0], 1)
    const batches = []
    // Stock carried into the window: one undated batch per item, consumed BEFORE anything bought
    // inside it. It has no expiry date so it is never shown — its whole job is absorbing the
    // consumption that genuinely came off it, which is what stops the window's dated batches being
    // eaten by usage that was never theirs.
    for (const o of opening || []) {
      const qty = parseFloat(o.qty) || 0
      if (qty <= 0) continue
      batches.push({ item_id: o.item_id, qty, rate: 0, date: windowStart, period_id: periodIds[0], carriedForward: true, entry: null })
    }
    for (const p of purchases || []) {
      const qty = Math.max(0, (parseFloat(p.qty) || 0) - (returnedByEntry[p.id] || 0))
      if (qty <= 0) continue
      const date = adDateOf(p.period_id, p.bs_day)
      if (!date) continue
      batches.push({
        item_id: p.item_id, qty, rate: parseFloat(p.rate) || 0, date, period_id: p.period_id,
        entry: p, returnedQty: returnedByEntry[p.id] || 0,
      })
    }

    // Consumption over the window: recipe-exploded sales + wastage + staff meals + orphan returns.
    //
    // Sales go through selectDepletingSales — this was the LAST page summing sales_entries raw
    // (S717). Without the shared rule a day sold in both POS and manual entry consumed its
    // ingredients twice, so batches were eaten that were still on the shelf and simply vanished
    // from an expiry report; and a credit note ('pos_credit', negative qty_sold) subtracted from
    // consumption, putting stock back and overstating what was at risk. Both directions were live,
    // and both produced rows that looked entirely ordinary.
    const depleting = selectDepletingSalesAcrossPeriods(sales || [])
    const soldRecipeIds = [...new Set(depleting.map(s => s.recipe_id).filter(Boolean))]
    // The recipe walk throws on a failed read (S695) — before, it walked an empty tree and every
    // consumption figure below silently came out as wastage + staff meals only.
    let breakdown = {}
    let explosion = null
    try {
      // S758: a customized plate's option stock lines ride on the sale row; their items/sub-recipes
      // are read alongside the recipe walk and fail the same way.
      const [b, e] = await Promise.all([
        soldRecipeIds.length > 0 ? explodeRecipeIngredients(supabase, soldRecipeIds) : {},
        loadDeltaExplosion(supabase, depleting.map(s => s.ingredient_deltas)),
      ])
      breakdown = b; explosion = e
    } catch (err) {
      // The isCurrent guard belongs on the failure path too: without it a superseded load's error
      // replaced the report the reader was actually looking at with a red banner (S717).
      if (!periodReq.isCurrent(periodId)) return
      setLoadError(err); setRows([]); return
    }
    if (!periodReq.isCurrent(periodId)) return   // superseded while the recipe walk was in flight

    // Consumption per MONTH, so each month's count settles what came before it (S756, D19).
    const consumedByPeriod = sumConsumptionByPeriod({
      sales: depleting, breakdown, explosion, wastages, staffMeals, returnsByPeriodItem: returnedByPeriodItem,
    })

    // ONE shared walk, not a second copy — Stock Ageing solves the same problem the same way and
    // `anchorToCounts` is where that arithmetic lives (stockAgeingCalc.js, tested). Quantities follow
    // each closed month's count: a lower count takes the missing stock off the OLDEST batches
    // (so a stolen or spilled case stops reading as still-to-expire), a higher count adds an
    // undated surplus with no expiry, which is never shown here.
    // `allPeriods` is newest-first (init's order), so [0] is the newest the client has.
    const ref = asOfForWindow(selected, { isNewest: allPeriods?.[0]?.id === selected.id })
    const { batches: allocated, lastCountByItem } = anchorToCounts({
      periods: inWindow.map(p => ({ id: p.id, endDate: bsToAd(p.bs_year, p.bs_month, daysInBsMonth(p.bs_year, p.bs_month)) })),
      batches,
      consumedByPeriod,
      countsByPeriod: countsFromClosedPeriods(closing, inWindow),
    })

    const reportRows = allocated
      .filter(b => b.entry && b.entry.expiry_date && b.remaining > 0.001)
      .map(b => {
        const p = b.entry
        const days = daysUntilExpiry(p.expiry_date, ref.date)
        let flag = 'ok'
        if (days === null) flag = 'ok'
        else if (days < 0) flag = 'expired'
        else if (days <= warningDays) flag = 'warning'
        const bp = periodById[p.period_id]
        return {
          id: p.id,
          itemName: p.items?.name,
          category: p.items?.categories?.name,
          uom: p.items?.uom,
          qty: b.remaining,
          originalQty: parseFloat(p.qty) || 0,
          returnedQty: b.returnedQty || 0,
          consumedQty: b.consumed,
          // The part of consumedQty a stock count took off (S756, D19) — stock that left without
          // being recorded as used.
          countedOffQty: b.countedOff || 0,
          countedIn: periodById[lastCountByItem[b.item_id]] || null,
          rate: parseFloat(p.rate) || 0,
          value: b.remaining * (parseFloat(p.rate) || 0),
          expiryDate: p.expiry_date,
          daysUntilExpiry: days,
          flag,
          boughtLabel: bp ? `${formatBsDay(p.bs_day, bp.bs_month)} ${bp.bs_year}` : '—',
        }
      })
      .sort((a, b) => (a.daysUntilExpiry ?? 1e9) - (b.daysUntilExpiry ?? 1e9))

    // Items still holding a batch that no count reached — they follow the estimate alone.
    const holding = new Set(allocated.filter(b => b.remaining > 0.001).map(b => b.item_id))
    const counted = Object.values(lastCountByItem).map(pid => periodById[pid]).filter(Boolean)

    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setAsOf(ref)
    setWindowLabel(inWindow.length === 1
      ? monthLabel(inWindow[0])
      : `${monthLabel(inWindow[0])} – ${monthLabel(selected)}`)
    setLatestCount(counted.reduce((a, p) => (!a || periodMonthIndex(p) > periodMonthIndex(a) ? p : a), null))
    setUncountedItems([...holding].filter(id => !lastCountByItem[id]).length)
    setRows(reportRows)
  }

  const filtered = rows.filter(r => {
    const matchFlag = filterFlag === 'all' || r.flag === filterFlag
    const matchCat  = filterCat === 'all' || r.category === filterCat
    return matchFlag && matchCat
  })

  // KPIs describe the WHOLE report, never the filtered view — the same decision Stock Ageing
  // records: a filtered count under an unfiltered figure reads as "NPR 800,000 across 5 items".
  // The filtered count is shown in the filter bar, where it belongs.
  const totalAtRisk   = rows.filter(r => r.flag !== 'ok').reduce((s, r) => s + r.value, 0)
  const expiredCount  = rows.filter(r => r.flag === 'expired').length
  const warningCount  = rows.filter(r => r.flag === 'warning').length
  const itemsTracked  = new Set(rows.map(r => r.itemName)).size

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const asOfLabel = asOf ? `${bsLabel(asOf.bs)}${asOf.isToday ? ' (today)' : ''}` : '—'
  const flagLabel = filterFlag === 'all' ? 'All statuses'
    : filterFlag === 'expired' ? 'Expired only'
    : filterFlag === 'warning' ? 'Expiring soon only' : 'In-date only'
  // What the reader is actually looking at, in one line — on screen, in the print header and in
  // the workbook alike. The filter bar is `no-print`, so a printed sheet otherwise showed a
  // filtered table with no record anywhere of which filter produced it (S594).
  // S756 (D19): the basis and the latest count go in the scope too — "quantities follow the counts"
  // is only checkable if the reader is told which count.
  const countLabel = latestCount ? `counts to end of ${monthLabel(latestCount)}` : 'no closed-month count in the window'
  const scopeLine = `Stock on hand as at ${asOfLabel} · batches bought ${windowLabel || periodLabel} (12 months) · quantities follow ${countLabel} · ${flagLabel} · ${filterCat === 'all' ? 'All categories' : filterCat}`

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const data = filtered.map(r => ({
      'Item': r.itemName,
      'Category': r.category,
      'UOM': r.uom,
      'Bought': r.boughtLabel,
      'Qty Still On Hand': Number(r.qty.toFixed(3)),
      'Original Qty': Number(r.originalQty.toFixed(3)),
      'Returned Qty': Number((r.returnedQty || 0).toFixed(3)),
      'Used or Counted Off Qty (FIFO)': Number((r.consumedQty || 0).toFixed(3)),
      'of which Counted Off': Number((r.countedOffQty || 0).toFixed(3)),
      'Quantity Follows': r.countedIn ? `Count, end of ${monthLabel(r.countedIn)}` : 'Estimate (no count in window)',
      'Rate': r.rate,
      'Value (NPR)': Math.round(r.value),
      'Expiry Date': r.expiryDate,
      'Days Left': r.daysUntilExpiry,
      'Status': r.flag === 'expired' ? 'EXPIRED' : r.flag === 'warning' ? 'EXPIRING SOON' : 'OK'
    }))
    const ws = sheetWithLetterhead(XLSX, {
      title: 'FIFO / Expiry Report',
      biz,
      scopeLine,
      rows: data,
      notes: [
        BASIS,
        `Days Left is measured to ${asOfLabel}${asOf && !asOf.isToday ? ' — the end of the selected period, not today.' : '.'}`,
        'Where a closed month has a stock count, each item is set to that count: stock the count did not find comes off the oldest batches first ("Counted Off"). Not a batch-precise trace.',
        uncountedItems > 0 ? `${uncountedItems} item(s) had no count in the window and follow purchases less recipe usage.` : 'Every item listed was reached by a stock count in the window.',
        'Stock carried into the window absorbs consumption before any batch listed here.',
      ],
    })
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'FIFO Report')
    XLSX.writeFile(wb, `FIFO-Report-${periodLabel.replace(' ', '-')}.xlsx`)
  }

  function flagStyle(flag) {
    if (flag === 'expired') return { color: 'var(--theme-red-text)', badge: 'badge-red', label: 'Expired' }
    if (flag === 'warning') return { color: 'var(--theme-amber-text)', badge: 'badge-amber', label: `Expiring in ${warningDays}d` }
    return { color: 'var(--theme-green-text)', badge: 'badge-green', label: 'OK' }
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="the FIFO / expiry report" />

  return (
    <div>
      {/* Print-only header — the printed sheet has to state its own scope (S594). */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>FIFO / Expiry Report</h2>
        <div style={{ fontSize: 12 }}>{scopeLine}</div>
        <div style={{ fontSize: 12 }}>{BASIS}</div>
      </div>

      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title"><Tip text="First In, First Out — tracks which stock batches expire soonest so you use older stock before newer stock." width={240}>FIFO</Tip> / Expiry Report</h1>
          <p className="page-subtitle">Batches still on hand, net of returns, sales usage, wastage and staff meals — oldest consumed first</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} provisionalWhenOpen />
            <span style={{ fontSize: 12, color: 'var(--theme-text2)', marginLeft: 8 }}>
              <Tip width={320} text={asOf?.isToday
                ? 'Days Left is counted from today, because you are looking at your newest period — nothing recorded after it, so what it left on the shelf is what is on the shelf now.'
                : 'Days Left is counted to the END of the selected period, not to today — a later period exists, and measuring this one to today would report all of its stock as long expired.'}>
                Days left as at {asOfLabel}
              </Tip>
            </span>
          </div>
          {/* The basis, stated where the reader looks first (S756, D19). Waits for the load so it
              never names the previous month's count under the new month's chip. */}
          {!loading && !loadError && (
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '6px 0 0' }}>
              {BASIS}{' '}
              {latestCount
                ? <>Latest count used: end of <strong>{monthLabel(latestCount)}</strong>{uncountedItems > 0 ? ` · ${uncountedItems} item${uncountedItems === 1 ? '' : 's'} with no count in the window follow the estimate` : ''}.</>
                : <strong style={{ color: 'var(--theme-amber-text)' }}>No closed month in the window has a stock count, so every quantity is an estimate.</strong>}
            </p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <select aria-label="Period" className="form-select" value={selectedPeriod?.id || ''} onChange={e => handlePeriodChange(e.target.value)}>
            {periods.map(p => <option key={p.id} value={p.id}>{BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : ''}</option>)}
          </select>
          <button className="btn btn-ghost" style={{ fontSize: 12 }} disabled={loading || !!loadError}
            onClick={() => printWithTitle(`FIFO / Expiry Report — ${scopeLine}`)}>🖨 Print</button>
          {/* biz.error (S756): a failed client-name read shipped a blank CompanyName line. */}
          <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={exportExcel}
            disabled={loading || !!loadError || filtered.length === 0 || !!biz.error}>↓ Export Excel</button>
        </div>
      </div>

      {biz.error && (
        <p role="alert" className="no-print" style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--theme-amber-text)' }}>
          This outlet's name could not be loaded, so Excel is switched off rather than exporting a sheet
          with a blank company name. The report below is unaffected. Reload the page to try again.
        </p>
      )}

      {/* A failed read renders as a failure — never as a quiet expiry report (S612). */}
      {loadError ? <ReportLoadError error={loadError} /> : <>

      {/* The KPI strip waits for the load: an uncomputed report is four confident zeroes, three of
          them green, and "nothing is expiring" is the most reassuring thing this page can say (S594/S616). */}
      {!loading && (
      <div className="stat-grid no-print">
        <div className="stat-card">
          <div className="stat-label">
            <Tip width={300} text="Batches with an expiry date that still have stock on them after this window's consumption has been taken off oldest-first.">Batches On Hand</Tip>
          </div>
          <div className="stat-value">{rows.length}</div>
          <div className="stat-sub">{itemsTracked} item{itemsTracked === 1 ? '' : 's'} with expiry dates</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Expired</div>
          <div className="stat-value" style={{ color: expiredCount > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
            {expiredCount} {expiredCount > 0 ? '▲' : '✓'}
          </div>
          <div className="stat-sub">as at {asOfLabel}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text={`Batches whose expiry date falls within ${warningDays} days of the date above. Configurable in Settings → Thresholds.`} width={260}>Expiring Soon</Tip>
          </div>
          <div className="stat-value" style={{ color: warningCount > 0 ? 'var(--theme-amber-text)' : 'var(--theme-green-text)' }}>
            {warningCount} {warningCount > 0 ? '△' : '✓'}
          </div>
          <div className="stat-sub">within {warningDays} days</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Value of the stock that is expired or expiring soon, at the rate actually paid for each batch. This is the potential loss if it is not used or returned in time." width={260}>Value at Risk</Tip>
          </div>
          <div className="stat-value" style={{ fontSize: 18, color: totalAtRisk > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
            {npr(totalAtRisk)}
          </div>
        </div>
      </div>
      )}

      {!loading && (
      <div className="no-print" style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div className="tab-bar">
          {['all', 'expired', 'warning', 'ok'].map(f => (
            <button key={f} onClick={() => setFilterFlag(f)} className={`tab-btn${filterFlag === f ? ' tab-btn--active' : ''}`}>
              {f === 'all' ? 'All' : f === 'warning' ? 'Expiring Soon' : f === 'ok' ? 'In date' : 'Expired'}
            </button>
          ))}
        </div>
        <select aria-label="Filter by category" className="form-select" value={filterCat} onChange={e => setFilterCat(e.target.value)}>
          <option value="all">All Categories</option>
          {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
          {filtered.length} of {rows.length} batch{rows.length === 1 ? '' : 'es'}
        </span>
      </div>
      )}

      <div className="card">
        {loading ? <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p> :
          rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">◷</div>
              <p className="empty-state-text">
                No stock on hand from batches with an expiry date, for purchases in the 12 months to {periodLabel}.
                Add expiry dates when recording purchases so perishable stock shows up here.
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">◈</div>
              <p className="empty-state-text">No batches match the selected filters.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Category</th>
                    <th><Tip text="The day this batch was bought. Batches from the 12 months up to the selected month are included — expiry does not respect a month or a fiscal-year boundary." width={280}>Bought</Tip></th>
                    <th style={{ textAlign: 'right' }}><Tip text="What is left of this batch: purchased quantity, less returns, less consumption (sales usage, wastage, staff meals) taken oldest-batch-first. At every closed month with a stock count the item is set to what was counted — stock the count did not find comes off the oldest batches too. Stock carried into the window is consumed before any batch listed here. Not batch-precise — nothing in the data records which lot a portion came out of." width={320}>On Hand</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returned</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>Rate</th>
                    <th style={{ textAlign: 'right' }}>Value</th>
                    <th>Expiry Date</th>
                    <th style={{ textAlign: 'right' }}>Days Left</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(row => {
                    const fs = flagStyle(row.flag)
                    return (
                      <tr key={row.id} style={{ background: row.flag === 'expired' ? 'color-mix(in srgb, var(--theme-red) 4%, transparent)' : row.flag === 'warning' ? 'color-mix(in srgb, var(--theme-amber) 4%, transparent)' : 'transparent' }}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{row.itemName}</td>
                        <td><span className="badge badge-yellow">{row.category}</span></td>
                        <td style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{row.boughtLabel}</td>
                        <td style={{ textAlign: 'right' }}>{Number(row.qty.toFixed(3))}</td>
                        <td style={{ textAlign: 'right', color: row.returnedQty > 0 ? 'var(--theme-red-text)' : 'var(--theme-text3)' }}>
                          {row.returnedQty > 0 ? `−${Number(row.returnedQty.toFixed(3))}` : '—'}
                        </td>
                        <td style={{ color: 'var(--theme-text2)' }}>{row.uom}</td>
                        <td style={{ textAlign: 'right' }}>{nprInt(row.rate)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontWeight: 600 }}>{npr(row.value)}</td>
                        <td style={{ color: fs.color, whiteSpace: 'nowrap' }}>{row.expiryDate}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: fs.color, whiteSpace: 'nowrap' }}>
                          {row.daysUntilExpiry === null ? '—'
                            : row.daysUntilExpiry < 0 ? `${Math.abs(row.daysUntilExpiry)}d ago`
                            : `${row.daysUntilExpiry}d`}
                        </td>
                        <td><span className={`badge ${fs.badge}`}>{fs.label}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
      </div>
      </>}
    </div>
  )
}
