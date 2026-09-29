import { npr, npr2 } from '../../../shared/nepalMoney'
import { useEffect, useRef, useState, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, runChunkedByIds } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import PeriodScope from '../../../components/PeriodScope'
import { useBizInfo } from '../../../shared/hooks/useBizInfo'
import { sheetWithLetterhead } from '../../../shared/excelLetterhead'
import SupportContactLine from '../../../components/SupportContactLine'
import { COGS_FORMULA, computeUsed } from '../../../shared/imsFormulas'
import { allocateBillDiscounts, returnCostValue } from '../reports/supplierAttribution'
import { periodRowIds, periodValuationItems } from '../reports/periodCost'
import { nepalBs, nepalDateAd } from '../../../shared/nepalTime'
import SearchableSelect from '../../../components/SearchableSelect'
import ConfirmModal from '../../../components/ConfirmModal'
import QtyInput from '../../../components/QtyInput'
import ActionError, { asActionError } from '../../../components/ActionError'
import { isNetworkError } from '../../../shared/errorText'
import { countSaveFailureText } from './countSaveFailure'
import CountConflictModal from './CountConflictModal'
import { CountConflictError, closingRpcRows, countedByLine, fmtQty, rpcMissing } from './countConflict'
import ReportLoadError from '../../../components/ReportLoadError'
import { firstError } from '../../../shared/queryError'
import './Stock.css'
import { cacheItems, getCachedItems, cacheCategories, getCachedCategories, cachePeriods, getCachedPeriods, cacheStockData, getCachedStockData, enqueue, getQueue, dequeue } from '../../../utils/offlineQueue'
import { BS_MONTHS, getBsToday, formatBsDay, daysInBsMonth } from '../../../utils/bsCalendar'
import { previousExistingPeriod, nextExistingPeriod } from '../../../pages/periods/closePeriod'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { WASTAGE_REASON_GROUPS, DEFAULT_WASTAGE_REASON } from '../../../shared/constants/wastageReasons'
import StockCountSettings from './StockCountSettings'
import { findUncountedItems, gapNote, UncountedItemsBanner } from '../../../shared/uncountedItems'
import Tabs, { TabPanel, FilterChips } from '../../../components/Tabs'
import ClosedPeriodBanner from '../../../components/ClosedPeriodBanner'

// The touch count screen's gate. Exported-in-spirit rather than inlined so the initial state, the
// resize handler and the media-query listener below cannot drift to three different thresholds —
// which is the shape of the bug this replaces.
const COARSE_POINTER = '(pointer: coarse)'
function isTouchCount() {
  return (window.matchMedia?.(COARSE_POINTER)?.matches ?? false) || window.innerWidth < 768
}

function dispPurch(baseQty, item) {
  const cf = parseFloat(item.conversion_factor) || 1
  if (cf > 1 && item.purchase_unit) {
    const puQty = (baseQty / cf).toLocaleString(undefined, { maximumFractionDigits: 3 })
    return `${puQty} ${item.purchase_unit} (${Number(baseQty).toLocaleString('en-IN')} ${item.uom})`
  }
  return Number(baseQty).toLocaleString('en-IN')
}

// A cell's on-screen value → what is written. '' (a blank cell) is null — "no figure" — and is
// distinct from 0 since S695: a Closing Stock of 0 is a real count ("we looked, there was none")
// and is stored as a row of physical_qty 0, so Stock Report can tell it from an item nobody
// counted. Before this, every save ran parseFloat(v) || 0 and a 0 deleted the row, which made
// "counted empty" and "not counted" the same fact in the database.
function toQty(v) {
  if (v === '' || v == null) return null
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : null
}
// Blank means "no row"; for every field but closing a 0 means the same thing.
const isNoRow = (fieldKey, qty) => qty == null || (fieldKey !== 'closing' && qty <= 0)
// Whether two quantities would be STORED as the same thing — the test "has this cell changed"
// asks (S756). A blank and a 0 wastage are one fact; a blank and a 0 closing count are not.
const sameStored = (fieldKey, a, b) => (isNoRow(fieldKey, a) && isNoRow(fieldKey, b)) || a === b

// Which tabs are ENTRY grids, and which stored field each one writes.
//
// An INCLUSION list on purpose. Until S737b this was an exclusion list — the grid rendered for
// `activeTab !== 'summary' && !== 'print' && !== 'daily_wastage'` — and every fieldKey ternary
// ended in `: 'wastage'`. So the Settings tab added hours earlier fell straight in: the wastage
// table rendered underneath the settings panel, and its Save All button was wired to write the
// WASTAGE column of every visible item. A new tab now renders no grid, and resolves no field,
// until it is named here — which is the direction that fails safe.
const FIELD_TAB = { opening: 'opening', closing: 'closing', wastage: 'wastage', staff_meal: 'staff_meal' }
const fieldKeyOf = tab => FIELD_TAB[tab] || null

// The Summary's Hidden badge (S792, D29) — worded like Stock Report's, the other page that keeps them.
const HIDDEN_ITEM_TIP = 'Hidden in Item Master. Shown because it had stock or movement this month, so the month’s figures still include it — hiding an item never changes a past month. It is not on the entry tabs, because a hidden item is no longer counted; show it again in Item Master to count it.'

