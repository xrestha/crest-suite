import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import QRCode from 'qrcode'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import Tip from '../../../components/Tip'
import { escapeHtml as esc } from '../../../utils/escapeHtml'

const STATUS_CYCLE = ['available', 'reserved', 'occupied', 'inactive']
const STATUS_BADGE = { available: 'badge-green', occupied: 'badge-red', reserved: 'badge-amber', inactive: 'badge-gray' }
const STATUS_LABEL = { available: 'Available', occupied: 'Occupied', reserved: 'Reserved', inactive: 'Inactive' }
// Same stage-color-strip treatment as the live floor view (PosOrders.jsx) and Kitchen Display —
// a small badge chip alone doesn't read at a glance; the badge stays too, so color is never the
// only signal.
const STATUS_COLOR = { available: 'var(--theme-green)', occupied: 'var(--theme-red)', reserved: 'var(--theme-amber)', inactive: 'var(--theme-border)' }

const QS_EMPTY  = { prefix: 'Table', start: 1, count: 10, section: '', capacity: 4 }
const ADD_EMPTY = { name: '', section: '', capacity: 4 }

const DEFAULT_DISCOUNT_REASONS = ['Loyalty customer', 'Promo / coupon code', 'Manager goodwill', 'Bulk / corporate order', 'Price match', 'Other']

