import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'

function fcColor(pct) {
  if (pct <= 30) return 'var(--theme-green)'
  if (pct <= 38) return 'var(--theme-amber)'
  return 'var(--theme-red)'
}

function vatOf(r) {
  return (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
}

const EMPTY_FORM = { name: '', category: '', price: '', vatRate: 0.13, costPrice: '' }

export default function MenuPricing() {
  const { clientId, profile, clientModules } = useAuth()
  const effectiveClientId = clientId || profile?.client_id
  const [recipes, setRecipes]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [catTab, setCatTab]     = useState('All')
  const [drafts, setDrafts]     = useState({})   // { id: string (incl-VAT input) }
  const [saving, setSaving]     = useState({})   // { id: bool }
  const [errors, setErrors]     = useState({})   // { id: string }
  const [toggling, setToggling] = useState({})   // { id: bool }

  const [addModal,   setAddModal]   = useState(false)
  const [addForm,    setAddForm]    = useState(EMPTY_FORM)
  const [addSaving,  setAddSaving]  = useState(false)
  const [addError,   setAddError]   = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [editingId,  setEditingId]  = useState(null) // recipe id being edited, or null when adding new (POS-only view)

  const [suggMap,       setSuggMap]       = useState({})   // { recipeId: [suggestedRecipeId] }
  const [suggestModal,  setSuggestModal]  = useState(null) // recipe object
  const [pairingDraft,  setPairingDraft]  = useState(new Set())
  const [pairingSaving, setPairingSaving] = useState(false)
  const [pairingSearch, setPairingSearch] = useState('')

  const load = useCallback(async () => {
    if (!effectiveClientId) return
    setLoading(true)

    const [{ data: recipeData }, { data: subRecipeData }] = await Promise.all([
      supabase.from('recipes')
        .select('id, name, category, selling_price, vat_rate, pos_enabled, cost_price')
        .eq('client_id', effectiveClientId)
        .eq('is_active', true)
        .neq('category', 'Sub-Recipe')
        .order('name'),
      supabase.from('recipes')
        .select('id, yield_qty')
        .eq('client_id', effectiveClientId)
        .eq('category', 'Sub-Recipe'),
    ])

    const allIds = [
      ...(recipeData || []).map(r => r.id),
      ...(subRecipeData || []).map(r => r.id),
    ]
    const { data: ingData } = allIds.length > 0
      ? await supabase
          .from('recipe_ingredients')
          .select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(per_uom_rate, yield_pct)')
          .in('recipe_id', allIds)
      : { data: [] }

    // Build per-sub-recipe ingredient list for recursive cost
    const subIngMap = {}
    const subIdSet = new Set((subRecipeData || []).map(sr => sr.id))
    for (const ri of (ingData || [])) {
      if (!subIdSet.has(ri.recipe_id)) continue
      if (!subIngMap[ri.recipe_id]) subIngMap[ri.recipe_id] = []
      subIngMap[ri.recipe_id].push(ri)
    }

    function subCostPerUnit(srId) {
      const sr = (subRecipeData || []).find(r => r.id === srId)
      if (!sr) return 0
      const ings = subIngMap[srId] || []
      let total = 0
      for (const ri of ings) {
        if (ri.item_id && ri.items) {
          const yf = (parseFloat(ri.items.yield_pct) || 100) / 100
          total += (parseFloat(ri.qty_per_portion || 0) / yf) * parseFloat(ri.items.per_uom_rate || 0)
        } else if (ri.sub_recipe_id) {
          total += parseFloat(ri.qty_per_portion || 0) * subCostPerUnit(ri.sub_recipe_id)
        }
      }
      return total / (parseFloat(sr.yield_qty) || 1)
    }

    const mainIdSet = new Set((recipeData || []).map(r => r.id))
    const costMap = {}
    for (const ri of (ingData || [])) {
      if (!mainIdSet.has(ri.recipe_id)) continue
      if (ri.item_id && ri.items) {
        const rate = parseFloat(ri.items.per_uom_rate || 0)
        const yf   = (parseFloat(ri.items.yield_pct) || 100) / 100
        costMap[ri.recipe_id] = (costMap[ri.recipe_id] || 0) + (parseFloat(ri.qty_per_portion || 0) / yf) * rate
      } else if (ri.sub_recipe_id) {
        costMap[ri.recipe_id] = (costMap[ri.recipe_id] || 0) + parseFloat(ri.qty_per_portion || 0) * subCostPerUnit(ri.sub_recipe_id)
      }
    }

    const processed = (recipeData || []).map(r => {
      // POS-only clients can't link Item Master ingredients (no IMS access), so a recipe with
      // no ingredient-derived cost falls back to the manually entered cost_price from Add Item.
      const cost    = costMap[r.id] || parseFloat(r.cost_price) || 0
      const vat     = vatOf(r)
      const exVat   = parseFloat(r.selling_price || 0)
      const inclVat = exVat > 0 ? exVat * (1 + vat) : 0
      const fcPct   = exVat > 0 ? (cost / exVat) * 100 : 0
      // pos_enabled defaults to true if null (column newly added)
      return { ...r, cost, vat, exVat, inclVat, fcPct, pos_enabled: r.pos_enabled !== false }
    })

    setRecipes(processed)

    // Load manual pairings (recipe_suggestions)
    const { data: suggData } = await supabase
      .from('recipe_suggestions')
      .select('recipe_id, suggest_recipe_id')
      .eq('client_id', effectiveClientId)
    const sMap = {}
    ;(suggData || []).forEach(s => {
      if (!sMap[s.recipe_id]) sMap[s.recipe_id] = []
      sMap[s.recipe_id].push(s.suggest_recipe_id)
    })
    setSuggMap(sMap)

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

  async function saveNewItem() {
    if (!effectiveClientId) { setAddError('No client selected. Pick a client in the top-left switcher before saving.'); return }
    if (!addForm.name.trim()) { setAddError('Name is required.'); return }
    const priceNum = parseFloat(addForm.price)
    if (!priceNum || priceNum <= 0) { setAddError('Enter a valid price.'); return }
    const exVat = priceNum / (1 + addForm.vatRate)
    const costPriceNum = parseFloat(addForm.costPrice)
    setAddSaving(true); setAddError('')
    const payload = {
      name:          addForm.name.trim(),
      category:      addForm.category.trim() || 'Other',
      selling_price: parseFloat(exVat.toFixed(4)),
      vat_rate:      addForm.vatRate,
      cost_price:    costPriceNum > 0 ? costPriceNum : null,
    }
    const { error } = editingId
      ? await supabase.from('recipes').update(payload).eq('id', editingId)
      : await supabase.from('recipes').insert({
          client_id:   effectiveClientId,
          is_active:   true,
          pos_enabled: true,
          ...payload,
        })
    setAddSaving(false)
    if (error) { setAddError(error.message); return }
    setAddModal(false); setAddForm(EMPTY_FORM); setEditingId(null)
    load()
  }

  function openEditModal(recipe) {
    setEditingId(recipe.id)
    setAddForm({
      name:      recipe.name,
      category:  recipe.category,
      price:     recipe.inclVat > 0 ? recipe.inclVat.toFixed(2) : '',
      vatRate:   recipe.vat,
      costPrice: recipe.cost_price != null ? String(recipe.cost_price) : '',
    })
    setAddError('')
    setAddModal(true)
  }

  const th = (align, tip, label, width) => (
    <th style={{ textAlign: align || 'left', width }}>
      {tip ? <Tip text={tip} width={240}>{label}</Tip> : label}
    </th>
  )

  const posOnCount  = recipes.filter(r => r.pos_enabled).length
  const posOffCount = recipes.filter(r => !r.pos_enabled).length

  /* ── POS-only view (no IMS) ─────────────────────────────────────────────── */
  if (!clientModules?.ims) return (
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Menu Pricing</h1>
          <p className="page-subtitle">Set menu prices and toggle <strong>On POS</strong> to control which items appear on the order screen.</p>
        </div>
        <button className="btn btn-primary" style={{ flexShrink: 0 }} onClick={() => { setEditingId(null); setAddForm(EMPTY_FORM); setAddError(''); setAddModal(true) }}>
          + Add Item
        </button>
      </div>

      {!loading && recipes.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 16 }}>
          <span style={{ fontSize: 12, color: 'var(--theme-green)' }}>● {posOnCount} item{posOnCount !== 1 ? 's' : ''} on POS</span>
          {posOffCount > 0 && <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>● {posOffCount} hidden from POS</span>}
        </div>
      )}

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
        <div className="empty-state">No menu items yet. Use <strong>+ Add Item</strong> above to add your first item.</div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 72, textAlign: 'center' }}>
                  <Tip text="Toggle to include or exclude this item from the POS order screen." width={220}>On POS</Tip>
                </th>
                <th><Tip text="Item name, category, and VAT status." width={200}>Item</Tip></th>
                <th style={{ textAlign: 'right', width: 110 }}>
                  <Tip text="What this item costs you to buy/produce, entered via Edit. Used to value Complimentary Slips and comp reporting." width={260}>Cost Price</Tip>
                </th>
                <th style={{ textAlign: 'right', width: 140 }}>
                  <Tip text="VAT-inclusive menu price." width={180}>Price</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => (
                <tr key={r.id} style={{ opacity: r.pos_enabled ? 1 : 0.45 }}>
                  <td style={{ color: 'var(--theme-text2)' }}>{i + 1}</td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={r.pos_enabled} disabled={toggling[r.id]}
                      onChange={() => togglePos(r)}
                      style={{ cursor: 'pointer', width: 15, height: 15, accentColor: 'var(--theme-green)' }} />
                  </td>
                  <td>
                    <strong>{r.name}</strong>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                      {r.category}
                      {r.vat > 0
                        ? <Tip text="Menu price includes 13% VAT." width={200}> · VAT 13%</Tip>
                        : <Tip text="No VAT on this item." width={160}> · No VAT</Tip>}
                      {' · '}
                      <button onClick={() => openEditModal(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, color: 'var(--theme-text3)', textDecoration: 'underline' }}>
                        Edit
                      </button>
                      {' · '}
                      <Tip text="Set which items appear as 'Pair with' suggestions when staff tap this item on the POS order screen." width={260}>
                        <button onClick={() => openSuggestModal(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, color: (suggMap[r.id]?.length || 0) > 0 ? 'var(--theme-accent)' : 'var(--theme-text3)', textDecoration: 'underline' }}>
                          {(suggMap[r.id]?.length || 0) > 0 ? `${suggMap[r.id].length} pairing${suggMap[r.id].length !== 1 ? 's' : ''}` : 'Pair'}
                        </button>
                      </Tip>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    {r.cost_price > 0 ? `NPR ${parseFloat(r.cost_price).toFixed(0)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--theme-text1)' }}>
                    {r.inclVat > 0 ? `NPR ${r.inclVat.toFixed(0)}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Pair With Modal (POS-only clients) ── */}
      {suggestModal && (
        <div onClick={e => { if (e.target === e.currentTarget) setSuggestModal(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12, width: 'min(480px, 96vw)', padding: '24px 28px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, color: 'var(--theme-text1)' }}>Pair with — {suggestModal.name}</h3>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
              Checked items appear as "Pair with" chips when staff tap this item on the POS order screen.
            </p>
            <input
              autoFocus
              placeholder="Search items…"
              value={pairingSearch}
              onChange={e => setPairingSearch(e.target.value)}
              style={{ background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)', marginBottom: 10, flexShrink: 0 }}
            />
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {recipes
                .filter(r => r.id !== suggestModal.id && r.name.toLowerCase().includes(pairingSearch.toLowerCase()))
                .map(r => (
                  <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', background: pairingDraft.has(r.id) ? 'color-mix(in srgb, var(--theme-accent) 10%, var(--theme-card))' : 'transparent' }}>
                    <input type="checkbox" checked={pairingDraft.has(r.id)}
                      onChange={() => setPairingDraft(s => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n })}
                      style={{ accentColor: 'var(--theme-accent)', cursor: 'pointer', width: 15, height: 15, flexShrink: 0 }}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--theme-text1)' }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{r.category} · {r.inclVat > 0 ? `NPR ${r.inclVat.toFixed(0)}` : '—'}</div>
                    </div>
                  </label>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setSuggestModal(null)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={savePairings} disabled={pairingSaving}>
                {pairingSaving ? 'Saving…' : `Save${pairingDraft.size > 0 ? ` (${pairingDraft.size})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {addModal && (
        <div onClick={e => { if (e.target === e.currentTarget) { setAddModal(false); setEditingId(null) } }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12, width: 'min(440px, 96vw)', padding: '24px 28px', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 16, color: 'var(--theme-text1)' }}>{editingId ? 'Edit Menu Item' : 'Add Menu Item'}</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>Item Name *</label>
                <input autoFocus value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()} placeholder="e.g. Cappuccino"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>Category</label>
                <input list="menu-cats-pos" value={addForm.category} onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                  placeholder="Beverage / Food / Dessert / Other"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
                <datalist id="menu-cats-pos">
                  {['Beverage', 'Food', 'Dessert', 'Snack', 'Other', ...Array.from(new Set(recipes.map(r => r.category))).sort()]
                    .filter((v, i, a) => a.indexOf(v) === i).map(c => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>VAT</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[{ label: 'VAT 13%', val: 0.13 }, { label: 'No VAT', val: 0 }].map(opt => (
                    <button key={opt.val} onClick={() => setAddForm(f => ({ ...f, vatRate: opt.val }))} style={{
                      flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                      background: addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                      color: addForm.vatRate === opt.val ? 'var(--theme-accent-text, #000)' : 'var(--theme-text2)',
                      border: `1px solid ${addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                      fontWeight: addForm.vatRate === opt.val ? 700 : 400,
                    }}>{opt.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                  {addForm.vatRate > 0 ? 'Menu Price (incl. VAT) *' : 'Menu Price *'}
                </label>
                <input type="number" min="0" step="any" value={addForm.price}
                  onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()} placeholder="e.g. 290"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
                {addForm.price && parseFloat(addForm.price) > 0 && addForm.vatRate > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                    Ex-VAT: NPR {(parseFloat(addForm.price) / (1 + addForm.vatRate)).toFixed(2)}
                  </div>
                )}
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                  <Tip text="What this item costs you to buy/produce, e.g. what you pay your supplier for a bottle of Coke. Used to value this item on the Complimentary Slip and comp reporting instead of showing NPR 0 — there's no Item Master to link an ingredient to on a POS-only plan." width={280}>
                    Cost Price (optional)
                  </Tip>
                </label>
                <input type="number" min="0" step="any" value={addForm.costPrice}
                  onChange={e => setAddForm(f => ({ ...f, costPrice: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()} placeholder="e.g. 25"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
              </div>
              {addError && <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-red)' }}>{addError}</p>}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setAddModal(false); setEditingId(null) }}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={saveNewItem} disabled={addSaving}>
                {addSaving ? 'Saving…' : editingId ? 'Save Changes' : 'Add to Menu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  function openSuggestModal(recipe) {
    setSuggestModal(recipe)
    setPairingDraft(new Set(suggMap[recipe.id] || []))
    setPairingSearch('')
  }

  async function savePairings() {
    if (!suggestModal || !effectiveClientId) return
    setPairingSaving(true)
    const recipeId = suggestModal.id
    await supabase.from('recipe_suggestions').delete()
      .eq('recipe_id', recipeId).eq('client_id', effectiveClientId)
    const newIds = [...pairingDraft]
    if (newIds.length > 0) {
      await supabase.from('recipe_suggestions').insert(
        newIds.map((suggestRecipeId, i) => ({
          client_id:         effectiveClientId,
          recipe_id:         recipeId,
          suggest_recipe_id: suggestRecipeId,
          sort_order:        i,
        }))
      )
    }
    setSuggMap(m => ({ ...m, [recipeId]: newIds }))
    setPairingSaving(false)
    setSuggestModal(null)
  }

  async function refreshCosts() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  /* ── IMS view (full food-cost table) ─────────────────────────────────────── */
  return (
    <div className="page-container">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <h1 className="page-title">Menu Pricing</h1>
          <p className="page-subtitle">
            Review food cost and update menu prices. Toggle <strong>On POS</strong> to control which items appear on the POS order screen.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn btn-ghost" onClick={refreshCosts} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : '↻ Refresh Costs'}
          </button>
          <button className="btn btn-primary" onClick={() => { setEditingId(null); setAddForm(EMPTY_FORM); setAddError(''); setAddModal(true) }}>
            + Add Item
          </button>
        </div>
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
        <div className="empty-state">No menu items found. Use <strong>+ Add Item</strong> above to add your first item.</div>
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

      {/* ── Pair With Modal ── */}
      {suggestModal && (
        <div onClick={e => { if (e.target === e.currentTarget) setSuggestModal(null) }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12, width: 'min(480px, 96vw)', padding: '24px 28px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 16, color: 'var(--theme-text1)' }}>Pair with — {suggestModal.name}</h3>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
              Checked items appear as "Pair with" chips when staff tap this item on the POS order screen.
            </p>
            <input
              autoFocus
              placeholder="Search items…"
              value={pairingSearch}
              onChange={e => setPairingSearch(e.target.value)}
              style={{ background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)', marginBottom: 10, flexShrink: 0 }}
            />
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {recipes
                .filter(r => r.id !== suggestModal.id && r.name.toLowerCase().includes(pairingSearch.toLowerCase()))
                .map(r => (
                  <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 6, cursor: 'pointer', background: pairingDraft.has(r.id) ? 'color-mix(in srgb, var(--theme-accent) 10%, var(--theme-card))' : 'transparent' }}>
                    <input type="checkbox" checked={pairingDraft.has(r.id)}
                      onChange={() => setPairingDraft(s => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n })}
                      style={{ accentColor: 'var(--theme-accent)', cursor: 'pointer', width: 15, height: 15, flexShrink: 0 }}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--theme-text1)' }}>{r.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>{r.category} · {r.inclVat > 0 ? `NPR ${r.inclVat.toFixed(0)}` : '—'}</div>
                    </div>
                  </label>
                ))}
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setSuggestModal(null)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={savePairings} disabled={pairingSaving}>
                {pairingSaving ? 'Saving…' : `Save${pairingDraft.size > 0 ? ` (${pairingDraft.size})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add Item Modal ── */}
      {addModal && (
        <div onClick={e => { if (e.target === e.currentTarget) { setAddModal(false); setEditingId(null) } }}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
          <div style={{ background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 12, width: 'min(440px, 96vw)', padding: '24px 28px', boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}>
            <h3 style={{ margin: '0 0 20px', fontSize: 16, color: 'var(--theme-text1)' }}>Add Menu Item</h3>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>Item Name *</label>
                <input
                  autoFocus
                  value={addForm.name}
                  onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()}
                  placeholder="e.g. Cappuccino"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>Category</label>
                <input
                  list="menu-cats"
                  value={addForm.category}
                  onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                  placeholder="Beverage / Food / Dessert / Other"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }}
                />
                <datalist id="menu-cats">
                  {['Beverage', 'Food', 'Dessert', 'Snack', 'Other',
                    ...Array.from(new Set(recipes.map(r => r.category))).sort()
                  ].filter((v, i, a) => a.indexOf(v) === i).map(c => <option key={c} value={c} />)}
                </datalist>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>VAT</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {[{ label: 'VAT 13%', val: 0.13 }, { label: 'No VAT', val: 0 }].map(opt => (
                    <button key={opt.val} onClick={() => setAddForm(f => ({ ...f, vatRate: opt.val }))}
                      style={{
                        flex: 1, padding: '7px 0', borderRadius: 6, fontSize: 13, cursor: 'pointer',
                        background: addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                        color: addForm.vatRate === opt.val ? 'var(--theme-accent-text, #000)' : 'var(--theme-text2)',
                        border: `1px solid ${addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                        fontWeight: addForm.vatRate === opt.val ? 700 : 400,
                      }}>{opt.label}</button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>
                  {addForm.vatRate > 0 ? 'Menu Price (incl. VAT) *' : 'Menu Price *'}
                </label>
                <input
                  type="number" min="0" step="any"
                  value={addForm.price}
                  onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()}
                  placeholder="e.g. 290"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 6, padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }}
                />
                {addForm.price && parseFloat(addForm.price) > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                    Ex-VAT: NPR {(parseFloat(addForm.price) / (1 + addForm.vatRate)).toFixed(2)}
                  </div>
                )}
              </div>

              {addError && <p style={{ margin: 0, fontSize: 12, color: 'var(--theme-red)' }}>{addError}</p>}
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setAddModal(false); setEditingId(null) }}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={saveNewItem} disabled={addSaving}>
                {addSaving ? 'Saving…' : 'Add to Menu'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
