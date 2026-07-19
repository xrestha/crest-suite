import { useState, useEffect, useCallback, Fragment } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { BS_MONTHS, bsToAd } from '../../../utils/bsCalendar'
import { runForecast } from '../../../utils/demandForecastData'
import { printWithTitle } from '../../../utils/printTitle'
import { Navigate } from 'react-router-dom'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const fmtNpr = n => n == null ? '—' : `NPR ${Math.round(n).toLocaleString()}`

export default function DemandForecast() {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom } = useScopedDb()
  const [horizon, setHorizon] = useState(7)
  const [forecast, setForecast] = useState([])
  const [recipeNames, setRecipeNames] = useState({})
  const [expandedItemsIdx, setExpandedItemsIdx] = useState(null) // which row's item preview is showing the FULL list instead of the top-3
  const [loading, setLoading] = useState(true)
  const [recomputing, setRecomputing] = useState(false)
  const [msg, setMsg] = useState('')
  const [lastRun, setLastRun] = useState(null)
  const [bizInfo, setBizInfo] = useState({ name: '', address: '' })

  useEffect(() => {
    if (!clientId) return
    Promise.all([
      supabase.from('clients').select('name').eq('id', clientId).single(),
      supabase.from('settings').select('property_address').eq('client_id', clientId).maybeSingle(),
    ]).then(([{ data: client }, { data: settings }]) => {
      setBizInfo({ name: client?.name || '', address: settings?.property_address || '' })
    })
  }, [clientId])

  const loadStored = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: rows }, { data: runs }] = await Promise.all([
      scopedFrom('demand_forecast_daily')
        .eq('horizon_days', horizon)
        .order('bs_year').order('bs_month').order('bs_day'),
      scopedFrom('demand_forecast_run_log')
        .order('run_at', { ascending: false }).limit(1),
    ])
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
      }
      if (r.recipe_id) day.forecastQtyByRecipe[r.recipe_id] = r.forecast_qty
      else {
        day.forecastCovers = r.forecast_covers; day.forecastRevenue = r.forecast_revenue; day.revenueEstimated = r.revenue_estimated
        day.holiday = r.holiday_name ? { name: r.holiday_name, multiplier: r.holiday_multiplier } : null
      }
    }
    const list = Object.values(byDay).sort((a, b) => a.bs.year - b.bs.year || a.bs.month - b.bs.month || a.bs.day - b.bs.day)
    setForecast(list)

    const recipeIds = [...new Set(list.flatMap(d => Object.keys(d.forecastQtyByRecipe)))]
    if (recipeIds.length > 0) {
      const { data: recs } = await scopedFrom('recipes', 'id, name').in('id', recipeIds)
      setRecipeNames(Object.fromEntries((recs || []).map(r => [r.id, r.name])))
    }
    setLoading(false)
  }, [clientId, horizon, scopedFrom])

  useEffect(() => { loadStored() }, [loadStored])

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  const horizonLabel = horizon === 7 ? 'Next 7 Days' : 'Next 30 Days'

  function handlePrint() {
    printWithTitle(`${bizInfo.name ? bizInfo.name + ' - ' : ''}Demand Forecast - ${horizonLabel}`)
  }

  async function handleRecompute() {
    setRecomputing(true); setMsg('')
    try {
      const { rowsWritten } = await runForecast(clientId, horizon)
      setMsg(`ok:Forecast recomputed — ${rowsWritten} rows written.`)
      await loadStored()
    } catch (err) {
      setMsg('error:' + (err.message || 'Recompute failed.'))
    }
    setRecomputing(false)
  }

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>
      <style>{`
        @media print {
          @page { margin: 14mm 12mm; }
        }
      `}</style>

      {/* Print-only letterhead — replaces the app-navigation header/subtitle on the printed sheet */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 16 }}>{bizInfo.name}</div>
        {bizInfo.address && <div style={{ fontSize: 12 }}>{bizInfo.address}</div>}
        <div style={{ fontWeight: 700, fontSize: 15, marginTop: 8 }}>Demand Forecast — {horizonLabel}</div>
        <div style={{ fontSize: 11 }}>Generated: {new Date().toLocaleString()}</div>
      </div>

      <div className="no-print" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>
          Demand Forecast <Tip text="Predicts covers, revenue, and per-dish quantity for upcoming days using a day-of-week moving average over your last ~12 weeks of POS sales (or manual Sales entries if POS history is thin). A simple, auditable model — not a trained AI — so you can see exactly why a number was predicted." width={320}>ⓘ</Tip>
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          What to expect tomorrow, next week, and the rest of the month — for purchasing and prep planning.
        </p>
      </div>

      <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', marginBottom: 20 }}>
        <div className="tab-bar">
          <button className={`tab-btn${horizon === 7 ? ' tab-btn--active' : ''}`} onClick={() => setHorizon(7)}>Next 7 Days</button>
          <button className={`tab-btn${horizon === 30 ? ' tab-btn--active' : ''}`} onClick={() => setHorizon(30)}>Next 30 Days</button>
        </div>
        <Tip text="Rebuilds the forecast from your latest sales data. Run this whenever you want an up-to-date prediction — it does not run automatically.">
          <button className="btn btn-primary" onClick={handleRecompute} disabled={recomputing}>
            {recomputing ? 'Recomputing…' : '↻ Recompute Forecast'}
          </button>
        </Tip>
        <button className="btn btn-ghost" onClick={handlePrint} disabled={forecast.length === 0}>🖨 Print</button>
        {lastRun && (
          <span style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
            Last run: {new Date(lastRun.run_at).toLocaleString()}
            {lastRun.error ? <span style={{ color: 'var(--theme-red)' }}> — failed: {lastRun.error}</span> : ` (${lastRun.rows_written} rows)`}
          </span>
        )}
      </div>

      {msg && <p className="no-print" style={{ color: msg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)', fontSize: 13, marginBottom: 12 }}>{msg.replace(/^(error|ok):/, '')}</p>}

      {loading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
      ) : forecast.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          No forecast yet for this horizon — click "Recompute Forecast" to generate one.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date (BS)</th><th>Day</th>
                <th style={{ textAlign: 'right' }}>Forecast Covers</th>
                <th style={{ textAlign: 'right' }}>Forecast Revenue</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {forecast.map((f, idx) => {
                const weekday = bsToAd(f.bs.year, f.bs.month, f.bs.day).getDay()
                const allItems = Object.entries(f.forecastQtyByRecipe).sort((a, b) => b[1] - a[1])
                const PREVIEW_COUNT = 3
                const showingAll = expandedItemsIdx === idx
                const visibleItems = showingAll ? allItems : allItems.slice(0, PREVIEW_COUNT)
                const hiddenCount = allItems.length - visibleItems.length
                return (
                  <Fragment key={idx}>
                    <tr>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{f.bs.day} {BS_MONTHS[f.bs.month - 1]} {f.bs.year}</td>
                      <td>{WEEKDAYS[weekday]}</td>
                      <td style={{ textAlign: 'right' }}>
                        {f.forecastCovers != null ? Math.round(f.forecastCovers)
                          : <Tip text="No POS bill history exists yet for this day of week — covers aren't tracked by manual Sales entries, so there's no signal to forecast from.">—</Tip>}
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>
                        {f.revenueEstimated
                          ? <Tip text="Estimated from forecasted item quantities × menu price — this day of week has no direct POS revenue history yet, only manual Sales entries (which track quantity, not revenue).">≈ {fmtNpr(f.forecastRevenue)}</Tip>
                          : fmtNpr(f.forecastRevenue)}
                      </td>
                      <td>{f.holiday && (
                        f.holiday.multiplier != null
                          ? <Tip text={`Adjusted ×${f.holiday.multiplier} for ${f.holiday.name} — set in Holiday Calendar. Covers, revenue, and item quantities above already reflect this.`}><span className="badge-amber" style={{ fontSize: 10 }}>{f.holiday.name} ×{f.holiday.multiplier}</span></Tip>
                          : <Tip text={`No demand multiplier set for ${f.holiday.name} in Holiday Calendar — this forecast is NOT adjusted for it. Treat it as a floor, not a ceiling, on a festival day.`}><span className="badge-amber" style={{ fontSize: 10 }}>{f.holiday.name}</span></Tip>
                      )}</td>
                    </tr>
                    {allItems.length > 0 && (
                      <tr>
                        <td colSpan={5} style={{ padding: '2px 12px 10px', borderTop: 'none' }}>
                          <div className="no-print" style={{ display: 'flex', flexWrap: 'wrap', gap: 10, fontSize: 11, color: 'var(--theme-text3)' }}>
                            {visibleItems.map(([recipeId, qty]) => (
                              <span key={recipeId}>{recipeNames[recipeId] || recipeId}: <strong style={{ color: 'var(--theme-text2)' }}>{qty.toFixed(1)}</strong></span>
                            ))}
                            {hiddenCount > 0 && (
                              <span style={{ cursor: 'pointer', color: 'var(--theme-accent)' }} onClick={() => setExpandedItemsIdx(idx)}>+{hiddenCount} more</span>
                            )}
                            {showingAll && allItems.length > PREVIEW_COUNT && (
                              <span style={{ cursor: 'pointer', color: 'var(--theme-accent)' }} onClick={() => setExpandedItemsIdx(null)}>show less</span>
                            )}
                          </div>
                          {/* Print always shows the complete item list regardless of on-screen
                              expand state — a printed sheet is a static snapshot, not an
                              interactive session. */}
                          {/* Global .print-only forces display:block!important on print, so flex-gap
                              won't apply here — spans get their own right-margin as a fallback. */}
                          <div className="print-only" style={{ fontSize: 11 }}>
                            {allItems.map(([recipeId, qty]) => (
                              <span key={recipeId} style={{ marginRight: 14 }}>{recipeNames[recipeId] || recipeId}: <strong>{qty.toFixed(1)}</strong></span>
                            ))}
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
      )}
    </div>
  )
}
