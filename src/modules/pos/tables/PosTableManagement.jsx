import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import QRCode from 'qrcode'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import Tabs, { FilterChips } from '../../../components/Tabs'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { TABLE_STATUS_BADGE as STATUS_BADGE, TABLE_STATUS_LABEL as STATUS_LABEL, tableStripColor } from '../posSignals'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import BsCalendarPicker from '../../../components/BsCalendarPicker'
import { adToBsSafe, formatBsDay, formatAd } from '../../../utils/bsCalendar'
import { turnoverByBand, dineInOnly, PARTY_BANDS } from '../reports/coversMath'
import { barCategoriesOf, NO_BAR_TEXT } from '../ticketRouting'
import { tableNameClash, quickSetupNames, quickSetupClashes, nextQuickSetupStart } from './tableNames'
import { normalizeReservationSettings, DEFAULT_RESERVATION_SETTINGS, DEFAULT_WHATSAPP_TEMPLATE } from '../reservations/reservationSettings'
import { LIVE_STATUSES, carryOverFrom } from '../reservations/reservationStatus'
import { holdingBookingLabels } from '../reservations/reservationConflicts'
import ActionError, { asActionError } from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import { errorText, errorLine } from '../../../shared/errorText'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { settleWithin } from '../../../utils/withTimeout'
import GuestMenuSetup from './GuestMenuSetup'
import PosPrintersPanel from '../printing/PosPrintersPanel'
import WeatherCityPicker from '../../dashboard/WeatherCityPicker'

const STATUS_CYCLE = ['available', 'reserved', 'occupied', 'inactive']
// This file used to carry its own byte-identical copy of the status badge/label/colour maps, which
// is how the floor plan and the setup grid could ever have disagreed. One copy now, in
// ../posSignals.js. The strip helper is the same one the live floor uses; with no order, no ticket
// and no guest request to report here, it resolves to "which tables are in play" — which is the
// only question this screen is for.

const QS_EMPTY  = { prefix: 'Table', start: 1, count: 10, section: '', capacity: 4 }
const ADD_EMPTY = { name: '', section: '', capacity: 4 }

const DEFAULT_DISCOUNT_REASONS = ['Loyalty customer', 'Promo / coupon code', 'Manager goodwill', 'Bulk / corporate order', 'Price match', 'Other']

// S835 (D41): the page's refusal for a table with bills, naming the way out. The database's own
// refusal (pos_table_has_bills) is worded in errorText.
const hasBillsText = name => `${name} has bills on record, so it can't be deleted. Take it out of service instead (set its Status to Inactive) — its bill history stays with it.`

