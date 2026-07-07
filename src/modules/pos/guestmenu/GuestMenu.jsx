import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { NUTRIENTS } from '../../../utils/nutrition'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const fmtNutrient = (def, value) => `${(Number(value) || 0).toFixed(def.dp)} ${def.unit}`

// Same three stages + wording as the staff-side floor-view badge (PosOrders.jsx) and KDS board —
// worded from the guest's point of view: their order was Sent to the kitchen, is being Prepared,
// or is Ready to be served.
const KOT_STATUS_BADGE = { new: 'badge-red', in_progress: 'badge-amber', ready: 'badge-green' }
const KOT_STATUS_LABEL = { new: 'Order sent to kitchen', in_progress: 'Being prepared', ready: 'Ready to serve' }

// Fully public, unauthenticated page — reached by a guest scanning a table's QR code (see
// PosTableManagement.jsx's "Print QR" action). View-only: shows the live POS menu for that
// table's client, no ordering. All data comes from one RPC (get_guest_menu) that does its own
// authorization (table → client → pos_enabled check) since there's no logged-in session here to
// gate on — see migration 20260707100000_guest_menu.sql for why nutrition is computed
// server-side rather than shipped as raw ingredient data to be crunched in the browser.
export default function GuestMenu() {
  const { tableId } = useParams()
  const [rows, setRows] = useState(null) // null = loading, [] = loaded-but-empty
  const [error, setError] = useState(false)
  const [kotStatus, setKotStatus] = useState(null) // null = no open order / nothing sent yet

  useEffect(() => {
    let cancelled = false
    supabase.rpc('get_guest_menu', { p_table_id: tableId }).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) { setError(true); setRows([]); return }
      setRows(data || [])
    })
    return () => { cancelled = true }
  }, [tableId])

  // 5s poll while the guest has the menu open — same cadence as the staff floor-view badge.
  useEffect(() => {
    let cancelled = false
    const poll = () => supabase.rpc('get_guest_table_status', { p_table_id: tableId }).then(({ data }) => {
      if (cancelled) return
      const row = data?.[0]
      setKotStatus(row?.has_open_order ? row.kot_status : null)
    })
    poll()
    const id = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(id) }
  }, [tableId])

  if (rows === null) {
    return <CenteredMessage>Loading menu…</CenteredMessage>
  }
  if (error || rows.length === 0) {
    return <CenteredMessage>
      Menu not available. Please ask staff for assistance.
    </CenteredMessage>
  }

  const outletName = rows[0].outlet_name
  const tableName = rows[0].table_name
  const nutritionEnabled = rows[0].nutrition_enabled

  const categories = []
  const byCategory = {}
  for (const r of rows) {
    const cat = r.category || 'Other'
    if (!byCategory[cat]) { byCategory[cat] = []; categories.push(cat) }
    byCategory[cat].push(r)
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--theme-bg)', color: 'var(--theme-text1)' }}>
      <div style={{ maxWidth: 640, margin: '0 auto', padding: '28px 20px 60px' }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 700 }}>{outletName}</h1>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text3)' }}>{tableName}</p>
          {kotStatus && (
            <span className={KOT_STATUS_BADGE[kotStatus]} style={{ display: 'inline-block', marginTop: 10, fontSize: 11 }}>
              {KOT_STATUS_LABEL[kotStatus]}
            </span>
          )}
        </div>

        {categories.map(cat => (
          <div key={cat} style={{ marginBottom: 28 }}>
            <h2 style={{
              fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em',
              color: 'var(--theme-accent)', margin: '0 0 12px', paddingBottom: 6,
              borderBottom: '1px solid var(--theme-border)',
            }}>{cat}</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {byCategory[cat].map(item => <MenuItemCard key={item.recipe_id} item={item} nutritionEnabled={nutritionEnabled} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function MenuItemCard({ item, nutritionEnabled }) {
  const [imgFailed, setImgFailed] = useState(false)
  const price = parseFloat(item.selling_price) || 0
  const vat = parseFloat(item.vat_rate) || 0
  const priceIncVat = Math.round(price * (1 + vat))

  return (
    <div className="card" style={{ display: 'flex', gap: 14, padding: 14 }}>
      {item.image_url && !imgFailed && (
        <img
          src={item.image_url} alt={item.name} onError={() => setImgFailed(true)}
          style={{ width: 84, height: 84, borderRadius: 8, objectFit: 'cover', flexShrink: 0, background: 'var(--theme-input-bg)' }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {item.is_veg != null && (
              <span title={item.is_veg ? 'Veg' : 'Non-Veg'} style={{
                display: 'inline-block', width: 12, height: 12, borderRadius: 2, flexShrink: 0,
                border: `1.5px solid ${item.is_veg ? 'var(--theme-green)' : 'var(--theme-red)'}`,
              }}>
                <span style={{
                  display: 'block', width: 6, height: 6, margin: '2px auto', borderRadius: '50%',
                  background: item.is_veg ? 'var(--theme-green)' : 'var(--theme-red)',
                }} />
              </span>
            )}
            <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--theme-text1)' }}>{item.name}</span>
          </div>
          <span style={{ fontWeight: 700, fontSize: 15, color: 'var(--theme-accent)', whiteSpace: 'nowrap' }}>{fmtNpr(priceIncVat)}</span>
        </div>
        {item.description && (
          <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--theme-text2)', lineHeight: 1.4 }}>{item.description}</p>
        )}
        {nutritionEnabled && item.has_nutrition && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8 }}>
            {NUTRIENTS.map(def => (
              <span key={def.key} style={{ fontSize: 10.5, color: 'var(--theme-text3)' }}>
                {def.label} {fmtNutrient(def, item[def.key])}
              </span>
            ))}
          </div>
        )}
        {nutritionEnabled && item.has_nutrition && item.allergens?.length > 0 && (
          <p style={{ margin: '4px 0 0', fontSize: 10.5, color: 'var(--theme-amber)', textTransform: 'capitalize' }}>
            Allergens: {item.allergens.join(', ')}
          </p>
        )}
      </div>
    </div>
  )
}

function CenteredMessage({ children }) {
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--theme-bg)', color: 'var(--theme-text2)', fontSize: 14, padding: 24, textAlign: 'center',
    }}>
      {children}
    </div>
  )
}
