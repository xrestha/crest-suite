import { useState, useEffect } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'

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
  const { clientId, profile, hasPosAccess } = useAuth()

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

  useEffect(() => {
    if (!clientId) return
    loadFloor()
    supabase.from('settings').select('pos_bot_categories').eq('client_id', clientId).maybeSingle()
      .then(({ data }) => {
        const arr = data?.pos_bot_categories
        if (arr?.length) setBotCategories(new Set(arr))
      })
  }, [clientId]) // eslint-disable-line

  if (!hasPosAccess('staff')) return <Navigate to="/pos" replace />

  /* ── data loaders ── */

  async function loadFloor() {
    setFloorLoad(true)
    const [{ data: tbls }, { data: orders }] = await Promise.all([
      supabase.from('pos_tables').select('*').eq('client_id', clientId)
        .order('sort_order').order('name'),
      supabase.from('pos_orders')
        .select('id, table_id, covers, pos_order_items(qty, unit_price, vat_rate)')
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
      }
    }
    setTableOrders(map)
    setFloorLoad(false)
  }

  async function loadMenu() {
    if (!clientId || menuLoaded) return
    const { data } = await supabase
      .from('recipes')
      .select('id, name, category, selling_price, vat_rate')
      .eq('client_id', clientId)
      .eq('is_active', true)
      .eq('pos_enabled', true)
      .neq('category', 'Sub-Recipe')
      .order('name')
    setMenu(data || [])
    setMenuLoaded(true)
  }

  async function openTable(table) {
    const { data: existing } = await supabase
      .from('pos_orders')
      .select('id, covers, pos_order_items(id, recipe_id, name, category, qty, unit_price, vat_rate, sent_to_kot)')
      .eq('client_id', clientId)
      .eq('status', 'open')
      .eq('table_id', table.id)
      .maybeSingle()

    if (existing) {
      setActiveTable(table)
      setOrderId(existing.id)
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
    setOrderId(null); setOrderItems([])
    setCovers(n)
    setMsg(''); setCoversModal(false); setPendingTable(null)
    setView('order')
  }

  function openTakeaway() {
    setActiveTable(null); setOrderId(null); setCovers(1); setOrderItems([])
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
      }]
    })
    setMsg('')
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

  /* ── core save (shared by saveOrder and sendTicket) ── */

  async function performSave() {
    let oid = orderId

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
        .select('id').single()
      if (error || !newOrder) return null
      oid = newOrder.id
      setOrderId(oid)
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
      }))
    )
    if (iErr) return null
    loadFloor()
    return oid
  }

  async function saveOrder() {
    if (!clientId) return
    if (orderItems.length === 0) { setMsg('error:Add at least one item.'); return }
    setSaving(true); setMsg('')

    const wasNew = !orderId
    const oid = await performSave()
    if (!oid) { setSaving(false); setMsg('error:Save failed.'); return }

    if (wasNew) {
      // Auto-send all items to their stations on first save
      const kotItems = orderItems.filter(i => !botCategories.has(i.category || 'Other'))
      const botItems = orderItems.filter(i =>  botCategories.has(i.category || 'Other'))
      await supabase.from('pos_order_items').update({ sent_to_kot: true }).eq('order_id', oid)
      setOrderItems(prev => prev.map(i => ({ ...i, sent_to_kot: true, sent_qty: i.qty })))
      if (kotItems.length > 0) printTicket('KOT', kotItems)
      if (botItems.length > 0) printTicket('BOT', botItems)
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
    const oid = await performSave()
    if (!oid) { setSaving(false); setMsg('error:Save failed.'); return }

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
    printTicket(station, unsentItems)
  }

  function printTicket(station, items) {
    const tableName    = activeTable?.name || 'Takeaway'
    const now          = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    const date         = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })
    const stationLabel = station === 'BOT' ? 'BAR ORDER TICKET' : 'KITCHEN ORDER TICKET'

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
</style>
</head><body>
  <div class="c b lg">${stationLabel}</div>
  <hr>
  <div class="row"><span class="b">${tableName}</span><span>Covers: ${covers}</span></div>
  <div class="row" style="font-size:11px;color:#555"><span>${date}</span><span>${now}</span></div>
  <hr>
  ${items.map(i => {
      const delta = (i.sent_qty || 0) > 0 ? i.qty - i.sent_qty : 0
      const label = delta > 0 ? `+${delta}` : `×${i.qty}`
      return `<div class="row"><span class="b">${i.name}</span><span class="qty">${label}</span></div>`
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

  function backToFloor() {
    setView('floor'); setActiveTable(null); setOrderId(null); setOrderItems([]); setMsg('')
  }

  /* ── computed totals ── */
  const subEx    = orderItems.reduce((s, i) => s + i.qty * i.unit_price, 0)
  const vatAmt   = orderItems.reduce((s, i) => s + i.qty * i.unit_price * (i.vat_rate ?? 0), 0)
  const total    = subEx + vatAmt
  const kotCount = orderItems.filter(i => !i.sent_to_kot && !botCategories.has(i.category || 'Other')).length
  const botCount = orderItems.filter(i => !i.sent_to_kot && botCategories.has(i.category || 'Other')).length

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
                  display: 'flex', alignItems: 'center', gap: 8,
                  borderBottom: '1px solid var(--theme-border)', padding: '9px 0',
                }}>
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
              )
            })}
          </div>

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
        <button className="btn btn-ghost" onClick={openTakeaway} style={{ fontSize: 13, flexShrink: 0 }}>
          + Takeaway
        </button>
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
                  <span className={STATUS_BADGE[t.status] || 'badge-gray'} style={{ fontSize: 10, flexShrink: 0 }}>
                    {STATUS_LABEL[t.status] || t.status}
                  </span>
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
