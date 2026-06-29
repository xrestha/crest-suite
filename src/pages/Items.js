import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'
import Fab from '../components/Fab'
import Modal from '../components/Modal'

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

const EMPTY_FORM = {
  name: '', category_id: '', uom: 'GM',
  purchase_qty: '', rate: '', yield_pct: '100',
  purchase_unit: '', base_unit: '', conversion_factor: ''
}

export default function Items() {
  const { clientId, isAdmin } = useAuth()
  const { settings } = useSettings()
  const [items, setItems] = useState([])
  const [categories, setCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [activeTab, setActiveTab] = useState('details') // 'details' | 'conversion'
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [filterCat, setFilterCat] = useState('all')
  const [search, setSearch] = useState('')
  const [sortConvFirst, setSortConvFirst] = useState(false)
  const [initingCats, setInitingCats] = useState(false)
  const [usageMap, setUsageMap] = useState({})
  const [filterUsage, setFilterUsage] = useState('all')

  const effectiveClientId = clientId

  useEffect(() => {
    if (!clientId) return
    setLoading(true)
    Promise.all([loadCategories(), loadItems(), checkAllUsage()])
      .finally(() => setLoading(false))
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function checkAllUsage() {
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
      const { data, error } = await supabase.from(table).select(qtyCol ? `item_id, ${qtyCol}` : 'item_id')
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
    const { error } = await supabase
      .from('items')
      .update({ purchase_unit: null, base_unit: null, conversion_factor: 1, purchase_qty: 1 })
      .eq('client_id', effectiveClientId)
      .not('purchase_unit', 'is', null)
    if (error) { alert('Error: ' + error.message); return }
    await loadItems()
  }

  async function loadCategories() {
    const { data } = await supabase
      .from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order')
    const filtered = (data || []).filter(c => c.name !== 'Sub-Recipes')
    setCategories(filtered)
    return filtered
  }

  async function loadItems() {
    const { data } = await supabase
      .from('items')
      .select('*, categories(name)')
      .eq('client_id', effectiveClientId)
      .eq('is_sub_recipe', false)
      .order('name')
    setItems(data || [])
  }

  async function initDefaultCategories() {
    if (!clientId) return // never seed categories with a null client_id (creates orphaned duplicates)
    setInitingCats(true)
    const inserts = DEFAULT_CATEGORIES.map((name, i) => ({ client_id: clientId, name, sort_order: i }))
    await supabase.from('categories').upsert(inserts, { onConflict: 'client_id,name', ignoreDuplicates: true })
    await loadCategories()
    setInitingCats(false)
  }

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, category_id: categories[0]?.id || '' })
    setActiveTab('details')
    setError('')
    setShowForm(true)
  }

  function openEdit(item) {
    setEditing(item.id)
    setForm({
      name: item.name,
      category_id: item.category_id || '',
      uom: item.uom,
      purchase_qty: item.purchase_qty,
      rate: item.rate,
      yield_pct: item.yield_pct != null ? String(item.yield_pct) : '100',
      purchase_unit: item.purchase_unit || '',
      base_unit: item.base_unit || '',
      conversion_factor: item.conversion_factor && item.conversion_factor !== 1 ? item.conversion_factor : ''
    })
    setActiveTab('details')
    setError('')
    setShowForm(true)
  }

  function f(val) { return { ...form, ...val } }

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
    if (!form.name.trim()) { setError('Item name is required.'); return false }
    if (!form.purchase_qty || !form.rate) { setError('Purchase qty and rate are required.'); return false }

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
    const payload = {
      name: form.name.trim().toUpperCase(),
      category_id: form.category_id || null,
      uom: form.uom,
      purchase_qty: parseFloat(form.purchase_qty),
      rate: parseFloat(form.rate),
      purchase_unit: hasPurchaseUnit ? form.purchase_unit.trim().toUpperCase() : null,
      base_unit: hasBaseUnit ? form.base_unit.trim().toUpperCase() : null,
      conversion_factor: cf,
      yield_pct: parseFloat(form.yield_pct) > 0 ? parseFloat(form.yield_pct) : 100,
    }

    // Auto-sync purchase_qty from conversion_factor when conversion is fully set
    if (hasPurchaseUnit && hasBaseUnit && hasFactor) {
      payload.purchase_qty = cf
    }

    if (editing) {
      const { error } = await supabase.from('items').update(payload).eq('id', editing)
      if (error) { setError(error.message); setSaving(false); return false }
    } else {
      const { error } = await supabase.from('items').insert({
        ...payload, client_id: clientId, item_code: getNextItemCode()
      })
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

  const perUom = (qty, rate) => qty && rate ? (rate / qty).toFixed(2) : '—'

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

  const tabStyle = (tab) => ({
    padding: '8px 18px',
    fontSize: 13,
    fontWeight: activeTab === tab ? 600 : 400,
    color: activeTab === tab ? 'var(--theme-accent)' : 'var(--theme-text2)',
    background: 'none',
    border: 'none',
    borderBottom: activeTab === tab ? '2px solid var(--theme-accent)' : '2px solid transparent',
    cursor: 'pointer',
    transition: 'all 0.15s'
  })

  return (
    <div>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
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
              style={{ fontSize: 12, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
              onClick={clearAllConversions}
            >
              ✕ Clear All Conversions
            </button>
          )}
        </div>
      </div>

      {categories.length === 0 && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'rgba(201,168,76,0.3)' }}>
          <p style={{ color: 'var(--theme-accent)', fontSize: 13, margin: 0 }}>
            No categories found. Click <strong>⚡ Load Default Categories</strong> to set up your 7 standard categories matching your Excel structure.
          </p>
        </div>
      )}

      {showForm && (
        <Modal onClose={() => setShowForm(false)} title={editing ? 'Edit Item' : 'Add Item'}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--theme-border)', marginBottom: 20, gap: 0 }}>
            <button style={tabStyle('details')} onClick={() => setActiveTab('details')}>
              Details
            </button>
            <button style={tabStyle('conversion')} onClick={() => setActiveTab('conversion')}>
              Conversion
              {form.purchase_unit && form.base_unit && form.conversion_factor
                ? <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--theme-green)' }}>●</span>
                : null}
            </button>
          </div>

          {/* Details tab */}
          {activeTab === 'details' && (
            <>
              <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 16 }}>
                <div className="form-field" style={{ gridColumn: 'span 2' }}>
                  <label>Item Name *</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(f({ name: e.target.value }))}
                    placeholder="e.g. CHICKEN BREAST"
                    autoFocus
                  />
                </div>
                <div className="form-field">
                  <label>Category</label>
                  <select value={form.category_id} onChange={e => setForm(f({ category_id: e.target.value }))}>
                    <option value="">— None —</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>UOM (base unit)</label>
                  <select value={form.uom} onChange={e => setForm(f({ uom: e.target.value }))}>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div className="form-field">
                  <label>
                    <Tip text={form.conversion_factor ? `Locked — derived from conversion factor (${form.conversion_factor}). Set on the Conversion tab.` : 'How many base units you typically buy at once. e.g. 1000 if you buy 1 KG bag = 1000 GM.'} width={240}>
                      Purchase Qty
                    </Tip>
                  </label>
                  <input
                    type="number"
                    value={form.conversion_factor ? form.conversion_factor : form.purchase_qty}
                    onChange={e => { if (!form.conversion_factor) setForm(f({ purchase_qty: e.target.value })) }}
                    placeholder="1000"
                    readOnly={!!form.conversion_factor}
                    style={form.conversion_factor ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                  />
                  {form.conversion_factor && (
                    <span style={{ fontSize: 11, color: 'var(--theme-text2)', marginTop: 4, display: 'block' }}>
                      Auto-set from conversion factor
                    </span>
                  )}
                </div>
                <div className="form-field">
                  <label>Rate (NPR)</label>
                  <input
                    type="number"
                    value={form.rate}
                    onChange={e => setForm(f({ rate: e.target.value }))}
                    placeholder="500"
                  />
                </div>
                <div className="form-field">
                  <label>
                    <Tip width={260} text="The usable percentage of an ingredient after trimming, cleaning, or cooking. e.g. Whole chicken = 70% (bones & skin removed), Spinach = 60% (wilts down), Onion = 85% (skin & root removed). Leave at 100 if you buy and use in the same form.">
                      Yield %
                    </Tip>
                  </label>
                  <input
                    type="number"
                    min="1" max="100"
                    value={form.yield_pct}
                    onChange={e => setForm(f({ yield_pct: e.target.value }))}
                    placeholder="100"
                  />
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Usable % after trim/prep. 100 = no loss</span>
                </div>
              </div>
              {form.purchase_qty && form.rate && (
                <p style={{ fontSize: 12, color: 'var(--theme-accent)', margin: '10px 0 0' }}>
                  Per {form.uom} rate: NPR {perUom(form.purchase_qty, form.rate)}
                </p>
              )}
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
                  <label>Purchase Unit</label>
                  <select
                    value={form.purchase_unit}
                    onChange={e => setForm(f({ purchase_unit: e.target.value }))}
                  >
                    <option value="">— Select —</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Unit you buy in</span>
                </div>
                <div className="form-field">
                  <label>Base Unit</label>
                  <select
                    value={form.base_unit}
                    onChange={e => setForm(f({ base_unit: e.target.value }))}
                  >
                    <option value="">— Select —</option>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Unit used in kitchen</span>
                </div>
                <div className="form-field">
                  <label>Conversion Factor</label>
                  <input
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
                  borderRadius: 8, padding: '10px 18px'
                }}>
                  <span style={{ fontSize: 18 }}>🔄</span>
                  <div>
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--theme-green)' }}>
                      {conversionPreview(form.purchase_unit, form.base_unit, form.conversion_factor)}
                    </p>
                    {form.rate && form.conversion_factor && (
                      <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                        Per {form.base_unit?.toUpperCase()} cost: NPR {(parseFloat(form.rate) / parseFloat(form.conversion_factor)).toFixed(4)}
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
                    style={{ fontSize: 12, color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
                    onClick={() => setForm(f({ purchase_unit: '', base_unit: '', conversion_factor: '' }))}
                  >
                    ✕ Clear Conversion
                  </button>
                </div>
              )}
            </>
          )}

          {error && <p style={{ color: 'var(--theme-red)', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}
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
      <div style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          style={{
            background: 'var(--theme-card)', border: '1px solid var(--theme-border)', borderRadius: 6,
            padding: '8px 12px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none', width: 260
          }}
          placeholder="Search by name or code…"
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
        <button
          onClick={() => setSortConvFirst(v => !v)}
          style={{
            fontSize: 12, padding: '7px 14px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
            border: sortConvFirst ? '1px solid rgba(20,184,166,0.5)' : '1px solid var(--theme-border)',
            background: sortConvFirst ? 'rgba(20,184,166,0.1)' : 'transparent',
            color: sortConvFirst ? '#2dd4bf' : 'var(--theme-text2)',
            fontWeight: sortConvFirst ? 600 : 400
          }}
        >
          {sortConvFirst ? '✕ ' : ''}With Conversion
        </button>
      </div>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--theme-border)', marginBottom: 0, flexWrap: 'wrap' }}>
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
              color: active ? 'var(--theme-accent)' : 'var(--theme-text2)',
              borderBottom: active ? '2px solid var(--theme-accent)' : '2px solid transparent',
              marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap'
            }}>
              {tab.name.length > 13
                ? tab.name.split(' ').slice(0,2).map((w,i) => i===0 ? w : w.slice(0,4)+'.').join(' ')
                : tab.name}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                background: active ? 'rgba(201,168,76,0.12)' : 'rgba(107,114,128,0.12)',
                color: active ? 'var(--theme-accent)' : 'var(--theme-text2)'
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
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Item Name</th>
                  {showCategoryCol && <th>Category</th>}
                  <th>UOM</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Quantity in base units per purchase order unit (e.g. 1 carton = 12 bottles → 12). Used to convert purchase-unit prices to per-base-unit rates." width={280}>Purch. Qty</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Purchase price per purchase unit (e.g. per carton). Divide by Purch. Qty to get the per-base-unit rate." width={260}>Rate (NPR)</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip text="Rate per base unit = Rate ÷ Purch. Qty. This is the cost used in recipe costing and stock valuation." width={270}>/ UOM</Tip>
                  </th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip width={240} text="Usable % after trim/prep. Red = trim loss is factored into recipe costing. 100% = no loss (default).">
                      Yield %
                    </Tip>
                  </th>
                  <th><Tip text="Purchase unit → base unit mapping (e.g. 1 carton = 12 bottles). Set this when your vendor sells in bulk but you track stock in individual units." width={280}>Conversion</Tip></th>
                  <th>Status</th>
                  <th><Tip text="Number of recipes that use this item as an ingredient. Helps identify items that are safe to archive." width={250}>Used In</Tip></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => {
                  const hasConversion = item.purchase_unit && item.base_unit && item.conversion_factor && item.conversion_factor !== 1
                  return (
                    <tr key={item.id}>
                      <td style={{ color: 'var(--theme-accent)', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
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
                      <td style={{ textAlign: 'right' }}>{Number(item.purchase_qty).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{Number(item.rate).toLocaleString()}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-accent)' }}>
                        {Number(item.per_uom_rate).toFixed(2)}
                      </td>
                      <td style={{ textAlign: 'right', color: parseFloat(item.yield_pct) < 100 ? 'var(--theme-red)' : 'var(--theme-text2)' }}>
                        {parseFloat(item.yield_pct || 100).toFixed(0)}%
                      </td>
                      <td>
                        {hasConversion ? (
                          <span style={{
                            fontSize: 11, background: 'rgba(52,211,153,0.08)',
                            color: 'var(--theme-green)', border: '1px solid rgba(52,211,153,0.25)',
                            borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap'
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
                          <span title={`Used in: ${usageMap[item.id].map(code => USAGE_LABELS[code] || code).join(', ')}`} style={{
                            fontSize: 11, background: 'rgba(201,168,76,0.12)',
                            color: 'var(--theme-accent)', border: '1px solid rgba(201,168,76,0.3)',
                            borderRadius: 4, padding: '2px 7px', cursor: 'default', whiteSpace: 'nowrap'
                          }}>
                            🔗 {usageMap[item.id].join(', ')}
                          </span>
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
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--theme-red)', borderColor: 'rgba(248,113,113,0.3)' }}
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
