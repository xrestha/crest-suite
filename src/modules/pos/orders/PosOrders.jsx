import { useState, useEffect, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import QRCode from 'qrcode'
import { adToBs, BS_MONTHS, getBsToday, getBsFiscalYear } from '../../../utils/bsCalendar'
import { numberToWordsNpr } from '../../../utils/numberToWords'
import { computeRecipeCosts, explodeRecipeIngredients } from '../../../utils/recipeCost'
import { buildDynamicQr } from '../../../utils/emvQr'
import { computeOrderAmounts } from '../../../utils/posBillingMath'
import IssueCreditNoteModal from '../creditnotes/IssueCreditNoteModal'
import {
  cachePosMenu, getCachedPosMenu, cachePosTables, getCachedPosTables,
  cachePosSettings, getCachedPosSettings, cachePosOrderForTable, getCachedPosOrderForTable,
  enqueuePosOrder, getPosOrderQueue, getQueuedPosOrder, dequeuePosOrder,
} from '../../../utils/offlineQueue'

const vatOf  = r => (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
// Shared shape for a pos_order_items row, whether it's about to go straight to Supabase or into
// the offline queue (enqueuePosOrder) — keeps the two write paths from drifting apart.
const toItemPayload = i => ({
  recipe_id:   i.recipe_id || null,
  name:        i.name,
  category:    i.category   || 'Other',
  qty:         i.qty,
  unit_price:  i.unit_price,
  vat_rate:    i.vat_rate   ?? 0,
  sent_to_kot: i.sent_to_kot || false,
  notes:       i.notes || null,
})
// Only these payment methods are scanned by the customer — Cash/Card/Credit already have their
// own settlement path, so a "scan to pay" QR on the bill would be irrelevant or misleading there.
const QR_PAY_METHODS = ['eSewa', 'Khalti', 'FonePay']

const STATUS_BADGE = { available: 'badge-green', occupied: 'badge-red', reserved: 'badge-amber', inactive: 'badge-gray' }
const STATUS_LABEL = { available: 'Available', occupied: 'Occupied', reserved: 'Reserved', inactive: 'Inactive' }

const PAYMENT_METHODS = ['Cash', 'Card', 'eSewa', 'Khalti', 'FonePay']
const VOID_REASONS    = ['Wrong table', 'Duplicate order', 'Test order', 'Order entry mistake', 'Other']
const COMP_REASONS    = ['Walkout / unpaid', 'Customer goodwill', 'Customer complaint', 'Staff error', 'Owners', 'Company Guest', 'Other']
const DEFAULT_DISCOUNT_REASONS = ['Loyalty customer', 'Promo / coupon code', 'Manager goodwill', 'Bulk / corporate order', 'Price match', 'Other']
const COPY_LABEL      = n => n <= 1 ? 'ORIGINAL-COPY' : n === 2 ? 'SECOND-COPY' : n === 3 ? 'THIRD-COPY' : `REPRINT #${n}`

const btnSm = {
  width: 26, height: 26, borderRadius: 4,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-input-bg)',
  color: 'var(--theme-text1)',
  cursor: 'pointer', fontSize: 16, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
}

const billInput = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
  borderRadius: 6, padding: '7px 10px', fontSize: 13,
  color: 'var(--theme-text1)', outline: 'none',
}