export default function PosTableManagement() {
  const { clientId, hasPosAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [mainTab, setMainTab] = useState('tables') // 'tables' | 'routing' | 'notes' | 'hsc' | 'discounts'

  const [tables,    setTables]    = useState([])
  const [loading,   setLoading]   = useState(true)
  const [secFilter, setSecFilter] = useState('All')
  // Transient banner above the floor grid for cycleStatus errors — that action happens directly
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
  const [botCats,         setBotCats]         = useState(new Set(['Beverage']))
  const [routingLoading,  setRoutingLoading]  = useState(false)
  const [routingSaving,   setRoutingSaving]   = useState(false)
  const [routingMsg,      setRoutingMsg]      = useState('')
  const [routingLoaded,   setRoutingLoaded]   = useState(false)

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
    if (!clientId) return
    if (mainTab === 'routing') loadRouting()
    else if (mainTab === 'notes') loadNotePresets()
    else if (mainTab === 'hsc') loadHscItems()
    else if (mainTab === 'discounts') loadDiscReasons()
    else if (mainTab === 'delivery') loadDeliverySettings()
  }, [clientId]) // eslint-disable-line

  if (!hasPosAccess('supervisor')) return <Navigate to="/pos" replace />

  async function load() {
    setLoading(true)
    const { data } = await scopedFrom('pos_tables')
      .order('sort_order').order('name')
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

  async function handleGenerate() {
    const count = parseInt(qs.count, 10) || 0
    const start = parseInt(qs.start, 10) || 1
    if (!qs.prefix.trim()) { setQsMsg('error:Prefix is required.'); return }
    if (count < 1 || count > 50) { setQsMsg('error:Count must be 1–50.'); return }
    if (!clientId) return
    setQsSaving(true); setQsMsg('')
    const rows = Array.from({ length: count }, (_, i) => ({
      name:       `${qs.prefix.trim()} ${start + i}`,
      section:    qs.section.trim() || null,
      capacity:   parseInt(qs.capacity, 10) || 4,
      sort_order: start + i,
    }))
    const { error } = await scopedInsert('pos_tables', rows)
    if (error) { setQsMsg('error:' + error.message); setQsSaving(false); return }
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
    setSaving(true); setMsg('')
    const payload = {
      name:       form.name.trim(),
      section:    form.section.trim() || null,
      capacity:   parseInt(form.capacity, 10) || 4,
      ...(target ? { sort_order: parseInt(form.sort_order, 10) || 0 } : {}),
    }
    const { error } = target
      ? await scopedUpdate('pos_tables', payload).eq('id', target.id)
      : await scopedInsert('pos_tables', payload)
    if (error) { setMsg('error:' + error.message); setSaving(false); return }
    await load(); closeModal(); setSaving(false)
  }

  async function handleDelete() {
    if (!target || !window.confirm(`Delete "${target.name}"? This cannot be undone.`)) return
    const { error } = await scopedDelete('pos_tables').eq('id', target.id)
    if (error) { setMsg('error:' + error.message); return }
    await load(); closeModal()
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
        <p style="margin:0 0 20px;color:#666;font-size:13px">Scan for our menu</p>
        <img src="${qrDataUrl}" style="width:240px;height:240px" />
      </body></html>
    `)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print(); w.close() }, 300)
  }

  async function cycleStatus(t, e) {
    e.stopPropagation()
    setFloorMsg('')
    const next = STATUS_CYCLE[(STATUS_CYCLE.indexOf(t.status) + 1) % STATUS_CYCLE.length]
    const { error } = await scopedUpdate('pos_tables', { status: next }).eq('id', t.id)
    if (error) { setFloorMsg('error:Could not update ' + t.name + ' — ' + error.message); return }
    setTables(prev => prev.map(r => r.id === t.id ? { ...r, status: next } : r))
  }

  async function handleStatusChange(val) {
    const { error } = await scopedUpdate('pos_tables', { status: val }).eq('id', target.id)
    if (error) { setMsg('error:' + error.message); return }
    setTables(prev => prev.map(r => r.id === target.id ? { ...r, status: val } : r))
    setTarget(t => ({ ...t, status: val }))
  }

  // ── Ticket Routing ───────────────────────────────────────────────────────────

  async function loadRouting() {
    setRoutingLoading(true)
    const [{ data: recipeData }, { data: settingsData }] = await Promise.all([
      scopedFrom('recipes', 'category').eq('pos_enabled', true).neq('category', 'Sub-Recipe'),
      supabase.from('settings').select('pos_bot_categories').eq('client_id', clientId).maybeSingle(),
    ])
    const cats = Array.from(new Set((recipeData || []).map(r => r.category).filter(Boolean))).sort()
    setCategories(cats)
    const botArr = settingsData?.pos_bot_categories ?? ['Beverage']
    setBotCats(new Set(botArr))
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
    setRoutingSaving(true); setRoutingMsg('')
    const botArr = Array.from(botCats)
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error
    if (existing?.id) {
      ;({ error } = await supabase.from('settings').update({ pos_bot_categories: botArr }).eq('id', existing.id))
    } else {
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, pos_bot_categories: botArr }))
    }
    setRoutingSaving(false)
    setRoutingMsg(error ? 'error:' + error.message : 'ok:Routing saved.')
  }

  // ── Quick Notes ──────────────────────────────────────────────────────────────

  async function loadNotePresets() {
    setNotesLoading(true)
    const { data } = await supabase.from('settings').select('pos_note_presets').eq('client_id', clientId).maybeSingle()
    setNotePresets(data?.pos_note_presets || [])
    setNotesLoading(false)
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
    setNotesSaving(true); setNotesMsg('')
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error
    if (existing?.id) {
      ;({ error } = await supabase.from('settings').update({ pos_note_presets: notePresets }).eq('id', existing.id))
    } else {
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, pos_note_presets: notePresets }))
    }
    setNotesSaving(false)
    setNotesMsg(error ? 'error:' + error.message : 'ok:Quick notes saved.')
  }

  // ── HSC Codes ────────────────────────────────────────────────────────────────

  async function loadHscItems() {
    setHscLoading(true)
    const { data } = await scopedFrom('recipes', 'id, name, category, hsc_code')
      .eq('is_active', true).eq('pos_enabled', true)
      .neq('category', 'Sub-Recipe').order('name')
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
    setHscSaving(s => ({ ...s, [recipe.id]: true }))
    await scopedUpdate('recipes', { hsc_code: trimmed || null }).eq('id', recipe.id)
    setHscItems(items => items.map(r => r.id === recipe.id ? { ...r, hsc_code: trimmed || null } : r))
    setHscSaving(s => ({ ...s, [recipe.id]: false }))
  }

  // ── Discount Reasons ────────────────────────────────────────────────────────

  async function loadDiscReasons() {
    setDiscLoading(true)
    const { data } = await supabase.from('settings').select('pos_discount_reasons').eq('client_id', clientId).maybeSingle()
    setDiscReasons(data?.pos_discount_reasons?.length ? data.pos_discount_reasons : DEFAULT_DISCOUNT_REASONS)
    setDiscLoading(false)
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
    setDiscSaving(true); setDiscMsg('')
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error
    if (existing?.id) {
      ;({ error } = await supabase.from('settings').update({ pos_discount_reasons: discReasons }).eq('id', existing.id))
    } else {
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, pos_discount_reasons: discReasons }))
    }
    setDiscSaving(false)
    setDiscMsg(error ? 'error:' + error.message : 'ok:Discount reasons saved.')
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
    const { data } = await supabase.from('settings')
      .select('pos_delivery_partners').eq('client_id', clientId).maybeSingle()
    setPartners(data?.pos_delivery_partners ?? [
      { name: 'Foodmandu', commission_pct: '', phone: '9800000001' },
      { name: 'Pathao',    commission_pct: '', phone: '9800000002' },
    ])
    setDeliveryLoading(false)
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
    setDeliverySaving(true); setDeliveryMsg('')
    const cleaned = partners
      .map(p => ({
        name: (p.name || '').trim(),
        commission_pct: p.commission_pct === '' || p.commission_pct == null ? null : parseFloat(p.commission_pct),
        phone: (p.phone || '').trim(),
      }))
      .filter(p => p.name)
    const payload = { pos_delivery_partners: cleaned }
    const { data: existing } = await supabase
      .from('settings').select('id').eq('client_id', clientId).maybeSingle()
    let error
    if (existing?.id) {
      ;({ error } = await supabase.from('settings').update(payload).eq('id', existing.id))
    } else {
      ;({ error } = await supabase.from('settings').insert({ client_id: clientId, ...payload }))
    }
    setPartners(cleaned)
    setDeliverySaving(false)
    setDeliveryMsg(error ? 'error:' + error.message : 'ok:Delivery partner settings saved.')
  }

  // ────────────────────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1100 }}>

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>Table Management</h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          Set up your floor plan and configure ticket routing for the kitchen and bar.
        </p>
      </div>

      {/* Main tab bar */}
      <div className="tab-bar" style={{ marginBottom: 24 }}>
        <button
          className={`tab-btn${mainTab === 'tables' ? ' tab-btn--active' : ''}`}
          onClick={() => setMainTab('tables')}
        >Tables</button>
        <Tip text="Assign each menu category to KOT (kitchen) or BOT (bar) — controls where the ticket prints when staff send an order">
          <button
            className={`tab-btn${mainTab === 'routing' ? ' tab-btn--active' : ''}`}
            onClick={openRoutingTab}
          >Ticket Routing</button>
        </Tip>
        <Tip text="Preset instruction chips (e.g. 'No onion', 'Extra spicy') staff can tap on an order item instead of typing — prints under that item on the KOT/BOT">
          <button
            className={`tab-btn${mainTab === 'notes' ? ' tab-btn--active' : ''}`}
            onClick={openNotesTab}
          >Quick Notes</button>
        </Tip>
        <Tip text="Harmonized System Code per menu item — only required (min. 4 digits) if the item is an imported good sold as-is (e.g. imported bottled drinks). Not needed for freshly prepared dishes. Printed on POS bills if set.">
          <button
            className={`tab-btn${mainTab === 'hsc' ? ' tab-btn--active' : ''}`}
            onClick={openHscTab}
          >HSC Codes</button>
        </Tip>
        <Tip text="Preset reasons staff can pick when applying a discount at Charge — customize this list to match how your team actually discounts (e.g. Loyalty customer, Manager goodwill)">
          <button
            className={`tab-btn${mainTab === 'discounts' ? ' tab-btn--active' : ''}`}
            onClick={openDiscountsTab}
          >Discounts</button>
        </Tip>
        <Tip text="Foodmandu/Pathao commission % — never applied automatically at Charge (their orders close as Credit, not their own payment method). It's only a starting suggestion shown when you settle that bill in Customers → Outstanding Credit, adjustable against what the platform actually remitted">
          <button
            className={`tab-btn${mainTab === 'delivery' ? ' tab-btn--active' : ''}`}
            onClick={openDeliveryTab}
          >Delivery Partners</button>
        </Tip>
      </div>

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
          ) : categories.length === 0 ? (
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
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-text1)' }}>{cat}</span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {['KOT', 'BOT'].map(station => {
                          const active = station === 'BOT' ? isBot : !isBot
                          return (
                            <button key={station} onClick={() => toggleCat(cat, station)} style={{
                              padding: '5px 18px', borderRadius: 6, fontSize: 12,
                              fontWeight: active ? 700 : 400, cursor: 'pointer',
                              background: active ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                              color: active ? 'var(--theme-accent-text, #000)' : 'var(--theme-text2)',
                              border: `1px solid ${active ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                              transition: 'all 0.1s',
                            }}>{station}</button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 18 }}>
                <button className="btn btn-primary" onClick={saveRouting} disabled={routingSaving}>
                  {routingSaving ? 'Saving…' : 'Save Routing'}
                </button>
                {routingMsg && (
                  <span style={{ fontSize: 12, color: routingMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
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
                <input
                  className="form-select" style={{ flex: 1 }}
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
                      padding: '6px 8px 6px 12px', borderRadius: 14, fontSize: 12,
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
                <button className="btn btn-primary" onClick={saveNotePresets} disabled={notesSaving}>
                  {notesSaving ? 'Saving…' : 'Save Quick Notes'}
                </button>
                {notesMsg && (
                  <span style={{ fontSize: 12, color: notesMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
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

          {hscLoading ? (
            <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading…</p>
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
                  <input
                    className="form-select"
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
                <input
                  className="form-select" style={{ flex: 1 }}
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
                      padding: '6px 8px 6px 12px', borderRadius: 14, fontSize: 12,
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
                <button className="btn btn-primary" onClick={saveDiscReasons} disabled={discSaving}>
                  {discSaving ? 'Saving…' : 'Save Discount Reasons'}
                </button>
                {discMsg && (
                  <span style={{ fontSize: 12, color: discMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
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
                <input
                  className="form-select" style={{ flex: 1 }}
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
                    <label style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Platform</label>
                    <label style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      <Tip text="Only a starting suggestion at settlement time (Customers → Outstanding Credit) — leave blank if you haven't negotiated/confirmed a rate yet">Commission %</Tip>
                    </label>
                    <label style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                      <Tip text="Pre-fills Buyer Phone whenever this platform's chip is tapped at Charge, so its orders always group under one customer record">Buyer Phone</Tip>
                    </label>
                    <span />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {partners.map((p, idx) => (
                      <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 26px', gap: 8, alignItems: 'center' }}>
                        <input className="form-select" value={p.name}
                          onChange={e => updatePartner(idx, 'name', e.target.value)} placeholder="Platform name" />
                        <input type="number" min="0" max="100" step="0.1" className="form-select" value={p.commission_pct ?? ''}
                          onChange={e => updatePartner(idx, 'commission_pct', e.target.value)} placeholder="e.g. 20" />
                        <input className="form-select" value={p.phone ?? ''}
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
                <button className="btn btn-primary" onClick={saveDeliverySettings} disabled={deliverySaving}>
                  {deliverySaving ? 'Saving…' : 'Save Delivery Partner Settings'}
                </button>
                {deliveryMsg && (
                  <span style={{ fontSize: 12, color: deliveryMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
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
          {/* Quick Setup trigger */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
            <button className="tab-btn" onClick={() => { setQsOpen(true); setQsMsg('') }}>⚡ Quick Setup</button>
          </div>

          {qsOpen && (
            <Modal onClose={() => setQsOpen(false)}>
              <h3 style={{ margin: '0 0 4px', color: 'var(--theme-text1)' }}>⚡ Quick Setup</h3>
              <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 18px' }}>Generate a batch of tables in one click</p>

              <div style={{ display: 'grid', gridTemplateColumns: '2fr 80px 80px 2fr 80px', gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
                    Prefix <Tip text="The name prefix — each table will be Prefix + number, e.g. 'Table 1', 'Bar 1'" />
                  </label>
                  <input className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.prefix} onChange={e => setQs(q => ({ ...q, prefix: e.target.value }))} placeholder="e.g. Table" />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
                    Start # <Tip text="First table number" />
                  </label>
                  <input type="number" min="1" className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.start} onChange={e => setQs(q => ({ ...q, start: e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
                    Count <Tip text="How many tables to create (max 50)" />
                  </label>
                  <input type="number" min="1" max="50" className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.count} onChange={e => setQs(q => ({ ...q, count: e.target.value }))} />
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
                    Section <Tip text="Optional — groups these tables under a section tab (e.g. Main Hall, Bar, Outdoor)" />
                  </label>
                  <input className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.section} onChange={e => setQs(q => ({ ...q, section: e.target.value }))}
                    placeholder="e.g. Main Hall" list="qs-section-list" />
                  <datalist id="qs-section-list">
                    {existingSections.map(s => <option key={s} value={s} />)}
                  </datalist>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
                    Seats <Tip text="Default capacity for all tables in this batch" />
                  </label>
                  <input type="number" min="1" className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={qs.capacity} onChange={e => setQs(q => ({ ...q, capacity: e.target.value }))} />
                </div>
              </div>

              <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 14px', fontStyle: 'italic' }}>
                Will create: <span style={{ color: 'var(--theme-text2)', fontStyle: 'normal' }}>{qsPreview()}</span>
                {parseInt(qs.count, 10) > 0 && (
                  <span style={{ color: 'var(--theme-accent)', marginLeft: 6 }}>({parseInt(qs.count, 10)} tables)</span>
                )}
              </p>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="btn btn-primary" onClick={handleGenerate} disabled={qsSaving}>
                  {qsSaving ? 'Creating…' : `Generate ${parseInt(qs.count, 10) || 0} Tables`}
                </button>
                {qsMsg && (
                  <span style={{ fontSize: 12, color: qsMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
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
                { label: 'Available',    value: counts.available, color: 'var(--theme-green)',  tip: 'Tables ready to seat a new party right now' },
                { label: 'Occupied',     value: counts.occupied,  color: 'var(--theme-red)',    tip: 'Tables with an active order currently open' },
                { label: 'Reserved',     value: counts.reserved,  color: 'var(--theme-amber)',  tip: 'Tables held for an upcoming booking or walk-in queue' },
              ].map(s => (
                <div key={s.label} className="card" style={{ padding: '12px 18px' }}>
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                    {s.tip ? <Tip text={s.tip}>{s.label}</Tip> : s.label}
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 700, color: s.color, marginTop: 4 }}>{s.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Section filter */}
          {sections.length > 1 && (
            <div className="tab-bar" style={{ marginBottom: 20 }}>
              {sections.map(s => (
                <button key={s} className={`tab-btn${secFilter === s ? ' tab-btn--active' : ''}`} onClick={() => setSecFilter(s)}>{s}</button>
              ))}
            </div>
          )}

          {floorMsg && (
            <div style={{
              background: floorMsg.startsWith('error:') ? 'rgba(248,113,113,0.08)' : 'rgba(52,211,153,0.08)',
              border: `1px solid ${floorMsg.startsWith('error:') ? 'rgba(248,113,113,0.25)' : 'rgba(52,211,153,0.25)'}`,
              borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13,
              color: floorMsg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)',
              cursor: 'pointer',
            }} onClick={() => setFloorMsg('')}>
              {floorMsg.replace(/^(error|ok):/, '')} <span style={{ opacity: 0.7 }}>(tap to dismiss)</span>
            </div>
          )}

          {/* Floor grid */}
          {loading ? (
            <p style={{ color: 'var(--theme-text3)' }}>Loading…</p>
          ) : visible.length === 0 && tables.length > 0 ? (
            <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--theme-text3)' }}>
              No tables in this section.
            </div>
          ) : tables.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 14 }}>
              {visible.map(t => (
                <div
                  key={t.id}
                  className="card"
                  onClick={() => openEdit(t)}
                  style={{ padding: '16px 18px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}
                >
                  <div style={{ margin: '-16px -18px 2px', height: 6, background: STATUS_COLOR[t.status] || 'var(--theme-border)', flexShrink: 0 }} />
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--theme-text1)', lineHeight: 1.2 }}>{t.name}</span>
                    <Tip text="Click to cycle: Available → Reserved → Occupied → Inactive.">
                      <span
                        className={STATUS_BADGE[t.status] || 'badge-gray'}
                        style={{ fontSize: 10, flexShrink: 0, cursor: 'pointer', borderBottom: 'none' }}
                        onClick={e => cycleStatus(t, e)}
                      >
                        {STATUS_LABEL[t.status] || t.status}
                      </span>
                    </Tip>
                  </div>
                  {t.section && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{t.section}</div>}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                    <div style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                      <Tip text="Seating capacity — edit the table to change it">👥 {t.capacity} seats</Tip>
                    </div>
                    <Tip text="View / print this table's guest menu QR code">
                      <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={e => openQr(t, e)}>▦ QR</button>
                    </Tip>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          <Fab show={tables.length > 0} onClick={openAdd} />
        </>
      )}

      {/* Add / Edit modal */}
      {modal && (
        <Modal onClose={closeModal}>
          <h3 style={{ margin: '0 0 18px', color: 'var(--theme-text1)' }}>
            {target ? `Edit — ${target.name}` : 'Add Table'}
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                Table Name <span style={{ color: 'var(--theme-red)' }}>*</span>{' '}
                <Tip text="Displayed on the floor plan and on bills — e.g. Table 1, Bar 3, Patio A" />
              </label>
              <input
                className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Table 1" autoFocus
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                  Section <Tip text="Groups tables by area — type a new name or pick an existing one." />
                </label>
                <input
                  style={{ width: '100%', boxSizing: 'border-box', padding: '7px 10px', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, color: 'var(--theme-text1)', fontSize: 13, outline: 'none' }}
                  value={form.section} onChange={e => setForm(f => ({ ...f, section: e.target.value }))}
                  placeholder="e.g. Indoor, Outdoor, Bar…" list="modal-section-list"
                />
                <datalist id="modal-section-list">
                  {existingSections.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                  Capacity <Tip text="Number of seats" />
                </label>
                <input type="number" min="1" className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                  value={form.capacity} onChange={e => setForm(f => ({ ...f, capacity: e.target.value }))} />
              </div>
            </div>

            {target && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                    Status <Tip text="Available = ready to seat. Occupied = active order. Reserved = booking. Inactive = out of service." />
                  </label>
                  <select className="form-select" style={{ width: '100%' }}
                    value={target.status} onChange={e => handleStatusChange(e.target.value)}>
                    {STATUS_CYCLE.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                    Sort Order <Tip text="Lower numbers appear first within a section" />
                  </label>
                  <input type="number" min="0" className="form-select" style={{ width: '100%', boxSizing: 'border-box' }}
                    value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))} />
                </div>
              </div>
            )}

            {msg && (
              <p style={{ margin: 0, fontSize: 12, color: msg.startsWith('error:') ? 'var(--theme-red)' : 'var(--theme-green)' }}>
                {msg.replace(/^(error|ok):/, '')}
              </p>
            )}

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
              {target && (
                <button className="btn btn-ghost"
                  style={{ color: 'var(--theme-red)', borderColor: 'var(--theme-red)', marginRight: 'auto' }}
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
    </div>
  )
}
