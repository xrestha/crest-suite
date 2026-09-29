import { npr2 } from '../../../shared/nepalMoney'
import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import ReportLoadError from '../../../components/ReportLoadError'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import ActionError, { asActionError } from '../../../components/ActionError'
import { budgetActuals } from './budgetActuals'
import { printWithTitle } from '../../../utils/printTitle'
import { BS_MONTHS } from '../../../utils/bsCalendar'

export default function BudgetVsActual() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [categories, setCategories] = useState([])
  const [actuals, setActuals] = useState({})   // { category_id: netPurchaseValue }
  const [budgets, setBudgets] = useState({})   // { category_id: amount }
  const [saving, setSaving] = useState({})     // { category_id: bool }
  const [dirty, setDirty] = useState({})       // { category_id: bool } — typed into since last save
  const [unbudgeted, setUnbudgeted] = useState(0)
  // Spend on lines whose item Monthly Summary does not value either (a prep item's mirror row) —
  // kept out of the Totals so they still tie, and named under the table (S792, FIGURES-9).
  const [excluded, setExcluded] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [saveError, setSaveError] = useState(null)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    setLoadError(null)
    const initResults = await Promise.all([
      scopedFrom('monthly_periods')
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('categories').order('sort_order'),
    ])
    // A failed read must not wear NoPeriodState or an empty budget sheet (S612 silent-zero rule).
    const initFailed = firstError(initResults)
    if (initFailed) { setLoadError(initFailed); setLoading(false); return }
    const [{ data: p }, { data: cats }] = initResults
    setPeriods(p || [])
    setCategories(cats || [])
    // Falls back to the latest period when none is open (S722 rule, S756). With every period closed
    // this selected nothing: the budget inputs still rendered, and saveBudget silently returned on
    // `!selectedPeriod` — a figure typed, tabbed away from, and never written, with no message.
    const chosen = (p || []).find(x => x.status === 'open') || (p || [])[0]
    if (chosen) {
      // init() claims the page too (S756), or an admin client switch after any period change leaves
      // the ref on the old client's period and loadData skips every setter.
      periodReq.begin(chosen.id)
      setSelectedPeriod(chosen)
      await loadData(chosen.id, cats || [])
      if (periodReq.isCurrent(chosen.id)) setLoading(false)
      return
    }
    setLoading(false)
  }

  async function loadData(periodId, cats) {
    const catList = cats || categories
    setLoadError(null)
    const results = await Promise.all([
      // Monthly Summary's item population exactly (S792, FIGURES-9): every non-sub-recipe item,
      // HIDDEN ONES INCLUDED (D29 — hiding an item never takes its spend out of a past month). This
      // read was `is_active = true` with no sub-recipe filter, the opposite on both counts, so its
      // total could not tie to the Net Purchases it says it matches.
      fetchAllRows(() => scopedFrom('items', 'id, category_id').eq('is_sub_recipe', false).order('id')),
      // `discount_amount` + the bill-key columns feed allocateBillDiscounts(). "Actual net" here
      // was gross − returns with the bill-level discount left in, so the figure a client checks
      // their budget against was higher than the Net Purchases figure Monthly Summary shows for
      // the identical period — the page could report Over Budget on spend that was not over.
      fetchAllRows(() => supabase.from('purchase_entries')
        .select('item_id, qty, rate, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day, vat_inclusive, vat_is_cost')
        .eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('vendor_returns').select('item_id, qty, rate, purchase_entries(vat_inclusive, vat_is_cost)').eq('period_id', periodId).order('id')),
      supabase.from('budgets').select('*').eq('period_id', periodId).eq('client_id', effectiveClientId),
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must not render NPR-0 actuals beside real budgets — or blank budget boxes a
    // save would then write zeros over (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setActuals({}); setBudgets({}); setUnbudgeted(0); setExcluded(0); setDirty({}); return }
    const [{ data: items }, { data: purchases }, { data: returns }, { data: budgetRows }] = results

    // Net purchase value per category, NET of each bill's allocated discount (base units both
    // sides — see item-master-rates.md), through budgetActuals.js so the arithmetic is tested
    // against Monthly Summary's own.
    //
    // `items.category_id` is NULLABLE, and a loop that only claimed items belonging to a real
    // category let every rupee spent on an uncategorised item fall out of the Actual column AND
    // the Totals row, silently. Those items are an unbudgetable row of their own, as Monthly
    // Summary groups them into "Uncategorized": there is no category to set a budget against, so
    // the row reports what was spent and says so.
    const { byCategory, uncategorised, excluded: notValued } = budgetActuals({ items, categories: catList, purchases, returns })
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setActuals(byCategory)
    setUnbudgeted(uncategorised)
    setExcluded(notValued)

    // Budget map: category_id → amount
    const budgetMap = {}
    ;(budgetRows || []).forEach(b => { budgetMap[b.category_id] = parseFloat(b.amount) || 0 })
    setBudgets(budgetMap)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setSaveError(null)
    setDirty({})   // an unsaved draft belongs to the period it was typed in, not the next one
    setLoading(true)
    await loadData(periodId, categories)
    // Only the load that still owns the page may clear the flag (S756): a superseded load returns
    // early from loadData, and clearing here would show the previous period's actuals and budgets
    // — editable — under the new period's label.
    if (periodReq.isCurrent(periodId)) setLoading(false)
  }

  function updateBudget(categoryId, value) {
    setBudgets(prev => ({ ...prev, [categoryId]: value }))
    setDirty(prev => prev[categoryId] ? prev : { ...prev, [categoryId]: true })
  }

  async function saveBudget(categoryId) {
    // Blur fires whether or not anything was typed, so tabbing across an untouched row used to
    // upsert `amount: 0` for every category it passed through — writing rows nobody had asked for.
    if (!dirty[categoryId]) return
    // Loud, not silent (S756): this return used to discard a typed budget with nothing on screen,
    // under a banner promising budgets save automatically.
    if (!selectedPeriod?.id || !effectiveClientId) {
      const name = categories.find(c => c.id === categoryId)?.name || 'this category'
      setSaveError(`The budget for ${name} was NOT saved — no period is selected. Pick a period above, then click into the box and out again.`)
      return
    }
    const amount = parseFloat(budgets[categoryId]) || 0
    setSaving(prev => ({ ...prev, [categoryId]: true }))
    setSaveError(null)
    const { error } = await supabase.from('budgets').upsert(
      { client_id: effectiveClientId, period_id: selectedPeriod.id, category_id: categoryId, amount },
      { onConflict: 'period_id,category_id' }
    )
    setSaving(prev => ({ ...prev, [categoryId]: false }))
    // The banner above this table says "Budgets are saved automatically". A failure that reaches
    // only console.error makes that sentence a lie: the spinner clears, the number stays on
    // screen, and the reader has every reason to believe it landed until they come back next
    // month and find it gone. Name the category and say the figure is still on screen (S716's
    // rule: write the recovery path and the sentence in the same edit — nothing here reloads
    // on failure, which is what makes "click out of the box again" true).
    if (error) {
      const name = categories.find(c => c.id === categoryId)?.name || 'this category'
      const { text, detail } = asActionError(error)
      setSaveError({
        text: `The budget for ${name} was NOT saved. What you typed is still on screen — click out of the box again to retry. Do not reload the page first. ${text}`,
        detail,
      })
      return
    }
    setDirty(prev => { const next = { ...prev }; delete next[categoryId]; return next })
  }

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  const totalBudget   = categories.reduce((s, c) => s + (parseFloat(budgets[c.id]) || 0), 0)
  // The Totals row is the period's net spend over the items Monthly Summary values, so it INCLUDES
  // the uncategorised remainder and EXCLUDES `excluded` — that is what makes it reconcile against
  // Monthly Summary's Net Purchases (S792, FIGURES-9: before it, hidden items' spend was in this
  // total and not in that one). The variance is deliberately measured against the budgeted
  // categories only, since there is no budget for the remainder to be over or under; the row above
  // the total names the gap rather than letting the two figures disagree silently (the S594 rule).
  const totalBudgetedActual = categories.reduce((s, c) => s + (actuals[c.id] || 0), 0)
  const totalActual   = totalBudgetedActual + unbudgeted
  const totalVariance = totalBudget - totalBudgetedActual

  const fmt = npr2
  // D7 (S756): the page opens on the current month, which is still OPEN — bills are still being
  // entered, so every category reads under budget until they are. No green/red and no Over/Under
  // verdict until the month is closed; the figures themselves still print.
  const provisional = selectedPeriod?.status === 'open'
  const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="this budget report" />

  return (
    <div>
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Budget vs Actual</h1>
          <p className="page-subtitle">Compare planned spend against actual net purchases</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} provisionalWhenOpen />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <select aria-label="Period"
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
            value={selectedPeriod?.id || ''}
            onChange={e => handlePeriodChange(e.target.value)}
          >
            {periods.map(p => (
              <option key={p.id} value={p.id}>
                {BS_MONTHS[p.bs_month - 1]} {p.bs_year} {p.status === 'open' ? '(open)' : '(closed)'}
              </option>
            ))}
          </select>
          {/* Gated on the load (S728/S756): mid-load the table holds the previous period's figures
              while the print title already names the new one. */}
          <button className="btn btn-ghost" style={{ fontSize: 13 }} disabled={loading || !!loadError} onClick={() => printWithTitle(`Budget vs Actual - ${periodLabel}`)}>⎙ Print</button>
        </div>
      </div>

      <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
        Enter a budget for each category — the app compares it against net purchases (purchases − bill discounts − returns) for the selected period, the same figure Monthly Summary shows. Budgets are saved automatically when you click out of the box.
      </div>

      {!loading && !loadError && provisional && (
        <div role="status" className="card" style={{ marginBottom: 16, padding: '12px 16px', fontSize: 13, color: 'var(--theme-text2)', borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)' }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>△ Provisional</strong> — this month is still open and its bills are still being entered, so spend reads low. Over / under budget is not judged until the month is closed.
        </div>
      )}

      {/* role="alert", above the table: someone who typed a budget, tabbed away and heard nothing
          has been told it saved. */}
      <ActionError error={saveError} className="action-error--top" />

      {loading ? (
        <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36, textAlign: 'center', color: 'var(--theme-text2)' }}>S.No</th>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}><Tip text="Enter your target spend for this category. Saved automatically when you click outside the field.">Budget (NPR)</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Net purchases = gross purchases minus bill discounts minus vendor returns, for this category this period. Items you have since hidden still count in the months they were bought.">Actual Net (NPR)</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Budget − Actual. Positive (green) = under budget. Negative (red) = over budget. Not coloured while the month is still open — its spend is not final.">Variance (NPR)</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Variance as % of budget. Shows how far over or under your target you are." width={220}>Variance %</Tip></th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((cat, idx) => {
                  const budget   = parseFloat(budgets[cat.id]) || 0
                  const actual   = actuals[cat.id] || 0
                  const variance = budget - actual
                  const pct      = budget > 0 ? (variance / budget) * 100 : null
                  const noBudget = budget === 0
                  const isOver   = !noBudget && actual > budget

                  return (
                    <tr key={cat.id}>
                      <td style={{ textAlign: 'center', color: 'var(--theme-text2)' }}>{idx + 1}</td>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{cat.name}</td>
                      <td style={{ textAlign: 'right', width: 180 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                          <input aria-label={`Budget for ${cat.name}`}
                            type="number" min="0"
                            value={budgets[cat.id] ?? ''}
                            onChange={e => updateBudget(cat.id, e.target.value)}
                            onBlur={() => saveBudget(cat.id)}
                            placeholder="Set budget…"
                            style={{
                              background: 'var(--theme-bg)', border: '1px solid',
                              borderColor: budget > 0 ? 'color-mix(in srgb, var(--theme-accent) 40%, transparent)' : 'var(--theme-border)',
                              borderRadius: 'var(--radius-sm)', padding: '5px 10px', fontSize: 13,
                              color: 'var(--theme-text1)', outline: 'none', width: 130, textAlign: 'right',
                            }}
                          />
                          {saving[cat.id] && <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>…</span>}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                        {/* `!== 0`, not `> 0` (S756): returns larger than a month's purchases make
                            net spend negative, and a dash there hid a real credit that the Totals
                            row below still counts. */}
                        {actual !== 0 ? fmt(actual) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: noBudget ? 'var(--theme-text2)' : provisional ? 'var(--theme-text1)' : isOver ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                        {noBudget ? '—' : (variance >= 0 ? '+' : '') + fmt(variance)}
                      </td>
                      <td style={{ textAlign: 'right', color: noBudget || provisional ? 'var(--theme-text2)' : isOver ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                        {pct !== null ? fmtPct(pct) : '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {/* The badge classes, not hand-rolled chips (S794): text2 on a 15% text2 tint
                            measured 4.41:1 on Light. `badge-sentence` keeps "Above so far" in
                            sentence case against the badge's capitalize. */}
                        {noBudget
                          ? <span className="badge badge-gray">No Budget</span>
                          : provisional
                          ? <span className="badge badge-gray badge-sentence" title="The month is still open — judged once it is closed">{isOver ? 'Above so far' : 'Within so far'}</span>
                          : isOver
                          ? <span className="badge badge-red">Over Budget</span>
                          : <span className="badge badge-green">Under Budget</span>
                        }
                      </td>
                    </tr>
                  )
                })}
                {/* Spend on items with no category set. It used to be dropped from the Actual
                    column and from the Totals row alike, so this page's total could not be
                    reconciled against Monthly Summary's Net Purchases and the reader was never
                    told why. A hidden item is no longer here (S792): it counts in its own category. */}
                {unbudgeted !== 0 && (
                  <tr>
                    <td style={{ textAlign: 'center', color: 'var(--theme-text2)' }}>{categories.length + 1}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text2)' }}>
                      <Tip text="Net purchases of items with no category set. Monthly Summary lists the same spend as Uncategorized. Set a category on the item in Item Master to bring this spend into a budget line." width={280}>Uncategorised / unbudgetable</Tip>
                    </td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>—</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>{fmt(unbudgeted)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>—</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>—</td>
                    <td style={{ textAlign: 'center' }}>
                      <span className="badge badge-gray">No Budget</span>
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td></td>
                  <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                    {unbudgeted !== 0
                      ? <Tip text="Budget totals the categories you have set one for. Actual is the period's whole net purchase value, including the unbudgetable row above — the same figure as Monthly Summary's Net Purchases. Variance compares budget against the budgeted categories only." width={290}>Totals</Tip>
                      : 'Totals'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>
                    {totalBudget > 0 ? fmt(totalBudget) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text3)' }}>
                    {totalActual !== 0 ? fmt(totalActual) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: totalBudget === 0 || provisional ? 'var(--theme-text2)' : totalVariance >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    {totalBudget > 0 ? (totalVariance >= 0 ? '+' : '') + fmt(totalVariance) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: totalBudget === 0 || provisional ? 'var(--theme-text2)' : totalVariance >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    {totalBudget > 0 ? fmtPct((totalVariance / totalBudget) * 100) : '—'}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
          {/* Named, not dropped (S792): a line Monthly Summary does not value either is kept out
              of the Totals so the two still tie — and the reader is told it exists. */}
          {excluded !== 0 && (
            <p style={{ margin: '12px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
              Not in the totals: {fmt(excluded)} of purchases of prep (sub-recipe) items. Monthly Summary leaves them out
              too, because their raw ingredients are already counted.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