export default function PosOrders() {
  const { clientId, profile, hasPosAccess, isAdmin, isOwner } = useAuth()

  /* ── view ── */
  const [view, setView] = useState('floor')

  /* ── floor ── */
  const [tables,      setTables]      = useState([])
  const [tableOrders, setTableOrders] = useState({})
  const [secFilter,   setSecFilter]   = useState('All')
  const [floorLoad,   setFloorLoad]   = useState(true)

  /* ── covers modal ── */
  const [coversModal,      setCoversModal]      = useState(false)
  const [pendingTable,     setPendingTable]      = useState(null)
  const [pendingCoversStr, setPendingCoversStr]  = useState('')

  /* ── order screen ── */
  const [activeTable, setActiveTable] = useState(null)
  const [orderId,     setOrderId]     = useState(null)
  const [orderNo,     setOrderNo]     = useState(null) // per-client sequential, assigned by DB trigger on insert
  // orderItems: { id?, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot }
  const [orderItems,  setOrderItems]  = useState([])
  const [covers,      setCovers]      = useState(1)
  const [menu,        setMenu]        = useState([])
  const [menuLoaded,  setMenuLoaded]  = useState(false)
  const [catTab,      setCatTab]      = useState('All')
  const [menuSearch,  setMenuSearch]  = useState('')
  const [saving,      setSaving]      = useState(false)
  const [msg,         setMsg]         = useState('')
  // categories that route to BOT — loaded from settings, default to ['Beverage']
  const [botCategories, setBotCategories] = useState(new Set(['Beverage']))
  const [outletName,    setOutletName]    = useState('')
  const [notePresets,   setNotePresets]   = useState([])
  const [noteFocusIdx,  setNoteFocusIdx]  = useState(null)
  // ME-driven suggestion chips
  const [suggestions,       setSuggestions]       = useState([])
  const [manualSuggestions, setManualSuggestions] = useState({}) // { recipeId: [suggestedRecipeId] }

  /* ── billing / invoice settings (loaded once per client) ── */
  const [billingSettings, setBillingSettings] = useState({
    is_vat_registered: true, invoice_prefix: '', vat_number: '', property_address: '', property_phone: '', payment_qr_data: '',
  })

  /* ── Billing modal ── */
  const [billingOpen, setBillingOpen] = useState(false)
  const [billingTab,  setBillingTab]  = useState('pay') // 'pay' | 'void' | 'writeoff'
  const [payMethod,   setPayMethod]   = useState('Cash')
  const [tenderedStr, setTenderedStr] = useState('')
  const [closeReason, setCloseReason] = useState('')
  const [buyerName,    setBuyerName]    = useState('')
  const [buyerAddress, setBuyerAddress] = useState('')
  const [buyerPan,     setBuyerPan]     = useState('')
  const [buyerPhone,   setBuyerPhone]   = useState('')
  const [billRemarks,  setBillRemarks]  = useState('')
  const [closing,     setClosing]     = useState(false)
  const [closeMsg,    setCloseMsg]    = useState('')
  const [compCostMap, setCompCostMap] = useState({}) // { recipeId: foodCostPerPortion } — fetched when Complimentary tab opens
  const [discountMode,    setDiscountMode]    = useState('amount') // 'amount' | 'percent'
  const [discountStr,     setDiscountStr]     = useState('')
  const [discountReason,  setDiscountReason]  = useState('')
  const [discountReasons, setDiscountReasons] = useState(DEFAULT_DISCOUNT_REASONS)
  const [hscMap,      setHscMap]      = useState({}) // { recipeId: hscCode } — fetched once when Billing modal opens
  const [openShiftId, setOpenShiftId] = useState(null) // cached, not queried per-close — see loadOpenShift()
  const [billQrUrl,   setBillQrUrl]   = useState('')   // per-bill dynamic payment QR (data URL), regenerated as the total changes

  // Split payment — multiple tenders collected against one order/one invoice (not a split bill;
  // see [[Split Payment (multi-tender) for POS Charge]] plan). tenders: [{ method, amount, tenderedAmount }]
  const [splitMode,    setSplitMode]    = useState(false)
  const [tenders,       setTenders]     = useState([])
  const [tenderMethod, setTenderMethod] = useState('Cash')
  const [tenderAmtStr, setTenderAmtStr] = useState('')

  /* ── Recent Bills / Reprint ── */
  const [recentBillsOpen, setRecentBillsOpen] = useState(false)
  const [recentBills,     setRecentBills]     = useState([])
  const [recentBillsLoad, setRecentBillsLoad] = useState(false)
  const [creditNoteOrder, setCreditNoteOrder] = useState(null) // order row currently in the Issue Credit Note modal

  /* ── offline mode (Order Taking only — Billing stays online-only, see closeOrder/openBilling gates) ── */
  const [isOnline,        setIsOnline]        = useState(() => navigator.onLine)
  const [pendingOrderIds, setPendingOrderIds] = useState(new Set()) // order ids currently queued, not yet synced
  const [syncingOffline,  setSyncingOffline]  = useState(false)
  const [conflictOrders,  setConflictOrders]  = useState([]) // queued orders whose server row was no longer 'open' at flush time
  const [floorMsg,        setFloorMsg]        = useState('') // transient floor-view banner (e.g. blocked-table message)
  const flushRef = useRef(null)

  useEffect(() => {
    if (!clientId) return
    loadFloor()
    if (!navigator.onLine) {
      getCachedPosSettings(clientId).then(data => {
        if (!data) return
        const arr = data.pos_bot_categories
        if (arr?.length) setBotCategories(new Set(arr))
        setNotePresets(data.pos_note_presets || [])
        setDiscountReasons(data.pos_discount_reasons?.length ? data.pos_discount_reasons : DEFAULT_DISCOUNT_REASONS)
        setBillingSettings({
          is_vat_registered: data.is_vat_registered ?? true,
          invoice_prefix:    data.invoice_prefix || '',
          vat_number:        data.vat_number || '',
          property_address:  data.property_address || '',
          property_phone:    data.property_phone || '',
          payment_qr_data:   data.payment_qr_data || '',
        })
        setOutletName(data.outlet_name || '')
      })
    } else {
      Promise.all([
        supabase.from('settings')
          .select('pos_bot_categories, pos_note_presets, pos_discount_reasons, is_vat_registered, invoice_prefix, vat_number, property_address, property_phone, payment_qr_data')
          .eq('client_id', clientId).maybeSingle(),
        supabase.from('clients').select('name').eq('id', clientId).single(),
      ]).then(([{ data }, { data: clientData }]) => {
        const arr = data?.pos_bot_categories
        if (arr?.length) setBotCategories(new Set(arr))
        setNotePresets(data?.pos_note_presets || [])
        setDiscountReasons(data?.pos_discount_reasons?.length ? data.pos_discount_reasons : DEFAULT_DISCOUNT_REASONS)
        setBillingSettings({
          is_vat_registered: data?.is_vat_registered ?? true,
          invoice_prefix:    data?.invoice_prefix || '',
          vat_number:        data?.vat_number || '',
          property_address:  data?.property_address || '',
          property_phone:    data?.property_phone || '',
          payment_qr_data:   data?.payment_qr_data || '',
        })
        setOutletName(clientData?.name || '')
        cachePosSettings(clientId, { ...data, outlet_name: clientData?.name || '' })
      })
    }
    if (navigator.onLine) flushRef.current?.()
  }, [clientId]) // eslint-disable-line

  useEffect(() => {
    const up   = () => { setIsOnline(true);  flushRef.current?.() }
    const down = () => setIsOnline(false)
    window.addEventListener('online',  up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])

  /* ── computed totals ── */
  // Non-VAT-registered clients print a plain PAN Bill with no VAT line (see buildBillHtml's
  // `vatReg` gate) — the live cart/payment totals must honor the same flag, or the amount
  // charged/tendered on screen drifts from the amount on the printed bill.
  const vatReg   = billingSettings.is_vat_registered
  const subEx    = orderItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const vatAmt   = vatReg ? orderItems.reduce((s, i) => s + i.qty * i.unit_price * (i.vat_rate ?? 0), 0) : 0
  const total    = Math.round(subEx + vatAmt) // rounded to the nearest rupee — matches the bill's Net Amount/Round Off line
  const compTotal = orderItems.reduce((s, i) => s + i.qty * (compCostMap[i.recipe_id] || 0), 0)

  // Discount reduces the pre-VAT taxable base, then VAT is recalculated on the discounted amount
  // (same rule as purchase_entries.discount_amount in Purchases.js) — not a flat subtraction off total.
  const discountAmt = (() => {
    const v = parseFloat(discountStr) || 0
    if (v <= 0 || subEx <= 0) return 0
    return discountMode === 'percent' ? Math.min(subEx, subEx * v / 100) : Math.min(subEx, v)
  })()
  const discRatio = subEx > 0 ? discountAmt / subEx : 0
  const payVatAmt = vatAmt * (1 - discRatio)
  const payTotal  = Math.round(subEx - discountAmt + payVatAmt)
  // Buyer Name + Phone become compulsory (not just optional) whenever a discount is applied, or
  // when the bill is going on Credit — both cases need an identifiable, audited record.
  const requireBuyerId = discountAmt > 0 || payMethod === 'Credit'

  // Split payment — running total of tenders collected so far against payTotal, and what's left.
  const tendersTotal = tenders.reduce((s, t) => s + t.amount, 0)
  const remaining     = Math.max(0, payTotal - tendersTotal)

  // Regenerate the dynamic payment QR as the payable amount changes (discount typed, items
  // edited) — the modal QR and print preview always encode the exact current amount. In split
  // mode this targets whatever the next tender's amount is (defaulting to the remaining balance),
  // not the full order total. makeBillQr is a hoisted function declaration, so calling it from
  // here is safe even though it appears later in the file.
  useEffect(() => {
    if (!billingOpen) { setBillQrUrl(''); return }
    const qrMethod = splitMode ? tenderMethod : payMethod
    const qrAmount = splitMode ? (parseFloat(tenderAmtStr) || remaining) : payTotal
    if (!QR_PAY_METHODS.includes(qrMethod) || !billingSettings.payment_qr_data || !(qrAmount > 0)) { setBillQrUrl(''); return }
    let cancelled = false
    makeBillQr(qrAmount).then(url => { if (!cancelled) setBillQrUrl(url) })
    return () => { cancelled = true }
  }, [billingOpen, splitMode, payMethod, tenderMethod, tenderAmtStr, remaining, payTotal, billingSettings.payment_qr_data]) // eslint-disable-line

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  /* ── data loaders ── */

  // Turns a queued (not-yet-synced) offline order into the same shape as a live floor overlay
  // entry, so the floor grid renders identically whether the count comes from the server or the
  // local queue. Flagged `offlinePending` so the tile can show the "unsynced" dot.
  function queuedOrderToOverlay(q) {
    return {
      orderId:   q.order_id,
      itemCount: q.items.reduce((s, i) => s + i.qty, 0),
      total:     q.items.reduce((s, i) => s + i.qty * i.unit_price * (1 + (vatReg ? (i.vat_rate ?? 0) : 0)), 0),
      covers:    q.covers,
      pending:   q.items.filter(i => !i.sent_to_kot).length,
      offlinePending: true,
    }
  }

  async function loadFloor() {
    setFloorLoad(true)

    if (!navigator.onLine) {
      const [cachedTables, queue] = await Promise.all([getCachedPosTables(clientId), getPosOrderQueue()])
      setTables(cachedTables || [])
      const map = {}
      for (const q of queue) { if (q.table_id) map[q.table_id] = queuedOrderToOverlay(q) }
      setTableOrders(map)
      setPendingOrderIds(new Set(queue.map(q => q.order_id)))
      setFloorLoad(false)
      return
    }

    loadOpenShift()
    const [{ data: tbls }, { data: orders }] = await Promise.all([
      supabase.from('pos_tables').select('*').eq('client_id', clientId)
        .order('sort_order').order('name'),
      supabase.from('pos_orders')
        .select('id, table_id, covers, pos_order_items(qty, unit_price, vat_rate, sent_to_kot)')
        .eq('client_id', clientId).eq('status', 'open'),
    ])
    setTables(tbls || [])
    cachePosTables(clientId, tbls || [])
    const map = {}
    for (const o of (orders || [])) {
      if (!o.table_id) continue
      const items = o.pos_order_items || []
      map[o.table_id] = {
        orderId:   o.id,
        itemCount: items.reduce((s, i) => s + i.qty, 0),
        total:     items.reduce((s, i) => s + i.qty * i.unit_price * (1 + (vatReg ? (i.vat_rate ?? 0) : 0)), 0),
        covers:    o.covers,
        pending:   items.filter(i => !i.sent_to_kot).length,
      }
    }
    // Layer any still-queued (not-yet-synced) local edits on top of server truth, so a table
    // doesn't briefly look wrong while a reconnect flush is still in flight.
    const queue = await getPosOrderQueue()
    for (const q of queue) { if (q.table_id) map[q.table_id] = queuedOrderToOverlay(q) }
    setTableOrders(map)
    setPendingOrderIds(new Set(queue.map(q => q.order_id)))
    setFloorLoad(false)
  }

  // Replays every queued offline order against Supabase, one at a time (structurally identical to
  // Stock.js's flushQueue — swallow-and-retry-later on failure, never dequeue on error). Runs on
  // reconnect (window 'online' event, via flushRef below) and once on mount if already online.
  async function flushPosOrderQueue() {
    const queue = await getPosOrderQueue()
    if (queue.length === 0) return
    setSyncingOffline(true)
    for (const q of queue) {
      try {
        const oid = q.order_id
        if (q.created_offline) {
          const { error } = await supabase.from('pos_orders').insert({
            id: oid, client_id: clientId, table_id: q.table_id, table_name: q.table_name,
            status: 'open', covers: q.covers, opened_by: q.opened_by,
          })
          if (error) throw error
          if (q.table_id) await supabase.from('pos_tables').update({ status: 'occupied' }).eq('id', q.table_id)
        } else {
          // Safety check: don't blindly overwrite an order another device already closed while
          // this one was offline — a queued item replace on a billed/voided order would be wrong.
          const { data: current } = await supabase.from('pos_orders').select('status').eq('id', oid).single()
          if (current && current.status !== 'open') {
            setConflictOrders(prev => prev.some(c => c.order_id === oid) ? prev : [...prev, q])
            continue // stays queued — surfaced for manual review, not auto-discarded
          }
          await supabase.from('pos_orders').update({ covers: q.covers }).eq('id', oid)
        }

        await supabase.from('pos_order_items').delete().eq('order_id', oid)
        await supabase.from('pos_order_items').insert(q.items.map(i => ({ order_id: oid, client_id: clientId, ...i })))

        for (const send of q.kot_sends || []) {
          try { await supabase.from('pos_kot_log').insert({ ...send, order_id: oid }) } catch (_) { /* best-effort, matches online logKotSend */ }
        }

        await dequeuePosOrder(oid)
        setPendingOrderIds(prev => { const next = new Set(prev); next.delete(oid); return next })

        // If the order currently open on screen just got synced, backfill its real order number.
        if (orderId === oid) {
          const { data: synced } = await supabase.from('pos_orders').select('order_no').eq('id', oid).single()
          if (synced) setOrderNo(synced.order_no)
        }
      } catch (err) {
        console.error('POS offline order sync failed, will retry:', err) // left queued, retried next flush
      }
    }
    setSyncingOffline(false)
    loadFloor()
  }
  flushRef.current = flushPosOrderQueue

  function discardConflictOrder(orderIdToDiscard) {
    dequeuePosOrder(orderIdToDiscard)
    setConflictOrders(prev => prev.filter(c => c.order_id !== orderIdToDiscard))
    setPendingOrderIds(prev => { const next = new Set(prev); next.delete(orderIdToDiscard); return next })
  }

  // Cached, not re-queried per order close — closeOrder() just reads this synchronously.
  // Re-fetched here (loadFloor runs after every close) so it self-heals within seconds if a
  // shift opens/closes elsewhere; a brief staleness window is fine since shift linkage is
  // informational only, never a gate on billing.
  async function loadOpenShift() {
    const { data } = await supabase.from('pos_shifts').select('id')
      .eq('client_id', clientId).eq('status', 'open').maybeSingle()
    setOpenShiftId(data?.id || null)
  }

  async function loadMenu() {
    if (!clientId || menuLoaded) return

    if (!navigator.onLine) {
      const cached = await getCachedPosMenu(clientId)
      if (cached) {
        setMenu(cached.menu || [])
        setManualSuggestions(cached.manualSuggestions || {})
        setMenuLoaded(true)
      }
      return
    }

    const [{ data }, { data: suggData }] = await Promise.all([
      supabase
        .from('recipes')
        .select('id, name, category, selling_price, vat_rate, me_class')
        .eq('client_id', clientId)
        .eq('is_active', true)
        .eq('pos_enabled', true)
        .neq('category', 'Sub-Recipe')
        .order('name'),
      supabase
        .from('recipe_suggestions')
        .select('recipe_id, suggest_recipe_id')
        .eq('client_id', clientId),
    ])
    setMenu(data || [])
    let suggMap = {}
    if (suggData) {
      suggData.forEach(s => {
        if (!suggMap[s.recipe_id]) suggMap[s.recipe_id] = []
        suggMap[s.recipe_id].push(s.suggest_recipe_id)
      })
      setManualSuggestions(suggMap)
    }
    setMenuLoaded(true)
    cachePosMenu(clientId, data || [], suggMap)
  }

  async function openTable(table) {
    setFloorMsg('')

    if (!navigator.onLine) {
      // A table this device already touched offline is the source of truth — use the queue.
      const queue = await getPosOrderQueue()
      const queued = queue.find(q => q.table_id === table.id)
      if (queued) {
        setActiveTable(table)
        setOrderId(queued.order_id)
        setOrderNo(null) // real order_no assigned on sync
        setCovers(queued.covers || 1)
        setOrderItems(queued.items.map(i => ({ ...i, sent_qty: i.sent_to_kot ? i.qty : 0 })))
        setMsg(''); setView('order'); loadMenu()
        return
      }
      // Otherwise fall back to the last-known-good snapshot from an earlier online visit.
      const cached = await getCachedPosOrderForTable(table.id)
      if (cached) {
        setActiveTable(table)
        setOrderId(cached.orderId)
        setOrderNo(cached.orderNo || null)
        setCovers(cached.covers || 1)
        setOrderItems((cached.items || []).map(i => ({ ...i, sent_qty: i.sent_to_kot ? i.qty : 0 })))
        setMsg(''); setView('order'); loadMenu()
        return
      }
      // The table has an order per the last-synced table list, but this device never loaded its
      // items — block rather than risk a full item replace that silently deletes what's really there.
      if (table.status === 'occupied' || table.status === 'reserved') {
        setFloorMsg(`error:${table.name} has an order that hasn't been loaded on this device yet — reconnect to open it.`)
        return
      }
      // No known order on this table — safe to start fresh, same as the online empty-table path.
      setPendingTable(table)
      setPendingCoversStr('')
      setCoversModal(true)
      loadMenu()
      return
    }

    const { data: existing } = await supabase
      .from('pos_orders')
      .select('id, order_no, covers, pos_order_items(id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot, notes)')
      .eq('client_id', clientId)
      .eq('status', 'open')
      .eq('table_id', table.id)
      .maybeSingle()

    if (existing) {
      setActiveTable(table)
      setOrderId(existing.id)
      setOrderNo(existing.order_no || null)
      setCovers(existing.covers || 1)
      const items = (existing.pos_order_items || []).map(i => ({
        ...i,
        sent_qty: i.sent_to_kot ? i.qty : 0,
      }))
      setOrderItems(items)
      cachePosOrderForTable(table.id, { orderId: existing.id, orderNo: existing.order_no || null, covers: existing.covers || 1, items })
      setMsg(''); setView('order'); loadMenu()
    } else {
      setPendingTable(table)
      setPendingCoversStr('')
      setCoversModal(true)
      loadMenu()
    }
  }

  function numpadPress(d) {
    setPendingCoversStr(prev => {
      const next = prev + d
      return parseInt(next) > 99 ? prev : next.replace(/^0+(\d)/, '$1')
    })
  }
  function numpadBackspace() { setPendingCoversStr(prev => prev.slice(0, -1)) }
  function numpadClear()     { setPendingCoversStr('') }

  function confirmCovers() {
    const n = Math.max(1, parseInt(pendingCoversStr) || 1)
    setActiveTable(pendingTable)
    setOrderId(null); setOrderNo(null); setOrderItems([])
    setCovers(n)
    setMsg(''); setCoversModal(false); setPendingTable(null)
    setView('order')
  }

  function openTakeaway() {
    setActiveTable(null); setOrderId(null); setOrderNo(null); setCovers(1); setOrderItems([])
    setMsg(''); setView('order'); loadMenu()
  }

  /* ── order item helpers ── */

  function addItem(recipe) {
    const vat = vatReg ? vatOf(recipe) : 0
    setOrderItems(prev => {
      const idx = prev.findIndex(i => i.recipe_id === recipe.id)
      if (idx >= 0) {
        return prev.map((item, n) => n === idx
          ? {
              ...item,
              qty:         item.qty + 1,
              sent_to_kot: false,
              // capture how many were already sent so we can show the +delta
              sent_qty: item.sent_to_kot ? item.qty : (item.sent_qty || 0),
            }
          : item)
      }
      return [...prev, {
        recipe_id:   recipe.id,
        name:        recipe.name,
        category:    recipe.category || 'Other',
        qty:         1,
        unit_price:  parseFloat(recipe.selling_price) || 0,
        vat_rate:    vat,
        sent_to_kot: false,
        sent_qty:    0,
        notes:       '',
      }]
    })
    setMsg('')
    computeSuggestions(recipe)
  }

  async function computeSuggestions(recipe) {
    const currentIds  = new Set([...orderItems.map(i => i.recipe_id), recipe.id])
    const hasMeData   = menu.some(r => r.me_class)
    const isPlowhouse = recipe.me_class === 'plowhouse'
    const triggerCat  = recipe.category || 'Other'
    const manualIds   = new Set(manualSuggestions[recipe.id] || [])

    function calcScore(r, coMap = {}, maxCo = 0) {
      if (manualIds.has(r.id)) return 100
      let s = 0
      if (hasMeData) {
        s = r.me_class === 'star' ? 10 : r.me_class === 'puzzle' ? 6 : 2
        if (r.category !== triggerCat) s += 3
        if (isPlowhouse && r.category === triggerCat) s -= 4
      }
      if (coMap[r.id] && maxCo > 0) s += (coMap[r.id] / maxCo) * 5
      return s
    }

    function rank(coMap = {}, maxCo = 0) {
      return menu
        .filter(r => !currentIds.has(r.id) && (manualIds.has(r.id) || r.me_class !== 'dog'))
        .map(r => ({ ...r, _score: calcScore(r, coMap, maxCo), _manual: manualIds.has(r.id) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, 4)
    }

    // Layer 2 + 3: immediate suggestions from local data
    const initial = rank()
    if (initial.length === 0) { setSuggestions([]); return }
    setSuggestions(initial)

    // Layer 1: co-occurrence (async — re-ranks on arrival)
    if (!clientId) return
    const { data: coData } = await supabase.rpc('get_cooccurrence', {
      p_client_id: clientId, p_recipe_id: recipe.id, p_days: 90,
    })
    if (!coData?.length) return
    const coMap = Object.fromEntries(coData.map(r => [r.paired_recipe_id, Number(r.co_count)]))
    const maxCo = Math.max(...Object.values(coMap))
    setSuggestions(rank(coMap, maxCo))
  }

  function setQty(idx, qty) {
    if (qty <= 0) {
      setOrderItems(prev => prev.filter((_, i) => i !== idx))
    } else {
      setOrderItems(prev => prev.map((item, i) => i === idx
        ? {
            ...item,
            qty,
            sent_to_kot: item.qty === qty ? item.sent_to_kot : false,
            sent_qty: (item.sent_to_kot && item.qty !== qty) ? item.qty : (item.sent_qty || 0),
          }
        : item))
    }
  }

  function updateItemNote(idx, notes) {
    setOrderItems(prev => prev.map((item, i) => i === idx
      ? {
          ...item, notes,
          sent_to_kot: item.notes === notes ? item.sent_to_kot : false,
          sent_qty: (item.sent_to_kot && item.notes !== notes) ? item.qty : (item.sent_qty || 0),
        }
      : item))
  }

  function addPresetToNote(idx, phrase) {
    const existing = (orderItems[idx].notes || '').split(',').map(s => s.trim()).filter(Boolean)
    if (existing.includes(phrase)) return
    updateItemNote(idx, [...existing, phrase].join(', '))
  }

  /* ── core save (shared by saveOrder and sendTicket) ── */

  async function performSave() {
    let oid = orderId
    let oNo = orderNo
    const isNewOrder = !oid

    const itemsPayload = orderItems.map(toItemPayload)

    if (!navigator.onLine) {
      let createdOffline = isNewOrder
      if (isNewOrder) {
        oid = crypto.randomUUID()
        setOrderId(oid)
        // oNo stays null — the real order_no is assigned by the server-side trigger on sync
      } else {
        const existingQueued = await getQueuedPosOrder(oid)
        createdOffline = existingQueued?.created_offline || false
      }
      await enqueuePosOrder(oid, {
        created_offline: createdOffline,
        table_id:   activeTable?.id   || null,
        table_name: activeTable?.name || 'Takeaway',
        covers,
        opened_by:  profile?.id || null,
        items: itemsPayload,
      })
      setPendingOrderIds(prev => new Set([...prev, oid]))
      if (isNewOrder && activeTable?.id) {
        setTables(prev => prev.map(t => t.id === activeTable.id ? { ...t, status: 'occupied' } : t))
      }
      loadFloor() // safe offline — reads from cache/queue, no network
      return { oid, oNo: null }
    }

    if (isNewOrder) {
      const { data: newOrder, error } = await supabase
        .from('pos_orders')
        .insert({
          client_id:  clientId,
          table_id:   activeTable?.id   || null,
          table_name: activeTable?.name || 'Takeaway',
          status:     'open',
          covers,
          opened_by:  profile?.id || null,
        })
        .select('id, order_no').single()
      if (error || !newOrder) return null
      oid = newOrder.id
      oNo = newOrder.order_no || null
      setOrderId(oid)
      setOrderNo(oNo)
      if (activeTable?.id) {
        await supabase.from('pos_tables').update({ status: 'occupied' }).eq('id', activeTable.id)
        setTables(prev => prev.map(t => t.id === activeTable.id ? { ...t, status: 'occupied' } : t))
      }
    } else {
      await supabase.from('pos_orders').update({ covers }).eq('id', oid)
    }

    // Delete + re-insert preserving sent_to_kot and category from local state
    await supabase.from('pos_order_items').delete().eq('order_id', oid)
    const { error: iErr } = await supabase.from('pos_order_items').insert(
      itemsPayload.map(i => ({ order_id: oid, client_id: clientId, ...i }))
    )
    if (iErr) return null
    if (activeTable?.id) cachePosOrderForTable(activeTable.id, { orderId: oid, orderNo: oNo, covers, items: orderItems })
    loadFloor()
    return { oid, oNo }
  }

  async function saveOrder() {
    if (!clientId) return
    if (orderItems.length === 0) { setMsg('error:Add at least one item.'); return }
    setSaving(true); setMsg('')

    const wasNew = !orderId
    const saved = await performSave()
    if (!saved) { setSaving(false); setMsg('error:Save failed.'); return }
    const { oid, oNo } = saved

    if (wasNew) {
      // Auto-send all items to their stations on first save
      const kotItems = orderItems.filter(i => !botCategories.has(i.category || 'Other'))
      const botItems = orderItems.filter(i =>  botCategories.has(i.category || 'Other'))
      const sentItems = orderItems.map(i => ({ ...i, sent_to_kot: true, sent_qty: i.qty }))
      if (navigator.onLine) {
        await supabase.from('pos_order_items').update({ sent_to_kot: true }).eq('order_id', oid)
      } else {
        await enqueuePosOrder(oid, { items: sentItems.map(toItemPayload) })
      }
      setOrderItems(sentItems)
      if (kotItems.length > 0) printTicket('KOT', kotItems, oNo)
      if (botItems.length > 0) printTicket('BOT', botItems, oNo)
      logKotSend('KOT', kotItems, oid, oNo)
      logKotSend('BOT', botItems, oid, oNo)
      setMsg('ok:Order sent!')
    } else {
      setMsg('ok:Saved.')
    }

    setSaving(false)
  }

  /* ── KOT / BOT ── */

  async function sendTicket(station) {
    if (orderItems.length === 0) { setMsg('error:Add items first.'); return }

    const unsentItems = orderItems.filter(i => {
      if (i.sent_to_kot) return false
      return station === 'BOT'
        ? botCategories.has(i.category || 'Other')
        : !botCategories.has(i.category || 'Other')
    })

    if (unsentItems.length === 0) {
      setMsg(`error:No new ${station === 'BOT' ? 'bar' : 'kitchen'} items to send.`)
      return
    }

    setSaving(true); setMsg('')
    const saved = await performSave()
    if (!saved) { setSaving(false); setMsg('error:Save failed.'); return }
    const { oid, oNo } = saved

    // Mark sent by recipe_id (unique per order)
    const recipeIds = unsentItems.map(i => i.recipe_id).filter(Boolean)
    const sentSet = new Set(recipeIds)
    const updatedItems = orderItems.map(i =>
      sentSet.has(i.recipe_id) ? { ...i, sent_to_kot: true, sent_qty: i.qty } : i
    )

    if (recipeIds.length > 0) {
      if (navigator.onLine) {
        await supabase.from('pos_order_items')
          .update({ sent_to_kot: true })
          .eq('order_id', oid)
          .in('recipe_id', recipeIds)
      } else {
        await enqueuePosOrder(oid, { items: updatedItems.map(toItemPayload) })
      }
    }

    setOrderItems(updatedItems)

    setSaving(false)
    setMsg(`ok:${station} sent!`)
    printTicket(station, unsentItems, oNo)
    logKotSend(station, unsentItems, oid, oNo)
  }

  // Best-effort, non-blocking (matches writeSalesEntries' own error-swallow pattern) — logs
  // exactly what was printed on the ticket (delta-aware qty) so the KOT Register/Reconciliation
  // reports reflect the real kitchen/bar send history, not just the current live order state.
  async function logKotSend(station, items, oid, oNo) {
    if (items.length === 0) return
    const payload = {
      client_id: clientId,
      order_id: oid,
      order_no: oNo,
      table_name: activeTable?.name || 'Takeaway',
      station,
      items: items.map(i => ({
        recipe_id: i.recipe_id, name: i.name, category: i.category,
        // Clamped at 0: a reduced-then-resent item must not log a negative delta, which would
        // cancel its earlier sends in the cumulative sum and un-flag it in KOT Reconciliation.
        qty: (i.sent_qty || 0) > 0 ? Math.max(0, i.qty - i.sent_qty) : i.qty,
      })),
      sent_by: profile?.id || null,
    }
    // Offline: queued alongside the order and replayed on sync — same best-effort contract as the
    // online path (a failed replay is silently retried later, never blocks/surfaces to the waiter).
    if (!navigator.onLine) {
      await enqueuePosOrder(oid, { kot_sends: [payload] })
      return
    }
    try {
      await supabase.from('pos_kot_log').insert(payload)
    } catch (err) {
      console.error('pos_kot_log insert failed:', err)
    }
  }

  function printTicket(station, items, ticketNo) {
    const tableName    = activeTable?.name || 'Takeaway'
    const now          = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const bs           = adToBs(new Date())
    const date         = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
    const stationLabel = station === 'BOT' ? 'BAR ORDER TICKET' : 'KITCHEN ORDER TICKET'
    const takenBy      = profile?.full_name || ''

    const html = `<!DOCTYPE html>
<html><head><title>${station}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:13px; width:80mm; padding:8px 10px; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:17px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:7px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:3px 0; }
  .qty { font-weight:bold; font-size:15px; min-width:34px; text-align:right; }
  .note { font-size:11px; font-style:italic; color:#000; padding:0 0 3px 10px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:14px">${outletName}</div>` : ''}
  <div class="c b lg">${stationLabel}</div>
  <hr>
  <div class="row"><span class="b" style="font-size:15px">${tableName}</span><span class="b" style="font-size:15px">${ticketNo ? `#${ticketNo}` : ''}</span></div>
  <div class="row"><span>${takenBy ? `Taken by: ${takenBy}` : ''}</span><span>Covers: ${covers}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>${date}</span><span>${now}</span></div>
  <hr>
  ${items.map(i => {
      const delta = (i.sent_qty || 0) > 0 ? i.qty - i.sent_qty : 0
      const label = delta > 0 ? `+${delta}` : `×${i.qty}`
      const note  = i.notes ? `<div class="note">↳ ${i.notes}</div>` : ''
      return `<div class="row"><span class="b">${i.name}</span><span class="qty">${label}</span></div>${note}`
    }).join('')}
  <hr>
</body></html>`

    printHtml(html)
  }

  function printHtml(html) {
    const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
    if (!w) { setMsg('error:Allow pop-ups to print.'); return false }
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print(); w.close() }, 300)
    return true
  }

  /* ── Billing / Charge ── */

  async function openBilling() {
    setBillingTab('pay')
    setPayMethod('Cash')
    setTenderedStr('')
    setCloseReason('')
    setBuyerName(''); setBuyerAddress(''); setBuyerPan(''); setBuyerPhone(''); setBillRemarks('')
    setDiscountStr(''); setDiscountMode('amount'); setDiscountReason('')
    setCloseMsg('')
    setCompCostMap({})
    setHscMap({})
    setSplitMode(false); setTenders([]); setTenderMethod('Cash'); setTenderAmtStr('')
    setBillingOpen(true)
    const recipeIds = orderItems.map(i => i.recipe_id).filter(Boolean)
    if (recipeIds.length > 0) {
      const { data } = await supabase.from('recipes').select('id, hsc_code').in('id', recipeIds)
      setHscMap(Object.fromEntries((data || []).map(r => [r.id, r.hsc_code])))
    }
  }

  async function openCompTab() {
    setBillingTab('writeoff'); setCloseMsg('')
    const recipeIds = orderItems.map(i => i.recipe_id).filter(Boolean)
    const map = await computeRecipeCosts(supabase, recipeIds)
    setCompCostMap(map)
  }

  // Split payment — adds one tender against the running `remaining` balance. Non-cash methods are
  // capped at remaining (no electronic overpay/change); Cash can exceed it, producing change, but
  // only the portion up to `remaining` is ever recorded as applied to the bill.
  function addTender() {
    const amt = parseFloat(tenderAmtStr)
    if (!amt || amt <= 0 || remaining <= 0) return
    setTenders(t => [...t, {
      method: tenderMethod,
      amount: Math.min(amt, remaining),
      tenderedAmount: tenderMethod === 'Cash' ? amt : null,
    }])
    setTenderAmtStr('')
  }

  // Only the most recent tender can be undone — correcting an earlier one means voiding and
  // re-ringing the whole order, same as any other billing mistake. See split-payment plan.
  function undoLastTender() {
    setTenders(t => t.slice(0, -1))
  }

  async function writeSalesEntries(closeType) {
    const { data: periods } = await supabase
      .from('monthly_periods').select('*').eq('client_id', clientId)
      .order('bs_year', { ascending: false }).order('bs_month', { ascending: false })
    const open = (periods || []).find(p => p.status === 'open')
    if (!open) return
    const today = getBsToday()
    if (today.year !== open.bs_year || today.month !== open.bs_month) return

    const soldItems = orderItems.filter(i => i.recipe_id)
    const rows = soldItems.map(i => ({ period_id: open.id, recipe_id: i.recipe_id, bs_day: today.day, qty_sold: i.qty, source: 'pos' }))
    if (rows.length > 0) await supabase.from('sales_entries').insert(rows)

    // Best-effort stock depletion — never blocks or fails the close (matches the sales_entries
    // insert above, which also discards its error rather than rolling back the bill).
    try {
      const recipeIds = [...new Set(soldItems.map(i => i.recipe_id))]
      if (recipeIds.length > 0) {
        const breakdown = await explodeRecipeIngredients(supabase, recipeIds)
        const agg = {}
        soldItems.forEach(i => {
          (breakdown[i.recipe_id] || []).forEach(({ item_id, qty }) => {
            agg[item_id] = (agg[item_id] || 0) + qty * i.qty
          })
        })
        const movementRows = Object.entries(agg).map(([item_id, qty]) => ({
          client_id: clientId, item_id, period_id: open.id, bs_day: today.day, qty: -qty,
          source: closeType === 'writeoff' ? 'pos_comp' : 'pos_sale', ref_id: orderId,
        }))
        if (movementRows.length > 0) {
          const { error: moveErr } = await supabase.from('stock_movements').insert(movementRows)
          if (moveErr) console.error('stock_movements write failed:', moveErr)
        }
      }
    } catch (err) {
      console.error('stock_movements write failed:', err)
    }
  }

  async function closeOrder(closeType) {
    if (!orderId || !clientId) return
    if ((closeType === 'void' || closeType === 'writeoff') && !closeReason) {
      setCloseMsg('error:Select a reason.'); return
    }
    if (closeType === 'paid' && discountAmt > 0 && !discountReason) {
      setCloseMsg('error:Select a discount reason.'); return
    }
    if (closeType === 'paid' && requireBuyerId && (!buyerName.trim() || !buyerPhone.trim())) {
      setCloseMsg('error:Buyer Name + Phone are required for a discount or Credit sale.'); return
    }
    if (closeType === 'paid' && splitMode && (remaining > 0 || tenders.length === 0)) {
      setCloseMsg('error:Split payment is not fully collected yet.'); return
    }
    setClosing(true); setCloseMsg('')

    const isSplit = closeType === 'paid' && splitMode && tenders.length > 0
    const today = getBsToday()
    const payload = {
      status:           closeType === 'void' ? 'voided' : 'billed',
      close_type:       closeType,
      payment_method:   closeType === 'paid' ? (isSplit ? 'Split' : payMethod) : null,
      paid_amount:      closeType === 'paid' ? payTotal : (closeType === 'writeoff' ? 0 : null),
      tendered_amount:  closeType === 'paid' && !isSplit && payMethod === 'Cash' ? (parseFloat(tenderedStr) || payTotal) : null,
      close_reason:     closeType === 'paid' ? null : closeReason,
      discount_amount:  closeType === 'paid' ? discountAmt : null,
      discount_reason:  closeType === 'paid' ? (discountReason || null) : null,
      buyer_name:       buyerName.trim() || null,
      buyer_address:    buyerAddress.trim() || null,
      buyer_pan:        buyerPan.trim() || null,
      buyer_phone:      buyerPhone.trim() || null,
      bill_remarks:     billRemarks.trim() || null,
      closed_by:        profile?.id || null,
      closed_at:        new Date().toISOString(),
      // Both Pay and Complimentary get their own sequential number (TI/PB for Pay, NC for
      // Complimentary) — the DB trigger partitions the counter by close_type so the two
      // sequences never share numbers. Void never gets one (order was never fulfilled).
      ...(closeType !== 'void' ? { invoice_fy: getBsFiscalYear(today.year, today.month) } : {}),
      // Best-effort shift attribution — openShiftId is cached, not re-queried per close, so an
      // order closed just after another device closes the shift gets stamped with whatever shift
      // is open at that instant (possibly null, possibly the next one). That's correct
      // bookkeeping, not a bug: shift linkage is informational only and never blocks Charge.
      shift_id: openShiftId,
    }

    const { data: updated, error } = await supabase
      .from('pos_orders').update(payload).eq('id', orderId)
      .select('*').single()
    if (error) { setCloseMsg('error:' + error.message); setClosing(false); return }

    if (isSplit) {
      await supabase.from('pos_order_payments').insert(tenders.map(t => ({
        order_id: orderId, client_id: clientId,
        payment_method: t.method, amount: t.amount, tendered_amount: t.tenderedAmount,
        recorded_by: profile?.id || null,
      })))
    }

    if (closeType !== 'void') await writeSalesEntries(closeType)

    // Auto-build the customer book: any bill with buyer Name + Phone (required for discounts and
    // Credit sales) adds/updates a pos_customers row keyed by phone. Non-fatal — never blocks billing.
    if (buyerName.trim() && buyerPhone.trim()) {
      const custRow = { client_id: clientId, name: buyerName.trim(), phone: buyerPhone.trim(), updated_at: new Date().toISOString() }
      if (buyerAddress.trim()) custRow.address = buyerAddress.trim()
      if (buyerPan.trim())     custRow.pan     = buyerPan.trim()
      await supabase.from('pos_customers').upsert(custRow, { onConflict: 'client_id,phone' })
    }

    if (activeTable?.id) {
      await supabase.from('pos_tables').update({ status: 'available' }).eq('id', activeTable.id)
    }

    if (closeType === 'paid') await printBill(updated, orderItems)
    if (closeType === 'writeoff') await printCompSlip(updated, orderItems)

    setClosing(false)
    setBillingOpen(false)
    await loadFloor()
    backToFloor()
  }

  // Pure HTML builder — no side effects, no DB calls. Shared by the actual print (printBill)
  // and the live in-modal preview, so the preview can never drift out of sync with what prints.
  // Per-bill dynamic payment QR: the merchant's static QR payload (Settings → Payment QR) with
  // this bill's exact amount injected (EMVCo tag 54) and the checksum recomputed — customer
  // scans and the amount arrives pre-filled/locked in their banking app. Pure string work, no
  // provider API. Returns a data-URL image, or '' if not configured / payload invalid.
  async function makeBillQr(amount) {
    if (!billingSettings.payment_qr_data || !(amount > 0)) return ''
    const payload = buildDynamicQr(billingSettings.payment_qr_data, amount)
    if (!payload) return ''
    try { return await QRCode.toDataURL(payload, { margin: 1, width: 200 }) } catch { return '' }
  }

  function buildBillHtml(order, items, copyLabel, qrUrl, payments, qrAmount) {
    const vatReg      = billingSettings.is_vat_registered
    const prefix      = billingSettings.invoice_prefix || ''
    const invoiceNo   = order.invoice_no != null
      ? `${vatReg ? 'TI' : 'PB'}${order.invoice_no}-${prefix}${prefix ? '-' : ''}${order.invoice_fy || ''}`
      : `${vatReg ? 'TI' : 'PB'}-(on confirm)`
    const tableName   = activeTable?.name || order.table_name || 'Takeaway'
    const now         = new Date()
    const nowStr      = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const adDateStr   = now.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const bs          = adToBs(now)
    const bsDateStr   = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`
    const payLabel    = order.payment_method || ''
    // Split payment — multiple tenders against one bill/one invoice number (not a split bill).
    // `payments` is [{ method, amount }], sourced either from pos_order_payments (real print) or
    // the live `tenders` state (in-modal preview) — same shape either way.
    const isSplitBill = payLabel === 'Split' && payments && payments.length > 0

    const { grossAmt, discount, taxableBase, nonTaxableBase, vatAmt: netVatAmt, net, roundOff, totalQty } =
      computeOrderAmounts(order, items, vatReg)
    const tendered = order.tendered_amount ?? net
    const change   = !isSplitBill && payLabel === 'Cash' ? Math.max(0, tendered - net) : 0

    return `<!DOCTYPE html>
<html><head><title>Bill</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:15px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  table { width:100%; border-collapse:collapse; font-size:11px; table-layout:fixed; }
  th, td { text-align:left; padding:2px 4px 2px 0; word-wrap:break-word; }
  th:last-child, td:last-child { padding-right:0; }
  th:nth-child(1), td:nth-child(1) { width:19px; }
  th:nth-child(2), td:nth-child(2) { width:24px; }
  th:nth-child(4), td:nth-child(4) { width:26px; text-align:center; padding-right:0; }
  th:nth-child(5), td:nth-child(5) { width:46px; text-align:right; }
  th:nth-child(6), td:nth-child(6) { width:54px; text-align:right; }
  .tot  { font-weight:bold; font-size:13px; }
  .copy { font-size:11px; letter-spacing:1px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:13px">${outletName}</div>` : ''}
  ${billingSettings.property_address ? `<div class="c" style="font-size:11px">${billingSettings.property_address}</div>` : ''}
  ${billingSettings.property_phone ? `<div class="c" style="font-size:11px">${billingSettings.property_phone}</div>` : ''}
  ${billingSettings.vat_number ? `<div class="c" style="font-size:11px">${vatReg ? 'VAT No' : 'PAN No'}: ${billingSettings.vat_number}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">${vatReg ? 'TAX INVOICE' : 'BILL'}</div>
  <div class="c copy">${copyLabel}</div>
  <hr>
  <div class="row"><span>Bill No:</span><span class="b">${invoiceNo}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Name:</span><span>${order.buyer_name || ''}</span></div>
  <div class="row"><span>Address:</span><span>${order.buyer_address || ''}</span></div>
  <div class="row"><span>PAN No: ${order.buyer_pan || ''}</span><span>Phone: ${order.buyer_phone || ''}</span></div>
  <div class="row"><span>Payment Mode:</span><span>${isSplitBill ? 'Split' : payLabel}</span></div>
  <div class="row"><span>Remarks:</span><span>${order.bill_remarks || ''}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>${tableName === 'Takeaway' ? 'Takeaway' : `Dine-In: ${tableName}`}</span><span>Covers: ${order.covers ?? ''}</span></div>
  <div class="row" style="font-size:11px;color:#000"><span>Cashier: ${profile?.full_name || ''}</span><span>${nowStr}</span></div>
  <hr>
  <table>
    <thead><tr><th>Sn</th><th>HSC</th><th>Particulars</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
    <tbody>
      ${items.map((i, idx) => `<tr><td>${idx + 1}</td><td>${hscMap[i.recipe_id] || ''}</td><td>${i.name}</td><td>${i.qty}</td><td>${i.unit_price.toFixed(2)}</td><td>${(i.qty * i.unit_price).toFixed(2)}</td></tr>`).join('')}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Gross Amount:</span><span>${grossAmt.toFixed(2)}</span></div>
  <div class="row"><span>Discount:</span><span>${discount.toFixed(2)}</span></div>
  ${vatReg ? `
  <div class="row"><span>Taxable:</span><span>${taxableBase.toFixed(2)}</span></div>
  <div class="row"><span>Nontaxable:</span><span>${nonTaxableBase.toFixed(2)}</span></div>
  <div class="row"><span>VAT 13%:</span><span>${netVatAmt.toFixed(2)}</span></div>
  <div class="row"><span>Round Off:</span><span>${roundOff >= 0 ? '+' : ''}${roundOff.toFixed(2)}</span></div>
  ` : ''}
  <div class="row tot"><span>Net Amount:</span><span>${net.toFixed(2)}</span></div>
  <hr>
  ${isSplitBill ? payments.map(p => `<div class="row"><span>${p.method}:</span><span>${p.amount.toFixed(2)}</span></div>`).join('') : `
  <div class="row"><span>Tender:</span><span>${tendered.toFixed(2)}</span></div>
  <div class="row"><span>Change:</span><span>${change.toFixed(2)}</span></div>
  `}
  <hr>
  <div class="row"><span>Total Qty:</span><span>${totalQty}</span></div>
  <hr>
  <div style="font-size:11px; margin:4px 0">Rs. ${numberToWordsNpr(net)} only</div>
  <hr>
  ${qrUrl ? `
  <div class="c" style="margin:6px 0">
    <img src="${qrUrl}" alt="Scan to pay" style="width:120px;height:120px;display:block;margin:0 auto" />
    <div style="font-size:11px;margin-top:2px">Scan to pay ${(qrAmount ?? net).toFixed(0)} — amount pre-filled</div>
  </div>
  <hr>
  ` : ''}
  ${payLabel === 'Credit' ? `
  <div style="margin-top:16px">
    <div class="row">
      <span style="border-bottom:1px solid #000; width:60%; display:inline-block">&nbsp;</span>
      <span style="border-bottom:1px solid #000; width:32%; display:inline-block">&nbsp;</span>
    </div>
    <div class="row" style="font-size:10px; margin-top:2px">
      <span>Customer Signature</span><span>Date</span>
    </div>
  </div>
  ` : ''}
  <div class="c" style="font-size:11px">Thank you for stopping by! We hope to see you again soon.</div>
</body></html>`
  }

  // Optional courtesy slip for one split-payment tender — not a Tax Invoice/PAN Bill, just proof
  // of that person's own payment while the rest of the table is still settling up. The one real
  // invoice still only prints once, at full close, via buildBillHtml above.
  function buildTenderSlipHtml(tender, remainingAfter) {
    const now       = new Date()
    const nowStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const tableName = activeTable?.name || 'Takeaway'
    const change    = tender.tenderedAmount != null ? Math.max(0, tender.tenderedAmount - tender.amount) : 0

    return `<!DOCTYPE html>
<html><head><title>Payment Slip</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  .tot { font-weight:bold; font-size:12px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:13px">${outletName}</div>` : ''}
  <div class="c" style="font-size:11px; margin-top:2px">Payment Received</div>
  <hr>
  <div class="row"><span>Table:</span><span>${tableName}</span></div>
  <div class="row"><span>Method:</span><span class="b">${tender.method}</span></div>
  <div class="row tot"><span>Amount:</span><span>NPR ${tender.amount.toFixed(2)}</span></div>
  ${tender.tenderedAmount != null ? `
  <div class="row"><span>Tendered:</span><span>${tender.tenderedAmount.toFixed(2)}</span></div>
  <div class="row"><span>Change:</span><span>${change.toFixed(2)}</span></div>
  ` : ''}
  <hr>
  <div class="row"><span>Remaining on bill:</span><span>${remainingAfter > 0 ? `NPR ${remainingAfter.toFixed(2)}` : 'Paid in full'}</span></div>
  <div class="row" style="font-size:10px; margin-top:6px"><span>Not a Tax Invoice / PAN Bill</span><span>${nowStr}</span></div>
  <hr>
  <div class="c" style="font-size:11px">Thank you for stopping by! We hope to see you again soon.</div>
</body></html>`
  }

  async function printBill(order, items) {
    const newCount = (order.print_count || 0) + 1
    await supabase.from('pos_orders').update({ print_count: newCount }).eq('id', order.id)
    const qrUrl = QR_PAY_METHODS.includes(order.payment_method) ? await makeBillQr(order.paid_amount) : ''
    let payments
    if (order.payment_method === 'Split') {
      const { data } = await supabase.from('pos_order_payments')
        .select('payment_method, amount').eq('order_id', order.id).order('recorded_at')
      payments = (data || []).map(p => ({ method: p.payment_method, amount: p.amount }))
    }
    printHtml(buildBillHtml(order, items, COPY_LABEL(newCount), qrUrl, payments))
  }

  // Complimentary items were never sold — this is an internal cost-tracking slip, not a Tax
  // Invoice or PAN Bill: no VAT/PAN, own NC-prefixed sequence (separate from TI/PB), and line
  // amounts are valued at food cost (not menu price) so the P&L impact isn't distorted by
  // retail pricing. Standard practice per restaurant accounting for comps.
  // Pure builder (see buildBillHtml) — shared by printCompSlip and the live in-modal preview.
  function buildCompSlipHtml(order, items, costMap, copyLabel) {
    const ncNo      = order.invoice_no != null ? `NC-${String(order.invoice_no).padStart(2, '0')}` : 'NC-(on confirm)'
    const tableName = activeTable?.name || order.table_name || 'Takeaway'
    const now       = new Date()
    const nowStr    = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const adDateStr = now.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const bs        = adToBs(now)
    const bsDateStr = `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}`

    const totalQty  = items.reduce((s, i) => s + i.qty, 0)
    const totalCost = items.reduce((s, i) => s + i.qty * (costMap[i.recipe_id] || 0), 0)

    return `<!DOCTYPE html>
<html><head><title>Complimentary Slip</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New',monospace; font-size:11px; width:80mm; padding:8px 10px; margin:0 auto; color:#000; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:14px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:6px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:2px 0; }
  table { width:100%; border-collapse:collapse; font-size:11px; }
  th, td { text-align:left; padding:2px 0; }
  th:last-child, td:last-child { text-align:right; }
  .tot  { font-weight:bold; font-size:12px; }
  .copy { font-size:11px; letter-spacing:1px; }
</style>
</head><body>
  <div class="c copy">${copyLabel}</div>
  ${outletName ? `<div class="c b" style="font-size:13px">${outletName}</div>` : ''}
  <div class="c b lg" style="margin-top:4px">COMPLIMENTARY SLIP</div>
  <div class="c" style="font-size:11px">Internal record — not a Tax Invoice or PAN Bill</div>
  <hr>
  <div class="row"><span>No:</span><span class="b">${ncNo}</span></div>
  <div class="row"><span>Order Ref:</span><span>#${order.order_no ?? ''}</span></div>
  <div class="row"><span>Table:</span><span>${tableName}</span></div>
  <div class="row"><span>Date:</span><span>${adDateStr}</span></div>
  <div class="row"><span>Miti:</span><span>${bsDateStr}</span></div>
  <div class="row"><span>Reason:</span><span>${order.close_reason || ''}</span></div>
  <div class="row"><span>Authorized by:</span><span>${profile?.full_name || ''}</span></div>
  <div class="row"><span>Remarks:</span><span>${order.bill_remarks || ''}</span></div>
  <hr>
  <table>
    <thead><tr><th>Item</th><th>Qty</th><th>Cost</th></tr></thead>
    <tbody>
      ${items.map(i => `<tr><td>${i.name}</td><td>${i.qty}</td><td>${(i.qty * (costMap[i.recipe_id] || 0)).toFixed(2)}</td></tr>`).join('')}
    </tbody>
  </table>
  <hr>
  <div class="row"><span>Total Qty:</span><span>${totalQty}</span></div>
  <div class="row tot"><span>Total Food Cost:</span><span>NPR ${totalCost.toFixed(2)}</span></div>
  <hr>
  <div class="row" style="font-size:11px;color:#000"><span>Table: ${tableName}</span><span>${nowStr}</span></div>
  <div style="margin-top:16px">
    <div class="row">
      <span style="border-bottom:1px solid #000; width:60%; display:inline-block">&nbsp;</span>
      <span style="border-bottom:1px solid #000; width:32%; display:inline-block">&nbsp;</span>
    </div>
    <div class="row" style="font-size:10px; margin-top:2px">
      <span>Customer Signature</span><span>Date</span>
    </div>
  </div>
</body></html>`
  }

  async function printCompSlip(order, items) {
    const newCount = (order.print_count || 0) + 1
    await supabase.from('pos_orders').update({ print_count: newCount }).eq('id', order.id)
    const recipeIds = items.map(i => i.recipe_id).filter(Boolean)
    const costMap = await computeRecipeCosts(supabase, recipeIds)
    printHtml(buildCompSlipHtml(order, items, costMap, COPY_LABEL(newCount)))
  }

  async function loadRecentBills() {
    setRecentBillsLoad(true)
    const today = getBsToday()
    const { data } = await supabase
      .from('pos_orders')
      .select('id, table_name, invoice_no, invoice_fy, close_type, paid_amount, closed_at, order_no, credit_note_id, buyer_name, buyer_address, buyer_pan, buyer_phone, discount_amount')
      .eq('client_id', clientId)
      .in('status', ['billed', 'voided'])
      .order('closed_at', { ascending: false })
      .limit(30)
    setRecentBills((data || []).filter(o => {
      if (!o.closed_at) return false
      const bs = adToBs(new Date(o.closed_at))
      return bs.year === today.year && bs.month === today.month && bs.day === today.day
    }))
    setRecentBillsLoad(false)
  }

  async function reprintBill(orderRow) {
    const { data: order } = await supabase.from('pos_orders').select('*').eq('id', orderRow.id).single()
    const { data: items } = await supabase.from('pos_order_items').select('*').eq('order_id', orderRow.id)
    if (!order) return
    if (order.close_type === 'writeoff') {
      await printCompSlip(order, items || [])
    } else {
      await printBill(order, items || [])
    }
    setRecentBills(prev => prev.map(o => o.id === orderRow.id ? { ...o, print_count: (o.print_count || 0) + 1 } : o))
  }

  async function clearAllOccupiedTables() {
    if (!isAdmin || !clientId) return
    if (!window.confirm('Clear ALL occupied tables? This permanently deletes every open order and its items for this client. Use only for testing.')) return
    setFloorLoad(true)
    const { data: openOrders } = await supabase.from('pos_orders').select('id').eq('client_id', clientId).eq('status', 'open')
    const ids = (openOrders || []).map(o => o.id)
    if (ids.length > 0) {
      await supabase.from('pos_order_items').delete().in('order_id', ids)
      await supabase.from('pos_orders').delete().in('id', ids)
    }
    await supabase.from('pos_tables').update({ status: 'available' }).eq('client_id', clientId).eq('status', 'occupied')
    await loadFloor()
  }

  function backToFloor() {
    setView('floor'); setActiveTable(null); setOrderId(null); setOrderNo(null); setOrderItems([]); setMsg('')
    setSuggestions([])
    setMenuLoaded(false)
  }

  // Live bill/slip preview inside the Billing modal — built from the exact same functions used
  // for the real print, so what the cashier sees always matches what will actually print.
  const previewDraftOrder = {
    invoice_no: null, invoice_fy: null,
    payment_method: splitMode && tenders.length > 0 ? 'Split' : payMethod,
    tendered_amount: !splitMode && payMethod === 'Cash' ? (parseFloat(tenderedStr) || payTotal) : null,
    buyer_name: buyerName, buyer_address: buyerAddress, buyer_pan: buyerPan, buyer_phone: buyerPhone,
    bill_remarks: billRemarks, close_reason: closeReason,
    discount_amount: discountAmt,
    table_name: activeTable?.name, order_no: orderNo, print_count: 0,
  }
  const previewHtml = !billingOpen ? null
    : billingTab === 'pay' ? buildBillHtml(previewDraftOrder, orderItems, 'PREVIEW', billQrUrl, tenders, splitMode ? (parseFloat(tenderAmtStr) || remaining) : payTotal)
    : billingTab === 'writeoff' ? buildCompSlipHtml(previewDraftOrder, orderItems, compCostMap, 'PREVIEW')
    : null
  const kotCount = orderItems.filter(i => !i.sent_to_kot && !botCategories.has(i.category || 'Other')).length
  const botCount = orderItems.filter(i => !i.sent_to_kot && botCategories.has(i.category || 'Other')).length

  const pendingTables    = Object.values(tableOrders).filter(o => o.pending > 0)
  const pendingTableCount = pendingTables.length
  const pendingItemCount  = pendingTables.reduce((s, o) => s + o.pending, 0)

  const sections  = ['All', ...Array.from(new Set(tables.map(t => t.section).filter(Boolean)))]
  const visTables = secFilter === 'All' ? tables : tables.filter(t => t.section === secFilter)
  const menuCats  = ['All', ...Array.from(new Set(menu.map(r => r.category))).sort()]
  const visMenu   = (catTab === 'All' ? menu : menu.filter(r => r.category === catTab))
    .filter(r => r.name.toLowerCase().includes(menuSearch.trim().toLowerCase()))

  /* ══════════════════════════════════════════ ORDER SCREEN */

  if (view === 'order') return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1000,
      background: 'var(--theme-bg)',
      display: 'flex', flexDirection: 'column',
    }}>

      {/* ── Top bar ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 16px', height: 52, flexShrink: 0,
        background: 'var(--theme-card)', borderBottom: '1px solid var(--theme-border)',
      }}>
        <button onClick={backToFloor} style={{
          background: 'none', border: '1px solid var(--theme-border)',
          borderRadius: 7, padding: '6px 14px',
          color: 'var(--theme-text2)', cursor: 'pointer', fontSize: 14,
        }}>
          ← {activeTable ? activeTable.name : 'Takeaway'}
        </button>

        {activeTable?.section && (
          <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>{activeTable.section}</span>
        )}

        {orderNo && (
          <Tip text="Order number — printed on every KOT/BOT ticket so the kitchen, bar and bill all reference the same order">
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-accent)',
              border: '1px solid var(--theme-accent)', borderRadius: 5,
              padding: '2px 7px', cursor: 'default',
            }}>#{orderNo}</span>
          </Tip>
        )}

        {!orderNo && orderId && (
          <Tip text="This order was saved offline — it will get a real order number once this device reconnects and syncs">
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-amber)',
              border: '1px solid var(--theme-amber)', borderRadius: 5,
              padding: '2px 7px', cursor: 'default',
            }}>#— (pending)</span>
          </Tip>
        )}

        {!isOnline && (
          <Tip text="Offline — this order is saved on this device and will sync when you reconnect">
            <span style={{
              fontSize: 12, fontWeight: 700, color: 'var(--theme-amber)',
              background: 'rgba(251,191,36,0.12)', borderRadius: 5,
              padding: '2px 7px', cursor: 'default',
            }}>📵 Offline</span>
          </Tip>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginLeft: 8 }}>
          <Tip text="Number of guests at this table — used for cover count reporting">
            <span style={{ fontSize: 12, color: 'var(--theme-text3)', cursor: 'default' }}>Covers</span>
          </Tip>
          <button onClick={() => setCovers(c => Math.max(1, c - 1))} style={btnSm}>−</button>
          <span style={{ fontWeight: 700, color: 'var(--theme-text1)', minWidth: 22, textAlign: 'center', fontSize: 14 }}>{covers}</span>
          <button onClick={() => setCovers(c => c + 1)} style={btnSm}>+</button>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {msg && (
            <span style={{ fontSize: 12, color: msg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
              {msg.replace(/^(error|ok):/, '')}
            </span>
          )}
        </div>
      </div>

      {/* ── Two-panel body ── */}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>

        {/* LEFT: Menu browser */}
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--theme-border)', minWidth: 0,
        }}>
          <div style={{
            flexShrink: 0, padding: '8px 12px',
            borderBottom: '1px solid var(--theme-border)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <div style={{ display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'none' }}>
              {menuCats.map(c => (
                <button key={c} className={`tab-btn${catTab === c ? ' tab-btn--active' : ''}`}
                  onClick={() => setCatTab(c)} style={{ flexShrink: 0 }}>{c}</button>
              ))}
            </div>
            <input
              type="text"
              placeholder="🔍 Search menu…"
              value={menuSearch}
              onChange={e => setMenuSearch(e.target.value)}
              style={{
                marginLeft: 'auto', flexShrink: 0, width: 160,
                background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                borderRadius: 6, padding: '6px 10px', fontSize: 12,
                color: 'var(--theme-text1)', outline: 'none',
              }}
            />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {!menuLoaded ? (
              <p style={{ color: 'var(--theme-text3)', margin: 0 }}>Loading menu…</p>
            ) : visMenu.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', margin: 0 }}>
                {menu.length === 0
                  ? 'No POS-enabled items. Toggle items On POS in Menu Pricing first.'
                  : menuSearch.trim()
                    ? `No items match "${menuSearch.trim()}".`
                    : 'No items in this category.'}
              </p>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                gap: 10,
              }}>
                {visMenu.map(r => {
                  const vat   = vatReg ? vatOf(r) : 0
                  const price = Math.round((parseFloat(r.selling_price) || 0) * (1 + vat))
                  const inOrd = orderItems.find(i => i.recipe_id === r.id)
                  return (
                    <button key={r.id} onClick={() => addItem(r)} style={{
                      background: inOrd
                        ? 'color-mix(in srgb, var(--theme-accent) 12%, var(--theme-card))'
                        : 'var(--theme-card)',
                      border: `1px solid ${inOrd ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                      borderRadius: 10, padding: '12px 10px',
                      cursor: 'pointer', textAlign: 'left',
                      display: 'flex', flexDirection: 'column', gap: 6,
                      position: 'relative', transition: 'border-color 0.12s',
                    }}>
                      {inOrd && (
                        <span style={{
                          position: 'absolute', top: 6, right: 8,
                          background: 'var(--theme-accent)', color: 'var(--theme-bg)',
                          borderRadius: 10, fontSize: 11, fontWeight: 700, padding: '1px 7px',
                        }}>{inOrd.qty}</span>
                      )}
                      <span style={{
                        fontWeight: 600, fontSize: 13, color: 'var(--theme-text1)',
                        lineHeight: 1.3, paddingRight: inOrd ? 28 : 0,
                      }}>{r.name}</span>
                      <span style={{ fontSize: 12, color: 'var(--theme-accent)', fontWeight: 600 }}>
                        NPR {price}
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: Order panel */}
        <div style={{
          width: 320, flexShrink: 0,
          display: 'flex', flexDirection: 'column',
          background: 'var(--theme-card)',
        }}>

          {/* Order items list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 14px' }}>
            {orderItems.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13, textAlign: 'center', paddingTop: 48, margin: 0 }}>
                Tap items on the left to add them
              </p>
            ) : orderItems.map((item, idx) => {
              const lineTotal = item.qty * item.unit_price * (1 + (vatReg ? (item.vat_rate ?? 0) : 0))
              return (
                <div key={idx} style={{
                  display: 'flex', flexDirection: 'column', gap: 4,
                  borderBottom: '1px solid var(--theme-border)', padding: '9px 0',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 13, color: 'var(--theme-text1)', lineHeight: 1.3 }}>
                        {item.name}
                      </span>
                      {item.sent_to_kot && (
                        <Tip text="Ticket already sent to the station — press KOT/BOT again only if you add more of this item">
                          <span style={{
                            fontSize: 9, fontWeight: 700, flexShrink: 0,
                            background: 'var(--theme-green)', color: '#fff',
                            borderRadius: 4, padding: '1px 5px', cursor: 'default',
                          }}>
                            ✓ {botCategories.has(item.category || 'Other') ? 'BOT' : 'KOT'}
                          </span>
                        </Tip>
                      )}
                      {!item.sent_to_kot && (item.sent_qty || 0) > 0 && item.qty > item.sent_qty && (
                        <Tip text={`${item.qty - item.sent_qty} extra added since last ticket — press KOT or BOT to send the addition to the station`}>
                          <span style={{
                            fontSize: 9, fontWeight: 700, flexShrink: 0,
                            background: 'var(--theme-amber)', color: '#000',
                            borderRadius: 4, padding: '1px 5px', cursor: 'default',
                          }}>
                            +{item.qty - item.sent_qty}
                          </span>
                        </Tip>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                    <button onClick={() => setQty(idx, item.qty - 1)} style={btnSm}>−</button>
                    <span style={{ minWidth: 22, textAlign: 'center', fontWeight: 700, color: 'var(--theme-text1)', fontSize: 13 }}>
                      {item.qty}
                    </span>
                    <button onClick={() => setQty(idx, item.qty + 1)} style={btnSm}>+</button>
                  </div>
                  <span style={{ fontSize: 13, color: 'var(--theme-text1)', fontWeight: 600, minWidth: 68, textAlign: 'right', flexShrink: 0 }}>
                    NPR {Math.round(lineTotal)}
                  </span>
                  <button
                    onClick={() => setQty(idx, 0)}
                    title="Remove"
                    style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 18, padding: '0 2px', lineHeight: 1, flexShrink: 0 }}
                  >×</button>
                  </div>
                  <input
                    type="text"
                    value={item.notes || ''}
                    onChange={e => updateItemNote(idx, e.target.value)}
                    onFocus={() => setNoteFocusIdx(idx)}
                    onBlur={() => setNoteFocusIdx(null)}
                    placeholder="+ Add note (e.g. no onion)"
                    style={{
                      background: 'none', border: 'none', outline: 'none',
                      fontSize: 11, fontStyle: 'italic', color: 'var(--theme-text3)',
                      padding: '0 0 0 2px', width: '100%',
                    }}
                  />
                  {noteFocusIdx === idx && notePresets.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 0 0 2px' }}>
                      {notePresets.map(p => (
                        <button
                          key={p}
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => addPresetToNote(idx, p)}
                          style={{
                            fontSize: 10, padding: '2px 8px', borderRadius: 10,
                            border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)',
                            color: 'var(--theme-text2)', cursor: 'pointer',
                          }}
                        >{p}</button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {/* ── ME suggestion chips ── */}
          {suggestions.length > 0 && (
            <div style={{
              borderTop: '1px solid var(--theme-border)', flexShrink: 0,
              padding: '8px 14px',
              background: 'color-mix(in srgb, var(--theme-accent) 5%, var(--theme-card))',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--theme-text3)' }}>Pair with</span>
                <button
                  onClick={() => setSuggestions([])}
                  style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: 0, marginLeft: 'auto', lineHeight: 1 }}
                >✕</button>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {suggestions.map(r => {
                  const price        = Math.round((parseFloat(r.selling_price) || 0) * (1 + (vatReg ? vatOf(r) : 0)))
                  const isChefsPick  = r.me_class === 'puzzle' && !r._manual
                  return (
                    <button
                      key={r.id}
                      onClick={() => addItem(r)}
                      style={{
                        background: 'var(--theme-card)',
                        border: `1px solid ${r._manual ? 'var(--theme-accent)' : isChefsPick ? 'var(--theme-amber)' : 'var(--theme-border)'}`,
                        borderRadius: 14, padding: '5px 10px', fontSize: 12, cursor: 'pointer',
                        color: 'var(--theme-text1)', display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left',
                      }}
                    >
                      {r._manual && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--theme-accent)', letterSpacing: 0.5 }}>PAIRED</span>
                      )}
                      {isChefsPick && (
                        <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--theme-amber)', letterSpacing: 0.5 }}>CHEF'S PICK</span>
                      )}
                      <span>{r.name}</span>
                      <span style={{ fontSize: 10, color: 'var(--theme-accent)' }}>+NPR {price}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Totals + action buttons */}
          <div style={{ borderTop: '2px solid var(--theme-border)', padding: '12px 14px', flexShrink: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--theme-text2)', marginBottom: 4 }}>
              <span>Subtotal (ex-VAT)</span><span>{fmtNpr(subEx)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--theme-text2)', marginBottom: 10 }}>
              <span>VAT</span><span>{fmtNpr(vatAmt)}</span>
            </div>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 20, fontWeight: 700, color: 'var(--theme-text1)',
              paddingTop: 10, borderTop: '1px solid var(--theme-border)', marginBottom: 14,
            }}>
              <span>TOTAL</span>
              <span style={{ color: 'var(--theme-accent)' }}>{fmtNpr(total)}</span>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <button
                className="btn btn-primary"
                style={{ width: '48%', padding: '12px 0', fontSize: 16, justifyContent: 'center', display: 'flex' }}
                onClick={saveOrder}
                disabled={saving || orderItems.length === 0}
              >
                {saving ? 'Sending…' : orderId ? 'Update Order' : 'Send Order'}
              </button>

              {hasPosAccess('supervisor') && (() => {
                const payDisabled = saving || !orderId || !isOnline
                return (
                <div style={{ width: '48%' }}>
                  <Tip text={!isOnline
                      ? 'Reconnect to close this bill — billing needs a live connection for the sequential invoice number and stock/sales posting.'
                      : 'Close this table — collect payment, or void/write-off if unpaid. Order must be saved first. Supervisor role or above.'}
                    style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}>
                    <button
                      className="btn"
                      style={{
                        width: '100%', padding: '12px 0', fontSize: 16, justifyContent: 'center', display: 'flex',
                        background: 'var(--theme-green)', color: '#fff', fontWeight: 700, border: 'none',
                        // Same disabled treatment as the KOT/BOT ticket-btn class (opacity 0.5) — this
                        // button uses inline styles instead of that class, so it needs its own dimming.
                        opacity: payDisabled ? 0.5 : 1,
                        cursor: payDisabled ? 'default' : 'pointer',
                      }}
                      onClick={openBilling}
                      disabled={payDisabled}>
                      Payment
                    </button>
                  </Tip>
                </div>
                )
              })()}
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ width: '48%' }}>
                <Tip text="Kitchen Order Ticket — sends unsent food items to the kitchen printer. Bold + badge show how many items are waiting."
                  style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}>
                  <button
                    className={`ticket-btn${kotCount > 0 ? ' ticket-btn--pending' : ''}`}
                    style={{ width: '100%', padding: '12px 0', fontSize: 16 }}
                    onClick={() => sendTicket('KOT')}
                    disabled={saving || kotCount === 0}
                  >
                    KOT
                    {kotCount > 0 && (
                      <span style={{
                        position: 'absolute', top: -6, right: -4,
                        background: 'var(--theme-red)', color: '#fff',
                        borderRadius: 10, fontSize: 10, fontWeight: 700,
                        padding: '1px 5px', lineHeight: 1.4, pointerEvents: 'none',
                      }}>{kotCount}</span>
                    )}
                  </button>
                </Tip>
              </div>
              <div style={{ width: '48%' }}>
                <Tip text="Bar Order Ticket — sends unsent bar/beverage items to the bar printer. Bold + badge show how many items are waiting."
                  style={{ display: 'inline-block', width: '100%', borderBottom: 'none' }}>
                  <button
                    className={`ticket-btn${botCount > 0 ? ' ticket-btn--pending' : ''}`}
                    style={{ width: '100%', padding: '12px 0', fontSize: 16 }}
                    onClick={() => sendTicket('BOT')}
                    disabled={saving || botCount === 0}
                  >
                    BOT
                    {botCount > 0 && (
                      <span style={{
                        position: 'absolute', top: -6, right: -4,
                        background: 'var(--theme-red)', color: '#fff',
                        borderRadius: 10, fontSize: 10, fontWeight: 700,
                        padding: '1px 5px', lineHeight: 1.4, pointerEvents: 'none',
                      }}>{botCount}</span>
                    )}
                  </button>
                </Tip>
              </div>
            </div>
          </div>
        </div>

      </div>

      {/* ── Billing modal ── */}
      {billingOpen && (
        <div
          onClick={e => { if (e.target === e.currentTarget && !closing) setBillingOpen(false) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
        >
          <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 14, width: 'min(1060px, 96vw)', maxHeight: '92vh', boxShadow: '0 16px 48px rgba(0,0,0,0.4)', display: 'flex', overflow: 'hidden' }}>
          <div style={{ width: 418, flexShrink: 0, background: 'var(--theme-sidebar)', borderRight: '1px solid var(--theme-border)', padding: '24px 20px', overflowY: 'auto' }}>
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 10px' }}>
              {billingTab === 'writeoff' ? 'Complimentary slip preview' : 'Bill preview'} <Tip text="Live preview built from the same layout that actually prints — updates as you fill in the fields to the right. The invoice/NC number shown here is a placeholder; the real one is assigned when you confirm.">(live)</Tip>
            </p>
            {previewHtml ? (
              <iframe
                title="bill-preview"
                srcDoc={previewHtml}
                scrolling="no"
                style={{ width: 378, height: 820, border: '1px solid var(--theme-border)', borderRadius: 8, background: '#fff', display: 'block', overflow: 'hidden' }}
              />
            ) : billingTab === 'void' && (
              <p style={{ fontSize: 12, color: 'var(--theme-text3)', fontStyle: 'italic' }}>
                No document prints for a Void — the order is treated as if it never happened.
              </p>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '24px 28px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 18, color: 'var(--theme-text1)' }}>
              {activeTable ? activeTable.name : 'Takeaway'}
            </h3>
            <p style={{ margin: '0 0 14px', fontSize: 20, fontWeight: 700, color: 'var(--theme-accent)' }}>
              {fmtNpr(billingTab === 'writeoff' ? compTotal : billingTab === 'pay' ? payTotal : total)}
              {billingTab === 'writeoff' && <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 8 }}>(food cost, not menu price)</span>}
              {billingTab === 'pay' && discountAmt > 0 && (
                <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--theme-text3)', marginLeft: 8 }}>
                  ({fmtNpr(total)} − {fmtNpr(discountAmt)} discount)
                </span>
              )}
            </p>

            {(kotCount + botCount) > 0 && (
              <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-amber)', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: 6, padding: '8px 10px' }}>
                ⚠ {kotCount + botCount} item{kotCount + botCount !== 1 ? 's' : ''} not yet sent to the kitchen/bar.
              </p>
            )}

            <div className="tab-bar" style={{ marginBottom: 16 }}>
              <button className={`tab-btn${billingTab === 'pay' ? ' tab-btn--active' : ''}`} onClick={() => { setBillingTab('pay'); setCloseMsg('') }}>Pay</button>
              {(isAdmin || isOwner) && (
                <button className={`tab-btn${billingTab === 'void' ? ' tab-btn--active' : ''}`} onClick={() => { setBillingTab('void'); setCloseMsg('') }}>Void</button>
              )}
              {hasPosAccess('supervisor') && (
                <button className={`tab-btn${billingTab === 'writeoff' ? ' tab-btn--active' : ''}`} onClick={openCompTab}>Complimentary</button>
              )}
            </div>

            {billingTab === 'pay' && (
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                  Buyer details {requireBuyerId ? (
                    <span style={{ color: 'var(--theme-red)', textTransform: 'none', letterSpacing: 'normal' }}>
                      <Tip text="Name and Phone are required whenever a discount is applied or the bill goes on Credit, so there's an identifiable record.">
                        {payMethod === 'Credit' ? '(Name + Phone required for Credit)' : '(Name + Phone required for this discount)'}
                      </Tip>
                    </span>
                  ) : (
                    <Tip text="Optional for transactions ≤ NPR 10,000 (IRD abbreviated-invoice exemption). Fill in if the customer requests a full invoice with their own PAN.">(optional)</Tip>
                  )}
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                  <input placeholder="Name" value={buyerName} onChange={e => setBuyerName(e.target.value)}
                    style={{ ...billInput, borderColor: requireBuyerId && !buyerName.trim() ? 'var(--theme-red)' : 'var(--theme-border)' }} />
                  <input placeholder="PAN No." value={buyerPan} onChange={e => setBuyerPan(e.target.value)} style={billInput} />
                  <input placeholder="Address" value={buyerAddress} onChange={e => setBuyerAddress(e.target.value)} style={billInput} />
                  <input placeholder="Phone" value={buyerPhone} onChange={e => setBuyerPhone(e.target.value)}
                    style={{ ...billInput, borderColor: requireBuyerId && !buyerPhone.trim() ? 'var(--theme-red)' : 'var(--theme-border)' }} />
                </div>
                <input placeholder="Remarks" value={billRemarks} onChange={e => setBillRemarks(e.target.value)} style={{ ...billInput, width: '100%' }} />
              </div>
            )}

            {billingTab === 'pay' && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <Tip text={tenders.length > 0 ? 'Undo all tenders below first to switch back.' : 'Collect this bill with one payment method.'}>
                    <button onClick={() => setSplitMode(false)} disabled={tenders.length > 0}
                      className={`pay-method-btn${!splitMode ? ' pay-method-btn--selected' : ''}`}
                      style={{ opacity: tenders.length > 0 ? 0.5 : 1, cursor: tenders.length > 0 ? 'not-allowed' : 'pointer' }}>
                      Single Payment
                    </button>
                  </Tip>
                  <Tip text="Collect this bill using more than one payment method — e.g. part eSewa, part cash. Not available with Credit.">
                    <button onClick={() => { setSplitMode(true); setPayMethod('Cash'); setTenderMethod('Cash'); setTenderAmtStr('') }}
                      className={`pay-method-btn${splitMode ? ' pay-method-btn--selected' : ''}`}>
                      Split Payment
                    </button>
                  </Tip>
                </div>

                {!splitMode && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    {PAYMENT_METHODS.map(m => (
                      <button key={m} onClick={() => setPayMethod(m)}
                        className={`pay-method-btn${payMethod === m ? ' pay-method-btn--selected' : ''}`}>
                        {m}
                      </button>
                    ))}
                    {hasPosAccess('supervisor') && (
                      <Tip text="Bill closes normally (counts as a sale, consumes an invoice number) but no payment is collected now — the customer owes this amount. Supervisor+ only. Collect it later from Customers → Outstanding Credit.">
                        <button onClick={() => setPayMethod('Credit')}
                          className={`pay-method-btn pay-method-btn--credit${payMethod === 'Credit' ? ' pay-method-btn--selected' : ''}`}>
                          Credit
                        </button>
                      </Tip>
                    )}
                  </div>
                )}

                <p style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em', margin: '0 0 8px' }}>
                  Discount <Tip text="Reduces the pre-VAT taxable amount — VAT is recalculated on the discounted base, matching standard invoice practice. Leave at 0 for no discount.">(optional)</Tip>
                </p>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <button onClick={() => setDiscountMode('amount')} style={{
                    padding: '7px 12px', borderRadius: 7, fontSize: 13, cursor: 'pointer',
                    fontWeight: discountMode === 'amount' ? 700 : 400,
                    background: discountMode === 'amount' ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                    color: discountMode === 'amount' ? '#000' : 'var(--theme-text2)',
                    border: `1px solid ${discountMode === 'amount' ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                  }}>₨</button>
                  <button onClick={() => setDiscountMode('percent')} style={{
                    padding: '7px 12px', borderRadius: 7, fontSize: 13, cursor: 'pointer',
                    fontWeight: discountMode === 'percent' ? 700 : 400,
                    background: discountMode === 'percent' ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                    color: discountMode === 'percent' ? '#000' : 'var(--theme-text2)',
                    border: `1px solid ${discountMode === 'percent' ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                  }}>%</button>
                  <input type="number" min="0" step="any" max={discountMode === 'percent' ? 100 : undefined}
                    placeholder="0" value={discountStr} onChange={e => setDiscountStr(e.target.value)}
                    style={{ ...billInput, flex: 1 }} />
                  {discountMode === 'percent' && discountAmt > 0 && (
                    <span style={{ fontSize: 12, color: 'var(--theme-text3)', whiteSpace: 'nowrap' }}>≈ {fmtNpr(discountAmt)}</span>
                  )}
                </div>
                {discountAmt > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Discount Reason</label>
                    <select className="form-select" style={{ width: '100%' }} value={discountReason} onChange={e => setDiscountReason(e.target.value)}>
                      <option value="">— Select —</option>
                      {discountReasons.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                )}

                {!splitMode ? (
                  <>
                    {payMethod === 'Cash' && (
                      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Tender</label>
                          <input type="number" min="0" step="any" placeholder={payTotal.toFixed(0)}
                            value={tenderedStr} onChange={e => setTenderedStr(e.target.value)} style={{ ...billInput, width: '100%' }} />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Change</label>
                          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-text1)' }}>
                            {fmtNpr(Math.max(0, (parseFloat(tenderedStr) || payTotal) - payTotal))}
                          </div>
                        </div>
                      </div>
                    )}
                    {QR_PAY_METHODS.includes(payMethod) && billQrUrl && (
                      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14, padding: '10px 12px', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8 }}>
                        <img src={billQrUrl} alt="Scan to pay" style={{ width: 110, height: 110, background: '#fff', borderRadius: 6, padding: 4, flexShrink: 0 }} />
                        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.6 }}>
                          Customer scans to pay <strong>{fmtNpr(payTotal)}</strong> — the amount arrives pre-filled and locked
                          in their app, so it can't be mistyped. Confirm once you see the payment land on your merchant app.
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span style={{ color: 'var(--theme-text2)' }}>Remaining</span>
                        <span style={{ fontWeight: 700, color: remaining > 0 ? 'var(--theme-amber)' : 'var(--theme-green)' }}>{fmtNpr(remaining)}</span>
                      </div>
                      {tenders.map((t, i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, padding: '5px 0 0', marginTop: 5, borderTop: '1px solid var(--theme-border-lt)' }}>
                          <span style={{ color: 'var(--theme-text2)' }}>{t.method}</span>
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{fmtNpr(t.amount)}</span>
                            <Tip text="Prints a small courtesy slip for this payment only — not the Tax Invoice/PAN Bill, which still prints once at the end.">
                              <button onClick={() => printHtml(buildTenderSlipHtml(t, payTotal - tenders.slice(0, i + 1).reduce((s, x) => s + x.amount, 0)))}
                                style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 11, padding: 0 }}>
                                🖨
                              </button>
                            </Tip>
                            {i === tenders.length - 1 && (
                              <button onClick={undoLastTender} style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 11, textDecoration: 'underline', padding: 0 }}>
                                ↩ Undo
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>

                    {remaining > 0 && (
                      <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                          {PAYMENT_METHODS.map(m => (
                            <button key={m} onClick={() => setTenderMethod(m)}
                              className={`pay-method-btn${tenderMethod === m ? ' pay-method-btn--selected' : ''}`}>
                              {m}
                            </button>
                          ))}
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 6 }}>
                          <div style={{ flex: 1 }}>
                            <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Amount</label>
                            <input type="number" min="0" step="any" placeholder={remaining.toFixed(0)}
                              value={tenderAmtStr} onChange={e => setTenderAmtStr(e.target.value)}
                              onKeyDown={e => e.key === 'Enter' && addTender()} style={{ ...billInput, width: '100%' }} />
                          </div>
                          <button className="btn btn-ghost" onClick={addTender} disabled={!(parseFloat(tenderAmtStr) > 0)}>
                            + Add Tender
                          </button>
                        </div>
                        {tenderMethod === 'Cash' && parseFloat(tenderAmtStr) > remaining && (
                          <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 10px' }}>
                            Change due: <strong>{fmtNpr(parseFloat(tenderAmtStr) - remaining)}</strong>
                          </p>
                        )}
                        {QR_PAY_METHODS.includes(tenderMethod) && billQrUrl && (
                          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14, padding: '10px 12px', background: 'var(--theme-bg)', border: '1px solid var(--theme-border)', borderRadius: 8 }}>
                            <img src={billQrUrl} alt="Scan to pay" style={{ width: 100, height: 100, background: '#fff', borderRadius: 6, padding: 4, flexShrink: 0 }} />
                            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0, lineHeight: 1.6 }}>
                              Customer scans to pay <strong>{fmtNpr(parseFloat(tenderAmtStr) || remaining)}</strong> for this portion.
                            </p>
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </>
            )}

            {billingTab === 'void' && (
              <>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Reason</label>
                <select className="form-select" style={{ width: '100%', marginBottom: 12 }} value={closeReason} onChange={e => setCloseReason(e.target.value)}>
                  <option value="">— Select —</option>
                  {VOID_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                {orderItems.some(i => i.sent_to_kot) && (
                  <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-amber)' }}>
                    ⚠ Some items were already sent to the kitchen/bar — consider Complimentary instead so food cost isn't lost.
                  </p>
                )}
              </>
            )}

            {billingTab === 'writeoff' && (
              <>
                <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Reason</label>
                <select className="form-select" style={{ width: '100%', marginBottom: 12 }} value={closeReason} onChange={e => setCloseReason(e.target.value)}>
                  <option value="">— Select —</option>
                  {COMP_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
                <input placeholder="Remarks (optional)" value={billRemarks} onChange={e => setBillRemarks(e.target.value)} style={{ ...billInput, width: '100%', marginBottom: 12 }} />
                <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text3)' }}>
                  ₨0 is collected, but this still counts against food-cost/inventory reporting. Prints an internal
                  Complimentary Slip valued at food cost — not a Tax Invoice or PAN Bill, no outlet name shown.
                </p>
              </>
            )}
          </div>

          {/* Sticky footer — primary action + Cancel always reachable, independent of how tall the
              scrollable content above gets (e.g. a long list of split-payment tenders). */}
          <div style={{ flexShrink: 0, padding: '14px 28px 20px', borderTop: '1px solid var(--theme-border)' }}>
            {closeMsg && <p style={{ margin: '0 0 10px', fontSize: 12, color: closeMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>{closeMsg.replace(/^(error|ok):/, '')}</p>}
            {billingTab === 'pay' && (
              <button className="btn btn-primary" style={{ width: '100%', padding: '11px 0', justifyContent: 'center' }}
                onClick={() => closeOrder('paid')}
                disabled={closing || (splitMode && (remaining > 0 || tenders.length === 0)) || (discountAmt > 0 && !discountReason) || (requireBuyerId && (!buyerName.trim() || !buyerPhone.trim()))}>
                {closing ? 'Processing…'
                  : splitMode ? (remaining > 0 ? `Remaining ${fmtNpr(remaining)}` : `Complete Order — ${fmtNpr(payTotal)}`)
                  : `Confirm Payment — ${fmtNpr(payTotal)}`}
              </button>
            )}
            {billingTab === 'void' && (
              <button className="btn" style={{ width: '100%', padding: '11px 0', justifyContent: 'center', background: 'var(--theme-red)', color: '#fff', borderColor: 'var(--theme-red)' }}
                onClick={() => closeOrder('void')} disabled={closing || !closeReason}>
                {closing ? 'Processing…' : 'Void Order'}
              </button>
            )}
            {billingTab === 'writeoff' && (
              <button className="btn" style={{ width: '100%', padding: '11px 0', justifyContent: 'center', background: 'var(--theme-amber)', color: '#000', borderColor: 'var(--theme-amber)' }}
                onClick={() => closeOrder('writeoff')} disabled={closing || !closeReason}>
                {closing ? 'Processing…' : 'Mark Complimentary (₨0 collected)'}
              </button>
            )}
            <button className="btn btn-ghost" style={{ width: '100%', padding: '9px 0', justifyContent: 'center', marginTop: 8, fontSize: 13 }}
              onClick={() => setBillingOpen(false)} disabled={closing}>
              Cancel
            </button>
          </div>
          </div>
          </div>
        </div>
      )}
    </div>
  )

  /* ══════════════════════════════════════════ FLOOR VIEW */

  return (
    <>
    {/* ── Covers modal ── */}
    {coversModal && pendingTable && (
      <div
        onClick={e => { if (e.target === e.currentTarget) { setCoversModal(false); setPendingTable(null) } }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}
      >
        <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 14, padding: '28px 32px', width: 300, boxShadow: '0 16px 48px rgba(0,0,0,0.35)', textAlign: 'center' }}>

          <h3 style={{ margin: '0 0 4px', fontSize: 18, color: 'var(--theme-text1)' }}>{pendingTable.name}</h3>
          {pendingTable.section && (
            <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--theme-text3)' }}>{pendingTable.section}</p>
          )}
          <p style={{ margin: '0 0 24px', fontSize: 12, color: 'var(--theme-text3)' }}>
            {pendingTable.capacity} seat{pendingTable.capacity !== 1 ? 's' : ''}
          </p>

          <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 600, color: 'var(--theme-text2)' }}>How many covers?</p>

          <div style={{ fontSize: 48, fontWeight: 700, color: pendingCoversStr ? 'var(--theme-text1)' : 'var(--theme-text3)', letterSpacing: 4, marginBottom: 16, minHeight: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {pendingCoversStr || '—'}
          </div>

          {(() => {
            const pad = { width: 72, height: 52, borderRadius: 10, border: '1px solid var(--theme-border)', background: 'var(--theme-input-bg)', color: 'var(--theme-text1)', fontSize: 20, fontWeight: 600, cursor: 'pointer' }
            return (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 20 }}>
                {[1,2,3,4,5,6,7,8,9].map(d => (
                  <button key={d} onClick={() => numpadPress(String(d))} style={pad}>{d}</button>
                ))}
                <button onClick={numpadClear} style={{ ...pad, color: 'var(--theme-red)', fontSize: 14, fontWeight: 700 }}>CLR</button>
                <button onClick={() => numpadPress('0')} style={pad}>0</button>
                <button onClick={numpadBackspace} style={{ ...pad, fontSize: 18 }}>⌫</button>
              </div>
            )
          })()}

          <button
            className="btn btn-primary"
            style={{ width: '100%', padding: '12px 0', fontSize: 15, marginBottom: 10, justifyContent: 'center' }}
            onClick={confirmCovers}
          >
            Open Order
          </button>
          <button
            className="btn btn-danger"
            style={{ width: '100%', padding: '12px 0', fontSize: 15, justifyContent: 'center' }}
            onClick={() => { setCoversModal(false); setPendingTable(null) }}
          >
            Cancel
          </button>
        </div>
      </div>
    )}

    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>Order Taking</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
            Tap a table to open or view its order. Occupied tables show the running total.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            {isAdmin && (
              <Tip text="Testing utility — deletes every open order/item and frees all occupied tables for this client. Admin only.">
                <button
                  onClick={clearAllOccupiedTables}
                  className="btn btn-ghost"
                  style={{ fontSize: 13, flexShrink: 0, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.35)', background: 'rgba(248,113,113,0.07)' }}
                >⚠ Clear Occupied</button>
              </Tip>
            )}
            <Tip text="Today's closed bills — reprint a duplicate/triplicate copy if a customer needs one again.">
              <button
                onClick={() => { setRecentBillsOpen(true); loadRecentBills() }}
                className="btn btn-ghost"
                style={{ fontSize: 13, flexShrink: 0 }}
              >📄 Recent Bills</button>
            </Tip>
            <button className="btn btn-ghost" onClick={openTakeaway} style={{ fontSize: 13, flexShrink: 0 }}>
              + Takeaway
            </button>
          </div>
          {pendingTableCount > 0 && (
            <Tip text="Tables with items added but not yet sent to the kitchen/bar — tap the table to review and send">
              <span style={{
                fontSize: 12, fontWeight: 700, color: '#000',
                background: 'var(--theme-amber)', borderRadius: 12,
                padding: '4px 10px', cursor: 'default', whiteSpace: 'nowrap',
              }}>
                ⚠ {pendingTableCount} table{pendingTableCount !== 1 ? 's' : ''} · {pendingItemCount} item{pendingItemCount !== 1 ? 's' : ''} pending
              </span>
            </Tip>
          )}
        </div>
      </div>

      {!isOnline && (
        <div style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-amber)' }}>
          <span>📵</span>
          <span><strong>Offline</strong> — orders are saved on this device and will sync when you reconnect. Billing stays disabled until then.</span>
          {pendingOrderIds.size > 0 && (
            <span style={{ marginLeft: 'auto', background: 'rgba(251,191,36,0.15)', borderRadius: 20, padding: '2px 10px', fontWeight: 600, flexShrink: 0 }}>
              {pendingOrderIds.size} pending
            </span>
          )}
        </div>
      )}
      {syncingOffline && (
        <div style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: 'var(--theme-green)' }}>
          ⟳ Syncing {pendingOrderIds.size} {pendingOrderIds.size === 1 ? 'order' : 'orders'}…
        </div>
      )}
      {floorMsg && (
        <div style={{
          background: floorMsg.startsWith('error:') ? 'rgba(248,113,113,0.08)' : 'rgba(52,211,153,0.08)',
          border: `1px solid ${floorMsg.startsWith('error:') ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)'}`,
          borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13,
          color: floorMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)',
        }}>
          {floorMsg.replace(/^(error|ok):/, '')}
        </div>
      )}
      {conflictOrders.map(c => (
        <div key={c.order_id} style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.3)', borderRadius: 8, padding: '12px 16px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-red)' }}>
          <span>⚠</span>
          <span>
            <strong>{c.table_name}</strong>'s bill was closed on another device while you were offline —
            your queued changes ({c.items.length} item{c.items.length !== 1 ? 's' : ''}) were NOT applied.
          </span>
          <button className="btn btn-ghost" style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--theme-red)', flexShrink: 0 }}
            onClick={() => discardConflictOrder(c.order_id)}>Discard</button>
        </div>
      ))}

      {sections.length > 1 && (
        <div className="tab-bar" style={{ marginBottom: 20 }}>
          {sections.map(s => (
            <button key={s} className={`tab-btn${secFilter === s ? ' tab-btn--active' : ''}`}
              onClick={() => setSecFilter(s)}>{s}</button>
          ))}
        </div>
      )}

      {floorLoad ? (
        <p style={{ color: 'var(--theme-text3)' }}>Loading tables…</p>
      ) : tables.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
          No tables set up yet.{' '}
          <a href="/pos/tables" style={{ color: 'var(--theme-accent)' }}>Go to Table Management →</a>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
          {visTables.map(t => {
            const ord      = tableOrders[t.id]
            const inactive = t.status === 'inactive'
            return (
              <div
                key={t.id}
                className="card"
                onClick={() => !inactive && openTable(t)}
                style={{
                  padding: '16px 18px',
                  cursor: inactive ? 'default' : 'pointer',
                  opacity: inactive ? 0.4 : 1,
                  display: 'flex', flexDirection: 'column', gap: 8,
                  ...(ord ? { borderColor: 'var(--theme-accent)' } : {}),
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                  <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--theme-text1)' }}>{t.name}</span>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                    <span className={STATUS_BADGE[t.status] || 'badge-gray'} style={{ fontSize: 10 }}>
                      {STATUS_LABEL[t.status] || t.status}
                    </span>
                    {ord?.offlinePending && (
                      <Tip text="Not yet synced to the server — will upload automatically once this device reconnects">
                        <span style={{
                          fontSize: 9, fontWeight: 700, color: '#000',
                          background: 'var(--theme-amber)', borderRadius: '50%',
                          width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'default',
                        }}>
                          📵
                        </span>
                      </Tip>
                    )}
                    {ord?.pending > 0 && (
                      <Tip text="Items added but not sent to the kitchen/bar yet — tap to open and send">
                        <span style={{
                          fontSize: 9, fontWeight: 700, color: '#000',
                          background: 'var(--theme-amber)', borderRadius: 4,
                          padding: '1px 6px', cursor: 'default', whiteSpace: 'nowrap',
                        }}>
                          ⚠ {ord.pending}
                        </span>
                      </Tip>
                    )}
                  </div>
                </div>

                {t.section && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{t.section}</div>
                )}

                {ord ? (
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      {ord.itemCount} item{ord.itemCount !== 1 ? 's' : ''} · {ord.covers} cover{ord.covers !== 1 ? 's' : ''}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--theme-accent)', marginTop: 3 }}>
                      {fmtNpr(ord.total)}
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--theme-text3)' }}>👥 {t.capacity} seats</div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>

    {/* ── Recent Bills / Reprint modal ── */}
    {recentBillsOpen && (
      <div
        onClick={e => { if (e.target === e.currentTarget) setRecentBillsOpen(false) }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 300 }}
      >
        <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 14, width: 'min(480px, 96vw)', maxHeight: '80vh', display: 'flex', flexDirection: 'column', padding: '24px 28px', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}>
          <h3 style={{ margin: '0 0 4px', fontSize: 16, color: 'var(--theme-text1)' }}>Recent Bills — Today</h3>
          <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>Reprint a bill closed earlier today.</p>
          <div style={{ flex: 1, overflowY: 'auto' }}>
            {recentBillsLoad ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
            ) : recentBills.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>No bills closed yet today.</p>
            ) : recentBills.map(o => (
              <div key={o.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderBottom: '1px solid var(--theme-border)' }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>
                    {o.table_name || 'Takeaway'} {o.close_type === 'void' && <span style={{ color: 'var(--theme-red)', fontSize: 11 }}>(Void)</span>}
                    {o.close_type === 'writeoff' && <span style={{ color: 'var(--theme-amber)', fontSize: 11 }}>(Complimentary)</span>}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                    {o.invoice_no ? `Inv #${o.invoice_no}` : `Order #${o.order_no}`} · {new Date(o.closed_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {o.paid_amount != null && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{fmtNpr(o.paid_amount)}</span>}
                  {o.close_type !== 'void' && (
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => reprintBill(o)}>Reprint</button>
                  )}
                  {o.close_type === 'paid' && !o.credit_note_id && hasPosAccess('manager') && (
                    <Tip text="Issue a formal Credit Note against this bill — corrects revenue for a billing/price/tax error. Does not affect stock.">
                      <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }} onClick={() => setCreditNoteOrder(o)}>Credit Note</button>
                    </Tip>
                  )}
                </div>
              </div>
            ))}
          </div>
          <button className="btn btn-ghost" style={{ width: '100%', padding: '9px 0', justifyContent: 'center', marginTop: 14, fontSize: 13 }}
            onClick={() => setRecentBillsOpen(false)}>
            Close
          </button>
        </div>
      </div>
    )}

    {creditNoteOrder && (
      <IssueCreditNoteModal
        order={creditNoteOrder}
        onClose={() => setCreditNoteOrder(null)}
        onIssued={created => {
          setRecentBills(prev => prev.map(o => o.id === creditNoteOrder.id ? { ...o, credit_note_id: created.id } : o))
          setCreditNoteOrder(null)
        }}
      />
    )}
    </>
  )
}
