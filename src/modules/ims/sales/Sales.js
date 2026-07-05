import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { getBsToday, daysInBsMonth } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']

export default function Sales() {
  const { clientId, profile, loading: authLoading, isAdmin } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [periods, setPeriods]       = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [recipes, setRecipes]       = useState([])
  const [sales, setSales]           = useState({}) // { recipe_id: qty } — bulk only, bs_day=0
  const [loading, setLoading]       = useState(true)
  const [bulkForm, setBulkForm]     = useState({})
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkSaved, setBulkSaved]   = useState(false)
  const [viewMode, setViewMode]     = useState('bulk') // bulk | summary
  const [sortBy, setSortBy]         = useState('rev_desc')
  const [selectedDay, setSelectedDay] = useState(1)
  const [dailySales, setDailySales] = useState({})
  const [dailyForm, setDailyForm]   = useState({})
  const [dailySaving, setDailySaving] = useState(false)
  const [dailySaved, setDailySaved]   = useState(false)
  const [allDaySums, setAllDaySums]   = useState({}) // recipe_id -> total qty across all days
  const [monthlyEntries, setMonthlyEntries] = useState([])
  const [monthlyLoading, setMonthlyLoading] = useState(false)

  useEffect(() => { if (!authLoading && effectiveClientId) init() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedPeriod) return
    const today = getBsToday()
    if (today.year === selectedPeriod.bs_year && today.month === selectedPeriod.bs_month) {
      setSelectedDay(today.day)
    } else {
      setSelectedDay(1)
    }
  }, [selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewMode === 'daily' && selectedPeriod) loadDailySales(selectedPeriod.id, selectedDay)
  }, [viewMode, selectedDay, selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (viewMode === 'breakdown' && selectedPeriod) loadMonthlyEntries(selectedPeriod.id)
  }, [viewMode, selectedPeriod]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)
    const [{ data: p }, { data: r }] = await Promise.all([
      supabase.from('monthly_periods').select('*').eq('client_id', effectiveClientId).order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      supabase.from('recipes').select('*').eq('client_id', effectiveClientId).eq('is_active', true).neq('category', 'Sub-Recipe').order('name')
    ])
    setPeriods(p || [])
    setRecipes(r || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) { setSelectedPeriod(open); await Promise.all([loadSales(open.id), loadAllDaySums(open.id)]) }
    setLoading(false)
  }

  async function loadSales(periodId) {
    const { data } = await supabase
      .from('sales_entries')
      .select('*')
      .eq('period_id', periodId)
      .eq('bs_day', 0) // bulk entries only
    const map = {}
    ;(data || []).forEach(s => {
      map[s.recipe_id] = parseFloat(s.qty_sold) || 0
    })
    setSales(map)
    setBulkForm({}) // reset form so it reads from DB
  }

  async function loadDailySales(periodId, day) {
    const { data } = await supabase
      .from('sales_entries').select('*')
      .eq('period_id', periodId).eq('bs_day', day)
    const map = {}
    ;(data || []).forEach(s => { map[s.recipe_id] = parseFloat(s.qty_sold) || 0 })
    setDailySales(map)
    setDailyForm({})
  }

  async function loadAllDaySums(periodId) {
    const { data } = await supabase
      .from('sales_entries').select('recipe_id, qty_sold').eq('period_id', periodId)
    const agg = {}
    ;(data || []).forEach(e => { agg[e.recipe_id] = (agg[e.recipe_id] || 0) + (parseFloat(e.qty_sold) || 0) })
    setAllDaySums(agg)
  }

  async function loadMonthlyEntries(periodId) {
    setMonthlyLoading(true)
    const { data } = await supabase
      .from('sales_entries').select('recipe_id, bs_day, qty_sold').eq('period_id', periodId)
    setMonthlyEntries(data || [])
    setMonthlyLoading(false)
  }

  async function saveDaily() {
    if (!selectedPeriod) return
    setDailySaving(true)
    const merged = {}
    recipes.forEach(r => {
      const saved = dailySales[r.id] || 0
      const raw = dailyForm[r.id]
      const typed = raw !== undefined ? (raw === '' ? 0 : parseFloat(raw)) : null
      merged[r.id] = (typed !== null && !isNaN(typed)) ? typed : saved
    })
    await supabase.from('sales_entries').delete().eq('period_id', selectedPeriod.id).eq('bs_day', selectedDay)
    const inserts = recipes
      .filter(r => (merged[r.id] || 0) > 0)
      .map(r => ({ period_id: selectedPeriod.id, recipe_id: r.id, bs_day: selectedDay, qty_sold: merged[r.id] }))
    if (inserts.length > 0) {
      const { error } = await supabase.from('sales_entries').insert(inserts)
      if (error) { console.error('Daily save error:', error.message); setDailySaving(false); return }
    }
    setDailySaving(false)
    setDailySaved(true)
    setTimeout(() => setDailySaved(false), 2500)
    await Promise.all([loadDailySales(selectedPeriod.id, selectedDay), loadAllDaySums(selectedPeriod.id)])
  }

  async function handlePeriodChange(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    await Promise.all([loadSales(periodId), loadAllDaySums(periodId)])
  }

  function getQty(recipeId) {
    if (bulkForm[recipeId] !== undefined) return bulkForm[recipeId]
    const saved = sales[recipeId]
    return saved > 0 ? String(saved) : ''
  }

  async function saveBulk() {
    if (!selectedPeriod) return
    setBulkSaving(true)

    // Merge: saved DB values as base, typed bulkForm values as override
    const merged = {}
    recipes.forEach(r => {
      const saved = sales[r.id] || 0
      const typed = bulkForm[r.id] !== undefined ? parseFloat(bulkForm[r.id]) : null
      merged[r.id] = typed !== null ? typed : saved
    })

    // Delete all existing bulk rows for this period, then re-insert
    await supabase.from('sales_entries')
      .delete()
      .eq('period_id', selectedPeriod.id)
      .eq('bs_day', 0)

    const inserts = recipes
      .filter(r => (merged[r.id] || 0) > 0)
      .map(r => ({
        period_id: selectedPeriod.id,
        recipe_id: r.id,
        bs_day: 0,
        qty_sold: merged[r.id]
      }))

    if (inserts.length > 0) {
      const { error } = await supabase.from('sales_entries').insert(inserts)
      if (error) {
        console.error('Bulk save error:', error.message)
        setBulkSaving(false)
        return
      }
    }

    setBulkSaving(false)
    setBulkSaved(true)
    setTimeout(() => setBulkSaved(false), 2500)
    await Promise.all([loadSales(selectedPeriod.id), loadAllDaySums(selectedPeriod.id)])
  }

  // Totals
  function getQtyNum(recipeId) {
    return parseFloat(bulkForm[recipeId] ?? sales[recipeId]) || 0
  }
  function getRevenue(recipe) {
    return getQtyNum(recipe.id) * (parseFloat(recipe.selling_price) || 0)
  }

  const totalQty     = recipes.reduce((s, r) => s + getQtyNum(r.id), 0)
  const totalRevenue = recipes.reduce((s, r) => s + getRevenue(r), 0)
  const itemsWithSales = recipes.filter(r => getQtyNum(r.id) > 0).length

  const sortedRecipes = [...recipes].sort((a, b) => {
    switch (sortBy) {
      case 'rev_desc':   return getRevenue(b) - getRevenue(a)
      case 'rev_asc':    return getRevenue(a) - getRevenue(b)
      case 'qty_desc':   return getQtyNum(b.id) - getQtyNum(a.id)
      case 'qty_asc':    return getQtyNum(a.id) - getQtyNum(b.id)
      case 'price_desc': return (parseFloat(b.selling_price) || 0) - (parseFloat(a.selling_price) || 0)
      case 'price_asc':  return (parseFloat(a.selling_price) || 0) - (parseFloat(b.selling_price) || 0)
      default:           return 0
    }
  })

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Sales Entry</h1>
          <p className="page-subtitle">Period total sales per menu item — {periodLabel}</p>
        </div>
        <select
          style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
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


      {/* Period locked banner */}
      {isLocked && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red)' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}
      {/* Stat cards */}
      <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Covers</div>
          <div className="stat-value">{totalQty.toLocaleString()}</div>
          <div className="stat-sub">Items sold this period</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items with Sales</div>
          <div className="stat-value">{itemsWithSales}</div>
          <div className="stat-sub">of {recipes.length} active recipes</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Total ex-VAT revenue for the period = sum of (Qty Sold × Selling Price) across all items. Used as the denominator for Food Cost %." width={280}>Period Revenue</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 18 }}>
            NPR {totalRevenue.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
          </div>
          <div className="stat-sub">Excl. VAT</div>
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid var(--theme-border)', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { key: 'bulk',      label: 'Bulk Entry' },
            { key: 'daily',     label: 'Daily Entry' },
            { key: 'breakdown', label: 'Daily Breakdown' },
            { key: 'summary',   label: 'Period Summary' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setViewMode(key)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 20px', fontSize: 13, fontWeight: 500,
              color: viewMode === key ? 'var(--theme-accent)' : 'var(--theme-text2)',
              borderBottom: viewMode === key ? '2px solid var(--theme-accent)' : '2px solid transparent',
              marginBottom: -1, transition: 'color 0.12s'
            }}>{label}</button>
          ))}
        </div>
        {viewMode === 'summary' && (
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', marginBottom: 6 }}
          >
            <option value="rev_desc">Highest Revenue</option>
            <option value="rev_asc">Lowest Revenue</option>
            <option value="qty_desc">Highest Qty Sold</option>
            <option value="qty_asc">Lowest Qty Sold</option>
            <option value="price_desc">Highest Selling Price</option>
            <option value="price_asc">Lowest Selling Price</option>
          </select>
        )}
      </div>

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
      ) : (
        <>
          {/* BULK ENTRY */}
          {viewMode === 'bulk' && (
            <>
              <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent)' }}>
                Enter total qty sold for the entire period per menu item. Sub-recipes are excluded.
              </div>
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
                    Period total — <strong style={{ color: 'var(--theme-accent)' }}>{periodLabel}</strong>
                  </span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-ghost"
                      disabled={isLocked}
                      onClick={() => {
                        if (!window.confirm('Clear all qty sold fields? This does not delete saved data until you Save.')) return
                        const cleared = {}
                        recipes.forEach(r => { cleared[r.id] = '' })
                        setBulkForm(cleared)
                      }}
                      style={{ fontSize: 13, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
                    >
                      Clear All
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={saveBulk}
                      disabled={bulkSaving || isLocked}
                    >
                      {bulkSaving ? 'Saving…' : bulkSaved ? '✓ Saved' : 'Save'}
                    </button>
                  </div>
                </div>
                {recipes.length === 0 ? (
                  <div className="empty-state">
                    <p className="empty-state-text">No active recipes. Add recipes in Recipe Costing first.</p>
                  </div>
                ) : (
                  <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Menu Item</th>
                        <th><Tip text="Recipe category — Food, Beverage, Dessert, etc. Filter by category using the tabs above." width={240}>Category</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Ex-VAT selling price per portion as set in Recipe Costing." width={230}>Selling Price</Tip></th>
                        <th style={{ textAlign: 'right', width: 160 }}><Tip text="Total portions sold across the entire period. Enter or edit in the Qty Sold column." width={240}>Total Qty Sold</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Total revenue = Qty Sold × Selling Price (ex-VAT). Used in food cost % and variance calculations." width={260}>Period Revenue</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRecipes.map(recipe => {
                        const qty = getQty(recipe.id)
                        const rev = (parseFloat(qty) || 0) * (parseFloat(recipe.selling_price) || 0)
                        return (
                          <tr key={recipe.id}>
                            <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{recipe.name}</td>
                            <td><span className="badge badge-yellow">{recipe.category}</span></td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                              {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toLocaleString()}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <input
                                type="number" min="0"
                                value={qty}
                                onChange={e => setBulkForm(f => ({ ...f, [recipe.id]: e.target.value }))}
                                placeholder="0"
                                disabled={isLocked}
                                style={{
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 5, padding: '6px 10px', fontSize: 13,
                                  color: 'var(--theme-text1)', outline: 'none', width: 110, textAlign: 'right',
                                  borderColor: parseFloat(qty) > 0 ? 'rgba(201,168,76,0.4)' : 'var(--theme-border)'
                                }}
                              />
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', fontWeight: rev > 0 ? 600 : 400 }}>
                              {rev > 0 ? `NPR ${rev.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                )}
              </div>
            </>
          )}

          {/* DAILY ENTRY */}
          {viewMode === 'daily' && (
            <>
              <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent)' }}>
                Enter qty sold per menu item for a single day. Use Bulk Entry for period totals instead.
              </div>
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>Day</span>
                    {(() => {
                      const dayCount = daysInBsMonth(selectedPeriod?.bs_year, selectedPeriod?.bs_month) || 32
                      const today = getBsToday()
                      const isCurrentMonth = selectedPeriod && today.year === selectedPeriod.bs_year && today.month === selectedPeriod.bs_month
                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <button
                              className="btn btn-ghost"
                              disabled={selectedDay <= 1}
                              onClick={() => setSelectedDay(d => Math.max(1, d - 1))}
                              style={{ padding: '4px 10px', fontSize: 14 }}
                            >‹</button>
                            <div style={{ width: 150 }}>
                              <BsCalendarPicker
                                lockYear={selectedPeriod?.bs_year}
                                lockMonth={selectedPeriod?.bs_month}
                                value={selectedDay}
                                onChange={v => setSelectedDay(Number(v))}
                                placeholder="Pick day"
                              />
                            </div>
                            <button
                              className="btn btn-ghost"
                              disabled={selectedDay >= dayCount}
                              onClick={() => setSelectedDay(d => Math.min(dayCount, d + 1))}
                              style={{ padding: '4px 10px', fontSize: 14 }}
                            >›</button>
                          </div>
                          {isCurrentMonth && selectedDay !== today.day && (
                            <button
                              className="btn btn-ghost"
                              onClick={() => setSelectedDay(today.day)}
                              style={{ fontSize: 11, padding: '4px 10px', color: 'var(--theme-accent)', borderColor: 'rgba(201,168,76,0.3)' }}
                            >Today (day {today.day})</button>
                          )}
                        </>
                      )
                    })()}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="btn btn-ghost"
                      disabled={isLocked}
                      onClick={() => setDailyForm(f => {
                        const cleared = {}
                        recipes.forEach(r => { cleared[r.id] = '' })
                        return cleared
                      })}
                      style={{ fontSize: 13, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
                    >Clear</button>
                    <button
                      className="btn btn-primary"
                      onClick={saveDaily}
                      disabled={dailySaving || isLocked}
                    >{dailySaving ? 'Saving…' : dailySaved ? '✓ Saved' : 'Save Day'}</button>
                  </div>
                </div>
                {recipes.length === 0 ? (
                  <div className="empty-state">
                    <p className="empty-state-text">No active recipes. Add recipes in Recipe Costing first.</p>
                  </div>
                ) : (
                  <>
                  {(() => {
                    let totQty = 0, totRev = 0
                    recipes.forEach(r => {
                      const raw = dailyForm[r.id] !== undefined ? dailyForm[r.id] : (dailySales[r.id] > 0 ? String(dailySales[r.id]) : '')
                      const q = parseFloat(raw) || 0
                      totQty += q
                      totRev += q * (parseFloat(r.selling_price) || 0)
                    })
                    return (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginBottom: 12, fontSize: 13, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--theme-text2)' }}>Total qty sold (Day {selectedDay}): <strong style={{ color: 'var(--theme-text1)' }}>{totQty.toLocaleString()}</strong></span>
                        <span style={{ color: 'var(--theme-text2)' }}>Day revenue: <strong style={{ color: 'var(--theme-accent)' }}>{totRev > 0 ? `NPR ${totRev.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}</strong></span>
                      </div>
                    )
                  })()}
                  <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Menu Item</th>
                        <th><Tip text="Recipe category — Food, Beverage, Dessert, etc." width={210}>Category</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Ex-VAT selling price per portion as set in Recipe Costing." width={230}>Selling Price</Tip></th>
                        <th style={{ textAlign: 'right', width: 160 }}><Tip text="Portions sold on this specific day. Saved separately from the monthly bulk total." width={250}>Qty Sold (Day {selectedDay})</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Revenue for this item on this day = Qty × Selling Price (ex-VAT)." width={240}>Day Revenue</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {recipes.map(recipe => {
                        const rawVal = dailyForm[recipe.id] !== undefined ? dailyForm[recipe.id] : (dailySales[recipe.id] > 0 ? String(dailySales[recipe.id]) : '')
                        const qty = parseFloat(rawVal) || 0
                        const rev = qty * (parseFloat(recipe.selling_price) || 0)
                        return (
                          <tr key={recipe.id}>
                            <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{recipe.name}</td>
                            <td><span className="badge badge-yellow">{recipe.category}</span></td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                              {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toLocaleString()}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <input
                                type="number" min="0"
                                value={rawVal}
                                onChange={e => setDailyForm(f => ({ ...f, [recipe.id]: e.target.value }))}
                                placeholder="0"
                                disabled={isLocked}
                                style={{
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 5, padding: '6px 10px', fontSize: 13,
                                  color: 'var(--theme-text1)', outline: 'none', width: 110, textAlign: 'right',
                                  borderColor: qty > 0 ? 'rgba(201,168,76,0.4)' : 'var(--theme-border)'
                                }}
                              />
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', fontWeight: rev > 0 ? 600 : 400 }}>
                              {rev > 0 ? `NPR ${rev.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                    <button
                      className="btn btn-ghost"
                      disabled={isLocked}
                      onClick={() => setDailyForm(f => {
                        const cleared = {}
                        recipes.forEach(r => { cleared[r.id] = '' })
                        return cleared
                      })}
                      style={{ fontSize: 13, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
                    >Clear</button>
                    <button
                      className="btn btn-primary"
                      onClick={saveDaily}
                      disabled={dailySaving || isLocked}
                    >{dailySaving ? 'Saving…' : dailySaved ? '✓ Saved' : 'Save Day'}</button>
                  </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* DAILY BREAKDOWN */}
          {viewMode === 'breakdown' && (() => {
            if (monthlyLoading) return <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
            if (monthlyEntries.length === 0) return (
              <div className="card">
                <div className="empty-state">
                  <div className="empty-state-icon">◈</div>
                  <p className="empty-state-text">No sales recorded yet for this period.</p>
                </div>
              </div>
            )

            // Build pivot: pivot[recipe_id][bs_day] = qty
            const pivot = {}
            for (const e of monthlyEntries) {
              if (!pivot[e.recipe_id]) pivot[e.recipe_id] = {}
              pivot[e.recipe_id][e.bs_day] = (pivot[e.recipe_id][e.bs_day] || 0) + (parseFloat(e.qty_sold) || 0)
            }

            // Days with data (excluding bulk bs_day=0), sorted
            const activeDays = [...new Set(monthlyEntries.filter(e => e.bs_day > 0).map(e => e.bs_day))].sort((a, b) => a - b)
            const hasBulk = monthlyEntries.some(e => e.bs_day === 0)

            // Recipes with any sales
            const activeRecipeIds = new Set(monthlyEntries.map(e => e.recipe_id))
            const activeRecipes = recipes.filter(r => activeRecipeIds.has(r.id))

            const today = getBsToday()
            const isCurrentMonth = selectedPeriod && today.year === selectedPeriod.bs_year && today.month === selectedPeriod.bs_month

            const colTotal = (day) => activeRecipes.reduce((s, r) => s + (pivot[r.id]?.[day] || 0), 0)
            const rowTotal = (recipeId) => Object.values(pivot[recipeId] || {}).reduce((s, v) => s + v, 0)
            const grandTotal = activeRecipes.reduce((s, r) => s + rowTotal(r.id), 0)

            const fmtQty = (n) => n > 0 ? n.toLocaleString() : <span style={{ color: 'var(--theme-border)' }}>—</span>

            return (
              <div className="card">
                <div className="table-wrap">
                  <table className="data-table" style={{ minWidth: 'max-content' }}>
                    <thead>
                      <tr>
                        <th style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', zIndex: 1, minWidth: 160 }}>Menu Item</th>
                        <th style={{ position: 'sticky', left: 160, background: 'var(--theme-bg)', zIndex: 1, minWidth: 90 }}>Category</th>
                        {activeDays.map(d => (
                          <th key={d} style={{ textAlign: 'right', minWidth: 56, color: isCurrentMonth && d === today.day ? 'var(--theme-accent)' : undefined }}>
                            {isCurrentMonth && d === today.day ? <span title="Today">⬤ {d}</span> : d}
                          </th>
                        ))}
                        {hasBulk && <th style={{ textAlign: 'right', minWidth: 70, color: 'var(--theme-text2)' }}>Bulk</th>}
                        <th style={{ textAlign: 'right', minWidth: 70, fontWeight: 700 }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeRecipes.map(recipe => {
                        const total = rowTotal(recipe.id)
                        return (
                          <tr key={recipe.id}>
                            <td style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', fontWeight: 600, color: 'var(--theme-text1)' }}>{recipe.name}</td>
                            <td style={{ position: 'sticky', left: 160, background: 'var(--theme-bg)' }}>
                              <span className="badge badge-yellow">{recipe.category}</span>
                            </td>
                            {activeDays.map(d => {
                              const qty = pivot[recipe.id]?.[d] || 0
                              return (
                                <td key={d} style={{ textAlign: 'right', color: qty > 0 ? 'var(--theme-text1)' : undefined }}>
                                  {fmtQty(qty)}
                                </td>
                              )
                            })}
                            {hasBulk && (
                              <td style={{ textAlign: 'right', color: (pivot[recipe.id]?.[0] || 0) > 0 ? 'var(--theme-text3)' : undefined }}>
                                {fmtQty(pivot[recipe.id]?.[0] || 0)}
                              </td>
                            )}
                            <td style={{ textAlign: 'right', fontWeight: 700, color: total > 0 ? 'var(--theme-accent)' : 'var(--theme-text2)' }}>
                              {total > 0 ? total.toLocaleString() : '—'}
                            </td>
                          </tr>
                        )
                      })}
                      <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                        <td style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', color: 'var(--theme-text2)', fontSize: 12 }} colSpan={2}>DAY TOTAL</td>
                        {activeDays.map(d => (
                          <td key={d} style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>
                            {colTotal(d) > 0 ? colTotal(d).toLocaleString() : '—'}
                          </td>
                        ))}
                        {hasBulk && (
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                            {(() => { const t = activeRecipes.reduce((s, r) => s + (pivot[r.id]?.[0] || 0), 0); return t > 0 ? t.toLocaleString() : '—' })()}
                          </td>
                        )}
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent)', fontSize: 15 }}>{grandTotal.toLocaleString()}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}

          {/* PERIOD SUMMARY */}
          {viewMode === 'summary' && (() => {
            const summaryRecipes = [...recipes].sort((a, b) => {
              const aqty = allDaySums[a.id] || 0
              const bqty = allDaySums[b.id] || 0
              const arev = aqty * (parseFloat(a.selling_price) || 0)
              const brev = bqty * (parseFloat(b.selling_price) || 0)
              switch (sortBy) {
                case 'rev_desc':   return brev - arev
                case 'rev_asc':    return arev - brev
                case 'qty_desc':   return bqty - aqty
                case 'qty_asc':    return aqty - bqty
                case 'price_desc': return (parseFloat(b.selling_price) || 0) - (parseFloat(a.selling_price) || 0)
                case 'price_asc':  return (parseFloat(a.selling_price) || 0) - (parseFloat(b.selling_price) || 0)
                default:           return 0
              }
            })
            const sumTotalQty = summaryRecipes.reduce((s, r) => s + (allDaySums[r.id] || 0), 0)
            const sumTotalRev = summaryRecipes.reduce((s, r) => s + (allDaySums[r.id] || 0) * (parseFloat(r.selling_price) || 0), 0)
            return (
              <div className="card">
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Menu Item</th>
                        <th>Category</th>
                        <th style={{ textAlign: 'right' }}>Total Sold</th>
                        <th style={{ textAlign: 'right' }}>Selling Price</th>
                        <th style={{ textAlign: 'right' }}><Tip text="Total revenue for this item = qty sold × selling price (ex-VAT). Used for variance and cost analysis.">Total Revenue</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="This item's share of total period revenue — highlights your top revenue contributors." width={240}>% of Revenue</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRecipes.map(recipe => {
                        const sold = allDaySums[recipe.id] || 0
                        const rev  = sold * (parseFloat(recipe.selling_price) || 0)
                        const revPct = sumTotalRev > 0 ? (rev / sumTotalRev) * 100 : 0
                        return (
                          <tr key={recipe.id} style={{ opacity: sold === 0 ? 0.4 : 1 }}>
                            <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{recipe.name}</td>
                            <td><span className="badge badge-yellow">{recipe.category}</span></td>
                            <td style={{ textAlign: 'right', color: sold > 0 ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>
                              {sold > 0 ? sold.toLocaleString() : '—'}
                            </td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                              {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toLocaleString()}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', fontWeight: 600 }}>
                              {rev > 0 ? `NPR ${rev.toLocaleString('en-NP', { maximumFractionDigits: 0 })}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {revPct > 0 ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                                  <div style={{ width: 60, height: 4, background: 'var(--theme-border)', borderRadius: 2 }}>
                                    <div style={{ width: `${Math.min(revPct, 100)}%`, height: '100%', background: 'var(--theme-accent)', borderRadius: 2 }} />
                                  </div>
                                  <span style={{ fontSize: 12, color: 'var(--theme-text2)', minWidth: 36 }}>{revPct.toFixed(1)}%</span>
                                </div>
                              ) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                      <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                        <td colSpan={2} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>Total</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>{sumTotalQty.toLocaleString()}</td>
                        <td></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>
                          NPR {sumTotalRev.toLocaleString('en-NP', { maximumFractionDigits: 0 })}
                        </td>
                        <td></td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}
        </>
      )}
    </div>
  )
}
