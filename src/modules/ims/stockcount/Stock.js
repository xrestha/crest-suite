import { useEffect, useRef, useState, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import NoPeriodState from '../../../components/NoPeriodState'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { COGS_FORMULA } from '../../../shared/imsFormulas'
import SearchableSelect from '../../../components/SearchableSelect'
import ConfirmModal from '../../../components/ConfirmModal'
import QtyInput from '../../../components/QtyInput'
import './Stock.css'
import { cacheItems, getCachedItems, cacheCategories, getCachedCategories, cachePeriods, getCachedPeriods, cacheStockData, getCachedStockData, enqueue, getQueue, dequeue } from '../../../utils/offlineQueue'
import { BS_MONTHS, getBsToday, formatBsDay } from '../../../utils/bsCalendar'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { printWithTitle } from '../../../utils/printTitle'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'

const WASTAGE_REASONS = ['Spoilage', 'Expiry', 'Over-prep', 'Breakage', 'Spillage', 'Customer return', 'Other']

function dispPurch(baseQty, item) {
  const cf = parseFloat(item.conversion_factor) || 1
  if (cf > 1 && item.purchase_unit) {
    const puQty = (baseQty / cf).toLocaleString(undefined, { maximumFractionDigits: 3 })
    return `${puQty} ${item.purchase_unit} (${Number(baseQty).toLocaleString()} ${item.uom})`
  }
  return Number(baseQty).toLocaleString()
}

export default function Stock() {
  const { clientId, profile, loading: authLoading, isAdmin, hasFeature, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom } = useScopedDb()
  const periodReq = useLatestRequest()
  const [periods, setPeriods] = useState([])
  const [selectedPeriod, setSelectedPeriod] = useState(null)
  const [items, setItems] = useState([])
  const itemOptions = useMemo(() => items.map(i => ({ value: i.id, label: i.name })), [items])
  const [categories, setCategories] = useState([])
  const [stockData, setStockData] = useState({})
  const [purchases, setPurchases] = useState({})
  const [returns, setReturns] = useState({}) // { item_id: total_returned_qty }
  const [requisitioned, setRequisitioned] = useState({}) // { item_id: total_qty_issued }
  const [purchFreq, setPurchFreq] = useState({})
  const [dailyWastage, setDailyWastage] = useState({})   // { item_id: total dated wastage qty }
  const [dailyRows, setDailyRows] = useState([])         // raw dated wastage rows (with item join) for the Daily tab
  const [wDay, setWDay] = useState(getBsToday().day)     // selected BS day for daily wastage entry
  const [wEntry, setWEntry] = useState({ item_id: '', qty: '', reason: 'Other' })
  const [wBusy, setWBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState({})
  const [activeTab, setActiveTab] = useState('opening')
  const [filterCat, setFilterCat] = useState('all')
  const [search, setSearch] = useState('')
  const [saveAllLoading, setSaveAllLoading] = useState(false)
  const [saved, setSaved] = useState(false)
  // Shared ConfirmModal for the page's bulk writes (S575 rule; these three ran on window.confirm
  // until S612): { title, body, confirmLabel, danger, run }.
  const [pendingConfirm, setPendingConfirm] = useState(null)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  const [isOnline, setIsOnline] = useState(() => navigator.onLine)
  const [pendingSync, setPendingSync] = useState(0)
  const [syncing, setSyncing] = useState(false)
  const [pendingItems, setPendingItems] = useState(new Set())
  const flushRef = useRef(null)

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
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
      init()
      if (navigator.onLine) flushRef.current?.()
    }
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function init() {
    setLoading(true)

    if (!navigator.onLine) {
      const [cachedItems, cachedCats, cachedPeriods] = await Promise.all([
        getCachedItems(effectiveClientId),
        getCachedCategories(effectiveClientId),
        getCachedPeriods(effectiveClientId),
      ])
      if (cachedItems)   setItems(cachedItems)
      if (cachedCats)    setCategories(cachedCats)
      if (cachedPeriods) {
        setPeriods(cachedPeriods)
        const open = cachedPeriods.find(x => x.status === 'open')
        if (open) {
          setSelectedPeriod(open)
          const cached = await getCachedStockData(open.id)
          if (cached) {
            const pending = await getQueue()
            const sd = { ...(cached.stockData || {}) }
            pending.forEach(op => {
              if (op.periodId === open.id) {
                if (!sd[op.itemId]) sd[op.itemId] = {}
                sd[op.itemId] = { ...sd[op.itemId], [op.fieldKey]: op.qty }
              }
            })
            setStockData(sd)
            setPurchases(cached.purchases    || {})
            setReturns(cached.returns        || {})
            setRequisitioned(cached.requisitioned || {})
            setPendingSync(pending.filter(op => op.periodId === open.id).length)
            setPendingItems(new Set(pending.filter(op => op.periodId === open.id).map(op => op.itemId)))
          }
        }
      }
      setLoading(false)
      return
    }

    const [{ data: p }, { data: i }, { data: c }] = await Promise.all([
      scopedFrom('monthly_periods').order('bs_year', { ascending: false }).order('bs_month', { ascending: false }),
      scopedFrom('items', '*, categories(name)').eq('is_active', true).order('name'),
      scopedFrom('categories').order('sort_order')
    ])
    setPeriods(p || [])
    setItems(i || [])
    setCategories(c || [])
    await Promise.all([
      cachePeriods(effectiveClientId, p || []),
      cacheItems(effectiveClientId, i || []),
      cacheCategories(effectiveClientId, c || []),
    ])
    const open = (p || []).find(x => x.status === 'open')
    if (open) {
      setSelectedPeriod(open)
      await loadStockData(open.id, i || [])
    }
    setLoading(false)
  }

  async function loadStockData(periodId, itemList) {
    // Every one of these is paged. PostgREST's silent 1000-row cap (S528/S529) is worst here of
    // anywhere: a truncated read produces a *plausible* COGS rather than an error, and this is the
    // page a month is closed from. `wastages` is the one that realistically crosses it — daily
    // entries are one row per item per day — but opening/closing are one row per item, so a client
    // past 1000 items would silently lose stock too. Each needs a unique tiebreaker in its sort or
    // paging can repeat a row on one page and skip it on the next.
    const [{ data: opening }, { data: closing }, { data: wastages }, { data: staffMealsData }, { data: purch }, { data: rets }, reqRes] = await Promise.all([
      fetchAllRows(() => supabase.from('opening_stock').select('*').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('closing_stock').select('*').eq('period_id', periodId).order('id')),
      fetchAllRows(() => supabase.from('wastages').select('id, item_id, qty, bs_day, reason, items(name, uom, per_uom_rate)').eq('period_id', periodId).order('id')),
      // Read and write must agree on `type`: persistValueDirect deletes and reinserts ONLY
      // type='staff', so counting a 'comp' row here would show a figure this tab cannot edit and
      // would double it on the next save. Nothing writes 'comp' today; this keeps it that way.
      fetchAllRows(() => supabase.from('staff_meals').select('item_id, qty').eq('period_id', periodId).eq('type', 'staff').order('id')),
      fetchAllRows(() => supabase.from('purchase_entries').select('item_id, qty').eq('period_id', periodId).order('id')),
      fetchAllRows(() => scopedFrom('vendor_returns', 'item_id, qty').eq('period_id', periodId).order('id')),
      // Independent of the six reads above but previously awaited after them — one extra serial
      // round trip on every load of the heaviest page. A failure degrades to "no requisitions",
      // exactly what the old try/catch did.
      fetchAllRows(() => supabase
        .from('requisition_lines')
        .select('item_id, qty_issued, requisitions!inner(client_id, period_id, status)')
        .eq('requisitions.period_id', periodId)
        .eq('requisitions.status', 'issued')
        .order('id')).catch(() => ({ data: null })),
    ])

    const data = {}
    const items = itemList || []
    items.forEach(item => { data[item.id] = { opening: '', closing: '', wastage: '', staff_meal: '' } })
    ;(opening || []).forEach(r => { if (data[r.item_id]) data[r.item_id].opening = r.qty })
    ;(closing || []).forEach(r => { if (data[r.item_id]) data[r.item_id].closing = r.physical_qty })

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
    Object.keys(catchAllMap).forEach(id => { if (data[id]) data[id].wastage = catchAllMap[id] })
    if (!periodReq.isCurrent(periodId)) return   // superseded by a newer period selection
    setDailyWastage(dailyMap)
    setDailyRows(dated)

    const staffMealMap = {}
    ;(staffMealsData || []).forEach(r => { staffMealMap[r.item_id] = (staffMealMap[r.item_id] || 0) + parseFloat(r.qty) })
    Object.keys(staffMealMap).forEach(id => { if (data[id]) data[id].staff_meal = staffMealMap[id] })

    setStockData(data)

    const purchMap = {}
    const freqMap = {}
    ;(purch || []).forEach(r => {
      purchMap[r.item_id] = (purchMap[r.item_id] || 0) + parseFloat(r.qty)
      freqMap[r.item_id] = (freqMap[r.item_id] || 0) + 1
    })
    setPurchases(purchMap)
    setPurchFreq(freqMap)

    // Returns map
    const retMap = {}
    ;(rets || []).forEach(r => { retMap[r.item_id] = (retMap[r.item_id] || 0) + parseFloat(r.qty) })
    setReturns(retMap)

    // Requisitioned map — qty issued via store requisitions
    const reqMap = {}
    ;(reqRes?.data || []).forEach(r => { reqMap[r.item_id] = (reqMap[r.item_id] || 0) + parseFloat(r.qty_issued || 0) })
    setRequisitioned(reqMap)

    try {
      await cacheStockData(periodId, { stockData: data, purchases: purchMap, returns: retMap, requisitioned: reqMap })
    } catch (_) {}
  }

  async function handlePeriodChange(periodId) {
    periodReq.begin(periodId)   // claim the page before any await
    const p = periods.find(x => x.id === periodId)
    setSelectedPeriod(p)
    if (!navigator.onLine) {
      const cached = await getCachedStockData(periodId)
      if (cached) {
        setStockData(cached.stockData    || {})
        setPurchases(cached.purchases    || {})
        setReturns(cached.returns        || {})
        setRequisitioned(cached.requisitioned || {})
      }
      return
    }
    await loadStockData(periodId, items)
  }

  function updateField(itemId, field, value) {
    setStockData(prev => ({ ...prev, [itemId]: { ...prev[itemId], [field]: value } }))
  }

  async function persistValueDirect(periodId, itemId, fieldKey, qty) {
    if (fieldKey === 'opening') {
      if (qty <= 0) {
        await supabase.from('opening_stock').delete().eq('period_id', periodId).eq('item_id', itemId)
      } else {
        await supabase.from('opening_stock').upsert({ period_id: periodId, item_id: itemId, qty }, { onConflict: 'period_id,item_id' })
      }
    }
    if (fieldKey === 'closing') {
      if (qty <= 0) {
        await supabase.from('closing_stock').delete().eq('period_id', periodId).eq('item_id', itemId)
      } else {
        await supabase.from('closing_stock').upsert({ period_id: periodId, item_id: itemId, physical_qty: qty, counted_at: new Date().toISOString() }, { onConflict: 'period_id,item_id' })
      }
    }
    if (fieldKey === 'wastage') {
      // Only the undated catch-all row — dated daily-wastage rows are managed in the Daily Wastage tab.
      await supabase.from('wastages').delete().eq('period_id', periodId).eq('item_id', itemId).is('bs_day', null)
      if (qty > 0) await supabase.from('wastages').insert({ period_id: periodId, item_id: itemId, qty, bs_day: null })
    }
    if (fieldKey === 'staff_meal') {
      await supabase.from('staff_meals').delete().eq('period_id', periodId).eq('item_id', itemId).eq('type', 'staff')
      if (qty > 0) await supabase.from('staff_meals').insert({ period_id: periodId, item_id: itemId, qty, type: 'staff' })
    }
  }

  // Wastage/staff-meal saves are delete()-then-insert() (two round trips, unlike opening/
  // closing's atomic upsert) — an onBlur autosave racing an immediate "Save All"/"Clear All"
  // click for the SAME item+field could otherwise interleave (both DELETEs land before either
  // INSERT), leaving two rows for that item+period and double-counting its cost downstream.
  // Serializing every persistValue call through a per-(item,field) promise chain means a second
  // call for the same key always waits for the first's round trip to fully finish before it
  // starts its own, so the two delete/insert pairs can never overlap.
  const persistLocks = useRef({})
  async function persistValue(itemId, fieldKey, qty) {
    const key = `${itemId}:${fieldKey}`
    const prior = persistLocks.current[key] || Promise.resolve()
    const run = prior.then(async () => {
      if (!navigator.onLine) {
        await enqueue({ periodId: selectedPeriod.id, itemId, fieldKey, qty })
        setPendingSync(prev => prev + 1)
        setPendingItems(prev => new Set([...prev, itemId]))
        return
      }
      await persistValueDirect(selectedPeriod.id, itemId, fieldKey, qty)
    }).catch(() => {}) // don't let one failed save wedge the chain for this key forever
    persistLocks.current[key] = run
    return run
  }

  async function flushQueue() {
    const queue = await getQueue()
    if (queue.length === 0) return
    setSyncing(true)
    let remaining = queue.length
    for (const item of queue) {
      try {
        await persistValueDirect(item.periodId, item.itemId, item.fieldKey, item.qty)
        await dequeue(item.id)
        remaining--
        setPendingSync(remaining)
        setPendingItems(prev => { const next = new Set(prev); next.delete(item.itemId); return next })
      } catch (_) {}
    }
    setSyncing(false)
  }

  flushRef.current = flushQueue

  // `overrideQty` exists for QtyInput's commit path: it hands us the evaluated number in the
  // same tick it calls updateField, so `stockData` read here would still hold the pre-commit
  // value. Save All passes nothing and reads state, which is correct for it.
  async function saveRow(itemId, overrideQty) {
    setSaving(prev => ({ ...prev, [itemId]: true }))
    const fieldKey = activeTab === 'opening' ? 'opening' : activeTab === 'closing' ? 'closing' : activeTab === 'staff_meal' ? 'staff_meal' : 'wastage'
    const source = overrideQty !== undefined ? overrideQty : (stockData[itemId] || {})[fieldKey]
    const qty = parseFloat(source) || 0
    await persistValue(itemId, fieldKey, qty)
    setSaving(prev => ({ ...prev, [itemId]: false }))
  }

  async function saveAll() {
    const visibleItems = filteredItems()

    // Same "used" calculation already driving the red highlight in the Summary tab — if it's
    // negative, more was used/wasted/counted-out than was ever bought or on hand, which is a real
    // data problem, not just a display quirk. Gated behind a client-level setting (off by default).
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
        alert(`Can't save — ${negativeItems.length} item(s) show negative usage (more used than was ever bought or on hand): ${names}.\n\nFix the counts before saving.`)
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
    if (entries.length === 0) return
    if (!navigator.onLine) {
      // Offline writes go to the local queue — per-item is fine there, no network involved.
      for (const e of entries) await persistValue(e.itemId, fieldKey, e.qty)
      return
    }
    const periodId = selectedPeriod.id
    const priors = entries.map(e => persistLocks.current[`${e.itemId}:${fieldKey}`] || Promise.resolve())
    const run = Promise.all(priors).then(async () => {
      const allIds = entries.map(e => e.itemId)
      const zeros = entries.filter(e => e.qty <= 0).map(e => e.itemId)
      const positives = entries.filter(e => e.qty > 0)
      if (fieldKey === 'opening') {
        if (zeros.length) await supabase.from('opening_stock').delete().eq('period_id', periodId).in('item_id', zeros)
        if (positives.length) await supabase.from('opening_stock').upsert(
          positives.map(e => ({ period_id: periodId, item_id: e.itemId, qty: e.qty })), { onConflict: 'period_id,item_id' })
      } else if (fieldKey === 'closing') {
        if (zeros.length) await supabase.from('closing_stock').delete().eq('period_id', periodId).in('item_id', zeros)
        if (positives.length) {
          const countedAt = new Date().toISOString()
          await supabase.from('closing_stock').upsert(
            positives.map(e => ({ period_id: periodId, item_id: e.itemId, physical_qty: e.qty, counted_at: countedAt })), { onConflict: 'period_id,item_id' })
        }
      } else if (fieldKey === 'wastage') {
        // Same shape as persistValueDirect: only the undated catch-all rows are this tab's to replace.
        await supabase.from('wastages').delete().eq('period_id', periodId).in('item_id', allIds).is('bs_day', null)
        if (positives.length) await supabase.from('wastages').insert(
          positives.map(e => ({ period_id: periodId, item_id: e.itemId, qty: e.qty, bs_day: null })))
      } else if (fieldKey === 'staff_meal') {
        await supabase.from('staff_meals').delete().eq('period_id', periodId).in('item_id', allIds).eq('type', 'staff')
        if (positives.length) await supabase.from('staff_meals').insert(
          positives.map(e => ({ period_id: periodId, item_id: e.itemId, qty: e.qty, type: 'staff' })))
      }
    }).catch(() => {}) // same policy as persistValue: a failed save must not wedge the chains
    entries.forEach(e => { persistLocks.current[`${e.itemId}:${fieldKey}`] = run })
    return run
  }

  async function performSaveAll(visibleItems) {
    setSaveAllLoading(true)
    const fieldKey = activeTab === 'opening' ? 'opening' : activeTab === 'closing' ? 'closing' : activeTab === 'staff_meal' ? 'staff_meal' : 'wastage'
    // Same source saveRow reads for Save All: current on-screen state, no override.
    const entries = visibleItems.map(item => ({
      itemId: item.id,
      qty: parseFloat((stockData[item.id] || {})[fieldKey]) || 0,
    }))
    await persistValuesBulk(fieldKey, entries)
    setSaveAllLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  // ── Daily wastage (dated, reason-tagged) ───────────────────────────────────
  async function addDailyWastage() {
    if (!selectedPeriod || !wEntry.item_id) return
    const qty = parseFloat(wEntry.qty) || 0
    if (qty <= 0) return
    setWBusy(true)
    await supabase.from('wastages').insert({
      period_id: selectedPeriod.id, item_id: wEntry.item_id, qty,
      bs_day: wDay, reason: wEntry.reason || 'Other',
    })
    setWEntry({ item_id: '', qty: '', reason: wEntry.reason })
    await loadStockData(selectedPeriod.id, items)
    setWBusy(false)
  }

  async function deleteDailyWastage(id) {
    if (!selectedPeriod) return
    setWBusy(true)
    await supabase.from('wastages').delete().eq('id', id)
    await loadStockData(selectedPeriod.id, items)
    setWBusy(false)
  }

  function clearAll() {
    const fieldKey = activeTab === 'opening' ? 'opening' : activeTab === 'closing' ? 'closing' : activeTab === 'staff_meal' ? 'staff_meal' : 'wastage'
    const label = TABS.find(t => t.id === activeTab)?.label || 'these'
    const visibleItems = filteredItems()
    setPendingConfirm({
      title: `Clear ${label} values`,
      confirmLabel: 'Clear All',
      danger: true,
      body: `Every entered ${label} value for the ${visibleItems.length} item(s) currently shown is set to 0 and saved. This cannot be undone.`,
      run: () => performClearAll(fieldKey, visibleItems),
    })
  }

  async function performClearAll(fieldKey, visibleItems) {
    setSaveAllLoading(true)
    await persistValuesBulk(fieldKey, visibleItems.map(item => ({ itemId: item.id, qty: 0 })))
    setStockData(prev => {
      const next = { ...prev }
      visibleItems.forEach(item => { next[item.id] = { ...next[item.id], [fieldKey]: 0 } })
      return next
    })
    setSaveAllLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
  }

  // Re-runnable version of Periods.js's close-time carry-forward: copies the chronologically
  // previous period's counted closing_stock into THIS period's opening_stock. Unlike the one-shot
  // snapshot at close time, this can be run whenever — after a late/edited closing count, or to
  // repair a period that was closed before the carry-forward feature existed (pre-2026-07-17).
  async function pullFromLastMonthClosing() {
    if (!selectedPeriod || isLocked) return
    if (!navigator.onLine) { alert('You need to be online to pull last month’s closing stock.'); return }
    const prevPeriod = periods
      .filter(p => p.bs_year < selectedPeriod.bs_year || (p.bs_year === selectedPeriod.bs_year && p.bs_month < selectedPeriod.bs_month))
      .sort((a, b) => (b.bs_year - a.bs_year) || (b.bs_month - a.bs_month))[0]
    if (!prevPeriod) { alert('No earlier period found to pull closing stock from.'); return }
    const prevLabel = `${BS_MONTHS[prevPeriod.bs_month - 1]} ${prevPeriod.bs_year}`
    setSaveAllLoading(true)
    const { data: closingRows } = await supabase.from('closing_stock')
      .select('item_id, physical_qty').eq('period_id', prevPeriod.id)
    const counted = (closingRows || []).filter(r => r.physical_qty != null && parseFloat(r.physical_qty) > 0)
    if (counted.length === 0) {
      setSaveAllLoading(false)
      alert(`${prevLabel} has no saved closing counts to pull.`)
      return
    }
    setSaveAllLoading(false)
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
    const rows = counted.map(r => ({ period_id: selectedPeriod.id, item_id: r.item_id, qty: r.physical_qty }))
    await supabase.from('opening_stock').upsert(rows, { onConflict: 'period_id,item_id' })
    setStockData(prev => {
      const next = { ...prev }
      counted.forEach(r => { next[r.item_id] = { ...next[r.item_id], opening: r.physical_qty } })
      return next
    })
    setSaveAllLoading(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2500)
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

  function countedItems(fk) {
    return filteredItems().filter(item => {
      const v = stockData[item.id]?.[fk]
      return v !== '' && parseFloat(v) > 0
    }).length
  }

  // PATCHED: subtract returns from used calculation
  function getUsed(itemId) {
    const row = stockData[itemId] || {}
    const opening = parseFloat(row.opening) || 0
    const purchased = parseFloat(purchases[itemId]) || 0
    const returned = parseFloat(returns[itemId]) || 0
    const closing = parseFloat(row.closing) || 0
    const wastage    = (parseFloat(row.wastage) || 0) + (parseFloat(dailyWastage[itemId]) || 0)
    const staffMeal  = parseFloat(row.staff_meal) || 0
    return opening + purchased - returned - closing - wastage - staffMeal
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
    const groups = [
      ...categories.map(c => ({ name: c.name, catItems: items.filter(i => i.category_id === c.id) })),
      { name: UNCATEGORISED, catItems: items.filter(i => !i.category_id || !knownCatIds.has(i.category_id)) },
    ]
    groups.forEach(({ name, catItems }) => {
      const openingVal   = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.opening) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const closingVal   = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.closing) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const purchasesVal = catItems.reduce((sum, i) => sum + (parseFloat(purchases[i.id]) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      // getUsed() subtracts vendor returns, so COGS below already nets them off — without this
      // column the row simply did not add up and an accountant could not reproduce the total.
      const returnsVal   = catItems.reduce((sum, i) => sum + (parseFloat(returns[i.id]) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const wastageVal    = catItems.reduce((sum, i) => sum + ((parseFloat(stockData[i.id]?.wastage) || 0) + (parseFloat(dailyWastage[i.id]) || 0)) * parseFloat(i.per_uom_rate || 0), 0)
      const staffMealsVal = catItems.reduce((sum, i) => sum + (parseFloat(stockData[i.id]?.staff_meal) || 0) * parseFloat(i.per_uom_rate || 0), 0)
      const cogsVal       = catItems.reduce((sum, i) => sum + getUsed(i.id) * parseFloat(i.per_uom_rate || 0), 0)
      byCategory[name] = { opening: openingVal, closing: closingVal, purchases: purchasesVal, returns: returnsVal, wastage: wastageVal, staffMeals: staffMealsVal, cogs: cogsVal }
    })
    return byCategory
  }

  async function exportExcel() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const rows = items.map(item => {
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
        'Purchase Value':    rate > 0 ? Math.round(purchQty * rate) : '',
        'Returned Qty':      retQty    || '',
        'Returns Value':     rate > 0 ? Math.round(retQty   * rate) : '',
        'Wastage Qty':       wastQty   || '',
        'Wastage Value':     rate > 0 ? Math.round(wastQty  * rate) : '',
        'Staff Meals Qty':   staffQty  || '',
        'Staff Meals Value': rate > 0 ? Math.round(staffQty * rate) : '',
        'Closing Qty':       closeQty  || '',
        'Closing Value':     rate > 0 ? Math.round(closeQty * rate) : '',
        'Used Qty':          usedQty   || '',
        'COGS (NPR)':        rate > 0 ? Math.round(usedQty  * rate) : '',
        'Requisitioned Qty': requisitioned[item.id] || '',
      }
    })
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Stock Register')
    XLSX.writeFile(wb, `Stock-Register-${selectedPeriod?.bs_year}-${selectedPeriod?.bs_month}.xlsx`)
  }

  const periodLabel = selectedPeriod ? `${BS_MONTHS[selectedPeriod.bs_month - 1]} ${selectedPeriod.bs_year}` : '—'
  const isLocked = !isAdmin && selectedPeriod?.status === 'closed'

  const TABS = [
    { id: 'opening',    label: 'Opening Stock', desc: 'Stock at start of month' },
    { id: 'closing',    label: 'Closing Stock', desc: 'Physical count at month end' },
    { id: 'wastage',    label: 'Wastage',       desc: 'Monthly catch-all total — quick single figure per item (daily detail goes in the Daily Wastage tab)' },
    { id: 'daily_wastage', label: 'Daily Wastage', desc: 'Log wastage by day with a reason — rolls into the period total and COGS' },
    ...(hasFeature('staff_meals') ? [{ id: 'staff_meal', label: 'Staff Meals', desc: 'Staff & complimentary consumption — tracked separately from wastage' }] : []),
    { id: 'summary',    label: 'Summary',       desc: 'Full picture per item' },
    { id: 'print',      label: 'Print Sheet',   desc: 'Physical count sheet for the floor' },
  ]

  // Floor tier, matching every other IMS page's guard (S417 convention). This page had none, so
  // the route was reachable by any account at an ims_enabled client regardless of ims_role.
  if (!hasImsAccess('staff')) return <Navigate to="/dashboard" replace />
  if (!loading && periods.length === 0) return <NoPeriodState what="stock count" />

  return (
    <div>
      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Stock Count</h1>
          <p className="page-subtitle">Opening stock, physical closing count & wastage — {periodLabel}</p>
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

      {isLocked && (
        <div style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red-text)' }}>
          🔒 <strong>This period is closed.</strong> Data is read-only. Contact your admin to re-open if needed.
        </div>
      )}

      {!isOnline && (
        <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-amber-text)' }}>
          <span>📵</span>
          <span><strong>Offline</strong> — entries are saved locally and will sync when you reconnect.</span>
          {pendingSync > 0 && <span style={{ marginLeft: 'auto', background: 'rgba(251,191,36,0.15)', borderRadius: 'var(--radius-lg)', padding: '2px 10px', fontWeight: 600 }}>{pendingSync} pending</span>}
        </div>
      )}
      {syncing && (
        <div style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 'var(--radius-sm)', padding: '10px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-green-text)' }}>
          ⟳ Syncing {pendingSync} {pendingSync === 1 ? 'entry' : 'entries'}…
        </div>
      )}

      {/* Seven tabs (eight with Staff Meals) in a row that had no flexWrap — the shape that hid
          ClientDrawer's last tab. .panel-tab-bar wraps instead, so "Print Sheet" cannot vanish. */}
      <div className="no-print panel-tab-bar" role="tablist" aria-label="Stock count sections">
        {TABS.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id}
            className={`panel-tab${activeTab === tab.id ? ' panel-tab--active' : ''}`}
            onClick={() => setActiveTab(tab.id)}>{tab.label}</button>
        ))}
      </div>

      {/* Summary Tab */}
      {activeTab === 'summary' && (
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
              const fmt = v => v.toLocaleString('en-NP', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
              const thStyle = { textAlign: 'right', whiteSpace: 'nowrap' }
              const tdStyle = (color) => ({ textAlign: 'right', color: color || 'var(--theme-text1)', whiteSpace: 'nowrap' })
              return (
                <div className="card" style={{ marginBottom: 24 }}>
                  {/* The sub-recipe disclosure exists for the accountant reconciling this page
                      against Monthly Summary: the two COGS figures differ by exactly the
                      sub-recipe amount, deliberately, and neither page said so before S575. */}
                  <p style={{ margin: '0 0 10px', fontSize: 11, color: 'var(--theme-text3)' }}>
                    These figures <strong>include sub-recipes</strong> — prep counted as stock. Monthly
                    Summary&apos;s COGS excludes them, so the two pages differ by exactly the sub-recipe
                    amount; both are correct for what they count.
                  </p>
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th style={{ width: 36, textAlign: 'center', color: 'var(--theme-text2)' }}>S.No</th>
                          <th><Tip text="All figures in NPR." width={140}>Category</Tip></th>
                          <th style={thStyle}>Opening Stock</th>
                          <th style={thStyle}><Tip text="Value of goods received via purchases this period. 'Production' = sub-recipes processed in-house from existing stock." width={280}>Purchase</Tip></th>
                          <th style={thStyle}><Tip text="Value of goods sent back to the vendor this period — a short delivery, a damaged crate, wrong item. Already netted off COGS." width={270}>Returns</Tip></th>
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
              )
            })()}

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-ghost" onClick={exportExcel}>Export Excel</button>
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
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Purchased quantity × per-unit purchase rate." width={220}>Purch. Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-red-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Wastage quantity × per-unit rate. NPR cost of goods recorded as waste." width={240}>Wastage Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-purple-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Staff meals quantity × per-unit rate. NPR cost of complimentary/staff consumption." width={260}>Staff Meals Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-green-text)', position: 'sticky', top: 0, zIndex: 2, background: 'var(--theme-card)' }}><Tip text="Closing (physical count) quantity × per-unit rate." width={220}>Close Value</Tip></th>
                    <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', borderLeft: '1px solid var(--theme-border)', position: 'sticky', top: 0, right: 0, zIndex: 4, background: 'var(--theme-card)' }}><Tip text={`Cost of Goods Sold = ${COGS_FORMULA}, in NPR.`} width={280}>COGS</Tip></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(item => {
                    const row      = stockData[item.id] || {}
                    const used     = getUsed(item.id)
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
                      ? `NPR ${Math.round(qty * rate).toLocaleString('en-NP')}`
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
                        <td style={{ fontWeight: hasData ? 600 : 400, color: hasData ? 'var(--theme-text1)' : 'var(--theme-text3)', position: 'sticky', left: 0, zIndex: 1, background: stickyBg }}>{item.name}</td>
                        <td><span className="badge badge-yellow">{item.categories?.name}</span></td>
                        <td style={{ color: 'var(--theme-text2)' }}>{item.uom}</td>
                        <td style={{ textAlign: 'right' }}>{row.opening !== '' ? Number(row.opening).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{purchQty > 0 ? dispPurch(purchQty, item) : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{returned > 0 ? `−${Number(returned).toLocaleString()}` : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{wastQty > 0 ? Number(wastQty).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-purple-text)' }}>{staffQty > 0 ? Number(staffQty).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{row.closing !== '' ? Number(row.closing).toLocaleString() : '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600, color: used < 0 ? 'var(--theme-red-text)' : 'var(--theme-text1)' }}>
                          {hasData ? Number(used).toLocaleString() : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                          {requisitioned[item.id] ? Number(requisitioned[item.id]).toLocaleString() : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-text3)', borderLeft: '1px solid var(--theme-border)' }}>{fmtVal(openQty)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>{fmtVal(purchQty)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{fmtVal(wastQty)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-purple-text)' }}>{fmtVal(staffQty)}</td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-green-text)' }}>{fmtVal(closeQty)}</td>
                        <td style={{ textAlign: 'right', fontWeight: hasData ? 700 : 400, color: used < 0 ? 'var(--theme-red-text)' : hasData ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', borderLeft: '1px solid var(--theme-border)', position: 'sticky', right: 0, zIndex: 1, background: stickyBg }}>
                          {hasData ? fmtVal(used) : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Print Sheet Tab */}
      {activeTab === 'print' && (
        <div>
          <div className="no-print" style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 12 }}>
              <input
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

          <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }} className="no-print">
            System Ref Qty = Opening Stock + Purchases − Returns recorded this period. ★ marks high-value, fast-moving items — count these first and double-check the figures.
          </div>

          <div className="card print-sheet">
            <div className="print-sheet-header">
              <h2 style={{ margin: '0 0 2px', fontSize: 18, color: 'var(--theme-text1)' }}>Physical Stock Count Sheet</h2>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>
                Period: {periodLabel} &nbsp;·&nbsp; Printed: {new Date().toLocaleDateString('en-GB')}
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
                        <th style={{ textAlign: 'right' }}><Tip text="Opening Stock + Purchases − Returns recorded this period. Use as a reference — your physical count may differ due to usage or shrinkage." width={250}>System Ref Qty</Tip></th>
                        <th style={{ textAlign: 'right' }}>Physical Count</th>
                      </tr>
                    </thead>
                    <tbody>
                      {catItems.map(item => (
                        <tr key={item.id}>
                          <td style={{ textAlign: 'center', color: 'var(--theme-accent-ink)' }}>{flagged.has(item.id) ? '★' : ''}</td>
                          <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{item.name}</td>
                          <td style={{ color: 'var(--theme-text2)' }}>{item.uom}</td>
                          <td style={{ textAlign: 'right' }}>{Number(getSystemRefQty(item.id)).toLocaleString()}</td>
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
        const fmtNpr = n => `NPR ${Math.round(n).toLocaleString('en-NP')}`
        return (
          <div>
            <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
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
                    <Tip text="Why the stock was lost. Used to group wastage by cause in the Wastage Report." width={240}>Reason</Tip>
                  </label>
                  <select id="stock-f3" style={{ ...winp, width: '100%' }} value={wEntry.reason} onChange={e => setWEntry(w => ({ ...w, reason: e.target.value }))}>
                    {WASTAGE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
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
                        <td><span className="badge badge-yellow">{r.reason || 'Other'}</span></td>
                        <td style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>{Number(r.qty).toLocaleString()} {r.items?.uom || ''}</td>
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
                        <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-red-text)', paddingTop: 12 }}>{Number(dayQty).toLocaleString()}</td>
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
                  <button key={d} onClick={() => setWDay(d)} className="btn btn-ghost" style={{ fontSize: 11, padding: '5px 10px', borderColor: d === wDay ? 'rgba(201,168,76,0.5)' : 'var(--theme-border)', color: d === wDay ? 'var(--theme-accent-ink)' : 'var(--theme-text3)' }}>
                    Day {d} · {fmtNpr(perDay[d])}
                  </button>
                ))}
              </div>
            )}
          </div>
        )
      })()}

      {activeTab !== 'summary' && activeTab !== 'print' && activeTab !== 'daily_wastage' && (() => {
        const fieldKey = activeTab === 'opening' ? 'opening' : activeTab === 'closing' ? 'closing' : activeTab === 'staff_meal' ? 'staff_meal' : 'wastage'
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
            <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 20, fontSize: 13, color: 'var(--theme-accent-ink)' }}>
              {TABS.find(t => t.id === activeTab)?.desc} — enter quantities in the item's UOM, then click Save All.
            </div>

            {isMobile ? (
              <div style={{ marginBottom: 12 }}>
                <input
                  style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: '100%', marginBottom: 10 }}
                  placeholder="Search items…" value={search} onChange={e => setSearch(e.target.value)}
                />
                <div className="mobile-cat-strip">
                  <button className={`mobile-cat-btn${filterCat === 'all' ? ' active' : ''}`} onClick={() => setFilterCat('all')}>All</button>
                  {categories.map(c => (
                    <button key={c.id} className={`mobile-cat-btn${filterCat === c.id ? ' active' : ''}`} onClick={() => setFilterCat(c.id)}>{c.name}</button>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  <input
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
                        style={{ color: 'var(--theme-accent-ink)', borderColor: 'rgba(201,168,76,0.35)' }}
                        onClick={pullFromLastMonthClosing}
                        disabled={saveAllLoading || isLocked}
                      >
                        ↩ Pull from last month
                      </button>
                    )}
                    <button className="btn btn-ghost" style={{ color: 'var(--theme-red-text)', borderColor: 'rgba(248,113,113,0.3)' }} onClick={clearAll} disabled={saveAllLoading || isLocked}>Clear All</button>
                  </div>
                  <button className="btn btn-primary" onClick={saveAll} disabled={saveAllLoading || isLocked}>
                    {saveAllLoading ? 'Saving…' : saved ? '✓ Saved' : 'Save All'}
                  </button>
                </div>
              </div>
            )}

            {isMobile && (
              <div className="mobile-progress">
                <div className="mobile-progress-bar" style={{ width: `${pct}%` }} />
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
                  return (
                    <div key={item.id} className={`mobile-stock-card${val > 0 ? ' has-value' : ''}${pendingItems.has(item.id) ? ' pending' : ''}`}>
                      <div className="mobile-stock-card-header">
                        <span className="mobile-stock-item-name">{item.name}</span>
                        <span className="badge badge-yellow">{item.categories?.name}</span>
                      </div>
                      <div className="mobile-stock-card-meta">
                        <span className="mobile-stock-uom">{item.uom}</span>
                        {purchases[item.id] > 0 && (
                          <span className="mobile-stock-ref">Purchased: {dispPurch(Number(purchases[item.id]), item)}</span>
                        )}
                        {returned > 0 && (
                          <span className="mobile-stock-ref" style={{ color: 'var(--theme-red-text)' }}>Returned: −{Number(returned).toLocaleString()}</span>
                        )}
                      </div>
                      <div className="mobile-stock-card-input-row">
                        <QtyInput
                          value={val}
                          onChange={v => updateField(item.id, fieldKey, v)}
                          onCommit={v => saveRow(item.id, v)}
                          placeholder="0"
                          disabled={isLocked}
                          className="mobile-stock-input"
                          wrapperStyle={{ flex: 1, minWidth: 0 }}
                        />
                        <span className="mobile-stock-unit">{item.uom}</span>
                        {lineValue != null && (
                          <span className="mobile-stock-value">NPR {lineValue.toLocaleString('en-NP')}</span>
                        )}
                        {saving[item.id] && <span style={{ fontSize: 11, color: 'var(--theme-text2)' }}>…</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 14px', marginTop: 10, background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', fontWeight: 700 }}>
                <span style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Total — {visible.length} item{visible.length !== 1 ? 's' : ''}</span>
                <span style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                  <span style={{ color: 'var(--theme-text1)', fontSize: 13 }}>{totalQty > 0 ? Number(totalQty).toLocaleString() : '—'}</span>
                  <span style={{ color: 'var(--theme-accent-ink)', fontSize: 14 }}>{totalValue > 0 ? `NPR ${Math.round(totalValue).toLocaleString('en-NP')}` : '—'}</span>
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
                          <th style={{ textAlign: 'right' }}>Purchased</th>
                          <th style={{ textAlign: 'right', color: 'var(--theme-red-text)' }}>Returned</th>
                          <th style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                            <Tip text="Qty entered × unit rate (per_uom_rate). Gives the NPR value of this item's stock entry." width={220}>Value (NPR)</Tip>
                          </th>
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
                              <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{item.name}</td>
                              <td><span className="badge badge-yellow">{item.categories?.name}</span></td>
                              <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>{item.uom}</td>
                              <td style={{ textAlign: 'right', width: 140 }}>
                                <QtyInput
                                  value={val}
                                  onChange={v => updateField(item.id, fieldKey, v)}
                                  onCommit={v => saveRow(item.id, v)}
                                  placeholder="0"
                                  disabled={isLocked}
                                  wrapperStyle={{ width: 110 }}
                                  style={{
                                    background: 'var(--theme-bg)', border: '1px solid var(--theme-border)',
                                    borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: 13,
                                    color: 'var(--theme-text1)', outline: 'none', width: '100%',
                                    textAlign: 'right', fontFamily: 'inherit', boxSizing: 'border-box',
                                    borderColor: val > 0 ? 'rgba(201,168,76,0.4)' : 'var(--theme-border)'
                                  }}
                                />
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--theme-text2)', fontSize: 13 }}>
                                {purchases[item.id] ? `${Number(purchases[item.id]).toLocaleString()} ${item.uom}` : '—'}
                              </td>
                              <td style={{ textAlign: 'right', color: returned > 0 ? 'var(--theme-red-text)' : 'var(--theme-text3)', fontSize: 13 }}>
                                {returned > 0 ? `−${Number(returned).toLocaleString()} ${item.uom}` : '—'}
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)', fontSize: 13, fontWeight: lineValue ? 600 : 400 }}>
                                {lineValue != null ? `NPR ${lineValue.toLocaleString('en-NP')}` : '—'}
                              </td>
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
                            {totalQty > 0 ? Number(totalQty).toLocaleString() : '—'}
                          </td>
                          <td colSpan={2}></td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent-ink)', fontSize: 14, paddingTop: 12 }}>
                            {totalValue > 0 ? `NPR ${Math.round(totalValue).toLocaleString('en-NP')}` : '—'}
                          </td>
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
                  <button className="btn btn-ghost" style={{ flex: 1, color: 'var(--theme-accent-ink)', borderColor: 'rgba(201,168,76,0.35)' }} onClick={pullFromLastMonthClosing} disabled={saveAllLoading || isLocked}>
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
    </div>
  )
}
