import { nprOrDash, npr } from '../../../shared/nepalMoney'
import { useState, useEffect, useCallback, Fragment } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import { firstError } from '../../../shared/queryError'
import { fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { BS_MONTHS, bsToAd } from '../../../utils/bsCalendar'
import { runForecast } from '../../../utils/demandForecastData'
import { splitDishList, totalQtyByRecipe, aggregateIngredientDemand, SAMPLES_PER_WEEKDAY, OCCASIONAL_THRESHOLD } from '../../../utils/demandForecastMath'
import { explodeRecipeIngredients } from '../../../utils/recipeCost'
import { printWithTitle } from '../../../utils/printTitle'
import { errorText } from '../../../shared/errorText'
import SuiteGate from '../../../components/SuiteGate'
import { Navigate } from 'react-router-dom'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const fmtNpr = nprOrDash
const PREVIEW_COUNT = 8

// Base-unit quantities span "0.25 kg" and "1,250 gm" — two decimals below 100, whole above.
function fmtQty(q) {
  if (q == null || !isFinite(q)) return '—'
  if (Math.abs(q) >= 100) return Math.round(q).toLocaleString('en-IN')
  return parseFloat(q.toFixed(2)).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

const dayOf = f => bsToAd(f.bs.year, f.bs.month, f.bs.day).getDay()
const bsLabel = f => `${f.bs.day} ${BS_MONTHS[f.bs.month - 1]} ${f.bs.year}`

// What stood behind a day's numbers — shown under the weekday and on every dish's hover, so a
// forecast averaged over one week and one over eight no longer look identical (S694).
function evidenceText(f) {
  const weekday = WEEKDAYS_FULL[dayOf(f)]
  if (f.sampleCount == null) return null // written before sample_count existed — say nothing rather than guess
  if (f.sampleCount === 0) return `no ${weekday}s in the last 12 weeks had sales`
  return `from the last ${f.sampleCount} ${weekday}${f.sampleCount === 1 ? '' : 's'}${f.sampleCount >= SAMPLES_PER_WEEKDAY ? '' : ' with sales'}`
}

export default function DemandForecast() {
  const { clientId, hasImsAccess, clientModules } = useAuth()
  const { scopedFrom } = useScopedDb()
  const horizonReq = useLatestRequest()
  const [horizon, setHorizon] = useState(7)
  const [forecast, setForecast] = useState([])
  const [recipeNames, setRecipeNames] = useState({})
  const [expandedIdx, setExpandedIdx] = useState(null) // which day's dish list is showing everything instead of the top plates
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [recomputing, setRecomputing] = useState(false)
  const [msg, setMsg] = useState('')
  const [lastRun, setLastRun] = useState(null)
  const [bizInfo, setBizInfo] = useState({ name: '', address: '' })
  // Ingredient demand for the horizon — loads after the day table, independently, so a slow
  // recipe walk never holds the forecast itself hostage, and its failure is its own message.
  const [ingredients, setIngredients] = useState({ loading: false, error: null, rows: [], totalValue: 0, unpriced: 0 })

  // Covers exist only where POS does: manual Sales Entries carry none. Keyed on the viewed
  // client's real subscription, not the session's `posEnabled`, which is true for every admin
  // (the S693 Roster fix, applied here for the same reason).
  const hasPos = !!clientModules?.pos

  useEffect(() => {
    if (!clientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address').eq('client_id', clientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({ name: client?.name || '', address: settings?.property_address || '' })
    })
  }, [clientId])

  const loadIngredients = useCallback(async (list, reqKey) => {
    const totals = totalQtyByRecipe(list)
    const recipeIds = Object.keys(totals).filter(id => totals[id] > 0)
    if (recipeIds.length === 0) { setIngredients({ loading: false, error: null, rows: [], totalValue: 0, unpriced: 0 }); return }
    setIngredients(s => ({ ...s, loading: true, error: null }))
    try {
      // Same walk the Reorder Report uses for theoretical usage: leaf items only, sub-recipes
      // resolved through their yield, item yield_pct applied.
      const exploded = await explodeRecipeIngredients(supabase, recipeIds)
      const byItem = aggregateIngredientDemand(totals, exploded)
      const itemIds = Object.keys(byItem)
      let items = []
      if (itemIds.length > 0) {
        const { data, error } = await fetchAllRowsChunked(itemIds, ids =>
          scopedFrom('items', 'id, name, uom, per_uom_rate, is_active, categories(name)').in('id', ids).order('id'))
        if (error) throw error
        items = data || []
      }
      if (!horizonReq.isCurrent(reqKey)) return
      const itemById = Object.fromEntries(items.map(i => [i.id, i]))
      let unpriced = 0
      const rows = itemIds.map(id => {
        const item = itemById[id]
        const rate = parseFloat(item?.per_uom_rate) || 0
        if (!rate) unpriced += 1
        return {
          id, name: item?.name || 'Unknown item', uom: item?.uom || '', category: item?.categories?.name || 'Uncategorised',
          inactive: item ? item.is_active === false : false,
          qty: byItem[id], rate, value: byItem[id] * rate,
        }
      }).sort((a, b) => b.value - a.value || b.qty - a.qty || a.name.localeCompare(b.name))
      setIngredients({ loading: false, error: null, rows, totalValue: rows.reduce((s, r) => s + r.value, 0), unpriced })
    } catch (err) {
      if (!horizonReq.isCurrent(reqKey)) return
      setIngredients({ loading: false, error: err, rows: [], totalValue: 0, unpriced: 0 })
    }
  }, [scopedFrom, horizonReq])

  const loadStored = useCallback(async () => {
    if (!clientId) return
    const reqKey = `${clientId}:${horizon}`
    horizonReq.begin(reqKey)
    setLoading(true)
    setLoadError(null)
    setExpandedIdx(null)
    const results = await Promise.all([
      scopedFrom('demand_forecast_daily')
        .eq('horizon_days', horizon)
        .order('bs_year').order('bs_month').order('bs_day'),
      scopedFrom('demand_forecast_run_log')
        .order('run_at', { ascending: false }).limit(1),
    ])
    if (!horizonReq.isCurrent(reqKey)) return
    // A failed read must not wear the "no forecast yet — click Recompute" empty state (S612).
    const failed = firstError(results)
    if (failed) { setLoadError(failed); setForecast([]); setLoading(false); return }
    const [{ data: rows }, { data: runs }] = results
    setLastRun(runs?.[0] || null)

    // Reshape stored rows (one covers-level row + N recipe-level rows per day) back into the
    // same per-day shape the recompute path already produces, so the table renders identically
    // whether its data came from a fresh run or a prior one.
    const byDay = {}
    for (const r of (rows || [])) {
      const key = `${r.bs_year}:${r.bs_month}:${r.bs_day}`
      const day = byDay[key] = byDay[key] || {
        bs: { year: r.bs_year, month: r.bs_month, day: r.bs_day },
        forecastCovers: null, forecastRevenue: null, revenueEstimated: false, forecastQtyByRecipe: {}, holiday: null,
        sampleCount: null, posSampleCount: null,
      }
      if (r.recipe_id) day.forecastQtyByRecipe[r.recipe_id] = parseFloat(r.forecast_qty) || 0
      else {
        day.forecastCovers = r.forecast_covers; day.forecastRevenue = r.forecast_revenue; day.revenueEstimated = r.revenue_estimated
        day.holiday = r.holiday_name ? { name: r.holiday_name, multiplier: r.holiday_multiplier } : null
        day.sampleCount = r.sample_count ?? null; day.posSampleCount = r.pos_sample_count ?? null
      }
    }
    const list = Object.values(byDay).sort((a, b) => a.bs.year - b.bs.year || a.bs.month - b.bs.month || a.bs.day - b.bs.day)
    setForecast(list)

    const recipeIds = [...new Set(list.flatMap(d => Object.keys(d.forecastQtyByRecipe)))]
    if (recipeIds.length > 0) {
      const { data: recs } = await fetchAllRowsChunked(recipeIds, ids => scopedFrom('recipes', 'id, name').in('id', ids).order('id'))
      if (!horizonReq.isCurrent(reqKey)) return
      setRecipeNames(Object.fromEntries((recs || []).map(r => [r.id, r.name])))
    }
    setLoading(false)
    loadIngredients(list, reqKey)
  }, [clientId, horizon, scopedFrom, horizonReq, loadIngredients])

  useEffect(() => { loadStored() }, [loadStored])

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  const horizonLabel = horizon === 7 ? 'Next 7 Days' : 'Next 30 Days'

  function handlePrint() {
    printWithTitle(`${bizInfo.name ? bizInfo.name + ' - ' : ''}Demand Forecast - ${horizonLabel}`)
  }

  async function handleRecompute() {
    setRecomputing(true); setMsg('')
    try {
      await runForecast(clientId, horizon)
      setMsg('ok:Forecast rebuilt from your sales history.')
      await loadStored()
    } catch (err) {
      setMsg('error:' + errorText(err, 'operator') + ' The figures below are from the last forecast that ran, not a new one.')
    }
    setRecomputing(false)
  }

  async function handleExport() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const ingRows = ingredients.rows.map(r => ({
      'Item': r.name, 'Category': r.category, 'Unit': r.uom,
      [`Forecast use (${horizonLabel.toLowerCase()})`]: parseFloat(r.qty.toFixed(3)),
      'Unit Rate (NPR)': r.rate || '',
      'Value (NPR)': r.rate ? Math.round(r.value) : '',
      'Status': r.inactive ? 'Inactive item' : '',
    }))
    const wsIng = XLSX.utils.json_to_sheet(ingRows)
    wsIng['!cols'] = [26, 16, 8, 18, 14, 12, 14].map(w => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, wsIng, 'Ingredients')
    const dishRows = []
    for (const f of forecast) {
      const { plates, occasional } = splitDishList(Object.entries(f.forecastQtyByRecipe))
      for (const p of plates) dishRows.push({ 'Date (BS)': bsLabel(f), 'Day': WEEKDAYS[dayOf(f)], 'Dish': recipeNames[p.recipeId] || p.recipeId, 'Plates': p.plates, 'Average / day': parseFloat(p.qty.toFixed(2)), 'Occasional': '' })
      for (const o of occasional) dishRows.push({ 'Date (BS)': bsLabel(f), 'Day': WEEKDAYS[dayOf(f)], 'Dish': recipeNames[o.recipeId] || o.recipeId, 'Plates': '', 'Average / day': parseFloat(o.qty.toFixed(2)), 'Occasional': 'yes' })
    }
    const wsDish = XLSX.utils.json_to_sheet(dishRows)
    wsDish['!cols'] = [16, 6, 30, 8, 14, 10].map(w => ({ wch: w }))
    XLSX.utils.book_append_sheet(wb, wsDish, 'Dishes by Day')
    XLSX.writeFile(wb, `Demand_Forecast_${horizon}d.xlsx`)
  }

  const coversHeader = hasPos
    ? <Tip text="Average covers on this weekday, from closed POS bills. Scaled by the holiday multiplier where one is set." width={260}>Forecast Covers</Tip>
    : null

  return (
    <div>
      <SuiteGate featureKey="demand_forecast" featureLabel="Demand Forecast" requireModules={['ims']}>
      <style>{`
        @media print {
          @page { margin: 14mm 12mm; }
        }
      `}</style>

      {/* Print-only letterhead — replaces the app-navigation header/subtitle on the printed sheet */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{bizInfo.name}</div>
        {bizInfo.address && <div style={{ fontSize: 12 }}>{bizInfo.address}</div>}
        <div style={{ fontWeight: 700, fontSize: 14, marginTop: 8 }}>Demand Forecast — {horizonLabel}</div>
        <div style={{ fontSize: 11 }}>Generated: {new Date().toLocaleString()}</div>
      </div>

      <div className="page-header no-print">
        <h1 className="page-title">
          Demand Forecast <Tip text="Predicts per-dish plates, revenue and (with POS) covers for the days ahead, from the last 8 same-weekday days in your sales history, weighted so recent weeks count more. A simple, auditable model — not a trained AI — so you can see exactly why a number was predicted. Below the days, the same forecast is exploded into the raw ingredients it will consume." width={340}>ⓘ</Tip>
        </h1>
        <p className="page-subtitle">
          What each day ahead will sell, and what to buy for it — for prep and purchasing.
        </p>
      </div>

      <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', marginBottom: 12 }}>
        <div className="tab-bar">
          <button className={`tab-btn${horizon === 7 ? ' tab-btn--active' : ''}`} onClick={() => setHorizon(7)}>Next 7 Days</button>
          <button className={`tab-btn${horizon === 30 ? ' tab-btn--active' : ''}`} onClick={() => setHorizon(30)}>Next 30 Days</button>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Tip text="Rebuilds the forecast from your latest sales data. Run this whenever you want an up-to-date prediction — it does not run automatically.">
            <button className="btn btn-primary" onClick={handleRecompute} disabled={recomputing}>
              {recomputing ? 'Recomputing…' : '↻ Recompute Forecast'}
            </button>
          </Tip>
          <button className="btn btn-ghost" onClick={handleExport} disabled={forecast.length === 0 || ingredients.loading}>📊 Export Excel</button>
          <button className="btn btn-ghost" onClick={handlePrint} disabled={forecast.length === 0}>🖨 Print</button>
        </div>
        {lastRun && (
          <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 'auto' }}>
            Last run: {new Date(lastRun.run_at).toLocaleString()}
            {lastRun.error ? <span style={{ color: 'var(--theme-red-text)' }}> — failed: {lastRun.error}</span> : ` (${lastRun.rows_written} rows)`}
          </span>
        )}
      </div>

      <p className="no-print" style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 20px' }}>
        {horizon === 30
          ? 'Days 8–30 repeat the weekly pattern learned from the last 8 weeks; only holiday multipliers differ between one Wednesday and the next. '
          : ''}
        {!hasPos && 'Covers are counted from POS bills. This outlet has no Crest POS, so the forecast is dishes and revenue only, with revenue priced at the current menu rather than measured.'}
      </p>

      {msg && <p className="no-print" style={{ color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)', fontSize: 13, marginBottom: 12 }}>{msg.replace(/^(error|ok):/, '')}</p>}

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Loading…</p></div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : forecast.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          No forecast yet for this horizon — click "Recompute Forecast" to generate one.
        </div>
      ) : (
        <>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Day</th>
                {hasPos && <th style={{ textAlign: 'right' }}>{coversHeader}</th>}
                <th style={{ textAlign: 'right' }}><Tip text="Before VAT — the same Revenue figure Owner Dashboard and Sales Entries use, so it can be compared with them and with the Labor Forecast's cost %." width={260}>Forecast Revenue</Tip></th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forecast.map((f, idx) => {
                const weekday = dayOf(f)
                const { plates, occasional } = splitDishList(Object.entries(f.forecastQtyByRecipe))
                const showingAll = expandedIdx === idx
                const visiblePlates = showingAll ? plates : plates.slice(0, PREVIEW_COUNT)
                const hiddenPlates = plates.length - visiblePlates.length
                const evidence = evidenceText(f)
                const nameOf = id => recipeNames[id] || id
                const avgTip = qty => `${qty.toFixed(1)} a day on average${evidence ? ', ' + evidence : ''}, recent weeks weighted more`
                const colSpan = hasPos ? 5 : 4
                return (
                  <Fragment key={idx}>
                    <tr>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)', whiteSpace: 'nowrap' }}>{bsLabel(f)}</td>
                      <td>
                        {WEEKDAYS[weekday]}
                        {evidence && <div style={{ fontSize: 10, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>{evidence}</div>}
                      </td>
                      {hasPos && (
                        <td style={{ textAlign: 'right' }}>
                          {f.forecastCovers != null ? Math.round(f.forecastCovers)
                            : <Tip text="No closed POS bills on this weekday in the last 12 weeks — the dishes came from manual Sales Entries, which carry no covers.">—</Tip>}
                        </td>
                      )}
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {f.revenueEstimated
                          ? <Tip text="Estimated: forecast dishes × current menu price, before VAT. This weekday's history has no POS bills to measure revenue from, so it is priced rather than measured." width={260}>≈ {fmtNpr(f.forecastRevenue)}</Tip>
                          : fmtNpr(f.forecastRevenue)}
                      </td>
                      <td>{f.holiday && (
                        f.holiday.multiplier != null
                          ? <Tip text={`Adjusted ×${f.holiday.multiplier} for ${f.holiday.name} — set in Holiday Calendar. Covers, revenue, and item quantities above already reflect this.`}><span className="badge badge-yellow">{f.holiday.name} ×{f.holiday.multiplier}</span></Tip>
                          : <Tip text={`No demand multiplier set for ${f.holiday.name} in Holiday Calendar — this forecast is NOT adjusted for it. Treat it as a floor, not a ceiling, on a festival day.`}><span className="badge badge-amber">⚠ {f.holiday.name}</span></Tip>
                      )}</td>
                    </tr>
                    {(plates.length > 0 || occasional.length > 0) && (
                      <tr>
                        <td colSpan={colSpan} style={{ padding: '2px 12px 10px', borderTop: 'none' }}>
                          {/* Whole plates to prep. The raw average sits on hover — 0.8 was being read as a
                              portion size, and nobody makes 0.8 of a toast (S694). */}
                          <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--theme-text3)', alignItems: 'baseline' }}>
                            {visiblePlates.map(p => (
                              <Tip key={p.recipeId} text={avgTip(p.qty)} width={240}>
                                <span>{nameOf(p.recipeId)}: <strong style={{ color: 'var(--theme-text2)' }}>{p.plates}</strong></span>
                              </Tip>
                            ))}
                            {!showingAll && (hiddenPlates > 0 || occasional.length > 0) && (
                              <button type="button" className="btn-linklike" onClick={() => setExpandedIdx(idx)}>
                                {hiddenPlates > 0 ? `+${hiddenPlates} more dish${hiddenPlates === 1 ? '' : 'es'}` : ''}
                                {hiddenPlates > 0 && occasional.length > 0 ? ' · ' : ''}
                                {occasional.length > 0 ? `${occasional.length} occasional` : ''}
                              </button>
                            )}
                            {showingAll && (
                              <button type="button" className="btn-linklike" onClick={() => setExpandedIdx(null)}>show less</button>
                            )}
                          </div>
                          {showingAll && occasional.length > 0 && (
                            <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 11, color: 'var(--theme-text3)', marginTop: 6, alignItems: 'baseline' }}>
                              <Tip text={`Sold on fewer than one ${WEEKDAYS_FULL[weekday]} in two — under ${OCCASIONAL_THRESHOLD} a day on average. Worth having the ingredients for, not worth prepping a plate of.`} width={260}>
                                <span style={{ fontStyle: 'italic' }}>Occasional:</span>
                              </Tip>
                              {occasional.map(o => (
                                <Tip key={o.recipeId} text={avgTip(o.qty)} width={240}>
                                  <span>{nameOf(o.recipeId)} <span style={{ opacity: 0.8 }}>({o.qty.toFixed(1)}/day)</span></span>
                                </Tip>
                              ))}
                            </div>
                          )}
                          {/* Print always shows the complete list regardless of on-screen expand state —
                              a printed sheet is a static snapshot, not an interactive session. */}
                          {/* Global .print-only forces display:block!important on print, so flex-gap
                              won't apply here — spans get their own right-margin as a fallback. */}
                          <div className="print-only" style={{ fontSize: 11 }}>
                            {plates.map(p => (
                              <span key={p.recipeId} style={{ marginRight: 14 }}>{nameOf(p.recipeId)}: <strong>{p.plates}</strong> <span style={{ opacity: 0.7 }}>({p.qty.toFixed(1)})</span></span>
                            ))}
                            {occasional.length > 0 && (
                              <div style={{ marginTop: 4 }}>
                                <em>Occasional:</em>{' '}
                                {occasional.map(o => (
                                  <span key={o.recipeId} style={{ marginRight: 14 }}>{nameOf(o.recipeId)} ({o.qty.toFixed(1)})</span>
                                ))}
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={{ marginTop: 32 }}>
          <h2 style={{ margin: '0 0 2px', fontSize: 18, color: 'var(--theme-text1)' }}>
            Ingredients to buy — {horizonLabel.toLowerCase()}{' '}
            <Tip text="Every dish above, multiplied through its recipe (and any sub-recipes, adjusted for yield) at the per-portion quantities in Recipe Costing, then summed per raw item for the whole horizon. This is what the forecast will consume — compare it against your last stock count or the Reorder Report before ordering; it does not know what is already on the shelf." width={340}>ⓘ</Tip>
          </h2>
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 12px' }}>
            Demand only, in each item's base unit, valued at the Item Master rate. Occasional dishes are included at their average, so a rarely-sold dish still puts a little of its ingredients on the list.
          </p>
          {ingredients.loading ? (
            <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13, margin: 0 }}>Working out ingredients…</p></div>
          ) : ingredients.error ? (
            <ReportLoadError error={ingredients.error} />
          ) : ingredients.rows.length === 0 ? (
            <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              None of the forecast dishes has ingredients in Recipe Costing yet, so there is nothing to explode.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Item</th><th>Category</th>
                    <th style={{ textAlign: 'right' }}><Tip text={`Total the forecast will use over the ${horizonLabel.toLowerCase()}, in the item's base unit.`}>Forecast use</Tip></th>
                    <th>Unit</th>
                    <th style={{ textAlign: 'right' }}><Tip text="Forecast use × the item's current per-unit rate from Item Master. A dash means the item has no rate yet." width={240}>≈ Value</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {ingredients.rows.map(r => (
                    <tr key={r.id}>
                      <td style={{ color: 'var(--theme-text1)' }}>
                        <span style={{ whiteSpace: 'nowrap' }}>{r.name}</span>
                        {r.inactive && <Tip text="This item is inactive in Item Master but a forecast dish still uses it — reactivate it or update the recipe."><span className="badge badge-amber" style={{ marginLeft: 6 }}>inactive</span></Tip>}
                      </td>
                      <td style={{ color: 'var(--theme-text2)' }}>{r.category}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtQty(r.qty)}</td>
                      <td style={{ color: 'var(--theme-text2)' }}>{r.uom}</td>
                      <td style={{ textAlign: 'right' }}>{r.rate ? npr(r.value) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {ingredients.rows.length} item{ingredients.rows.length === 1 ? '' : 's'}
                      {ingredients.unpriced > 0 && <span style={{ fontWeight: 400, color: 'var(--theme-text3)' }}> · {ingredients.unpriced} without a rate, not in the total</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)' }}>{npr(ingredients.totalValue)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
        </>
      )}
      </SuiteGate>
    </div>
  )
}
