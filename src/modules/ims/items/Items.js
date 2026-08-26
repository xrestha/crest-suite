import { useEffect, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import FieldError, { fieldAria } from '../../../components/FieldError'
import { Navigate } from 'react-router-dom'
import { printWithTitle } from '../../../utils/printTitle'

const DEFAULT_CATEGORIES = [
  'Dairy & Bakery',
  'Meats & Poultry',
  'Groceries',
  'Veg & Fruits',
  'Beverage',
  'Misc. Items'
]

const UNITS = ['GM', 'ML', 'KG', 'LTR', 'PCS', 'PKT', 'BTL', 'BOX', 'ROLL', 'BUNCH', 'JAR', 'CTN', 'BAG', 'TIN', 'SACHET']

const USAGE_LABELS = { OS: 'Opening Stock', CS: 'Closing Stock', R: 'Recipes', P: 'Purchases', W: 'Wastage', SM: 'Staff Meals', RQ: 'Requisitions', VR: 'Vendor Returns' }

// `rate` here is the price of ONE base unit — the only price the form collects and the exact value
// written to items.rate. There is no pack size on the form or in the row; see the note on `pack`.
const EMPTY_FORM = {
  name: '', category_id: '', uom: 'GM',
  rate: '', yield_pct: '100',
  purchase_unit: '', base_unit: '', conversion_factor: ''
}

export default function Items() {
  const { clientId, isAdmin, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate } = useScopedDb()
  const [items, setItems] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [activeTab, setActiveTab] = useState('details') // 'details' | 'conversion'
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Per-field validation, separate from `error` above. `error` stays the FORM-level channel — a
  // save that the server rejected, or a rule spanning several fields (the conversion trio) that no
  // single box owns. A message about one box belongs under that box (S603).
  const [fieldErr, setFieldErr] = useState({})
  const [filterCat, setFilterCat] = useState('all')
  const [search, setSearch] = useState('')
  const [sortConvFirst, setSortConvFirst] = useState(false)
  const [initingCats, setInitingCats] = useState(false)
  const [usageMap, setUsageMap] = useState({})
  const [filterUsage, setFilterUsage] = useState('all')
  // Working-out, never data: "I bought 500 GM for NPR 388.50" → NPR 0.777 per GM, which is what
  // actually gets stored. Deliberately cleared every time the dialog opens — items.purchase_qty is
  // always 1 and there is no column to remember a pack size in. If the pack is a standing fact
  // about the item ("this always comes in 500 GM bottles"), that belongs on the Conversion tab,
  // which is also what the Purchase Bill reads to decide whether its Qty column means bottles or
  // grams. Two boxes, one meaning each — the old Purchase Qty / Rate pair meant the pack price
  // while you typed and the per-unit price once you reopened it (S597).
  const [pack, setPack] = useState({ qty: '', total: '' })

  useEffect(() => {
    if (!clientId) return
    setLoading(true)
    Promise.all([loadCategories(), loadItems(), checkAllUsage()])
      .finally(() => setLoading(false))
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function checkAllUsage() {
    // None of these 8 tables were filtered at all — for an admin "viewing as" a client, RLS
    // allows every tenant's rows, so this pulled every client's ENTIRE purchase/stock/wastage/
    // requisition/return history into the browser just to compute a "Used In" badge (a real
    // cross-tenant data exposure + unbounded-payload perf bug). Most of these tables are
    // period/parent-scoped rather than client_id-scoped directly (see CLAUDE.md), so the
    // reliable fix across all 8 is to intersect on this client's own item ids instead — an
    // item_id can only ever belong to one client, so this is exactly as tight as a client_id
    // filter would be, without needing per-table-specific scoping logic.
    const { data: myItems, error: myItemsErr } = await scopedFrom('items', 'id')
    // A failed read must not blank the usage map — it feeds the delete guard, and an empty map
    // reads as "nothing references this item" (S607 silent-zero class).
    if (myItemsErr) return
    const myItemIds = (myItems || []).map(i => i.id)
    if (myItemIds.length === 0) { setUsageMap({}); return }

    // Every table whose FK references items.id — any row here blocks a DB delete.
    // qtyCol present = also require qty > 0 to count it as "active" usage for the badge.
    const referenceTables = [
      { table: 'recipe_ingredients', label: 'R',  qtyCol: null },
      { table: 'purchase_entries',   label: 'P',  qtyCol: 'qty' },
      { table: 'opening_stock',      label: 'OS', qtyCol: 'qty' },
      { table: 'closing_stock',      label: 'CS', qtyCol: 'physical_qty' },
      { table: 'wastages',           label: 'W',  qtyCol: 'qty' },
      { table: 'staff_meals',        label: 'SM', qtyCol: 'qty' },
      { table: 'requisition_lines',  label: 'RQ', qtyCol: null },
      { table: 'vendor_returns',     label: 'VR', qtyCol: 'qty' },
    ]
    const map = {}
    for (const { table, label, qtyCol } of referenceTables) {
      // Paged (S528/S529): purchase_entries alone crosses PostgREST's silent 1000-row cap on any
      // real client, and a truncated read here reported a used item as unused — feeding both the
      // "unused" filter and the force-delete guard.
      const { data, error } = await fetchAllRows(() => supabase.from(table)
        .select(qtyCol ? `item_id, ${qtyCol}` : 'item_id').in('item_id', myItemIds).order('id'))
      if (error || !data) continue // table may not exist for this client/plan — skip quietly
      data.forEach(row => {
        if (!row.item_id) return
        if (qtyCol && (!row[qtyCol] || parseFloat(row[qtyCol]) <= 0)) return
        if (!map[row.item_id]) map[row.item_id] = []
        if (!map[row.item_id].includes(label)) map[row.item_id].push(label)
      })
    }
    setUsageMap(map)
  }

  async function deleteItem(item) {
    const refs = usageMap[item.id] || []
    if (refs.length > 0) {
      const fullNames = refs.map(code => USAGE_LABELS[code] || code).join(', ')
      if (!isAdmin) {
        alert(`Cannot delete "${item.name}" — referenced in: ${fullNames}. Hide it instead.`)
        return
      }
      // Admin: offer to force-delete (removes the referencing records too).
      if (window.confirm(
        `"${item.name}" is referenced in: ${fullNames}.\n\n` +
        `FORCE DELETE will permanently remove the item AND every record that references it ` +
        `(purchases, stock counts, wastage, staff meals, requisitions, vendor returns, recipe lines).\n\n` +
        `This erases its history and recalculates affected reports. It cannot be undone.\n\nProceed?`
      )) {
        await forceDeleteItem(item)
      }
      return
    }
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return
    const { error } = await supabase.from('items').delete().eq('id', item.id)
    if (error) {
      // Foreign-key violation from a reference the badge didn't show (e.g. a zero-quantity row).
      const isFk = /foreign key|violates|referenced/i.test(error.message || '')
      if (isFk && isAdmin) {
        if (window.confirm(
          `"${item.name}" still has hidden references (e.g. a zero-quantity stock/purchase row).\n\n` +
          `Force-delete it and permanently remove those references? This cannot be undone.`
        )) {
          await forceDeleteItem(item)
        }
        return
      }
      alert(
        `Could not delete "${item.name}".\n\n` +
        (isFk
          ? 'It is still referenced by an older record (purchase, stock, wastage, staff meal, requisition, vendor return, or recipe). Use "Hide" instead to keep that history intact.'
          : error.message)
      )
      return
    }
    loadItems()
    checkAllUsage()
  }

  // Admin-only hard delete: clears every FK reference, then removes the item.
  // Order matters — vendor_returns before purchase_entries (it references both).
  async function forceDeleteItem(item) {
    const id = item.id
    const refTables = [
      'vendor_returns', 'recipe_ingredients', 'requisition_lines', 'staff_meals',
      'wastages', 'opening_stock', 'closing_stock', 'purchase_entries',
    ]
    for (const table of refTables) {
      // Best-effort: ignore errors (missing table / already-clear); the final item delete is the gate.
      await supabase.from(table).delete().eq('item_id', id)
    }
    const { error } = await supabase.from('items').delete().eq('id', id)
    if (error) {
      alert(`References were cleared but the item still couldn't be deleted:\n\n${error.message}`)
      return
    }
    loadItems()
    checkAllUsage()
  }

  async function clearAllConversions() {
    const withConversion = items.filter(i => i.purchase_unit)
    if (withConversion.length === 0) { alert('No items have a conversion set.'); return }
    if (!window.confirm(`Clear conversions on ${withConversion.length} item${withConversion.length !== 1 ? 's' : ''}?\n\nThis resets Purchase Unit, Base Unit, Conversion Factor and Purchase Qty to 1 for each affected item. This cannot be undone.`)) return
    const { error } = await scopedUpdate('items', { purchase_unit: null, base_unit: null, conversion_factor: 1, purchase_qty: 1 })
      .not('purchase_unit', 'is', null)
    if (error) { alert('Error: ' + error.message); return }
    await loadItems()
  }

  async function loadCategories() {
    const { data } = await scopedFrom('categories').order('sort_order')
    const filtered = (data || []).filter(c => c.name !== 'Sub-Recipes')
    setCategories(filtered)
    return filtered
  }

  async function loadItems() {
    const { data } = await scopedFrom('items', '*, categories(name)')
      .eq('is_sub_recipe', false)
      .order('name')
    setItems(data || [])
  }

  async function initDefaultCategories() {
    // scopedUpsert refuses (and returns an error) if no client is selected, instead of
    // seeding a null-client_id row — see memory: bug-null-client-id.
    setInitingCats(true)
    const inserts = DEFAULT_CATEGORIES.map((name, i) => ({ name, sort_order: i }))
    const { error } = await scopedUpsert('categories', inserts, { onConflict: 'client_id,name', ignoreDuplicates: true })
    if (error) alert('Error: ' + error.message)
    await loadCategories()
    setInitingCats(false)
  }

  // Every item is stored in its SMALLEST unit: `purchase_qty` is always 1, so `items.rate` is the
  // price of one base unit and equals the generated `per_uom_rate`. Storing a pack size instead is
  // what let a 500 GM bottle prefill NPR 388.50 into a Purchase Bill row counting grams, billing
  // 500 bottles (S597). Longer history: this box was once "Total (NPR)" and did
  // `rate = amount / qty`, which the generated column then divided by `qty` a SECOND time — S566,
  // found via a CUP HOLDER valuing 880 PCS at NPR 12. The form now collects the per-unit price
  // directly, so neither multiplication nor division survives at save time.
  const packPerUnit = (() => {
    const q = parseFloat(pack.qty), t = parseFloat(pack.total)
    return q > 0 && t > 0 ? t / q : null
  })()

  function setPackField(field, val) {
    const next = { ...pack, [field]: val }
    setPack(next)
    const q = parseFloat(next.qty), t = parseFloat(next.total)
    if (q > 0 && t > 0) setForm(prev => ({ ...prev, rate: String(parseFloat((t / q).toFixed(6))) }))
  }

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, category_id: categories[0]?.id || '' })
    setActiveTab('details')
    setPack({ qty: '', total: '' })
    setError('')
    setFieldErr({})
    setShowForm(true)
  }

  function openEdit(item) {
    setEditing(item.id)
    setPack({ qty: '', total: '' })
    setForm({
      name: item.name,
      category_id: item.category_id || '',
      uom: item.uom,
      // per_uom_rate is the authoritative per-unit figure; rate only equals it because purchase_qty
      // is pinned to 1, so read the generated column and let a legacy row correct itself on save.
      rate: item.per_uom_rate ?? item.rate,
      yield_pct: item.yield_pct != null ? String(item.yield_pct) : '100',
      purchase_unit: item.purchase_unit || '',
      base_unit: item.base_unit || '',
      conversion_factor: item.conversion_factor && item.conversion_factor !== 1 ? item.conversion_factor : ''
    })
    setActiveTab('details')
    setError('')
    setFieldErr({})
    setShowForm(true)
  }

  // Editing a field clears its own error — a red border under a box the user has just corrected
  // teaches them the message is stale and worth ignoring.
  function f(val) {
    const keys = Object.keys(val)
    setFieldErr(e => keys.some(k => e[k]) ? { ...e, ...Object.fromEntries(keys.map(k => [k, ''])) } : e)
    return { ...form, ...val }
  }

  function getNextItemCode() {
    const prefix = (settings?.item_code_prefix || 'ITM').toUpperCase()
    let maxNum = 0
    items.forEach(item => {
      const code = item.item_code || ''
      const match = code.match(new RegExp(`^${prefix}-(\\d+)$`))
      if (match) {
        const num = parseInt(match[1], 10)
        if (num > maxNum) maxNum = num
      }
    })
    return `${prefix}-${String(maxNum + 1).padStart(3, '0')}`
  }

  // Core save — validates + writes, returns true on success. Does NOT close the modal or reload,
  // so callers can chain a "save & next" navigation.
  async function doSave() {
    if (!clientId) { setError('No client selected. Pick a client in the top-left switcher before saving.'); return false }
    const fe = {}
    if (!form.name.trim()) fe.name = 'Item name is required.'
    // parseFloat, not truthiness: "0" is truthy as a string, and a price of NPR 0 stored here
    // misprices the item in every valuation at once with nothing to flag it (S607).
    if (!form.rate || !(parseFloat(form.rate) > 0)) fe.rate = `Price per ${form.uom} is required and must be above zero — type it in, or use "Bought a pack?" to work it out.`
    setFieldErr(fe)
    if (fe.name || fe.rate) { setActiveTab('details'); return false }

    // Conversion validation
    const hasPurchaseUnit = form.purchase_unit.trim() !== ''
    const hasBaseUnit = form.base_unit.trim() !== ''
    const hasFactor = form.conversion_factor !== '' && parseFloat(form.conversion_factor) > 0
    const hasAny = hasPurchaseUnit || hasBaseUnit || hasFactor
    if (hasAny && !(hasPurchaseUnit && hasBaseUnit && hasFactor)) {
      setError('Conversion requires all three fields: Purchase Unit, Base Unit, and Conversion Factor.')
      setActiveTab('conversion')
      return false
    }

    setSaving(true)
    setError('')

    const cf = hasFactor ? parseFloat(form.conversion_factor) : 1

    // purchase_qty is pinned to 1 and deliberately NOT set from the conversion factor: a
    // buy-in-CTN / count-in-BTL relationship belongs to the Conversion tab, which is what the
    // Purchase Bill reads to pick its qty unit. Mirroring it here would store a per-CTN price in a
    // column every valuation reads as per-BTL.
    const payload = {
      name: form.name.trim().toUpperCase(),
      category_id: form.category_id || null,
      uom: form.uom,
      purchase_qty: 1,
      rate: parseFloat(parseFloat(form.rate).toFixed(6)),
      purchase_unit: hasPurchaseUnit ? form.purchase_unit.trim().toUpperCase() : null,
      base_unit: hasBaseUnit ? form.base_unit.trim().toUpperCase() : null,
      conversion_factor: cf,
      yield_pct: parseFloat(form.yield_pct) > 0 ? parseFloat(form.yield_pct) : 100,
    }

    if (editing) {
      const { error } = await supabase.from('items').update(payload).eq('id', editing)
      if (error) { setError(error.message); setSaving(false); return false }
    } else {
      const { error } = await scopedInsert('items', { ...payload, item_code: getNextItemCode() })
      if (error) { setError(error.message); setSaving(false); return false }
    }
    setSaving(false)
    return true
  }

  async function save() {
    if (await doSave()) { setShowForm(false); loadItems() }
  }

  // Save current item, then open the adjacent one (dir = +1 next / -1 prev) in the visible order.
  async function saveAndGo(dir) {
    const idx = filtered.findIndex(i => i.id === editing)
    const target = filtered[idx + dir]
    if (!target) return
    if (await doSave()) { loadItems(); openEdit(target) }
  }

  async function toggleActive(item) {
    await supabase.from('items').update({ is_active: !item.is_active }).eq('id', item.id)
    loadItems()
  }

  // A sub-paisa unit rate is legitimate (a PCS item bought by the 1000), so `toFixed(2)` alone
  // flattens it to "0.00" — which hides exactly the mis-entry this figure exists to reveal.
  const fmtPerUom = v => {
    const n = parseFloat(v)
    if (!isFinite(n)) return '—'
    if (n > 0 && n < 0.01) return parseFloat(n.toFixed(6)).toString()
    return n.toFixed(2)
  }


  // Conversion preview string
  function conversionPreview(pu, bu, cf) {
    if (!pu || !bu || !cf) return null
    return `1 ${pu.toUpperCase()} = ${cf} ${bu.toUpperCase()}`
  }

  const catsWithItems   = categories.filter(c => items.some(i => i.category_id === c.id))
  const showCategoryCol = filterCat === 'all'

  const filtered = items.filter(item => {
    const matchCat = filterCat === 'all' || item.category_id === filterCat
    const s = search.toLowerCase()
    const matchSearch = item.name.toLowerCase().includes(s) || (item.item_code || '').toLowerCase().includes(s)
    const usage = usageMap[item.id] || []
    const matchUsage =
      filterUsage === 'all'    ? true :
      filterUsage === 'unused' ? usage.length === 0 :
      filterUsage === 'stock'  ? (usage.includes('OS') || usage.includes('CS')) :
      usage.includes(filterUsage)
    return matchCat && matchSearch && matchUsage
  }).sort((a, b) => {
    if (!sortConvFirst) return 0
    const aHas = !!(a.purchase_unit && a.conversion_factor > 1)
    const bHas = !!(b.purchase_unit && b.conversion_factor > 1)
    return bHas - aHas
  })

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  // .panel-tab is the shared class for exactly this row (it carries the underline, the type, the
  // 40px height, the coarse-pointer target and a focus ring); this file had hand-rolled it.
  const tabProps = (tab) => ({
    type: 'button',
    role: 'tab',
    'aria-selected': activeTab === tab,
    className: `panel-tab${activeTab === tab ? ' panel-tab--active' : ''}`,
    onClick: () => setActiveTab(tab),
  })

  return (
    <div>
      {/* Print-only header */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Item Master</h2>
      </div>

      <div className="page-header no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1 className="page-title">Item Master</h1>
          <p className="page-subtitle">{items.length} ingredients across {categories.length} categories</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {categories.length === 0 && (
            <button className="btn btn-ghost" onClick={initDefaultCategories} disabled={initingCats}>
              {initingCats ? 'Setting up…' : '⚡ Load Default Categories'}
            </button>
          )}
          {isAdmin && items.some(i => i.purchase_unit) && (
            <button
              className="btn btn-ghost"
              style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'rgba(248,113,113,0.3)' }}
              onClick={clearAllConversions}
            >
              ✕ Clear All Conversions
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => printWithTitle('Item Master')}>Print</button>
        </div>
      </div>

      {categories.length === 0 && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'rgba(201,168,76,0.3)' }}>
          <p style={{ color: 'var(--theme-accent-ink)', fontSize: 13, margin: 0 }}>
            No categories found. Click <strong>⚡ Load Default Categories</strong> to set up your 7 standard categories matching your Excel structure.
          </p>
        </div>
      )}

      {showForm && (
        <Modal onClose={() => setShowForm(false)} title={editing ? 'Edit Item' : 'Add Item'}>
          {/* Tab bar */}
          <div className="panel-tab-bar" role="tablist" aria-label="Item form sections">
            <button {...tabProps('details')}>
              Details
            </button>
            <button {...tabProps('conversion')}>
              Conversion
              {form.purchase_unit && form.base_unit && form.conversion_factor
                ? <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-green-text)' }}>●</span>
                : null}
            </button>
          </div>

          {/* Details tab */}
          {activeTab === 'details' && (
            <>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
                <div className="form-field" style={{ gridColumn: 'span 2' }}>
                  <label htmlFor="items-f1">Item Name *</label>
                  <input id="items-f1"
                    value={form.name}
                    onChange={e => setForm(f({ name: e.target.value }))}
                    placeholder="e.g. CHICKEN BREAST"
                    autoFocus
                    {...fieldAria('items-f1', fieldErr.name)}
                  />
                  <FieldError id="items-f1" message={fieldErr.name} />
                </div>
                <div className="form-field">
                  <label htmlFor="items-f2">Category</label>
                  <select id="items-f2" value={form.category_id} onChange={e => setForm(f({ category_id: e.target.value }))}>
                    <option value="">— None —</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor="items-f3">
                    <Tip width={260} text="The usable percentage of an ingredient after trimming, cleaning, or cooking. e.g. Whole chicken = 70% (bones & skin removed), Spinach = 60% (wilts down), Onion = 85% (skin & root removed). Leave at 100 if you buy and use in the same form.">
                      Yield %
                    </Tip>
                  </label>
                  <input id="items-f3"
                    type="number"
                    min="1" max="100"
                    value={form.yield_pct}
                    onChange={e => setForm(f({ yield_pct: e.target.value }))}
                    placeholder="100"
                  />
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Usable % after trim/prep. 100 = no loss</span>
                </div>
                <div className="form-field">
                  <label htmlFor="items-f4">UOM (base unit)</label>
                  <select id="items-f4" value={form.uom} onChange={e => setForm(f({ uom: e.target.value }))}>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label htmlFor="items-f6">
                    <Tip text={`What ONE ${form.uom} costs. This is the only price Crest stores, and the figure every recipe cost, stock value and report is built on. If you only know what a whole pack cost, use "Bought a pack?" below and this fills itself in.`} width={300}>
                      Price per {form.uom} (NPR) *
                    </Tip>
                  </label>
                  <input id="items-f6"
                    type="number" min="0" step="any"
                    value={form.rate}
                    onChange={e => { setPack({ qty: '', total: '' }); setForm(f({ rate: e.target.value })) }}
                    placeholder="0.777"
                    {...fieldAria('items-f6', fieldErr.rate)}
                  />
                  <FieldError id="items-f6" message={fieldErr.rate} />
                </div>
              </div>

              {/* Pack helper — arithmetic on screen, never stored. See the note on `pack` above. */}
              <div style={{
                marginTop: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                background: 'var(--theme-bg)', border: '1px solid var(--theme-border-lt)',
                borderRadius: 'var(--radius-sm)', padding: '12px 16px'
              }}>
                <span style={{ fontSize: 13, color: 'var(--theme-text2)', fontWeight: 600 }}>
                  <Tip text={`Here to do the division for you, nothing more. Type what you actually bought — "500 ${form.uom} for NPR 388.50" — and the price above fills in. Neither box is saved. To record that this item ALWAYS comes in a pack, set it up on the Conversion tab instead: that is what the Purchase Bill reads to decide whether its Qty column means packs or ${form.uom}.`} width={320}>
                    Bought a pack?
                  </Tip>
                </span>
                <input id="items-pack-qty"
                  aria-label={`Pack size, in ${form.uom}`}
                  className="form-input"
                  type="number" min="0" step="any"
                  value={pack.qty}
                  onChange={e => setPackField('qty', e.target.value)}
                  placeholder="500"
                  style={{ width: 92 }}
                />
                <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{form.uom} for NPR</span>
                <input id="items-pack-total"
                  aria-label="Price paid for that whole pack"
                  className="form-input"
                  type="number" min="0" step="any"
                  value={pack.total}
                  onChange={e => setPackField('total', e.target.value)}
                  placeholder="388.50"
                  style={{ width: 112 }}
                />
                {packPerUnit != null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                    → NPR {fmtPerUom(packPerUnit)} per {form.uom}
                  </span>
                )}
              </div>
            </>
          )}

          {/* Conversion tab */}
          {activeTab === 'conversion' && (
            <>
              <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 20px' }}>
                Set this when you buy in one unit but use/count in another.
                e.g. buy in <strong style={{ color: 'var(--theme-text1)' }}>CTN</strong>, use per <strong style={{ color: 'var(--theme-text1)' }}>BTL</strong> — or buy in <strong style={{ color: 'var(--theme-text1)' }}>KG</strong>, use in <strong style={{ color: 'var(--theme-text1)' }}>GM</strong>.
                Leave blank if purchase and usage units are the same.
              </p>
              <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 16, maxWidth: 560 }}>
                <div className="form-field">
                  <label htmlFor="items-f8">Purchase Unit</label>
                  <select id="items-f8"
                    value={form.purchase_unit}
                    onChange={e => setForm(f({ purchase_unit: e.target.value }))}
                  >
                    <option value="">— Select —</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Unit you buy in</span>
                </div>
                <div className="form-field">
                  <label htmlFor="items-f9">Base Unit</label>
                  <select id="items-f9"
                    value={form.base_unit}
                    onChange={e => setForm(f({ base_unit: e.target.value }))}
                  >
                    <option value="">— Select —</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Unit used in kitchen</span>
                </div>
                <div className="form-field">
                  <label htmlFor="items-f10">Conversion Factor</label>
                  <input id="items-f10"
                    type="number"
                    min="0"
                    step="any"
                    value={form.conversion_factor}
                    onChange={e => setForm(f({ conversion_factor: e.target.value }))}
                    placeholder="e.g. 24"
                  />
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Base units per purchase unit</span>
                </div>
              </div>

              {/* Live preview */}
              {conversionPreview(form.purchase_unit, form.base_unit, form.conversion_factor) && (
                <div style={{
                  marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 10,
                  background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.25)',
                  borderRadius: 'var(--radius-sm)', padding: '10px 18px'
                }}>
                  <span style={{ fontSize: 18 }}>🔄</span>
                  <div>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--theme-green-text)' }}>
                      {conversionPreview(form.purchase_unit, form.base_unit, form.conversion_factor)}
                    </p>
                    {form.rate && form.conversion_factor && (
                      <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                        NPR {fmtPerUom(form.rate)} per {form.base_unit?.toUpperCase()} → NPR {(parseFloat(form.rate) * parseFloat(form.conversion_factor)).toFixed(2)} per {form.purchase_unit?.toUpperCase()}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Clear conversion */}
              {(form.purchase_unit || form.base_unit || form.conversion_factor) && (
                <div style={{ marginTop: 12 }}>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'rgba(248,113,113,0.3)' }}
                    onClick={() => setForm(f({ purchase_unit: '', base_unit: '', conversion_factor: '' }))}
                  >
                    ✕ Clear Conversion
                  </button>
                </div>
              )}
            </>
          )}

          {error && <p style={{ color: 'var(--theme-red-text)', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}
          <div className="form-actions" style={{ justifyContent: 'space-between' }}>
            {editing ? (() => {
              const idx = filtered.findIndex(i => i.id === editing)
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn btn-ghost" onClick={() => saveAndGo(-1)} disabled={saving || idx <= 0}
                    title="Save & edit previous item" style={{ padding: '7px 12px' }}>← Prev</button>
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)', minWidth: 64, textAlign: 'center' }}>
                    {idx >= 0 ? `${idx + 1} of ${filtered.length}` : ''}
                  </span>
                  <button className="btn btn-ghost" onClick={() => saveAndGo(1)} disabled={saving || idx < 0 || idx >= filtered.length - 1}
                    title="Save & edit next item" style={{ padding: '7px 12px' }}>Next →</button>
                </div>
              )
            })() : <span />}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : editing ? 'Update Item' : 'Add Item'}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {/* Search + filters */}
      <div className="no-print" style={{ marginBottom: 16, display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            style={{
              background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 'var(--radius-sm)',
              padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 260
            }}
            placeholder="Search by name or code…"
            aria-label="Search items by name or code"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {/* Used-In filter chips */}
          {[
            { key: 'all',    label: 'All' },
            { key: 'R',      label: '🍽 Recipes' },
            { key: 'P',      label: '📦 Purchases' },
            { key: 'stock',  label: '📊 Stock' },
            { key: 'unused', label: '○ Unused' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilterUsage(key)}
              className={filterUsage === key ? 'tab-btn tab-btn--active' : 'tab-btn'}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setSortConvFirst(v => !v)}
          style={{
            fontSize: 12, padding: '7px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', whiteSpace: 'nowrap',
            border: sortConvFirst ? '1px solid var(--theme-accent)' : '1px solid var(--theme-border)',
            background: sortConvFirst ? 'var(--theme-table-hover)' : 'transparent',
            color: sortConvFirst ? 'var(--theme-accent-ink)' : 'var(--theme-text2)',
            fontWeight: sortConvFirst ? 600 : 400
          }}
        >
          {sortConvFirst ? '✕ ' : ''}With Conversion
        </button>
      </div>

      {/* Category tabs */}
      <div className="no-print" style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--theme-border)', marginBottom: 0, flexWrap: 'wrap' }}>
        {[{ id: 'all', name: 'All Items' }, ...catsWithItems].map(tab => {
          const count = items.filter(i => {
            const matchCat = tab.id === 'all' || i.category_id === tab.id
            const s = search.toLowerCase()
            const matchSearch = i.name.toLowerCase().includes(s) || (i.item_code || '').toLowerCase().includes(s)
            const usage = usageMap[i.id] || []
            const matchUsage =
              filterUsage === 'all'    ? true :
              filterUsage === 'unused' ? usage.length === 0 :
              filterUsage === 'stock'  ? (usage.includes('OS') || usage.includes('CS')) :
              usage.includes(filterUsage)
            return matchCat && matchSearch && matchUsage
          }).length
          const active = filterCat === tab.id
          return (
            <button key={tab.id} onClick={() => setFilterCat(tab.id)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 16px', fontSize: 13, fontWeight: 500,
              color: active ? 'var(--theme-accent-ink)' : 'var(--theme-text2)',
              borderBottom: active ? '2px solid var(--theme-accent)' : '2px solid transparent',
              marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap'
            }}>
              {tab.name.length > 13
                ? tab.name.split(' ').slice(0,2).map((w,i) => i===0 ? w : w.slice(0,4)+'.').join(' ')
                : tab.name}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                background: active ? 'rgba(201,168,76,0.12)' : 'color-mix(in srgb, var(--theme-text2) 12%, transparent)',
                color: active ? 'var(--theme-accent-ink)' : 'var(--theme-text2)'
              }}>{count}</span>
            </button>
          )
        })}
      </div>

      <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">≡</div>
            <p className="empty-state-text">
              {items.length === 0
                ? 'No items yet. Add your first ingredient to get started.'
                : 'No items match your search.'}
            </p>
          </div>
        ) : (
          <div className="table-wrap table-wrap--fab-clear">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item Name</th>
                  {showCategoryCol && <th>Category</th>}
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Cost of ONE base unit — the figure recipe costing, stock valuation and every IMS report use. Items are always stored in their smallest unit, so a 1 KG bag counted in GM shows its per-GM price here, not the bag price." width={300}>Rate (NPR) / UOM</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip width={240} text="Usable % after trim/prep. Red = trim loss is factored into recipe costing. 100% = no loss (default).">
                      Yield %
                    </Tip>
                  </th>
                  <th><Tip text="Purchase unit → base unit mapping (e.g. 1 carton = 12 bottles). Set this when your vendor sells in bulk but you track stock in individual units." width={280}>Conversion</Tip></th>
                  <th>Status</th>
                  <th><Tip text="Where this item already has records. An item with any of these can't be deleted — deactivate it instead, which hides it everywhere but keeps its history. R = Recipes, P = Purchases, OS/CS = Stock counts, W = Wastage, SM = Staff Meals, RQ = Requisitions, VR = Vendor Returns." width={300}>Used In</Tip></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => {
                  const hasConversion = item.purchase_unit && item.base_unit && item.conversion_factor && item.conversion_factor !== 1
                  return (
                    <tr key={item.id}>
                      <td style={{ color: 'var(--theme-accent-ink)', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {item.item_code || '—'}
                      </td>
                      <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{item.name}</td>
                      {showCategoryCol && (
                        <td>
                          {item.categories?.name
                            ? <span className="badge badge-yellow">{item.categories.name}</span>
                            : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                        </td>
                      )}
                      <td>{item.uom}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent-ink)' }}>
                        {fmtPerUom(item.per_uom_rate)}
                      </td>
                      <td style={{ textAlign: 'right', color: parseFloat(item.yield_pct) < 100 ? 'var(--theme-red-text)' : 'var(--theme-text2)' }}>
                        {parseFloat(item.yield_pct || 100).toFixed(0)}%
                      </td>
                      <td>
                        {hasConversion ? (
                          <span style={{
                            fontSize: 11, background: 'rgba(52,211,153,0.08)',
                            color: 'var(--theme-green-text)', border: '1px solid rgba(52,211,153,0.25)',
                            borderRadius: 'var(--radius-xs)', padding: '2px 7px', whiteSpace: 'nowrap'
                          }}>
                            🔄 1 {item.purchase_unit} = {item.conversion_factor} {item.base_unit}
                          </span>
                        ) : (
                          <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${item.is_active ? 'badge-green' : 'badge-gray'}`}>
                          {item.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        {usageMap[item.id]?.length > 0 ? (
                          <Tip text={`Has records in: ${usageMap[item.id].map(code => USAGE_LABELS[code] || code).join(', ')}`} width={260}><span style={{
                            fontSize: 11, background: 'rgba(201,168,76,0.12)',
                            color: 'var(--theme-accent-ink)', border: '1px solid rgba(201,168,76,0.3)',
                            borderRadius: 'var(--radius-xs)', padding: '2px 7px', cursor: 'default', whiteSpace: 'nowrap'
                          }}>
                            🔗 {usageMap[item.id].join(', ')}
                          </span></Tip>
                        ) : (
                          <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => openEdit(item)}>Edit</button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => toggleActive(item)}>
                          {item.is_active ? 'Hide' : 'Show'}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--theme-red-text)', borderColor: 'rgba(248,113,113,0.3)' }}
                          onClick={() => deleteItem(item)}>Del</button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Fab onClick={openNew} label="+ Add Item" show={!showForm} />
    </div>
  )
}
