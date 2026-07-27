import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { getBsToday, daysInBsMonth } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import SalesImportButton from './SalesImportButton'
import { printWithTitle } from '../../../utils/printTitle'
import { persistSalesDay, findSupersededRows, SAVE_TIMEOUT_MS } from './persistSalesDay'
import SupersedeConfirmModal from './SupersedeConfirmModal'

const BS_MONTHS = ['Baisakh','Jestha','Ashadh','Shrawan','Bhadra','Ashwin','Kartik','Mangsir','Poush','Magh','Falgun','Chaitra']
// S454 added a pre-save `getSession()` probe on an 8s clock to diagnose a hang. It served its
// purpose and is deliberately GONE (S458): an 8s gate is *tighter* than the 15s cap that
// authFetchTimeout puts on the auth request underneath it, so a slow-but-perfectly-fine token
// refresh — 12.4s was measured on this very connection — tripped the probe and blocked the save
// with "your login session has stopped responding" when nothing was wrong with the session.
// A diagnostic that fails the operation it was meant to explain is worse than no diagnostic.
//
// What replaces it is not another check at save time but two things that remove the failure:
// startSessionKeepAlive() (AuthContext) tops the token up whenever the tab wakes, so a long
// data-entry session doesn't arrive at Save with an hour-old token; and persistSalesDay() renews
// and retries once if the token turns out to be expired anyway. The save itself can no longer
// hang regardless — withTimeout bounds it.
const TAB_LABELS = { bulk: 'Bulk Entry', daily: 'Daily Entry', breakdown: 'Daily Breakdown', summary: 'Period Summary' }