export default function PosTableManagement() {
  const { clientId, hasPosAccess, hasWeather } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()

  const [mainTab, setMainTab] = useState('tables') // 'tables' | 'routing' | 'notes' | 'hsc' | 'discounts' | 'delivery' | 'reservations' | 'guestmenu' | 'printers' | 'weather'

  const [tables,    setTables]    = useState([])
  const [loading,   setLoading]   = useState(true)
  const [tablesError, setTablesError] = useState(null) // the last pos_tables read that failed
  const [secFilter, setSecFilter] = useState('All')
  // Transient banner above the floor grid for setTableStatus errors — that action happens directly
  // on a floor tile, outside the Add/Edit modal, so the modal's own `msg` banner isn't visible.
  const [floorMsg, setFloorMsg] = useState('')

  // Quick Setup
  const [qsOpen,   setQsOpen]   = useState(false)
  const [qs,       setQs]       = useState(QS_EMPTY)
  const [qsSaving, setQsSaving] = useState(false)
  const [qsMsg,    setQsMsg]    = useState('')

  // Add / Edit modal
  const [modal,   setModal]   = useState(false)
  const [target,  setTarget]  = useState(null)
  const [form,    setForm]    = useState(ADD_EMPTY)
  const [saving,  setSaving]  = useState(false)
  const [msg,     setMsg]     = useState('')

  // Guest menu QR (view-only digital menu, src/modules/pos/guestmenu/GuestMenu.jsx)
  const [qrTable,   setQrTable]   = useState(null) // table row currently shown in the QR modal
  const [qrDataUrl, setQrDataUrl] = useState('')

  // Ticket Routing
  const [categories,      setCategories]      = useState([])
  // S817 4i: bar categories with no dish on the till (the default Beverage where the drinks are
  // "Drinks"). Listed so they can be moved to Kitchen; before, a till kept a greyed BOT for them.
  const [dishlessCats,    setDishlessCats]    = useState(new Set())
  const [botCats,         setBotCats]         = useState(new Set(['Beverage']))
  const [routingLoading,  setRoutingLoading]  = useState(false)
  const [routingSaving,   setRoutingSaving]   = useState(false)
  const [routingMsg,      setRoutingMsg]      = useState('')
  const [routingLoaded,   setRoutingLoaded]   = useState(false)
  const [routingLoadError, setRoutingLoadError] = useState(null)

  // Quick Notes
  const [notePresets,   setNotePresets]   = useState([])
  const [newPreset,     setNewPreset]     = useState('')
  const [notesLoading,  setNotesLoading]  = useState(false)
  const [notesSaving,   setNotesSaving]   = useState(false)
  const [notesMsg,      setNotesMsg]      = useState('')
  const [notesLoaded,   setNotesLoaded]   = useState(false)

  // HSC Codes
  const [hscItems,   setHscItems]   = useState([])
  const [hscLoading, setHscLoading] = useState(false)
  const [hscLoaded,  setHscLoaded]  = useState(false)
  const [hscSaving,  setHscSaving]  = useState({})   // { recipeId: bool }
  const [hscError,   setHscError]   = useState(null) // the last HSC write that did not land
  const [hscLoadError, setHscLoadError] = useState(null) // the item list could not be read

  // Discount Reasons
  const [discReasons,   setDiscReasons]   = useState(DEFAULT_DISCOUNT_REASONS)
  const [newDiscReason, setNewDiscReason] = useState('')
  const [discLoading,   setDiscLoading]   = useState(false)
  const [discSaving,    setDiscSaving]    = useState(false)
  const [discMsg,       setDiscMsg]       = useState('')
  const [discLoaded,    setDiscLoaded]    = useState(false)

  // Delivery Partners — a client-editable list (platforms come and go), not a fixed
  // Foodmandu/Pathao pair. Each entry: { name, commission_pct, phone }. See PosOrders.jsx Credit
  // quick-select and PosCustomers.jsx settlement flow.
  const [partners,        setPartners]        = useState([])
  const [newPartnerName,  setNewPartnerName]   = useState('')
  const [deliveryLoading, setDeliveryLoading] = useState(false)
  const [deliverySaving,  setDeliverySaving]  = useState(false)
  const [deliveryMsg,     setDeliveryMsg]     = useState('')
  const [deliveryLoaded,  setDeliveryLoaded]  = useState(false)

  // Reservations (S677) — settings.pos_reservation_settings plus the outlet's public booking
  // link and QR. See src/modules/pos/reservations/reservationSettings.js for the shape.
  const [resv,         setResv]         = useState(DEFAULT_RESERVATION_SETTINGS)
  const [resvMeasured, setResvMeasured] = useState(null) // turnoverByBand over the last 90 days, or null if unread
  const [resvLoading,  setResvLoading]  = useState(false)
  const [resvSaving,   setResvSaving]   = useState(false)
  const [resvMsg,      setResvMsg]      = useState('')
  const [resvLoaded,   setResvLoaded]   = useState(false)
  const [resvLoadError, setResvLoadError] = useState(null)
  const [outletName,   setOutletName]   = useState('')
  const [bookingQrUrl, setBookingQrUrl] = useState('')
  const [newClosedDate, setNewClosedDate] = useState('') // AD iso from the BS picker, pending Add

  useEffect(() => { if (clientId) load() }, [clientId]) // eslint-disable-line

  // Each settings tab below only loads once per its own xLoaded flag — cheap while clientId is
  // stable, but those flags were never reset on an admin "view as" client switch, so a tab left
  // open across a switch kept showing (and could Save-overwrite) the PREVIOUS client's data under
  // the NEW client's id. Reset every flag here, and re-load whichever tab is currently open so a
  // switch mid-tab refreshes immediately instead of waiting for a manual tab re-click.
  useEffect(() => {
    setRoutingLoaded(false)
    setNotesLoaded(false)
    setHscLoaded(false)
    setDiscLoaded(false)
    setDeliveryLoaded(false)
    setResvLoaded(false)
    // S754: the reservation form also drops the previous client's values, not only its flag — the
    // booking QR and outlet name are rendered from state, and a load error belongs to the old id.
    setResv(DEFAULT_RESERVATION_SETTINGS)
    setResvMeasured(null)
    setOutletName('')
    setBookingQrUrl('')
    setResvLoadError(null)
    setRoutingLoadError(null)
    setHscLoadError(null)
    if (!clientId) return
    if (mainTab === 'routing') loadRouting()
    else if (mainTab === 'notes') loadNotePresets()
    else if (mainTab === 'hsc') loadHscItems()
    else if (mainTab === 'discounts') loadDiscReasons()
    else if (mainTab === 'delivery') loadDeliverySettings()
    else if (mainTab === 'reservations') loadReservationSettings()
  }, [clientId]) // eslint-disable-line

  if (!hasPosAccess('manager')) return <Navigate to="/pos" replace />

  async function load() {
    setLoading(true)
    const { data, error } = await scopedFrom('pos_tables')
      .order('sort_order').order('name')
    // S754: a failed read is not an empty floor. Rendering it as zero tables auto-opened Quick
    // Setup, and Generate then created a second Table 1–10 beside the real ones. The grid, the
    // counts and Quick Setup all stand down until a read succeeds.
    if (error) { setTables([]); setTablesError(error); setLoading(false); return }
    setTablesError(null)
    const rows = data || []
    setTables(rows)
    if (rows.length === 0) setQsOpen(true)
    setLoading(false)
  }

  const existingSections = Array.from(new Set(tables.map(t => t.section).filter(Boolean)))
  const sections  = ['All', ...existingSections]
  const visible   = secFilter === 'All' ? tables : tables.filter(t => t.section === secFilter)
  const counts    = {
    available: tables.filter(t => t.status === 'available').length,
    occupied:  tables.filter(t => t.status === 'occupied').length,
    reserved:  tables.filter(t => t.status === 'reserved').length,
  }

  // ── Quick Setup ──────────────────────────────────────────────────────────────

  function qsPreview() {
    const n = Math.max(0, parseInt(qs.count, 10) || 0)
    const s = parseInt(qs.start, 10) || 1
    const p = qs.prefix.trim() || 'Table'
    if (n === 0) return '—'
    if (n <= 5) return Array.from({ length: n }, (_, i) => `${p} ${s + i}`).join(', ')
    return `${p} ${s}, ${p} ${s + 1}, ${p} ${s + 2} … ${p} ${s + n - 1}`
  }
  // S817 4i (FLOOR-KITCHEN-8): the names this batch would give a second table in service. Shown under
  // the preview as the numbers change, and Generate refuses them (so does the database).
  const qsClashes = qs.prefix.trim() ? quickSetupClashes(quickSetupNames(qs), tables) : []
  const qsClashText = qsClashes.length === 0 ? ''
    : `Already on the floor: ${qsClashes.slice(0, 5).join(', ')}${qsClashes.length > 5 ? ` and ${qsClashes.length - 5} more` : ''} — change Start # or the prefix.`

  // Quick Setup opens on the next free number for its prefix (S817 4i): its defaults used to recreate
  // "Table 1–10" on a floor that already had them. The Start box follows the prefix until it is typed in.
  function openQuickSetup() {
    setQs({ ...QS_EMPTY, start: nextQuickSetupStart(QS_EMPTY.prefix, tables) })
    setQsMsg('')
    setQsOpen(true)
  }

  async function handleGenerate() {
    const count = parseInt(qs.count, 10) || 0
    if (!qs.prefix.trim()) { setQsMsg('error:Prefix is required.'); return }
    if (count < 1 || count > 50) { setQsMsg('error:Count must be 1–50.'); return }
    if (qsClashes.length > 0) { setQsMsg('error:' + qsClashText); return }
    if (!clientId) return
    setQsSaving(true); setQsMsg('')
    const start = parseInt(qs.start, 10) || 1
    const rows = quickSetupNames(qs).map((name, i) => ({
      name,
      section:    qs.section.trim() || null,
      capacity:   parseInt(qs.capacity, 10) || 4,
      sort_order: start + i,
    }))
    const { error } = await scopedInsert('pos_tables', rows)
    // S817 4i: it said "The quick-service setting was not saved" for a failed table insert.
    if (error) { setQsMsg('error:No tables were created. ' + errorLine(error)); setQsSaving(false); return }
    await load()
    setQsMsg(`ok:Created ${count} table${count !== 1 ? 's' : ''}.`)
    setQsSaving(false)
    setQs(QS_EMPTY)
  }

  // ── Add / Edit ───────────────────────────────────────────────────────────────

  function openAdd() {
    setTarget(null)
    setForm({ ...ADD_EMPTY })
    setMsg(''); setModal(true)
  }
  function openEdit(t) {
    setTarget(t)
    setForm({ name: t.name, section: t.section || '', capacity: t.capacity ?? 4, sort_order: t.sort_order ?? 0 })
    setMsg(''); setModal(true)
  }
  function closeModal() { setModal(false); setTarget(null) }

  async function handleSave() {
    if (!form.name.trim()) { setMsg('error:Table name is required.'); return }
    if (!clientId) return
    // S817 4i (FLOOR-KITCHEN-8): no second table in service with this name (a retired table's name may
    // be used again), and no rename while the table has an open bill (D20) — the bill and its earlier
    // kitchen tickets would keep the old name. The database refuses both too.
    const name = form.name.trim()
    const clash = (!target || target.status !== 'inactive') ? tableNameClash(name, tables, target?.id) : null
    if (clash) { setMsg(`error:${clash.name} already has that name on the floor — two tables with one name cannot be told apart on a ticket. Give this one another name.`); return }
    setSaving(true); setMsg('')
    if (target && name !== target.name) {
      const { bill, error: billErr } = await openBillOn(target.id)
      if (billErr) { setMsg('error:The table was not renamed — could not check whether it has an open bill. ' + errorLine(billErr)); setSaving(false); return }
      if (bill) { setMsg(`error:${target.name} has an open bill (order #${bill.order_no ?? '?'}). Rename it once that bill is closed, so the bill and its kitchen tickets keep one name.`); setSaving(false); return }
    }
    const payload = {
      name:       form.name.trim(),
      section:    form.section.trim() || null,
      capacity:   parseInt(form.capacity, 10) || 4,
      ...(target ? { sort_order: parseInt(form.sort_order, 10) || 0 } : {}),
    }
    const { error } = target
      ? await scopedUpdate('pos_tables', payload).eq('id', target.id)
      : await scopedInsert('pos_tables', payload)
    if (error) { setMsg('error:' + (target ? 'The table was not updated.' : 'The table was not added.') + ' ' + errorLine(error)); setSaving(false); return }
    await load(); closeModal(); setSaving(false)
  }

  async function handleDelete() {
    if (!target) return
    // Three references, three behaviours, none visible from the button (S682, corrected S754):
    // pos_reservation_tables cascades only the LINK, so a booking survives with this table taken
    // off it; pos_guest_order_requests is a plain FK and refuses the delete (worded in errorText);
    // pos_orders.table_id has no FK at all, so a bill would outlive its table — which is why this
    // reads for one first.
    // S818 RESERVATIONS-11: once the link is gone nothing records which bookings lost the table, so
    // they are named here, before the delete. A check that could not run has not passed.
    // S835 (D41, owner decision): a table with ANY bill on record, open or closed, is not deleted; it
    // is taken out of service (Inactive), so its bill history stays tied to it. The database refuses
    // it too (pos_table_has_bills, worded in errorText); this asks before the confirm, so the Owner is
    // not asked to confirm a delete that cannot happen.
    setMsg('')
    const t = target
    const [{ labels, error: holdErr }, { count: billCount, error: billErr }] = await Promise.all([bookingsHolding(t.id), billsOn(t.id)])
    if (billErr) { setMsg('error:"' + t.name + '" was not deleted — could not check whether it has bills on record. ' + errorLine(billErr)); return }
    if (billCount > 0) { setMsg('error:' + hasBillsText(t.name)); return }
    if (holdErr) { setMsg('error:"' + t.name + '" was not deleted — could not check which bookings hold it. ' + errorLine(holdErr)); return }
    askConfirm({
      title: `Delete "${target.name}"?`,
      confirmLabel: 'Delete Table', danger: true, busyLabel: 'Deleting…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>The table leaves the floor plan and its QR code stops working.</p>
          {labels.length > 0 ? (<>
            <p style={{ margin: '0 0 4px' }}>
              <strong>{labels.length === 1 ? 'One booking still to come holds it and will lose it' : `${labels.length} bookings still to come hold it and will lose it`}</strong> — give
              {labels.length === 1 ? ' it' : ' each'} another table on the Reservations page:
            </p>
            <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>{labels.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </>) : (
            <p style={{ margin: '0 0 8px' }}>No booking still to come holds it.</p>
          )}
          <p style={{ margin: '0 0 8px' }}>
            A table that has ever had a bill or a QR guest order cannot be deleted — take that one out of service
            (Inactive) instead, and its history stays with it.
          </p>
          <p style={{ margin: 0 }}>This cannot be undone.</p>
        </>
      ),
      run: async () => {
        // S754, widened S835 (D41): the page half of the guard (pos_table_has_bills is the database's),
        // read again here because a bill can be opened on it while this dialog is up. A check that
        // could not run has not passed, so a failed read refuses the delete rather than waving it through.
        const { count, error: countErr } = await billsOn(t.id)
        if (countErr) { setMsg('error:"' + t.name + '" was not deleted — could not check whether it has bills on record. ' + errorLine(countErr)); return }
        if (count > 0) { setMsg('error:' + hasBillsText(t.name)); return }
        // .select('id'): a delete RLS refuses matches zero rows with no error, which would otherwise
        // close the dialog as though it had worked.
        const { data: deleted, error } = await scopedDelete('pos_tables').eq('id', t.id).select('id')
        if (error) { setMsg('error:"' + t.name + '" was not deleted — it is still on the floor. ' + errorLine(error)); return }
        if (!deleted?.length) { setMsg('error:"' + t.name + '" was not deleted — this account may not remove tables, or it was already removed on another device. Reload the page to check.'); return }
        await load(); closeModal()
      },
    })
  }

  // S835 (D41). How many bills, of any status, name this table. A head count: no rows travel. Bounded,
  // because the confirm waits on it and a busy confirm cannot be cancelled; a timeout is a failed check.
  async function billsOn(tableId) {
    const { count, error } = await settleWithin(
      scopedFrom('pos_orders', 'id', { count: 'exact', head: true }).eq('table_id', tableId), 15000, 'Bill check')
    return { count: count ?? 0, error }
  }

  // ── Guest Menu QR ────────────────────────────────────────────────────────────
  // The QR just encodes this table's own guest-menu URL — no new column/token needed, the
  // table's id is already a UUID and the page itself (GuestMenu.jsx) does its own authorization
  // via get_guest_menu (checks pos_enabled, only ever returns safe/whitelisted columns).

  function guestMenuUrl(t) {
    return `${window.location.origin}/pos/menu/${t.id}`
  }

  async function openQr(t, e) {
    e?.stopPropagation()
    setQrTable(t)
    setQrDataUrl('')
    const url = await QRCode.toDataURL(guestMenuUrl(t), { margin: 1, width: 240 })
    setQrDataUrl(url)
  }

  function printQr() {
    if (!qrTable || !qrDataUrl) return
    // noopener as a window.open feature makes the call return null (no way to then write/print/
    // close the popup) — sever window.opener manually instead, on the reference we keep, for the
    // same "can't reach back into the live app" protection without losing that reference.
    const w = window.open('', '_blank', 'width=380,height=520,left=200,top=100')
    if (!w) return
    w.opener = null
    w.document.write(`
      <html><head><title>${esc(qrTable.name)} — Menu QR</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:24px">
        <h2 style="margin:0 0 4px">${esc(qrTable.name)}</h2>
        <p style="margin:0 0 20px;color:#555;font-size:13px">Scan for our menu</p>
        <img src="${qrDataUrl}" style="width:240px;height:240px" />
      </body></html>
    `)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print(); w.close() }, 300)
  }

  // S817 4i (FLOOR-KITCHEN-7). A table's open bill, read before a status change or a rename the
  // database refuses under one (pos_tables_guard_open_bill). A check that could not run has not passed.
  async function openBillOn(tableId) {
    const { data, error } = await scopedFrom('pos_orders', 'id, order_no').eq('table_id', tableId).eq('status', 'open').limit(1)
    return { bill: data?.[0] || null, error }
  }

  // S818 RESERVATIONS-11. The bookings still to come that hold this table, worded for a confirm. A
  // deleted table's links cascade away and an inactive table cannot be picked at seating, so both are
  // asked about first. Reaches back the longest booking so one already running is seen.
  async function bookingsHolding(tableId) {
    const { data, error } = await scopedFrom('pos_reservations',
      'id, customer_name, party_size, reserved_for, duration_minutes, status, pos_reservation_tables!inner(table_id)')
      .eq('pos_reservation_tables.table_id', tableId)
      .in('status', LIVE_STATUSES)
      .gte('reserved_for', carryOverFrom(new Date().toISOString()))
      .order('reserved_for').order('id')
    return error ? { labels: [], error } : { labels: holdingBookingLabels(data), error: null }
  }

  // S818 (D26): Inactive while bookings still to come hold the table asks first, naming them, then
  // goes ahead. They keep the table, marked out of service on the Reservations page, until re-tabled.
  // Returns a refusal sentence, or null once the change has been handed to `apply` (now or on confirm).
  async function retireOrAsk(t, apply) {
    const { labels, error } = await bookingsHolding(t.id)
    if (error) return `${t.name} was not changed — could not check which bookings hold it. ${errorLine(error)}`
    if (labels.length === 0) { await apply(); return null }
    askConfirm({
      title: `Take ${t.name} out of service?`,
      confirmLabel: 'Mark Inactive', busyLabel: 'Saving…',
      body: (
        <>
          <p style={{ margin: '0 0 4px' }}>
            {labels.length === 1 ? 'One booking still to come holds' : `${labels.length} bookings still to come hold`} {t.name}:
          </p>
          <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>{labels.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <p style={{ margin: 0 }}>
            They keep it, marked out of service on the Reservations page, and cannot be seated at it. Give
            {labels.length === 1 ? ' it' : ' each'} another table there.
          </p>
        </>
      ),
      run: apply,
    })
    return null
  }

  // Why a status change must not happen, or null. Inactive under an open bill left the floor refusing
  // every tap on the table, and Available under one offered it to the next walk-in; a table brought
  // back into service must not take a name another table in service already has.
  async function statusRefusal(t, next) {
    if (next === 'inactive' || next === 'available') {
      const { bill, error } = await openBillOn(t.id)
      if (error) return `${t.name} was not changed — could not check whether it has an open bill. ${errorLine(error)}`
      if (bill) return `${t.name} has an open bill (order #${bill.order_no ?? '?'}), so it stays ${STATUS_LABEL[t.status] || t.status} — bill or void it first.`
    }
    if (t.status === 'inactive' && next !== 'inactive') {
      const clash = tableNameClash(t.name, tables, t.id)
      if (clash) return `${t.name} was not brought back — another table in service is already called ${clash.name}. Rename one of them first.`
    }
    return null
  }

  async function setTableStatus(t, next) {
    if (next === t.status) return
    setFloorMsg('')
    const refusal = await statusRefusal(t, next)
    if (refusal) { setFloorMsg('error:' + refusal); return }
    const apply = async () => {
      const { error } = await scopedUpdate('pos_tables', { status: next }).eq('id', t.id)
      if (error) { setFloorMsg('error:' + t.name + ' was not updated — the floor still shows its previous state. ' + errorLine(error)); return }
      setTables(prev => prev.map(r => r.id === t.id ? { ...r, status: next } : r))
    }
    if (next !== 'inactive') { await apply(); return }
    const retireRefusal = await retireOrAsk(t, apply)
    if (retireRefusal) setFloorMsg('error:' + retireRefusal)
  }

  async function handleStatusChange(val) {
    if (val === target.status) return
    setMsg('')
    const t = target
    const refusal = await statusRefusal(t, val)
    if (refusal) { setMsg('error:' + refusal); return }
    const apply = async () => {
      const { error } = await scopedUpdate('pos_tables', { status: val }).eq('id', t.id)
      if (error) { setMsg('error:The table status was not changed — the floor still shows its previous state. ' + errorLine(error)); return }
      setTables(prev => prev.map(r => r.id === t.id ? { ...r, status: val } : r))
      setTarget(cur => (cur?.id === t.id ? { ...cur, status: val } : cur))
    }
    if (val !== 'inactive') { await apply(); return }
    const retireRefusal = await retireOrAsk(t, apply)
    if (retireRefusal) setMsg('error:' + retireRefusal)
  }

  // ── Ticket Routing ───────────────────────────────────────────────────────────

  async function loadRouting() {
    setRoutingLoading(true); setRoutingLoadError(null)
    const [{ data: recipeData, error: rErr }, { data: settingsData, error: sErr }] = await Promise.all([
      // Same nullable-column rule as below, though nothing changes here in practice: a NULL
      // category contributes no routing category either way (`.filter(Boolean)`). Written the safe
      // way so the next reader does not have to work that out (S714).
      scopedFrom('recipes', 'category').eq('pos_enabled', true).or('category.is.null,category.neq.Sub-Recipe'),
      supabase.from('settings').select('pos_bot_categories').eq('client_id', clientId).maybeSingle(),
    ])
    // S754: either read failing leaves the ['Beverage'] default on screen, and Save writes the
    // WHOLE on-screen set — so a failed read followed by Save re-routed every real bar category
    // to the kitchen. Stay not-loaded; Save stays disabled; re-opening the tab retries.
    if (rErr || sErr) { setRoutingLoadError(loadFailedError('the ticket routing', rErr || sErr)); setRoutingLoading(false); return }
    const dishCats = new Set((recipeData || []).map(r => r.category).filter(Boolean))
    // Never set means the Beverage default; an empty list is a saved "no bar" (S809 3m, Q15), and
    // every till reads it the same way now (ticketRouting.js).
    const bar = barCategoriesOf(settingsData?.pos_bot_categories)
    // S817 4i: a bar category with no dish on the till is listed too, so it can be moved to Kitchen.
    setCategories(Array.from(new Set([...dishCats, ...bar])).sort())
    setDishlessCats(new Set(bar.filter(c => !dishCats.has(c))))
    setBotCats(new Set(bar))
    setRoutingLoading(false)
    setRoutingLoaded(true)
  }

  function openRoutingTab() {
    setMainTab('routing')
    if (!routingLoaded) loadRouting()
  }

  function toggleCat(cat, station) {
    setRoutingMsg('')
    setBotCats(prev => {
      const next = new Set(prev)
      if (station === 'BOT') next.add(cat)
      else next.delete(cat)
      return next
    })
  }

  async function saveRouting() {
    if (!clientId) return   // guard the admin "no client selected" window: client_id:null would write the global-defaults row
    setRoutingSaving(true); setRoutingMsg('')
    const botArr = Array.from(botCats)
    const { data: existing, error: existErr } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error = existErr || null
    if (!error && existing?.id) {
      ;({ error } = await supabase.from('settings').update({ pos_bot_categories: botArr }).eq('id', existing.id))
    } else if (!error) {
      // A failed existing-row read must NOT fall into insert (S613) — that writes a second
      // settings row for the client and splits every settings read after it.
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, pos_bot_categories: botArr }))
    }
    setRoutingSaving(false)
    setRoutingMsg(error ? 'error:The ticket routing was not saved — kitchen and bar still print as before. ' + errorLine(error) : 'ok:Routing saved.')
  }

  // ── Quick Notes ──────────────────────────────────────────────────────────────

  // Each settings tab below loads the client's list, edits it on screen, and its Save writes the
  // WHOLE on-screen array back. So a loader that drops its error and substitutes a stub is not a
  // display bug: a failed read followed by a routine Save replaced the client's real quick notes,
  // discount reasons or delivery commission rates with the stub, and said "Saved." (S682). On a
  // failed read the tab now stays "not loaded" — Save is disabled — and says so; re-opening the
  // tab retries.
  const loadFailed = what => error =>
    `error:Could not load ${what} — Save is disabled until it loads. Re-open this tab to retry. ` + errorText(error, 'operator')
  // The same sentence as an ActionError object (S754), for the tabs whose failed read replaces the
  // tab body rather than riding beside Save — an empty-state card there would be a claim about the
  // client ("no categories"), and the object form keeps the technical detail as fine print.
  const loadFailedError = (what, error) => {
    const { text, detail } = asActionError(error)
    return { text: `Could not load ${what} — Save is disabled until it loads. Re-open this tab to retry. ${text}`, detail }
  }

  async function loadNotePresets() {
    setNotesLoading(true)
    const { data, error } = await supabase.from('settings').select('pos_note_presets').eq('client_id', clientId).maybeSingle()
    setNotesLoading(false)
    if (error) { setNotesMsg(loadFailed('the quick notes')(error)); return }
    setNotePresets(data?.pos_note_presets || [])
    setNotesMsg('')
    setNotesLoaded(true)
  }

  function openNotesTab() {
    setMainTab('notes')
    if (!notesLoaded) loadNotePresets()
  }

  function addPreset() {
    const v = newPreset.trim()
    if (!v || notePresets.includes(v)) { setNewPreset(''); return }
    setNotePresets(prev => [...prev, v])
    setNewPreset('')
    setNotesMsg('')
  }

  function removePreset(p) {
    setNotePresets(prev => prev.filter(x => x !== p))
    setNotesMsg('')
  }

  async function saveNotePresets() {
    if (!clientId) return
    setNotesSaving(true); setNotesMsg('')
    const { data: existing, error: existErr } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error = existErr || null
    if (!error && existing?.id) {
      ;({ error } = await supabase.from('settings').update({ pos_note_presets: notePresets }).eq('id', existing.id))
    } else if (!error) {
      // A failed existing-row read must NOT fall into insert (S613) — that writes a second
      // settings row for the client and splits every settings read after it.
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, pos_note_presets: notePresets }))
    }
    setNotesSaving(false)
    setNotesMsg(error ? 'error:The quick notes were not saved — the till still offers the previous list. ' + errorLine(error) : 'ok:Quick notes saved.')
  }

  // ── HSC Codes ────────────────────────────────────────────────────────────────

  async function loadHscItems() {
    setHscLoading(true); setHscLoadError(null)
    const { data, error } = await scopedFrom('recipes', 'id, name, category, hsc_code')
      .eq('is_active', true).eq('pos_enabled', true)
      // `.or(...)`, not `.neq` — category is nullable and a server-side .neq drops NULL rows,
      // hiding an uncategorised dish from HSC code assignment (S714).
      .or('category.is.null,category.neq.Sub-Recipe').order('name')
    // S754: a failed read is not "No POS-enabled menu items" — that card sends the owner to Menu
    // Pricing to switch on dishes that are already on. Stay not-loaded so re-opening retries.
    if (error) {
      const { text, detail } = asActionError(error)
      setHscLoadError({ text: `Could not load the menu items, so no HSC codes are shown. Re-open this tab to retry. ${text}`, detail })
      setHscItems([]); setHscLoading(false)
      return
    }
    setHscItems(data || [])
    setHscLoading(false)
    setHscLoaded(true)
  }

  function openHscTab() {
    setMainTab('hsc')
    if (!hscLoaded) loadHscItems()
  }

  async function saveHsc(recipe, value) {
    const trimmed = value.trim()
    if (trimmed === (recipe.hsc_code || '')) return
    setHscSaving(s => ({ ...s, [recipe.id]: true })); setHscError(null)
    // The HSC code prints on the IRD Tax Invoice, so an optimistic write here is the wrong kind
    // of optimism: a refused update used to show the new code as saved while every bill kept
    // printing the old one (S682). State only follows a write that landed.
    const { error } = await scopedUpdate('recipes', { hsc_code: trimmed || null }).eq('id', recipe.id)
    if (error) {
      const { text, detail } = asActionError(error)
      setHscError({ text: `The HSC code for ${recipe.name} was not saved — bills still print "${recipe.hsc_code || 'none'}". ${text}`, detail })
    } else {
      setHscItems(items => items.map(r => r.id === recipe.id ? { ...r, hsc_code: trimmed || null } : r))
    }
    setHscSaving(s => ({ ...s, [recipe.id]: false }))
  }

  // ── Discount Reasons ────────────────────────────────────────────────────────

  async function loadDiscReasons() {
    setDiscLoading(true)
    const { data, error } = await supabase.from('settings').select('pos_discount_reasons').eq('client_id', clientId).maybeSingle()
    setDiscLoading(false)
    if (error) { setDiscMsg(loadFailed('the discount reasons')(error)); return }
    setDiscReasons(data?.pos_discount_reasons?.length ? data.pos_discount_reasons : DEFAULT_DISCOUNT_REASONS)
    setDiscMsg('')
    setDiscLoaded(true)
  }

  function openDiscountsTab() {
    setMainTab('discounts')
    if (!discLoaded) loadDiscReasons()
  }

  function addDiscReason() {
    const v = newDiscReason.trim()
    if (!v || discReasons.includes(v)) { setNewDiscReason(''); return }
    setDiscReasons(prev => [...prev, v])
    setNewDiscReason('')
    setDiscMsg('')
  }

  function removeDiscReason(r) {
    setDiscReasons(prev => prev.filter(x => x !== r))
    setDiscMsg('')
  }

  async function saveDiscReasons() {
    if (!clientId) return
    setDiscSaving(true); setDiscMsg('')
    const { data: existing, error: existErr } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error = existErr || null
    if (!error && existing?.id) {
      ;({ error } = await supabase.from('settings').update({ pos_discount_reasons: discReasons }).eq('id', existing.id))
    } else if (!error) {
      // A failed existing-row read must NOT fall into insert (S613) — that writes a second
      // settings row for the client and splits every settings read after it.
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, pos_discount_reasons: discReasons }))
    }
    setDiscSaving(false)
    setDiscMsg(error ? 'error:The discount reasons were not saved — the till still offers the previous list. ' + errorLine(error) : 'ok:Discount reasons saved.')
  }

  // ── Delivery Partners ────────────────────────────────────────────────────────
  // A client-editable list, not a fixed Foodmandu/Pathao pair — new aggregators can be added, and
  // ones a client stops using can be removed, without a code/schema change. Commission % is only a
  // starting suggestion shown when settling that partner's Credit bill (PosCustomers.jsx) — never
  // applied automatically at Charge. Phone is the sentinel number the Credit quick-select chip
  // fills into buyer_phone (PosOrders.jsx), so every order from that platform groups under one
  // pos_customers row despite there being no real customer phone.

  async function loadDeliverySettings() {
    setDeliveryLoading(true)
    const { data, error } = await supabase.from('settings')
      .select('pos_delivery_partners').eq('client_id', clientId).maybeSingle()
    setDeliveryLoading(false)
    if (error) { setDeliveryMsg(loadFailed('the delivery partners')(error)); return }
    setPartners(data?.pos_delivery_partners ?? [
      { name: 'Foodmandu', commission_pct: '', phone: '9800000001' },
      { name: 'Pathao',    commission_pct: '', phone: '9800000002' },
    ])
    setDeliveryMsg('')
    setDeliveryLoaded(true)
  }

  function openDeliveryTab() {
    setMainTab('delivery')
    if (!deliveryLoaded) loadDeliverySettings()
  }

  function addPartner() {
    const v = newPartnerName.trim()
    if (!v || partners.some(p => p.name.toLowerCase() === v.toLowerCase())) { setNewPartnerName(''); return }
    setPartners(prev => [...prev, { name: v, commission_pct: '', phone: '' }])
    setNewPartnerName('')
    setDeliveryMsg('')
  }

  function updatePartner(idx, field, value) {
    setPartners(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p))
    setDeliveryMsg('')
  }

  function removePartner(idx) {
    setPartners(prev => prev.filter((_, i) => i !== idx))
    setDeliveryMsg('')
  }

  async function saveDeliverySettings() {
    if (!clientId) return
    setDeliverySaving(true); setDeliveryMsg('')
    const cleaned = partners
      .map(p => ({
        name: (p.name || '').trim(),
        commission_pct: p.commission_pct === '' || p.commission_pct == null ? null : parseFloat(p.commission_pct),
        phone: (p.phone || '').trim(),
      }))
      .filter(p => p.name)
    const payload = { pos_delivery_partners: cleaned }
    const { data: existing, error: existErr } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error = existErr || null
    if (!error && existing?.id) {
      ;({ error } = await supabase.from('settings').update(payload).eq('id', existing.id))
    } else if (!error) {
      // A failed existing-row read must NOT fall into insert (S613) — that writes a second
      // settings row for the client and splits every settings read after it.
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, ...payload }))
    }
    setPartners(cleaned)
    setDeliverySaving(false)
    setDeliveryMsg(error ? 'error:The delivery partners were not saved — settling a platform bill still uses the previous commission rates. ' + errorLine(error) : 'ok:Delivery partner settings saved.')
  }

  // ── Reservations ──────────────────────────────────────────────────────────────
  // Expected sitting length per party size (prefilled from the outlet's own measured turn times,
  // the Covers Report's Turnover Time arithmetic), the late/seat windows, the WhatsApp message
  // template, and the public booking link — the QR a customer scans to request a table.

  function bookingUrl() { return `${window.location.origin}/pos/book/${clientId}` }

  async function loadReservationSettings() {
    setResvLoading(true); setResvMsg(''); setResvLoadError(null)
    const since = new Date(Date.now() - 90 * 86400000).toISOString()
    const [{ data: s, error: sErr }, { data: client }, { data: orders, error: oErr }] = await Promise.all([
      supabase.from('settings').select('pos_reservation_settings').eq('client_id', clientId).maybeSingle(),
      supabase.from('clients').select('name').eq('id', clientId).maybeSingle(),
      // 90 days of paid bills crosses 1000 rows on a busy outlet — paged, unique tiebreaker.
      // `part_of_order_id` (S836) is read so dineInOnly sees a part bill as dine-in, as the Covers
      // Report does; turnoverByBand then leaves it out, because it is not a sitting of its own.
      fetchAllRows(() => scopedFrom('pos_orders', 'id, table_id, part_of_order_id, covers, opened_at, closed_at').eq('close_type', 'paid').gte('closed_at', since).order('id')),
    ])
    // S754: on a failed settings read the form still holds DEFAULT_RESERVATION_SETTINGS, and Save
    // writes the whole object — so one routine Save replaced the outlet's real hours, closures and
    // template with the defaults. Stay not-loaded (Save disabled) and say so in the operator's words.
    if (sErr) { setResvLoadError(loadFailedError('the reservation settings', sErr)); setResvLoading(false); return }
    setResv(normalizeReservationSettings(s?.pos_reservation_settings))
    setOutletName(client?.name || '')
    // The measured figure is a hint beside the field, not the field — a failed read drops the
    // hint, never the tab.
    // S754: dine-in only, the same rule as the Covers Report — a takeaway bill is one "cover" that
    // never held a table, and it dragged the 1–2 band's measured turn time down.
    setResvMeasured(oErr ? null : turnoverByBand(dineInOnly(orders)))
    setResvLoading(false)
    setResvLoaded(true)
    QRCode.toDataURL(bookingUrl(), { margin: 1, width: 240 }).then(setBookingQrUrl).catch(() => setBookingQrUrl(''))
  }

  function openReservationsTab() {
    setMainTab('reservations')
    if (!resvLoaded) loadReservationSettings()
  }

  // The section row's one handler (S841): a section that reads on first open keeps its own opener.
  function openSection(key) {
    const opener = {
      routing: openRoutingTab, notes: openNotesTab, hsc: openHscTab,
      discounts: openDiscountsTab, delivery: openDeliveryTab, reservations: openReservationsTab,
    }[key]
    if (opener) opener()
    else setMainTab(key)
  }

  function setResvField(key, value) { setResv(prev => ({ ...prev, [key]: value })); setResvMsg('') }
  function setResvBand(key, value)  { setResv(prev => ({ ...prev, duration_by_band: { ...prev.duration_by_band, [key]: value } })); setResvMsg('') }
  function toggleResvWeekday(key, n) {
    setResv(prev => {
      const has = (prev[key] || []).includes(n)
      const next = has ? (prev[key] || []).filter(x => x !== n) : [...(prev[key] || []), n].sort((a, b) => a - b)
      // A day cannot be both closed and walk-in only; ticking one clears the other.
      const other = key === 'closed_weekdays' ? 'walk_in_weekdays' : 'closed_weekdays'
      return { ...prev, [key]: next, [other]: (prev[other] || []).filter(x => x !== n || has) }
    })
    setResvMsg('')
  }
  function addClosedDate() {
    if (!newClosedDate) return
    setResv(prev => ({ ...prev, closed_dates: [...new Set([...(prev.closed_dates || []), newClosedDate])].sort() }))
    setNewClosedDate('')
    setResvMsg('')
  }
  function removeClosedDate(iso) {
    setResv(prev => ({ ...prev, closed_dates: (prev.closed_dates || []).filter(d => d !== iso) }))
    setResvMsg('')
  }
  const closedDateLabel = iso => {
    const bs = adToBsSafe(new Date(iso + 'T00:00:00'))
    return bs ? `${formatBsDay(bs.day, bs.month)} ${bs.year} · ${iso}` : iso
  }

  async function saveReservationSettings() {
    if (!clientId) return
    setResvSaving(true); setResvMsg('')
    const cleaned = normalizeReservationSettings(resv)
    const payload = { pos_reservation_settings: cleaned }
    const { data: existing, error: existErr } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error = existErr || null
    if (!error && existing?.id) {
      ;({ error } = await supabase.from('settings').update(payload).eq('id', existing.id))
    } else if (!error) {
      // A failed existing-row read must NOT fall into insert (S613) — a second settings row
      // splits every settings read after it.
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, ...payload }))
    }
    setResv(cleaned)
    setResvSaving(false)
    setResvMsg(error ? 'error:The reservation settings were not saved — the public booking page still uses the previous hours and closures. ' + errorLine(error) : 'ok:Reservation settings saved.')
  }

  async function copyBookingUrl() {
    try { await navigator.clipboard.writeText(bookingUrl()); setResvMsg('ok:Booking link copied.') }
    catch { setResvMsg('error:Could not copy — select the link below and copy it by hand.') }
  }

  function printBookingQr() {
    if (!bookingQrUrl) return
    // Same popup shape as printQr above: sever window.opener on the kept reference rather than
    // passing noopener as a feature, which would return null and leave nothing to print.
    const w = window.open('', '_blank', 'width=380,height=560,left=200,top=100')
    if (!w) return
    w.opener = null
    w.document.write(`
      <html><head><title>${esc(outletName)} — Book a table</title></head>
      <body style="font-family:sans-serif;text-align:center;padding:24px">
        <h2 style="margin:0 0 4px">${esc(outletName)}</h2>
        <p style="margin:0 0 20px;color:#555;font-size:13px">Scan to book a table</p>
        <img src="${bookingQrUrl}" style="width:240px;height:240px" />
        <p style="margin:16px 0 0;color:#555;font-size:11px;word-break:break-all">${esc(bookingUrl())}</p>
      </body></html>
    `)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print(); w.close() }, 300)
  }

  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div>

      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">POS Setup</h1>
          <p className="page-subtitle">
            Set up your floor plan and configure ticket routing for the kitchen and bar.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {/* The header spans every tab, so the Tables tab's own condition rides on `show`. */}
          <Fab show={mainTab === 'tables' && tables.length > 0} onClick={openAdd} label="+ Add Table" />
        </div>
      </div>

      {/* Main tab bar. `Tabs` since S841, so the open section is announced rather than shown by its
          tint alone. A section's hint rides as its tab's `title`: a Tip around a tab is not the tab. */}
      <Tabs idBase="pos-setup" label="POS Setup sections" active={mainTab} style={{ marginBottom: 24 }}
        onChange={openSection}
        tabs={[
          { key: 'tables', label: 'Tables' },
          { key: 'routing', label: 'Ticket Routing', title: 'Assign each menu category to KOT (kitchen) or BOT (bar) — controls where the ticket prints when staff send an order' },
          { key: 'notes', label: 'Quick Notes', title: "Preset instruction chips (e.g. 'No onion', 'Extra spicy') staff can tap on an order item instead of typing — prints under that item on the KOT/BOT" },
          { key: 'hsc', label: 'HSC Codes', title: 'Harmonized System Code per menu item — only required (min. 4 digits) if the item is an imported good sold as-is (e.g. imported bottled drinks). Not needed for freshly prepared dishes. Printed on POS bills if set.' },
          { key: 'discounts', label: 'Discounts', title: 'Preset reasons staff can pick when applying a discount at Charge — customize this list to match how your team actually discounts (e.g. Loyalty customer, Manager goodwill)' },
          { key: 'delivery', label: 'Delivery Partners', title: "Foodmandu/Pathao commission % — never applied automatically at Charge (their orders close as Credit, not their own payment method). It's only a starting suggestion shown when you settle that bill in Customers → Outstanding Credit, adjustable against what the platform actually remitted" },
          { key: 'reservations', label: 'Reservations', title: 'How long a party of each size is expected to sit (prefilled from your own measured turn times), when a booking counts as late, the WhatsApp confirmation message, and the booking link / QR customers scan to request a table' },
          { key: 'guestmenu', label: 'Guest Menu', title: "What guests see at the top of every table's QR menu and your online booking page — the restaurant name and logo (the owner sets these) — and the order of the menu's sections" },
          { key: 'printers', label: 'Printers', title: 'The computers at the restaurant that print kitchen and bar tickets on their own printer, instead of each till opening a print window — pair one, test it, and see what it printed. When none is online, the tills print as before' },
          ...(hasWeather ? [{ key: 'weather', label: 'Weather', title: "The town the outlet's weather is read for. Today's and the next three days' weather then show at the top of the Dashboard" }] : []),
        ]} />

      {/* ══ WEATHER TAB (S786) ══ — the city only: the rainy-day sales figure moves the Inventory
          sales chart and lives in Inventory Settings. WeatherCityPicker saves through the settings
          context (so the Dashboard strip sees the new city at once) and reads the row only once it
          was read for this client, so a client switch cannot carry one outlet's city into the next.
          The key remounts it on a switch all the same, like Guest Menu. */}
      {mainTab === 'weather' && hasWeather && (
        <div className="card" style={{ maxWidth: 520 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Weather</h3>
          <p className="weather-picker__lead">
            Pick the town nearest the outlet, and today&apos;s and the next three days&apos; weather show at the top of the Dashboard:
            rain, the high and low during opening hours, and a picture. The Owner or a manager can change it.
          </p>
          <WeatherCityPicker key={clientId || 'none'} clientId={clientId} idBase="pos-weather" />
        </div>
      )}

      {/* ══ GUEST MENU TAB (S767) ══ — its own component: it loads and saves on its own, and a
          client switch remounts it through the key, so nothing here can carry the previous client's
          name or logo into the next one's Save. */}
      {mainTab === 'guestmenu' && (
        <GuestMenuSetup key={clientId || 'none'} clientId={clientId} tables={tables} />
      )}

      {/* ══ PRINTERS TAB (S837) ══ — kitchen and bar printer computers. Its own component, keyed by
          client like Guest Menu, so an outlet switch cannot carry one outlet's computers or pairing
          codes into the next. It polls only while this tab is open. */}
      {mainTab === 'printers' && (
        <PosPrintersPanel key={clientId || 'none'} clientId={clientId} />
      )}

      {/* ══ TICKET ROUTING TAB ══ */}
      {mainTab === 'routing' && (
        <div style={{ maxWidth: 520 }}>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
            Assign each menu category to a ticket station.{' '}
            <strong style={{ color: 'var(--theme-text2)' }}>KOT</strong> prints at the kitchen;{' '}
            <strong style={{ color: 'var(--theme-text2)' }}>BOT</strong> prints at the bar.
            Changes take effect immediately on the next KOT/BOT sent.
          </p>

          {routingLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading categories…</p>
          ) : routingLoadError ? (
            <ActionError error={routingLoadError} />
          ) : !routingLoaded ? null : categories.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              No menu categories found. Add recipes in Menu Pricing first.
            </div>
          ) : (
            <>
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {/* Header row */}
                <div style={{
                  display: 'grid', gridTemplateColumns: '1fr auto',
                  padding: '10px 18px',
                  borderBottom: '1px solid var(--theme-border)',
                  fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)',
                  textTransform: 'uppercase', letterSpacing: '0.07em',
                }}>
                  <span>Category</span>
                  <span style={{ minWidth: 120, textAlign: 'center' }}>Station</span>
                </div>

                {categories.map((cat, i) => {
                  const isBot = botCats.has(cat)
                  return (
                    <div key={cat} style={{
                      display: 'grid', gridTemplateColumns: '1fr auto',
                      alignItems: 'center', padding: '12px 18px',
                      borderBottom: i < categories.length - 1 ? '1px solid var(--theme-border-lt, var(--theme-border))' : 'none',
                    }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>
                        {cat}
                        {dishlessCats.has(cat) && (
                          <Tip text="No dish on the till is in this category, but the bar list still names it, so the tills keep a Bar (BOT) button for it. Move it to KOT and save if the outlet has no bar dishes under this name.">
                            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: 'var(--theme-text3)' }}>no dishes on the till</span>
                          </Tip>
                        )}
                      </span>
                      {/* S841: the station is the setting being edited, so a screen reader hears which
                          one this category prints to (aria-pressed), named for the category. Centred
                          in the Station heading's 120px so the pair sits under it. till-hit--row keeps
                          the 44px touch floor the unclassed buttons had (.tab-btn alone is 32px). */}
                      <FilterChips label={`Ticket station for ${cat}`}
                        style={{ flexWrap: 'nowrap', justifyContent: 'center', minWidth: 120 }}
                        options={[{ key: 'KOT', label: 'KOT', className: 'till-hit--row' }, { key: 'BOT', label: 'BOT', className: 'till-hit--row' }]}
                        active={isBot ? 'BOT' : 'KOT'}
                        onChange={station => toggleCat(cat, station)} />
                    </div>
                  )
                })}
              </div>

              {/* S809 3m (Q15): every category on KOT is a real choice, saved as an empty bar list;
                  the tills then print every dish on the kitchen ticket and hide their BOT button.
                  The till's own test (an empty list), so the line and the tills cannot disagree. */}
              {botCats.size === 0 && (
                <p role="status" style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--theme-text2)' }}>{NO_BAR_TEXT}</p>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18 }}>
                <button className="btn btn-primary" onClick={saveRouting} disabled={routingSaving || !routingLoaded}>
                  {routingSaving ? 'Saving…' : 'Save Routing'}
                </button>
                {routingMsg && (
                  <span style={{ fontSize: 12, color: routingMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                    {routingMsg.replace(/^(error|ok):/, '')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ QUICK NOTES TAB ══ */}
      {mainTab === 'notes' && (
        <div style={{ maxWidth: 520 }}>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
            Preset instruction chips staff can tap on an order item instead of typing (e.g.{' '}
            <strong style={{ color: 'var(--theme-text2)' }}>No onion</strong>,{' '}
            <strong style={{ color: 'var(--theme-text2)' }}>Extra spicy</strong>). They print under
            that item on the KOT/BOT ticket. Staff can still free-type anything not in this list.
          </p>

          {notesLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <input aria-label="New quick note"
                  className="form-input" style={{ flex: 1 }}
                  value={newPreset}
                  onChange={e => setNewPreset(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addPreset()}
                  placeholder="e.g. No onion"
                />
                <button className="btn btn-ghost" onClick={addPreset}>+ Add</button>
              </div>

              {notePresets.length === 0 ? (
                <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
                  No quick notes yet — add common instructions above.
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                  {notePresets.map(p => (
                    <span key={p} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 8px 6px 12px', borderRadius: 'var(--radius-lg)', fontSize: 12,
                      background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                      color: 'var(--theme-text1)',
                    }}>
                      {p}
                      <button
                        onClick={() => removePreset(p)}
                        title="Remove"
                        style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <button className="btn btn-primary" onClick={saveNotePresets} disabled={notesSaving || !notesLoaded}>
                  {notesSaving ? 'Saving…' : 'Save Quick Notes'}
                </button>
                {notesMsg && (
                  <span style={{ fontSize: 12, color: notesMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                    {notesMsg.replace(/^(error|ok):/, '')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ HSC CODES TAB ══ */}
      {mainTab === 'hsc' && (
        <div style={{ maxWidth: 600 }}>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
            Harmonized System Code per menu item. IRD only requires this (min. 4 digits) for items
            that are <strong style={{ color: 'var(--theme-text2)' }}>imported goods sold as-is</strong>{' '}
            (e.g. imported bottled drinks or snacks) — freshly prepared dishes don't need one.
            Leave blank unless it applies. Printed on the POS bill per line if set.
          </p>

          <ActionError error={hscError} />
          {hscLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : hscLoadError ? (
            <ActionError error={hscLoadError} />
          ) : hscItems.length === 0 ? (
            <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
              No POS-enabled menu items found. Toggle items On POS in Menu Pricing first.
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{
                display: 'grid', gridTemplateColumns: '1fr 160px',
                padding: '10px 18px', borderBottom: '1px solid var(--theme-border)',
                fontSize: 11, fontWeight: 700, color: 'var(--theme-text3)',
                textTransform: 'uppercase', letterSpacing: '0.07em',
              }}>
                <span>Item</span>
                <span>HSC Code</span>
              </div>
              {hscItems.map((r, i) => (
                <div key={r.id} style={{
                  display: 'grid', gridTemplateColumns: '1fr 160px',
                  alignItems: 'center', padding: '10px 18px',
                  borderBottom: i < hscItems.length - 1 ? '1px solid var(--theme-border-lt, var(--theme-border))' : 'none',
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--theme-text1)' }}>{r.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{r.category}</div>
                  </div>
                  <input aria-label={`HSC code for ${r.name}`}
                    className="form-input"
                    defaultValue={r.hsc_code || ''}
                    onBlur={e => saveHsc(r, e.target.value)}
                    placeholder="e.g. 2202"
                    disabled={hscSaving[r.id]}
                    style={{ width: '100%' }}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ══ DISCOUNTS TAB ══ */}
      {mainTab === 'discounts' && (
        <div style={{ maxWidth: 520 }}>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
            Preset reasons a Supervisor+ can pick when applying a discount at Charge (e.g.{' '}
            <strong style={{ color: 'var(--theme-text2)' }}>Loyalty customer</strong>,{' '}
            <strong style={{ color: 'var(--theme-text2)' }}>Manager goodwill</strong>). A reason is
            required whenever a discount is applied, for an audit trail.
          </p>

          {discLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <input aria-label="New discount reason"
                  className="form-input" style={{ flex: 1 }}
                  value={newDiscReason}
                  onChange={e => setNewDiscReason(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addDiscReason()}
                  placeholder="e.g. Bulk / corporate order"
                />
                <button className="btn btn-ghost" onClick={addDiscReason}>+ Add</button>
              </div>

              {discReasons.length === 0 ? (
                <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
                  No discount reasons yet — add common reasons above.
                </div>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
                  {discReasons.map(r => (
                    <span key={r} style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      padding: '6px 8px 6px 12px', borderRadius: 'var(--radius-lg)', fontSize: 12,
                      background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)',
                      color: 'var(--theme-text1)',
                    }}>
                      {r}
                      <button
                        onClick={() => removeDiscReason(r)}
                        title="Remove"
                        style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }}
                      >×</button>
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <button className="btn btn-primary" onClick={saveDiscReasons} disabled={discSaving || !discLoaded}>
                  {discSaving ? 'Saving…' : 'Save Discount Reasons'}
                </button>
                {discMsg && (
                  <span style={{ fontSize: 12, color: discMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                    {discMsg.replace(/^(error|ok):/, '')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ DELIVERY PARTNERS TAB ══ */}
      {mainTab === 'delivery' && (
        <div style={{ maxWidth: 460 }}>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
            Aggregators like Foodmandu and Pathao don't pay at the counter — they collect from the
            customer and remit to you later, minus commission. So their orders close as a Credit
            bill (Order Taking → Pay → Credit → tap the platform's chip), not a separate payment
            method. Commission is never calculated at Charge — it only shows up as an adjustable
            suggestion when you settle that bill in Customers → Outstanding Credit, computed on the
            bill's ex-VAT (taxable) value. Add, rename, or remove platforms below as your
            partnerships change — this list isn't fixed to just these two.
          </p>

          {deliveryLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <input aria-label="New delivery partner name"
                  className="form-input" style={{ flex: 1 }}
                  value={newPartnerName}
                  onChange={e => setNewPartnerName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addPartner()}
                  placeholder="e.g. Bhojan Griha"
                />
                <button className="btn btn-ghost" onClick={addPartner}>+ Add Platform</button>
              </div>

              {partners.length === 0 ? (
                <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13, marginBottom: 20 }}>
                  No delivery partners yet — add one above.
                </div>
              ) : (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 26px', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Platform</span>
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      <Tip text="Only a starting suggestion at settlement time (Customers → Outstanding Credit) — leave blank if you haven't negotiated/confirmed a rate yet">Commission %</Tip>
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      <Tip text="Pre-fills Buyer Phone whenever this platform's chip is tapped at Charge, so its orders always group under one customer record">Buyer Phone</Tip>
                    </span>
                    <span />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {partners.map((p, idx) => (
                      <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 26px', gap: 8, alignItems: 'center' }}>
                        <input className="form-input form-input--auto" aria-label={`Platform name, row ${idx + 1}`} value={p.name}
                          onChange={e => updatePartner(idx, 'name', e.target.value)} placeholder="Platform name" />
                        <input type="number" min="0" max="100" step="0.1" className="form-input form-input--auto" aria-label={`Commission % for ${p.name || `row ${idx + 1}`}`} value={p.commission_pct ?? ''}
                          onChange={e => updatePartner(idx, 'commission_pct', e.target.value)} placeholder="e.g. 20" />
                        <input className="form-input form-input--auto" aria-label={`Buyer phone for ${p.name || `row ${idx + 1}`}`} value={p.phone ?? ''}
                          onChange={e => updatePartner(idx, 'phone', e.target.value)} placeholder="9800000001" />
                        <button
                          onClick={() => removePartner(idx)}
                          title="Remove"
                          style={{ background: 'none', border: 'none', color: 'var(--theme-text3)', cursor: 'pointer', fontSize: 16, padding: 0, lineHeight: 1 }}
                        >×</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <button className="btn btn-primary" onClick={saveDeliverySettings} disabled={deliverySaving || !deliveryLoaded}>
                  {deliverySaving ? 'Saving…' : 'Save Delivery Partner Settings'}
                </button>
                {deliveryMsg && (
                  <span style={{ fontSize: 12, color: deliveryMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                    {deliveryMsg.replace(/^(error|ok):/, '')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ══ TABLES TAB ══ */}
      {mainTab === 'tables' && (
        <>
          {/* Quick Setup trigger — hidden while the floor could not be read (S754): generating a
              batch against a floor we cannot see is how Table 1–10 got created twice. */}
          {!tablesError && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
              <button className="tab-btn" onClick={openQuickSetup}>⚡ Quick Setup</button>
            </div>
          )}

          {qsOpen && (
            <Modal onClose={() => setQsOpen(false)}>
              <h3 style={{ margin: '0 0 4px', color: 'var(--theme-text1)' }}>⚡ Quick Setup</h3>
              <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 18px' }}>Generate a batch of tables in one click</p>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px 80px 2fr 80px', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-table-management-prefix">
                    Prefix <Tip text="The name prefix — each table will be Prefix + number, e.g. 'Table 1', 'Bar 1'" />
                  </label>
                  <input id="pos-table-management-prefix" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.prefix} onChange={e => { const v = e.target.value; setQs(q => ({ ...q, prefix: v, ...(q.startTouched ? {} : { start: nextQuickSetupStart(v, tables) }) })) }} placeholder="e.g. Table" />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-table-management-start">
                    Start # <Tip text="First table number. It starts one past the highest number already used with this prefix, so a new batch never repeats a table on the floor." />
                  </label>
                  <input id="pos-table-management-start" type="number" min="1" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.start} onChange={e => { const v = e.target.value; setQs(q => ({ ...q, start: v, startTouched: true })) }} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-table-management-count">
                    Count <Tip text="How many tables to create (max 50)" />
                  </label>
                  <input id="pos-table-management-count" type="number" min="1" max="50" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.count} onChange={e => setQs(q => ({ ...q, count: e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-table-management-section">
                    Section <Tip text="Optional — groups these tables under a section tab (e.g. Main Hall, Bar, Outdoor)" />
                  </label>
                  <input id="pos-table-management-section" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.section} onChange={e => setQs(q => ({ ...q, section: e.target.value }))}
                    placeholder="e.g. Main Hall" list="qs-section-list" />
                  <datalist id="qs-section-list">
                    {existingSections.map(s => <option key={s} value={s} />)}
                  </datalist>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }} htmlFor="pos-table-management-seats">
                    Seats <Tip text="Default capacity for all tables in this batch" />
                  </label>
                  <input id="pos-table-management-seats" type="number" min="1" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.capacity} onChange={e => setQs(q => ({ ...q, capacity: e.target.value }))} />
                </div>
              </div>

              <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: qsClashText ? '0 0 6px' : '0 0 14px', fontStyle: 'italic' }}>
                Will create: <span style={{ color: 'var(--theme-text2)', fontStyle: 'normal' }}>{qsPreview()}</span>
                {parseInt(qs.count, 10) > 0 && (
                  <span style={{ color: 'var(--theme-accent-ink)', marginLeft: 6 }}>({parseInt(qs.count, 10)} tables)</span>
                )}
              </p>
              {qsClashText && (
                <p role="alert" style={{ fontSize: 12, color: 'var(--theme-red-text)', margin: '0 0 14px' }}>{qsClashText}</p>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="btn btn-primary" onClick={handleGenerate} disabled={qsSaving || !!tablesError}>
                  {qsSaving ? 'Creating…' : `Generate ${parseInt(qs.count, 10) || 0} Tables`}
                </button>
                {qsMsg && (
                  <span style={{ fontSize: 12, color: qsMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                    {qsMsg.replace(/^(error|ok):/, '')}
                  </span>
                )}
              </div>
            </Modal>
          )}

          {/* Stat cards */}
          {tables.length > 0 && (
            <div className="stat-grid" style={{ marginBottom: 20 }}>
              {[
                { label: 'Total Tables', value: tables.length,    color: 'var(--theme-text1)', tip: null },
                { label: 'Available',    value: counts.available, color: 'var(--theme-text1)',      tip: 'Tables ready to seat a new party right now' },
                { label: 'Occupied',     value: counts.occupied,  color: 'var(--theme-accent-ink)', tip: 'Tables with an active order currently open' },
                { label: 'Reserved',     value: counts.reserved,  color: 'var(--theme-text1)',      tip: 'Tables held for an upcoming booking or walk-in queue' },
              ].map(s => (
                <div key={s.label} className="card" style={{ padding: '12px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    {s.tip ? <Tip text={s.tip}>{s.label}</Tip> : s.label}
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: s.color, marginTop: 4 }}>{s.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Section filter: it narrows the floor grid below, so chips, not tabs (S841) */}
          {sections.length > 1 && (
            <FilterChips label="Floor section" style={{ marginBottom: 20 }}
              options={sections.map(s => ({ key: s, label: s }))}
              active={secFilter} onChange={setSecFilter} />
          )}

          {floorMsg && (() => {
            const isErr = floorMsg.startsWith('error:')
            const tone = isErr ? 'var(--theme-red)' : 'var(--theme-green)'
            // A real Dismiss button: the old "(tap to dismiss)" div was mouse/touch only. Tints
            // come from the live tokens, not the Dark preset's rgba literals.
            return (
              <div role={isErr ? 'alert' : 'status'} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                background: `color-mix(in srgb, ${tone} 8%, transparent)`,
                border: `1px solid color-mix(in srgb, ${tone} 25%, transparent)`,
                borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
                color: isErr ? 'var(--theme-red-text)' : 'var(--theme-green-text)',
              }}>
                <span style={{ flex: 1 }}>{floorMsg.replace(/^(error|ok):/, '')}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFloorMsg('')}>Dismiss</button>
              </div>
            )
          })()}

          {/* Floor grid */}
          {loading ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          ) : tablesError ? (
            <ReportLoadError error={tablesError} />
          ) : visible.length === 0 && tables.length > 0 ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
              No tables in this section.
            </div>
          ) : tables.length > 0 ? (
            // .fab-clear: on a phone, where the header's Add floats, the last row's QR buttons stay clear of it.
            <div className="fab-clear" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
              {visible.map(t => (
                <div
                  key={t.id}
                  className="card"
                  onClick={() => openEdit(t)}
                  style={{ padding: '16px 18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}
                >
                  <div style={{ margin: '-16px -18px 2px', height: 6, background: tableStripColor({ status: t.status }), flexShrink: 0 }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                    {/* The card keeps its onClick as the mouse convenience, but the keyboard
                        path is these two real controls rather than role="button" on the card:
                        this card holds three interactive children (name, status, QR), and
                        nesting buttons inside a button role is invalid and unfocusable. That
                        is why this grid is treated differently from the visually identical one
                        on Order Taking, whose cards have no interactive children. */}
                    {/* btn-linklike for the semantics and the focus ring, with its colour and
                        underline overridden back to the card title's own treatment: a floor can
                        run to 40 tables, and gold-underlining every name would spend the
                        rationed accent 40 times on one screen. The card's own cursor:pointer is
                        the mouse affordance; this button exists for the keyboard. */}
                    <button
                      className="btn-linklike"
                      style={{ fontWeight: 700, fontSize: 15, lineHeight: 1.2,
                               color: 'var(--theme-text1)', textDecoration: 'none' }}
                      onClick={e => { e.stopPropagation(); openEdit(t) }}
                    >{t.name}</button>
                    <Tip text="This table's status. Pick a new one from the list — the till sets Occupied and Available by itself as orders open and close.">
                      {/* A picker wearing the badge class (S776). It was a button that CYCLED on each tap
                          (Available → Reserved → Occupied → Inactive), 57×15 at 10px — so a stray tap on
                          a tablet quietly marked a table Reserved, and reaching Inactive meant passing
                          through Occupied. A select names every state and changes nothing until one is
                          chosen. The inline reset is the badge styles' gap: they assume a span. */}
                      <select
                        className={STATUS_BADGE[t.status] || 'badge-gray'}
                        aria-label={`Status of ${t.name}`}
                        value={t.status}
                        onClick={e => e.stopPropagation()}
                        onChange={e => setTableStatus(t, e.target.value)}
                        style={{ fontSize: 12, flexShrink: 0, cursor: 'pointer', border: 'none', fontFamily: 'inherit' }}
                      >
                        {STATUS_CYCLE.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                      </select>
                    </Tip>
                  </div>
                  {t.section && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{t.section}</div>}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      <Tip text="Seating capacity — edit the table to change it">👥 {t.capacity} seats</Tip>
                    </div>
                    <Tip text="View / print this table's guest menu QR code">
                      {/* `btn btn-ghost`, not `btn-ghost` alone: .btn-ghost is colour-only, and the
                          coarse-pointer touch-size rule keys on .btn — so this button (measured
                          25px) sat in no touch rule at all on the tablet this page is used from. */}
                      <button className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={e => openQr(t, e)}>▦ QR</button>
                    </Tip>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {/* ══ RESERVATIONS TAB ══ */}
      {mainTab === 'reservations' && (
        <div style={{ maxWidth: 560 }}>
          <p style={{ margin: '0 0 20px', fontSize: 13, color: 'var(--theme-text3)', lineHeight: 1.6 }}>
            Bookings live on the Reservations page and show on the Orders floor as a chip on the
            table they hold. The figures here decide how long a booking is expected to occupy its
            table, when it reads as late, and what the WhatsApp confirmation says. The booking link
            at the bottom is what a customer scans to request a table — every request waits for a
            staff Accept.
          </p>

          {resvLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
          ) : resvLoadError ? (
            <ActionError error={resvLoadError} />
          ) : !resvLoaded ? null : (
            <>
              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text1)' }}>
                Expected sitting length <Tip text="Per party size. Prefills the booking form and sizes the block on the capacity strip. 'Measured' is this outlet's own average from opening a table to paying its bill over the last 90 days — the Covers Report's Turnover Time figure." width={300}>ⓘ</Tip>
              </h3>
              <div className="table-wrap" style={{ marginBottom: 18 }}>
                <table className="data-table">
                  <thead><tr><th>Party</th><th style={{ textAlign: 'right' }}>Minutes</th><th>Measured</th><th></th></tr></thead>
                  <tbody>
                    {PARTY_BANDS.map(b => {
                      const m = resvMeasured?.find(x => x.key === b.key)
                      const measured = m && m.orders > 0 ? Math.round(m.avgMinutes) : null
                      return (
                        <tr key={b.key}>
                          <td><label htmlFor={`resv-band-${b.key}`} style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{b.label}</label></td>
                          <td style={{ textAlign: 'right' }}>
                            <input id={`resv-band-${b.key}`} type="number" min={15} max={720} step={5} inputMode="numeric"
                              className="form-input form-input--auto" style={{ width: 90, textAlign: 'right' }}
                              value={resv.duration_by_band[b.key]} onChange={e => setResvBand(b.key, e.target.value)} />
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                            {/* S818: sittings over 12 hours are left out of the measure (S814 4d), so it can no
                                longer read above the field's 720-minute ceiling; the "skewed by bills left
                                open" note that stood here could not show. */}
                            {resvMeasured === null ? <span style={{ color: 'var(--theme-text3)' }}>—</span>
                              : measured == null ? <span style={{ color: 'var(--theme-text3)' }}>no sittings yet</span>
                              : `${measured} min · ${m.orders} sitting${m.orders === 1 ? '' : 's'}`}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {measured != null && measured >= 15 && measured <= 720 && (
                              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResvBand(b.key, String(measured))}>Use measured</button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px 16px', marginBottom: 18 }}>
                <div className="form-field">
                  <label htmlFor="resv-grace">
                    Late after (min) <Tip text="Minutes past the booked time before a booking that is not yet marked Arrived shows a late flag on the Reservations page." width={260}>ⓘ</Tip>
                  </label>
                  <input id="resv-grace" type="number" min={0} max={180} inputMode="numeric" value={resv.arrival_grace_minutes} onChange={e => setResvField('arrival_grace_minutes', e.target.value)} />
                </div>
                <div className="form-field">
                  <label htmlFor="resv-window">
                    Offer seating from (min before) <Tip text="Tapping a booked table this many minutes before its time offers 'Seat <name>' instead of the covers numpad." width={260}>ⓘ</Tip>
                  </label>
                  <input id="resv-window" type="number" min={0} max={240} inputMode="numeric" value={resv.seat_window_minutes} onChange={e => setResvField('seat_window_minutes', e.target.value)} />
                </div>
              </div>

              <div className="form-field" style={{ marginBottom: 18 }}>
                <label htmlFor="resv-template">
                  WhatsApp confirmation message <Tip text="What the 💬 button on the Reservations page prefills. Placeholders: {name} {party} {outlet} {date} {time}. Sent from the host's own WhatsApp — nothing is sent automatically." width={300}>ⓘ</Tip>
                </label>
                <textarea id="resv-template" rows={3} value={resv.whatsapp_template} onChange={e => setResvField('whatsapp_template', e.target.value)} />
                <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start', marginTop: 6 }} onClick={() => setResvField('whatsapp_template', DEFAULT_WHATSAPP_TEMPLATE)}>Reset to default</button>
              </div>

              <h3 style={{ margin: '0 0 8px', fontSize: 14, color: 'var(--theme-text1)' }}>
                Online booking <Tip text="A public page customers reach from a QR or link — on a table tent, the door, your Instagram bio, your Facebook Book Now button. They pick a day, time and party size and enter a name and mobile number; the request lands on the Reservations page for a staff Accept or Decline, and their phone shows the answer." width={320}>ⓘ</Tip>
              </h3>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: 'var(--theme-text1)', marginBottom: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={resv.public_booking_enabled} onChange={e => setResvField('public_booking_enabled', e.target.checked)} />
                Accept online booking requests
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px 16px', marginBottom: 14 }}>
                <div className="form-field">
                  <label htmlFor="resv-maxparty">
                    Largest party online <Tip text="Bigger groups are told to call. Keeps a banquet-sized request from being a one-tap surprise." width={240}>ⓘ</Tip>
                  </label>
                  <input id="resv-maxparty" type="number" min={1} max={99} inputMode="numeric" value={resv.max_party_online} onChange={e => setResvField('max_party_online', e.target.value)} disabled={!resv.public_booking_enabled} />
                </div>
                <div className="form-field">
                  <label htmlFor="resv-lead">
                    Minimum notice (min) <Tip text="A request for a time sooner than this is refused with 'please call' — a same-minute online request cannot be accepted by anyone in time." width={260}>ⓘ</Tip>
                  </label>
                  <input id="resv-lead" type="number" min={0} max={1440} inputMode="numeric" value={resv.min_lead_minutes} onChange={e => setResvField('min_lead_minutes', e.target.value)} disabled={!resv.public_booking_enabled} />
                </div>
              </div>
              <div style={{ marginBottom: 18 }}>
                <span className="field-label" id="resv-closed-label" style={{ display: 'block', marginBottom: 6 }}>
                  Closed on <Tip text="Weekly off days. The booking page shows them as Closed and refuses a request for them. Ticking a day here clears it from Walk-ins only." width={260}>ⓘ</Tip>
                </span>
                <div role="group" aria-labelledby="resv-closed-label" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                    <button key={d} type="button" className={`tab-btn${(resv.closed_weekdays || []).includes(i) ? ' tab-btn--active' : ''}`}
                      aria-pressed={(resv.closed_weekdays || []).includes(i)} onClick={() => toggleResvWeekday('closed_weekdays', i)}>{d}</button>
                  ))}
                </div>
                <span className="field-label" id="resv-walkin-label" style={{ display: 'block', marginBottom: 6 }}>
                  Walk-ins only on <Tip text="Days you are open but take no online bookings — the page shows them as Walk-in and refuses a request for them. Staff can still enter a booking by hand." width={280}>ⓘ</Tip>
                </span>
                <div role="group" aria-labelledby="resv-walkin-label" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => (
                    <button key={d} type="button" className={`tab-btn${(resv.walk_in_weekdays || []).includes(i) ? ' tab-btn--active' : ''}`}
                      aria-pressed={(resv.walk_in_weekdays || []).includes(i)} onClick={() => toggleResvWeekday('walk_in_weekdays', i)}>{d}</button>
                  ))}
                </div>
                <div className="form-field" style={{ marginBottom: 12 }}>
                  <label htmlFor="resv-closed-date">
                    Closed dates <Tip text="Dashain, Tihar, a private function — any single day the page should show as Closed. Not taken from the HR holiday calendar: most outlets are open on a public holiday." width={280}>ⓘ</Tip>
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <BsCalendarPicker id="resv-closed-date" value={newClosedDate} onChange={setNewClosedDate} placeholder="Pick a BS date" />
                    <button type="button" className="btn btn-ghost btn-sm" onClick={addClosedDate} disabled={!newClosedDate}>Add date</button>
                  </div>
                  {(resv.closed_dates || []).length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                      {(resv.closed_dates || []).map(iso => (
                        <span key={iso} className="badge badge-gray" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          {closedDateLabel(iso)}
                          <button type="button" className="btn-linklike" aria-label={`Remove ${iso}`} onClick={() => removeClosedDate(iso)} style={{ fontSize: 12 }}>×</button>
                        </span>
                      ))}
                    </div>
                  )}
                  {(resv.closed_dates || []).some(iso => iso < formatAd(new Date())) && (
                    <span style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 4 }}>Past dates are kept for the record; they no longer affect the page.</span>
                  )}
                </div>
                <div className="form-field">
                  <label htmlFor="resv-notice">
                    Notice on the booking page <Tip text="One line under the page title, for anything the rules above cannot say — 'Groups over 12 please call', 'Terrace closed in monsoon'. 160 characters." width={260}>ⓘ</Tip>
                  </label>
                  <input id="resv-notice" maxLength={160} value={resv.page_notice || ''} onChange={e => setResvField('page_notice', e.target.value)} placeholder="Optional" />
                </div>
              </div>
              <div className="form-field" style={{ marginBottom: 18 }}>
                <label htmlFor="resv-link">Booking link</label>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input id="resv-link" className="form-input" readOnly value={bookingUrl()} style={{ flex: '1 1 260px', fontSize: 12 }} onFocus={e => e.target.select()} />
                  <button type="button" className="btn btn-ghost btn-sm" onClick={copyBookingUrl}>Copy link</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={printBookingQr} disabled={!bookingQrUrl}>Print QR</button>
                </div>
                {!resv.public_booking_enabled && (
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)', marginTop: 4 }}>The page shows "not taking online bookings" until the box above is ticked and saved.</span>
                )}
              </div>
              {bookingQrUrl && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
                  <img src={bookingQrUrl} alt="Booking QR" style={{ width: 120, height: 120, borderRadius: 'var(--radius-sm)', border: '1px solid var(--theme-border)' }} />
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)', lineHeight: 1.5 }}>
                    Print it for the table tents and the door; paste the link into your Instagram bio, Facebook Book Now button and Google Maps listing.
                  </span>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <button className="btn btn-primary" onClick={saveReservationSettings} disabled={resvSaving || !resvLoaded}>
                  {resvSaving ? 'Saving…' : 'Save Reservation Settings'}
                </button>
                {resvMsg && (
                  <span style={{ fontSize: 12, color: resvMsg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                    {resvMsg.replace(/^(error|ok):/, '')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <Modal onClose={closeModal}>
          <h3 style={{ margin: '0 0 18px', color: 'var(--theme-text1)' }}>
            {target ? `Edit — ${target.name}` : 'Add Table'}
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="pos-table-management-table-name">
                Table Name <span style={{ color: 'var(--theme-red-text)' }}>*</span>{' '}
                <Tip text="Displayed on the floor plan and on bills — e.g. Table 1, Bar 3, Patio A" />
              </label>
              <input id="pos-table-management-table-name"
                className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Table 1" autoFocus
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="pos-table-management-section-2">
                  Section <Tip text="Groups tables by area — type a new name or pick an existing one." />
                </label>
                <input id="pos-table-management-section-2"
                  style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', color: 'var(--theme-text1)', fontSize: 13, outline: 'none' }}
                  value={form.section} onChange={e => setForm(f => ({ ...f, section: e.target.value }))}
                  placeholder="e.g. Indoor, Outdoor, Bar…" list="modal-section-list"
                />
                <datalist id="modal-section-list">
                  {existingSections.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="pos-table-management-capacity">
                  Capacity <Tip text="Number of seats" />
                </label>
                <input id="pos-table-management-capacity" type="number" min="1" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                  value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} />
              </div>
            </div>

            {target && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="pos-table-management-status">
                    Status <Tip text="Available = ready to seat. Occupied = active order. Reserved = booking. Inactive = out of service: it takes no new order or QR order. A table with an open bill cannot be made Inactive or Available until that bill is closed." />
                  </label>
                  <select id="pos-table-management-status" className="form-select" style={{ width: '100%' }}
                    value={target.status} onChange={e => handleStatusChange(e.target.value)}>
                    {STATUS_CYCLE.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="pos-table-management-sort-order">
                    Sort Order <Tip text="Lower numbers appear first within a section" />
                  </label>
                  <input id="pos-table-management-sort-order" type="number" min="0" className="form-input" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))} />
                </div>
              </div>
            )}

            {msg && (
              <p role="alert" style={{ margin: 0, fontSize: 12, color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
                {msg.replace(/^(error|ok):/, '')}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              {target && (
                <button className="btn btn-ghost"
                  style={{ color: 'var(--theme-red-text)', borderColor: 'var(--theme-red)', marginRight: 'auto' }}
                  onClick={handleDelete}>Delete</button>
              )}
              <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : target ? 'Save Changes' : 'Add Table'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Guest Menu QR modal */}
      {qrTable && (
        <Modal onClose={() => setQrTable(null)}>
          <h3 style={{ margin: '0 0 4px', color: 'var(--theme-text1)' }}>{qrTable.name} — Guest Menu QR</h3>
          <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 18px' }}>
            Print this and place it on the table — scanning it opens a read-only menu, no app or login needed.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
            {qrDataUrl ? (
              <img src={qrDataUrl} alt="Guest menu QR" style={{ width: 200, height: 200 }} />
            ) : (
              <div style={{ width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--theme-text3)', fontSize: 12 }}>Generating…</div>
            )}
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', wordBreak: 'break-all', textAlign: 'center', margin: 0 }}>
              {guestMenuUrl(qrTable)}
            </p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost" onClick={() => setQrTable(null)}>Close</button>
              <button className="btn btn-primary" onClick={printQr} disabled={!qrDataUrl}>Print</button>
            </div>
          </div>
        </Modal>
      )}
      {confirmEl}
    </div>
  )
}
