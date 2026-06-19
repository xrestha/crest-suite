import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function BudgetVsActual() {
  const { clientId, profile, loading: authLoading } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [categories, setCategories] = useState([])
  const [actuals, setActuals] = useState({})   // { category_id: netPurchaseValue }
  const [budgets, setBudgets] = useState({})   // { category_id: amount }
  const [saving, setSaving] = useState({})     // { category_id: bool }
  const [loading, setLoading] = useState(true)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: cats }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId)
        .order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order'),
    ])
    setPeriods(p || [])
    setCategories(cats || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await loadData(open.id, cats || []) }
    setLoading(false)
  }

  async function loadData(periodId, cats) {
    const catList = cats || categories
    const [{ data: items }, { data: purchases }, { data: returns }, { data: budgetRows }] = await Promise.all([
      supabase.from('items').select('id, category_id').eq('client_id', effectiveClientId).eq('is_active', true),
      supabase.from('purchase_entries').select('item_id, qty, rate').eq('period_id', periodId),
      supabase.from('vendor_returns').select('item_id, qty, rate').eq('period_id', periodId),
      supabase.from('budgets').select('*').eq('period_id', periodId).eq('client_id', effectiveClientId),
    ])

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
    setActuals(actualMap)

    // Budget map: category_id → amount
    const budgetMap = {}
    ;(budgetRows || []).forEach(b => { budgetMap[b.category_id] = parseFloat(b.amount) || 0 })
    setBudgets(budgetMap)
  }

  async function handlePeriodChange(periodId) {
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

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Budget vs Actual</h1>
          <p className="page-subtitle">Compare planned spend against actual net purchases — {periodLabel}</p>
        </div>
        <select
          style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none' }}
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

      <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#c9a84c' }}>
        Enter a budget for each category — the app compares it against net purchases (purchases − returns) for the selected period. Budgets are saved automatically.
      </div>

      {loading ? (
        <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36, textAlign: 'center', color: '#6b7280' }}>S.No</th>
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
                      <td style={{ textAlign: 'center', color: '#6b7280' }}>{idx + 1}</td>
                      <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{cat.name}</td>
                      <td style={{ textAlign: 'right', width: 180 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
                          <input
                            type="number" min="0"
                            value={budgets[cat.id] ?? ''}
                            onChange={e => updateBudget(cat.id, e.target.value)}
                            onBlur={() => saveBudget(cat.id)}
                            placeholder="Set budget…"
                            style={{
                              background: '#0f1117', border: '1px solid',
                              borderColor: budget > 0 ? 'rgba(201,168,76,0.4)' : '#2a2f3d',
                              borderRadius: 5, padding: '5px 10px', fontSize: 13,
                              color: '#e8e0d0', outline: 'none', width: 130, textAlign: 'right',
                            }}
                          />
                          {saving[cat.id] && <span style={{ fontSize: 11, color: '#6b7280' }}>…</span>}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', color: '#9ca3af' }}>
                        {actual > 0 ? fmt(actual) : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: noBudget ? '#6b7280' : isOver ? '#f87171' : '#34d399' }}>
                        {noBudget ? '—' : (variance >= 0 ? '+' : '') + fmt(variance)}
                      </td>
                      <td style={{ textAlign: 'right', color: noBudget ? '#6b7280' : isOver ? '#f87171' : '#34d399' }}>
                        {pct !== null ? fmtPct(pct) : '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {noBudget
                          ? <span style={{ fontSize: 11, color: '#6b7280', background: 'rgba(107,114,128,0.15)', padding: '2px 10px', borderRadius: 10 }}>No Budget</span>
                          : isOver
                          ? <span style={{ fontSize: 11, color: '#f87171', background: 'rgba(248,113,113,0.12)', padding: '2px 10px', borderRadius: 10 }}>Over Budget</span>
                          : <span style={{ fontSize: 11, color: '#34d399', background: 'rgba(52,211,153,0.12)', padding: '2px 10px', borderRadius: 10 }}>Under Budget</span>
                        }
                      </td>
                    </tr>
                  )
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                  <td></td>
                  <td style={{ fontWeight: 700, color: '#c9a84c' }}>Totals</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#e8e0d0' }}>
                    {totalBudget > 0 ? fmt(totalBudget) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: '#9ca3af' }}>
                    {totalActual > 0 ? fmt(totalActual) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: totalBudget === 0 ? '#6b7280' : totalVariance >= 0 ? '#34d399' : '#f87171' }}>
                    {totalBudget > 0 ? (totalVariance >= 0 ? '+' : '') + fmt(totalVariance) : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: totalBudget === 0 ? '#6b7280' : totalVariance >= 0 ? '#34d399' : '#f87171' }}>
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
