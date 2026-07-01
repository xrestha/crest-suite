import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

function fcColor(pct) {
  if (pct <= 30) return 'var(--theme-green)'
  if (pct <= 38) return 'var(--theme-amber)'
  return 'var(--theme-red)'
}

function vatOf(r) {
  return (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
}

export default function MenuPricing() {
  const { clientId, profile } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [recipes, setRecipes]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [catTab, setCatTab]     = useState('All')
  const [drafts, setDrafts]     = useState({})   // { id: string (incl-VAT input) }
  const [saving, setSaving]     = useState({})   // { id: bool }
  const [errors, setErrors]     = useState({})   // { id: string }
  const [toggling, setToggling] = useState({})   // { id: bool }

  const load = useCallback(async () => {
    if (!effectiveClientId) return
    setLoading(true)

    const { data: recipeData } = await supabase
      .from('recipes')
      .select('id, name, category, selling_price, vat_rate, pos_enabled')
      .eq('client_id', effectiveClientId)
      .eq('is_active', true)
      .neq('category', 'Sub-Recipe')
      .order('name')

    const recipeIds = (recipeData || []).map(r => r.id)
    const { data: ingData } = recipeIds.length > 0
      ? await supabase
          .from('recipe_ingredients')
          .select('recipe_id, qty_per_portion, items(per_uom_rate, yield_pct)')
          .in('recipe_id', recipeIds)
      : { data: [] }

    const costMap = {}
    for (const ri of (ingData || [])) {
      const rate = parseFloat(ri.items?.per_uom_rate || 0)
      const yf   = (parseFloat(ri.items?.yield_pct) || 100) / 100
      costMap[ri.recipe_id] = (costMap[ri.recipe_id] || 0) + (parseFloat(ri.qty_per_portion || 0) / yf) * rate
    }

    const processed = (recipeData || []).map(r => {
      const cost    = costMap[r.id] || 0
      const vat     = vatOf(r)
      const exVat   = parseFloat(r.selling_price || 0)
      const inclVat = exVat > 0 ? exVat * (1 + vat) : 0
      const fcPct   = exVat > 0 ? (cost / exVat) * 100 : 0
      // pos_enabled defaults to true if null (column newly added)
      return { ...r, cost, vat, exVat, inclVat, fcPct, pos_enabled: r.pos_enabled !== false }
    })

    setRecipes(processed)
    setLoading(false)
  }, [effectiveClientId])

  useEffect(() => { load() }, [load])

  const tabs    = ['All', ...Array.from(new Set(recipes.map(r => r.category))).sort()]
  const display = catTab === 'All' ? recipes : recipes.filter(r => r.category === catTab)

  function setDraft(id, val) {
    setDrafts(d => ({ ...d, [id]: val }))
    setErrors(e => { const n = { ...e }; delete n[id]; return n })
  }

  async function togglePos(recipe) {
    const newVal = !recipe.pos_enabled
    setToggling(t => ({ ...t, [recipe.id]: true }))
    const { error } = await supabase
      .from('recipes')
      .update({ pos_enabled: newVal })
      .eq('id', recipe.id)
    if (!error) {
      setRecipes(rs => rs.map(r => r.id === recipe.id ? { ...r, pos_enabled: newVal } : r))
    }
    setToggling(t => ({ ...t, [recipe.id]: false }))
  }

  async function saveRow(recipe) {
    const raw = parseFloat(drafts[recipe.id])
    if (!raw || raw <= 0) { setErrors(e => ({ ...e, [recipe.id]: 'Enter a valid price' })); return }
    const newExVat = raw / (1 + recipe.vat)
    setSaving(s => ({ ...s, [recipe.id]: true }))
    const { error } = await supabase
      .from('recipes')
      .update({ selling_price: parseFloat(newExVat.toFixed(4)) })
      .eq('id', recipe.id)
    if (error) {
      setErrors(e => ({ ...e, [recipe.id]: 'Save failed' }))
    } else {
      setRecipes(rs => rs.map(r => {
        if (r.id !== recipe.id) return r
        const newFcPct = newExVat > 0 ? (r.cost / newExVat) * 100 : 0
        return { ...r, exVat: newExVat, inclVat: raw, fcPct: newFcPct, selling_price: newExVat }
      }))
      setDrafts(d => { const n = { ...d }; delete n[recipe.id]; return n })
    }
    setSaving(s => ({ ...s, [recipe.id]: false }))
  }

  const th = (align, tip, label, width) => (
    <th style={{ textAlign: align || 'left', width }}>
      {tip ? <Tip text={tip} width={240}>{label}</Tip> : label}
    </th>
  )

  const posOnCount  = recipes.filter(r => r.pos_enabled).length
  const posOffCount = recipes.filter(r => !r.pos_enabled).length

  return (
    <div className="page-container">
      <div style={{ marginBottom: 20 }}>
        <h1 className="page-title">Menu Pricing</h1>
        <p className="page-subtitle">
          Review food cost and update menu prices. Toggle <strong>On POS</strong> to control which items appear on the POS order screen.
        </p>
      </div>

      {/* POS summary strip */}
      {!loading && recipes.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <span style={{ fontSize: 12, color: 'var(--theme-green)' }}>
            ● {posOnCount} item{posOnCount !== 1 ? 's' : ''} on POS
          </span>
          {posOffCount > 0 && (
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
              ● {posOffCount} hidden from POS
            </span>
          )}
        </div>
      )}

      {/* Category tabs */}
      <div className="tab-bar" style={{ marginBottom: 16 }}>
        {tabs.map(t => {
          const count = t === 'All' ? recipes.length : recipes.filter(r => r.category === t).length
          return (
            <button key={t} className={`tab-btn${catTab === t ? ' tab-btn--active' : ''}`} onClick={() => setCatTab(t)}>
              {t} <span style={{ fontSize: 11, opacity: 0.65, marginLeft: 4 }}>{count}</span>
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : display.length === 0 ? (
        <div className="empty-state">No menu items found. Add recipes in Recipe Costing first.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {th('left',  null, '#', 36)}
                {th('center', 'Toggle to include or exclude this item from the POS order screen. Turn off for seasonal or discontinued items without deleting the recipe.', 'On POS', 72)}
                {th('left',  'Recipe name, category, and VAT status. VAT 13% items: selling price includes 13% VAT. No VAT items are sold at the price as entered.', 'Item')}
                {th('right', 'Total ingredient cost per portion at current item rates from the Item Master.', 'Food Cost', 100)}
                {th('right', 'Current VAT-inclusive menu price saved in Recipe Costing. Calculated as selling price × (1 + VAT rate).', 'Current Price', 120)}
                {th('right', 'Food cost ÷ ex-VAT selling price. Green ≤30%, amber 31–38%, red >38%. Nepal F&B target: 28–35%.', 'FC %', 80)}
                {th('right', 'Enter a new VAT-inclusive menu price. The ex-VAT price and FC% are back-calculated automatically. Press Enter to save.', 'New Price (incl VAT)', 150)}
                {th('right', 'Projected FC% at the new price. Updates live as you type.', 'New FC %', 90)}
                {th('right', 'Difference between new and current VAT-inclusive price. Green = price increase, red = price decrease.', 'Change', 90)}
                {th(null, null, '', 72)}
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => {
                const draft      = drafts[r.id]
                const hasDraft   = draft !== undefined && draft !== ''
                const draftNum   = hasDraft ? parseFloat(draft) : null
                const draftExVat = draftNum > 0 ? draftNum / (1 + r.vat) : null
                const newFcPct   = draftExVat > 0 ? (r.cost / draftExVat) * 100 : null
                const diff       = draftNum !== null && r.inclVat > 0 ? draftNum - r.inclVat : null
                const changed    = hasDraft && draftNum !== r.inclVat
                const dimmed     = !r.pos_enabled

                return (
                  <tr key={r.id} style={{ opacity: dimmed ? 0.45 : 1, background: changed ? 'rgba(245,158,11,0.05)' : undefined }}>
                    <td style={{ color: 'var(--theme-text2)' }}>{i + 1}</td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={r.pos_enabled}
                        disabled={toggling[r.id]}
                        onChange={() => togglePos(r)}
                        style={{ cursor: 'pointer', width: 15, height: 15, accentColor: 'var(--theme-green)' }}
                      />
                    </td>
                    <td>
                      <strong>{r.name}</strong>
                      <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                        {r.category}
                        {r.vat > 0
                          ? <Tip text="VAT-registered item. Menu price includes 13% VAT. FC% is calculated on the ex-VAT portion." width={260}> · VAT 13%</Tip>
                          : <Tip text="No VAT on this item. Menu price = ex-VAT price. FC% = food cost ÷ full selling price." width={240}> · No VAT</Tip>
                        }
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {r.cost > 0 ? `NPR ${r.cost.toFixed(2)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {r.inclVat > 0 ? `NPR ${r.inclVat.toFixed(0)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.exVat > 0 ? fcColor(r.fcPct) : 'var(--theme-text3)' }}>
                      {r.exVat > 0 ? `${r.fcPct.toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="number" min="0" step="any"
                        value={draft !== undefined ? draft : ''}
                        placeholder={r.inclVat > 0 ? r.inclVat.toFixed(0) : '0'}
                        onChange={e => setDraft(r.id, e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && changed && saveRow(r)}
                        style={{
                          background: 'var(--theme-input-bg)',
                          border: `1px solid ${changed ? 'var(--theme-amber)' : 'var(--theme-border)'}`,
                          borderRadius: 5, padding: '5px 8px', fontSize: 13,
                          color: 'var(--theme-text1)', outline: 'none',
                          width: 110, textAlign: 'right',
                        }}
                      />
                      {errors[r.id] && <div style={{ fontSize: 10, color: 'var(--theme-red)', marginTop: 2 }}>{errors[r.id]}</div>}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: newFcPct !== null ? 700 : 400, color: newFcPct !== null ? fcColor(newFcPct) : 'var(--theme-text3)' }}>
                      {newFcPct !== null ? `${newFcPct.toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: diff !== null ? 600 : 400, color: diff === null ? 'var(--theme-text3)' : diff > 0 ? 'var(--theme-green)' : 'var(--theme-red)' }}>
                      {diff !== null ? `${diff > 0 ? '+' : ''}NPR ${Math.round(diff)}` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {changed && (
                        <button
                          className="btn btn-primary"
                          style={{ fontSize: 12, padding: '4px 14px' }}
                          disabled={saving[r.id] || !draftNum || draftNum <= 0}
                          onClick={() => saveRow(r)}
                        >
                          {saving[r.id] ? '…' : 'Save'}
                        </button>
                      )}
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
