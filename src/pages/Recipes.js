import { useEffect, useState, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const RECIPE_CATS = ['Food', 'Beverage', 'Dessert', 'Snack', 'Sub-Recipe', 'Other']
const EMPTY_RECIPE = { name: '', category: 'Food', selling_price: '', vat_rate: '0.13', yield_qty: '1', yield_uom: 'portion', target_fc_pct: '30' }

export default function Recipes() {
  const { clientId, isAdmin } = useAuth()
  const { settings } = useSettings()
  const [recipes, setRecipes] = useState([])
  const [overheadData, setOverheadData] = useState(null) // { totalOverheads, totalCovers, openPeriodId } | null
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState('list') // list | edit | detail
  const [selectedRecipe, setSelectedRecipe] = useState(null)
  const [recipeForm, setRecipeForm] = useState(EMPTY_RECIPE)
  const [ingredients, setIngredients] = useState([{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [printRecipe, setPrintRecipe] = useState(null)
  const filterCat = 'all' // no active UI to change this; filter always passes through

  const init = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const [{ data: r }, { data: i }] = await Promise.all([
      supabase.from('recipes').select('*').eq('client_id', clientId).order('name'),
      supabase.from('items').select('*').eq('client_id', clientId).eq('is_active', true).order('name')
    ])

    // Fetch ingredients separately
    const { data: ings } = await supabase
      .from('recipe_ingredients')
      .select('*, items(name, uom, per_uom_rate, item_code, yield_pct)')

    // Attach ingredients to recipes
    const allRecipes = (r || []).map(recipe => ({
      ...recipe,
      recipe_ingredients: (ings || []).filter(ri => ri.recipe_id === recipe.id)
    }))

    // Manually attach sub_recipe data to each ingredient
    allRecipes.forEach(recipe => {
      (recipe.recipe_ingredients || []).forEach(ri => {
        if (ri.sub_recipe_id) {
          const sr = allRecipes.find(x => x.id === ri.sub_recipe_id)
          ri.sub_recipe = sr || null
        }
      })
    })

    setRecipes(allRecipes)
    setItems(i || [])

    // Fetch overhead + sales data for open period to power overhead panel
    const { data: periods } = await supabase
      .from('monthly_periods')
      .select('id')
      .eq('client_id', clientId)
      .eq('status', 'open')
      .limit(1)
    const openPeriodId = periods?.[0]?.id || null

    if (openPeriodId) {
      const [{ data: ohRows }, { data: salesRows }] = await Promise.all([
        supabase.from('overheads').select('amount').eq('client_id', clientId).eq('period_id', openPeriodId).eq('bucket', 'overhead'),
        supabase.from('sales_entries').select('qty_sold').eq('period_id', openPeriodId)
      ])
      const totalOverheads = (ohRows || []).reduce((s, o) => s + parseFloat(o.amount || 0), 0)
      const totalCovers = (salesRows || []).reduce((s, se) => s + parseFloat(se.qty_sold || 0), 0)
      if (totalOverheads > 0 && totalCovers > 0) {
        setOverheadData({ totalOverheads, totalCovers, openPeriodId })
      } else {
        setOverheadData(null)
      }
    } else {
      setOverheadData(null)
    }

    setLoading(false)
  }, [clientId])

  useEffect(() => { if (clientId) init() }, [clientId, init])

  useEffect(() => {
    if (!printRecipe) return
    const t = setTimeout(() => { window.print(); setPrintRecipe(null) }, 80)
    return () => clearTimeout(t)
  }, [printRecipe])

  // ── Cost calculation (recursive) ──────────────────────────────
  function calcSubRecipeCostPerUnit(subRecipe, allRecipes) {
    if (!subRecipe) return 0
    const ings = subRecipe.recipe_ingredients || []
    let total = 0
    ings.forEach(ri => {
      if (ri.item_id && ri.items) {
        const yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
        total += (parseFloat(ri.qty_per_portion) / yieldFactor) * parseFloat(ri.items.per_uom_rate || 0)
      } else if (ri.sub_recipe_id) {
        const nested = allRecipes.find(r => r.id === ri.sub_recipe_id)
        if (nested) {
          const nestedCostPerUnit = calcSubRecipeCostPerUnit(nested, allRecipes)
          total += parseFloat(ri.qty_per_portion) * nestedCostPerUnit
        }
      }
    })
    const yieldQty = parseFloat(subRecipe.yield_qty) || 1
    return total / yieldQty
  }

  function calcRecipeCost(recipe, allRecipes) {
    return (recipe.recipe_ingredients || []).reduce((sum, ri) => {
      if (ri.item_id && ri.items) {
        const yieldFactor = (parseFloat(ri.items.yield_pct) || 100) / 100
        return sum + (parseFloat(ri.qty_per_portion) / yieldFactor) * parseFloat(ri.items.per_uom_rate || 0)
      } else if (ri.sub_recipe_id && ri.sub_recipe) {
        const costPerUnit = calcSubRecipeCostPerUnit(ri.sub_recipe, allRecipes)
        return sum + parseFloat(ri.qty_per_portion) * costPerUnit
      }
      return sum
    }, 0)
  }

  // Live cost in edit mode
  function calcLiveCost(ingList, itemsList, allRecipes) {
    return ingList.reduce((sum, ing) => {
      if (ing.type === 'item') {
        const item = itemsList.find(i => i.id === ing.item_id)
        if (!item || !ing.qty_per_portion) return sum
        const yieldFactor = (parseFloat(item.yield_pct) || 100) / 100
        return sum + (parseFloat(ing.qty_per_portion) / yieldFactor) * parseFloat(item.per_uom_rate || 0)
      } else {
        const sr = allRecipes.find(r => r.id === ing.sub_recipe_id)
        if (!sr || !ing.qty_per_portion) return sum
        const costPerUnit = calcSubRecipeCostPerUnit(sr, allRecipes)
        return sum + parseFloat(ing.qty_per_portion) * costPerUnit
      }
    }, 0)
  }

  function getSuggestedPrice(cost, vatRate = 0.13, targetFcPct = 0.30) {
    const basePrice = cost / targetFcPct
    return Math.ceil((basePrice * (1 + vatRate)) / 5) * 5
  }

  // Sub-recipes available as ingredients (all recipes with category Sub-Recipe)
  const subRecipes = recipes.filter(r => r.category === 'Sub-Recipe')

  // ── Form helpers ──────────────────────────────────────────────
  function openNew() {
    setSelectedRecipe(null)
    setRecipeForm(EMPTY_RECIPE)
    setIngredients([{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
    setError('')
    setView('edit')
  }

  function openEdit(recipe) {
    setSelectedRecipe(recipe)
    setRecipeForm({
      name: recipe.name,
      category: recipe.category || 'Food',
      selling_price: recipe.selling_price || '',
      vat_rate: recipe.vat_rate || '0.13',
      yield_qty: recipe.yield_qty || '1',
      yield_uom: recipe.yield_uom || 'portion',
      target_fc_pct: recipe.target_fc_pct ? String(recipe.target_fc_pct) : '30'
    })
    const ings = (recipe.recipe_ingredients || []).map(ri => ({
      _key: ri.id,
      item_id: ri.item_id || '',
      sub_recipe_id: ri.sub_recipe_id || '',
      qty_per_portion: ri.qty_per_portion,
      type: ri.sub_recipe_id ? 'sub_recipe' : 'item'
    }))
    setIngredients(ings.length > 0 ? ings : [{ _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
    setError('')
    setView('edit')
  }

  function openDetail(recipe) {
    setSelectedRecipe(recipe)
    setView('detail')
  }

  function addRow() {
    setIngredients(prev => [...prev, { _key: Date.now(), item_id: '', sub_recipe_id: '', qty_per_portion: '', type: 'item' }])
  }

  function removeRow(key) {
    setIngredients(prev => prev.filter(r => r._key !== key))
  }

  function updateIng(key, field, value) {
    setIngredients(prev => prev.map(r => r._key === key ? { ...r, [field]: value } : r))
  }

  function setIngType(key, type) {
    setIngredients(prev => prev.map(r => r._key === key ? { ...r, type, item_id: '', sub_recipe_id: '', qty_per_portion: '' } : r))
  }

  function getNextSubRecipeCode() {
    const SRC_PREFIX = (settings?.sub_recipe_code_prefix || 'SRC').toUpperCase()
    let maxNum = 0
    recipes.filter(r => r.category === 'Sub-Recipe').forEach(r => {
      const match = (r.recipe_code || '').match(new RegExp(`^${SRC_PREFIX}-(\\d+)$`))
      if (match) maxNum = Math.max(maxNum, parseInt(match[1], 10))
    })
    return `${SRC_PREFIX}-${String(maxNum + 1).padStart(3, '0')}`
  }

  async function save() {
    if (!recipeForm.name.trim()) { setError('Recipe name is required.'); return }
    const validIngs = ingredients.filter(i =>
      (i.type === 'item' ? i.item_id : i.sub_recipe_id) && parseFloat(i.qty_per_portion) > 0
    )
    if (validIngs.length === 0) { setError('Add at least one ingredient with qty.'); return }

    setSaving(true)
    setError('')

    const isSubRecipe = recipeForm.category === 'Sub-Recipe'
    const payload = {
      client_id: clientId,
      name: recipeForm.name.trim(),
      category: recipeForm.category,
      selling_price: !isSubRecipe && recipeForm.selling_price ? parseFloat(recipeForm.selling_price) : null,
      vat_rate: parseFloat(recipeForm.vat_rate) || 0.13,
      yield_qty: parseFloat(recipeForm.yield_qty) || 1,
      yield_uom: recipeForm.yield_uom || 'portion',
      target_fc_pct: parseFloat(recipeForm.target_fc_pct) || 30,
      is_active: true
    }

    let recipeId
    if (selectedRecipe) {
      const { error } = await supabase.from('recipes').update(payload).eq('id', selectedRecipe.id)
      if (error) { setError(error.message); setSaving(false); return }
      recipeId = selectedRecipe.id
      await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipeId)
    } else {
      if (isSubRecipe) payload.recipe_code = getNextSubRecipeCode()
      const { data, error } = await supabase.from('recipes').insert(payload).select().single()
      if (error) { setError(error.message); setSaving(false); return }
      recipeId = data.id
    }

    const ingPayload = validIngs.map(ing => ({
      recipe_id: recipeId,
      item_id: ing.type === 'item' ? ing.item_id : null,
      sub_recipe_id: ing.type === 'sub_recipe' ? ing.sub_recipe_id : null,
      qty_per_portion: parseFloat(ing.qty_per_portion)
    }))

    const { error: ingError } = await supabase.from('recipe_ingredients').insert(ingPayload)
    if (ingError) { setError(ingError.message); setSaving(false); return }

    setSaving(false)
    setView('list')
    init()
  }

  async function deleteRecipe(recipe) {
    if (!window.confirm(`Delete "${recipe.name}"?`)) return
    await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipe.id)
    await supabase.from('recipes').delete().eq('id', recipe.id)
    init()
  }

  // ── Derived values for edit form ──────────────────────────────
  const isSubRecipeForm = recipeForm.category === 'Sub-Recipe'
  const liveCost = calcLiveCost(ingredients, items, recipes)
  const livePrice = parseFloat(recipeForm.selling_price) || 0
  const liveVat = parseFloat(recipeForm.vat_rate) || 0.13
  const liveFcPct = livePrice > 0 ? (liveCost / livePrice) * 100 : null
  const livePriceWithVat = livePrice * (1 + liveVat)
  const liveFcTarget = (parseFloat(recipeForm.target_fc_pct) || 30) / 100
  const suggestedPrice = liveCost > 0 && !isSubRecipeForm ? getSuggestedPrice(liveCost, liveVat, liveFcTarget) : null
  const liveYieldQty = parseFloat(recipeForm.yield_qty) || 1
  const liveCostPerUnit = isSubRecipeForm && liveYieldQty > 0 ? liveCost / liveYieldQty : null

  // ── Tab state ─────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('all')

  // ── Filtered list ─────────────────────────────────────────────
  const filtered = recipes.filter(r => {
    const matchSearch = r.name.toLowerCase().includes(search.toLowerCase())
    const matchCat = filterCat === 'all' || r.category === filterCat
    return matchSearch && matchCat
  })

  const regularRecipes = filtered.filter(r => r.category !== 'Sub-Recipe')
  const subRecipeList = filtered.filter(r => r.category === 'Sub-Recipe')

  // Build tab list dynamically from categories present in recipes
  const presentCats = RECIPE_CATS.filter(c => c !== 'Sub-Recipe' && recipes.some(r => r.category === c))
  const tabs = [
    { key: 'all', label: 'All Recipes', count: regularRecipes.length },
    ...presentCats.map(c => ({
      key: c,
      label: c,
      count: filtered.filter(r => r.category === c).length
    })),
    { key: 'sub-recipes', label: '⚙ Sub-Recipes', count: subRecipeList.length },
  ]

  const tabFiltered = activeTab === 'all'
    ? regularRecipes
    : activeTab === 'sub-recipes'
      ? subRecipeList
      : filtered.filter(r => r.category === activeTab)

  return (
    <div>
      {/* Header */}
      <div className={`page-header${(view === 'detail' || printRecipe) ? ' no-print' : ''}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Recipe Costing</h1>
          <p className="page-subtitle">
            {view === 'list' && `${recipes.filter(r=>r.category!=='Sub-Recipe').length} recipes · ${subRecipes.length} sub-recipes`}
            {view === 'edit' && (selectedRecipe ? `Editing: ${selectedRecipe.name}` : 'New Recipe')}
            {view === 'detail' && selectedRecipe?.name}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {view !== 'list' && <button className="btn btn-ghost" onClick={() => setView('list')}>← Back</button>}
          {view === 'list' && <button className="btn btn-primary" onClick={openNew}>+ New Recipe</button>}
        </div>
      </div>

      {/* ── LIST VIEW ── */}
      {view === 'list' && (
        <div className={printRecipe ? 'no-print' : ''}>
          {/* Search bar */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <input
              style={{ background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6, padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 240 }}
              placeholder="Search recipes…" value={search} onChange={e => setSearch(e.target.value)} />
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 2, marginBottom: 0, borderBottom: '1px solid #2a2f3d' }}>
            {tabs.map(tab => {
              const isActive = activeTab === tab.key
              const isSubTab = tab.key === 'sub-recipes'
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    background: isActive ? '#2a2f3d' : 'transparent',
                    border: 'none',
                    borderBottom: isActive
                      ? `2px solid ${isSubTab ? '#c9a84c' : '#6366f1'}`
                      : '2px solid transparent',
                    padding: '10px 16px',
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 400,
                    color: isActive
                      ? (isSubTab ? '#c9a84c' : '#e8e0d0')
                      : '#6b7280',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    transition: 'color 0.15s',
                    borderRadius: '6px 6px 0 0',
                    marginBottom: -1,
                  }}
                >
                  {tab.label}
                  <span style={{
                    background: isActive ? (isSubTab ? 'rgba(201,168,76,0.15)' : 'rgba(99,102,241,0.15)') : '#2a2f3d',
                    color: isActive ? (isSubTab ? '#c9a84c' : '#818cf8') : '#9ca3af',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 600,
                    padding: '1px 7px',
                    minWidth: 20,
                    textAlign: 'center',
                  }}>
                    {tab.count}
                  </span>
                </button>
              )
            })}
          </div>

          {/* Tab content */}
          <div className="card" style={{ borderRadius: '0 6px 6px 6px', marginTop: 0 }}>
            {loading ? (
              <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
            ) : tabFiltered.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon">◈</div>
                <p className="empty-state-text">
                  {search
                    ? `No results for "${search}" in this tab.`
                    : activeTab === 'sub-recipes'
                      ? 'No sub-recipes yet. Create one by setting category to ⚙ Sub-Recipe.'
                      : 'No recipes yet. Click + New Recipe to build your first costed dish.'}
                </p>
              </div>
            ) : activeTab === 'sub-recipes' ? (
              /* ── Sub-recipes tab ── */
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Sub-Recipe</th>
                      <th>Ingredients</th>
                      <th style={{ textAlign: 'right' }}>Total Cost</th>
                      <th style={{ textAlign: 'right' }}>Yield</th>
                      <th style={{ textAlign: 'right' }}>Cost per Unit</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabFiltered.map(recipe => {
                      const cost = calcRecipeCost(recipe, recipes)
                      const yieldQty = parseFloat(recipe.yield_qty) || 1
                      const costPerUnit = cost / yieldQty
                      return (
                        <tr key={recipe.id}>
                          <td style={{ color: '#c9a84c', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                            {recipe.recipe_code || '—'}
                          </td>
                          <td style={{ fontWeight: 600, color: '#c9a84c', cursor: 'pointer' }} onClick={() => openDetail(recipe)}>
                            ⚙ {recipe.name}
                          </td>
                          <td style={{ color: '#6b7280' }}>{(recipe.recipe_ingredients || []).length} items</td>
                          <td style={{ textAlign: 'right', color: '#c9a84c' }}>NPR {cost.toFixed(2)}</td>
                          <td style={{ textAlign: 'right', color: '#6b7280' }}>{recipe.yield_qty} {recipe.yield_uom}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: '#e8e0d0' }}>
                            NPR {costPerUnit.toFixed(2)} / {recipe.yield_uom}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setPrintRecipe(recipe)}>🖶</button>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEdit(recipe)}>Edit</button>
                              <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteRecipe(recipe)}>Del</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              /* ── Regular recipes tab (All / per-category) ── */
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Recipe</th>
                      {activeTab === 'all' && <th>Category</th>}
                      <th>Ingredients</th>
                      <th style={{ textAlign: 'right' }}>Food Cost</th>
                      <th style={{ textAlign: 'right' }}><Tip text="Menu price ex-VAT (stored without VAT). VAT-inclusive price = selling price × (1 + VAT rate)." width={240}>Selling Price</Tip></th>
                      <th style={{ textAlign: 'right' }}><Tip text="Food Cost % = ingredient cost ÷ selling price. ≤30% excellent, 31–38% acceptable, >38% too high. Nepal F&B target: 28–35%." width={280}>FC %</Tip></th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tabFiltered.map(recipe => {
                      const cost = calcRecipeCost(recipe, recipes)
                      const price = parseFloat(recipe.selling_price) || 0
                      const fcPct = price > 0 ? (cost / price) * 100 : null
                      const fcColor = fcPct == null ? '#6b7280' : fcPct <= 30 ? '#34d399' : fcPct <= 38 ? '#c9a84c' : '#f87171'
                      const subIngCount = (recipe.recipe_ingredients || []).filter(ri => ri.sub_recipe_id).length
                      return (
                        <tr key={recipe.id}>
                          <td style={{ fontWeight: 600, color: '#e8e0d0', cursor: 'pointer' }} onClick={() => openDetail(recipe)}>
                            {recipe.name}
                            {subIngCount > 0 && <span style={{ fontSize: 10, color: '#c9a84c', marginLeft: 6 }}>⚙ {subIngCount} sub</span>}
                          </td>
                          {activeTab === 'all' && <td><span className="badge badge-yellow">{recipe.category}</span></td>}
                          <td style={{ color: '#6b7280' }}>{(recipe.recipe_ingredients || []).length} items</td>
                          <td style={{ textAlign: 'right', color: '#c9a84c' }}>NPR {cost.toFixed(2)}</td>
                          <td style={{ textAlign: 'right' }}>
                            {recipe.selling_price ? `NPR ${Number(recipe.selling_price).toFixed(2)}` : <span style={{ color: '#9ca3af' }}>—</span>}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: fcColor }}>
                            {fcPct != null ? `${fcPct.toFixed(1)}%` : '—'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => setPrintRecipe(recipe)}>🖶</button>
                              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEdit(recipe)}>Edit</button>
                              <button className="btn btn-danger" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => deleteRecipe(recipe)}>Del</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── EDIT VIEW ── */}
      {view === 'edit' && (
        <div>
          {/* Recipe details */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 18px', fontSize: 14, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Recipe Details</h3>
            <div style={{ display: 'grid', gridTemplateColumns: isSubRecipeForm ? '2fr 1fr 1fr 1fr' : '2fr 1fr 1fr 1fr', gap: 16 }}>
              <div className="form-field">
                <label>Recipe / Dish Name *</label>
                <input value={recipeForm.name} onChange={e => setRecipeForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Mango Sticky Rice" autoFocus />
              </div>
              <div className="form-field">
                <label>Category</label>
                <select value={recipeForm.category} onChange={e => setRecipeForm(f => ({ ...f, category: e.target.value }))}>
                  {RECIPE_CATS.map(c => <option key={c} value={c}>{c === 'Sub-Recipe' ? '⚙ Sub-Recipe / Prep Item' : c}</option>)}
                </select>
              </div>
              {isSubRecipeForm ? (
                <>
                  <div className="form-field">
                    <label><Tip text="How many units this batch produces (e.g. 1000 for 1L of sauce). Cost per unit = total cost ÷ yield qty." width={240}>Yield Quantity *</Tip></label>
                    <input type="number" value={recipeForm.yield_qty} onChange={e => setRecipeForm(f => ({ ...f, yield_qty: e.target.value }))} placeholder="e.g. 1000" />
                  </div>
                  <div className="form-field">
                    <label><Tip text="Unit for the batch output, e.g. ML, GM, PCS. Used when this sub-recipe is added as an ingredient elsewhere." width={260}>Yield UOM *</Tip></label>
                    <input value={recipeForm.yield_uom} onChange={e => setRecipeForm(f => ({ ...f, yield_uom: e.target.value }))} placeholder="e.g. ML, GM, PCS" />
                  </div>
                </>
              ) : (
                <>
                  <div className="form-field">
                    <label><Tip text="Enter the VAT-inclusive menu price. The system strips VAT and stores the ex-VAT price for accurate food cost calculation." width={280}>Menu Price (NPR, incl. 13% VAT)</Tip></label>
                    <div style={{ position: 'relative' }}>
                      <input
                        type="number"
                        key={recipeForm.selling_price ? 'has-price' : 'no-price'}
                        defaultValue={recipeForm.selling_price ? (parseFloat(recipeForm.selling_price) * (1 + (parseFloat(recipeForm.vat_rate) || 0.13))).toFixed(2) : ''}
                        onBlur={e => {
                          const rawPrice = parseFloat(e.target.value) || 0
                          const menuPrice = rawPrice > 0 ? Math.round(rawPrice) : 0
                          if (menuPrice !== rawPrice && e.target) e.target.value = menuPrice || ''
                          const vatRate = parseFloat(recipeForm.vat_rate) || 0.13
                          const exVat = menuPrice > 0 ? (menuPrice / (1 + vatRate)).toFixed(4) : ''
                          setRecipeForm(f => ({ ...f, selling_price: exVat }))
                        }}
                        placeholder="e.g. 500"
                      />
                      {recipeForm.selling_price && (
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                          Ex-VAT stored: NPR {parseFloat(recipeForm.selling_price).toFixed(2)}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="form-field">
                    <label><Tip text="Standard Nepal VAT is 13%. Set to 0% for VAT-exempt dishes (some raw food items).">VAT Rate</Tip></label>
                    <select value={recipeForm.vat_rate} onChange={e => setRecipeForm(f => ({ ...f, vat_rate: e.target.value }))}>
                      <option value="0.13">13% (VAT)</option>
                      <option value="0">0% (No VAT)</option>
                    </select>
                  </div>
                  {isAdmin && (
                    <div className="form-field">
                      <label><Tip text="Target food cost % for this recipe. Used to compute the suggested menu price. Nepal F&B average: 28–35%." width={260}>Target FC % 🔒</Tip></label>
                      <input
                        type="number" min="1" max="100"
                        value={recipeForm.target_fc_pct}
                        onChange={e => setRecipeForm(f => ({ ...f, target_fc_pct: e.target.value }))}
                        placeholder="30"
                      />
                      {recipeForm.target_fc_pct && (
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                          Suggested price targets {recipeForm.target_fc_pct}% food cost
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Live cost panel */}
          {liveCost > 0 && (
            <div style={{
              background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)',
              borderRadius: 8, padding: '16px 20px', marginBottom: 20,
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 16
            }}>
              <div>
                <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
                  {isSubRecipeForm ? 'Total Batch Cost' : 'Food Cost'}
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: '#c9a84c' }}>NPR {liveCost.toFixed(2)}</div>
              </div>
              {isSubRecipeForm && liveCostPerUnit != null && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Cost per {recipeForm.yield_uom || 'unit'}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#34d399' }}>NPR {liveCostPerUnit.toFixed(2)}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Yield: {recipeForm.yield_qty} {recipeForm.yield_uom}</div>
                </div>
              )}
              {!isSubRecipeForm && livePrice > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Food Cost %</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: liveFcPct <= 30 ? '#34d399' : liveFcPct <= 38 ? '#c9a84c' : '#f87171' }}>
                    {liveFcPct?.toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                    {liveFcPct <= 30 ? '✓ Good' : liveFcPct <= 38 ? '⚠ Acceptable' : '✗ Too high'}
                  </div>
                </div>
              )}
              {!isSubRecipeForm && livePrice > 0 && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Menu Price (incl. VAT)</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#e8e0d0' }}>NPR {livePriceWithVat.toFixed(0)}</div>
                </div>
              )}
              {suggestedPrice && (
                <div>
                  <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>Suggested @ {recipeForm.target_fc_pct || 30}% FC</div>
                  <div style={{ fontSize: 20, fontWeight: 700, color: '#34d399' }}>NPR {suggestedPrice}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>incl. {(liveVat*100).toFixed(0)}% VAT, rounded</div>
                </div>
              )}
            </div>
          )}

          {/* Ingredients */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <h3 style={{ margin: 0, fontSize: 14, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Ingredients</h3>
              <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={addRow}>+ Add Row</button>
            </div>

            <div className="table-wrap">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', fontSize: 11, color: '#6b7280', padding: '0 0 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 100 }}>Type</th>
                  <th style={{ textAlign: 'left', fontSize: 11, color: '#6b7280', padding: '0 12px 10px 8px', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Ingredient</th>
                  <th style={{ textAlign: 'right', fontSize: 11, color: '#6b7280', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 130 }}>Qty per Portion</th>
                  <th style={{ textAlign: 'left', fontSize: 11, color: '#6b7280', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 70 }}>UOM</th>
                  <th style={{ textAlign: 'right', fontSize: 11, color: '#6b7280', padding: '0 12px 10px', letterSpacing: '0.08em', textTransform: 'uppercase', width: 110 }}>Cost</th>
                  <th style={{ width: 36 }}></th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map(ing => {
                  let cost = null
                  let uomLabel = '—'

                  if (ing.type === 'item') {
                    const item = items.find(i => i.id === ing.item_id)
                    if (item && ing.qty_per_portion) {
                      const yieldFactor = (parseFloat(item.yield_pct) || 100) / 100
                      cost = (parseFloat(ing.qty_per_portion) / yieldFactor) * parseFloat(item.per_uom_rate || 0)
                      uomLabel = item.uom
                    }
                  } else {
                    const sr = recipes.find(r => r.id === ing.sub_recipe_id)
                    if (sr && ing.qty_per_portion) {
                      const cpu = calcSubRecipeCostPerUnit(sr, recipes)
                      cost = parseFloat(ing.qty_per_portion) * cpu
                      uomLabel = sr.yield_uom
                    }
                  }

                  return (
                    <tr key={ing._key}>
                      <td style={{ padding: '6px 0' }}>
                        <select
                          value={ing.type}
                          onChange={e => setIngType(ing._key, e.target.value)}
                          style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 8px', fontSize: 12, color: ing.type === 'sub_recipe' ? '#c9a84c' : '#6b7280', outline: 'none', width: 95 }}
                        >
                          <option value="item">Item</option>
                          <option value="sub_recipe">⚙ Sub-Recipe</option>
                        </select>
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        {ing.type === 'item' ? (
                          <select value={ing.item_id} onChange={e => updateIng(ing._key, 'item_id', e.target.value)}
                            style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: '100%' }}>
                            <option value="">— Select ingredient —</option>
                            {items.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
                          </select>
                        ) : (
                          <select value={ing.sub_recipe_id} onChange={e => updateIng(ing._key, 'sub_recipe_id', e.target.value)}
                            style={{ background: '#0f1117', border: '1px solid rgba(201,168,76,0.3)', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: '#c9a84c', outline: 'none', width: '100%' }}>
                            <option value="">— Select sub-recipe —</option>
                            {subRecipes.filter(sr => sr.id !== selectedRecipe?.id).map(sr => (
                              <option key={sr.id} value={sr.id}>⚙ {sr.name} ({sr.yield_qty} {sr.yield_uom})</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td style={{ padding: '6px 12px', textAlign: 'right' }}>
                        <input type="number" min="0" value={ing.qty_per_portion}
                          onChange={e => updateIng(ing._key, 'qty_per_portion', e.target.value)}
                          placeholder="0"
                          style={{ background: '#0f1117', border: '1px solid #2a2f3d', borderRadius: 5, padding: '7px 10px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 100, textAlign: 'right' }} />
                      </td>
                      <td style={{ padding: '6px 12px', color: ing.type === 'sub_recipe' ? '#c9a84c' : '#6b7280', fontSize: 13 }}>{uomLabel}</td>
                      <td style={{ padding: '6px 12px', textAlign: 'right', color: '#c9a84c', fontSize: 13, fontWeight: 600 }}>
                        {cost != null ? `NPR ${cost.toFixed(2)}` : '—'}
                      </td>
                      <td style={{ padding: '6px 0', textAlign: 'right' }}>
                        <button onClick={() => removeRow(ing._key)}
                          style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>×</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          </div>

          {error && <p style={{ color: '#f87171', fontSize: 13, margin: '0 0 16px' }}>{error}</p>}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost" onClick={() => setView('list')}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : selectedRecipe ? 'Update Recipe' : 'Save Recipe'}
            </button>
          </div>
        </div>
      )}

      {/* ── DETAIL VIEW ── */}
      {view === 'detail' && selectedRecipe && (() => {
        const isSubRec = selectedRecipe.category === 'Sub-Recipe'
        const cost = calcRecipeCost(selectedRecipe, recipes)
        const price = parseFloat(selectedRecipe.selling_price) || 0
        const vat = parseFloat(selectedRecipe.vat_rate) || 0.13
        const fcPct = price > 0 ? (cost / price) * 100 : null
        const yieldQty = parseFloat(selectedRecipe.yield_qty) || 1
        const costPerUnit = cost / yieldQty
        const fcColor = fcPct == null ? '#6b7280' : fcPct <= 30 ? '#34d399' : fcPct <= 38 ? '#c9a84c' : '#f87171'

        return (
          <>
          <div className="no-print">
          <div>
            {isSubRec && (
              <div style={{ background: 'rgba(201,168,76,0.06)', border: '1px solid rgba(201,168,76,0.2)', borderRadius: 8, padding: '12px 16px', marginBottom: 20, fontSize: 13, color: '#c9a84c' }}>
                ⚙ Sub-Recipe — Yield: {selectedRecipe.yield_qty} {selectedRecipe.yield_uom} · Cost per {selectedRecipe.yield_uom}: NPR {costPerUnit.toFixed(2)}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px,1fr))', gap: 14, marginBottom: 24 }}>
              {isSubRec ? [
                { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}`, color: '#c9a84c' },
                { label: `Cost per ${selectedRecipe.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}`, color: '#34d399' },
                { label: 'Yield', value: `${selectedRecipe.yield_qty} ${selectedRecipe.yield_uom}`, color: '#e8e0d0' },
              ] : [
                { label: 'Food Cost', value: `NPR ${cost.toFixed(2)}`, color: '#c9a84c' },
                { label: 'Food Cost %', value: fcPct != null ? `${fcPct.toFixed(1)}%` : '—', color: fcColor },
                { label: 'Selling Price (ex. VAT)', value: price ? `NPR ${price.toFixed(2)}` : '—', color: '#e8e0d0' },
                { label: `Menu Price (incl. ${(vat*100).toFixed(0)}% VAT)`, value: price ? `NPR ${(price*(1+vat)).toFixed(0)}` : '—', color: '#e8e0d0' },
                { label: `Suggested @ ${selectedRecipe.target_fc_pct || 30}% FC`, value: `NPR ${getSuggestedPrice(cost, vat, (parseFloat(selectedRecipe.target_fc_pct) || 30) / 100)}`, color: '#34d399' },
              ].map(s => (
                <div key={s.label} className="stat-card">
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value" style={{ fontSize: 18, color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Overhead panel — shown when overheads + sales exist for open period */}
            {!isSubRec && overheadData && price > 0 && (() => {
              const ohPerPortion = overheadData.totalOverheads / overheadData.totalCovers
              const trueCost = cost + ohPerPortion
              const trueNetMargin = price > 0 ? ((price - trueCost) / price) * 100 : null
              const vat = parseFloat(selectedRecipe.vat_rate) || 0.13
              const suggestedRaw = trueCost / 0.20
              const suggestedVat = Math.ceil((suggestedRaw * (1 + vat)) / 5) * 5
              return (
                <div style={{
                  background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.2)',
                  borderRadius: 8, padding: '16px 20px', marginBottom: 20
                }}>
                  <div style={{ fontSize: 11, color: '#34d399', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14, fontWeight: 600 }}>
                    ⚖ True Cost with Overheads
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: 16 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Overhead / Portion</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399' }}>NPR {ohPerPortion.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>NPR {overheadData.totalOverheads.toLocaleString()} ÷ {overheadData.totalCovers} covers</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>True Cost / Portion</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#c9a84c' }}>NPR {trueCost.toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>Food + Overhead</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>True Net Margin %</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: trueNetMargin >= 20 ? '#34d399' : '#f87171' }}>
                        {trueNetMargin != null ? `${trueNetMargin.toFixed(1)}%` : '—'}
                      </div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{trueNetMargin >= 20 ? '✓ Healthy' : '✗ Below 20%'}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Suggested Price @ 20% margin</div>
                      <div style={{ fontSize: 18, fontWeight: 700, color: '#34d399' }}>NPR {suggestedVat}</div>
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>incl. {(vat*100).toFixed(0)}% VAT, rounded to ÷5</div>
                    </div>
                  </div>
                </div>
              )
            })()}

            <div className="card">
              <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Ingredient</th>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Qty per Portion</th>
                    <th>UOM</th>
                    <th style={{ textAlign: 'right' }}>Yield %</th>
                    <th style={{ textAlign: 'right' }}>Unit Rate</th>
                    <th style={{ textAlign: 'right' }}>Cost</th>
                    <th style={{ textAlign: 'right' }}>% of Dish</th>
                  </tr>
                </thead>
                <tbody>
                  {(selectedRecipe.recipe_ingredients || []).map(ri => {
                    let name, uom, unitRate, itemCost, yieldPct
                    if (ri.item_id && ri.items) {
                      name = ri.items.name
                      uom = ri.items.uom
                      yieldPct = parseFloat(ri.items.yield_pct) || 100
                      const yieldFactor = yieldPct / 100
                      unitRate = parseFloat(ri.items.per_uom_rate || 0)
                      itemCost = (parseFloat(ri.qty_per_portion) / yieldFactor) * unitRate
                    } else if (ri.sub_recipe_id && ri.sub_recipe) {
                      const cpu = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
                      name = `⚙ ${ri.sub_recipe.name}`
                      uom = ri.sub_recipe.yield_uom
                      unitRate = cpu
                      itemCost = parseFloat(ri.qty_per_portion) * cpu
                      yieldPct = null
                    } else return null
                    const pctOfDish = cost > 0 ? (itemCost / cost) * 100 : 0
                    return (
                      <tr key={ri.id}>
                        <td style={{ fontWeight: 600, color: ri.sub_recipe_id ? '#c9a84c' : '#e8e0d0' }}>
                          {ri.items?.item_code && (
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#c9a84c', marginRight: 7, fontWeight: 400 }}>{ri.items.item_code}</span>
                          )}
                          {ri.sub_recipe?.recipe_code && (
                            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#c9a84c', marginRight: 7, fontWeight: 400 }}>{ri.sub_recipe.recipe_code}</span>
                          )}
                          {name}
                        </td>
                        <td><span className={`badge ${ri.sub_recipe_id ? 'badge-yellow' : 'badge-gray'}`}>{ri.sub_recipe_id ? 'Sub-Recipe' : 'Item'}</span></td>
                        <td style={{ textAlign: 'right' }}>{ri.qty_per_portion}</td>
                        <td style={{ color: '#6b7280' }}>{uom}</td>
                        <td style={{ textAlign: 'right', color: yieldPct != null && yieldPct < 100 ? '#f87171' : '#6b7280' }}>
                          {yieldPct != null ? `${yieldPct.toFixed(0)}%` : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: '#6b7280' }}>NPR {unitRate.toFixed(2)}</td>
                        <td style={{ textAlign: 'right', color: '#c9a84c', fontWeight: 600 }}>NPR {itemCost.toFixed(2)}</td>
                        <td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                            <div style={{ width: 60, height: 4, background: '#2a2f3d', borderRadius: 2 }}>
                              <div style={{ width: `${Math.min(pctOfDish,100)}%`, height: '100%', background: '#c9a84c', borderRadius: 2 }} />
                            </div>
                            <span style={{ fontSize: 12, color: '#6b7280', minWidth: 36 }}>{pctOfDish.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid #2a2f3d' }}>
                    <td colSpan={6} style={{ fontWeight: 700, color: '#6b7280', paddingTop: 12 }}>Total</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#c9a84c', fontSize: 15, paddingTop: 12 }}>NPR {cost.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
              </div>
            </div>
            <div style={{ marginTop: 16, display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" style={{ fontSize: 12 }} onClick={() => window.print()}>🖶 Print Cost Card</button>
              <button className="btn btn-ghost" onClick={() => openEdit(selectedRecipe)}>Edit Recipe</button>
            </div>
          </div>
          </div>

          {/* ── PRINT-ONLY COST CARD ── */}
          <div className="print-only">
            <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 680, margin: '0 auto' }}>

              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#555', marginBottom: 2 }}>
                    {settings?.app_name || 'Crest Inventory'}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#000' }}>{selectedRecipe.name}</div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 3 }}>
                    {isSubRec
                      ? `Sub-Recipe · Yield: ${selectedRecipe.yield_qty} ${selectedRecipe.yield_uom}`
                      : `Category: ${selectedRecipe.category}`}
                  </div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Recipe Cost Card</div>
                  <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{new Date().toLocaleDateString('en-NP')}</div>
                </div>
              </div>

              {/* Summary strip */}
              <div style={{ display: 'grid', gridTemplateColumns: isSubRec ? '1fr 1fr 1fr' : 'repeat(5, 1fr)', gap: 12, marginBottom: 18, padding: '10px 0', borderBottom: '1px solid #ddd' }}>
                {(isSubRec ? [
                  { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}` },
                  { label: `Cost per ${selectedRecipe.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}` },
                  { label: 'Yield', value: `${selectedRecipe.yield_qty} ${selectedRecipe.yield_uom}` },
                ] : [
                  { label: 'Food Cost', value: `NPR ${cost.toFixed(2)}` },
                  { label: `Selling Price (ex-VAT)`, value: price ? `NPR ${price.toFixed(2)}` : '—' },
                  { label: `Menu Price (incl. ${(vat * 100).toFixed(0)}% VAT)`, value: price ? `NPR ${(price * (1 + vat)).toFixed(0)}` : '—' },
                  { label: 'Food Cost %', value: fcPct != null ? `${fcPct.toFixed(1)}%` : '—' },
                  { label: 'Gross Margin %', value: fcPct != null ? `${(100 - fcPct).toFixed(1)}%` : '—' },
                ]).map(m => (
                  <div key={m.label}>
                    <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#777', marginBottom: 3 }}>{m.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#000' }}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* Ingredients label */}
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 6 }}>Ingredients</div>

              {/* Ingredient table */}
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #000' }}>
                    {['Ingredient', 'Qty', 'UOM', 'Rate (NPR)', 'Cost (NPR)', '% of Dish'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 0 ? 'left' : i === 2 ? 'left' : 'right', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: i === 0 ? 0 : 6, paddingRight: i === 5 ? 0 : 6 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(selectedRecipe.recipe_ingredients || []).map((ri, idx) => {
                    let ingName, ingUom, ingRate, ingCost
                    if (ri.item_id && ri.items) {
                      ingName = ri.items.name
                      ingUom = ri.items.uom
                      ingRate = parseFloat(ri.items.per_uom_rate || 0)
                      ingCost = parseFloat(ri.qty_per_portion) * ingRate
                    } else if (ri.sub_recipe_id && ri.sub_recipe) {
                      const cpu = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
                      ingName = `⚙ ${ri.sub_recipe.name}`
                      ingUom = ri.sub_recipe.yield_uom
                      ingRate = cpu
                      ingCost = parseFloat(ri.qty_per_portion) * cpu
                    } else return null
                    const pct = cost > 0 ? (ingCost / cost) * 100 : 0
                    return (
                      <tr key={ri.id || idx} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '5px 6px 5px 0', color: '#000' }}>{ingName}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right' }}>{ri.qty_per_portion}</td>
                        <td style={{ padding: '5px 6px', color: '#555' }}>{ingUom}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right', color: '#555' }}>{ingRate.toFixed(2)}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 600 }}>{ingCost.toFixed(2)}</td>
                        <td style={{ padding: '5px 0 5px 6px', textAlign: 'right', color: '#555' }}>{pct.toFixed(1)}%</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid #000' }}>
                    <td colSpan={4} style={{ padding: '7px 6px 7px 0', fontWeight: 700, fontSize: 12 }}>TOTAL FOOD COST</td>
                    <td style={{ padding: '7px 6px', textAlign: 'right', fontWeight: 700, fontSize: 12 }}>NPR {cost.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>

              {/* Overhead section */}
              {!isSubRec && overheadData && price > 0 && (() => {
                const ohPerPortion2 = overheadData.totalOverheads / overheadData.totalCovers
                const trueCost2 = cost + ohPerPortion2
                const trueMargin2 = price > 0 ? ((price - trueCost2) / price) * 100 : null
                const suggestedVat2 = Math.ceil(((trueCost2 / 0.20) * (1 + vat)) / 5) * 5
                return (
                  <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid #ccc', borderRadius: 3 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 8 }}>True Cost with Overheads</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                      {[
                        { label: 'Overhead / Portion', value: `NPR ${ohPerPortion2.toFixed(2)}` },
                        { label: 'True Cost / Portion', value: `NPR ${trueCost2.toFixed(2)}` },
                        { label: 'True Net Margin %', value: trueMargin2 != null ? `${trueMargin2.toFixed(1)}%` : '—' },
                        { label: 'Suggested @ 20% Margin', value: `NPR ${suggestedVat2}` },
                      ].map(m => (
                        <div key={m.label}>
                          <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{m.label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: '#000' }}>{m.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}

              {/* Footer */}
              <div style={{ marginTop: 20, paddingTop: 8, borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#999' }}>
                <span>CONFIDENTIAL — Internal use only</span>
                <span>Generated by Crest Inventory · {new Date().toLocaleDateString('en-NP')}</span>
              </div>
            </div>
          </div>
          </>
        )
      })()}

      {/* ── LIST-VIEW PRINT CARD (fires when 🖶 clicked from list) ── */}
      {printRecipe && (() => {
        const r = printRecipe
        const isSubRec = r.category === 'Sub-Recipe'
        const cost = calcRecipeCost(r, recipes)
        const price = parseFloat(r.selling_price) || 0
        const vat = parseFloat(r.vat_rate) || 0.13
        const fcPct = price > 0 ? (cost / price) * 100 : null
        const yieldQty = parseFloat(r.yield_qty) || 1
        const costPerUnit = cost / yieldQty
        return (
          <div className="print-only">
            <div style={{ fontFamily: 'Georgia, serif', color: '#000', padding: '20px 24px', maxWidth: 680, margin: '0 auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #000', paddingBottom: 10, marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#555', marginBottom: 2 }}>{settings?.app_name || 'Crest Inventory'}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#000' }}>{r.name}</div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 3 }}>{isSubRec ? `Sub-Recipe · Yield: ${r.yield_qty} ${r.yield_uom}` : `Category: ${r.category}`}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Recipe Cost Card</div>
                  <div style={{ fontSize: 11, color: '#555', marginTop: 4 }}>{new Date().toLocaleDateString('en-NP')}</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: isSubRec ? '1fr 1fr 1fr' : 'repeat(5, 1fr)', gap: 12, marginBottom: 18, padding: '10px 0', borderBottom: '1px solid #ddd' }}>
                {(isSubRec ? [
                  { label: 'Total Batch Cost', value: `NPR ${cost.toFixed(2)}` },
                  { label: `Cost per ${r.yield_uom}`, value: `NPR ${costPerUnit.toFixed(2)}` },
                  { label: 'Yield', value: `${r.yield_qty} ${r.yield_uom}` },
                ] : [
                  { label: 'Food Cost', value: `NPR ${cost.toFixed(2)}` },
                  { label: 'Selling Price (ex-VAT)', value: price ? `NPR ${price.toFixed(2)}` : '—' },
                  { label: `Menu Price (incl. ${(vat * 100).toFixed(0)}% VAT)`, value: price ? `NPR ${(price * (1 + vat)).toFixed(0)}` : '—' },
                  { label: 'Food Cost %', value: fcPct != null ? `${fcPct.toFixed(1)}%` : '—' },
                  { label: 'Gross Margin %', value: fcPct != null ? `${(100 - fcPct).toFixed(1)}%` : '—' },
                ]).map(m => (
                  <div key={m.label}>
                    <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#777', marginBottom: 3 }}>{m.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#000' }}>{m.value}</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 6 }}>Ingredients</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #000' }}>
                    {['Ingredient', 'Qty', 'UOM', 'Rate (NPR)', 'Cost (NPR)', '% of Dish'].map((h, i) => (
                      <th key={h} style={{ textAlign: i === 0 || i === 2 ? 'left' : 'right', padding: '4px 6px', fontWeight: 700, fontSize: 10, color: '#555', textTransform: 'uppercase', letterSpacing: '0.06em', paddingLeft: i === 0 ? 0 : 6, paddingRight: i === 5 ? 0 : 6 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(r.recipe_ingredients || []).map((ri, idx) => {
                    let ingName, ingUom, ingRate, ingCost
                    if (ri.item_id && ri.items) {
                      ingName = ri.items.name; ingUom = ri.items.uom
                      ingRate = parseFloat(ri.items.per_uom_rate || 0)
                      ingCost = parseFloat(ri.qty_per_portion) * ingRate
                    } else if (ri.sub_recipe_id && ri.sub_recipe) {
                      const cpu = calcSubRecipeCostPerUnit(ri.sub_recipe, recipes)
                      ingName = `⚙ ${ri.sub_recipe.name}`; ingUom = ri.sub_recipe.yield_uom
                      ingRate = cpu; ingCost = parseFloat(ri.qty_per_portion) * cpu
                    } else return null
                    const pct = cost > 0 ? (ingCost / cost) * 100 : 0
                    return (
                      <tr key={ri.id || idx} style={{ borderBottom: '1px solid #eee' }}>
                        <td style={{ padding: '5px 6px 5px 0' }}>{ingName}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right' }}>{ri.qty_per_portion}</td>
                        <td style={{ padding: '5px 6px', color: '#555' }}>{ingUom}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right', color: '#555' }}>{ingRate.toFixed(2)}</td>
                        <td style={{ padding: '5px 6px', textAlign: 'right', fontWeight: 600 }}>{ingCost.toFixed(2)}</td>
                        <td style={{ padding: '5px 0 5px 6px', textAlign: 'right', color: '#555' }}>{pct.toFixed(1)}%</td>
                      </tr>
                    )
                  })}
                  <tr style={{ borderTop: '2px solid #000' }}>
                    <td colSpan={4} style={{ padding: '7px 6px 7px 0', fontWeight: 700, fontSize: 12 }}>TOTAL FOOD COST</td>
                    <td style={{ padding: '7px 6px', textAlign: 'right', fontWeight: 700, fontSize: 12 }}>NPR {cost.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
              {!isSubRec && overheadData && price > 0 && (() => {
                const ohPer = overheadData.totalOverheads / overheadData.totalCovers
                const trueCost = cost + ohPer
                const trueMargin = price > 0 ? ((price - trueCost) / price) * 100 : null
                const suggested = Math.ceil(((trueCost / 0.20) * (1 + vat)) / 5) * 5
                return (
                  <div style={{ marginTop: 16, padding: '10px 12px', border: '1px solid #ccc', borderRadius: 3 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: '#555', marginBottom: 8 }}>True Cost with Overheads</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
                      {[
                        { label: 'Overhead / Portion', value: `NPR ${ohPer.toFixed(2)}` },
                        { label: 'True Cost / Portion', value: `NPR ${trueCost.toFixed(2)}` },
                        { label: 'True Net Margin %', value: trueMargin != null ? `${trueMargin.toFixed(1)}%` : '—' },
                        { label: 'Suggested @ 20% Margin', value: `NPR ${suggested}` },
                      ].map(m => (
                        <div key={m.label}>
                          <div style={{ fontSize: 9, color: '#777', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>{m.label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700 }}>{m.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })()}
              <div style={{ marginTop: 20, paddingTop: 8, borderTop: '1px solid #ddd', display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#999' }}>
                <span>CONFIDENTIAL — Internal use only</span>
                <span>Generated by Crest Inventory · {new Date().toLocaleDateString('en-NP')}</span>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
