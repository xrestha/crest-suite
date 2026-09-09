import { useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { BS_MONTHS, getBsToday, daysInBsMonth, formatBsDay } from '../../../utils/bsCalendar'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import SalesImportButton from './SalesImportButton'
import { printWithTitle } from '../../../utils/printTitle'
import { persistSalesDay, findSupersededRows, depleteManualSales, SAVE_TIMEOUT_MS } from './persistSalesDay'
import { isManualSource } from './salesDepletion'
import SupersedeConfirmModal from './SupersedeConfirmModal'
import { readPageCache, writePageCache } from '../../../shared/sessionDataCache'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { firstError } from '../../../shared/queryError'
import { disabledStyle } from '../../../shared/inlineFieldState'
import ReportLoadError from '../../../components/ReportLoadError'

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
// The two tabs that WRITE. Disabled whenever POS is running (see posOwnsSales below); the other
// two are read-only views of whatever POS has already posted, so they stay available.
const ENTRY_TABS = ['bulk', 'daily']
const READ_ONLY_TAB = 'summary'

// `sales_entries.source` is nullable — DEFAULT 'manual', no NOT NULL — so every row written before
// the column had a default reads as NULL. A SERVER-side `.neq('source','pos_comp')` therefore drops
// those rows silently, because `NULL <> 'pos_comp'` is NULL rather than true. Both dashboards had
// this and both fixed it by selecting `source` and filtering in JS (ClientDashboard.jsx,
// OwnerDashboard.jsx); this page never got the sweep, and here it is worse than under-reporting.
// A legacy row missing from the grid is missing from the save payload too, and save_sales_day's
// delete covers `source IS NULL OR source = 'manual'` — so the next Save Day deletes the row the
// page never showed anyone. Every read below selects `source` and uses these two predicates.
const isComp = row => row.source === 'pos_comp'
// What Daily Entry shows in its locked "From POS" column: real till sales and the credit notes
// that reverse them. Comps are excluded here for the same reason they are excluded everywhere on
// this page — a comped dish was never sold, and every figure here means real sales.
const isPosRow = row => row.source === 'pos' || row.source === 'pos_credit'

export default function Sales() {
  const { clientId, profile, loading: authLoading, isAdmin, clientModules, hasImsAccess } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  // Manual Sales Entry exists for IMS clients who do NOT run POS. Where both modules are on, POS
  // is the source of truth and supersedes manual entry entirely — a bill closed at the till
  // already posts its own sales_entries row (source='pos'), so anything typed here is at best a
  // duplicate and at worst a contradiction of the till. Rather than let the two compete, the
  // writing tabs are closed off and the page becomes a read-only view of what POS posted.
  //
  // Admin is exempt, matching isLocked's own !isAdmin carve-out below — an admin correcting a
  // client's pre-POS manual history still needs the entry grids, and save_sales_day (migration
  // 20260727180000) now scopes every one of its deletes to source='manual', so an admin save can
  // no longer damage POS rows even on a client running both.
  const posOwnsSales = !isAdmin && !!clientModules?.pos
  const { scopedFrom } = useScopedDb()
  // periods/recipes only (the menu + period list) are cached for an instant revisit — deliberately
  // NOT the entered-quantity maps (sales/dailySales/etc. below), which a Save reads as the
  // "current" baseline to merge edits into. For a POS-enabled client, sales_entries keeps changing
  // in the background all day as bills close, so those must always reload fresh rather than risk
  // a stale cached number silently reaching a save. See conversation with Aashish (2026-07-27).
  const [periods, setPeriods]       = useState(() => readPageCache('sales', 'periods', effectiveClientId) ?? [])
  const periodReq = useLatestRequest()
  // A SECOND guard, keyed `${periodId}:${day}` (S601's rule, applied to the axis this page actually
  // races on). periodReq keys on the period id alone, so it cannot tell one day of a period from
  // another — and the Daily tab reloads on every ‹/› press. Two quick clicks start two loads; the
  // later-landing one wins `dailySales` while `selectedDay` shows whatever was clicked last, and
  // because `dailySales` is what buildDailyRows() merges as its baseline, Save Day then writes one
  // day's whole grid onto another day's `bs_day` — after save_sales_day has deleted what was there.
  // On a report an overlapping load is a flicker; on a write surface it is a wrong figure saved.
  const dayReq = useLatestRequest()
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [recipes, setRecipes]       = useState(() => readPageCache('sales', 'recipes', effectiveClientId) ?? [])
  const [sales, setSales]           = useState({}) // { recipe_id: qty } — bulk only, bs_day=0
  const [loading, setLoading]       = useState(true)
  // A failed sales read must not render as an empty grid: this page batch-saves what is on
  // screen, so a blank grid followed by Save writes zeros over real figures (S682).
  //
  // Keyed per loader rather than one shared slot. Five loaders write this and two of them
  // (loadSales + loadAllDaySums) run concurrently inside handlePeriodChange — so with one slot the
  // one that SUCCEEDED cleared the one that FAILED, and the page went back to rendering a confident
  // empty grid over a read that never landed. Each loader now only ever sets or clears its own key.
  const [loadErrors, setLoadErrors] = useState({})
  const noteLoad = (key, err) => setLoadErrors(prev => ({ ...prev, [key]: err || null }))
  const [bulkForm, setBulkForm]     = useState({})
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkSaved, setBulkSaved]   = useState(false)
  const [bulkSaveError, setBulkSaveError] = useState('')
  const [viewMode, setViewMode]     = useState('bulk') // bulk | summary
  const [sortBy, setSortBy]         = useState('rev_desc')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [menuSearch, setMenuSearch] = useState('') // all four tabs — narrows drawn rows only, never a save or a figure
  const [onlyWithSales, setOnlyWithSales] = useState(false) // Bulk Entry / Daily Entry only
  const [selectedDay, setSelectedDay] = useState(1)
  const [dailySales, setDailySales] = useState({})
  const [dailyForm, setDailyForm]   = useState({})
  // Per-item discount (NPR) for this day — imported from the vendor Excel's Discount column, or
  // typed manually. Kept separate from unit_price (which stays a plain recipe-price snapshot) so
  // it's independently editable/auditable rather than silently baked into a price.
  const [dailyDiscounts, setDailyDiscounts] = useState({})
  const [discountForm, setDiscountForm]     = useState({})
  // What the TILL sold on this day, held apart from the editable manual maps above and shown in a
  // locked column. `dailySales` used to carry every source, so on a POS client (admin only — the
  // tabs are closed to everyone else) the grid pre-filled with the till's own quantities and
  // buildDailyRows() handed them straight back as `source='manual'` rows. save_sales_day deletes
  // only manual rows, so the POS originals survived alongside the new copies and one Save Day
  // roughly doubled the day's revenue. The migration says resolving POS-vs-manual is the UI's job;
  // hiding the tabs is not that job for the one caller who can still reach them.
  const [posDaySales, setPosDaySales]         = useState({})
  const [posDayDiscounts, setPosDayDiscounts] = useState({})
  const [dailySaving, setDailySaving] = useState(false)
  const [dailySaved, setDailySaved]   = useState(false)
  const [dailySaveError, setDailySaveError] = useState('')
  const [allDaySums, setAllDaySums]   = useState({}) // recipe_id -> total qty across all days
  const [allDayDiscounts, setAllDayDiscounts] = useState({}) // recipe_id -> total discount across all days
  // Revenue is split into the part already priced by the row's own unit_price snapshot and the
  // qty on rows that have none (pre-S375 rows), so the recipe's CURRENT price is only ever used
  // as a fallback for the latter. See recipeRevenue() below.
  const [allDayPricedRev, setAllDayPricedRev] = useState({})   // recipe_id -> Sum(qty x unit_price)
  const [allDayUnpricedQty, setAllDayUnpricedQty] = useState({}) // recipe_id -> qty with no snapshot
  const [monthlyEntries, setMonthlyEntries] = useState([])
  const [monthlyLoading, setMonthlyLoading] = useState(false)
  // Set when a save is staged behind the typed-confirmation modal because it would delete the
  // opposite mode's rows: { mode, rows, superseded }. See findSupersededRows() (S457).
  const [pendingSave, setPendingSave] = useState(null)

  // Only wraps setPeriods/setRecipes below — deliberately not used for anything a save merges
  // against (see comment above the periods/recipes useState calls).
  function setAndCache(setter, section, value) {
    setter(value)
    writePageCache('sales', section, effectiveClientId, value)
  }

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

  // viewMode starts at 'bulk' and clientModules only resolves once the profile has loaded, so a
  // POS client's first render can legitimately land on a tab that is about to become disabled.
  // Move them off it rather than leaving a disabled tab rendered as the active one.
  useEffect(() => {
    if (posOwnsSales && ENTRY_TABS.includes(viewMode)) setViewMode(READ_ONLY_TAB)
  }, [posOwnsSales, viewMode])

  async function init() {
    setLoading(true)
    const results = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      // `.or(...)`, not `.neq('category','Sub-Recipe')` (S714). category is NULLABLE with no
      // default, and a server-side .neq also drops every NULL row — silently. Menu Pricing carries
      // the same fix and the same comment; three sibling reads never got it.
      // Here that meant a dish with no category could not be entered against a period at all — it
      // was absent from Sales Entry's recipe list, with nothing saying so.
      scopedFrom('recipes').eq('is_active', true).or('category.is.null,category.neq.Sub-Recipe').order('name')
    ])
    // Both reads dropped their `error` until S699, and on this page that is not merely a wrong
    // report. A failed PERIODS read rendered NoPeriodState — "no period set up" for a read that
    // never landed. A failed RECIPES read rendered "No active recipes. Add recipes in Recipe
    // Costing first." over a live Save button, and buildBulkRows()/buildDailyRows() both iterate
    // `recipes`, so an empty menu builds an EMPTY PAYLOAD — which save_sales_day treats as "delete
    // this day's manual rows and insert nothing". The S682 guard below this only ever covered the
    // sales reads; the menu the payload is built from was never checked.
    const failed = firstError(results)
    if (failed) { noteLoad('init', failed); setLoading(false); return }
    noteLoad('init', null)
    const [{ data: p }, { data: r }] = results
    setAndCache(setPeriods, 'periods', p || [])
    setAndCache(setRecipes, 'recipes', r || [])
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      periodReq.begin(open.id)   // claim the page, as useLatestRequest's own docs require of init()
      setSelectedPeriod(open)
      await Promise.all([loadSales(open.id), loadAllDaySums(open.id)])
    }
    setLoading(false)
  }

  async function loadSales(periodId) {
    const { data, error } = await supabase
      .from('sales_entries')
      .select('*')
      .eq('period_id', periodId)
      .eq('bs_day', 0) // bulk entries only
    if (!periodReq.isCurrent(periodId)) return
    if (error) { noteLoad('sales', error); return }
    noteLoad('sales', null)
    const map = {}
    ;(data || []).forEach(s => {
      map[s.recipe_id] = parseFloat(s.qty_sold) || 0
    })
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setSales(map)
    setBulkForm({}) // reset form so it reads from DB
  }

  async function loadDailySales(periodId, day) {
    const key = `${periodId}:${day}`
    dayReq.begin(key)   // synchronous — claims the day before any await
    // `source` is SELECTED and comps are filtered in JS. See isComp's note above: a server-side
    // .neq drops NULL-source rows too, and here that is destructive rather than merely wrong.
    const { data, error } = await supabase
      .from('sales_entries').select('*')
      .eq('period_id', periodId).eq('bs_day', day)
    if (!dayReq.isCurrent(key)) return   // superseded by a newer day/period selection
    if (error) { noteLoad('daily', error); return }
    noteLoad('daily', null)
    const map = {}
    const discMap = {}
    const posMap = {}
    const posDiscMap = {}
    // Accumulate, don't overwrite — loadAllDaySums below has always summed, and this must agree
    // with it. A day can legitimately hold more than one row per recipe: POS writes one row PER
    // BILL, so a day with five bills of the same item was showing only the last bill's qty here.
    //
    // Manual and POS go to SEPARATE maps: only the manual one is the editable baseline a save
    // merges into, and only the POS one is drawn in the locked column.
    ;(data || []).forEach(s => {
      const manual = isManualSource(s.source)
      if (!manual && !isPosRow(s)) return   // comps, and any source added later, are drawn nowhere
      const qtyTarget = manual ? map : posMap
      const discTarget = manual ? discMap : posDiscMap
      qtyTarget[s.recipe_id] = (qtyTarget[s.recipe_id] || 0) + (parseFloat(s.qty_sold) || 0)
      discTarget[s.recipe_id] = (discTarget[s.recipe_id] || 0) + (parseFloat(s.discount) || 0)
    })
    setDailySales(map)
    setDailyForm({})
    setDailyDiscounts(discMap)
    setDiscountForm({})
    setPosDaySales(posMap)
    setPosDayDiscounts(posDiscMap)
  }

  async function loadAllDaySums(periodId) {
    // Paged (S613): POS writes one row per bill per recipe, so a month crosses the silent
    // 1000-row cap — and allDaySums doubles as a save-time fallback baseline, so a truncated
    // read here would not just misreport, it could be written back.
    const { data, error } = await fetchAllRows(() => supabase
      .from('sales_entries').select('recipe_id, qty_sold, discount, unit_price, source').eq('period_id', periodId).order('id'))
    // These maps are every PERIOD figure on the page — the three stat cards and the whole Period
    // Summary tab — so a failed read here must block the page, not fall back to "nothing sold".
    // (They are not a save baseline: buildBulkRows merges `sales` and buildDailyRows `dailySales`.
    // The comment here said otherwise for a long time.)
    if (error) { if (periodReq.isCurrent(periodId)) noteLoad('allDay', error); return }
    const agg = {}
    const discAgg = {}
    const pricedAgg = {}
    const unpricedAgg = {}
    ;(data || []).forEach(e => {
      if (isComp(e)) return
      const qty = parseFloat(e.qty_sold) || 0
      agg[e.recipe_id] = (agg[e.recipe_id] || 0) + qty
      discAgg[e.recipe_id] = (discAgg[e.recipe_id] || 0) + (parseFloat(e.discount) || 0)
      if (e.unit_price != null) {
        pricedAgg[e.recipe_id] = (pricedAgg[e.recipe_id] || 0) + qty * (parseFloat(e.unit_price) || 0)
      } else {
        unpricedAgg[e.recipe_id] = (unpricedAgg[e.recipe_id] || 0) + qty
      }
    })
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    noteLoad('allDay', null)
    setAllDaySums(agg)
    setAllDayDiscounts(discAgg)
    setAllDayPricedRev(pricedAgg)
    setAllDayUnpricedQty(unpricedAgg)
  }

  async function loadMonthlyEntries(periodId) {
    setMonthlyLoading(true)
    const { data, error } = await fetchAllRows(() => supabase
      .from('sales_entries').select('recipe_id, bs_day, qty_sold, source').eq('period_id', periodId).order('id'))
    if (!periodReq.isCurrent(periodId)) return   // superseded — leave the spinner to the newer load
    setMonthlyLoading(false)
    if (error) { noteLoad('monthly', error); return }
    noteLoad('monthly', null)
    setMonthlyEntries((data || []).filter(e => !isComp(e)))
  }

  // Build the payload each mode would write. Kept separate from the save itself so the
  // "what will this delete?" precheck can run against the exact rows about to be sent.
  // The typed draft merged over the saved MANUAL baseline, per recipe. Extracted so the
  // discount-without-quantity check below and the payload builder cannot disagree about what a
  // save is going to contain.
  function mergedDailyValues() {
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
    return { merged, mergedDiscount }
  }

  // A discount on a row with no quantity is dropped by the `qty > 0` filter below, so it was typed,
  // shown on screen as negative Day Revenue, counted in the day's Total discount — and then
  // silently thrown away by Save Day. Money quietly disappearing off a screen is the one thing this
  // page must not do, so the save stops and names the items instead of choosing for the user.
  function discountsWithoutQty() {
    const { merged, mergedDiscount } = mergedDailyValues()
    return recipes
      .filter(r => (mergedDiscount[r.id] || 0) > 0 && (merged[r.id] || 0) <= 0)
      .map(r => r.name)
  }

  function buildDailyRows() {
    const { merged, mergedDiscount } = mergedDailyValues()
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
    // Both writing tabs are unreachable when POS owns sales, so this can't be hit through the UI.
    // It stays as the last line of defence for any path that doesn't go through a tab — the Excel
    // import button, a stale render mid-load, a future caller — since the cost of being wrong here
    // is writing manual rows that contradict the till.
    if (posOwnsSales) return
    const isBulk = mode === 'bulk'
    if (isBulk ? bulkSaving : dailySaving) return
    const setSaving = isBulk ? setBulkSaving : setDailySaving
    const setErr = isBulk ? setBulkSaveError : setDailySaveError

    // An empty menu builds an empty payload, and save_sales_day reads that as "delete this day's
    // manual rows and insert nothing". `recipes` is only ever empty because the client genuinely has
    // no recipes or because the read failed — neither is a reason to clear a day.
    if (recipes.length === 0) {
      setErr('No menu items are loaded, so there is nothing to save. Reload the page; if the menu is still empty, add recipes in Recipe Costing first.')
      return
    }

    if (!isBulk) {
      const orphanDiscounts = discountsWithoutQty()
      if (orphanDiscounts.length > 0) {
        const shown = orphanDiscounts.slice(0, 5).join(', ')
        setErr(`${orphanDiscounts.length === 1 ? 'This item has' : 'These items have'} a discount but no quantity sold, and a discount is only saved against a sale: ${shown}${orphanDiscounts.length > 5 ? `, and ${orphanDiscounts.length - 5} more` : ''}. Enter the quantity sold, or clear the discount, then save again.`)
        return
      }
    }

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
    // Manual-sales stock depletion — best-effort, non-blocking (see depleteManualSales' own
    // try/catch); the sales save itself already committed above regardless of this outcome.
    depleteManualSales(supabase, {
      clientId, periodId: selectedPeriod.id, bsDay: isBulk ? 0 : selectedDay, rows,
    })
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
    periodReq.begin(periodId)   // claim the page before any await
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

  // Period revenue for one recipe, across EVERY row (bulk + daily), priced the way every other
  // report in the codebase prices sales: the row's own unit_price snapshot wins, and the recipe's
  // current selling_price is only a fallback for rows written before that snapshot existed
  // (S375). Using the live price for everything — which this page used to do — silently restates
  // a whole period's revenue the moment someone edits a menu price.
  function recipeRevenue(recipe) {
    const priced = allDayPricedRev[recipe.id] || 0
    const unpricedQty = allDayUnpricedQty[recipe.id] || 0
    const disc = allDayDiscounts[recipe.id] || 0
    return priced + unpricedQty * (parseFloat(recipe.selling_price) || 0) - disc
  }

  // The three stat cards are PERIOD figures and must read allDaySums. They used to read
  // getQtyNum(), whose `sales` map is loaded with .eq('bs_day', 0) — bulk rows only — so on a
  // client entering sales daily, "Total Covers"/"Period Revenue" showed roughly nothing while the
  // Period Summary tab on the same page showed the real number.
  const totalQty     = recipes.reduce((s, r) => s + (allDaySums[r.id] || 0), 0)
  const totalRevenue = recipes.reduce((s, r) => s + recipeRevenue(r), 0)
  const itemsWithSales = recipes.filter(r => (allDaySums[r.id] || 0) > 0).length

  // Sorted by the SAVED figures, not the live draft. It used to sort through getQtyNum(), which
  // reads bulkForm — the very state the Qty box writes — so typing a quantity re-sorted the whole
  // menu on every keystroke AND physically moved the row being typed in out from under the
  // cursor. The order now refreshes when the period's data is saved or reloaded, which is also
  // what lets this memoize.
  const sortedRecipes = useMemo(() => {
    const savedQty = id => parseFloat(sales[id]) || 0
    const savedRev = r => savedQty(r.id) * (parseFloat(r.selling_price) || 0)
    return [...recipes].sort((a, b) => {
      switch (sortBy) {
        case 'rev_desc':   return savedRev(b) - savedRev(a)
        case 'rev_asc':    return savedRev(a) - savedRev(b)
        case 'qty_desc':   return savedQty(b.id) - savedQty(a.id)
        case 'qty_asc':    return savedQty(a.id) - savedQty(b.id)
        case 'price_desc': return (parseFloat(b.selling_price) || 0) - (parseFloat(a.selling_price) || 0)
        case 'price_asc':  return (parseFloat(a.selling_price) || 0) - (parseFloat(b.selling_price) || 0)
        default:           return 0
      }
    })
  }, [recipes, sortBy, sales])

  const categories = [...new Set(recipes.map(r => r.category).filter(Boolean))].sort()

  // The menu search runs on all four tabs — a quick way to find one item among 90+ recipes. It
  // only narrows which rows are DRAWN: the stat cards still sum every recipe, a Bulk save still
  // writes every recipe (buildBulkRows reads `recipes`, not `bulkRows`), and Period Summary's
  // % of Revenue keeps its denominator, so it never looks like data quietly went missing.
  // Bulk Entry has no category control, so it must use the search alone — applying the category
  // there would let a category picked on another tab silently hide Bulk rows with nothing on
  // screen to explain it.
  const menuSearchLc = menuSearch.trim().toLowerCase()
  const matchesMenuSearch = r => !menuSearchLc || r.name.toLowerCase().includes(menuSearchLc)
  const matchesMenuFilter = r =>
    (categoryFilter === 'all' || r.category === categoryFilter) && matchesMenuSearch(r)

  // Each list was written out twice in the JSX (once for the empty check, once for the .map), so
  // every filter ran twice per render. Computed once here instead. The drafts (bulkForm/dailyForm)
  // stay part of the "has sales" test on purpose — that is the filter's meaning.
  const bulkRows = sortedRecipes.filter(r => matchesMenuSearch(r) && (!onlyWithSales || getQtyNum(r.id) > 0))
  const dailyRows = recipes.filter(r => matchesMenuFilter(r) && (!onlyWithSales || parseFloat(getDailyQty(r.id)) > 0))

  // The locked "From POS" column only exists on a day that HAS till sales, so an IMS-only client
  // never sees a column of dashes. Its revenue is stated separately rather than folded into Day
  // revenue: that figure is what this grid is about to save, and the two must not be confusable.
  const hasPosDay = Object.keys(posDaySales).length > 0 || Object.keys(posDayDiscounts).length > 0
  const posDayRevenue = recipes.reduce((s, r) =>
    s + (posDaySales[r.id] || 0) * (parseFloat(r.selling_price) || 0) - (posDayDiscounts[r.id] || 0), 0)

  // Daily Breakdown pivot — one row per recipe × one column per day (~9,000 cells on a real
  // month). Rebuilt per keystroke of the menu search before this memo; the totals are precomputed
  // maps so the footer doesn't re-reduce the whole matrix per column per render.
  const dailyPivot = useMemo(() => {
    const pivot = {}
    for (const e of monthlyEntries) {
      if (!pivot[e.recipe_id]) pivot[e.recipe_id] = {}
      pivot[e.recipe_id][e.bs_day] = (pivot[e.recipe_id][e.bs_day] || 0) + (parseFloat(e.qty_sold) || 0)
    }
    const activeDays = [...new Set(monthlyEntries.filter(e => e.bs_day > 0).map(e => e.bs_day))].sort((a, b) => a - b)
    const hasBulk = monthlyEntries.some(e => e.bs_day === 0)
    const activeRecipeIds = new Set(monthlyEntries.map(e => e.recipe_id))
    const activeRecipes = recipes.filter(r => activeRecipeIds.has(r.id) && matchesMenuFilter(r))
    const rowTotals = {}
    activeRecipes.forEach(r => {
      rowTotals[r.id] = Object.values(pivot[r.id] || {}).reduce((s, v) => s + v, 0)
    })
    const colTotals = {}
    activeDays.forEach(d => {
      colTotals[d] = activeRecipes.reduce((s, r) => s + (pivot[r.id]?.[d] || 0), 0)
    })
    const bulkColTotal = activeRecipes.reduce((s, r) => s + (pivot[r.id]?.[0] || 0), 0)
    const grandTotal = activeRecipes.reduce((s, r) => s + (rowTotals[r.id] || 0), 0)
    return { pivot, activeDays, hasBulk, activeRecipes, rowTotals, colTotals, bulkColTotal, grandTotal }
  }, [monthlyEntries, recipes, categoryFilter, menuSearchLc]) // eslint-disable-line react-hooks/exhaustive-deps

  const periodLabel = selectedPeriod
    ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}`
    : '—'

  // Which failed read blocks the screen the reader is actually on. `init` and `allDay` always
  // count — the first is the menu and period list everything is built from, the second is the three
  // stat cards, which sit above the tab strip. The rest is per tab, so a Daily Breakdown that could
  // not load stops blocking Bulk Entry the moment you leave it: the previous single shared slot
  // meant one tab's failure blanked all four with no way back except a period change or a reload.
  const TAB_LOAD_KEY = { bulk: 'sales', daily: 'daily', breakdown: 'monthly', summary: null }
  const loadError = loadErrors.init || loadErrors.allDay || loadErrors[TAB_LOAD_KEY[viewMode]] || null

  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'
  // Both Save buttons sit ABOVE the "No active recipes" empty state, so an empty menu — whether the
  // client has none or the read failed — left a live Save over nothing. Both payload builders
  // iterate `recipes`, and save_sales_day reads an empty payload as "clear this day".
  const noMenu = recipes.length === 0
  const tabPrintLabel = `${TAB_LABELS[viewMode]} — ${periodLabel}${viewMode === 'daily' ? `, Day ${selectedDay}` : ''}`

  // 'staff' is the floor tier every other IMS page's guard is measured against — this page had no
  // guard at all, so ModuleGate's client-level ims_enabled check was the only thing in front of
  // it. sales_entries is deliberately left readable/writable for POS PIN staff at the RLS level
  // (billing has to post to it), so a pos_role='staff' account with no ims_role could type /sales
  // and read, then overwrite, the client's whole manual sales ledger. Nav already hid it
  // (Layout.js's imsVisible requires an imsRole); the route did not.
  if (!hasImsAccess('staff')) return <Navigate to="/dashboard" replace />
  // `!loadError` matters: with a failed periods read `periods` is [] for a reason that has nothing
  // to do with the client's setup, and "no period" is the wrong sentence to put in front of them.
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="sales entry" />

  return (
    <div>
      {/* Header */}
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Sales Entry</h1>
          <p className="page-subtitle">Total sales per menu item</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
          </div>
          <p className="page-subtitle print-only" style={{ marginTop: 2 }}>{tabPrintLabel}</p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
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
          <button className="btn btn-ghost" onClick={() => printWithTitle(`Sales Entry - ${tabPrintLabel}`)}>🖶 Print</button>
        </div>
      </div>


      {/* Period locked banner */}
      {isLocked && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red-text)' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}
      {/* POS-supersedes-manual banner. Accent rather than red — this is how the product is meant
          to work for a two-module client, not an error or a lockout they need to resolve. */}
      {posOwnsSales && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 35%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-text1)' }}>
          🛈 <span><strong>Sales come from Crest POS.</strong> Every bill closed at the till posts its own sales automatically, so Bulk Entry and Daily Entry are disabled — manual figures would duplicate or contradict the till. These views stay live and read-only.</span>
        </div>
      )}
      {/* Stat cards */}
      <div className="stat-grid no-print">
        <div className="stat-card">
          {/* Was labelled "Total Covers" — this is Σ qty_sold across recipes, i.e. dishes, not
              guests. A cover is a guest served (what CoversReport and Demand Forecast both mean by
              it), and it is the denominator of average spend per head — so an owner dividing
              revenue by this got roughly revenue-per-dish and called it their average check. */}
          <div className="stat-label"><Tip text="Total number of menu items sold this period — dishes, not guests. Guest counts (covers) come from POS bills, not from sales entry." width={260}>Items Sold</Tip></div>
          <div className="stat-value">{totalQty.toLocaleString('en-IN')}</div>
          <div className="stat-sub">across all menu items</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Items with Sales</div>
          <div className="stat-value">{itemsWithSales}</div>
          <div className="stat-sub">of {recipes.length} active recipes</div>
        </div>
        <div className="stat-card">
          <div className="stat-label"><Tip text="Total ex-VAT revenue for the period, across every entry — bulk, daily and POS. Each sale is priced at the selling price recorded when it was entered, less any discount on it. Used as the denominator for Food Cost %." width={300}>Period Revenue</Tip></div>
          <div className="stat-value gold" style={{ fontSize: 18 }}>
            NPR {totalRevenue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </div>
          <div className="stat-sub">Excl. VAT</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid var(--theme-border)', marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 4 }} role="tablist" aria-label="Sales entry views">
          {Object.entries(TAB_LABELS).map(([key, label]) => {
            const tabDisabled = posOwnsSales && ENTRY_TABS.includes(key)
            // aria-disabled, NOT the disabled attribute: a disabled <button> swallows mouse events
            // and never bubbles them, so Tip (which binds onMouseEnter on its wrapper span) would
            // never fire and the user would get a greyed-out tab with no way to find out why.
            const btn = (
              <button key={key} type="button" role="tab" aria-selected={viewMode === key}
                onClick={() => { if (!tabDisabled) setViewMode(key) }} aria-disabled={tabDisabled}
                className={`panel-tab${viewMode === key ? ' panel-tab--active' : ''}`}
                style={tabDisabled ? { cursor: 'not-allowed', color: 'var(--theme-text3)' } : undefined}
              >{tabDisabled ? `🔒 ${label}` : label}</button>
            )
            return tabDisabled
              ? <Tip key={key} style={{ borderBottom: 'none', cursor: 'not-allowed' }} width={300}
                     text="Disabled because Crest POS is active. Every bill closed at the till posts its own sales automatically, so manual entry would duplicate or contradict it. Review or correct sales in the POS Sales Report instead.">{btn}</Tip>
              : btn
          })}
        </div>
        {(viewMode === 'bulk' || viewMode === 'daily' || viewMode === 'breakdown' || viewMode === 'summary') && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {(viewMode === 'bulk' || viewMode === 'daily') && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--theme-text2)', cursor: 'pointer', marginBottom: 6, whiteSpace: 'nowrap' }}>
                <input type="checkbox" checked={onlyWithSales} onChange={e => setOnlyWithSales(e.target.checked)} />
                Only items with sales
              </label>
            )}
            <div style={{ position: 'relative', marginBottom: 6 }}>
              <input
                aria-label="Search menu item"
                value={menuSearch}
                onChange={e => setMenuSearch(e.target.value)}
                placeholder="Search menu item…"
                style={{ background: 'var(--theme-card)', border: `1px solid ${menuSearch ? 'color-mix(in srgb, var(--theme-accent) 50%, transparent)' : 'var(--theme-border)'}`, borderRadius: 'var(--radius-sm)', padding: '6px 10px 6px 28px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', width: 170, display: 'block' }}
              />
              <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--theme-text2)', pointerEvents: 'none' }}>🔍</span>
              {menuSearch && (
                <button type="button" onClick={() => setMenuSearch('')} title="Clear" aria-label="Clear search"
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}>×</button>
              )}
            </div>
            {(viewMode === 'daily' || viewMode === 'breakdown' || viewMode === 'summary') && (
              <select aria-label="Filter by category"
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', marginBottom: 6 }}
              >
                <option value="all">All Categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            )}
            {viewMode === 'summary' && (
              <select aria-label="Sort by"
                value={sortBy}
                onChange={e => setSortBy(e.target.value)}
                style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 12, color: 'var(--theme-text1)', outline: 'none', marginBottom: 6 }}
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
          {loadError && <ReportLoadError error={loadError} />}
          {!loadError && viewMode === 'bulk' && (
            <>
              <div className="no-print" style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
                Enter total qty sold for the entire period per menu item. Sub-recipes are excluded.
              </div>
              <div className="card">
                <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                  <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>
                    Period total — <strong style={{ color: 'var(--theme-accent-ink)' }}>{periodLabel}</strong>
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
                      style={{ fontSize: 13, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                    >
                      Clear All
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={() => requestSave('bulk')}
                      disabled={bulkSaving || isLocked || noMenu}
                    >
                      {bulkSaving ? 'Saving…' : bulkSaved ? '✓ Saved' : 'Save'}
                    </button>
                  </div>
                </div>
                {bulkSaveError && (
                  <div className="no-print" style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 16, fontSize: 12, color: 'var(--theme-red-text)' }}>
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
                        <th><Tip text="Recipe category — Food, Beverage, Dessert, etc. Use the search box above to find one item." width={240}>Category</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Ex-VAT selling price per portion as set in Recipe Costing." width={230}>Selling Price</Tip></th>
                        <th style={{ textAlign: 'right', width: 160 }}><Tip text="Total portions sold across the entire period. Enter or edit in the Qty Sold column." width={240}>Total Qty Sold</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Total revenue = Qty Sold × Selling Price (ex-VAT). Used in food cost % and variance calculations." width={260}>Period Revenue</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkRows.length === 0 && (
                        <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: '16px 0' }}>{menuSearchLc ? 'No menu items match this filter.' : 'No items with sales entered yet.'}</td></tr>
                      )}
                      {bulkRows.map(recipe => {
                        const qty = getQty(recipe.id)
                        const rev = (parseFloat(qty) || 0) * (parseFloat(recipe.selling_price) || 0)
                        return (
                          <tr key={recipe.id}>
                            <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{recipe.name}</td>
                            <td><span className="badge badge-yellow">{recipe.category}</span></td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                              {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toLocaleString('en-IN')}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <input aria-label={`Quantity sold: ${recipe.name}`}
                                type="number" min="0"
                                value={qty}
                                onChange={e => setBulkForm(f => ({ ...f, [recipe.id]: e.target.value }))}
                                placeholder="0"
                                disabled={isLocked}
                                style={disabledStyle({
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 13,
                                  color: 'var(--theme-text1)', outline: 'none', width: 110, textAlign: 'right',
                                  borderColor: parseFloat(qty) > 0 ? 'color-mix(in srgb, var(--theme-accent) 40%, transparent)' : 'var(--theme-border)'
                                }, isLocked)}
                              />
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', fontWeight: rev > 0 ? 600 : 400 }}>
                              {rev > 0 ? `NPR ${rev.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
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
          {!loadError && viewMode === 'daily' && (
            <>
              <div className="no-print" style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
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
                              style={{ fontSize: 11, padding: '4px 10px', color: 'var(--theme-accent-ink)', borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}
                            >Today (day {today.day})</button>
                          )}
                        </>
                      )
                    })()}
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <SalesImportButton recipes={recipes} disabled={isLocked || noMenu} onMatched={handleImportMatched} />
                    <button
                      className="btn btn-ghost"
                      disabled={isLocked}
                      onClick={() => {
                        const cleared = {}
                        recipes.forEach(r => { cleared[r.id] = '' })
                        setDailyForm(cleared)
                        setDiscountForm(cleared)
                      }}
                      style={{ fontSize: 13, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                    >Clear</button>
                    <button
                      className="btn btn-primary"
                      onClick={() => requestSave('daily')}
                      disabled={dailySaving || isLocked || noMenu}
                    >{dailySaving ? 'Saving…' : dailySaved ? '✓ Saved' : 'Save Day'}</button>
                  </div>
                </div>
                {dailySaveError && (
                  <div className="no-print" style={{ background: 'color-mix(in srgb, var(--theme-red) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-red) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', marginBottom: 16, fontSize: 12, color: 'var(--theme-red-text)' }}>
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
                        <span style={{ color: 'var(--theme-text2)' }}>Total qty sold ({formatBsDay(selectedDay, selectedPeriod?.bs_month)}): <strong style={{ color: 'var(--theme-text1)' }}>{totQty.toLocaleString('en-IN')}</strong></span>
                        {totDiscount > 0 && (
                          <span style={{ color: 'var(--theme-text2)' }}>Total discount: <strong style={{ color: 'var(--theme-red-text)' }}>NPR {totDiscount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
                        )}
                        <span style={{ color: 'var(--theme-text2)' }}>Day revenue (typed here): <strong style={{ color: 'var(--theme-accent-ink)' }}>{totRev > 0 ? `NPR ${totRev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</strong></span>
                        {hasPosDay && (
                          <span style={{ color: 'var(--theme-text2)' }}>From POS: <strong style={{ color: 'var(--theme-text1)' }}>{posDayRevenue > 0 ? `NPR ${posDayRevenue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</strong></span>
                        )}
                      </div>
                    )
                  })()}
                  {hasPosDay && (
                    <div className="no-print" style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 14px', marginBottom: 12, fontSize: 12, color: 'var(--theme-text2)' }}>
                      🛈 The till already posted sales for this day — shown in the read-only <strong>From POS</strong> column. Save Day writes only what you type in Qty Sold and Discount; it never changes or deletes a POS sale.
                    </div>
                  )}
                  <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Menu Item</th>
                        <th><Tip text="Recipe category — Food, Beverage, Dessert, etc." width={210}>Category</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Ex-VAT selling price per portion as set in Recipe Costing." width={230}>Selling Price</Tip></th>
                        <th style={{ textAlign: 'right', width: 160 }}><Tip text="Portions sold on this specific day, typed here by hand. Saved separately from the monthly bulk total." width={250}>Qty Sold ({formatBsDay(selectedDay, selectedPeriod?.bs_month)})</Tip></th>
                        {hasPosDay && (
                          <th style={{ textAlign: 'right', width: 110 }}><Tip text="Portions the till already sold on this day. Read-only — POS posts its own sales automatically, and Save Day never writes, changes or deletes these. They are shown so you can see the whole day before typing anything by hand." width={300}>From POS</Tip></th>
                        )}
                        <th style={{ textAlign: 'right', width: 130 }}><Tip text="NPR discount applied to this item on this day — e.g. staff discount, promo, or complimentary reduction. Subtracted from Day Revenue. Auto-filled by ↑ Import Excel from the report's Discount column, or type it in directly." width={280}>Discount</Tip></th>
                        <th style={{ textAlign: 'right' }}><Tip text="Revenue for this item on this day = (Qty × Selling Price) − Discount, ex-VAT." width={260}>Day Revenue</Tip></th>
                      </tr>
                    </thead>
                    <tbody>
                      {dailyRows.length === 0 && (
                        <tr><td colSpan={hasPosDay ? 7 : 6} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: '16px 0' }}>No menu items match this filter.</td></tr>
                      )}
                      {dailyRows.map(recipe => {
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
                              {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toLocaleString('en-IN')}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              <input aria-label={`Quantity sold: ${recipe.name}`}
                                type="number" min="0"
                                value={rawVal}
                                onChange={e => setDailyForm(f => ({ ...f, [recipe.id]: e.target.value }))}
                                placeholder="0"
                                disabled={isLocked}
                                style={disabledStyle({
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 13,
                                  color: 'var(--theme-text1)', outline: 'none', width: 110, textAlign: 'right',
                                  borderColor: qty > 0 ? 'color-mix(in srgb, var(--theme-accent) 40%, transparent)' : 'var(--theme-border)'
                                }, isLocked)}
                              />
                            </td>
                            {hasPosDay && (
                              // Text, not a disabled input: this is not a field that happens to be
                              // locked, it is a figure from another system. A greyed-out box invites
                              // someone to work out how to type in it.
                              <td style={{ textAlign: 'right', color: (posDaySales[recipe.id] || 0) > 0 ? 'var(--theme-text2)' : 'var(--theme-text3)' }}>
                                {(posDaySales[recipe.id] || 0) > 0 ? (posDaySales[recipe.id]).toLocaleString('en-IN') : '—'}
                              </td>
                            )}
                            <td style={{ textAlign: 'right' }}>
                              <input aria-label={`Discount: ${recipe.name}`}
                                type="number" min="0"
                                value={discRaw}
                                onChange={e => setDiscountForm(f => ({ ...f, [recipe.id]: e.target.value }))}
                                placeholder="0"
                                disabled={isLocked}
                                style={disabledStyle({
                                  background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                  borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 13,
                                  color: 'var(--theme-text1)', outline: 'none', width: 100, textAlign: 'right',
                                  borderColor: disc > 0 ? 'color-mix(in srgb, var(--theme-red) 40%, transparent)' : 'var(--theme-border)'
                                }, isLocked)}
                              />
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', fontWeight: rev > 0 ? 600 : 400 }}>
                              {qty > 0 || disc > 0 ? `NPR ${rev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
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
                      style={{ fontSize: 13, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                    >Clear</button>
                    <button
                      className="btn btn-primary"
                      onClick={() => requestSave('daily')}
                      disabled={dailySaving || isLocked || noMenu}
                    >{dailySaving ? 'Saving…' : dailySaved ? '✓ Saved' : 'Save Day'}</button>
                  </div>
                  </>
                )}
              </div>
            </>
          )}

          {/* DAILY BREAKDOWN */}
          {!loadError && viewMode === 'breakdown' && (() => {
            if (monthlyLoading) return <div className="card"><p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p></div>
            if (monthlyEntries.length === 0) return (
              <div className="card">
                <div className="empty-state">
                  <div className="empty-state-icon">◈</div>
                  <p className="empty-state-text">No sales recorded yet for this period.</p>
                </div>
              </div>
            )

            // Pivot, totals and the filtered recipe list all come from the dailyPivot memo above —
            // rebuilt only when the entries or the Category/Search filter change, not per render.
            const { pivot, activeDays, hasBulk, activeRecipes, rowTotals, colTotals, bulkColTotal, grandTotal } = dailyPivot

            const today = getBsToday()
            const isCurrentMonth = selectedPeriod && today.year === selectedPeriod.bs_year && today.month === selectedPeriod.bs_month

            const colTotal = (day) => colTotals[day] || 0
            const rowTotal = (recipeId) => rowTotals[recipeId] || 0

            const fmtQty = (n) => n > 0 ? n.toLocaleString('en-IN') : <span style={{ color: 'var(--theme-border)' }}>—</span>

            return (
              <div className="card">
                <div className="table-wrap">
                  <table className="data-table" style={{ minWidth: 'max-content' }}>
                    <thead>
                      <tr>
                        <th style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', zIndex: 1, minWidth: 160 }}>Menu Item</th>
                        <th style={{ position: 'sticky', left: 160, background: 'var(--theme-bg)', zIndex: 1, minWidth: 90 }}>Category</th>
                        {activeDays.map(d => (
                          <th key={d} style={{ textAlign: 'right', minWidth: 56, color: isCurrentMonth && d === today.day ? 'var(--theme-accent-ink)' : undefined }}>
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
                            <td style={{ textAlign: 'right', fontWeight: 700, color: total > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text2)' }}>
                              {total > 0 ? total.toLocaleString('en-IN') : '—'}
                            </td>
                          </tr>
                        )
                      })}
                      <tr style={{ borderTop: '2px solid var(--theme-border)', fontWeight: 700 }}>
                        <td style={{ position: 'sticky', left: 0, background: 'var(--theme-bg)', color: 'var(--theme-text2)', fontSize: 12 }} colSpan={2}>DAY TOTAL</td>
                        {activeDays.map(d => (
                          <td key={d} style={{ textAlign: 'right', color: 'var(--theme-text1)' }}>
                            {colTotal(d) > 0 ? colTotal(d).toLocaleString('en-IN') : '—'}
                          </td>
                        ))}
                        {hasBulk && (
                          <td style={{ textAlign: 'right', color: 'var(--theme-text3)' }}>
                            {bulkColTotal > 0 ? bulkColTotal.toLocaleString('en-IN') : '—'}
                          </td>
                        )}
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 14 }}>{grandTotal.toLocaleString('en-IN')}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )
          })()}

          {/* PERIOD SUMMARY */}
          {!loadError && viewMode === 'summary' && (() => {
            // summaryBase is the category-scoped list the figures are measured against; the search
            // only picks which of those rows are drawn. % of Revenue therefore keeps meaning "share
            // of this category's period revenue" whether or not a search is typed — otherwise
            // searching "momo" would make each variant read as a share of momo revenue only.
            const summaryBase = recipes
              .filter(r => categoryFilter === 'all' || r.category === categoryFilter)
              .sort((a, b) => {
                const aqty = allDaySums[a.id] || 0
                const bqty = allDaySums[b.id] || 0
                const arev = recipeRevenue(a)
                const brev = recipeRevenue(b)
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
            const summaryRecipes = summaryBase.filter(matchesMenuSearch)
            const baseTotalRev = summaryBase.reduce((s, r) => s + recipeRevenue(r), 0)
            // The footer sums the rows actually on screen (as Daily Breakdown's does), and says so
            // whenever a search has hidden some of them.
            const sumTotalQty = summaryRecipes.reduce((s, r) => s + (allDaySums[r.id] || 0), 0)
            const sumTotalDiscount = summaryRecipes.reduce((s, r) => s + (allDayDiscounts[r.id] || 0), 0)
            const sumTotalRev = summaryRecipes.reduce((s, r) => s + recipeRevenue(r), 0)
            const footerLabel = menuSearchLc && summaryRecipes.length !== summaryBase.length
              ? `Total (${summaryRecipes.length} of ${summaryBase.length} items shown)`
              : 'Total'
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
                      {summaryRecipes.length === 0 && (
                        <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: '16px 0' }}>No menu items match this filter.</td></tr>
                      )}
                      {summaryRecipes.map(recipe => {
                        const sold = allDaySums[recipe.id] || 0
                        const disc = allDayDiscounts[recipe.id] || 0
                        const rev  = recipeRevenue(recipe)
                        const revPct = baseTotalRev > 0 ? (rev / baseTotalRev) * 100 : 0
                        // An unsold item is labelled by its "—" sold count and a slate name, never by
                        // opacity: at 0.4 the name measured 2.5:1 and the figure 1.9:1 (S682).
                        return (
                          <tr key={recipe.id}>
                            <td style={{ fontWeight: 600, color: sold === 0 ? 'var(--theme-text3)' : 'var(--theme-text1)' }}>{recipe.name}</td>
                            <td><span className="badge badge-yellow">{recipe.category}</span></td>
                            <td style={{ textAlign: 'right', color: sold > 0 ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>
                              {sold > 0 ? sold.toLocaleString('en-IN') : '—'}
                            </td>
                            <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                              {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toLocaleString('en-IN')}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right', color: disc > 0 ? 'var(--theme-red-text)' : 'var(--theme-text3)' }}>
                              {disc > 0 ? `NPR ${disc.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right', color: rev > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', fontWeight: 600 }}>
                              {rev > 0 ? `NPR ${rev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </td>
                            <td style={{ textAlign: 'right' }}>
                              {revPct > 0 ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                                  <div style={{ width: 60, height: 4, background: 'var(--theme-border)', borderRadius: 'var(--radius-xs)' }}>
                                    <div style={{ width: `${Math.min(revPct, 100)}%`, height: '100%', background: 'var(--theme-accent)', borderRadius: 'var(--radius-xs)' }} />
                                  </div>
                                  <span style={{ fontSize: 12, color: 'var(--theme-text2)', minWidth: 36 }}>{revPct.toFixed(1)}%</span>
                                </div>
                              ) : '—'}
                            </td>
                          </tr>
                        )
                      })}
                      <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                        <td colSpan={2} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>{footerLabel}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, paddingTop: 12 }}>{sumTotalQty.toLocaleString('en-IN')}</td>
                        <td></td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 12 }}>
                          {sumTotalDiscount > 0 ? `NPR ${sumTotalDiscount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 12 }}>
                          NPR {sumTotalRev.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
