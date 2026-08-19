import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { COGS_FORMULA, computeUsed, varianceFlagPct } from '../../../shared/imsFormulas'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { selectDepletingSales } from '../sales/salesDepletion'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

function dispPurch(baseQty, item) {
  const cf = parseFloat(item.conversion_factor) || 1
  if (cf > 1 && item.purchase_unit) {
    const puQty = (baseQty / cf).toLocaleString(undefined, { maximumFractionDigits: 3 })
    return `${puQty} ${item.purchase_unit} (${Number(baseQty).toLocaleString()} ${item.uom})`
  }
  return Number(baseQty).toLocaleString()
}

export default function Variance() {
  const { clientId, profile, loading: authLoading, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const flagPct = varianceFlagPct(settings)
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [report, setReport] = useState([])
  const [loading, setLoading] = useState(true)
  const [filterCat, setFilterCat] = useState('all')
  const [filterFlag, setFilterFlag] = useState('all')
  const [categories, setCategories] = useState([])
  const [summary, setSummary] = useState(null)
  // Variance is only meaningful once the period's closing stock has been counted — see the
  // comment on the period default below.
  const [hasClosing, setHasClosing] = useState(true)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: c }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('categories').order('sort_order')
    ])
    setPeriods(p || [])
    setCategories(c || [])
    // Default to the most recent CLOSED period, not the open one. Closing stock is counted at
    // month-end, so mid-month `closeQty` is 0 for every item — actual usage then reads as
    // "everything on the shelf plus everything bought", every row flags Over, and the page paints
    // a red "potential loss" figure on a month that structurally cannot have one yet.
    // ShrinkageReport.js already restricts itself this way; this page never did.
    const chosen = (p || []).find(x => x.status === 'closed') || (p || []).find(x => x.status === 'open')
    if (chosen) { setSelectedPeriod(chosen); await buildReport(chosen.id) }
    setLoading(false)
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    setLoading(true)
    await buildReport(periodId)
    setLoading(false)
  }

  async function buildReport(periodId) {
    const [
      { data: items },
      { data: opening },
      { data: closing },
      { data: purchases },
      { data: returns },
      { data: wastages },
      { data: staffMealsData },
      { data: sales },
      { data: clientRecipes }
    ] = await Promise.all([
      scopedFrom('items', '*, categories(name)').eq('is_active', true).eq('is_sub_recipe', false),
      supabase.from('opening_stock').select('*').eq('period_id', periodId),
      supabase.from('closing_stock').select('*').eq('period_id', periodId),
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId).order('id')),
      scopedFrom('vendor_returns', 'item_id, qty').eq('period_id', periodId),
      supabase.from('wastages').select('item_id, qty').eq('period_id', periodId),
      supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId),
      // source + bs_day are needed for selectDepletingSales' POS-supersedes-manual dedup below.
      // Paged: a POS-heavy period's sales_entries crosses PostgREST's silent 1000-row cap, which
      // would truncate theoretical usage into a believable-but-low figure (S528/S529 class).
      fetchAllRows(() => supabase.from('sales_entries').select('recipe_id, qty_sold, bs_day, source').eq('period_id', periodId).order('id')),
      scopedFrom('recipes', 'id')
    ])

    const recipeIds = (clientRecipes || []).map(r => r.id)
    // explodeRecipeIngredients recurses through sub-recipe ingredients and applies yield_pct —
    // the previous direct recipe_ingredients read only picked up rows with item_id set, silently
    // dropping any ingredient that was itself a sub-recipe (sauces, batters, prepped components)
    // from theoretical usage entirely, understating it and throwing false "over variance" flags.
    const breakdown = recipeIds.length > 0 ? await explodeRecipeIngredients(supabase, recipeIds) : {}

    const openMap = {}; (opening || []).forEach(r => { openMap[r.item_id] = parseFloat(r.qty) || 0 })
    const closeMap = {}; (closing || []).forEach(r => { closeMap[r.item_id] = parseFloat(r.physical_qty) || 0 })
    setHasClosing((closing || []).length > 0)

    // PATCHED: build purchMap net of returns
    const purchMap = {}
    ;(purchases || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) + parseFloat(r.qty) })
    ;(returns || []).forEach(r => { purchMap[r.item_id] = (purchMap[r.item_id] || 0) - parseFloat(r.qty) })

    const wasteMap = {}
    ;(wastages || []).forEach(r => { wasteMap[r.item_id] = (wasteMap[r.item_id] || 0) + parseFloat(r.qty) })

    const staffMealMap = {}
    ;(staffMealsData || []).forEach(r => { staffMealMap[r.item_id] = (staffMealMap[r.item_id] || 0) + parseFloat(r.qty) })

    // Deduplicate POS-synced and manual bulk sales before summing — a client running POS *and*
    // manual Sales Entry can carry the same dish as both a 'pos' row and a 'manual'/bulk row for
    // the same period, and summing both double-counts qty_sold. That inflates theoretical usage,
    // which pushes variance downward and MASKS real over-consumption (shrinkage) — the opposite of
    // what this "money report" is for. selectDepletingSales applies the one shared
    // POS-supersedes-manual rule (same as Stock Movements' Sub-Recipes tab and Supplier
    // Contribution): every POS sale counts (comps included — they consumed stock), a manual row
    // counts only where POS didn't already sell that recipe that day, and credit-note reversals
    // never add usage.
    const soldMap = {}
    selectDepletingSales(sales || []).forEach(s => { soldMap[s.recipe_id] = (soldMap[s.recipe_id] || 0) + parseFloat(s.qty_sold) })

    // breakdown[recipeId] is already yield_pct-adjusted, per-one-portion raw-ingredient qty
    // (recursed through any sub-recipe nesting) — just scale by how many portions actually sold.
    const theoreticalMap = {}
    Object.entries(breakdown).forEach(([recipeId, rows]) => {
      const sold = soldMap[recipeId] || 0
      if (sold <= 0) return
      rows.forEach(({ item_id, qty }) => {
        theoreticalMap[item_id] = (theoreticalMap[item_id] || 0) + sold * qty
      })
    })

    const rows = (items || []).map(item => {
      const openQty      = openMap[item.id] || 0
      const netPurchQty  = purchMap[item.id] || 0  // already net of returns
      const closeQty     = closeMap[item.id] || 0
      const wasteQty     = wasteMap[item.id]     || 0
      const staffMealQty = staffMealMap[item.id] || 0
      const actualUsed   = computeUsed({
        opening: openQty, purchases: netPurchQty, wastage: wasteQty, staffMeals: staffMealQty, closing: closeQty
      })
      const theoreticalUsed = theoreticalMap[item.id] || 0
      const variance     = actualUsed - theoreticalUsed
      const variancePct  = theoreticalUsed > 0 ? (variance / theoreticalUsed) * 100 : null
      const value        = variance * parseFloat(item.per_uom_rate || 0)

      let flag = 'ok'
      if (variancePct !== null) {
        if (variancePct > flagPct) flag = 'over'
        else if (variancePct < -flagPct) flag = 'under'
      }
      if (theoreticalUsed === 0 && actualUsed > 0) flag = 'over'

      return {
        item, openQty,
        purchQty: netPurchQty, // net figure displayed
        closeQty, wasteQty,
        actualUsed, theoreticalUsed, variance,
        variancePct, value, flag,
        category: item.categories?.name || 'Uncategorised'
      }
    })

    const totalActual         = rows.reduce((s, r) => s + Math.max(r.actualUsed, 0), 0)
    const totalTheoretical    = rows.reduce((s, r) => s + r.theoreticalUsed, 0)
    const totalVarianceValue  = rows.reduce((s, r) => s + r.value, 0)
    const flaggedCount        = rows.filter(r => r.flag !== 'ok' && (r.actualUsed > 0 || r.theoreticalUsed > 0)).length

    setSummary({ totalActual, totalTheoretical, totalVarianceValue, flaggedCount, totalItems: rows.length })
    setReport(rows)
  }

  const filtered = report.filter(r => {
    const matchCat  = filterCat === 'all' || r.item.categories?.name === filterCat
    const matchFlag = filterFlag === 'all' || r.flag === filterFlag
    const hasActivity = r.actualUsed !== 0 || r.theoreticalUsed > 0 || r.openQty > 0 || r.purchQty > 0
    return matchCat && matchFlag && hasActivity
  })

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'

  function flagBadge(flag) {
    if (flag === 'over') return <span className="badge badge-red">Over</span>
    if (flag === 'under') return <span className="badge badge-amber">Under</span>
    return <span className="badge badge-green">OK</span>
  }

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />
  if (!loading && periods.length === 0) return <NoPeriodState what="the variance report" />

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Variance Report</h1>
          <p className="page-subtitle">Theoretical vs actual usage — the money report — {periodLabel}</p>
        </div>
        <select aria-label="Period"
          className="form-select"
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

      {!loading && selectedPeriod && !hasClosing && (
        <div style={{ background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.30)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Closing stock hasn’t been counted for {periodLabel} yet.</strong>{' '}
          Variance can’t be measured until it is — until then the figures below count everything
          still sitting on your shelves as “used”, which makes every item look over-consumed.
          Finish the Stock Count for this month, or pick a closed month above.
        </div>
      )}

      {summary && (
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4,1fr)', marginBottom: 24 }}>
          <div className="stat-card">
            <div className="stat-label">Items Analysed</div>
            <div className="stat-value">{filtered.length}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text={`Items where actual usage differs from theoretical by more than ${flagPct}%. These need investigation. Change the threshold in Settings → Thresholds.`} width={240}>Flagged Items</Tip>
            </div>
            <div className="stat-value" style={{ color: !hasClosing ? 'var(--theme-text2)' : summary.flaggedCount > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
              {hasClosing ? summary.flaggedCount : '—'}
            </div>
            <div className="stat-sub">{hasClosing ? `>${flagPct}% variance` : 'Needs closing count'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Sum of (over-used qty × item rate) across all items. This is the NPR value of stock you can't account for." width={240}>Total Variance Value</Tip>
            </div>
            <div className="stat-value gold" style={{ fontSize: 18, color: !hasClosing ? 'var(--theme-text2)' : summary.totalVarianceValue > 0 ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
              {hasClosing
                ? `NPR ${Math.abs(summary.totalVarianceValue).toLocaleString('en-NP', { maximumFractionDigits: 0 })}`
                : 'Not measurable yet'}
            </div>
            <div className="stat-sub">{!hasClosing ? 'Closing count not entered' : summary.totalVarianceValue > 0 ? 'Over-used (potential loss)' : 'Under-used'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">
              <Tip text="Variance needs two things: sales entries (to work out what should have been used) and a closing stock count (to work out what actually was). Both must be present for the figures to mean anything." width={260}>Data Coverage</Tip>
            </div>
            <div className="stat-value" style={{ fontSize: 16, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {summary.totalTheoretical > 0 ? <span className="badge badge-green">Sales linked</span> : <span className="badge badge-amber">No sales data</span>}
              {hasClosing ? <span className="badge badge-green">Stock counted</span> : <span className="badge badge-amber">No closing count</span>}
            </div>
            <div className="stat-sub">
              {summary.totalTheoretical > 0 && hasClosing ? 'Variance is measurable' : 'Both are needed to compare'}
            </div>
          </div>
        </div>
      )}

      <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.15)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', lineHeight: 1.6 }}>
        <strong style={{ color: 'var(--theme-accent-ink)' }}>How to read this:</strong> Theoretical = what should have been used based on sales × recipe qty. Actual = {COGS_FORMULA}.
        <span style={{ color: 'var(--theme-red-text)' }}> Over variance</span> = more used than sold (waste, theft, over-portioning).
        <span style={{ color: 'var(--theme-amber-text)' }}> Under variance</span> = less used than expected (under-portioning or data gap).
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select aria-label="Filter by category" className="form-select"
            value={filterCat} onChange={e => setFilterCat(e.target.value)}>
            <option value="all">All Categories</option>
            {categories.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
          </select>
          <select aria-label="Filter by variance flag" className="form-select"
            value={filterFlag} onChange={e => setFilterFlag(e.target.value)}>
            <option value="all">All Items</option>
            <option value="over">Over variance only</option>
            <option value="under">Under variance only</option>
            <option value="ok">OK only</option>
          </select>
        </div>
        <span style={{ fontSize: 13, color: 'var(--theme-text2)', marginLeft: 'auto' }}>{filtered.length} items</span>
      </div>

      <div className="card">
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Building report…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">△</div>
            <p className="empty-state-text">No data yet. Complete stock count and add purchase entries to generate the variance report.</p>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Category</th>
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>Opening</th>
                  <th style={{ textAlign: 'right' }}>Net Purchased</th>
                  <th style={{ textAlign: 'right' }}>Wastage</th>
                  <th style={{ textAlign: 'right' }}>Closing</th>
                  <th style={{ textAlign: 'right' }}><Tip text={`${COGS_FORMULA}. What was actually consumed, based on stock movement.`} width={240}>Actual Used</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="What should have been used based on recipes sold × ingredient qty per portion." width={220}>Theoretical</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Actual − Theoretical. Positive (red) = over-used = loss. Negative (yellow) = under-used = possible data gap." width={240}>Variance</Tip></th>
                  <th style={{ textAlign: 'right' }}>Var %</th>
                  <th style={{ textAlign: 'right' }}>Value (NPR)</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {filtered.sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).map(row => {
                  // Without a closing count every variance figure is an artefact of the missing
                  // count, so it is shown in neutral type and left unflagged rather than painted
                  // red — the banner above says why.
                  const varColor = !hasClosing ? 'var(--theme-text2)'
                    : row.variance > 0 ? 'var(--theme-red-text)' : row.variance < 0 ? 'var(--theme-amber-text)' : 'var(--theme-text2)'
                  return (
                    <tr key={row.item.id} style={{ background: hasClosing && row.flag === 'over' ? 'rgba(248,113,113,0.03)' : 'transparent' }}>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{row.item.name}</td>
                      <td><span className="badge badge-yellow">{row.category}</span></td>
                      <td style={{ color: 'var(--theme-text2)' }}>{row.item.uom}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{row.openQty > 0 ? row.openQty.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{row.purchQty !== 0 ? dispPurch(row.purchQty, row.item) : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{row.wasteQty > 0 ? row.wasteQty.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{row.closeQty > 0 ? row.closeQty.toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.actualUsed !== 0 ? Number(row.actualUsed.toFixed(3)).toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{row.theoreticalUsed > 0 ? Number(row.theoreticalUsed.toFixed(3)).toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: varColor }}>
                        {row.variance !== 0 ? (row.variance > 0 ? '+' : '') + Number(row.variance.toFixed(3)).toLocaleString() : '—'}
                      </td>
                      <td style={{ textAlign: 'right', color: varColor }}>
                        {row.variancePct != null ? `${row.variancePct > 0 ? '+' : ''}${row.variancePct.toFixed(1)}%` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 600, color: varColor }}>
                        {row.value !== 0 ? `${row.value > 0 ? '+' : ''}${Number(row.value.toFixed(0)).toLocaleString()}` : '—'}
                      </td>
                      <td>{hasClosing ? flagBadge(row.flag) : <span style={{ color: 'var(--theme-text3)' }}>—</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
