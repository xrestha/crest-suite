import { useEffect, useMemo, useState, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { useSettings } from '../../../context/SettingsContext'
import { fcFigure, fcThresholds } from '../../../shared/imsFormulas'
import { printWithTitle } from '../../../utils/printTitle'
import ActionError, { asActionError } from '../../../components/ActionError'
import ReportLoadError from '../../../components/ReportLoadError'
import { firstError } from '../../../shared/queryError'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { calcSubRecipeCostPerUnit } from './recipeCostCalc'
import { nextProductCode, productCodePrefix } from '../../../shared/productCode'
import Modal from '../../../components/Modal'


function vatOf(r) {
  return (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : parseFloat(r.vat_rate)
}

// "VAT 13%" was written out as a literal in the row captions, the column tooltips and the Excel
// export, while `vat_rate` is a plain numeric column every one of those rows carries its own value
// of. A client on any other rate read a page confidently stating the wrong one. One formatter, fed
// the row's own rate.
function vatLabel(vat) {
  return vat > 0 ? `VAT ${Number((vat * 100).toFixed(2))}%` : 'No VAT'
}

// The FC% cell's tooltip when there is no cost to divide. The cell itself reads "—", and a dash on
// its own does not say what to do about it.
const NO_COST_TITLE = 'No food cost yet — add ingredients to this recipe in Recipe Costing.'
const NO_COST_TITLE_POS = 'No cost price yet — add one with Edit on this row.'

const EMPTY_FORM = { name: '', category: '', price: '', vatRate: 0.13, costPrice: '' }

// Columns whose value comes from an unsaved draft rather than a saved row. Sorting on one of
// these: null (nothing typed yet) sorts last in BOTH directions — "no new price" is not a small
// number — and the row order freezes while a price box has focus.
const DRAFT_SORT_KEYS = { newFc: true, change: true }

export default function MenuPricing() {
  const { clientId, profile, clientModules, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  // `fcFigure` is the one rendered form of a banded food-cost figure — colour, the ✓/△/▲ mark and
  // the band name as a title, together. This page used to take the three apart into its own
  // wrappers and reassemble them at each cell, which is exactly the shape that lets a call site
  // keep the colour and drop the mark. It also renders a null pct as "—" with no band, which is
  // what makes the no-cost case below expressible at all.

  const effectiveClientId = clientId || profile?.client_id
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const [recipes, setRecipes]   = useState([])
  const [loading, setLoading]   = useState(true)
  const [loadError, setLoadError] = useState(null) // a failed read, never rendered as an empty menu
  const [catTab, setCatTab]     = useState('All')
  const [search, setSearch]     = useState('')
  const [sortKey, setSortKey]   = useState('name')
  const [sortDir, setSortDir]   = useState('asc')
  // Row order captured while a New Price box has focus. Sorting by New FC % or Change reads a
  // value the reader is mid-way through typing, so without this the row jumps on every keystroke
  // ("7", "75", "750" are three different food costs) and drags the focused input with it.
  const [frozenIds, setFrozenIds] = useState(null)
  const [drafts, setDrafts]     = useState({})   // { id: string (incl-VAT input) }
  const [saving, setSaving]     = useState({})   // { id: bool }
  const [errors, setErrors]     = useState({})   // { id: string }
  const [toggling, setToggling] = useState({})   // { id: bool }
  // A failed write used to have nowhere to go on this page: togglePos dropped its error entirely
  // and saveRow flattened it to the string 'Save failed'. Both now land here, which has room for
  // the sentence AND the technical detail (S619).
  const [pageError, setPageError] = useState(null)

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
  const [pairingError,  setPairingError]  = useState(null)

  // Which branch renders. Also decides whether the pairings read is worth making at all: only the
  // POS-only branch has a Pair control, so an IMS client was paying for a round trip whose result
  // nothing could reach.
  const posOnly = !clientModules?.ims

  const load = useCallback(async () => {
    if (!effectiveClientId) return
    setLoading(true)

    setLoadError(null)
    const results = await Promise.all([
      // `.neq('category', 'Sub-Recipe')` ALSO excluded every recipe whose category is NULL — the
      // column is nullable, and a server-side .neq drops NULL rows silently. Such a recipe vanished
      // from the one page that sets its price, with no error and nothing missing from any count.
      // Paged, too: a bare .select() stops at 1000 rows and says nothing about it.
      fetchAllRows(() => scopedFrom('recipes', 'id, name, category, selling_price, vat_rate, pos_enabled, cost_price, recipe_code')
        .eq('is_active', true)
        .or('category.is.null,category.neq.Sub-Recipe')
        .order('name').order('id')),
      fetchAllRows(() => scopedFrom('recipes', 'id, yield_qty')
        .eq('category', 'Sub-Recipe')
        .order('id')),
      // Manual pairings — independent of everything else here; used to be a third serial round
      // trip at the tail of the load. Only fetched for the branch that can actually show them.
      posOnly
        ? fetchAllRows(() => scopedFrom('recipe_suggestions', 'recipe_id, suggest_recipe_id').order('id'))
        : Promise.resolve({ data: [], error: null }),
    ])
    // A failed read is not "no menu items yet" — that sentence names a button and invites the
    // reader to start adding a menu they already have (S683, the S594 rule on a CRUD page).
    const readErr = firstError(results)
    if (readErr) { setLoadError(readErr); setLoading(false); return }
    const [{ data: recipeData }, { data: subRecipeData }, { data: suggData }] = results

    const allIds = [
      ...(recipeData || []).map(r => r.id),
      ...(subRecipeData || []).map(r => r.id),
    ]
    const { data: ingData, error: ingErr } = allIds.length > 0
      ? await fetchAllRowsChunked(allIds, ids => supabase
          .from('recipe_ingredients')
          .select('recipe_id, qty_per_portion, item_id, sub_recipe_id, items(per_uom_rate, yield_pct)')
          .in('recipe_id', ids).order('id'))
      : { data: [], error: null }
    if (ingErr) { setLoadError(ingErr); setLoading(false); return }

    // Build per-sub-recipe ingredient list for recursive cost
    const subIngMap = {}
    const subIdSet = new Set((subRecipeData || []).map(sr => sr.id))
    for (const ri of (ingData || [])) {
      if (!subIdSet.has(ri.recipe_id)) continue
      if (!subIngMap[ri.recipe_id]) subIngMap[ri.recipe_id] = []
      subIngMap[ri.recipe_id].push(ri)
    }

    // Sub-recipe costing is `calcSubRecipeCostPerUnit` from recipeCostCalc.js — the same walk
    // Recipes.js, the printed cost card, the recipe importer, Stock Count's sub-recipe usage and
    // the nutrition roll-up all run. This page used to carry a private copy, and that copy was the
    // last one in the repo still using a VISITED set where the shared one uses a PATH set: a base
    // sub-recipe reached down two branches of the same tree costed 0 the second time, so Menu
    // Pricing quietly UNDER-STATED food cost against every other screen — on the one page where
    // that number decides a price. See that function's comment for the diamond it under-costs.
    //
    // The helper reads `recipe_ingredients` off the recipe and resolves nested ids against the
    // array it is handed, so the separately-fetched ingredients are stitched back on here. Each
    // sub-recipe is costed once from a fresh path set, which is what an on-demand call did anyway.
    const subRecipesFull = (subRecipeData || []).map(sr => ({ ...sr, recipe_ingredients: subIngMap[sr.id] || [] }))
    const subCost = {}
    for (const sr of subRecipesFull) subCost[sr.id] = calcSubRecipeCostPerUnit(sr, subRecipesFull)

    const mainIdSet = new Set((recipeData || []).map(r => r.id))
    const costMap = {}
    for (const ri of (ingData || [])) {
      if (!mainIdSet.has(ri.recipe_id)) continue
      if (ri.item_id && ri.items) {
        const rate = parseFloat(ri.items.per_uom_rate || 0)
        const yf   = (parseFloat(ri.items.yield_pct) || 100) / 100
        costMap[ri.recipe_id] = (costMap[ri.recipe_id] || 0) + (parseFloat(ri.qty_per_portion || 0) / yf) * rate
      } else if (ri.sub_recipe_id) {
        costMap[ri.recipe_id] = (costMap[ri.recipe_id] || 0) + parseFloat(ri.qty_per_portion || 0) * (subCost[ri.sub_recipe_id] || 0)
      }
    }

    const processed = (recipeData || []).map(r => {
      // POS-only clients can't link Item Master ingredients (no IMS access), so a recipe with
      // no ingredient-derived cost falls back to the manually entered cost_price from Add Item.
      const cost    = costMap[r.id] || parseFloat(r.cost_price) || 0
      const vat     = vatOf(r)
      const exVat   = parseFloat(r.selling_price || 0)
      const inclVat = exVat > 0 ? exVat * (1 + vat) : 0
      // NULL, not 0, when there is no cost to divide by the price. `(0 / price) * 100` is a real
      // 0.0%, and fcBand bands 0% as Healthy — so a dish with no ingredients and no cost price
      // printed "0.0% ✓" in green and sorted to the top of the best performers. This page's own
      // + Add Item creates exactly those rows, since it writes a recipe with no ingredients. The
      // New FC % sort already treated a zero cost as unknown; the cells and the FC % sort did not.
      const fcPct   = exVat > 0 && cost > 0 ? (cost / exVat) * 100 : null
      // pos_enabled defaults to true if null (column newly added)
      return { ...r, cost, vat, exVat, inclVat, fcPct, pos_enabled: r.pos_enabled !== false }
    })

    setRecipes(processed)

    // Manual pairings (fetched above, in parallel)
    const sMap = {}
    ;(suggData || []).forEach(s => {
      if (!sMap[s.recipe_id]) sMap[s.recipe_id] = []
      sMap[s.recipe_id].push(s.suggest_recipe_id)
    })
    setSuggMap(sMap)

    setLoading(false)
  }, [effectiveClientId, scopedFrom, posOnly])

  useEffect(() => { load() }, [load])

  // One pass for the tab list AND per-tab counts — both tab bars used to run a fresh
  // recipes.filter() per tab on every render (typing one price re-renders the whole page).
  const { tabs, tabCounts } = useMemo(() => {
    const tabCounts = {}
    recipes.forEach(r => { tabCounts[r.category] = (tabCounts[r.category] || 0) + 1 })
    return { tabs: ['All', ...Object.keys(tabCounts).sort()], tabCounts }
  }, [recipes])
  const display = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = recipes.filter(r =>
      (catTab === 'All' || r.category === catTab) &&
      (!q || r.name.toLowerCase().includes(q) || (r.category || '').toLowerCase().includes(q))
    )

    const valOf = r => {
      switch (sortKey) {
        case 'pos':    return r.pos_enabled ? 1 : 0
        case 'cost':   return r.cost > 0 ? r.cost : null
        case 'price':  return r.inclVat > 0 ? r.inclVat : null
        case 'fc':     return r.fcPct
        case 'newFc': {
          const d = parseFloat(drafts[r.id])
          const ex = d > 0 ? d / (1 + r.vat) : 0
          return ex > 0 && r.cost > 0 ? (r.cost / ex) * 100 : null
        }
        case 'change': {
          const d = parseFloat(drafts[r.id])
          return d > 0 && r.inclVat > 0 ? d - r.inclVat : null
        }
        default: return null
      }
    }

    const mul = sortDir === 'asc' ? 1 : -1
    const byName = (a, b) => a.name.localeCompare(b.name)
    const sorted = [...list].sort((a, b) => {
      if (sortKey === 'name') return byName(a, b) * mul
      const av = valOf(a), bv = valOf(b)
      if (av === null && bv === null) return byName(a, b)
      if (av === null) return 1
      if (bv === null) return -1
      // Name is the tiebreaker everywhere, so equal figures never shuffle between renders.
      return av === bv ? byName(a, b) : (av - bv) * mul
    })

    if (!frozenIds || !DRAFT_SORT_KEYS[sortKey]) return sorted
    const pos = new Map(frozenIds.map((id, i) => [id, i]))
    // Rows that were not on screen when the order froze (a search cleared mid-edit) go last.
    return sorted
      .map((r, i) => [r, pos.has(r.id) ? pos.get(r.id) : frozenIds.length + i])
      .sort((a, b) => a[1] - b[1])
      .map(([r]) => r)
  }, [recipes, catTab, search, sortKey, sortDir, drafts, frozenIds])

  function toggleSort(key) {
    setFrozenIds(null)
    if (sortKey === key) { setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); return }
    setSortKey(key)
    // A figure column opens on its worst end first — the reason to sort by FC % is to find the
    // items eating the margin, not the ones already fine.
    setSortDir(key === 'name' ? 'asc' : 'desc')
  }

  function setDraft(id, val) {
    setDrafts(d => ({ ...d, [id]: val }))
    setErrors(e => { const n = { ...e }; delete n[id]; return n })
  }

  async function togglePos(recipe) {
    const newVal = !recipe.pos_enabled
    setToggling(t => ({ ...t, [recipe.id]: true }))
    setPageError(null)
    const { error } = await scopedUpdate('recipes', { pos_enabled: newVal })
      .eq('id', recipe.id)
    if (error) {
      // The error used to be dropped on the floor: the checkbox snapped back to its stored value
      // and nothing said why. On the control that 86s a dish, that reads as a missed click rather
      // than "this item is still selling". It does not claim the write did not land — a response
      // can be lost after the row was updated — so it says how to find out what is stored.
      const a = asActionError(error)
      setPageError({
        text: `“${recipe.name}” — the On POS setting may not have changed. Reload the page to see what is stored. ${a.text}`,
        detail: a.detail,
      })
    } else {
      setRecipes(rs => rs.map(r => r.id === recipe.id ? { ...r, pos_enabled: newVal } : r))
    }
    setToggling(t => ({ ...t, [recipe.id]: false }))
  }

  async function saveRow(recipe) {
    const raw = parseFloat(drafts[recipe.id])
    if (!raw || raw <= 0) { setErrors(e => ({ ...e, [recipe.id]: 'Enter a valid price' })); return }
    const newExVat = raw / (1 + recipe.vat)
    setSaving(s => ({ ...s, [recipe.id]: true }))
    setPageError(null)
    const { error } = await scopedUpdate('recipes', { selling_price: parseFloat(newExVat.toFixed(4)) })
      .eq('id', recipe.id)
    if (error) {
      // Was the bare string 'Save failed', which names neither what state the price is in nor what
      // to do next (S619). The field keeps a short marker so the row is still findable in a table
      // of ~100; the sentence and the technical detail go to the page banner, which has room for
      // both. Neither claims the price was not saved — the response can be lost after the commit.
      const a = asActionError(error)
      setErrors(e => ({ ...e, [recipe.id]: 'Save not confirmed' }))
      setPageError({
        text: `“${recipe.name}” — the new price may not have been saved. Press ↻ Refresh Costs to see the stored price. ${a.text}`,
        detail: a.detail,
      })
    } else {
      setRecipes(rs => rs.map(r => {
        if (r.id !== recipe.id) return r
        const newFcPct = newExVat > 0 && r.cost > 0 ? (r.cost / newExVat) * 100 : null
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
    let error = null
    if (editingId) {
      ;({ error } = await scopedUpdate('recipes', payload).eq('id', editingId))
    } else {
      // Recipe Costing issues a Product Code from the category on every recipe it creates, and
      // Settings → Product Codes exists to backfill the ones that predate the feature. An item
      // added here got neither: no code to search on the POS order screen, and a blank column on
      // Item Wise. Same generator, same per-prefix series.
      const insertPayload = {
        is_active:   true,
        pos_enabled: true,
        ...payload,
        recipe_code: nextProductCode(productCodePrefix(payload.category), recipes.map(r => r.recipe_code)),
      }
      // The code is computed from in-memory state, so a second tab can genuinely take the number
      // first. That is not the user's mistake and must not be reported as one — recompute from
      // what is stored and retry, exactly as Recipes.js does. A failed re-read aborts with the
      // collision rather than restarting the sequence from scratch and colliding again.
      for (let attempt = 0; attempt < 3; attempt++) {
        ;({ error } = await scopedInsert('recipes', insertPayload))
        if (!error || error.code !== '23505') break
        const { data: fresh, error: freshErr } = await scopedFrom('recipes', 'recipe_code')
        if (freshErr) { error = freshErr; break }
        insertPayload.recipe_code = nextProductCode(
          productCodePrefix(payload.category), (fresh || []).map(r => r.recipe_code))
      }
    }
    setAddSaving(false)
    if (error) {
      // Neither half claims the write did not land. For the INSERT that matters most: `recipes`
      // has no unique index on (client_id, name), so a response lost after the row was committed
      // turns the retry this sentence would otherwise invite into a duplicate menu item.
      const a = asActionError(error)
      setAddError({
        text: (editingId
          ? 'The changes may not have been saved — close and reopen this item to see what is stored. '
          : 'The menu item may not have been added — check the list before trying again, since a second attempt can add it twice. ') + a.text,
        detail: a.detail,
      })
      return
    }
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

  // `sortAs` makes the header a sort control. The button goes INSIDE Tip on purpose: Tip makes a
  // lone interactive child its own focus target, so the column is one tab stop and the tooltip is
  // announced on the button rather than on a wrapper span nobody focuses.
  const th = (align, tip, label, width, sortAs) => {
    const active = sortAs && sortKey === sortAs
    const arrow  = active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'
    const inner = sortAs ? (
      <button type="button" className={`th-sort${active ? ' th-sort--active' : ''}`}
        onClick={() => toggleSort(sortAs)}
        aria-label={`Sort by ${label}${active ? (sortDir === 'asc' ? ', ascending' : ', descending') : ''}`}>
        {label}<span className="th-sort-arrow" aria-hidden="true">{arrow}</span>
      </button>
    ) : label
    return (
      <th style={{ textAlign: align || 'left', width }}
        aria-sort={sortAs ? (active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}>
        {tip ? <Tip text={sortAs ? `${tip} Click the heading to sort by this column.` : tip} width={240}>{inner}</Tip> : inner}
      </th>
    )
  }

  const posOnCount  = recipes.filter(r => r.pos_enabled).length
  const posOffCount = recipes.filter(r => !r.pos_enabled).length

  // IMS staff-role gate only applies to clients that actually have IMS — a POS-only client's
  // Owner login has no ims_role at all and must never be blocked from this shared route.
  if (clientModules?.ims && !hasImsAccess('manager')) return <Navigate to="/dashboard" replace />

  /* ── POS-only view (no IMS) ─────────────────────────────────────────────── */
  if (!clientModules?.ims) return (
    <div className="page-container">
      <div className="page-header page-header--split">
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
          <span style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>● {posOnCount} item{posOnCount !== 1 ? 's' : ''} on POS</span>
          {posOffCount > 0 && <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>● {posOffCount} hidden from POS</span>}
        </div>
      )}

      <ActionError error={pageError} />

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          style={{
            background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
            padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 260,
          }}
          placeholder="Search by item or category…"
          aria-label="Search menu items by name or category"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="tab-bar" style={{ marginBottom: 0 }}>
          {tabs.map(t => {
            const count = t === 'All' ? recipes.length : (tabCounts[t] || 0)
            return (
              <button key={t} className={`tab-btn${catTab === t ? ' tab-btn--active' : ''}`} onClick={() => setCatTab(t)}>
                {t} <span style={{ fontSize: 11, opacity: 0.65, marginLeft: 4 }}>{count}</span>
              </button>
            )
          })}
        </div>
        {search.trim() && !loading && (
          <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
            {display.length} of {recipes.length} item{recipes.length !== 1 ? 's' : ''}
            <button className="btn-linklike" onClick={() => setSearch('')} style={{ marginLeft: 8 }}>Clear</button>
          </span>
        )}
      </div>

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : display.length === 0 ? (
        <div className="empty-state">
          {recipes.length > 0
            ? <>No items match {search.trim() ? <>“{search.trim()}”</> : 'this filter'}{catTab !== 'All' ? <> in <strong>{catTab}</strong></> : null}.</>
            : <>No menu items yet. Use <strong>+ Add Item</strong> above to add your first item.</>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>#</th>
                <th style={{ width: 72, textAlign: 'center' }}>
                  <Tip text="Toggle to include or exclude this item from the POS order screen — also how you 86 an item when you run out (remember to turn it back on once restocked)." width={260}>On POS</Tip>
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
                    <input type="checkbox" aria-label={`Show ${r.name} on the POS menu`} checked={r.pos_enabled} disabled={toggling[r.id]}
                      onChange={() => togglePos(r)}
                      style={{ cursor: 'pointer', width: 15, height: 15, accentColor: 'var(--theme-green)' }} />
                  </td>
                  <td>
                    <strong>{r.name}</strong>
                    <div style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 2 }}>
                      {r.category}
                      {r.vat > 0
                        ? <Tip text={`Menu price includes ${Number((r.vat * 100).toFixed(2))}% VAT.`} width={200}> · {vatLabel(r.vat)}</Tip>
                        : <Tip text="No VAT on this item." width={160}> · No VAT</Tip>}
                      {' · '}
                      <button onClick={() => openEditModal(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, color: 'var(--theme-text3)', textDecoration: 'underline' }}>
                        Edit
                      </button>
                      {' · '}
                      <Tip text="Set which items appear as 'Pair with' suggestions when staff tap this item on the POS order screen." width={260}>
                        <button onClick={() => openSuggestModal(r)} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 11, color: (suggMap[r.id]?.length || 0) > 0 ? 'var(--theme-accent-ink)' : 'var(--theme-text3)', textDecoration: 'underline' }}>
                          {(suggMap[r.id]?.length || 0) > 0 ? `${suggMap[r.id].length} pairing${suggMap[r.id].length !== 1 ? 's' : ''}` : 'Pair'}
                        </button>
                      </Tip>
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                    {r.cost_price > 0 ? `NPR ${parseFloat(r.cost_price).toFixed(0)}` : <span style={{ color: 'var(--theme-text3)' }} title={NO_COST_TITLE_POS}>—</span>}
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
        // On the shared Modal since S682 — Escape, focus trap, focus return, role="dialog"; the
        // hand-rolled overlay had none of them. Same conversion in both branches.
        <Modal onClose={() => setSuggestModal(null)} title={`Pair with — ${suggestModal.name}`} maxWidth={480}
          panelStyle={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--theme-text3)' }}>
              Checked items appear as "Pair with" chips when staff tap this item on the POS order screen.
            </p>
            <input aria-label="Search items to pair"
              autoFocus
              placeholder="Search items…"
              value={pairingSearch}
              onChange={e => setPairingSearch(e.target.value)}
              style={{ background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)', marginBottom: 10, flexShrink: 0 }}
            />
            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {recipes
                .filter(r => r.id !== suggestModal.id && r.name.toLowerCase().includes(pairingSearch.toLowerCase()))
                .map(r => (
                  <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', background: pairingDraft.has(r.id) ? 'color-mix(in srgb, var(--theme-accent) 10%, var(--theme-card))' : 'transparent' }}>
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
            <ActionError error={pairingError} />
            <div style={{ display: 'flex', gap: 10, marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--theme-border)', flexShrink: 0 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => setSuggestModal(null)}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={savePairings} disabled={pairingSaving}>
                {pairingSaving ? 'Saving…' : `Save${pairingDraft.size > 0 ? ` (${pairingDraft.size})` : ''}`}
              </button>
            </div>
        </Modal>
      )}

      {addModal && (
        <Modal onClose={() => { setAddModal(false); setEditingId(null) }} title={editingId ? 'Edit Menu Item' : 'Add Menu Item'} maxWidth={440}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="menupr-f1">Item Name *</label>
                <input id="menupr-f1" autoFocus value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()} placeholder="e.g. Cappuccino"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="menupr-f2">Category</label>
                <input id="menupr-f2" list="menu-cats-pos" value={addForm.category} onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                  placeholder="Beverage / Food / Dessert / Other"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
                <datalist id="menu-cats-pos">
                  {['Beverage', 'Food', 'Dessert', 'Snack', 'Other', ...Array.from(new Set(recipes.map(r => r.category))).sort()]
                    .filter((v, i, a) => a.indexOf(v) === i).map(c => <option key={c} value={c} />)}
                </datalist>
              </div>
              <div>
                <span style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>VAT</span>
                <div role="group" aria-label="VAT" style={{ display: 'flex', gap: 8 }}>
                  {[{ label: 'VAT 13%', val: 0.13 }, { label: 'No VAT', val: 0 }].map(opt => (
                    <button key={opt.val} aria-pressed={addForm.vatRate === opt.val} onClick={() => setAddForm(f => ({ ...f, vatRate: opt.val }))} style={{
                      flex: 1, padding: '7px 0', borderRadius: 'var(--radius-sm)', fontSize: 13, cursor: 'pointer',
                      background: addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                      color: addForm.vatRate === opt.val ? 'var(--theme-accent-text)' : 'var(--theme-text2)',
                      border: `1px solid ${addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                      fontWeight: addForm.vatRate === opt.val ? 700 : 400,
                    }}>{opt.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="menupr-f3">
                  {addForm.vatRate > 0 ? 'Menu Price (incl. VAT) *' : 'Menu Price *'}
                </label>
                <input id="menupr-f3" type="number" min="0" step="any" value={addForm.price}
                  onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()} placeholder="e.g. 290"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
                {addForm.price && parseFloat(addForm.price) > 0 && addForm.vatRate > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                    Ex-VAT: NPR {(parseFloat(addForm.price) / (1 + addForm.vatRate)).toFixed(2)}
                  </div>
                )}
              </div>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="menupr-f4">
                  <Tip text="What this item costs you to buy/produce, e.g. what you pay your supplier for a bottle of Coke. Used to value this item on the Complimentary Slip and comp reporting instead of showing NPR 0 — there's no Item Master to link an ingredient to on a POS-only plan." width={280}>
                    Cost Price (optional)
                  </Tip>
                </label>
                <input id="menupr-f4" type="number" min="0" step="any" value={addForm.costPrice}
                  onChange={e => setAddForm(f => ({ ...f, costPrice: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()} placeholder="e.g. 25"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }} />
              </div>
              <ActionError error={addError} />
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setAddModal(false); setEditingId(null) }}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={saveNewItem} disabled={addSaving}>
                {addSaving ? 'Saving…' : editingId ? 'Save Changes' : 'Add to Menu'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  )

  function openSuggestModal(recipe) {
    setSuggestModal(recipe)
    setPairingDraft(new Set(suggMap[recipe.id] || []))
    setPairingSearch('')
    setPairingError(null)
  }

  // Was delete-every-row-then-insert with BOTH results discarded. If the delete landed and the
  // insert was refused, every pairing on this item was gone — and the modal still closed on
  // "Saved" and wrote the intended list into state, so nothing on screen ever said so.
  //
  // Three things changed. Only what the user actually changed is touched, so a failure can never
  // wipe a list they did not edit. Additions go FIRST, the same insert-before-delete order
  // Recipes.js uses on ingredients, so a half-completed save leaves more than it takes.
  // `recipe_suggestions` has a UNIQUE (recipe_id, suggest_recipe_id), which is precisely why the
  // diff has to exclude the unchanged rows rather than re-inserting them. And each error is read.
  async function savePairings() {
    if (!suggestModal || !effectiveClientId) return
    setPairingSaving(true)
    setPairingError(null)
    const recipeId = suggestModal.id
    const before   = new Set(suggMap[recipeId] || [])
    const added    = [...pairingDraft].filter(id => !before.has(id))
    const removed  = [...before].filter(id => !pairingDraft.has(id))

    const fail = (what, err) => {
      const a = asActionError(err)
      setPairingError({ text: `${what} ${a.text}`, detail: a.detail })
      setPairingSaving(false)
    }

    if (added.length > 0) {
      // sort_order is decorative — the POS order screen reads the pairings unordered — so new rows
      // simply continue past the existing ones rather than renumbering the whole set.
      const { error } = await scopedInsert('recipe_suggestions',
        added.map((suggestRecipeId, i) => ({
          recipe_id:         recipeId,
          suggest_recipe_id: suggestRecipeId,
          sort_order:        before.size + i,
        }))
      )
      if (error) { fail('The pairings were not changed — the list is still exactly as it was.', error); return }
    }
    if (removed.length > 0) {
      const { error } = await scopedDelete('recipe_suggestions')
        .eq('recipe_id', recipeId).in('suggest_recipe_id', removed)
      if (error) {
        // The additions did land, so the map has to say so — reporting the failure while showing
        // the list the user asked for would be the same lie in a smaller shape.
        setSuggMap(m => ({ ...m, [recipeId]: [...before, ...added] }))
        fail('The items you ticked were saved, but the ones you unticked were not removed.', error)
        return
      }
    }
    setSuggMap(m => ({ ...m, [recipeId]: [...pairingDraft] }))
    setPairingSaving(false)
    setSuggestModal(null)
  }

  async function refreshCosts() {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  // Exports the table as filtered on screen — the active category tab, same convention as the
  // Print button. The New Price column is exported BLANK on purpose: this sheet's job is the
  // same as the printed one's (send it out, get prices back), just over email instead of paper.
  async function exportExcel() {
    const XLSX = await import('xlsx')
    const rows = display.map((r, i) => ({
      '#': i + 1,
      'On POS': r.pos_enabled ? 'Yes' : 'No',
      'Item': r.name,
      'Category': r.category || '',
      'VAT': vatLabel(r.vat),
      'Food Cost (NPR)': r.cost > 0 ? Math.round(r.cost * 100) / 100 : '',
      'Current Price incl VAT (NPR)': r.inclVat > 0 ? Math.round(r.inclVat) : '',
      // Blank, not "0.0%", where there is no cost to divide — the sheet is sent out and priced
      // against, and a 0% food cost reads as a fact rather than as a missing recipe.
      'FC %': r.fcPct !== null ? `${r.fcPct.toFixed(1)}%` : '',
      'New Price (incl VAT)': '',
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Menu Pricing')
    // The sheet is the on-screen filter, so the filename has to name the whole filter — a search
    // hit dropping 90 rows out of an export called plain "menu-pricing" reads as the whole menu.
    const slug = search.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24)
    XLSX.writeFile(wb, `menu-pricing${catTab !== 'All' ? '-' + catTab.toLowerCase() : ''}${slug ? '-' + slug : ''}.xlsx`)
  }

  /* ── IMS view (full food-cost table) ─────────────────────────────────────── */
  return (
    <div className="page-container">
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Menu Pricing</h1>
          <p className="page-subtitle">
            Review food cost and update menu prices. Toggle <strong>On POS</strong> to control which items appear on the POS order screen.
          </p>
        </div>
        <div className="no-print" style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {/* Prints the table as filtered on screen — the active category tab goes into the print
              title (same convention as Stock Movements), since the tab bar itself is no-print. */}
          <Tip text="Prints the price list exactly as filtered and sorted on screen — the current category tab and search, with current prices and FC%." width={280}>
            <button className="btn btn-ghost" onClick={() => printWithTitle(`Menu Pricing${catTab !== 'All' ? ' - ' + catTab : ''}${search.trim() ? ` - search: "${search.trim()}"` : ''}`)}>
              🖨 Print
            </button>
          </Tip>
          <Tip text="Downloads the list as filtered and sorted on screen, with a blank New Price column to fill in and send back." width={280}>
            <button className="btn btn-ghost" onClick={exportExcel} disabled={loading || display.length === 0}>
              ⬇ Excel
            </button>
          </Tip>
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
          <span style={{ fontSize: 12, color: 'var(--theme-green-text)' }}>
            ● {posOnCount} item{posOnCount !== 1 ? 's' : ''} on POS
          </span>
          {posOffCount > 0 && (
            <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
              ● {posOffCount} hidden from POS
            </span>
          )}
        </div>
      )}

      <ActionError error={pageError} className="no-print" />

      {/* Search + category tabs */}
      <div className="no-print" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          style={{
            background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
            padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 260,
          }}
          placeholder="Search by item or category…"
          aria-label="Search menu items by name or category"
          value={search}
          onChange={e => { setSearch(e.target.value); setFrozenIds(null) }}
        />
        <div className="tab-bar" style={{ marginBottom: 0 }}>
          {tabs.map(t => {
            const count = t === 'All' ? recipes.length : (tabCounts[t] || 0)
            return (
              <button key={t} className={`tab-btn${catTab === t ? ' tab-btn--active' : ''}`} onClick={() => { setCatTab(t); setFrozenIds(null) }}>
                {t} <span style={{ fontSize: 11, opacity: 0.65, marginLeft: 4 }}>{count}</span>
              </button>
            )
          })}
        </div>
        {/* The tab counts above count the whole category, so once a search narrows the table they
            stop describing what is on screen — this says what is actually showing. */}
        {search.trim() && !loading && (
          <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
            {display.length} of {recipes.length} item{recipes.length !== 1 ? 's' : ''}
            <button className="btn-linklike" onClick={() => { setSearch(''); setFrozenIds(null) }} style={{ marginLeft: 8 }}>Clear</button>
          </span>
        )}
        {frozenIds && DRAFT_SORT_KEYS[sortKey] && (
          <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
            Order held while you price — click the column heading to re-sort.
          </span>
        )}
      </div>

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : loadError ? (
        // A failed read is not an empty menu (S594). This branch had no loadError case at all,
        // so a refused or dropped query rendered as "No menu items found. Use + Add Item" — an
        // invitation to re-enter a menu that is already there.
        <ReportLoadError error={loadError} />
      ) : display.length === 0 ? (
        <div className="empty-state">
          {recipes.length > 0
            ? <>No items match {search.trim() ? <>“{search.trim()}”</> : 'this filter'}{catTab !== 'All' ? <> in <strong>{catTab}</strong></> : null}.</>
            : <>No menu items found. Use <strong>+ Add Item</strong> above to add your first item.</>}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {th('left',  null, '#', 36)}
                {th('center', 'Toggle to include or exclude this item from the POS order screen. Turn off for seasonal or discontinued items, or to 86 it for the day when you run out — just remember to turn it back on once restocked.', 'On POS', 72, 'pos')}
                {th('left',  'Recipe name, category, and VAT status. A VAT-registered item\'s selling price includes VAT at the rate set on that item. No VAT items are sold at the price as entered.', 'Item', undefined, 'name')}
                {th('right', 'Total ingredient cost per portion at current item rates from the Item Master.', 'Food Cost', 100, 'cost')}
                {th('right', 'Current VAT-inclusive menu price saved in Recipe Costing. Calculated as selling price × (1 + VAT rate).', 'Current Price', 120, 'price')}
                {th('right', `Food cost ÷ ex-VAT selling price. Green up to ${fcThresholds(settings).warn}%, amber up to ${fcThresholds(settings).critical}%, red above that — the thresholds set in Settings → Thresholds. A plate of momo costing NPR 105 sold at NPR 300 is 35%.`, 'FC %', 80, 'fc')}
                {th('right', 'Enter a new VAT-inclusive menu price. The ex-VAT price and FC% are back-calculated automatically. Press Enter to save.', 'New Price (incl VAT)', 150)}
                {th('right', 'Projected FC% at the new price. Updates live as you type.', 'New FC %', 90, 'newFc')}
                {th('right', 'Difference between new and current VAT-inclusive price. Green = price increase, red = price decrease.', 'Change', 90, 'change')}
                {th(null, null, '', 72)}
              </tr>
            </thead>
            <tbody>
              {display.map((r, i) => {
                const draft      = drafts[r.id]
                const hasDraft   = draft !== undefined && draft !== ''
                const draftNum   = hasDraft ? parseFloat(draft) : null
                const draftExVat = draftNum > 0 ? draftNum / (1 + r.vat) : null
                const newFcPct   = draftExVat > 0 && r.cost > 0 ? (r.cost / draftExVat) * 100 : null
                const diff       = draftNum !== null && r.inclVat > 0 ? draftNum - r.inclVat : null
                const changed    = hasDraft && draftNum !== r.inclVat
                const dimmed     = !r.pos_enabled
                const fcFig      = fcFigure(r.fcPct, settings)
                const newFcFig   = fcFigure(newFcPct, settings)

                return (
                  <tr key={r.id} style={{ opacity: dimmed ? 0.45 : 1, background: changed ? 'rgba(245,158,11,0.05)' : undefined }}>
                    <td style={{ color: 'var(--theme-text2)' }}>{i + 1}</td>
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={`Show ${r.name} on the POS menu`}
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
                          ? <Tip text={`VAT-registered item. Menu price includes ${Number((r.vat * 100).toFixed(2))}% VAT. FC% is calculated on the ex-VAT portion.`} width={260}> · {vatLabel(r.vat)}</Tip>
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
                    {/* "—" covers two different absences now: no price to divide by, and no cost
                        to divide. The second used to print 0.0% ✓ in green. */}
                    <td style={{ textAlign: 'right', fontWeight: r.fcPct !== null ? 700 : 400, color: r.fcPct !== null ? fcFig.style.color : 'var(--theme-text3)' }}
                      title={fcFig.title || (r.exVat > 0 ? NO_COST_TITLE : undefined)}>
                      {fcFig.text}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {/* Focusing this box freezes the row order (see DRAFT_SORT_KEYS) and nothing
                          releases it on blur on purpose: the Save button sits in this same row, and
                          a row that re-sorts on blur moves out from under the pointer between
                          mousedown and mouseup, so the click never lands. Re-sorting, searching or
                          switching tab releases it. */}
                      <input
                        id={`menuprice-${r.id}`}
                        className="print-blank-input"
                        type="number" min="0" step="any"
                        value={draft !== undefined ? draft : ''}
                        placeholder={r.inclVat > 0 ? r.inclVat.toFixed(0) : '0'}
                        onChange={e => setDraft(r.id, e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && changed && saveRow(r)}
                        onFocus={() => { if (DRAFT_SORT_KEYS[sortKey] && !frozenIds) setFrozenIds(display.map(x => x.id)) }}
                        aria-label={`New menu price for ${r.name}`}
                        {...fieldAria(`menuprice-${r.id}`, errors[r.id])}
                        style={{
                          background: 'var(--theme-input-bg)',
                          // Invalid outranks the amber unsaved-edit border: a row that failed to
                          // save is still an unsaved edit, so amber would mask every rejection.
                          border: `1px solid ${errors[r.id] ? 'var(--theme-red)' : changed ? 'var(--theme-amber)' : 'var(--theme-border)'}`,
                          borderRadius: 'var(--radius-sm)', padding: '5px 8px', fontSize: 13,
                          color: 'var(--theme-text1)', outline: 'none',
                          width: 110, textAlign: 'right',
                        }}
                      />
                      {/* Was a bare red <div>: visible, but bound to nothing and announced never.
                          The row's input is unlabelled in a table of ~100 rows, so the aria-label
                          names WHICH dish as well (S576's template-label rule). */}
                      <FieldError id={`menuprice-${r.id}`} message={errors[r.id]} />
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: newFcPct !== null ? 700 : 400, color: newFcPct !== null ? newFcFig.style.color : 'var(--theme-text3)' }}
                      title={newFcFig.title || (r.cost > 0 ? undefined : NO_COST_TITLE)}>
                      {newFcFig.text}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: diff !== null ? 600 : 400, color: diff === null ? 'var(--theme-text3)' : diff > 0 ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
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

      {/* No Pair With modal here. The IMS branch renders no Pair control — `openSuggestModal`
          is called only from the POS-only table above — so the copy that used to sit here was
          ~45 lines of JSX nothing could open, plus a `recipe_suggestions` read on every load. An
          IMS+POS client gets "frequently ordered together" from its own sales history instead
          (see Help → POS order screen), which is the documented split; if manual pinning is ever
          wanted here too, it needs a Pair control in the row, not this modal back. */}

      {/* ── Add Item Modal ── */}
      {addModal && (
        <Modal onClose={() => { setAddModal(false); setEditingId(null) }} title="Add Menu Item" maxWidth={440}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="menupr-f5">Item Name *</label>
                <input id="menupr-f5"
                  autoFocus
                  value={addForm.name}
                  onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()}
                  placeholder="e.g. Cappuccino"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }}
                />
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="menupr-f6">Category</label>
                <input id="menupr-f6"
                  list="menu-cats"
                  value={addForm.category}
                  onChange={e => setAddForm(f => ({ ...f, category: e.target.value }))}
                  placeholder="Beverage / Food / Dessert / Other"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }}
                />
                <datalist id="menu-cats">
                  {['Beverage', 'Food', 'Dessert', 'Snack', 'Other',
                    ...Array.from(new Set(recipes.map(r => r.category))).sort()
                  ].filter((v, i, a) => a.indexOf(v) === i).map(c => <option key={c} value={c} />)}
                </datalist>
              </div>

              <div>
                <span style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }}>VAT</span>
                <div role="group" aria-label="VAT" style={{ display: 'flex', gap: 8 }}>
                  {[{ label: 'VAT 13%', val: 0.13 }, { label: 'No VAT', val: 0 }].map(opt => (
                    <button key={opt.val} aria-pressed={addForm.vatRate === opt.val} onClick={() => setAddForm(f => ({ ...f, vatRate: opt.val }))}
                      style={{
                        flex: 1, padding: '7px 0', borderRadius: 'var(--radius-sm)', fontSize: 13, cursor: 'pointer',
                        background: addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-input-bg)',
                        color: addForm.vatRate === opt.val ? 'var(--theme-accent-text)' : 'var(--theme-text2)',
                        border: `1px solid ${addForm.vatRate === opt.val ? 'var(--theme-accent)' : 'var(--theme-border)'}`,
                        fontWeight: addForm.vatRate === opt.val ? 700 : 400,
                      }}>{opt.label}</button>
                  ))}
                </div>
              </div>

              <div>
                <label style={{ fontSize: 12, color: 'var(--theme-text2)', display: 'block', marginBottom: 5 }} htmlFor="menupr-f7">
                  {addForm.vatRate > 0 ? 'Menu Price (incl. VAT) *' : 'Menu Price *'}
                </label>
                <input id="menupr-f7"
                  type="number" min="0" step="any"
                  value={addForm.price}
                  onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))}
                  onKeyDown={e => e.key === 'Enter' && saveNewItem()}
                  placeholder="e.g. 290"
                  style={{ width: '100%', boxSizing: 'border-box', background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)', padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)' }}
                />
                {addForm.price && parseFloat(addForm.price) > 0 && addForm.vatRate > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4 }}>
                    Ex-VAT: NPR {(parseFloat(addForm.price) / (1 + addForm.vatRate)).toFixed(2)}
                  </div>
                )}
              </div>

              <ActionError error={addError} />
            </div>

            <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
              <button className="btn btn-ghost" style={{ flex: 1, justifyContent: 'center' }} onClick={() => { setAddModal(false); setEditingId(null) }}>Cancel</button>
              <button className="btn btn-primary" style={{ flex: 2, justifyContent: 'center' }} onClick={saveNewItem} disabled={addSaving}>
                {addSaving ? 'Saving…' : 'Add to Menu'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  )
}
