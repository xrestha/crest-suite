import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { firstError } from '../../../shared/queryError'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

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
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

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
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await loadData(open.id, cats || []) }
    setLoading(false)
  }

  async function loadData(periodId, cats) {
    const catList = cats || categories
    setLoadError(null)
    const results = await Promise.all([
      scopedFrom('items', 'id, category_id').eq('is_active', true),
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty, rate').eq('period_id', periodId).order('id')),
      supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', periodId),
      supabase.from('budgets').select('*').eq('period_id', periodId).eq('client_id', effectiveClientId),
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must not render NPR-0 actuals beside real budgets — or blank budget boxes a
    // save would then write zeros over (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setActuals({}); setBudgets({}); return }
    const [{ data: items }, { data: purchases }, { data: returns }, { data: budgetRows }] = results

    // NPR value per item from purchase_entries (qty × rate — both base units)
    const purchMap = {}
    ;(purchases || []).forEach(p => {
      purchMap[p.item_id] = (purchMap[p.item_id] || 0) + parseFloat(p.qty) * parseFloat(p.rate)
    })
    const retMap = {}
    ;(returns || []).forEach(r => {
      retMap[r.item_id] = (retMap[r.item_id] || 0) + parseFloat(r.qty) * parseFloat(r.rate)
    })

    // Net purchase value per category
    const actualMap = {}
    catList.forEach(cat => {
      const catItems = (items || []).filter(i => i.category_id === cat.id)
      actualMap[cat.id] = catItems.reduce((s, i) => s + (purchMap[i.id] || 0) - (retMap[i.id] || 0), 0)
    })
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setActuals(actualMap)

    // Budget map: category_id → amount
    const budgetMap = {}
    ;(budgetRows || []).forEach(b => { budgetMap[b.category_id] = parseFloat(b.amount) || 0 })
    setBudgets(budgetMap)
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await loadData(periodId, categories)
    setLoading(false)
  }

  function updateBudget(categoryId, value) {
    setBudgets(prev => ({ ...prev, [categoryId]: value }))
  }

  async function saveBudget(categoryId) {
    const amount = parseFloat(budgets[categoryId]) || 0
    setSaving(prev => ({ ...prev, [categoryId]: true }))
    const { error } = await supabase.from('budgets').upsert(
      { client_id: effectiveClientId, period_id: selectedPeriod.id, category_id: categoryId, amount },
      { onConflict: 'period_id,category_id' }
    )
    if (error) console.error('Budget save error:', error)
    setSaving(prev => ({ ...prev, [categoryId]: false }))
  }

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  const totalBudget   = categories.reduce((s, c) => s + (parseFloat(budgets[c.id]) || 0), 0)
  const totalActual   = categories.reduce((s, c) => s + (actuals[c.id] || 0), 0)
  const totalVariance = totalBudget - totalActual

  const fmt    = v => v.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  const fmtPct = v => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  // !loadError: a failed periods read must not wear NoPeriodState (S612 silent-zero rule).
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="this budget report" />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Budget vs Actual</h1>
          <p className="page-subtitle">Compare planned spend against actual net purchases — {periodLabel}</p>
        </div>
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
      </div>

      <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
        Enter a budget for each category — the app compares it against net purchases (purchases − returns) for the selected period. Budgets are saved automatically.
      </div>

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
                  <th style={{ textAlign: 'right' }}><Tip text="Net purchases = gross purchases minus vendor returns for this category this period.">Actual Net (NPR)</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Budget − Actual. Positive (green) = under budget. Negative (red) = over budget.">Variance (NPR)</Tip></th>
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
                          <input
                            type="number" min="0"
                            value={budgets[cat.id] ?? ''}
                            onChange={e => updateBudget(cat.id, e.target.value)}
                            onBlur={() => saveBudget(cat.id)}
                            placeholder="Set budget…"
                            style={{
                              background: 'var(--theme-bg)', border: '1px solid',
                              borderColor: budget > 0 ? 'rgba(201,168,76,0.4)' : 'var(--theme-border)',
                              borderRadius: 'var(--radius-sm)', padding: '5px 10px', fontSize: 13,
                              color: 'var(--theme-text1)', outline: 'none', width: 130, textAlign: 'right',
                            }}
                          />
                          {saving[cat.id] && <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>…</span>}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                        {actual > 0 ? fmt(actual) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: noBudget ? 'var(--theme-text2)' : isOver ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                        {noBudget ? '—' : (variance >= 0 ? '+' : '') + fmt(variance)}
                      </td>
                      <td style={{ textAlign: 'right', color: noBudget ? 'var(--theme-text2)' : isOver ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                        {pct !== null ? fmtPct(pct) : '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {noBudget
                          ? <span style={{ fontSize: 11, color: 'var(--theme-text2)', background: 'color-mix(in srgb, var(--theme-text2) 15%, transparent)', padding: '2px 10px', borderRadius: 'var(--radius-md)' }}>No Budget</span>
                          : isOver
                          ? <span style={{ fontSize: 11, color: 'var(--theme-red-text)', background: 'rgba(248,113,113,0.12)', padding: '2px 10px', borderRadius: 'var(--radius-md)' }}>Over Budget</span>
                          : <span style={{ fontSize: 11, color: 'var(--theme-green-text)', background: 'rgba(52,211,153,0.12)', padding: '2px 10px', borderRadius: 'var(--radius-md)' }}>Under Budget</span>
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                  <td></td>
                  <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)' }}>Totals</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>
                    {totalBudget > 0 ? fmt(totalBudget) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text3)' }}>
                    {totalActual > 0 ? fmt(totalActual) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: totalBudget === 0 ? 'var(--theme-text2)' : totalVariance >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    {totalBudget > 0 ? (totalVariance >= 0 ? '+' : '') + fmt(totalVariance) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: totalBudget === 0 ? 'var(--theme-text2)' : totalVariance >= 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
                    {totalBudget > 0 ? fmtPct((totalVariance / totalBudget) * 100) : '—'}
                  </td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
