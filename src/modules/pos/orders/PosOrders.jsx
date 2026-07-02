import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import { adToBs, BS_MONTHS } from '../../../utils/bsCalendar'

const vatOf  = r => (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`

const STATUS_BADGE = { available: 'badge-green', occupied: 'badge-red', reserved: 'badge-amber', inactive: 'badge-gray' }
const STATUS_LABEL = { available: 'Available', occupied: 'Occupied', reserved: 'Reserved', inactive: 'Inactive' }

const btnSm = {
  width: 26, height: 26, borderRadius: 4,
  border: '1px solid var(--theme-border)',
  background: 'var(--theme-input-bg)',
  color: 'var(--theme-text1)',
  cursor: 'pointer', fontSize: 16, lineHeight: 1,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  flexShrink: 0,
}

export default function PosOrders() {
  const { clientId, profile, hasPosAccess, isAdmin } = useAuth()

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

  useEffect(() => {
    if (!clientId) return
    loadFloor()
    supabase.from('settings').select('pos_bot_categories, pos_note_presets').eq('client_id', clientId).maybeSingle()
      .then(({ data }) => {
        const arr = data?.pos_bot_categories
        if (arr?.length) setBotCategories(new Set(arr))
        setNotePresets(data?.pos_note_presets || [])
      })
    supabase.from('clients').select('name').eq('id', clientId).single()
      .then(({ data }) => setOutletName(data?.name || ''))
  }, [clientId]) // eslint-disable-line

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  /* ── data loaders ── */

  async function loadFloor() {
    setFloorLoad(true)
    const [{ data: tbls }, { data: orders }] = await Promise.all([
      supabase.from('pos_tables').select('*').eq('client_id', clientId)
        .order('sort_order').order('name'),
      supabase.from('pos_orders')
        .select('id, table_id, covers, pos_order_items(qty, unit_price, vat_rate, sent_to_kot)')
        .eq('client_id', clientId).eq('status', 'open'),
    ])
    setTables(tbls || [])
    const map = {}
    for (const o of (orders || [])) {
      if (!o.table_id) continue
      const items = o.pos_order_items || []
      map[o.table_id] = {
        orderId:   o.id,
        itemCount: items.reduce((s, i) => s + i.qty, 0),
        total:     items.reduce((s, i) => s + i.qty * i.unit_price * (1 + (i.vat_rate ?? 0)), 0),
        covers:    o.covers,
        pending:   items.filter(i => !i.sent_to_kot).length,
      }
    }
    setTableOrders(map)
    setFloorLoad(false)
  }

  async function loadMenu() {
    if (!clientId || menuLoaded) return
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
    if (suggData) {
      const map = {}
      suggData.forEach(s => {
        if (!map[s.recipe_id]) map[s.recipe_id] = []
        map[s.recipe_id].push(s.suggest_recipe_id)
      })
      setManualSuggestions(map)
    }
    setMenuLoaded(true)
  }

  async function openTable(table) {
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
      setOrderItems((existing.pos_order_items || []).map(i => ({
        ...i,
        sent_qty: i.sent_to_kot ? i.qty : 0,
      })))
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
    const vat = vatOf(recipe)
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

    if (!oid) {
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
      orderItems.map(i => ({
        order_id:    oid,
        client_id:   clientId,
        recipe_id:   i.recipe_id || null,
        name:        i.name,
        category:    i.category   || 'Other',
        qty:         i.qty,
        unit_price:  i.unit_price,
        vat_rate:    i.vat_rate   ?? 0,
        sent_to_kot: i.sent_to_kot || false,
        notes:       i.notes || null,
      }))
    )
    if (iErr) return null
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
      await supabase.from('pos_order_items').update({ sent_to_kot: true }).eq('order_id', oid)
      setOrderItems(prev => prev.map(i => ({ ...i, sent_to_kot: true, sent_qty: i.qty })))
      if (kotItems.length > 0) printTicket('KOT', kotItems, oNo)
      if (botItems.length > 0) printTicket('BOT', botItems, oNo)
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

    // Mark sent in DB by recipe_id (unique per order)
    const recipeIds = unsentItems.map(i => i.recipe_id).filter(Boolean)
    if (recipeIds.length > 0) {
      await supabase.from('pos_order_items')
        .update({ sent_to_kot: true })
        .eq('order_id', oid)
        .in('recipe_id', recipeIds)
    }

    // Update local state
    const sentSet = new Set(recipeIds)
    setOrderItems(prev => prev.map(i =>
      sentSet.has(i.recipe_id) ? { ...i, sent_to_kot: true, sent_qty: i.qty } : i
    ))

    setSaving(false)
    setMsg(`ok:${station} sent!`)
    printTicket(station, unsentItems, oNo)
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
  body { font-family:'Courier New',monospace; font-size:13px; width:80mm; padding:8px 10px; }
  .c   { text-align:center; }
  .b   { font-weight:bold; }
  .lg  { font-size:17px; letter-spacing:1px; }
  hr   { border:none; border-top:1px dashed #000; margin:7px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; padding:3px 0; }
  .qty { font-weight:bold; font-size:15px; min-width:34px; text-align:right; }
  .note { font-size:11px; font-style:italic; color:#333; padding:0 0 3px 10px; }
</style>
</head><body>
  ${outletName ? `<div class="c b" style="font-size:14px">${outletName}</div>` : ''}
  <div class="c b lg">${stationLabel}</div>
  <hr>
  <div class="row"><span class="b" style="font-size:15px">${tableName}</span><span class="b" style="font-size:15px">${ticketNo ? `#${ticketNo}` : ''}</span></div>
  <div class="row"><span>${takenBy ? `Taken by: ${takenBy}` : ''}</span><span>Covers: ${covers}</span></div>
  <div class="row" style="font-size:11px;color:#555"><span>${date}</span><span>${now}</span></div>
  <hr>
  ${items.map(i => {
      const delta = (i.sent_qty || 0) > 0 ? i.qty - i.sent_qty : 0
      const label = delta > 0 ? `+${delta}` : `×${i.qty}`
      const note  = i.notes ? `<div class="note">↳ ${i.notes}</div>` : ''
      return `<div class="row"><span class="b">${i.name}</span><span class="qty">${label}</span></div>${note}`
    }).join('')}
  <hr>
</body></html>`

    const w = window.open('', '_blank', 'width=340,height=480,left=200,top=100')
    if (!w) { setMsg('error:Allow pop-ups to print.'); return }
    w.document.write(html)
    w.document.close()
    w.focus()
    setTimeout(() => { w.print(); w.close() }, 300)
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

  /* ── computed totals ── */
  const subEx    = orderItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const vatAmt   = orderItems.reduce((s, i) => s + i.qty * i.unit_price * (i.vat_rate ?? 0), 0)
  const total    = subEx + vatAmt
  const kotCount = orderItems.filter(i => !i.sent_to_kot && !botCategories.has(i.category || 'Other')).length
  const botCount = orderItems.filter(i => !i.sent_to_kot && botCategories.has(i.category || 'Other')).length

  const pendingTables    = Object.values(tableOrders).filter(o => o.pending > 0)
  const pendingTableCount = pendingTables.length
  const pendingItemCount  = pendingTables.reduce((s, o) => s + o.pending, 0)

  const sections  = ['All', ...Array.from(new Set(tables.map(t => t.section).filter(Boolean)))]
  const visTables = secFilter === 'All' ? tables : tables.filter(t => t.section === secFilter)
  const menuCats  = ['All', ...Array.from(new Set(menu.map(r => r.category))).sort()]
  const visMenu   = catTab === 'All' ? menu : menu.filter(r => r.category === catTab)

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
            display: 'flex', gap: 6, overflowX: 'auto', scrollbarWidth: 'none',
          }}>
            {menuCats.map(c => (
              <button key={c} className={`tab-btn${catTab === c ? ' tab-btn--active' : ''}`}
                onClick={() => setCatTab(c)} style={{ flexShrink: 0 }}>{c}</button>
            ))}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
            {!menuLoaded ? (
              <p style={{ color: 'var(--theme-text3)', margin: 0 }}>Loading menu…</p>
            ) : visMenu.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', margin: 0 }}>
                {menu.length === 0
                  ? 'No POS-enabled items. Toggle items On POS in Menu Pricing first.'
                  : 'No items in this category.'}
              </p>
            ) : (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
                gap: 10,
              }}>
                {visMenu.map(r => {
                  const vat   = vatOf(r)
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
              const lineTotal = item.qty * item.unit_price * (1 + (item.vat_rate ?? 0))
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
                  const price        = Math.round((parseFloat(r.selling_price) || 0) * (1 + vatOf(r)))
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

            <button
              className="btn btn-primary"
              style={{ width: '100%', padding: '12px 0', fontSize: 16, marginBottom: 8, justifyContent: 'center' }}
              onClick={saveOrder}
              disabled={saving || orderItems.length === 0}
            >
              {saving ? 'Sending…' : orderId ? 'Update Order' : 'Send Order'}
            </button>

            <div style={{ display: 'flex', gap: 8 }}>
              <Tip text="Kitchen Order Ticket — sends unsent food items to the kitchen printer. Badge shows how many items are waiting.">
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1, padding: '8px 0', fontSize: 13, justifyContent: 'center', position: 'relative' }}
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
              <Tip text="Bar Order Ticket — sends unsent bar/beverage items to the bar printer. Badge shows how many items are waiting.">
                <button
                  className="btn btn-ghost"
                  style={{ flex: 1, padding: '8px 0', fontSize: 13, justifyContent: 'center', position: 'relative' }}
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
              <Tip text="Billing & payment — coming next">
                <button className="btn btn-ghost"
                  style={{ flex: 1, padding: '8px 0', fontSize: 13, opacity: 0.4, cursor: 'not-allowed', justifyContent: 'center' }}
                  disabled>
                  Charge →
                </button>
              </Tip>
            </div>
          </div>
        </div>

      </div>
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
    </>
  )
}