export default function Stock() {
  const { clientId, profile, loading: authLoading, isAdmin, canEditClosedPeriods, hasFeature, hasImsAccess, imsCountOnly } = useAuth()
  // The export's letterhead (S756, owner decision): the one extra read this page makes for it.
  const biz = useBizInfo()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [allItems, setItems] = useState([])
  // Items hidden in Item Master (S792, D29: hiding an item never changes history). They are never
  // on an entry grid — a hidden item cannot be counted — but the Summary values a month over every
  // item with a row in it, so a count, purchase or wastage recorded before the hide stays in that
  // month's figures. `summaryRowIds` is which items had a row in the period on screen.
  const [hiddenItems, setHiddenItems] = useState([])
  const [summaryRowIds, setSummaryRowIds] = useState(() => new Set())
  const [allCategories, setCategories] = useState([])
  // Which categories THIS account has been given to count (S737). null = not read yet / not
  // applicable. Only ever populated for a raw ims_role of 'staff' — admin and Owner resolve to
  // 'manager' on every axis, which makes the RESOLVED rank the wrong test for "is this a counter".
  const [myCategoryIds, setMyCategoryIds] = useState(null)

  // "Is this account a counter", asked once. A RAW ims_role of 'staff' on purpose: admin and the
  // Owner resolve to 'manager' on every axis, so the resolved rank is the wrong test (CLAUDE.md).
  // Three rules key off it — scoping, blind count, and hiding value — and they were three separate
  // spellings of this expression before S761.
  const isCounter = !isAdmin && profile?.ims_role === 'staff'

  // The scope is DERIVED rather than applied at load, so it settles correctly when the settings
  // row arrives after the first read. It is a display rule only: the lock that actually holds is
  // the RESTRICTIVE policy on closing_stock writes (migration 20260910120000). Showing an item a
  // counter may not save would just move the refusal to the Save button.
  const scopeOn = isCounter && !!settings?.ims_count_scope_enforced

  // Manager-only, and last on the bar: it configures the page rather than being part of counting
  // it. Same conditional shape the staff_meals tab uses.
  const canManageCounts = isAdmin || hasImsAccess('manager')

  // What a PIN count account is handed (S761, owner decision). It exists to do ONE job on a shared
  // store-room phone or tablet — enter a closing count — so it gets one tab. The rest were not
  // merely clutter: Opening Stock is a live entry grid with its own Save All and was the DEFAULT
  // tab, so the first thing a counter saw was the screen that rewrites the month's starting basis;
  // Summary prints COGS, purchase value and an Excel export of the client's cost base; Print Sheet
  // is a paper artefact for a desktop, and it and Summary between them made `ims_count_blind`
  // peekable in two taps.
  //
  // Keyed on `imsCountOnly` (a PIN account), not on `isCounter`, so a store keeper you gave a real
  // email login to keeps the full page. Like the blind/scope rules this is a DISPLAY control —
  // only `closing_stock` carries a counter-scoped RESTRICTIVE policy; `opening_stock`, `wastages`
  // and `staff_meals` do not, so the browser could still be made to write them.
  const TABS = imsCountOnly
    ? [{ id: 'closing', label: 'Closing Stock', desc: 'Physical count at month end' }]
    : [
      { id: 'opening',    label: 'Opening Stock', desc: 'Stock at start of month' },
      { id: 'closing',    label: 'Closing Stock', desc: 'Physical count at month end' },
      { id: 'wastage',    label: 'Wastage',       desc: 'Monthly catch-all total — quick single figure per item (daily detail goes in the Daily Wastage tab)' },
      { id: 'daily_wastage', label: 'Daily Wastage', desc: 'Log wastage by day with a reason — rolls into the period total and COGS' },
      ...(hasFeature('staff_meals') ? [{ id: 'staff_meal', label: 'Staff Meals', desc: 'Staff & complimentary consumption — tracked separately from wastage' }] : []),
      { id: 'summary',    label: 'Summary',       desc: 'Full picture per item' },
      { id: 'print',      label: 'Print Sheet',   desc: 'Physical count sheet for the floor' },
      ...(canManageCounts && hasFeature('stock_count_assignment')
        ? [{ id: 'settings', label: 'Settings', desc: 'Who counts what, blind counting, recount protection and the count-page QR' }]
        : []),
    ]
  // Fail CLOSED while the assignment read is still outstanding: an empty list is the honest
  // rendering of "we do not yet know what is yours", and the server would refuse those writes.
  const items = useMemo(
    () => (scopeOn ? allItems.filter(i => myCategoryIds?.has(i.category_id)) : allItems),
    [allItems, scopeOn, myCategoryIds],
  )
  const categories = useMemo(
    () => (scopeOn ? allCategories.filter(c => myCategoryIds?.has(c.id)) : allCategories),
    [allCategories, scopeOn, myCategoryIds],
  )
  const itemOptions = useMemo(() => items.map(i => ({ value: i.id, label: i.name })), [items])
  // What the Summary, its uncounted-items banner and its Excel export value (S792, D29): every
  // active item this account sees, plus each hidden one that had a row this period — the population
  // Monthly Summary values (periodValuationItems), so hiding an item no longer takes its stock out
  // of a past month here while that page keeps it. Sub-recipes stay in, as they always have on this
  // page: prep is counted as stock here, which is the one difference the Summary's note names. The
  // entry grids, the touch cards and the Print Sheet stay on `items` — active only. Hidden items are
  // listed after the active ones, in name order, and carry a Hidden badge.
  const summaryItems = useMemo(() => {
    const hidden = scopeOn ? hiddenItems.filter(i => myCategoryIds?.has(i.category_id)) : hiddenItems
    return periodValuationItems([...items, ...hidden], summaryRowIds)
  }, [items, hiddenItems, summaryRowIds, scopeOn, myCategoryIds])
  const [stockData, setStockData] = useState({})
  const [purchases, setPurchases] = useState({})
  const [returns, setReturns] = useState({}) // { item_id: total_returned_qty }
  // What the period's purchases and returns COST, per item (S756): purchases at each bill line's
  // own rate net of its share of the bill discount (allocateBillDiscounts), returns at the rate
  // they went back at — the basis Monthly Summary and the frozen Monthly Report use. The Summary
  // tab valued both at today's items.per_uom_rate, which moves on every purchase bill and ignores
  // discounts, so the same month's purchases and COGS were two numbers on two pages. null means
  // "not known" (an offline cache written before these existed) and falls back to the master rate.
  const [purchaseValues, setPurchaseValues] = useState(null)
  const [returnValues, setReturnValues] = useState(null)
  // Who last counted each item, from closing_stock.counted_by_name (S737 wrote it; nothing showed
  // it until S756). { item_id: name }.
  const [countedBy, setCountedBy] = useState({})
  const [requisitioned, setRequisitioned] = useState({}) // { item_id: total_qty_issued }
  const [purchFreq, setPurchFreq] = useState({})
  const [dailyWastage, setDailyWastage] = useState({})   // { item_id: total dated wastage qty }
  const [dailyRows, setDailyRows] = useState([])         // raw dated wastage rows (with item join) for the Daily tab
  const [wDay, setWDay] = useState(getBsToday().day)     // selected BS day for daily wastage entry
  const [wEntry, setWEntry] = useState({ item_id: '', qty: '', reason: DEFAULT_WASTAGE_REASON })
  const [wBusy, setWBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  // A month switch in flight (S792, STOCK-6). handlePeriodChange moves the label at once while the
  // seven reads run, so the grids, the touch cards ("✓ Saved" included), the Summary and its Export
  // showed the previous month's figures under the new month's name — and an export in that window
  // was Bhadra's register in a file named for Shrawan. Everything that shows or writes figures
  // waits on `figuresLoading` below; only the request still current may clear it (periodReq).
  const [periodLoading, setPeriodLoading] = useState(false)
  const figuresLoading = loading || periodLoading
  const [saving, setSaving] = useState({})
  // DERIVED, not stored (S761): `profile` arrives after the first render, so a count account's
  // stored default would be 'opening' for a beat — and `imsCountOnly` flipping later would leave
  // a tab selected that is no longer on the bar. Falling back to the first available tab makes
  // "not on the bar" and "not reachable" the same fact, whenever the answer settles.
  const [tabChoice, setActiveTab] = useState('opening')
  const activeTab = TABS.some(t => t.id === tabChoice) ? tabChoice : TABS[0].id
  const [filterCat, setFilterCat] = useState('all')
  const [search, setSearch] = useState('')
  const [saveAllLoading, setSaveAllLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  // The last save that did not land, as `<ActionError>` copy naming what the server holds now.
  const [saveError, setSaveError] = useState(null)
  // A read that failed. While set, nothing below the header renders: the tables would show every
  // cell blank, and Save All writes on-screen state — so a failed read followed by Save All used
  // to DELETE the month's real counts on the server (S695). No figure, no save.
  const [loadError, setLoadError] = useState(null)
  // An in-page notice for the things that used to be window.alert() — offline, no earlier month,
  // nothing to carry forward. Not an error: nothing failed, there is just nothing to do.
  const [pageNotice, setPageNotice] = useState(null)
  // Shared ConfirmModal for the page's bulk writes (S575 rule; these three ran on window.confirm
  // until S612): { title, body, confirmLabel, danger, run }.
  const [pendingConfirm, setPendingConfirm] = useState(null)
  // S765: the touch count screen is chosen by INPUT METHOD, not by width. `window.innerWidth < 768`
  // is exactly iPad-portrait width, so `< 768` excluded it — and landscape is 1024+, a 10" Android
  // is ~800 portrait. No tablet had ever reached the card list, the progress bar or the fixed save
  // bar built for it, and every one of them got the desktop table with a ~38px QtyInput instead:
  // the one piece of scene-specific design in IMS, and the scene never received it.
  // `(pointer: coarse)` is the product's documented rule for touch sizing (DESIGN.md → Layout), and
  // it reads the PRIMARY pointer — a touchscreen laptop driven by a mouse still reports `fine` and
  // correctly keeps the table. The width clause is kept only so a desktop browser dragged narrow
  // still behaves, which is also how this branch gets tested.
  const [isMobile, setIsMobile] = useState(() => isTouchCount())
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [pendingSync, setPendingSync] = useState(0)
  const [syncing, setSyncing] = useState(false)
  // Counts the queued entries the last sync attempt could NOT write, with the reason. Until S731
  // flushQueue() swallowed every failure: a count queued against a month that was closed while
  // the device was offline (or refused by RLS after a sign-out on a shared tablet) was retried on
  // every page load forever, never landed, and said nothing — and the "N pending" badge it
  // inflates only renders inside the offline banner, so once back online the stuck entries were
  // invisible from every screen.
  const [syncFailed, setSyncFailed] = useState(null)
  const [pendingItems, setPendingItems] = useState(new Set())
  const flushRef = useRef(null)

  // What the server is known to hold for each cell, as of the last read or the last write that
  // landed (or was queued): { periodId, cells: { [itemId]: { [fieldKey]: qty|null } } }.
  //
  // Save All used to write EVERY visible row from on-screen state, and a blank cell is a delete.
  // So two tablets counting in parallel lost data: tablet A opens a blank sheet, tablet B saves
  // its section, A presses Save All — and B's rows are deleted. It also re-stamped counted_by and
  // counted_at on rows nobody touched, and with recount protection on, the guard trigger refused a
  // staff counter's whole Save All over rows they had not changed (S756). A cell is now written
  // only when it differs from this record; a cell deliberately blanked still differs, so it is
  // still an explicit delete. It is a ref, not state: nothing renders from it, and the save
  // handlers must read it live rather than through a render's closure.
  const storedRef = useRef({ periodId: null, cells: {} })
  function resetStored(periodId, data) {
    const cells = {}
    Object.entries(data || {}).forEach(([id, row]) => {
      cells[id] = { opening: toQty(row.opening), closing: toQty(row.closing), wastage: toQty(row.wastage), staff_meal: toQty(row.staff_meal) }
    })
    storedRef.current = { periodId, cells }
  }
  // Records writes that landed. A late answer for a period no longer on screen is ignored — the
  // record is of the period being shown. Closing counts also update the "counted by" line.
  function markStored(periodId, fieldKey, entries, by) {
    if (storedRef.current.periodId !== periodId) return
    const cells = storedRef.current.cells
    entries.forEach(e => { cells[e.itemId] = { ...cells[e.itemId], [fieldKey]: e.qty } })
    if (fieldKey === 'closing') {
      setCountedBy(prev => {
        const next = { ...prev }
        entries.forEach(e => { if (e.qty == null) delete next[e.itemId]; else next[e.itemId] = e.line !== undefined ? e.line : (by?.counted_by_name || null) })
        return next
      })
    }
  }
  function isChanged(itemId, fieldKey, value) {
    return !sameStored(fieldKey, toQty(value), storedRef.current.cells[itemId]?.[fieldKey] ?? null)
  }

  // Both signals have to be watched: `resize` catches the narrow-window clause, and the media query
  // itself fires when the primary pointer changes (a detachable tablet docked to a keyboard, or
  // devtools device emulation being toggled).
  useEffect(() => {
    const handler = () => setIsMobile(isTouchCount())
    const mq = window.matchMedia?.(COARSE_POINTER)
    window.addEventListener('resize', handler)
    mq?.addEventListener?.('change', handler)
    return () => {
      window.removeEventListener('resize', handler)
      mq?.removeEventListener?.('change', handler)
    }
  }, [])

  useEffect(() => {
    const up   = () => { setIsOnline(true);  flushRef.current?.() }
    const down = () => setIsOnline(false)
    window.addEventListener('online',  up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  useEffect(() => {
    if (!authLoading && effectiveClientId) {
      // init() is async and nothing awaits it, so a throw inside it used to be an unhandled
      // rejection: setLoading(false) never ran and the page sat on "Loading…" forever with no
      // error anywhere. Every IndexedDB call it makes can reject — Firefox private browsing
      // refuses indexedDB.open outright, and an evicted or blocked store does the same — and
      // since flushQueue() is the FIRST thing init() does, that took the ONLINE path down too:
      // an unusable local cache bricked a page that did not need it.
      init().catch(err => {
        setLoadError(err?.supabase || err || new Error('Stock Count could not be loaded.'))
        setLoading(false)
      })
    }
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  // The day the Daily Wastage tab opens on. Today's day-of-month is right for the current period
  // and can be past the end of a shorter or earlier one (day 32 of a 29-day month), so it is
  // clamped to the period being shown.
  function clampWDay(period) {
    if (!period) return
    const max = daysInBsMonth(period.bs_year, period.bs_month)
    setWDay(d => Math.min(Math.max(1, d), max))
  }

  async function init() {
    setLoading(true)
    // `loading` covers the page from here; a month switch this load supersedes can no longer
    // clear its own flag (it is not the current request any more), so it is cleared here.
    setPeriodLoading(false)
    setClosedCarry(null)
    setLoadError(null)

    if (!navigator.onLine) {
      // Offline AND no readable local store is a real dead end, unlike the online path — say so
      // rather than rendering an empty item list, which reads as "this client has no items".
      let cachedItems, cachedCats, cachedPeriods
      try {
        ;[cachedItems, cachedCats, cachedPeriods] = await Promise.all([
          getCachedItems(effectiveClientId),
          getCachedCategories(effectiveClientId),
          getCachedPeriods(effectiveClientId),
        ])
      } catch (err) {
        setLoadError(err instanceof Error ? err : new Error(String(err)))
        setLoading(false)
        return
      }
      if (cachedItems)   setItems(cachedItems)
      if (cachedCats)    setCategories(cachedCats)
      if (cachedPeriods) {
        setPeriods(cachedPeriods)
        const open = cachedPeriods.find(x => x.status === 'open')
        if (open) {
          setSelectedPeriod(open)
          clampWDay(open)
          const cached = await getCachedStockData(open.id).catch(() => null)
          if (cached) {
            const pending = await getQueue().catch(() => [])
            const sd = { ...(cached.stockData || {}) }
            pending.forEach(op => {
              if (op.periodId === open.id) {
                if (!sd[op.itemId]) sd[op.itemId] = {}
                sd[op.itemId] = { ...sd[op.itemId], [op.fieldKey]: op.qty ?? '' }
              }
            })
            setStockData(sd)
            // Queued figures count as recorded: the queue is what will write them.
            resetStored(open.id, sd)
            restoreSummaryPopulation(cached)
            setPurchases(cached.purchases    || {})
            setReturns(cached.returns        || {})
            setPurchaseValues(cached.purchaseValues || null)
            setReturnValues(cached.returnValues || null)
            setRequisitioned(cached.requisitioned || {})
            // The badge counts everything still waiting for THIS client, across every month —
            // the same set flushQueue() will attempt. It used to count only the open period's
            // ops while the sync banner counted all of them, so the two numbers describing one
            // queue disagreed. `pendingItems` stays period-scoped: it highlights rows in the
            // table on screen, which is a different question.
            setPendingSync(pending.filter(op => !op.clientId || op.clientId === effectiveClientId).length)
            setPendingItems(new Set(pending.filter(op => op.periodId === open.id).map(op => op.itemId)))
          } else {
            resetStored(open.id, {})
            restoreSummaryPopulation(null)
          }
        }
      }
      setLoading(false)
      return
    }

    // Replay anything counted offline BEFORE reading the server, not alongside it. The two used to
    // run concurrently from the effect, so when the read landed first the synced counts were
    // dequeued but not on screen — and the next Save All wrote the stale screen back over them.
    await flushQueue()

    // The assignment read is issued for a staff-rank account whether or not scoping is switched on
    // — `settings` may not have landed yet, and a second read fired later would be a waterfall on
    // the one page a month is counted on. It is a handful of rows.
    const initResults = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      // Paged (S756): past 1000 items the count sheet silently had no rows for the tail of the
      // book, and every read below is keyed on this list. `id` is the unique tiebreaker.
      fetchAllRows(() => scopedFrom('items', '*, categories(name)').eq('is_active', true).order('name').order('id')),
      scopedFrom('categories').order('sort_order'),
      isCounter
        ? scopedFrom('ims_count_assignments', 'category_id').eq('profile_id', profile.id)
        : Promise.resolve({ data: [], error: null }),
      // The hidden items, for the Summary only (S792, D29) — kept apart from the list above so no
      // entry grid, save path or offline item cache can ever reach one. In the failure check below
      // like every other read: a Summary that silently lost its hidden items' stock is the defect
      // this read exists to end.
      fetchAllRows(() => scopedFrom('items', '*, categories(name)').eq('is_active', false).order('name').order('id')),
    ])
    // A failed read is not "no periods yet" — that empty state is a claim about the client. The
    // assignment read is in this check on purpose: dropping its error would leave myCategoryIds
    // null, which renders as "nothing is yours" — a claim, not an absence.
    const initFailed = firstError(initResults)
    if (initFailed) { setLoadError(initFailed); setLoading(false); return }
    const [{ data: p }, { data: i }, { data: c }, { data: assigned }, { data: hidden }] = initResults
    setMyCategoryIds(new Set((assigned || []).map(a => a.category_id)))
    setPeriods(p || [])
    setItems(i || [])
    setHiddenItems(hidden || [])
    setCategories(c || [])
    // Warming the offline cache is an accelerator, never the data path — the server read above
    // has already succeeded. A rejection here (no store, quota) must not fail a load that worked.
    await Promise.all([
      cachePeriods(effectiveClientId, p || []),
      cacheItems(effectiveClientId, i || []),
      cacheCategories(effectiveClientId, c || []),
    ]).catch(() => {})
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      periodReq.begin(open.id)   // the auto-selected period claims the page like a chosen one
      setSelectedPeriod(open)
      clampWDay(open)
      await loadStockData(open.id, i || [], hidden || [])
    }
    setLoading(false)
  }

  // The Summary's hidden items and row ids for one month, from the offline copy of that month
  // (S792, D29). A copy written before these were cached has neither, and the Summary then values
  // active items only — what it did before — rather than inventing a population.
  function restoreSummaryPopulation(cached) {
    setSummaryRowIds(new Set(cached?.rowIds || []))
    if (cached?.hiddenItems) setHiddenItems(cached.hiddenItems)
  }

  // `hiddenList` is the client's hidden items — the ones with a row this period go into the offline
  // copy, so the Summary of a month opened offline values the same items it did online.
  async function loadStockData(periodId, itemList, hiddenList = hiddenItems) {
    // Every one of these is paged. PostgREST's silent 1000-row cap (S528/S529) is worst here of
    // anywhere: a truncated read produces a *plausible* COGS rather than an error, and this is the
    // page a month is closed from. `wastages` is the one that realistically crosses it — daily
    // entries are one row per item per day — but opening/closing are one row per item, so a client
    // past 1000 items would silently lose stock too. Each needs a unique tiebreaker in its sort or
    // paging can repeat a row on one page and skip it on the next.
    setLoadError(null)
    const results = await Promise.all([
      fetchAllRows(() => supabase.from('opening_stock').select('*').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('*').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('id, item_id, qty, bs_day, reason, items(name, uom, per_uom_rate)').eq('period_id', periodId).order('id')),
      // Read and write must agree on `type`: persistValueDirect deletes and reinserts ONLY
      // type='staff', so counting a 'comp' row here would show a figure this tab cannot edit and
      // would double it on the next save. Nothing writes 'comp' today; this keeps it that way.
      fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId).eq('type', 'staff').order('id')),
      // rate + discount_amount + the bill-key columns are what allocateBillDiscounts() needs to
      // value each line net of its bill's discount (S756) — vendor-payables.md's `a || b` rule: a
      // bill written before grouping has no purchase_group_id, and without the vendor_id/
      // invoice_ref/bs_day fallback every such line would be treated as its own bill.
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty, rate, discount_amount, purchase_group_id, vendor_id, invoice_ref, bs_day, vat_inclusive, vat_is_cost').eq('period_id', periodId).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'item_id, qty, rate, purchase_entries(vat_inclusive, vat_is_cost)').eq('period_id', periodId).order('id')),
      // Independent of the six reads above but previously awaited after them — one extra serial
      // round trip on every load of the heaviest page.
      fetchAllRows(() => supabase
        .from('requisition_lines')
        .select('item_id, qty_issued, requisitions!inner(client_id, period_id, status)')
        .eq('requisitions.period_id', periodId)
        .eq('requisitions.status', 'issued')
        .order('id')),
    ])
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    // A failed read must not render as an empty month. Every read here destructured `{ data }`
    // and dropped `error` until S695, so an RLS refusal or auth stall showed every cell blank —
    // and Save All then deleted the server's real rows for every visible item (a blank is "no
    // row"). The requisitions read used to degrade to "no requisitions"; it is in the check now
    // because a Summary the month is closed on should not carry one silently missing column.
    const failed = firstError(results)
    if (failed) {
      setLoadError(failed)
      setStockData({}); setPurchases({}); setReturns({}); setRequisitioned({}); setPurchFreq({})
      setPurchaseValues({}); setReturnValues({}); setCountedBy({})
      setDailyWastage({}); setDailyRows([])
      setSummaryRowIds(new Set())
      resetStored(periodId, {})
      return
    }
    const [{ data: opening }, { data: closing }, { data: wastages }, { data: staffMealsData }, { data: purch }, { data: rets }, reqRes] = results

    // Which items had any row this month (S792, D29) — what admits a hidden item to the Summary.
    const rowIds = periodRowIds({ opening, closing, purchases: purch, returns: rets, wastages, staffMeals: staffMealsData })
    setSummaryRowIds(rowIds)

    const data = {}
    const items = itemList || []
    items.forEach(item => { data[item.id] = { opening: '', closing: '', wastage: '', staff_meal: '' } })
    // A row for an item not in the list — a hidden item, since S792 (D29) — is KEPT rather than
    // dropped, so the Summary can value it. It is never rendered on an entry grid (those iterate
    // `items`), and every save path iterates the visible items, so holding its figures here writes
    // nothing. Before this the four loops below discarded such rows, which is how hiding an item
    // took its opening, count, wastage and staff meals out of the month's Summary.
    const cellOf = id => (data[id] || (data[id] = { opening: '', closing: '', wastage: '', staff_meal: '' }))
    ;(opening || []).forEach(r => { cellOf(r.item_id).opening = r.qty })
    const countedMap = {}
    ;(closing || []).forEach(r => {
      cellOf(r.item_id).closing = r.physical_qty
      if (r.physical_qty != null) countedMap[r.item_id] = countedByLine(r)
    })
    setCountedBy(countedMap)

    // Split wastage: undated rows (bs_day NULL) = the monthly catch-all edited in the Wastage tab;
    // dated rows = daily entries. Period total wastage = catch-all + daily (see getUsed/getSummary).
    const catchAllMap = {}
    const dailyMap = {}
    const dated = []
    ;(wastages || []).forEach(r => {
      const q = parseFloat(r.qty) || 0
      if (r.bs_day == null) {
        catchAllMap[r.item_id] = (catchAllMap[r.item_id] || 0) + q
      } else {
        dailyMap[r.item_id] = (dailyMap[r.item_id] || 0) + q
        dated.push(r)
      }
    })
    Object.keys(catchAllMap).forEach(id => { cellOf(id).wastage = catchAllMap[id] })
    setDailyWastage(dailyMap)
    setDailyRows(dated)

    const staffMealMap = {}
    ;(staffMealsData || []).forEach(r => { staffMealMap[r.item_id] = (staffMealMap[r.item_id] || 0) + parseFloat(r.qty) })
    Object.keys(staffMealMap).forEach(id => { cellOf(id).staff_meal = staffMealMap[id] })

    setStockData(data)
    resetStored(periodId, data)

    const purchMap = {}
    const freqMap = {}
    const purchValMap = {}
    // allocateBillDiscounts runs over EVERY line of the period, not just this page's items: a
    // bill's discount is shared across all its lines, including lines for items outside the list.
    ;allocateBillDiscounts(purch || []).forEach(r => {
      purchMap[r.item_id] = (purchMap[r.item_id] || 0) + parseFloat(r.qty)
      purchValMap[r.item_id] = (purchValMap[r.item_id] || 0) + r.lineCost
      freqMap[r.item_id] = (freqMap[r.item_id] || 0) + 1
    })
    setPurchases(purchMap)
    setPurchaseValues(purchValMap)
    setPurchFreq(freqMap)

    // Returns map — quantity, and value at the rate each return was recorded at (list rate, as
    // Monthly Summary and the frozen report take it).
    const retMap = {}
    const retValMap = {}
    ;(rets || []).forEach(r => {
      retMap[r.item_id] = (retMap[r.item_id] || 0) + parseFloat(r.qty)
      retValMap[r.item_id] = (retValMap[r.item_id] || 0) + returnCostValue(r)   // D32: a PAN outlet's VAT is cost
    })
    setReturns(retMap)
    setReturnValues(retValMap)

    // Requisitioned map — qty issued via store requisitions
    const reqMap = {}
    ;(reqRes?.data || []).forEach(r => { reqMap[r.item_id] = (reqMap[r.item_id] || 0) + parseFloat(r.qty_issued || 0) })
    setRequisitioned(reqMap)

    try {
      await cacheStockData(periodId, {
        stockData: data, purchases: purchMap, returns: retMap, purchaseValues: purchValMap, returnValues: retValMap, requisitioned: reqMap,
        rowIds: [...rowIds], hiddenItems: (hiddenList || []).filter(h => rowIds.has(h.id)),
      })
    } catch (_) {}
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    setPeriodLoading(true)      // with the label, in the same render (STOCK-6)
    try {
      await switchPeriod(periodId)
    } finally {
      // A slower, earlier switch finishing late must not reopen the page over a load still running.
      if (periodReq.isCurrent(periodId)) setPeriodLoading(false)
    }
  }

  async function switchPeriod(periodId) {
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    clampWDay(p)
    setPageNotice(null)
    if (!navigator.onLine) {
      const cached = await getCachedStockData(periodId).catch(() => null)
      if (!periodReq.isCurrent(periodId)) return
      setCountedBy({})   // not cached; an empty line is better than the previous month's names
      if (cached) {
        setStockData(cached.stockData    || {})
        resetStored(periodId, cached.stockData)
        restoreSummaryPopulation(cached)
        setPurchases(cached.purchases    || {})
        setReturns(cached.returns        || {})
        setPurchaseValues(cached.purchaseValues || null)
        setReturnValues(cached.returnValues || null)
        setRequisitioned(cached.requisitioned || {})
      } else {
        // No offline copy of this month: show it EMPTY under its own label. Leaving the previous
        // month's figures on screen here meant a Save All queued last month's counts against this
        // month's period id.
        const blank = {}
        items.forEach(item => { blank[item.id] = { opening: '', closing: '', wastage: '', staff_meal: '' } })
        setStockData(blank); setPurchases({}); setReturns({}); setRequisitioned({})
        setPurchaseValues({}); setReturnValues({})
        setDailyWastage({}); setDailyRows([])
        restoreSummaryPopulation(null)
        resetStored(periodId, blank)
        setPageNotice('This month has not been opened on this device while online, so its saved figures are not available offline. Anything you enter now is queued and will sync when you reconnect.')
      }
      return
    }
    await loadStockData(periodId, items)
  }

  function updateField(itemId, field, value) {
    setStockData(prev => ({ ...prev, [itemId]: { ...prev[itemId], [field]: value } }))
  }

  // supabase-js resolves `{ error }` and never throws, so before S682 a refused write (a closed
  // period's trigger, an RLS refusal, a dropped connection) passed straight through the promise
  // chains below and the cell kept reading as saved. `fail()` turns it into a thrown error the
  // chain's catch records against the row. `cleared` is for the two delete-then-insert fields:
  // once the delete has landed and the insert is refused, the server holds NOTHING for that item
  // — a different fact from "your new figure did not save", and the message has to say which.
  const fail = (error, cleared = false) => {
    if (error) throw Object.assign(new Error(error.message || String(error)), { supabase: error, cleared })
  }
  // Who counted, as the closing row records it (S737). `counted_by` had existed since the baseline
  // schema and nothing had ever written it, so a month's count was anonymous.
  //
  // The NAME is snapshotted beside the id on purpose: the FK is ON DELETE SET NULL, so removing a
  // staff account would otherwise erase the attribution rather than just the link. Same reasoning
  // as the owner report's "resolve FK display values at generation time".
  const countedByFields = () => ({
    counted_by: profile?.id || null,
    counted_by_name: profile?.full_name || null,
  })

  // `qty` is null for a blank cell (see toQty). Closing keeps a 0 as a row — a count of nothing
  // is still a count; every other field treats 0 and blank alike.
  //
  // `countedBy` is passed in rather than read live because of the offline queue: the person who
  // counted is not necessarily the session that syncs, and a shared tablet is exactly where those
  // differ. Stamped at enqueue time, replayed as stamped.
  //
  // `mode` is D37's (S792 stage 4) and applies to a counted closing figure only: 'check' (the
  // default) saves nothing over another person's count and throws CountConflictError instead;
  // 'replace' and 'add' are the counter's answer. Returns the row the server saved, for closing.
  async function persistValueDirect(periodId, itemId, fieldKey, qty, countedBy = countedByFields(), mode = 'check') {
    const noRow = isNoRow(fieldKey, qty)
    if (fieldKey === 'opening') {
      if (noRow) {
        fail((await supabase.from('opening_stock').delete().eq('period_id', periodId).eq('item_id', itemId)).error)
      } else {
        fail((await supabase.from('opening_stock').upsert({ period_id: periodId, item_id: itemId, qty }, { onConflict: 'period_id,item_id' })).error)
      }
    }
    if (fieldKey === 'closing') {
      if (noRow) {
        fail((await supabase.from('closing_stock').delete().eq('period_id', periodId).eq('item_id', itemId)).error)
      } else {
        const { saved, conflicts } = await saveClosingCounts(periodId, [{ itemId, qty }], countedBy, mode)
        if (conflicts.length) throw new CountConflictError(conflicts)
        return saved[0] || null
      }
    }
    if (fieldKey === 'wastage') {
      // Only the undated catch-all row — dated daily-wastage rows are managed in the Daily Wastage tab.
      fail((await supabase.from('wastages').delete().eq('period_id', periodId).eq('item_id', itemId).is('bs_day', null)).error)
      if (!noRow) fail((await supabase.from('wastages').insert({ period_id: periodId, item_id: itemId, qty, bs_day: null })).error, true)
    }
    if (fieldKey === 'staff_meal') {
      fail((await supabase.from('staff_meals').delete().eq('period_id', periodId).eq('item_id', itemId).eq('type', 'staff')).error)
      if (!noRow) fail((await supabase.from('staff_meals').insert({ period_id: periodId, item_id: itemId, qty, type: 'staff' })).error, true)
    }
  }

  // Counted closing figures go through save_closing_counts (D37, migration 20260929100000): the
  // check against another person's count and the write are one statement per item, so a
  // read-then-upsert race cannot slip a second tablet's figure through, and an add is atomic.
  // Until that migration is applied the RPC does not exist, and the old plain upsert runs instead
  // (the persistSalesDay precedent) — every other error is thrown as it came.
  async function saveClosingCounts(periodId, entries, by, mode = 'check') {
    const { data, error } = await supabase.rpc('save_closing_counts', { p_period_id: periodId, p_rows: closingRpcRows(entries, by, mode) })
    if (error && rpcMissing(error)) {
      fail((await supabase.from('closing_stock').upsert(
        entries.map(e => ({ period_id: periodId, item_id: e.itemId, physical_qty: e.qty, counted_at: new Date().toISOString(), ...by })),
        { onConflict: 'period_id,item_id' })).error)
      return { saved: entries.map(e => ({ item_id: e.itemId, physical_qty: e.qty, counted_by_name: by?.counted_by_name || null })), conflicts: [] }
    }
    fail(error)
    return { saved: data?.saved || [], conflicts: data?.conflicts || [] }
  }
  // Records closing rows the server saved. `onScreen` also puts the stored figure in the cell: an
  // add stores more than was typed, and "keep theirs" stores what someone else typed. A plain save
  // leaves the cell alone — the counter may already be typing the next figure into it.
  function applySavedClosing(periodId, rows, onScreen = false) {
    if (!rows?.length) return
    markStored(periodId, 'closing', rows.map(r => ({ itemId: r.item_id, qty: Number(r.physical_qty), line: countedByLine(r) })))
    if (!onScreen || storedRef.current.periodId !== periodId) return
    setStockData(prev => {
      const next = { ...prev }
      rows.forEach(r => { next[r.item_id] = { ...next[r.item_id], closing: fmtQty(r.physical_qty) } })
      return next
    })
  }

  // D37: counts another person already holds, waiting for "add, replace or keep theirs". Each row
  // carries its own period, and `op` when it came from the offline queue.
  const [countConflicts, setCountConflicts] = useState(null)   // { rows } or null
  const [conflictBusy, setConflictBusy] = useState(false)
  const [conflictError, setConflictError] = useState(null)
  function openCountConflicts(periodId, conflicts, mine) {
    const rows = conflicts.map(c => {
      const m = mine.find(x => x.itemId === c.item_id) || {}
      const item = allItems.find(i => i.id === c.item_id)
      return { periodId, itemId: c.item_id, name: item?.name || m.op?.itemName || 'An item', uom: item?.uom || '', mine: m.qty, other: c, op: m.op || null }
    })
    setConflictError(null)
    setCountConflicts(prev => {
      const keep = (prev?.rows || []).filter(r => !rows.some(n => n.periodId === r.periodId && n.itemId === r.itemId))
      return { rows: [...keep, ...rows] }
    })
  }
  async function resolveCountConflicts(chosen) {
    setConflictBusy(true)
    setConflictError(null)
    const done = []
    for (const row of chosen) {
      try {
        if (row.choice === 'keep') {
          applySavedClosing(row.periodId, [{ ...row.other, item_id: row.itemId }], true)
        } else {
          const by = row.op ? row.op.countedBy : countedByFields()
          const saved = await withKeyLock(`${row.itemId}:closing`, () =>
            persistValueDirect(row.periodId, row.itemId, 'closing', row.mine, by, row.choice))
          applySavedClosing(row.periodId, [saved], true)
          noteDirectWrite(row.periodId, 'closing', [{ itemId: row.itemId }])
          noteClosedCorrection(row.periodId, 'closing', [{ itemId: row.itemId, qty: Number(saved?.physical_qty) }])
        }
        if (row.op) {
          try { await dequeue(row.op.id) } catch (_) { /* decided; a replay would only ask again */ }
          setPendingSync(prev => Math.max(0, prev - 1))
          setPendingItems(prev => { const next = new Set(prev); next.delete(row.itemId); return next })
        }
        done.push(row)
      } catch (err) {
        // Recount protection refuses a staff counter's Replace (only Add is theirs to choose); a
        // closed month or another section refuses anything. The row stays in the dialog.
        setConflictError(asActionError(err?.supabase || err, canManageCounts ? 'operator' : 'staff'))
        break
      }
    }
    setCountConflicts(prev => {
      const left = (prev?.rows || []).filter(r => !done.some(d => d.periodId === r.periodId && d.itemId === r.itemId))
      return left.length ? { rows: left } : null
    })
    setConflictBusy(false)
  }

  const FIELD_LABEL = { opening: 'opening stock', closing: 'closing count', wastage: 'wastage', staff_meal: 'staff meal' }
  // Called from the promise chains' catch: names the row, says what the server holds NOW, and
  // keeps the raw detail. Nothing here claims the write did not land (a dead fetch does not prove
  // that) — it says the value on screen is not known to be stored, which is the honest fact.
  // "Re-enter it and save again" is offered only where a retry can pass (S792, STOCK-7): a closed
  // month, recount protection or a section outside scope leads with its reason instead. And the
  // reason is worded for who is reading it: a counter or supervisor can only escalate ('staff'),
  // while admin, the Owner and an IMS manager are the ones who fix it ('operator').
  function noteSaveFailure(itemId, fieldKey, err, count) {
    const label = FIELD_LABEL[fieldKey] || fieldKey
    const name = itemId ? (items.find(i => i.id === itemId)?.name || 'this item') : `${count} item(s)`
    setSaveError(countSaveFailureText({
      label, name, cleared: !!err?.cleared, err: err?.supabase || err,
      audience: canManageCounts ? 'operator' : 'staff',
    }))
  }

  // Wastage/staff-meal saves are delete()-then-insert() (two round trips, unlike opening/
  // closing's atomic upsert) — an onBlur autosave racing an immediate "Save All"/"Clear All"
  // click for the SAME item+field could otherwise interleave (both DELETEs land before either
  // INSERT), leaving two rows for that item+period and double-counting its cost downstream.
  // Serializing every persistValue call through a per-(item,field) promise chain means a second
  // call for the same key always waits for the first's round trip to fully finish before it
  // starts its own, so the two delete/insert pairs can never overlap.
  // Resolves true when the write landed (or was queued), false when it did not — the failure is
  // already recorded on the page by then. Callers use the boolean to decide whether to show the
  // "✓ Saved" state; they must never show it unconditionally (S695).
  // `navigator.onLine` only reports whether the device has a network INTERFACE. On a restaurant
  // wifi with no upstream, or when the signal dies between pressing Save and the request landing,
  // it stays true — so the write took the direct path, failed, and was reported as a lost count
  // while the offline queue, the entire point of which is this situation, was never consulted.
  //
  // The replay is safe to attempt because every write here is idempotent: opening/closing are
  // upserts, and wastage/staff_meal are delete-then-insert over the same key, so re-running one
  // converges on the same rows whether or not the original landed. That matters, because a dead
  // fetch never proves the write did not land — it only proves we did not hear back.
  //
  // Only a NETWORK failure qualifies. An RLS refusal, a closed-period trigger or a constraint
  // violation is a decision the server made, and queueing it would retry a refusal for ever.
  async function queueOnNetworkFailure(err, fieldKey, entries) {
    if (!isNetworkError(err?.supabase || err)) return false
    try {
      for (const e of entries) {
        await enqueue({ clientId: effectiveClientId, periodId: selectedPeriod.id, itemId: e.itemId, fieldKey, qty: e.qty, countedBy: countedByFields(), checkCount: true, ...queueLabels(e.itemId) })
      }
    } catch (_) {
      return false   // no local store either; fall through to the ordinary failure message
    }
    setPendingSync(prev => prev + entries.length)
    setPendingItems(prev => { const next = new Set(prev); entries.forEach(e => next.add(e.itemId)); return next })
    markStored(selectedPeriod.id, fieldKey, entries, countedByFields())   // the queue is now the record
    setPageNotice(`The connection dropped before ${entries.length === 1 ? 'that figure' : 'those figures'} could be saved, so ${entries.length === 1 ? 'it has' : 'they have'} been held on this device instead. Press Sync Now once you are back on a working connection.`)
    return true
  }

  const persistLocks = useRef({})
  // Writes started and not yet settled, per `${itemId}:${fieldKey}` — see saveRow (S756).
  const inflight = useRef({})
  const trackInflight = (keys, promise) => {
    keys.forEach(k => { inflight.current[k] = (inflight.current[k] || 0) + 1 })
    promise.finally(() => keys.forEach(k => { inflight.current[k] -= 1; if (inflight.current[k] <= 0) delete inflight.current[k] }))
  }
  // When a DIRECT write for a cell last landed, keyed `${periodId}:${itemId}:${fieldKey}` (S792,
  // STOCK-1). A figure queued offline carries the moment it was queued, and the replay skips one
  // that a later save has already overtaken — the counter corrects Rice from 5 to 6 while the
  // replay of the old 5 is still working through the queue, and the 6 must be what stays.
  const directWriteAt = useRef({})
  const noteDirectWrite = (periodId, fieldKey, entries) => {
    const at = Date.now()
    entries.forEach(e => { directWriteAt.current[`${periodId}:${e.itemId}:${fieldKey}`] = at })
  }
  // Runs one write in the per-(item, field) chain every other save of that cell uses, so a replay
  // and an on-blur save can never interleave their delete/insert pairs (S792: the replay used to
  // bypass the lock, which is how two replays doubled a wastage or staff-meal row).
  function withKeyLock(key, fn) {
    const prior = persistLocks.current[key] || Promise.resolve()
    const run = prior.then(fn)
    const tail = run.catch(() => {})   // recorded by the caller; never wedges the chain
    persistLocks.current[key] = tail
    trackInflight([key], tail)
    return run
  }
  async function persistValue(itemId, fieldKey, qty) {
    const key = `${itemId}:${fieldKey}`
    const prior = persistLocks.current[key] || Promise.resolve()
    const run = prior.then(async () => {
      if (!navigator.onLine) {
        // `clientId` is what lets flushQueue() tell this outlet's counts from those of whoever
        // used the device before — see the note there.
        await enqueue({ clientId: effectiveClientId, periodId: selectedPeriod.id, itemId, fieldKey, qty, countedBy: countedByFields(), checkCount: true, ...queueLabels(itemId) })
        setPendingSync(prev => prev + 1)
        setPendingItems(prev => new Set([...prev, itemId]))
        markStored(selectedPeriod.id, fieldKey, [{ itemId, qty }], countedByFields())
        return true
      }
      const saved = await persistValueDirect(selectedPeriod.id, itemId, fieldKey, qty)
      if (saved) applySavedClosing(selectedPeriod.id, [saved])
      else markStored(selectedPeriod.id, fieldKey, [{ itemId, qty }], countedByFields())
      noteDirectWrite(selectedPeriod.id, fieldKey, [{ itemId }])
      noteClosedCorrection(selectedPeriod.id, fieldKey, [{ itemId, qty }])
      return true
    }).catch(async err => {
      // Someone else counted it first (D37): nothing was written, and the counter decides.
      if (err instanceof CountConflictError) {
        openCountConflicts(selectedPeriod.id, err.conflicts, [{ itemId, qty }])
        return 'conflict'
      }
      // A dropped connection is held, not lost — see queueOnNetworkFailure. Anything else is a
      // decision the server made and is recorded on the page as one.
      if (await queueOnNetworkFailure(err, fieldKey, [{ itemId, qty }])) return 'queued'
      noteSaveFailure(itemId, fieldKey, err)
      return false
    }) // recorded, and never wedges the chain for this key
    persistLocks.current[key] = run
    trackInflight([key], run)
    return run
  }

  // Replays what was counted offline. Two things it must not do, both learned the hard way:
  //
  // It must not replay another tenant's ops. The queue is one IndexedDB store shared by every
  // account that has used this device, and a queued op used to carry only a period id — so after
  // a sign-out on a shared counting tablet, or an outlet switch, the next session's init() sent
  // the previous one's counts under its own JWT, where RLS refuses them. `switchOutlet()` in
  // AuthContext already refuses to switch while the queue is non-empty for exactly this reason;
  // sign-out has no such guard, so the op now carries the client it was counted against and
  // anything belonging elsewhere is left where it is. (An op with no clientId predates S731 —
  // flushed as before rather than stranded, since it is far more likely to be this device's own
  // interrupted count than someone else's.)
  //
  // And it must not swallow the refusal. A count queued against a month that was closed while the
  // device was offline can never land; retrying it silently on every page load is not resilience,
  // it is a figure the counter believes is saved and is not.
  // What a held figure was, in words — carried on the queued op (S756) because a replay runs before
  // the page has read its items, and a refused figure the counter cannot identify is a lost one.
  function queueLabels(itemId) {
    return {
      itemName: allItems.find(i => i.id === itemId)?.name || null,
      periodLabel: selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : null,
    }
  }

  // One replay at a time (S792, STOCK-1). The `online` event can fire more than once on a flapping
  // connection, and init() replays too; two runs over the same queue replayed every op twice, which
  // on the delete-then-insert tables (wastage, staff meals — no unique key) left two rows each. A
  // second trigger while a replay runs joins it rather than starting another.
  const flushingRef = useRef(null)
  function flushQueue() {
    if (flushingRef.current) return flushingRef.current
    const run = flushQueueOnce().finally(() => { flushingRef.current = null })
    flushingRef.current = run
    return run
  }

  const opLine = op => `${op.itemName || 'an item'} — ${FIELD_LABEL[op.fieldKey] || op.fieldKey} ${op.qty ?? 'blank'}`
  const monthOf = p => (p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : null)

  // Figures counted offline for a month that has closed since, held for the Owner or admin to
  // decide about (S792, D38). Their login may still write a closed month, so the replay used to
  // land them there silently — after that month's closing count had already been carried into the
  // next month's opening stock, so the next month opened on the old figure. Now nothing lands on
  // its own: the list is shown with one button that adds them AND carries the closing counts on.
  const [heldClosed, setHeldClosed] = useState(null)   // { ops, periods } or null
  const [heldBusy, setHeldBusy] = useState(false)
  const [heldError, setHeldError] = useState(null)

  async function flushQueueOnce() {
    let queue
    try {
      queue = await getQueue()
    } catch (_) {
      // No usable offline store on this device (private browsing, evicted storage). Nothing was
      // queued here, so there is nothing to replay — and this must never take the page down with
      // it: init() awaits this before it reads the server at all.
      return
    }
    const mine = (queue || []).filter(op => !op.clientId || op.clientId === effectiveClientId)
    if (mine.length === 0) { setPendingSync(0); setSyncFailed(null); setHeldClosed(null); return }
    setSyncing(true)
    setSyncFailed(null)
    let remaining = mine.length
    const settle = op => {
      remaining--
      setPendingSync(remaining)
      setPendingItems(prev => { const next = new Set(prev); next.delete(op.itemId); return next })
    }
    const forget = async op => {
      try { await dequeue(op.id) } catch (_) { /* stays queued; the next replay decides it again */ }
      settle(op)
    }

    // Only the NEWEST figure for a cell is written (S792, STOCK-1): the queue is replayed in the
    // order it was typed, but an older figure written after a newer one — because the newer one
    // landed in an earlier replay, or directly once the connection came back — overwrote the
    // correction while the card showed "✓ Saved". Older figures for the same cell leave unwritten.
    const byKey = new Map()
    ;[...mine].sort((a, b) => a.id - b.id).forEach(op => byKey.set(`${op.periodId}:${op.itemId}:${op.fieldKey}`, op))
    const latest = new Set([...byKey.values()].map(op => op.id))
    for (const op of mine) if (!latest.has(op.id)) await forget(op)

    // Which months are closed NOW, read fresh — a counting tablet can sit open for days, so the
    // page's own period list is not evidence. An unreadable list stops the replay: the queue is
    // kept, which is the safe answer to a question that could not be asked.
    const { data: freshPeriods, error: perErr } = await scopedFrom('monthly_periods', 'id, status, bs_year, bs_month')
    if (perErr) {
      setSyncing(false)
      const { text, detail } = asActionError(perErr)
      setSyncFailed({ text: `${remaining} figure${remaining === 1 ? '' : 's'} counted on this device ${remaining === 1 ? 'is' : 'are'} still waiting: the months could not be checked, so nothing was sent. Press Sync Now to try again. ${text}`, detail })
      return
    }
    const periodById = new Map((freshPeriods || []).map(p => [p.id, p]))

    const refusedClosed = []   // a staff login: the database refuses a closed month (D1)
    const refusedOther = []    // any other refusal: another section, recount protection, rank
    const heldForOwner = []    // the Owner or admin: held for their decision (D38)
    const heldConflict = []    // someone else counted it first: the counter decides (D37)
    let stoppedOn = null       // the connection dropped: the rest stays queued, in order

    for (const op of [...byKey.values()].sort((a, b) => a.id - b.id)) {
      const key = `${op.periodId}:${op.itemId}:${op.fieldKey}`
      if ((directWriteAt.current[key] || 0) > (op.timestamp || 0)) { await forget(op); continue }
      if (periodById.get(op.periodId)?.status === 'closed') {
        if (canEditClosedPeriods) { heldForOwner.push(op); continue }
        refusedClosed.push(op); await forget(op); continue
      }
      try {
        // A figure queued before D37 shipped carries no checkCount, and is replayed as it always
        // was (replace) rather than raising a question about a count made days ago.
        const mode = op.checkCount ? 'check' : 'replace'
        const saved = await withKeyLock(`${op.itemId}:${op.fieldKey}`, () =>
          persistValueDirect(op.periodId, op.itemId, op.fieldKey, op.qty, op.countedBy, mode))
        if (saved) applySavedClosing(op.periodId, [saved])
        else markStored(op.periodId, op.fieldKey, [{ itemId: op.itemId, qty: op.qty }], op.countedBy)
        await forget(op)
      } catch (err) {
        // Stays queued until someone answers — see resolveCountConflicts.
        if (err instanceof CountConflictError) { heldConflict.push({ op, conflicts: err.conflicts }); continue }
        const e = err?.supabase || err
        // Only a dropped connection is worth another try, and the replay STOPS on the first one:
        // carrying on past it wrote later figures while earlier ones stayed queued, and the next
        // replay then wrote the earlier ones over them.
        if (isNetworkError(e)) { stoppedOn = err; break }
        // Anything else is a decision the server made, and no retry passes it. Kept, it was
        // retried for ever under a "connection" message and later landed under whichever login
        // outranked the counter (S792, STOCK-9). It leaves the queue and is named.
        if (e?.hint === 'period_closed' || /period_closed/.test(e?.message || '')) refusedClosed.push(op)
        else refusedOther.push({ op, err: e })
        await forget(op)
      }
    }
    setSyncing(false)
    setHeldClosed(heldForOwner.length ? { ops: heldForOwner, periods: freshPeriods || [] } : null)
    setHeldError(null)
    heldConflict.forEach(h => openCountConflicts(h.op.periodId, h.conflicts, [{ itemId: h.op.itemId, qty: h.op.qty, op: h.op }]))

    // ONE message covering every outcome (S792, STOCK-3): a replay that hit a closed month and a
    // dropped connection at once used to name only the closed-month figures and return, and the
    // others dropped out of sight.
    const parts = []
    let detail
    if (refusedClosed.length) {
      const month = monthOf(periodById.get(refusedClosed[0].periodId)) || refusedClosed[0].periodLabel || 'that month'
      parts.push(`${refusedClosed.length} figure${refusedClosed.length === 1 ? ' was' : 's were'} entered offline for ${month}, which was closed before ${refusedClosed.length === 1 ? 'it' : 'they'} reached the server, so ${refusedClosed.length === 1 ? 'it was' : 'they were'} not added. Write ${refusedClosed.length === 1 ? 'it' : 'these'} down and give ${refusedClosed.length === 1 ? 'it' : 'them'} to the account owner, who can still enter a closed month: ${refusedClosed.map(opLine).join('; ')}.`)
    }
    if (refusedOther.length) {
      const reason = asActionError(refusedOther[0].err, 'staff')
      detail = reason.detail
      parts.push(`${refusedOther.length} figure${refusedOther.length === 1 ? ' was' : 's were'} refused by the server and ${refusedOther.length === 1 ? 'has' : 'have'} been taken off this device — trying again would be refused the same way: ${refusedOther.map(r => opLine(r.op)).join('; ')}. ${reason.text}`)
    }
    if (stoppedOn) {
      const reason = asActionError(stoppedOn?.supabase || stoppedOn)
      detail = detail || reason.detail
      parts.push(`The connection dropped part-way, so ${remaining - heldForOwner.length - heldConflict.length} figure${remaining - heldForOwner.length - heldConflict.length === 1 ? ' is' : 's are'} still waiting on this device, in the order they were counted. Press Sync Now once the connection is steady.`)
    }
    if (parts.length) setSyncFailed({ text: parts.join(' '), detail })
  }

  // D38's one button: add the held figures to their closed month, then carry the closing counts
  // among them into the next month's opening stock — only those items, never a re-carry of the
  // whole month, so an opening figure someone has since corrected on the next month is left alone.
  async function addHeldToClosedMonth() {
    if (!heldClosed) return
    setHeldBusy(true)
    setHeldError(null)
    const added = []
    for (const op of heldClosed.ops) {
      try {
        // 'replace': the Owner's one button is the decision for these figures (D38).
        await withKeyLock(`${op.itemId}:${op.fieldKey}`, () =>
          persistValueDirect(op.periodId, op.itemId, op.fieldKey, op.qty, op.countedBy, 'replace'))
        try { await dequeue(op.id) } catch (_) { /* written; a replay would only write it again */ }
        added.push(op)
      } catch (err) {
        setHeldError(asActionError(err?.supabase || err))
        break
      }
    }
    // Carry each closed month's added closing counts into the month after it.
    const { carried, failures: carryFailures } = await carryClosingIntoNext(
      added.filter(op => op.fieldKey === 'closing').map(op => ({ periodId: op.periodId, itemId: op.itemId, qty: op.qty })),
      heldClosed.periods)
    const left = heldClosed.ops.filter(op => !added.includes(op))
    setPendingSync(prev => Math.max(0, prev - added.length))
    setHeldClosed(left.length ? { ...heldClosed, ops: left } : null)
    if (carryFailures.length) {
      const { text, detail } = asActionError(carryFailures[0].error)
      setHeldError({ text: `The figures were added to the closed month, but ${monthOf(carryFailures[0].next)}'s opening stock could not be updated from them. Use Resync Opening Stock on the Periods page to carry them on. ${text}`, detail })
    } else if (added.length) {
      setPageNotice(`${added.length} figure${added.length === 1 ? ' was' : 's were'} added to the closed month${carried.length ? ', and the closing counts carried into the next month’s opening stock' : ''}. Regenerate Snapshot on that month’s Monthly Report to bring the frozen report up to date.`)
    }
    setHeldBusy(false)
    // The month on screen may be one of those just written; show what the server now holds.
    if (added.some(op => op.periodId === selectedPeriod?.id) || carried.some(c => c.next.id === selectedPeriod?.id)) {
      await loadStockData(selectedPeriod.id, items)
    }
  }

  // Closing counts into the opening stock of the month after theirs — the next one that EXISTS
  // (closePeriod.js' rule) — for the items given only, never a re-carry of the whole month, so an
  // opening figure someone has since corrected on the next month is left alone. A blank count
  // carries nothing, as the month-end carry does. Shared by D38's held offline figures and a
  // closed-month correction made on this page (S792, STOCK-5). `entries`: [{ periodId, itemId, qty }].
  async function carryClosingIntoNext(entries, periodList) {
    const byPeriod = new Map()
    entries.filter(e => e.qty != null).forEach(e => {
      if (!byPeriod.has(e.periodId)) byPeriod.set(e.periodId, [])
      byPeriod.get(e.periodId).push(e)
    })
    const carried = [], failures = []
    for (const [periodId, list] of byPeriod) {
      const period = periodList.find(p => p.id === periodId)
      const next = period ? nextExistingPeriod(periodList, period) : null
      if (!next) continue
      const { error } = await supabase.from('opening_stock').upsert(
        list.map(e => ({ period_id: next.id, item_id: e.itemId, qty: e.qty })), { onConflict: 'period_id,item_id' })
      if (error) failures.push({ next, error })
      else carried.push({ periodId, next, count: list.length })
    }
    return { carried, failures }
  }

  // Closing counts corrected on this page in a CLOSED month (S792, STOCK-5), not yet carried on.
  // The month-end carry-forward ran at close, so the Owner fixing Bhadra's count — the sanctioned
  // D1 path, and where the counter's "give these to the account owner" figures end up — changed
  // Bhadra's COGS and left Ashwin opening on the old figure, and nothing on the page said so.
  // { [periodId]: { [itemId]: qty|null } } — the latest figure per item; a blank carries nothing.
  // Kept PER MONTH (S792 stage 2 review, P4): it was one month's list, so correcting Shrawan after
  // Bhadra replaced Bhadra's un-carried corrections, and Ashwin went on opening on the old counts
  // with nothing left on the page to say so. The prompt shows the month on screen.
  const [closedCarry, setClosedCarry] = useState({})
  const [closedCarryBusy, setClosedCarryBusy] = useState(false)
  function noteClosedCorrection(periodId, fieldKey, entries) {
    if (fieldKey !== 'closing') return
    const period = periods.find(p => p.id === periodId)
    if (period?.status !== 'closed' || !nextExistingPeriod(periods, period)) return
    setClosedCarry(prev => {
      const counts = { ...(prev[periodId] || {}) }
      entries.forEach(e => { counts[e.itemId] = e.qty })
      return { ...prev, [periodId]: counts }
    })
  }
  async function carryClosedCorrections() {
    const periodId = selectedPeriod?.id
    const counts = periodId ? closedCarry[periodId] : null
    if (!counts) return
    const period = periods.find(p => p.id === periodId)
    const next = period ? nextExistingPeriod(periods, period) : null
    setClosedCarryBusy(true)
    setSaveError(null)
    setPageNotice(null)
    const { carried, failures } = await carryClosingIntoNext(
      Object.entries(counts).map(([itemId, qty]) => ({ periodId, itemId, qty })), periods)
    setClosedCarryBusy(false)
    if (failures.length) {
      // An upsert of the same rows: pressing it again converges whether or not this one landed.
      const { text, detail } = asActionError(failures[0].error)
      setSaveError({ text: `${monthOf(next)}'s opening stock was not updated from the corrected counts, so it may still open on the old figures. Press the button again, or use Resync Opening Stock on the Periods page. ${text}`, detail })
      return
    }
    // Only this month's entry, and only the figures that were carried: a count corrected again
    // while the carry was running is still waiting for its own.
    setClosedCarry(prev => {
      const left = { ...(prev[periodId] || {}) }
      Object.entries(counts).forEach(([itemId, qty]) => { if (left[itemId] === qty) delete left[itemId] })
      const { [periodId]: _done, ...others } = prev
      return Object.keys(left).length ? { ...others, [periodId]: left } : others
    })
    const n = carried.reduce((s, c) => s + c.count, 0)
    setPageNotice(`${n} corrected closing count${n === 1 ? ' was' : 's were'} carried into ${monthOf(next)}'s opening stock. Regenerate Snapshot on ${monthOf(period)}'s Monthly Report${next?.status === 'closed' ? ` and on ${monthOf(next)}'s` : ''} to bring the frozen report up to date.`)
  }

  // The Owner's other answer: these figures should not be added at all. They leave the device.
  async function discardHeld() {
    if (!heldClosed) return
    for (const op of heldClosed.ops) { try { await dequeue(op.id) } catch (_) { /* next replay holds it again */ } }
    setPendingSync(prev => Math.max(0, prev - heldClosed.ops.length))
    setHeldClosed(null)
    setHeldError(null)
  }

  flushRef.current = flushQueue

  // `overrideQty` exists for QtyInput's commit path: it hands us the evaluated number in the
  // same tick it calls updateField, so `stockData` read here would still hold the pre-commit
  // value. Save All passes nothing and reads state, which is correct for it.
  async function saveRow(itemId, overrideQty) {
    const fieldKey = fieldKeyOf(activeTab)
    if (!fieldKey) return   // not an entry tab; nothing on screen writes a stored field
    const source = overrideQty !== undefined ? overrideQty : (stockData[itemId] || {})[fieldKey]
    // QtyInput commits on EVERY blur, so tabbing through a cell nobody typed in used to write it —
    // and a blank cell is a delete, which erased another tablet's count for that item (S756). Only
    // a cell that differs from what the server holds is written, and never before this period's
    // figures have loaded (the record still describes the previous period until then).
    // (A write still in flight for this cell means the record is about to move, so the comparison
    // cannot be trusted — typing a figure back to its old value mid-save must still be written.)
    if (storedRef.current.periodId !== selectedPeriod?.id) return
    if (!isChanged(itemId, fieldKey, source) && !inflight.current[`${itemId}:${fieldKey}`]) return
    setSaving(prev => ({ ...prev, [itemId]: true }))
    await persistValue(itemId, fieldKey, toQty(source))
    setSaving(prev => ({ ...prev, [itemId]: false }))
  }

  async function saveAll() {
    const fieldKey = fieldKeyOf(activeTab)
    if (!fieldKey) return
    setPageNotice(null)
    // Not before this period's figures have loaded: until then the record of what the server
    // holds still describes the previous period, and every comparison against it is meaningless.
    if (storedRef.current.periodId !== selectedPeriod?.id) {
      setPageNotice('This month’s figures are still loading. Wait for them to appear, then press Save All.')
      return
    }
    // Only the cells changed since the figures were loaded or last saved (S756) — see storedRef.
    const visibleItems = filteredItems().filter(item =>
      isChanged(item.id, fieldKey, (stockData[item.id] || {})[fieldKey]) || inflight.current[`${item.id}:${fieldKey}`])
    if (visibleItems.length === 0) {
      setPageNotice('Nothing has changed since these figures were loaded or last saved, so there was nothing to save.')
      return
    }

    // Same "used" calculation already driving the red highlight in the Summary tab — if it's
    // negative, more was used/wasted/counted-out than was ever bought or on hand, which is a real
    // data problem, not just a display quirk. Gated behind a client-level setting (off by default).
    // Tested over the rows this save WRITES: a figure already stored is not being recorded by it.
    if (settings.block_negative_stock) {
      const negativeItems = visibleItems.filter(item => {
        const row = stockData[item.id] || {}
        // Same "has activity" test the Summary row uses — wastage/staff meals included, since an
        // item carrying only waste is exactly the shape that goes negative.
        const wast = (parseFloat(row.wastage) || 0) + (parseFloat(dailyWastage[item.id]) || 0)
        const hasData = row.opening !== '' || row.closing !== '' || purchases[item.id]
          || wast > 0 || (parseFloat(row.staff_meal) || 0) > 0
        return hasData && getUsed(item.id) < 0
      })
      if (negativeItems.length > 0) {
        const names = negativeItems.map(i => i.name).join(', ')
        if (isAdmin) {
          setPendingConfirm({
            title: 'Negative usage detected',
            confirmLabel: 'Save Anyway',
            danger: true,
            body: `${negativeItems.length} item(s) show negative usage — more used than was ever bought or on hand: ${names}. Saving records these figures as the period's counts.`,
            run: () => performSaveAll(visibleItems),
          })
          return
        }
        setPendingConfirm({
          title: 'Cannot save — negative usage',
          confirmLabel: 'OK',
          body: `${negativeItems.length} item(s) show negative usage — more used than was ever bought or on hand: ${names}. Fix those counts before saving.`,
          run: () => {},
        })
        return
      }
    }

    await performSaveAll(visibleItems)
  }

  // Bulk counterpart of persistValue for Save All / Clear All. The old shape was one saveRow per
  // visible item — one round trip each (two on the delete-then-insert tabs), fully serial through
  // the per-key locks — so a real 300-item count paid 300–600 sequential round trips per click,
  // i.e. minutes, on the page a month is closed from. This writes the same rows in at most two
  // requests. It keeps the persistLocks guarantee: it starts only after every pending single-cell
  // save for these keys has settled, and registers itself as each key's tail so a later onBlur
  // autosave chains after it — no delete/insert pair can interleave with it.
  async function persistValuesBulk(fieldKey, entries) {
    if (entries.length === 0) return true
    if (!navigator.onLine) {
      // Offline writes go to the local queue — per-item is fine there, no network involved.
      let allOk = true
      for (const e of entries) allOk = (await persistValue(e.itemId, fieldKey, e.qty)) && allOk
      return allOk
    }
    const periodId = selectedPeriod.id
    const priors = entries.map(e => persistLocks.current[`${e.itemId}:${fieldKey}`] || Promise.resolve())
    // Counted closing figures the server saved, and those it kept back for the counter (D37).
    let savedClosing = []
    let closingConflicts = []
    const run = Promise.all(priors).then(async () => {
      const allIds = entries.map(e => e.itemId)
      // "zeros" is the delete set: blank cells, plus 0 on every field but closing (isNoRow).
      const zeros = entries.filter(e => isNoRow(fieldKey, e.qty)).map(e => e.itemId)
      const positives = entries.filter(e => !isNoRow(fieldKey, e.qty))
      if (fieldKey === 'opening') {
        // Chunked: `zeros`/`allIds` here are "every visible item", which on a real client is the
        // whole item book. PostgREST spells an .in() list out in the REQUEST URL, so 400 uuids is
        // ~15 kB of URL and a 414 from the proxy long before the row cap matters (S629). The
        // upserts/inserts are POST bodies and need no such treatment. Each delete runs BEFORE the
        // write that replaces those rows, so a chunk failing part-way throws here and the insert
        // never runs — nothing is destroyed without its replacement.
        if (zeros.length) fail((await runChunkedByIds(zeros, ids => supabase.from('opening_stock').delete().eq('period_id', periodId).in('item_id', ids))).error)
        if (positives.length) fail((await supabase.from('opening_stock').upsert(
          positives.map(e => ({ period_id: periodId, item_id: e.itemId, qty: e.qty })), { onConflict: 'period_id,item_id' })).error)
      } else if (fieldKey === 'closing') {
        if (zeros.length) fail((await runChunkedByIds(zeros, ids => supabase.from('closing_stock').delete().eq('period_id', periodId).in('item_id', ids))).error)
        if (positives.length) {
          const res = await saveClosingCounts(periodId, positives, countedByFields())
          savedClosing = res.saved
          closingConflicts = res.conflicts
        }
      } else if (fieldKey === 'wastage') {
        // Same shape as persistValueDirect: only the undated catch-all rows are this tab's to replace.
        fail((await runChunkedByIds(allIds, ids => supabase.from('wastages').delete().eq('period_id', periodId).in('item_id', ids).is('bs_day', null))).error)
        if (positives.length) fail((await supabase.from('wastages').insert(
          positives.map(e => ({ period_id: periodId, item_id: e.itemId, qty: e.qty, bs_day: null })))).error, true)
      } else if (fieldKey === 'staff_meal') {
        fail((await runChunkedByIds(allIds, ids => supabase.from('staff_meals').delete().eq('period_id', periodId).in('item_id', ids).eq('type', 'staff'))).error)
        if (positives.length) fail((await supabase.from('staff_meals').insert(
          positives.map(e => ({ period_id: periodId, item_id: e.itemId, qty: e.qty, type: 'staff' })))).error, true)
      }
      return true
    }).then(ok => {
      const keptBack = new Set(closingConflicts.map(c => c.item_id))
      const landed = entries.filter(e => !keptBack.has(e.itemId))
      if (fieldKey === 'closing') {
        markStored(periodId, fieldKey, landed.filter(e => isNoRow(fieldKey, e.qty)), countedByFields())
        applySavedClosing(periodId, savedClosing)
      } else {
        markStored(periodId, fieldKey, entries, countedByFields())
      }
      noteDirectWrite(periodId, fieldKey, landed)
      noteClosedCorrection(periodId, fieldKey, landed)
      if (closingConflicts.length) {
        openCountConflicts(periodId, closingConflicts, entries)
        return 'conflict'
      }
      return ok
    }).catch(async err => {
      // Worth most here: this is the click at the end of a 300-item count.
      if (await queueOnNetworkFailure(err, fieldKey, entries)) return 'queued'
      noteSaveFailure(null, fieldKey, err, entries.length)
      return false
    }) // recorded; never wedges the chains
    entries.forEach(e => { persistLocks.current[`${e.itemId}:${fieldKey}`] = run })
    trackInflight(entries.map(e => `${e.itemId}:${fieldKey}`), run)
    return run
  }

  function flashSaved() {
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  async function performSaveAll(visibleItems) {
    const fieldKey = fieldKeyOf(activeTab)
    if (!fieldKey) return   // void, like every other exit from this function
    setSaveAllLoading(true)
    setSaveError(null)
    // Same source saveRow reads for Save All: current on-screen state, no override.
    const entries = visibleItems.map(item => ({
      itemId: item.id,
      qty: toQty((stockData[item.id] || {})[fieldKey]),
    }))
    const ok = await persistValuesBulk(fieldKey, entries)
    setSaveAllLoading(false)
    // "✓ Saved" only when it did save. The bulk writer's catch records the failure and resolves,
    // so this used to flash success directly above an ActionError saying the opposite. `'queued'`
    // is the third answer (S731): the connection dropped and the figures are held on this device,
    // which the page notice explains — flashing "✓ Saved" over that sentence is the same
    // contradiction one state along.
    if (ok && ok !== 'queued' && ok !== 'conflict') flashSaved()
  }

  // ── Daily wastage (dated, reason-tagged) ───────────────────────────────────
  async function addDailyWastage() {
    if (!selectedPeriod || !wEntry.item_id) return
    const qty = parseFloat(wEntry.qty) || 0
    if (qty <= 0) return
    setWBusy(true); setSaveError(null)
    const { error } = await supabase.from('wastages').insert({
      period_id: selectedPeriod.id, item_id: wEntry.item_id, qty,
      bs_day: wDay, reason: wEntry.reason || DEFAULT_WASTAGE_REASON,
    })
    if (error) {
      // Keep the form as typed so the entry can be retried without re-picking the item.
      const { text, detail } = asActionError(error)
      setSaveError({ text: `This wastage entry was not added. ${text}`, detail })
      setWBusy(false)
      return
    }
    setWEntry({ item_id: '', qty: '', reason: wEntry.reason })
    await loadStockData(selectedPeriod.id, items)
    setWBusy(false)
  }

  async function deleteDailyWastage(id) {
    if (!selectedPeriod) return
    setWBusy(true); setSaveError(null)
    const { error } = await supabase.from('wastages').delete().eq('id', id)
    if (error) {
      const { text, detail } = asActionError(error)
      setSaveError({ text: `This wastage entry is still recorded — it was not deleted. ${text}`, detail })
    }
    await loadStockData(selectedPeriod.id, items)
    setWBusy(false)
  }

  function clearAll() {
    const fieldKey = fieldKeyOf(activeTab)
    if (!fieldKey) return
    const label = TABS.find(t => t.id === activeTab)?.label || 'these'
    const visibleItems = filteredItems()
    setPendingConfirm({
      title: `Clear ${label} values`,
      confirmLabel: 'Clear All',
      danger: true,
      body: `Every entered ${label} value for the ${visibleItems.length} item(s) currently shown is cleared and saved as blank${fieldKey === 'closing' ? ' — not counted, which is different from a count of 0' : ''}. This cannot be undone.`,
      run: () => performClearAll(fieldKey, visibleItems),
    })
  }

  async function performClearAll(fieldKey, visibleItems) {
    setSaveAllLoading(true)
    setSaveError(null)
    // Blank, not 0: on the Closing tab a 0 is a real count and would be saved as one.
    const ok = await persistValuesBulk(fieldKey, visibleItems.map(item => ({ itemId: item.id, qty: null })))
    if (ok) {
      // The screen follows the server, not the click — a refused clear leaves the figures the
      // server still holds on screen, beside the ActionError that says so. A QUEUED clear does
      // clear the screen: the queue is now the record of what those cells hold.
      setStockData(prev => {
        const next = { ...prev }
        visibleItems.forEach(item => { next[item.id] = { ...next[item.id], [fieldKey]: '' } })
        return next
      })
      if (ok !== 'queued') flashSaved()
    }
    setSaveAllLoading(false)
  }

  // Re-runnable version of Periods.js's close-time carry-forward: copies the chronologically
  // previous period's counted closing_stock into THIS period's opening_stock. Unlike the one-shot
  // snapshot at close time, this can be run whenever — after a late/edited closing count, or to
  // repair a period that was closed before the carry-forward feature existed (pre-2026-07-17).
  async function pullFromLastMonthClosing() {
    if (!selectedPeriod || isLocked) return
    setPageNotice(null); setSaveError(null)
    if (!navigator.onLine) { setPageNotice('You’re offline. Last month’s closing counts are on the server, so this needs a connection. The counts you have entered on this page are saved on this device and will sync when you’re back online.'); return }
    // The chronologically previous period that EXISTS — the one definition of "last month" the
    // period close, "+ Create Period" and Periods' Resync all share since S738 (closePeriod.js).
    const prevPeriod = previousExistingPeriod(periods, selectedPeriod)
    if (!prevPeriod) { setPageNotice('This is the earliest period on record, so there is no previous month to carry a closing count forward from. Enter the opening stock directly.'); return }
    const prevLabel = `${BS_MONTHS[prevPeriod.bs_month - 1]} ${prevPeriod.bs_year}`
    setSaveAllLoading(true)
    // Paged, exactly as carryForwardOpeningStock() pages the same read (S705, here S756): one row
    // per item, so a bare select stopped at 1000 and the rest of the book opened on whatever was
    // typed. item_id is unique per period, so it is the tiebreaker.
    const { data: closingRows, error: readErr } = await fetchAllRows(() => supabase.from('closing_stock')
      .select('item_id, physical_qty').eq('period_id', prevPeriod.id).order('item_id'))
    setSaveAllLoading(false)
    if (readErr) {
      // A failed read is not "never counted" — that sentence sent a reader off to recount a
      // month that was already counted.
      const { text, detail } = asActionError(readErr)
      setSaveError({ text: `${prevLabel}'s closing count could not be read, so nothing was carried forward. ${text}`, detail })
      return
    }
    // Same rows the period close carries forward (closePeriod.js): every counted item, a count
    // of 0 included — a 0 last month means this month opens on 0, not on whatever was typed.
    const counted = (closingRows || []).filter(r => r.physical_qty != null)
    if (counted.length === 0) {
      setPageNotice(`${prevLabel} was never closing-counted, so there is nothing to carry forward. Count the closing stock for ${prevLabel} first, or enter this month’s opening figures directly.`)
      return
    }
    setPendingConfirm({
      title: 'Pull last month’s closing stock',
      confirmLabel: 'Overwrite Opening Stock',
      danger: true,
      body: `${counted.length} item closing count(s) from ${prevLabel} copy into ${periodLabel}'s Opening Stock. Existing opening entries for those items are overwritten.`,
      run: () => performPullFromLastMonth(counted),
    })
  }

  async function performPullFromLastMonth(counted) {
    setSaveAllLoading(true)
    setSaveError(null)
    const positives = counted.filter(r => parseFloat(r.physical_qty) > 0)
    const zeros = counted.filter(r => !(parseFloat(r.physical_qty) > 0)).map(r => r.item_id)
    const rows = positives.map(r => ({ period_id: selectedPeriod.id, item_id: r.item_id, qty: r.physical_qty }))
    // Checked, and the screen follows the server: this used to await the upsert bare, then paint
    // the copied figures and flash "✓ Saved" whether or not the write had landed.
    const upsertRes = rows.length ? await supabase.from('opening_stock').upsert(rows, { onConflict: 'period_id,item_id' }) : { error: null }
    const delRes = !upsertRes.error && zeros.length
      ? await runChunkedByIds(zeros, ids => supabase.from('opening_stock').delete().eq('period_id', selectedPeriod.id).in('item_id', ids))
      : { error: null }
    setSaveAllLoading(false)
    const err = upsertRes.error || delRes.error
    if (err) {
      const { text, detail } = asActionError(err)
      setSaveError({ text: `Last month's closing counts were not carried into Opening Stock — what is on screen is what the server held before. Reload to check, then try again. ${text}`, detail })
      return
    }
    setStockData(prev => {
      const next = { ...prev }
      positives.forEach(r => { next[r.item_id] = { ...next[r.item_id], opening: r.physical_qty } })
      zeros.forEach(id => { next[id] = { ...next[id], opening: '' } })
      return next
    })
    markStored(selectedPeriod.id, 'opening', [
      ...positives.map(r => ({ itemId: r.item_id, qty: toQty(r.physical_qty) })),
      ...zeros.map(id => ({ itemId: id, qty: null })),
    ])
    flashSaved()
  }

  // Memoized once per items/filter change — this used to be a fresh filter pass (with
  // search.toLowerCase() inside the loop) on every render, called from the tables, the progress
  // bar AND countedItems, i.e. several times per keystroke. filteredItems() keeps its function
  // shape because Save All / Clear All read it at click time — they must see exactly the list the
  // table renders.
  const visible = useMemo(() => {
    const q = search.toLowerCase()
    return items.filter(item => {
      const matchCat = filterCat === 'all' || item.category_id === filterCat
      return matchCat && item.name.toLowerCase().includes(q)
    })
  }, [items, filterCat, search])
  function filteredItems() { return visible }

  // On the Closing tab an entered 0 is a count and shows in the progress figure; elsewhere a 0 is
  // the same as blank.
  function countedItems(fk) {
    return filteredItems().filter(item => !isNoRow(fk, toQty(stockData[item.id]?.[fk]))).length
  }

  // Quantity used, through the shared formula rather than a retyped copy of it (S756 — the S551
  // rule: COGS_FORMULA where it is printed, computeUsed() where it is computed).
  function getUsed(itemId) {
    const row = stockData[itemId] || {}
    return computeUsed({
      opening:    parseFloat(row.opening) || 0,
      purchases:  parseFloat(purchases[itemId]) || 0,
      returns:    parseFloat(returns[itemId]) || 0,
      wastage:    (parseFloat(row.wastage) || 0) + (parseFloat(dailyWastage[itemId]) || 0),
      staffMeals: parseFloat(row.staff_meal) || 0,
      closing:    parseFloat(row.closing) || 0,
    })
  }

  // What this period's purchases and returns of an item cost, in NPR (S756): the bills' own rates
  // net of their discounts, and returns at their own rate — not qty × today's master rate. Falls
  // back to the master rate only when the values are not known (an older offline cache).
  function purchaseValueOf(item) {
    if (purchaseValues) return purchaseValues[item.id] || 0
    return (parseFloat(purchases[item.id]) || 0) * parseFloat(item.per_uom_rate || 0)
  }
  function returnValueOf(item) {
    if (returnValues) return returnValues[item.id] || 0
    return (parseFloat(returns[item.id]) || 0) * parseFloat(item.per_uom_rate || 0)
  }
  // COGS in NPR, one item: stock on hand at the master rate, purchases and returns at what they
  // cost. Both Summary tables and the export read this, so they cannot value one item two ways.
  function getCogsValue(item) {
    const row = stockData[item.id] || {}
    const rate = parseFloat(item.per_uom_rate || 0)
    return computeUsed({
      opening:    (parseFloat(row.opening) || 0) * rate,
      purchases:  purchaseValueOf(item),
      returns:    returnValueOf(item),
      wastage:    ((parseFloat(row.wastage) || 0) + (parseFloat(dailyWastage[item.id]) || 0)) * rate,
      staffMeals: (parseFloat(row.staff_meal) || 0) * rate,
      closing:    (parseFloat(row.closing) || 0) * rate,
    })
  }

  // PATCHED: subtract returns from system ref qty
  function getSystemRefQty(itemId) {
    const row = stockData[itemId] || {}
    const opening = parseFloat(row.opening) || 0
    const purchased = parseFloat(purchases[itemId]) || 0
    const returned = parseFloat(returns[itemId]) || 0
    return opening + purchased - returned
  }

  function getStockValue(itemId, item) {
    return getSystemRefQty(itemId) * parseFloat(item.per_uom_rate || 0)
  }

  // Memoized: sorts every item's stock value, and the Print Sheet tab (its only consumer) has a
  // search box — search isn't a dependency here, so typing in it no longer re-runs this.
  const highValueFlags = useMemo(() => {
    const values = items.map(i => getStockValue(i.id, i)).filter(v => v > 0)
    if (values.length === 0) return new Set()
    const sorted = [...values].sort((a, b) => b - a)
    const cutoffIdx = Math.max(0, Math.ceil(sorted.length * 0.25) - 1)
    const valueThreshold = sorted[cutoffIdx] || 0
    const freqThreshold = 3
    const flagged = new Set()
    items.forEach(item => {
      const value = getStockValue(item.id, item)
      const freq = purchFreq[item.id] || 0
      if (value >= valueThreshold && value > 0 && freq >= freqThreshold) flagged.add(item.id)
    })
    return flagged
  }, [items, stockData, purchases, returns, purchFreq]) // eslint-disable-line react-hooks/exhaustive-deps

  // Key used for items whose `category_id` is NULL (Items.js writes null when the field is left
  // blank) or points at a category this client no longer has. Both used to fall out of the rollup
  // entirely — it loops over `categories`, so nothing claimed them — while the item-level table
  // below it iterates `items` and counted them. The Totals row a month is closed on was therefore
  // understated by exactly those items, silently, with no row to hint at the gap.
  const UNCATEGORISED = 'Uncategorised'

  function getSummary() {
    const byCategory = {}
    const knownCatIds = new Set(categories.map(c => c.id))
    // summaryItems, not items (S792, D29): a hidden item with a row this month stays in its category.
    const groups = [
      ...categories.map(c => ({ name: c.name, catItems: summaryItems.filter(i => i.category_id === c.id) })),
      { name: UNCATEGORISED, catItems: summaryItems.filter(i => !i.category_id || !knownCatIds.has(i.category_id)) },
    ]
    groups.forEach(({ name, catItems }) => {
      const openingVal   = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.opening) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const closingVal   = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.closing) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const purchasesVal = catItems.reduce((sum, i) => sum + purchaseValueOf(i), 0)
      // COGS below already nets returns off — without this column the row simply did not add up
      // and an accountant could not reproduce the total.
      const returnsVal   = catItems.reduce((sum, i) => sum + returnValueOf(i), 0)
      const wastageVal    = catItems.reduce((sum, i) => sum + ((parseFloat(stockData[i.id]?.wastage) || 0) + (parseFloat(dailyWastage[i.id]) || 0)) * parseFloat(i.per_uom_rate || 0), 0)
      const staffMealsVal = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.staff_meal) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const cogsVal       = catItems.reduce((sum, i) => sum + getCogsValue(i), 0)
      byCategory[name] = { opening: openingVal, closing: closingVal, purchases: purchasesVal, returns: returnsVal, wastage: wastageVal, staffMeals: staffMealsVal, cogs: cogsVal }
    })
    return byCategory
  }

  // Items with stock this period and no closing count (S756 D6). Read off on-screen state, which is
  // what the Summary's figures are built from, so the warning and the COGS beside it cannot describe
  // two different counts: `toQty(closing) != null` is the same blank-vs-0 line every save path draws
  // (a 0 is a count, a blank is not). Active, non-sub-recipe items only, per the owner's rule —
  // this page counts prep too, but a missing prep count is not what the summaries are warning about.
  // Built over the Summary's items (S792, D29), so the COGS the gap is measured against is the COGS
  // the Totals show; findUncountedItems itself passes over a hidden item — it cannot be counted.
  function getUncountedGap() {
    const openingQty = {}
    const countedIds = new Set()
    let cogs = 0
    summaryItems.forEach(item => {
      const row = stockData[item.id] || {}
      openingQty[item.id] = parseFloat(row.opening) || 0
      if (toQty(row.closing) != null) countedIds.add(item.id)
      cogs += getCogsValue(item)
    })
    const purchaseValue = {}
    summaryItems.forEach(item => { purchaseValue[item.id] = purchaseValueOf(item) })
    return findUncountedItems({ items: summaryItems, openingQty, purchaseQty: purchases, purchaseValue, countedIds, cogs })
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const gap = getUncountedGap()
    const uncountedIds = new Set(gap.uncounted.map(u => u.id))
    // The Summary's items (S792, D29), so the sheet totals to the Totals row on screen.
    const rows = summaryItems.map(item => {
      const row      = stockData[item.id] || {}
      const rate     = parseFloat(item.per_uom_rate || 0)
      const openQty  = parseFloat(row.opening  || 0)
      const purchQty = parseFloat(purchases[item.id] || 0)
      const retQty   = parseFloat(returns[item.id]   || 0)
      const wastQty  = parseFloat(row.wastage || 0) + (parseFloat(dailyWastage[item.id]) || 0)
      const staffQty = parseFloat(row.staff_meal || 0)
      const closeQty = parseFloat(row.closing    || 0)
      const usedQty  = getUsed(item.id)
      return {
        'Item':              item.name,
        'Category':          item.categories?.name || '',
        'UOM':               item.uom,
        'Opening Qty':       openQty   || '',
        'Opening Value':     rate > 0 ? Math.round(openQty  * rate) : '',
        'Purchased Qty':     purchQty  || '',
        // What the bills charged, net of their discounts, and returns at their own rate (S756) —
        // not qty × master rate, so this sheet ties to Monthly Summary rather than to today's price.
        'Purchase Value':    purchQty ? Math.round(purchaseValueOf(item)) : '',
        'Returned Qty':      retQty    || '',
        'Returns Value':     retQty ? Math.round(returnValueOf(item)) : '',
        'Wastage Qty':       wastQty   || '',
        'Wastage Value':     rate > 0 ? Math.round(wastQty  * rate) : '',
        'Staff Meals Qty':   staffQty  || '',
        'Staff Meals Value': rate > 0 ? Math.round(staffQty * rate) : '',
        'Closing Qty':       closeQty  || '',
        'Closing Value':     rate > 0 ? Math.round(closeQty * rate) : '',
        // Who last counted it — written since S737, carried out of the building since S756.
        'Counted By':        row.closing !== '' && row.closing != null ? (countedBy[item.id] || '') : '',
        // Marked as on screen (S756 D6): this item's COGS counts its whole stock as used.
        'Closing counted':   uncountedIds.has(item.id) ? 'NOT COUNTED' : '',
        // Marked as on screen (S792, D29): hidden in Item Master, kept because it had a row this month.
        'Hidden':            item.is_active === false ? 'HIDDEN' : '',
        'Used Qty':          usedQty   || '',
        'COGS (NPR)':        Math.round(getCogsValue(item)) || '',
        'Requisitioned Qty': requisitioned[item.id] || '',
      }
    })
    // The warning travels with the sheet (S756 D6), under the same letterhead every other report
    // export carries (owner decision, S756 stage 4).
    const note = gapNote(gap, periodLabel)
    const hiddenCount = summaryItems.filter(i => i.is_active === false).length
    const hiddenNote = hiddenCount
      ? `${hiddenCount} item${hiddenCount === 1 ? ' is' : 's are'} hidden in Item Master and still included, because ${hiddenCount === 1 ? 'it' : 'they'} had stock or movement in ${periodLabel} — hiding an item never changes a past month.`
      : null
    const ws = sheetWithLetterhead(XLSX, {
      title: 'Stock Register',
      biz,
      scopeLine: `Period : ${periodLabel}${selectedPeriod?.status === 'open' ? ' (PROVISIONAL — period still open, figures can change)' : ' (period closed)'}`,
      rows,
      notes: [note, hiddenNote].filter(Boolean),
    })
    XLSX.utils.book_append_sheet(wb, ws, 'Stock Register')
    XLSX.writeFile(wb, `Stock-Register-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  // Admin and the Owner edit a closed month in place (S756); everyone else is read-only.
  const isLocked = !canEditClosedPeriods && selectedPeriod?.status === 'closed'

  // Blind count (S737): a counter writes what is on the shelf rather than confirming what the
  // system expected, so the reference quantities come off the screen for a staff-rank account.
  //
  // Widened in S761 from `activeTab === 'closing'` to every screen that carries the same figures.
  // Hiding Purchased/Returned on the Closing tab while Print Sheet printed System Ref Qty and
  // Summary printed the whole register meant the control could be walked around in two taps — a
  // counting-discipline rule nobody had to keep. Opening, wastage and staff meals are still not
  // the count being blinded, so `blindCount` (the entry grid's columns) stays scoped to Closing;
  // `blindOn` is the account-level fact the other two tabs ask.
  //
  // This is a DISPLAY rule and the settings tab says so where it is switched on: the figures still
  // reach the browser. Making it a real boundary would mean a second read path for scoped
  // accounts, which is not worth it for a control whose purpose is counting discipline.
  const blindOn = isCounter && !!settings?.ims_count_blind
  const blindCount = blindOn && activeTab === 'closing'

  // Money on a counter's screen (S761, owner decision). Counting an item needs its name, its unit
  // and a box to type into; what the shelf is worth is the owner's business, and on a phone the
  // NPR column is competing for width with the thing being counted. Separate from `blindCount`
  // because they hide different facts — that one hides reference QUANTITIES and only while blind
  // counting is switched on; this hides VALUE, always, for anyone counting.
  const hideValues = isCounter

  // Floor tier, matching every other IMS page's guard (S417 convention). This page had none, so
  // the route was reachable by any account at an ims_enabled client regardless of ims_role.
  if (!hasImsAccess('staff')) return <Navigate to="/dashboard" replace />
  // Not on a failed read (S747): a first load that fails leaves `periods` empty too, and this used to
  // tell the counter there were no periods instead of showing the error card below.
  if (!loading && !loadError && periods.length === 0) return <NoPeriodState what="stock count" />

  return (
    <div>
      <div className="page-header page-header--split no-print">
        <div>
          <h1 className="page-title">Stock Count</h1>
          {/* A count account has only the closing tab, so the full subtitle named two screens it
              cannot reach — the first thing it would look for and not find. */}
          <p className="page-subtitle">{imsCountOnly ? 'Physical closing count for the month' : 'Opening stock, physical closing count & wastage'}</p>
          <div className="page-scope-row">
            <PeriodScope label={periodLabel} status={selectedPeriod?.status} />
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
        </div>
      </div>
      <ActionError error={saveError} className="no-print" />
      {pageNotice && (
        <div className="no-print" role="status" style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 12, fontSize: 13, color: 'var(--theme-text1)' }}>
          <span style={{ flex: 1 }}>{pageNotice}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPageNotice(null)} aria-label="Dismiss">Dismiss</button>
        </div>
      )}

      {loadError && <ReportLoadError error={loadError} />}

      {/* Section scope (S737). Says WHY the list is short, because a counter given three of nine
          categories otherwise reads a two-thirds-empty item book as items missing from the system.
          The no-assignment case is fail-closed and is stated as such — it is the state a manager
          leaves behind by switching scoping on before filling the grid in, and without this the
          page is a blank list under a working Save button. */}
      {scopeOn && !loadError && (
        <div className="no-print" role="status" style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-text1)' }}>
          {items.length === 0
            ? 'No sections have been assigned to you yet, so there is nothing here for you to count. Ask your manager to assign your sections in Stock Count → Settings.'
            : `You are counting ${categories.length} of your outlet's sections${blindCount ? ', without the expected quantities' : ''}. Anything outside them is another counter's and is not shown.`}
        </div>
      )}

      {isLocked && (
        <ClosedPeriodBanner />
      )}
      {/* The Owner and admin may correct a closed month here (S756), and before S792 were told
          nothing: the red banner is suppressed with the lock, and a corrected closing count never
          reached the next month's opening stock (STOCK-5). Amber, because the edit will succeed. */}
      {canEditClosedPeriods && selectedPeriod?.status === 'closed' && (() => {
        const next = nextExistingPeriod(periods, selectedPeriod)
        const pending = Object.values(closedCarry[selectedPeriod.id] || {}).filter(q => q != null).length
        return (
          <>
            <ClosedPeriodBanner canEdit periodLabel={periodLabel} style={{ marginBottom: pending ? 8 : 20 }}
              note={next ? `A corrected closing count does not reach ${monthOf(next)}'s opening stock on its own: once you save one, carry it across with the button that appears here.` : undefined} />
            {pending > 0 && next && (
              <div className="no-print" role="status" style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-text2)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ flex: 1, minWidth: 220 }}>
                  <strong style={{ color: 'var(--theme-amber-text)' }}>{pending} corrected closing count{pending === 1 ? ' is' : 's are'} not in {monthOf(next)}&rsquo;s opening stock yet.</strong>{' '}
                  {monthOf(next)} opened on the count {periodLabel} had when it closed.
                </span>
                <button type="button" className="btn btn-primary btn-sm" disabled={closedCarryBusy} aria-busy={closedCarryBusy || undefined} onClick={carryClosedCorrections}>
                  {closedCarryBusy ? 'Carrying…' : `Carry into ${monthOf(next)}’s opening stock`}
                </button>
              </div>
            )}
          </>
        )
      })()}

      {!isOnline && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>📵</span>
            <span><strong>Offline</strong> — entries are saved locally and will sync when you reconnect.</span>
            {pendingSync > 0 && <span style={{ marginLeft: 'auto', background: 'color-mix(in srgb, var(--theme-amber) 15%, transparent)', borderRadius: 'var(--radius-lg)', padding: '2px 10px', fontWeight: 600 }}>{pendingSync} pending</span>}
          </div>
          {/* S673: a broken app needs a phone number, not just a network. */}
          <SupportContactLine variant="inline" />
        </div>
      )}
      {syncing && (
        <div style={{ background: 'color-mix(in srgb, var(--theme-green) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-green-text)' }}>
          ⟳ Syncing {pendingSync} {pendingSync === 1 ? 'entry' : 'entries'}…
        </div>
      )}
      {/* Entries held on this device while the browser believes it is online. Two ways to get
          here: `navigator.onLine` reports only a network interface, so a wifi with no upstream
          never fires the offline event; and a connection can die between pressing Save and the
          request landing. Either way the amber banner above never renders, and before S731 the
          "N pending" badge lived inside it — so held counts were invisible from every screen and
          nothing would send them until the next page load. Sync Now is the action. */}
      {/* S792 (STOCK-3): this used to hide whenever a sync had FAILED — the one moment its button
          is the action — while the failure message below said "Press Sync Now". Figures held for
          the Owner's decision (below) are not counted here: Sync Now will not send them. */}
      {isOnline && !syncing && pendingSync - (heldClosed?.ops.length || 0) > 0 && (() => {
        const waiting = pendingSync - (heldClosed?.ops.length || 0)
        return (
          <div style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 25%, transparent)', borderRadius: 'var(--radius-sm)', padding: '10px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-amber-text)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span>⏳ <strong>{waiting} {waiting === 1 ? 'entry' : 'entries'}</strong> counted on this device {waiting === 1 ? 'has' : 'have'} not reached the server yet.</span>
            <button type="button" className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => flushQueue()}>Sync Now</button>
          </div>
        )
      })()}
      {/* A sync that could not finish. This renders while ONLINE — which is the whole point: an
          entry the server permanently refuses was retried on every load and never mentioned. */}
      {syncFailed && !syncing && <ActionError error={syncFailed} />}
      {/* S792 (D38): figures counted offline for a month that has closed since, held for the Owner
          or admin. Nothing is added to a closed month without this choice being made. */}
      {heldClosed && !syncing && (() => {
        const months = [...new Set(heldClosed.ops.map(op => op.periodId))]
          .map(pid => heldClosed.periods.find(p => p.id === pid)).filter(Boolean)
        const monthNames = months.map(monthOf).join(', ') || 'a closed month'
        const nexts = months.map(p => nextExistingPeriod(heldClosed.periods, p)).filter(Boolean)
        const hasClosing = heldClosed.ops.some(op => op.fieldKey === 'closing' && op.qty != null)
        const carryLabel = hasClosing && nexts.length ? ` and carry into ${nexts.map(monthOf).join(', ')}'s opening stock` : ''
        return (
          <div role="alert" style={{ background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-amber) 35%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-text2)', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span>
              <strong style={{ color: 'var(--theme-amber-text)' }}>{heldClosed.ops.length} figure{heldClosed.ops.length === 1 ? ' was' : 's were'} counted offline for {monthNames}, which has closed since.</strong>{' '}
              They have not been added. {hasClosing ? 'The month-end carry-forward ran without them, so the next month opened on the old closing count.' : ''}
            </span>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {heldClosed.ops.map(op => <li key={op.id}>{opLine(op)}</li>)}
            </ul>
            <ActionError error={heldError} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={heldBusy} aria-busy={heldBusy || undefined} onClick={addHeldToClosedMonth}>
                {heldBusy ? 'Adding…' : `Add to ${monthNames}${carryLabel}`}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={heldBusy} onClick={() => setPendingConfirm({
                title: 'Discard these offline figures?',
                body: <p style={{ margin: 0 }}>The {heldClosed.ops.length} figure{heldClosed.ops.length === 1 ? '' : 's'} listed will be taken off this device and never added to {monthNames}. The month keeps the figures it has now. This cannot be undone.</p>,
                confirmLabel: 'Discard', danger: true, run: discardHeld,
              })}>Discard these figures</button>
            </div>
          </div>
        )
      })()}

      {/* Nothing below the error card while a read has failed: every tab either shows figures the
          page does not have or saves on-screen state back to the server. */}
      {!loadError && <>
      {/* Up to eight tabs (nine with Settings) in a row that had no flexWrap — the shape that hid
          ClientDrawer's last tab. .panel-tab-bar wraps instead, so "Print Sheet" cannot vanish.
          A PIN count account gets one tab (see TABS), which is also what takes the bar on a phone
          back from three wrapped rows to none. The bar is still rendered for it: one tab reads as
          a heading for the screen below, and hiding it would make the single-tab case a different
          layout to maintain. */}
      {/* S765: this row declared role="tablist"/"tab"/aria-selected and delivered no aria-controls,
          no tabpanel and no roving tabIndex — so reaching Settings, the 9th tab, cost nine Tab
          presses, and Settings is where blind counting and recount protection live. */}
      <Tabs
        idBase="stock"
        hasPanel
        variant="panel"
        label="Stock count sections"
        className="no-print"
        tabs={TABS.map(tab => ({ key: tab.id, label: tab.label }))}
        active={activeTab}
        onChange={setActiveTab}
      />

      <TabPanel idBase="stock" active={activeTab}>
      {/* While a month's figures load (S792, STOCK-6), no tab that shows or writes them renders:
          not the grids or the touch cards, not the Summary and its Export, not the Print Sheet or
          Daily Wastage. Settings is the client's, not the month's, and stays. */}
      {figuresLoading && activeTab !== 'settings' && (
        <div className="card" role="status" style={{ padding: 28, textAlign: 'center', color: 'var(--theme-text2)', fontSize: 13 }}>
          Loading {periodLabel}…
        </div>
      )}
      {(!figuresLoading || activeTab === 'settings') && <>
      {/* Summary Tab */}
      {activeTab === 'summary' && blindOn && (
        /* Blind counting is on and this tab is the whole register — opening, purchases, closing
           and the value of each — for every item this account can see (S761). Withholding the
           reference figures on the Closing tab and then printing them here is not a control.
           The tab stays on the bar rather than disappearing: a counter who was using it should
           be told why it is empty, not left looking for it. */
        <div className="card" style={{ padding: 28, textAlign: 'center' }}>
          <p style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>Hidden while blind counting is on</p>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
            This month's summary carries the expected quantities your count is meant to be
            independent of. Your manager can see it, and it opens to you once the count is taken
            and blind counting is switched off.
          </p>
        </div>
      )}
      {activeTab === 'summary' && !blindOn && (
        <div>
          {(() => {
              const summary = getSummary()
              const EMPTY_ROW = { opening: 0, purchases: 0, returns: 0, closing: 0, wastage: 0, staffMeals: 0, cogs: 0 }
              // The Uncategorised group is rendered only when it actually holds something, so a
              // tidy client never sees an all-dashes row — but when it does hold something, both
              // the row and the Totals below include it.
              const uncat = summary[UNCATEGORISED] || EMPTY_ROW
              const hasUncat = Object.values(uncat).some(v => Math.abs(v) > 0.005)
              const summaryRows = [
                ...categories.map(c => ({ key: c.id, name: c.name, s: summary[c.name] || EMPTY_ROW })),
                ...(hasUncat ? [{ key: '__uncat__', name: UNCATEGORISED, s: uncat, muted: true }] : []),
              ]
              const rows = summaryRows.map(r => r.s)
              const totals = {
                opening:    rows.reduce((s, r) => s + r.opening,            0),
                purchases:  rows.reduce((s, r) => s + r.purchases,          0),
                returns:    rows.reduce((s, r) => s + (r.returns || 0),      0),
                closing:    rows.reduce((s, r) => s + r.closing,            0),
                wastage:    rows.reduce((s, r) => s + r.wastage,            0),
                staffMeals: rows.reduce((s, r) => s + (r.staffMeals || 0), 0),
                cogs:       rows.reduce((s, r) => s + r.cogs,               0),
              }
              const fmt = npr2
              const gap = getUncountedGap()
              const thStyle = { textAlign: 'right', whiteSpace: 'nowrap' }
              const tdStyle = (color) => ({ textAlign: 'right', color: color || 'var(--theme-text1)', whiteSpace: 'nowrap' })
              return (
                <>
                {/* D6 (S756): named here, above the Totals a month is closed on. Totals are unchanged —
                    the uncounted items are still in them, counted as fully used. */}
                <UncountedItemsBanner gap={gap} scope={periodLabel}>
                  They are marked in the item table below and in the Excel export.
                </UncountedItemsBanner>
                <div className="card" style={{ marginBottom: 24 }}>
                  {/* The disclosure exists for the accountant reconciling this page against Monthly
                      Summary (S575). Until S756 it claimed the two differed by exactly the
                      sub-recipe amount while this page valued purchases and returns at today's
                      master rate with no bill discount — so they differed by that as well, and by a
                      different amount every time a bill moved an item's rate. Both pages now value
                      purchases and returns the same way, which is what makes the sentence true. */}
                  <p style={{ margin: '0 0 10px', fontSize: 11, color: 'var(--theme-text3)' }}>
                    Purchases are valued at what each bill charged, less its bill discount, and returns
                    at the rate they went back at — the same basis as Monthly Summary. Opening, closing,
                    wastage and staff meals are valued at the current Item Master rate. These figures
                    also <strong>include sub-recipes</strong> (prep counted as stock), which Monthly
                    Summary leaves out, so its COGS differs from this page by the value of that prep.
                    An item hidden in Item Master stays in any month it had stock or movement in, just
                    as on Monthly Summary; the item table below marks it Hidden.
                  </p>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: 36, textAlign: 'center', color: 'var(--theme-text2)' }}>S.No</th>
                          <th><Tip text="All figures in NPR." width={140}>Category</Tip></th>
                          <th style={thStyle}>Opening Stock</th>
                          <th style={thStyle}><Tip text="What this period's purchase bills charged for these goods, after each bill's discount and before VAT. 'Production' = sub-recipes processed in-house from existing stock." width={280}>Purchase</Tip></th>
                          <th style={thStyle}><Tip text="Value of goods sent back to the vendor this period — a short delivery, a damaged crate, wrong item — at the rate each return was recorded at. Already netted off COGS." width={270}>Returns</Tip></th>
                          <th style={thStyle}>Closing Stock</th>
                          <th style={thStyle}>Wastage</th>
                          <th style={thStyle}>Staff Meals</th>
                          <th style={thStyle}><Tip text={`Cost of Goods Sold = ${COGS_FORMULA}, in NPR.`} width={280}>COGS</Tip></th>
                        </tr>
                      </thead>
                      <tbody>
                        {summaryRows.map(({ key, name, s, muted }, idx) => {
                          return (
                            <tr key={key}>
                              <td style={{ textAlign: 'center', color: 'var(--theme-text2)' }}>{muted ? '—' : idx + 1}</td>
                              <td style={{ fontWeight: 600, color: muted ? 'var(--theme-text2)' : 'var(--theme-text1)' }}>
                                {muted
                                  ? <Tip text="Items with no category set, or pointing at a category that no longer exists. They are included in the Totals below and in the item table — assign them a category in Item Master to file them properly." width={280}>{name}</Tip>
                                  : name}
                              </td>
                              {/* *-text variants (accent-ink for accent): these are TEXT on the
                                  card, and the base tokens fail AA on the light presets — the
                                  tfoot below already used the variants while these body cells
                                  did not (S612; the tdStyle() argument shape is exactly what a
                                  property-level color: grep cannot see). */}
                              <td style={tdStyle('var(--theme-text3)')}>{s.opening > 0 ? fmt(s.opening) : '—'}</td>
                              <td style={tdStyle('var(--theme-accent-ink)')}>{s.purchases > 0 ? fmt(s.purchases) : '—'}</td>
                              <td style={tdStyle('var(--theme-red-text)')}>{(s.returns || 0) > 0 ? fmt(s.returns) : '—'}</td>
                              <td style={tdStyle('var(--theme-green-text)')}>{s.closing > 0 ? fmt(s.closing) : '—'}</td>
                              <td style={tdStyle('var(--theme-red-text)')}>{s.wastage > 0 ? fmt(s.wastage) : '—'}</td>
                              <td style={tdStyle('var(--theme-purple-text)')}>{(s.staffMeals || 0) > 0 ? fmt(s.staffMeals) : '—'}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600, color: s.cogs < 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)', whiteSpace: 'nowrap' }}>{fmt(s.cogs)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                          <td></td>
                          <td style={{ fontWeight: 700, color: 'var(--theme-accent-ink)' }}>Totals</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>{fmt(totals.opening)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{fmt(totals.purchases)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', whiteSpace: 'nowrap' }}>{fmt(totals.returns)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-green-text)', whiteSpace: 'nowrap' }}>{fmt(totals.closing)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', whiteSpace: 'nowrap' }}>{fmt(totals.wastage)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-purple-text)', whiteSpace: 'nowrap' }}>{fmt(totals.staffMeals)}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', whiteSpace: 'nowrap' }}>{fmt(totals.cogs)}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
                </>
              )
            })()}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            {/* A failed client-name read would ship the register with a blank CompanyName line (S754 rule). */}
            <button className="btn btn-ghost" onClick={exportExcel} disabled={!!biz.error || figuresLoading}
              title={biz.error ? 'Your business name could not be loaded, so the export is paused — reload the page and try again.' : undefined}>
              Export Excel
            </button>
          </div>

          <div className="card">
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  {/* Sticky header (top:0) + sticky Item/COGS columns (left:0 / right:0) — this
                      table is 17 columns wide by nature (qty + value per metric), so reading any
                      one row used to mean scrolling all the way down past every item to reach the
                      table-wrap's horizontal scrollbar, dragging it right, then losing track of
                      which item or which column you were even looking at. Pinning the header plus
                      the two columns that matter most for identifying a row (Item) and reading its
                      bottom line (COGS) means neither scroll direction ever hides both at once —
                      same pattern already used for Purchases.js's Daily Register (sticky Total,
                      right:0) and Sales.js's pivot (sticky Menu Item, left:0). */}
                  <tr>
                    <th style={{ position: 'sticky', top: 0, left: 0, zIndex: 4, background: 'var(--theme-card)' }}>Item</th>
                    <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}>Category</th>
                    <th style={{ position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}>UOM</th>
                    <th style={{ textAlign: 'right', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}>Opening</th>
                    <th style={{ textAlign: 'right', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}>Purchased</th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}>Returned</th>
                    <th style={{ textAlign: 'right', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}>Wastage</th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-purple-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Staff & complimentary consumption recorded this period. Deducted from Used separately from wastage." width={240}>Staff Meals</Tip></th>
                    <th style={{ textAlign: 'right', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}>Closing</th>
                    <th style={{ textAlign: 'right', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text={`${COGS_FORMULA}. What was actually consumed this period.`} width={250}>Used</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-text2)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Total qty issued from the store via requisition slips this period. Should align with Used quantity." width={240}>Requisitioned</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-text3)', borderLeft: '1px solid var(--theme-border)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Opening quantity × per-unit rate. Value of stock carried forward from the previous period." width={240}>Open. Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="What this period's bills charged for the item, after each bill's discount and before VAT — not quantity × today's Item Master rate." width={240}>Purch. Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Wastage quantity × per-unit rate. NPR cost of goods recorded as waste." width={240}>Wastage Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-purple-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Staff meals quantity × per-unit rate. NPR cost of complimentary/staff consumption." width={260}>Staff Meals Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-green-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Closing (physical count) quantity × per-unit rate." width={220}>Close Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', borderLeft: '1px solid var(--theme-border)', position: 'sticky', top: 0, right: 0, zIndex: 4, background: 'var(--theme-card)' }}><Tip text={`Cost of Goods Sold = ${COGS_FORMULA}, in NPR. Purchases and returns at what they cost; stock on hand, wastage and staff meals at the Item Master rate.`} width={280}>COGS</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {(() => { const uncountedIds = new Set(getUncountedGap().uncounted.map(u => u.id)); return summaryItems.map(item => {
                    const row      = stockData[item.id] || {}
                    const used     = getUsed(item.id)
                    const notCounted = uncountedIds.has(item.id)
                    const returned = returns[item.id] || 0
                    const rate     = parseFloat(item.per_uom_rate || 0)
                    const openQty  = parseFloat(row.opening     || 0)
                    const purchQty = parseFloat(purchases[item.id] || 0)
                    // Period wastage is catch-all + daily, exactly as getUsed(), getSummary() and
                    // the Excel export all compute it. This row alone used to print the catch-all
                    // only, so on any item with Daily Wastage the Wastage column contradicted the
                    // Used and COGS columns beside it, the category rollup above it and the
                    // spreadsheet — the row simply did not add up.
                    const wastQty  = parseFloat(row.wastage || 0) + (parseFloat(dailyWastage[item.id]) || 0)
                    const staffQty = parseFloat(row.staff_meal  || 0)
                    const closeQty = parseFloat(row.closing     || 0)
                    // Wastage and staff meals count as "this item has activity" too. Without them an
                    // item carrying only waste (no opening, no purchase, no count) rendered Used and
                    // COGS as "—" while the rollup above still added its negative COGS in.
                    const hasData  = row.opening !== '' || row.closing !== '' || purchases[item.id] || wastQty > 0 || staffQty > 0
                    const fmtVal   = (qty) => rate > 0 && qty !== 0
                      ? `NPR ${Math.round(qty * rate).toLocaleString('en-IN')}`
                      : '—'
                    // No-activity rows are muted by WEIGHT and the anchor cells' colour, never by row
                    // opacity — DESIGN.md's own Don't: opacity multiplies through every cell's text
                    // colour and takes the row below AA (S613; this row was the product's one
                    // violation of it). The body cells already read as quiet — every one shows an
                    // em-dash when empty — so only the two loud sticky anchors (name, COGS) need
                    // stepping down. A sticky cell still needs its fully OPAQUE background so
                    // scrolled-away columns don't show through underneath it.
                    const stickyBg = 'var(--theme-card)'
                    return (
                      <tr key={item.id}>
                        <td style={{ fontWeight: hasData ? 600 : 400, color: hasData ? 'var(--theme-text1)' : 'var(--theme-text3)', position: 'sticky', left: 0, zIndex: 1, background: stickyBg }}>
                          {item.name}
                          {/* S756 D6: stock this period, no closing count — Used and COGS count all of it. */}
                          {notCounted && (
                            <span className="badge badge-amber" style={{ marginLeft: 6 }} title="Has stock this period but no closing count — Used and COGS treat all of it as consumed">not counted</span>
                          )}
                          {/* S792, D29: kept in the month it had a row in; not on any entry tab. */}
                          {item.is_active === false && (
                            <span className="badge badge-gray" style={{ marginLeft: 6 }} title={HIDDEN_ITEM_TIP}>Hidden</span>
                          )}
                        </td>
                        <td><span className="badge badge-yellow">{item.categories?.name}</span></td>
                        <td style={{ color: 'var(--theme-text2)' }}>{item.uom}</td>
                        <td style={{ textAlign: 'right' }}>{row.opening !== '' ? Number(row.opening).toLocaleString('en-IN') : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{purchQty > 0 ? dispPurch(purchQty, item) : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{returned > 0 ? `−${Number(returned).toLocaleString('en-IN')}` : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{wastQty > 0 ? Number(wastQty).toLocaleString('en-IN') : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-purple-text)' }}>{staffQty > 0 ? Number(staffQty).toLocaleString('en-IN') : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{row.closing !== '' ? Number(row.closing).toLocaleString('en-IN') : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: used < 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
                          {hasData ? Number(used).toLocaleString('en-IN') : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                          {requisitioned[item.id] ? Number(requisitioned[item.id]).toLocaleString('en-IN') : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)', borderLeft: '1px solid var(--theme-border)' }}>{fmtVal(openQty)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{purchQty > 0 ? npr(purchaseValueOf(item)) : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmtVal(wastQty)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-purple-text)' }}>{fmtVal(staffQty)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{fmtVal(closeQty)}</td>
                        <td style={{ textAlign: 'right', fontWeight: hasData ? 700 : 400, color: used < 0 ? 'var(--theme-red-text)' : hasData ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', borderLeft: '1px solid var(--theme-border)', position: 'sticky', right: 0, zIndex: 1, background: stickyBg }}>
                          {hasData ? npr(getCogsValue(item)) : '—'}
                        </td>
                      </tr>
                    )
                  }) })()}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Settings Tab (S737) — the panel lives in its own file: this one is already 1,700 lines,
          and nothing in it is shared with counting. */}
      {activeTab === 'settings' && canManageCounts && (
        <StockCountSettings
          clientId={effectiveClientId}
          categories={allCategories}
          uncategorisedCount={allItems.filter(i => !i.category_id).length}
        />
      )}

      {/* Print Sheet Tab */}
      {activeTab === 'print' && (
        <div>
          <div className="no-print" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <input aria-label="Search items"
                style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 200 }}
                placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
              />
              <select aria-label="Filter by category"
                style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
                value={filterCat} onChange={e => setFilterCat(e.target.value)}
              >
                <option value="all">All Categories</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" onClick={() => printWithTitle(`Stock Count Sheet - ${periodLabel}`)}>🖨 Print Sheet</button>
          </div>

          <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }} className="no-print">
            {blindOn
              ? 'Blind counting is on, so this sheet prints without the expected quantities — write what is on the shelf. ★ marks high-value, fast-moving items; count these first and double-check the figures.'
              : 'System Ref Qty = Opening Stock + Purchases − Returns recorded this period. ★ marks high-value, fast-moving items — count these first and double-check the figures.'}
          </div>

          <div className="card print-sheet">
            <div className="print-sheet-header">
              <h2 style={{ margin: '0 0 2px', fontSize: 18, color: 'var(--theme-text1)' }}>Physical Stock Count Sheet</h2>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
                {/* In BS, as the day is read in Nepal (S756). It printed the runtime's AD date,
                    so a sheet on the store-room wall named a calendar no one here counts in. */}
                Period: {periodLabel} &nbsp;·&nbsp; Printed: {(() => {
                  const t = nepalBs(new Date())
                  return t ? `${formatBsDay(t.day, t.month)} ${t.year}` : `${nepalDateAd(new Date())} (AD)`
                })()}
              </p>
            </div>

            {(() => {
              const flagged = highValueFlags
              const grouped = categories
                .map(c => ({ category: c, catItems: visible.filter(i => i.category_id === c.id) }))
                .filter(g => g.catItems.length > 0)
              const uncategorized = visible.filter(i => !i.category_id)
              if (uncategorized.length > 0) grouped.push({ category: { id: 'none', name: 'Uncategorized' }, catItems: uncategorized })
              if (grouped.length === 0) return <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>No items match the current filters.</p>
              return grouped.map(({ category, catItems }) => (
                <div key={category.id} className="print-sheet-section">
                  <h3 className="print-sheet-cat">{category.name}</h3>
                  <table className="data-table print-sheet-table">
                    <thead>
                      <tr>
                        <th style={{ width: 40 }}><Tip text="High-value, fast-moving items. Count these first — errors here have the biggest financial impact." width={220}>★</Tip></th>
                        <th>Item</th>
                        <th>UOM</th>
                        {/* The reference quantity is the whole thing blind counting hides (S761).
                            Printing it here handed a blinded counter the figure the Closing tab
                            had just withheld — on paper, which is worse, because it leaves the
                            store room. */}
                        {!blindOn && <th style={{ textAlign: 'right' }}><Tip text="Opening Stock + Purchases − Returns recorded this period. Use as a reference — your physical count may differ due to usage or shrinkage." width={250}>System Ref Qty</Tip></th>}
                        <th style={{ textAlign: 'right' }}>Physical Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catItems.map(item => (
                        <tr key={item.id}>
                          <td style={{ textAlign: 'center', color: 'var(--theme-accent-ink)' }}>{flagged.has(item.id) ? '★' : ''}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{item.name}</td>
                          <td style={{ color: 'var(--theme-text2)' }}>{item.uom}</td>
                          {!blindOn && <td style={{ textAlign: 'right' }}>{Number(getSystemRefQty(item.id)).toLocaleString('en-IN')}</td>}
                          <td className="print-sheet-blank"></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))
            })()}
          </div>
        </div>
      )}

      {/* Daily Wastage Tab */}
      {activeTab === 'daily_wastage' && (() => {
        if (!selectedPeriod) {
          return <div className="card" style={{ padding: 28, textAlign: 'center', color: 'var(--theme-text2)' }}>No period selected.</div>
        }
        const winp = { background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', fontFamily: 'inherit' }
        const valOf = r => (parseFloat(r.qty) || 0) * parseFloat(r.items?.per_uom_rate || 0)
        const dayEntries = dailyRows.filter(r => r.bs_day === wDay).sort((a, b) => valOf(b) - valOf(a))
        const dayQty = dayEntries.reduce((s, r) => s + (parseFloat(r.qty) || 0), 0)
        const dayValue = dayEntries.reduce((s, r) => s + valOf(r), 0)
        const perDay = {}
        dailyRows.forEach(r => { perDay[r.bs_day] = (perDay[r.bs_day] || 0) + valOf(r) })
        const monthValue = Object.values(perDay).reduce((s, v) => s + v, 0)
        const fmtNpr = npr
        return (
          <div>
            <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
              Log spoilage and waste as it happens, by day and reason. These entries roll into the period's total wastage and COGS — alongside the monthly catch-all on the Wastage tab.
            </div>

            {/* Day selector + month total */}
            <div className="card" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Day</span>
                <div style={{ width: 160 }}>
                  <BsCalendarPicker
                    lockYear={selectedPeriod?.bs_year}
                    lockMonth={selectedPeriod?.bs_month}
                    value={wDay}
                    onChange={v => setWDay(parseInt(v, 10))}
                    placeholder="Pick day"
                  />
                </div>
              </div>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                Month total: <span style={{ color: 'var(--theme-red-text)', fontWeight: 700 }}>{monthValue > 0 ? fmtNpr(monthValue) : '—'}</span>
              </span>
            </div>

            {/* Add entry */}
            {!isLocked && (
              <div className="card" style={{ marginBottom: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ flex: '2 1 220px' }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--theme-text2)', marginBottom: 5 }} htmlFor="stock-f1">Item</label>
                  <SearchableSelect id="stock-f1"
                    value={wEntry.item_id}
                    onChange={v => setWEntry(w => ({ ...w, item_id: v }))}
                    options={itemOptions}
                    placeholder="— Select item —"
                  />
                </div>
                <div style={{ flex: '0 1 110px' }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--theme-text2)', marginBottom: 5 }} htmlFor="stock-f2">Qty</label>
                  <QtyInput id="stock-f2"
                    value={wEntry.qty}
                    onChange={v => setWEntry(w => ({ ...w, qty: v }))}
                    placeholder="0"
                    wrapperStyle={{ width: '100%' }}
                    style={{ ...winp, width: '100%', textAlign: 'right', boxSizing: 'border-box' }}
                  />
                </div>
                <div style={{ flex: '1 1 150px' }}>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--theme-text2)', marginBottom: 5 }} htmlFor="stock-f3">
                    <Tip text="Why the stock was lost. Grouped only to make the list quicker to scan — the Wastage Report totals by the individual reason, not by the heading. Pick the one that says what you'd DO about it." width={260}>Reason</Tip>
                  </label>
                  <select id="stock-f3" style={{ ...winp, width: '100%' }} value={wEntry.reason} onChange={e => setWEntry(w => ({ ...w, reason: e.target.value }))}>
                    {WASTAGE_REASON_GROUPS.map(g => (
                      <optgroup key={g.group} label={g.group}>
                        {g.reasons.map(r => <option key={r} value={r}>{r}</option>)}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <button className="btn btn-primary" onClick={addDailyWastage} disabled={wBusy || !wEntry.item_id || !(parseFloat(wEntry.qty) > 0)} style={{ fontSize: 13 }}>
                  {wBusy ? 'Saving…' : '+ Add'}
                </button>
              </div>
            )}

            {/* Selected day's entries */}
            <div className="card" style={{ padding: 0, marginBottom: 16 }}>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Reason</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Qty wasted × per-unit rate." width={200}>Value (NPR)</Tip>
                      </th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {dayEntries.length === 0 ? (
                      <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--theme-text2)', padding: 24 }}>No wastage logged for {formatBsDay(wDay, selectedPeriod?.bs_month)}.</td></tr>
                    ) : dayEntries.map(r => (
                      <tr key={r.id}>
                        <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{r.items?.name || '—'}</td>
                        <td><span className="badge badge-yellow">{r.reason || DEFAULT_WASTAGE_REASON}</span></td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{Number(r.qty).toLocaleString('en-IN')} {r.items?.uom || ''}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)', fontWeight: 600 }}>{valOf(r) > 0 ? fmtNpr(valOf(r)) : '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {!isLocked && <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteDailyWastage(r.id)} disabled={wBusy}>Del</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  {dayEntries.length > 0 && (
                    <tfoot>
                      <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                        <td colSpan={2} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>{formatBsDay(wDay, selectedPeriod?.bs_month)} total</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 12 }}>{Number(dayQty).toLocaleString('en-IN')}</td>
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', fontSize: 14, paddingTop: 12 }}>{fmtNpr(dayValue)}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>

            {/* Month strip — days with wastage */}
            {Object.keys(perDay).length > 0 && (
              <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginRight: 4 }}>Days with wastage</span>
                {Object.keys(perDay).map(Number).sort((a, b) => a - b).map(d => (
                  <button key={d} onClick={() => setWDay(d)} className="btn btn-ghost" style={{ fontSize: 11, padding: '5px 10px', borderColor: d === wDay ? 'color-mix(in srgb, var(--theme-accent) 50%, transparent)' : 'var(--theme-border)', color: d === wDay ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>
                    Day {d} · {fmtNpr(perDay[d])}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {fieldKeyOf(activeTab) && (() => {
        const fieldKey = fieldKeyOf(activeTab)
        // The accessible name of each grid box — "Closing count for Tomato (KG)". The cells have no
        // <label>, so a screen reader announced "edit text, 34" with no item, field or unit: 322
        // times on one real count sheet, on the page a month is closed from (S794).
        const fieldName = FIELD_LABEL[fieldKey] || fieldKey
        const qtyBoxLabel = item => `${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)} for ${item.name}${item.uom ? ` (${item.uom})` : ''}`
        // An empty closing box is "not counted" and a typed 0 is a count (S695), so the empty box
        // must not wear a "0" placeholder that makes it look counted (S796). The other fields store
        // nothing for 0 or blank alike, so they need no hint at all.
        const countPlaceholder = fieldKey === 'closing' ? 'not counted' : undefined
        const counted = countedItems(fieldKey)
        const pct = visible.length > 0 ? Math.round(counted / visible.length * 100) : 0
        const totalQty = visible.reduce((s, item) => s + (parseFloat(stockData[item.id]?.[fieldKey]) || 0), 0)
        const totalValue = visible.reduce((s, item) => {
          const rate = parseFloat(item.per_uom_rate || 0)
          const qty  = parseFloat(stockData[item.id]?.[fieldKey]) || 0
          return s + (rate > 0 ? qty * rate : 0)
        }, 0)
        return (
          <>
            <div style={{ background: 'color-mix(in srgb, var(--theme-accent) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-accent) 20%, transparent)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
              {TABS.find(t => t.id === activeTab)?.desc} — enter quantities in the item's UOM, then click Save All.
            </div>

            {isMobile ? (
              <div style={{ marginBottom: 12 }}>
                <input aria-label="Search items"
                  style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', marginBottom: 10 }}
                  placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
                />
                {/* S765: was .mobile-cat-strip/.mobile-cat-btn, a hand-rolled copy of .tab-btn that
                    kept the bug the real class was fixed for — accent-as-text on its own focus-ring
                    tint, ~2.8:1 on Modernist Light. The shared classes bring accent-ink, the focus
                    pair and the coarse-pointer touch floor, none of which Stock.css ever had. */}
                <FilterChips
                  label="Filter by category"
                  className="tab-bar--scroll"
                  options={[{ key: 'all', label: 'All' }, ...categories.map(c => ({ key: c.id, label: c.name }))]}
                  active={filterCat}
                  onChange={setFilterCat}
                />
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  <input aria-label="Search items"
                    style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 200 }}
                    placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
                  />
                  <select aria-label="Filter by category"
                    style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none' }}
                    value={filterCat} onChange={e => setFilterCat(e.target.value)}
                  >
                    <option value="all">All Categories</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {activeTab === 'opening' && (
                      <button
                        className="btn btn-ghost"
                        title="Copies last month's counted closing stock into this period's opening — 'this month's closing IS next month's opening'. Existing opening entries for those items are overwritten."
                        style={{ color: 'var(--theme-accent-ink)', borderColor: 'color-mix(in srgb, var(--theme-accent) 35%, transparent)' }}
                        onClick={pullFromLastMonthClosing}
                        disabled={saveAllLoading || isLocked}
                      >
                        ↩ Pull from last month
                      </button>
                    )}
                    {/* Not for a counting tablet (S792, MASTER-8): S761 dropped Clear All from the
                        touch layout only, so a count PIN on a mouse or trackpad could still blank
                        every visible item's closing count for the month in one click. */}
                    {!imsCountOnly && (
                      <button className="btn btn-ghost" style={{ color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }} onClick={clearAll} disabled={saveAllLoading || isLocked}>Clear All</button>
                    )}
                  </div>
                  <button className="btn btn-primary" onClick={saveAll} disabled={saveAllLoading || isLocked}>
                    {saveAllLoading ? 'Saving…' : saved ? '✓ Saved' : 'Save All'}
                  </button>
                </div>
              </div>
            )}

            {isMobile && (
              <div className="mobile-progress" role="progressbar" aria-valuenow={counted} aria-valuemin={0}
                aria-valuemax={visible.length} aria-label={`${counted} of ${visible.length} items counted`}>
                {/* A 0–1 fraction, not a width: the bar is drawn full width and squeezed with
                    scaleX, so the transition composites instead of running layout. An inline
                    `width` also beat the stylesheet outright, leaving a declared transition that
                    had never once run. */}
                <div className="mobile-progress-bar" style={{ '--count-scale': pct / 100 }} />
                <span className="mobile-progress-label">{counted} / {visible.length} counted</span>
              </div>
            )}

            {isMobile ? (
              <>
              <div className="mobile-stock-list">
                {visible.map(item => {
                  const row = stockData[item.id] || {}
                  const val = row[fieldKey]
                  const returned = returns[item.id] || 0
                  const rate = parseFloat(item.per_uom_rate || 0)
                  const qty = parseFloat(val || 0)
                  const lineValue = rate > 0 && qty > 0 ? Math.round(qty * rate) : null
                  // S765: `has-value` fired on the first KEYSTROKE, so "I typed it" and "the server
                  // has it" were the same border. On a shared tablet — two people counting, one
                  // offline queue — that is the single fact the counter needs and the only one the
                  // card would not tell them. `isChanged` already knows what the server holds, so
                  // the three states are free: saving, typed-not-stored, stored.
                  const isSavingRow = !!saving[item.id]
                  const isQueued = pendingItems.has(item.id)
                  const hasVal = val !== '' && val !== null && val !== undefined
                  const isStored = hasVal && !isQueued && !isSavingRow && !isChanged(item.id, fieldKey, val)
                  const isUnsaved = hasVal && !isQueued && !isSavingRow && !isStored
                  const stateCls = isQueued ? ' pending' : isSavingRow ? ' saving' : isStored ? ' stored' : isUnsaved ? ' unsaved' : ''
                  return (
                    <div key={item.id} className={`mobile-stock-card${hasVal ? ' has-value' : ''}${stateCls}`}>
                      <div className="mobile-stock-card-header">
                        <span className="mobile-stock-item-name">{item.name}</span>
                        <span className="badge badge-yellow">{item.categories?.name}</span>
                      </div>
                      <div className="mobile-stock-card-meta">
                        <span className="mobile-stock-uom">{item.uom}</span>
                        {fieldKey === 'closing' && countedBy[item.id] && (
                          <span className="mobile-stock-ref">counted by {countedBy[item.id]}</span>
                        )}
                        {!blindCount && purchases[item.id] > 0 && (
                          <span className="mobile-stock-ref">Purchased: {dispPurch(Number(purchases[item.id]), item)}</span>
                        )}
                        {!blindCount && returned > 0 && (
                          <span className="mobile-stock-ref" style={{ color: 'var(--theme-red-text)' }}>Returned: −{Number(returned).toLocaleString('en-IN')}</span>
                        )}
                      </div>
                      <div className="mobile-stock-card-input-row">
                        <QtyInput
                          aria-label={qtyBoxLabel(item)}
                          value={val}
                          onChange={v => updateField(item.id, fieldKey, v)}
                          onCommit={v => saveRow(item.id, v)}
                          placeholder={countPlaceholder}
                          disabled={isLocked}
                          className="mobile-stock-input"
                          wrapperStyle={{ flex: 1, minWidth: 0 }}
                        />
                        <span className="mobile-stock-unit">{item.uom}</span>
                        {!hideValues && !blindCount && lineValue != null && (
                          <span className="mobile-stock-value">NPR {lineValue.toLocaleString('en-IN')}</span>
                        )}
                      </div>
                      {/* The state ships a WORD, not only a border colour — the counter on a shared
                          tablet is the reader, and a border they have to remember the meaning of is
                          not an answer. `aria-live` so it is announced rather than only drawn. */}
                      {hasVal && (
                        <div className="mobile-stock-state" aria-live="polite">
                          {isSavingRow ? <span className="mobile-stock-state--saving">Saving…</span>
                            : isQueued ? <span className="mobile-stock-state--queued">△ Saved on this device — waiting for a connection</span>
                            : isStored ? <span className="mobile-stock-state--stored">✓ Saved</span>
                            : <span className="mobile-stock-state--unsaved">△ Not saved yet</span>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', marginTop: 10, background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontWeight: 700 }}>
                <span style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Total — {visible.length} item{visible.length !== 1 ? 's' : ''}</span>
                <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <span style={{ color: 'var(--theme-text1)', fontSize: 13 }}>{totalQty > 0 ? Number(totalQty).toLocaleString('en-IN') : '—'}</span>
                  {!hideValues && !blindCount && <span style={{ color: 'var(--theme-accent-ink)', fontSize: 14 }}>{totalValue > 0 ? `NPR ${Math.round(totalValue).toLocaleString('en-IN')}` : '—'}</span>}
                </span>
              </div>
              </>
            ) : (
              <div className="card">
                {loading ? (
                  <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Item</th>
                          <th>Category</th>
                          <th style={{ textAlign: 'right' }}>UOM</th>
                          <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                            {activeTab === 'opening' ? 'Opening Qty' : activeTab === 'closing' ? 'Physical Count' : activeTab === 'staff_meal' ? 'Staff Meals Qty' : 'Wastage Qty'}
                          </th>
                          {!blindCount && <th style={{ textAlign: 'right' }}>Purchased</th>}
                          {!blindCount && <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returned</th>}
                          {!hideValues && !blindCount && (
                            <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                              <Tip text="Qty entered × unit rate (per_uom_rate). Gives the NPR value of this item's stock entry." width={220}>Value (NPR)</Tip>
                            </th>
                          )}
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {visible.map(item => {
                          const row = stockData[item.id] || {}
                          const val = row[fieldKey]
                          const isSaving = saving[item.id]
                          const returned = returns[item.id] || 0
                          const rate = parseFloat(item.per_uom_rate || 0)
                          const qty = parseFloat(val || 0)
                          const lineValue = rate > 0 && qty > 0 ? Math.round(qty * rate) : null
                          return (
                            <tr key={item.id}>
                              <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                                {item.name}
                                {/* Who counted it (S756) — closing_stock.counted_by_name had been
                                    written since S737 and shown nowhere. A block child so it takes
                                    its own line without widening the column. */}
                                {fieldKey === 'closing' && countedBy[item.id] && (
                                  <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)' }}>counted by {countedBy[item.id]}</span>
                                )}
                              </td>
                              <td><span className="badge badge-yellow">{item.categories?.name}</span></td>
                              <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{item.uom}</td>
                              <td style={{ textAlign: 'right', width: 140 }}>
                                <QtyInput
                                  aria-label={qtyBoxLabel(item)}
                                  value={val}
                                  onChange={v => updateField(item.id, fieldKey, v)}
                                  onCommit={v => saveRow(item.id, v)}
                                  placeholder={countPlaceholder}
                                  disabled={isLocked}
                                  wrapperStyle={{ width: 110 }}
                                  style={{
                                    background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                    borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 13,
                                    color: 'var(--theme-text1)', outline: 'none', width: '100%',
                                    textAlign: 'right', fontFamily: 'inherit', boxSizing: 'border-box',
                                    borderColor: val > 0 ? 'color-mix(in srgb, var(--theme-accent) 40%, transparent)' : 'var(--theme-border)'
                                  }}
                                />
                              </td>
                              {!blindCount && (
                                <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 13 }}>
                                  {purchases[item.id] ? `${Number(purchases[item.id]).toLocaleString('en-IN')} ${item.uom}` : '—'}
                                </td>
                              )}
                              {!blindCount && (
                                <td style={{ textAlign: 'right', color: returned > 0 ? 'var(--theme-red-text)' : 'var(--theme-text3)', fontSize: 13 }}>
                                  {returned > 0 ? `−${Number(returned).toLocaleString('en-IN')} ${item.uom}` : '—'}
                                </td>
                              )}
                              {!hideValues && !blindCount && (
                                <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 13, fontWeight: lineValue ? 600 : 400 }}>
                                  {lineValue != null ? `NPR ${lineValue.toLocaleString('en-IN')}` : '—'}
                                </td>
                              )}
                              <td style={{ width: 40, textAlign: 'center' }}>
                                {isSaving && <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>…</span>}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '2px solid var(--theme-border)' }}>
                          <td colSpan={3} style={{ fontWeight: 700, color: 'var(--theme-text2)', paddingTop: 12 }}>
                            Total — {visible.length} item{visible.length !== 1 ? 's' : ''}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-text1)', paddingTop: 12 }}>
                            {totalQty > 0 ? Number(totalQty).toLocaleString('en-IN') : '—'}
                          </td>
                          {!blindCount && <td colSpan={2}></td>}
                          {!hideValues && !blindCount && (
                            <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 12 }}>
                              {totalValue > 0 ? `NPR ${Math.round(totalValue).toLocaleString('en-IN')}` : '—'}
                            </td>
                          )}
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )}

            {isMobile && (
              <div className="mobile-save-bar">
                {activeTab === 'opening' && (
                  <button className="btn btn-ghost" style={{ flex: 1, color: 'var(--theme-accent-ink)', borderColor: 'color-mix(in srgb, var(--theme-accent) 35%, transparent)' }} onClick={pullFromLastMonthClosing} disabled={saveAllLoading || isLocked}>
                    ↩ Last month
                  </button>
                )}
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={saveAll} disabled={saveAllLoading || isLocked}>
                  {saveAllLoading ? 'Saving…' : saved ? '✓ Saved' : 'Save All'}
                </button>
              </div>
            )}
          </>
        )
      })()}
      </>}
      </TabPanel>
      </>}
      {pendingConfirm && (
        <ConfirmModal
          title={pendingConfirm.title}
          confirmLabel={pendingConfirm.confirmLabel}
          danger={pendingConfirm.danger}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={() => { const run = pendingConfirm.run; setPendingConfirm(null); run() }}
        >
          {pendingConfirm.body}
        </ConfirmModal>
      )}
      {countConflicts && (
        <CountConflictModal
          rows={countConflicts.rows}
          busy={conflictBusy}
          error={conflictError}
          onResolve={resolveCountConflicts}
          onClose={() => { setCountConflicts(null); setConflictError(null) }}
        />
      )}
    </div>
  )
}