export default function Sales() {
  const { clientId, profile, loading: authLoading, isAdmin } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const [periods, setPeriods]       = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [recipes, setRecipes]       = useState([])
  const [sales, setSales]           = useState({}) // { recipe_id: qty } — bulk only, bs_day=0
  const [loading, setLoading]       = useState(true)
  const [bulkForm, setBulkForm]     = useState({})
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkSaved, setBulkSaved]   = useState(false)
  const [bulkSaveError, setBulkSaveError] = useState('')
  const [viewMode, setViewMode]     = useState('bulk') // bulk | summary
  const [sortBy, setSortBy]         = useState('rev_desc')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [menuSearch, setMenuSearch] = useState('') // Daily Entry / Daily Breakdown only
  const [onlyWithSales, setOnlyWithSales] = useState(false) // Bulk Entry / Daily Entry only
  const [selectedDay, setSelectedDay] = useState(1)
  const [dailySales, setDailySales] = useState({})
  const [dailyForm, setDailyForm]   = useState({})
  // Per-item discount (NPR) for this day — imported from the vendor Excel's Discount column, or
  // typed manually. Kept separate from unit_price (which stays a plain recipe-price snapshot) so
  // it's independently editable/auditable rather than silently baked into a price.
  const [dailyDiscounts, setDailyDiscounts] = useState({})
  const [discountForm, setDiscountForm]     = useState({})
  const [dailySaving, setDailySaving] = useState(false)
  const [dailySaved, setDailySaved]   = useState(false)
  const [dailySaveError, setDailySaveError] = useState('')
  const [allDaySums, setAllDaySums]   = useState({}) // recipe_id -> total qty across all days
  const [allDayDiscounts, setAllDayDiscounts] = useState({}) // recipe_id -> total discount across all days
  const [monthlyEntries, setMonthlyEntries] = useState([])
  const [monthlyLoading, setMonthlyLoading] = useState(false)
  // Set when a save is staged behind the typed-confirmation modal because it would delete the
  // opposite mode's rows: { mode, rows, superseded }. See findSupersededRows() (S457).
  const [pendingSave, setPendingSave] = useState(null)

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
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('recipes').eq('is_active', true).neq('category', 'Sub-Recipe').order('name')
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
    // Excludes comps (source='pos_comp') — a comped item was never actually sold, and this
    // page's every figure (including the Day revenue shown alongside it) means real sales.
    const { data } = await supabase
      .from('sales_entries').select('*')
      .eq('period_id', periodId).eq('bs_day', day).neq('source', 'pos_comp')
    const map = {}
    const discMap = {}
    ;(data || []).forEach(s => {
      map[s.recipe_id] = parseFloat(s.qty_sold) || 0
      discMap[s.recipe_id] = parseFloat(s.discount) || 0
    })
    setDailySales(map)
    setDailyForm({})
    setDailyDiscounts(discMap)
    setDiscountForm({})
  }

  async function loadAllDaySums(periodId) {
    const { data } = await supabase
      .from('sales_entries').select('recipe_id, qty_sold, discount').eq('period_id', periodId).neq('source', 'pos_comp')
    const agg = {}
    const discAgg = {}
    ;(data || []).forEach(e => {
      agg[e.recipe_id] = (agg[e.recipe_id] || 0) + (parseFloat(e.qty_sold) || 0)
      discAgg[e.recipe_id] = (discAgg[e.recipe_id] || 0) + (parseFloat(e.discount) || 0)
    })
    setAllDaySums(agg)
    setAllDayDiscounts(discAgg)
  }

  async function loadMonthlyEntries(periodId) {
    setMonthlyLoading(true)
    const { data } = await supabase
      .from('sales_entries').select('recipe_id, bs_day, qty_sold').eq('period_id', periodId).neq('source', 'pos_comp')
    setMonthlyEntries(data || [])
    setMonthlyLoading(false)
  }

  // Build the payload each mode would write. Kept separate from the save itself so the
  // "what will this delete?" precheck can run against the exact rows about to be sent.
  function buildDailyRows() {
    const merged = {}
    const mergedDiscount = {}
    recipes.forEach(r => {
      const saved = dailySales[r.id] || 0
      const raw = dailyForm[r.id]
      const typed = raw !== undefined ? (raw === '' ? 0 : parseFloat(raw)) : null
      merged[r.id] = (typed !== null && !isNaN(typed)) ? typed : saved

      const savedDisc = dailyDiscounts[r.id] || 0
      const rawDisc = discountForm[r.id]
      const typedDisc = rawDisc !== undefined ? (rawDisc === '' ? 0 : parseFloat(rawDisc)) : null
      mergedDiscount[r.id] = (typedDisc !== null && !isNaN(typedDisc)) ? typedDisc : savedDisc
    })
    // unit_price/vat_rate snapshot the recipe's price at entry time — manual entry has no other
    // price source, but capturing it now is still far more stable than every report joining the
    // recipe's CURRENT price at view time (which used to silently reprice past periods' revenue
    // whenever a menu price changed later). discount is the per-day/per-item NPR reduction (from
    // the vendor Excel import or typed manually) — kept as its own column rather than folded into
    // unit_price so it stays a separately editable, auditable figure.
    return recipes
      .filter(r => (merged[r.id] || 0) > 0)
      .map(r => ({
        recipe_id: r.id, qty_sold: merged[r.id],
        unit_price: parseFloat(r.selling_price) || 0, vat_rate: r.vat_rate,
        discount: mergedDiscount[r.id] || 0,
      }))
  }

  function buildBulkRows() {
    // Merge: saved DB values as base, typed bulkForm values as override
    const merged = {}
    recipes.forEach(r => {
      const saved = sales[r.id] || 0
      const typed = bulkForm[r.id] !== undefined ? parseFloat(bulkForm[r.id]) : null
      merged[r.id] = typed !== null ? typed : saved
    })
    // Bulk rows carry no discount of their own (Daily Entry owns that field), so the RPC's
    // COALESCE leaves it at the column default of 0 — same as the old insert did.
    return recipes
      .filter(r => (merged[r.id] || 0) > 0)
      .map(r => ({
        recipe_id: r.id, qty_sold: merged[r.id],
        unit_price: parseFloat(r.selling_price) || 0, vat_rate: r.vat_rate,
      }))
  }

  function saveErrorMessage(err) {
    // withTimeout's own message is already user-facing. postgrest-js converts an aborted fetch
    // into a returned {error} rather than a thrown AbortError, so that path arrives here as a
    // plain Error whose message we wrapped above — detect it by substring, not err.name.
    if (/abort/i.test(err.message || '')) return 'Save timed out — check your connection and try again.'
    return err.message || 'Failed to save — please try again.'
  }

  // Step 1 of a save: verify the session, build the payload, and find out what this save would
  // silently delete on the other side (Bulk vs Daily supersede each other per recipe, across the
  // whole period). Anything to delete → hand off to the typed-confirmation modal; otherwise commit
  // straight away. See findSupersededRows() for why this warning exists (S457).
  async function requestSave(mode) {
    if (!selectedPeriod) return
    const isBulk = mode === 'bulk'
    if (isBulk ? bulkSaving : dailySaving) return
    const setSaving = isBulk ? setBulkSaving : setDailySaving
    const setErr = isBulk ? setBulkSaveError : setDailySaveError

    setSaving(true)
    setErr('')
    const abortCtl = new AbortController()
    const timeoutId = setTimeout(() => abortCtl.abort(), SAVE_TIMEOUT_MS)
    let prepared = null
    try {
      const rows = isBulk ? buildBulkRows() : buildDailyRows()
      const superseded = rows.length
        ? await findSupersededRows(supabase, {
            periodId: selectedPeriod.id,
            bsDay: isBulk ? 0 : selectedDay,
            recipeIds: rows.map(r => r.recipe_id),
            signal: abortCtl.signal,
          })
        : { total: 0, byRecipe: [] }
      prepared = { rows, superseded }
    } catch (err) {
      console.error(`${mode} save precheck error:`, err)
      setErr(saveErrorMessage(err))
    } finally {
      clearTimeout(timeoutId)
      setSaving(false)
    }
    if (!prepared) return

    if (prepared.superseded.total > 0) {
      setPendingSave({ mode, rows: prepared.rows, superseded: prepared.superseded })
      return
    }
    await commitSave(mode, prepared.rows)
  }

  // Step 2: the write itself. Reached either directly (nothing to supersede) or from the modal.
  async function commitSave(mode, rows) {
    if (!selectedPeriod) return
    const isBulk = mode === 'bulk'
    const setSaving = isBulk ? setBulkSaving : setDailySaving
    const setErr = isBulk ? setBulkSaveError : setDailySaveError
    const setSaved = isBulk ? setBulkSaved : setDailySaved

    setSaving(true)
    setErr('')
    // The actual save (delete/insert/cleanup-delete) is wrapped in its own try/finally so
    // dailySaving always resets the moment the SAVE itself finishes — regardless of success or
    // thrown error. Found live (S449): with the reload below inside the same try/finally, a
    // hung reload query (e.g. a flaky connection) kept dailySaving stuck at true forever even
    // though the save had already succeeded — permanently disabling the Save Day button, since
    // nothing else ever sets dailySaving back to false. The post-save reload now runs in its own
    // separate try/catch, entirely outside what gates the button, so it can never block it again.
    // S453: even with the above, the button could still freeze forever if the DELETE/INSERT
    // request itself never settles — no error, no success, just a stalled connection (proxy,
    // VPN, flaky wifi) that the browser never times out on its own. abortSignal + a 20s
    // setTimeout guarantees the request always settles one way or the other, so `finally` below
    // is always reached and the button can never be stuck longer than 20s.
    // S454: abortSignal alone turned out NOT to be enough — supabase-js awaits auth.getSession()
    // BEFORE it ever calls fetch (fetchWithAuth, line 43 vs 70), so a hang in there means the
    // abort signal is attached to nothing and firing it does nothing at all. Every call is now
    // additionally raced against a wall clock via withTimeout(), which can't be defeated by a
    // promise that simply never settles. See src/utils/withTimeout.js for the full writeup.
    let saveSucceeded = false
    const abortCtl = new AbortController()
    const timeoutId = setTimeout(() => abortCtl.abort(), SAVE_TIMEOUT_MS)
    try {
      // One atomic RPC: delete + insert + cross-mode cleanup in a single transaction, so a stall
      // can no longer leave this day deleted with nothing written back (S456).
      await persistSalesDay(supabase, {
        periodId: selectedPeriod.id, bsDay: isBulk ? 0 : selectedDay, rows, signal: abortCtl.signal,
      })
      saveSucceeded = true
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch (err) {
      console.error(`${mode} save error:`, err)
      setErr(saveErrorMessage(err))
    } finally {
      clearTimeout(timeoutId)
      setSaving(false)
    }
    if (!saveSucceeded) return
    // Refresh the displayed data — best-effort. Both modes reload both maps, since a save in
    // either one may have just superseded rows belonging to the other. If this hangs or fails,
    // the save itself already succeeded; the table just won't reflect it until the next reload.
    try {
      const reloads = [loadAllDaySums(selectedPeriod.id), loadSales(selectedPeriod.id)]
      if (!isBulk) reloads.push(loadDailySales(selectedPeriod.id, selectedDay))
      await Promise.all(reloads)
    } catch (err) {
      console.error(`${mode} post-save reload error:`, err)
    }
  }

  async function confirmPendingSave() {
    const pending = pendingSave
    setPendingSave(null)
    if (pending) await commitSave(pending.mode, pending.rows)
  }

  // recipe_id → name, so the confirmation modal can name what it's about to delete.
  const recipeNames = recipes.reduce((m, r) => { m[r.id] = r.name; return m }, {})

  // From SalesImportButton — writes only into dailyForm/discountForm, the same local state the
  // manual qty/discount inputs below already use. Nothing is persisted until Save Day is clicked.
  function handleImportMatched(qtyMap, discountMap) {
    setDailyForm(f => {
      const next = { ...f }
      for (const [recipeId, qty] of qtyMap.entries()) next[recipeId] = String(qty)
      return next
    })
    if (discountMap && discountMap.size > 0) {
      setDiscountForm(f => {
        const next = { ...f }
        for (const [recipeId, discount] of discountMap.entries()) next[recipeId] = String(discount)
        return next
      })
    }
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

  // Daily Entry only — mirrors the dailyForm/dailySales fallback pattern used inline for qty.
  function getDailyDiscount(recipeId) {
    if (discountForm[recipeId] !== undefined) return discountForm[recipeId]
    const saved = dailyDiscounts[recipeId]
    return saved > 0 ? String(saved) : ''
  }

  function getDailyQty(recipeId) {
    if (dailyForm[recipeId] !== undefined) return dailyForm[recipeId]
    const saved = dailySales[recipeId]
    return saved > 0 ? String(saved) : ''
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

  const categories = [...new Set(recipes.map(r => r.category).filter(Boolean))].sort()

  // Daily Entry / Daily Breakdown only — a quick way to find one item among 90+ recipes. Totals
  // on those tabs still sum every recipe regardless of this filter; it only narrows which rows
  // are drawn, so it never looks like data quietly went missing from the day/period total.
  const menuSearchLc = menuSearch.trim().toLowerCase()
  const matchesMenuFilter = r =>
    (categoryFilter === 'all' || r.category === categoryFilter) &&
    (!menuSearchLc || r.name.toLowerCase().includes(menuSearchLc))

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'
  const tabPrintLabel = `${TAB_LABELS[viewMode]} — ${periodLabel}${viewMode === 'daily' ? `, Day ${selectedDay}` : ''}`

  return (
    <div>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Sales Entry</h1>
          <p className="page-subtitle">Period total sales per menu item — {periodLabel}</p>
          <p className="page-subtitle print-only" style={{ marginTop: 2 }}>{tabPrintLabel}</p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Sales Entry - ${tabPrintLabel}`)}>🖶 Print</button>
        </div>
      </div>


      {/* Period locked banner */}
      {isLocked && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red)' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}
      {/* Stat cards */}
      <div className="stat-grid no-print" style={{ gridTemplateColumns: 'repeat(3,1fr)', marginBottom: 20 }}>
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
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid var(--theme-border)', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {Object.entries(TAB_LABELS).map(([key, label]) => (
            <button key={key} onClick={() => setViewMode(key)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 20px', fontSize: 13, fontWeight: 500,
              color: viewMode === key ? 'var(--theme-accent)' : 'var(--theme-text2)',
              borderBottom: viewMode === key ? '2px solid var(--theme-accent)' : '2px solid transparent',
              marginBottom: -1, transition: 'color 0.12s'
            }}>{label}</button>
          ))}
        </div>
        {(viewMode === 'bulk' || viewMode === 'daily' || viewMode === 'breakdown' || viewMode === 'summary') && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {(viewMode === 'bulk' || viewMode === 'daily') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--theme-text2)', cursor: 'pointer', marginBottom: 6, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={onlyWithSales} onChange={e => setOnlyWithSales(e.target.checked)} />
                Only items with sales
              </label>
            )}
            {(viewMode === 'daily' || viewMode === 'breakdown') && (
              <div style={{ position: 'relative', marginBottom: 6 }}>
                <input
                  value={menuSearch}
                  onChange={e => setMenuSearch(e.target.value)}
                  placeholder="Search menu item…"
                  style={{ background: 'var(--theme-card)', border: `1px solid ${menuSearch ? 'rgba(201,168,76,0.5)' : 'var(--theme-border)'}`, borderRadius: 6, padding: '6px 10px 6px 28px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', width: 170, display: 'block' }}
                />
                <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--theme-text2)', pointerEvents: 'none' }}>🔍</span>
                {menuSearch && (
                  <button onClick={() => setMenuSearch('')} title="Clear"
                    style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
                )}
              </div>
            )}
            {(viewMode === 'daily' || viewMode === 'breakdown' || viewMode === 'summary') && (
              <select
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '6px 10px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', marginBottom: 6 }}
              >
                <option value="all">All Categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
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
        )}
      </div>

      {loading ? (
        <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
      ) : (
        <>
          {/* BULK ENTRY */}
          {viewMode === 'bulk' && (
            <>
              <div className="no-print" style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent)' }}>
                Enter total qty sold for the entire period per menu item. Sub-recipes are excluded.
              </div>
              <div className="card">
                <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
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
                      onClick={() => requestSave('bulk')}
                      disabled={bulkSaving || isLocked}
                    >
                      {bulkSaving ? 'Saving…' : bulkSaved ? '✓ Saved' : 'Save'}
                    </button>
                  </div>
                </div>
                {bulkSaveError && (
                  <div className="no-print" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 6, padding: '8px 12px', marginBottom: 16, fontSize: 12.5, color: 'var(--theme-red)' }}>
                    ⚠ {bulkSaveError}
                  </div>
                )}
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
                      {sortedRecipes.filter(r => !onlyWithSales || getQtyNum(r.id) > 0).length === 0 && (
                        <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: '16px 0' }}>No items with sales entered yet.</td></tr>
                      )}
                      {sortedRecipes.filter(r => !onlyWithSales || getQtyNum(r.id) > 0).map(recipe => {
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
              <div className="no-print" style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent)' }}>
                Enter qty sold per menu item for a single day. Use Bulk Entry for period totals instead.
              </div>
              <div className="card">
                <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
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
                              aria-label="Previous day"
                              disabled={selectedDay <= 1}
                              onClick={() => setSelectedDay(d => Math.max(1, d - 1))}
                              style={{ padding: '8px 12px', fontSize: 14 }}
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
                              aria-label="Next day"
                              disabled={selectedDay >= dayCount}
                              onClick={() => setSelectedDay(d => Math.min(dayCount, d + 1))}
                              style={{ padding: '8px 12px', fontSize: 14 }}
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
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <SalesImportButton recipes={recipes} disabled={isLocked} onMatched={handleImportMatched} />
                    <button
                      className="btn btn-ghost"
                      disabled={isLocked}
                      onClick={() => {
                        const cleared = {}
                        recipes.forEach(r => { cleared[r.id] = '' })
                        setDailyForm(cleared)
                        setDiscountForm(cleared)
                      }}
                      style={{ fontSize: 13, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
                    >Clear</button>
                    <button
                      className="btn btn-primary"
                      onClick={() => requestSave('daily')}
                      disabled={dailySaving || isLocked}
                    >{dailySaving ? 'Saving…' : dailySaved ? '✓ Saved' : 'Save Day'}</button>
                  </div>
                </div>
                {dailySaveError && (
                  <div className="no-print" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 6, padding: '8px 12px', marginBottom: 16, fontSize: 12.5, color: 'var(--theme-red)' }}>
                    ⚠ {dailySaveError}
                  </div>
                )}
                {recipes.length === 0 ? (
                  <div className="empty-state">
                    <p className="empty-state-text">No active recipes. Add recipes in Recipe Costing first.</p>
                  </div>
                ) : (
                  <>
                  {(() => {
                    let totQty = 0, totGross = 0, totDiscount = 0
                    recipes.forEach(r => {
                      const q = parseFloat(getDailyQty(r.id)) || 0
                      totQty += q
                      totGross += q * (parseFloat(r.selling_price) || 0)
                      totDiscount += parseFloat(getDailyDiscount(r.id)) || 0
                    })
                    const totRev = totGross - totDiscount
                    return (
                      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 24, marginBottom: 12, fontSize: 13, flexWrap: 'wrap' }}>
                        <span style={{ color: 'var(--theme-text2)' }}>Total qty sold (Day {selectedDay}): <strong style={{ color: 'var(--theme-text1)' }}>{totQty.toLocaleString()}</strong></span>
                        {totDiscount > 0 && (
                          <span style={{ color: 'var(--theme-text2)' }}>Total discount: <strong style={{ color: 'var(--theme-red)' }}>NPR {totDiscount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
                        )}
                        <span style={{ color: 'var(--theme-text2)' }}>Day revenue: <strong style={{ color: 'var(--theme-accent)' }}>{totRev > 0 ? `NPR ${totRev.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</strong></span>
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
                        <th style={{ textAlign: 'right', width: 130 }}><Tip text="NPR discount applied to this item on this day — e.g. staff discount, promo, or complimentary reduction. Subtracted from Day Revenue. Auto-filled by ↑ Import Excel from the report's Discount column, or type it in directly." width={280}>Discount</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Revenue for this item on this day = (Qty × Selling Price) − Discount, ex-VAT." width={260}>Day Revenue</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {recipes.filter(r => matchesMenuFilter(r) && (!onlyWithSales || parseFloat(getDailyQty(r.id)) > 0)).length === 0 && (
                        <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: '16px 0' }}>No menu items match this filter.</td></tr>
                      )}
                      {recipes.filter(r => matchesMenuFilter(r) && (!onlyWithSales || parseFloat(getDailyQty(r.id)) > 0)).map(recipe => {
                        const rawVal = getDailyQty(recipe.id)
                        const qty = parseFloat(rawVal) || 0
                        const discRaw = getDailyDiscount(recipe.id)
                        const disc = parseFloat(discRaw) || 0
                        const rev = qty * (parseFloat(recipe.selling_price) || 0) - disc
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
                            <td style={{ textAlign: 'right' }}>
                              <input
                                type="number" min="0"
                                value={discRaw}
                                onChange={e => setDiscountForm(f => ({ ...f, [recipe.id]: e.target.value }))}
                                placeholder="0"
                                disabled={isLocked}
                                style={{
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 5, padding: '6px 10px', fontSize: 13,
                                  color: 'var(--theme-text1)', outline: 'none', width: 100, textAlign: 'right',
                                  borderColor: disc > 0 ? 'rgba(248,113,113,0.4)' : 'var(--theme-border)'
                                }}
                              />
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', fontWeight: rev > 0 ? 600 : 400 }}>
                              {qty > 0 || disc > 0 ? `NPR ${rev.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                  <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                    <button
                      className="btn btn-ghost"
                      disabled={isLocked}
                      onClick={() => {
                        const cleared = {}
                        recipes.forEach(r => { cleared[r.id] = '' })
                        setDailyForm(cleared)
                        setDiscountForm(cleared)
                      }}
                      style={{ fontSize: 13, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
                    >Clear</button>
                    <button
                      className="btn btn-primary"
                      onClick={() => requestSave('daily')}
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

            // Recipes with any sales, narrowed by the Category/Search filter — totals below
            // (colTotal/grandTotal) are computed from this same filtered list, so they always
            // describe exactly what's on screen.
            const activeRecipeIds = new Set(monthlyEntries.map(e => e.recipe_id))
            const activeRecipes = recipes.filter(r => activeRecipeIds.has(r.id) && matchesMenuFilter(r))

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
                      {activeRecipes.length === 0 && (
                        <tr><td colSpan={2 + activeDays.length + (hasBulk ? 1 : 0) + 1} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: '16px 0' }}>No menu items match this filter.</td></tr>
                      )}
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
            const summaryRecipes = recipes
              .filter(r => categoryFilter === 'all' || r.category === categoryFilter)
              .sort((a, b) => {
                const aqty = allDaySums[a.id] || 0
                const bqty = allDaySums[b.id] || 0
                const arev = aqty * (parseFloat(a.selling_price) || 0) - (allDayDiscounts[a.id] || 0)
                const brev = bqty * (parseFloat(b.selling_price) || 0) - (allDayDiscounts[b.id] || 0)
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
            const sumTotalDiscount = summaryRecipes.reduce((s, r) => s + (allDayDiscounts[r.id] || 0), 0)
            const sumTotalRev = summaryRecipes.reduce((s, r) => s + (allDaySums[r.id] || 0) * (parseFloat(r.selling_price) || 0) - (allDayDiscounts[r.id] || 0), 0)
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
                        <th style={{ textAlign: 'right' }}><Tip text="Total discount applied across the period for this item (from Daily Entry, including any imported from the vendor Excel's Discount column)." width={260}>Discount</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Total revenue for this item = (qty sold × selling price) − discount, ex-VAT. Used for variance and cost analysis.">Total Revenue</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="This item's share of total period revenue — highlights your top revenue contributors." width={240}>% of Revenue</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRecipes.map(recipe => {
                        const sold = allDaySums[recipe.id] || 0
                        const disc = allDayDiscounts[recipe.id] || 0
                        const rev  = sold * (parseFloat(recipe.selling_price) || 0) - disc
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
                            <td style={{ textAlign: 'right', color: disc > 0 ? 'var(--theme-red)' : 'var(--theme-text3)' }}>
                              {disc > 0 ? `NPR ${disc.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', fontWeight: 600 }}>
                              {rev > 0 ? `NPR ${rev.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
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
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red)', paddingTop: 12 }}>
                          {sumTotalDiscount > 0 ? `NPR ${sumTotalDiscount.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)', fontSize: 15, paddingTop: 12 }}>
                          NPR {sumTotalRev.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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

      {pendingSave && (
        <SupersedeConfirmModal
          mode={pendingSave.mode}
          superseded={pendingSave.superseded}
          recipeNames={recipeNames}
          onCancel={() => setPendingSave(null)}
          onConfirm={confirmPendingSave}
        />
      )}
    </div>
  )
}
