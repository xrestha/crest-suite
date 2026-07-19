import { useState, useEffect, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import SearchableSelect from '../../../components/SearchableSelect'
import { Navigate } from 'react-router-dom'

const fmtNpr = n => `NPR ${Math.round(n).toLocaleString()}`
const WINDOW_OPTIONS = [30, 90, 180]

export default function ComboBuilder() {
  const { clientId, hasImsAccess } = useAuth()
  const { scopedFrom } = useScopedDb()

  const [menu, setMenu] = useState([])
  const [menuLoading, setMenuLoading] = useState(true)
  const [anchorId, setAnchorId] = useState('')
  const [days, setDays] = useState(90)
  const [pairs, setPairs] = useState([])
  const [pairsLoading, setPairsLoading] = useState(false)
  const [discountPct, setDiscountPct] = useState(10)

  useEffect(() => {
    if (!clientId) return
    Promise.all([
      scopedFrom('recipes', 'id, name, category, selling_price')
        .eq('is_active', true).eq('pos_enabled', true)
        .neq('category', 'Sub-Recipe').order('name'),
      supabase.from('settings').select('combo_discount_pct').eq('client_id', clientId).maybeSingle(),
    ]).then(([{ data: recs }, { data: settings }]) => {
      const list = recs || []
      setMenu(list)
      setAnchorId(prev => prev || list[0]?.id || '')
      setDiscountPct(settings?.combo_discount_pct ?? 10)
      setMenuLoading(false)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  const loadPairs = useCallback(async () => {
    if (!clientId || !anchorId) { setPairs([]); return }
    setPairsLoading(true)
    const { data } = await supabase.rpc('get_cooccurrence', { p_client_id: clientId, p_recipe_id: anchorId, p_days: days })
    setPairs(data || [])
    setPairsLoading(false)
  }, [clientId, anchorId, days])

  useEffect(() => { loadPairs() }, [loadPairs])

  async function saveDiscountPct(raw) {
    const pct = Math.max(0, Math.min(100, parseFloat(raw) || 0))
    setDiscountPct(pct)
    if (!clientId) return
    await supabase.from('settings').update({ combo_discount_pct: pct }).eq('client_id', clientId)
  }

  const menuById = Object.fromEntries(menu.map(r => [r.id, r]))
  const anchor = menuById[anchorId]

  const rows = pairs
    .map(p => ({ paired_recipe_id: p.paired_recipe_id, coCount: Number(p.co_count), recipe: menuById[p.paired_recipe_id] }))
    .filter(p => p.recipe) // a paired recipe may have since gone inactive/off-POS — don't suggest it
    .sort((a, b) => b.coCount - a.coCount)

  const maxCo = rows.length > 0 ? rows[0].coCount : 0

  const menuOptions = menu.map(r => ({ value: r.id, label: `${r.name}${r.category ? ` (${r.category})` : ''}` }))

  if (!hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  return (
    <div style={{ padding: '24px 28px', maxWidth: 1000 }}>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, color: 'var(--theme-text1)', fontSize: 20 }}>
          Combo Builder{' '}
          <Tip text="Shows which items are actually ordered together most often at this table (from real POS bills, last N days) and suggests a discounted combo price. Insight-only — pick a pairing you like, then create the priced bundle yourself in Menu Pricing." width={320}>ⓘ</Tip>
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--theme-text3)' }}>
          What actually sells together — and what to charge if you bundle it.
        </p>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginBottom: 20 }}>
        <div style={{ minWidth: 260 }}>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
            <Tip text="The item to find pairings for — results show what's most often ordered alongside it." width={240}>Anchor Item</Tip>
          </label>
          <SearchableSelect value={anchorId} onChange={setAnchorId} options={menuOptions} placeholder="Select an item…" />
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>Window</label>
          <div className="tab-bar" style={{ marginBottom: 0 }}>
            {WINDOW_OPTIONS.map(d => (
              <button key={d} className={`tab-btn${days === d ? ' tab-btn--active' : ''}`} onClick={() => setDays(d)}>{d}d</button>
            ))}
          </div>
        </div>
        <div>
          <label style={{ fontSize: 11, color: 'var(--theme-text3)', display: 'block', marginBottom: 4 }}>
            <Tip text="Discount applied to the combined price when you bundle two items — used to compute the suggested combo price below. Saved per client." width={260}>Combo Discount %</Tip>
          </label>
          <input
            type="number" min="0" max="100" step="1" value={discountPct}
            onChange={e => setDiscountPct(e.target.value)}
            onBlur={e => saveDiscountPct(e.target.value)}
            className="form-select" style={{ width: 80 }}
          />
        </div>
      </div>

      {menuLoading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading menu…</p>
      ) : menu.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          No POS-enabled items yet — toggle items on in Menu Pricing first.
        </div>
      ) : pairsLoading ? (
        <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Loading pairings…</p>
      ) : rows.length === 0 ? (
        <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--theme-text3)', fontSize: 13 }}>
          No co-occurrence data yet for {anchor?.name || 'this item'} in the last {days} days — needs more bills with this item on them.
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Paired With</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text="How many bills in this window had both items on them" width={220}>Bills Together</Tip>
                </th>
                <th>Frequency</th>
                <th style={{ textAlign: 'right' }}>Combined Price</th>
                <th style={{ textAlign: 'right' }}>
                  <Tip text={`Combined price × (1 − ${discountPct}%) — round-number suggestion, not auto-created`} width={240}>Suggested Combo Price</Tip>
                </th>
                <th style={{ textAlign: 'right' }}>Savings</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const combined = (anchor?.selling_price || 0) + (p.recipe.selling_price || 0)
                const combo = combined * (1 - discountPct / 100)
                const savings = combined - combo
                const pct = maxCo > 0 ? (p.coCount / maxCo) * 100 : 0
                return (
                  <tr key={p.paired_recipe_id}>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>
                      {p.recipe.name}
                      {p.recipe.category && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-text3)' }}>{p.recipe.category}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{p.coCount}</td>
                    <td style={{ minWidth: 100 }}>
                      <div style={{ background: 'var(--theme-input-bg)', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--theme-accent)' }} />
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>{fmtNpr(combined)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--theme-accent)' }}>{fmtNpr(combo)}</td>
                    <td style={{ textAlign: 'right', color: 'var(--theme-green)' }}>−{fmtNpr(savings)}</td>
                    <td>
                      <a href="/menu-pricing" style={{ fontSize: 12, color: 'var(--theme-accent)', whiteSpace: 'nowrap' }}>Create as Menu Item →</a>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
