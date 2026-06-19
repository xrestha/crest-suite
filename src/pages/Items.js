import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { useSettings } from '../context/SettingsContext'
import { supabase } from '../supabaseClient'
import Tip from '../components/Tip'

const DEFAULT_CATEGORIES = [
  'Kitchen Production',
  'Dairy & Bakery',
  'Meats & Poultry',
  'Groceries',
  'Veg & Fruits',
  'Beverage',
  'Misc. Items'
]

const UNITS = ['GM', 'ML', 'KG', 'LTR', 'PCS', 'PKT', 'BTL', 'BOX', 'ROLL', 'BUNCH', 'JAR', 'CTN', 'BAG', 'TIN', 'SACHET']

const USAGE_LABELS = { OS: 'Opening Stock', CS: 'Closing Stock', R: 'Recipes', P: 'Purchases', W: 'Wastage' }

const EMPTY_FORM = {
  name: '', category_id: '', uom: 'GM',
  purchase_qty: '', rate: '', yield_pct: '100',
  purchase_unit: '', base_unit: '', conversion_factor: ''
}

export default function Items() {
  const { clientId } = useAuth()
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
  const [initingCats, setInitingCats] = useState(false)
  const [usageMap, setUsageMap] = useState({})

  const effectiveClientId = clientId

  useEffect(() => {
    if (!clientId) return
    setLoading(true)
    Promise.all([loadCategories(), loadItems(), checkAllUsage()])
      .finally(() => setLoading(false))
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function checkAllUsage() {
    const referenceTables = [
      { table: 'recipe_ingredients', label: 'R',  qtyCol: null },
      { table: 'purchase_entries',   label: 'P',  qtyCol: 'qty' },
      { table: 'opening_stock',      label: 'OS', qtyCol: 'qty' },
      { table: 'closing_stock',      label: 'CS', qtyCol: 'physical_qty' },
      { table: 'wastages',           label: 'W',  qtyCol: 'qty' },
    ]
    const map = {}
    for (const { table, label, qtyCol } of referenceTables) {
      const { data } = await supabase.from(table).select(qtyCol ? `item_id, ${qtyCol}` : 'item_id')
      if (data) {
        data.forEach(row => {
          if (!row.item_id) return
          if (qtyCol && (!row[qtyCol] || parseFloat(row[qtyCol]) <= 0)) return
          if (!map[row.item_id]) map[row.item_id] = []
          if (!map[row.item_id].includes(label)) map[row.item_id].push(label)
        })
      }
    }
    setUsageMap(map)
  }

  async function deleteItem(item) {
    if (usageMap[item.id]?.length > 0) {
      const fullNames = usageMap[item.id].map(code => USAGE_LABELS[code] || code)
      alert(`Cannot delete "${item.name}" — referenced in: ${fullNames.join(', ')}. Hide it instead.`)
      return
    }
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone.`)) return
    const { error } = await supabase.from('items').delete().eq('id', item.id)
    if (error) { setError(error.message); return }
    loadItems()
    checkAllUsage()
  }

  async function loadCategories() {
    const { data } = await supabase
      .from('categories').select('*').eq('client_id', effectiveClientId).order('sort_order')
    setCategories(data || [])
    return data || []
  }

  async function loadItems() {
    const { data } = await supabase
      .from('items')
      .select('*, categories(name)')
      .eq('client_id', effectiveClientId)
      .order('name')
    setItems(data || [])
  }

  async function initDefaultCategories() {
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

  async function save() {
    if (!form.name.trim()) { setError('Item name is required.'); return }
    if (!form.purchase_qty || !form.rate) { setError('Purchase qty and rate are required.'); return }

    // Conversion validation
    const hasPurchaseUnit = form.purchase_unit.trim() !== ''
    const hasBaseUnit = form.base_unit.trim() !== ''
    const hasFactor = form.conversion_factor !== '' && parseFloat(form.conversion_factor) > 0
    const hasAny = hasPurchaseUnit || hasBaseUnit || hasFactor
    if (hasAny && !(hasPurchaseUnit && hasBaseUnit && hasFactor)) {
      setError('Conversion requires all three fields: Purchase Unit, Base Unit, and Conversion Factor.')
      setActiveTab('conversion')
      return
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
      if (error) { setError(error.message); setSaving(false); return }
    } else {
      const { error } = await supabase.from('items').insert({
        ...payload, client_id: clientId, item_code: getNextItemCode()
      })
      if (error) { setError(error.message); setSaving(false); return }
    }
    setSaving(false)
    setShowForm(false)
    loadItems()
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
    return matchCat && matchSearch
  })

  const tabStyle = (tab) => ({
    padding: '8px 18px',
    fontSize: 13,
    fontWeight: activeTab === tab ? 600 : 400,
    color: activeTab === tab ? '#c9a84c' : '#6b7280',
    background: 'none',
    border: 'none',
    borderBottom: activeTab === tab ? '2px solid #c9a84c' : '2px solid transparent',
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
        <div style={{ display: 'flex', gap: 10 }}>
          {categories.length === 0 && (
            <button className="btn btn-ghost" onClick={initDefaultCategories} disabled={initingCats}>
              {initingCats ? 'Setting up…' : '⚡ Load Default Categories'}
            </button>
          )}
          <button className="btn btn-primary" onClick={openNew}>+ Add Item</button>
        </div>
      </div>

      {categories.length === 0 && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'rgba(201,168,76,0.3)' }}>
          <p style={{ color: '#c9a84c', fontSize: 13, margin: 0 }}>
            No categories found. Click <strong>⚡ Load Default Categories</strong> to set up your 7 standard categories matching your Excel structure.
          </p>
        </div>
      )}

      {showForm && (
        <div className="card" style={{ marginBottom: 24 }}>
          {/* Tab bar */}
          <div style={{ display: 'flex', borderBottom: '1px solid #2a2f3d', marginBottom: 20, gap: 0 }}>
            <button style={tabStyle('details')} onClick={() => setActiveTab('details')}>
              Details
            </button>
            <button style={tabStyle('conversion')} onClick={() => setActiveTab('conversion')}>
              Conversion
              {form.purchase_unit && form.base_unit && form.conversion_factor
                ? <span style={{ marginLeft: 6, fontSize: 11, color: '#34d399' }}>●</span>
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
                  <label>Purchase Qty</label>
                  <input
                    type="number"
                    value={form.purchase_qty}
                    onChange={e => setForm(f({ purchase_qty: e.target.value }))}
                    placeholder="1000"
                  />
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
                  <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, display: 'block' }}>Usable % after trim/prep. 100 = no loss</span>
                </div>
              </div>
              {form.purchase_qty && form.rate && (
                <p style={{ fontSize: 12, color: '#c9a84c', margin: '10px 0 0' }}>
                  Per {form.uom} rate: NPR {perUom(form.purchase_qty, form.rate)}
                </p>
              )}
            </>
          )}

          {/* Conversion tab */}
          {activeTab === 'conversion' && (
            <>
              <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px' }}>
                Set this when you buy in one unit but use/count in another.
                e.g. buy in <strong style={{ color: '#e8e0d0' }}>CTN</strong>, use per <strong style={{ color: '#e8e0d0' }}>BTL</strong> — or buy in <strong style={{ color: '#e8e0d0' }}>KG</strong>, use in <strong style={{ color: '#e8e0d0' }}>GM</strong>.
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
                  <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, display: 'block' }}>Unit you buy in</span>
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
                  <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, display: 'block' }}>Unit used in kitchen</span>
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
                  <span style={{ fontSize: 11, color: '#9ca3af', marginTop: 4, display: 'block' }}>Base units per purchase unit</span>
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
                    <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#34d399' }}>
                      {conversionPreview(form.purchase_unit, form.base_unit, form.conversion_factor)}
                    </p>
                    {form.rate && form.conversion_factor && (
                      <p style={{ margin: '3px 0 0', fontSize: 12, color: '#6b7280' }}>
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
                    style={{ fontSize: 12, color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}
                    onClick={() => setForm(f({ purchase_unit: '', base_unit: '', conversion_factor: '' }))}
                  >
                    ✕ Clear Conversion
                  </button>
                </div>
              )}
            </>
          )}

          {error && <p style={{ color: '#f87171', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Update Item' : 'Add Item'}
            </button>
          </div>
        </div>
      )}

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          style={{
            background: '#181c27', border: '1px solid #2a2f3d', borderRadius: 6,
            padding: '8px 12px', fontSize: 13, color: '#e8e0d0', outline: 'none', width: 260
          }}
          placeholder="Search by name or code…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid #2a2f3d', marginBottom: 0, flexWrap: 'wrap' }}>
        {[{ id: 'all', name: 'All Items' }, ...catsWithItems].map(tab => {
          const count = items.filter(i =>
            (tab.id === 'all' || i.category_id === tab.id) &&
            (i.name.toLowerCase().includes(search.toLowerCase()) || (i.item_code || '').toLowerCase().includes(search.toLowerCase()))
          ).length
          const active = filterCat === tab.id
          return (
            <button key={tab.id} onClick={() => setFilterCat(tab.id)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '10px 16px', fontSize: 13, fontWeight: 500,
              color: active ? '#c9a84c' : '#6b7280',
              borderBottom: active ? '2px solid #c9a84c' : '2px solid transparent',
              marginBottom: -1, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap'
            }}>
              {tab.name.length > 13
                ? tab.name.split(' ').slice(0,2).map((w,i) => i===0 ? w : w.slice(0,4)+'.').join(' ')
                : tab.name}
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 8,
                background: active ? 'rgba(201,168,76,0.12)' : 'rgba(107,114,128,0.12)',
                color: active ? '#c9a84c' : '#6b7280'
              }}>{count}</span>
            </button>
          )
        })}
      </div>

      <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
        {loading ? (
          <p style={{ color: '#6b7280', fontSize: 13 }}>Loading…</p>
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
                  <th style={{ textAlign: 'right' }}>Purch. Qty</th>
                  <th style={{ textAlign: 'right' }}>Rate (NPR)</th>
                  <th style={{ textAlign: 'right' }}>/ UOM</th>
                  <th style={{ textAlign: 'right' }}>
                    <Tip width={240} text="Usable % after trim/prep. Red = trim loss is factored into recipe costing. 100% = no loss (default).">
                      Yield %
                    </Tip>
                  </th>
                  <th>Conversion</th>
                  <th>Status</th>
                  <th>Used In</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => {
                  const hasConversion = item.purchase_unit && item.base_unit && item.conversion_factor && item.conversion_factor !== 1
                  return (
                    <tr key={item.id}>
                      <td style={{ color: '#c9a84c', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }}>
                        {item.item_code || '—'}
                      </td>
                      <td style={{ fontWeight: 600, color: '#e8e0d0' }}>{item.name}</td>
                      {showCategoryCol && (
                        <td>
                          {item.categories?.name
                            ? <span className="badge badge-yellow">{item.categories.name}</span>
                            : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                      )}
                      <td>{item.uom}</td>
                      <td style={{ textAlign: 'right' }}>{Number(item.purchase_qty).toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{Number(item.rate).toLocaleString()}</td>
                      <td style={{ textAlign: 'right', color: '#c9a84c' }}>
                        {Number(item.per_uom_rate).toFixed(2)}
                      </td>
                      <td style={{ textAlign: 'right', color: parseFloat(item.yield_pct) < 100 ? '#f87171' : '#6b7280' }}>
                        {parseFloat(item.yield_pct || 100).toFixed(0)}%
                      </td>
                      <td>
                        {hasConversion ? (
                          <span style={{
                            fontSize: 11, background: 'rgba(52,211,153,0.08)',
                            color: '#34d399', border: '1px solid rgba(52,211,153,0.25)',
                            borderRadius: 4, padding: '2px 7px', whiteSpace: 'nowrap'
                          }}>
                            🔄 1 {item.purchase_unit} = {item.conversion_factor} {item.base_unit}
                          </span>
                        ) : (
                          <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
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
                            color: '#c9a84c', border: '1px solid rgba(201,168,76,0.3)',
                            borderRadius: 4, padding: '2px 7px', cursor: 'default', whiteSpace: 'nowrap'
                          }}>
                            🔗 {usageMap[item.id].join(', ')}
                          </span>
                        ) : (
                          <span style={{ color: '#9ca3af', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => openEdit(item)}>Edit</button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => toggleActive(item)}>
                          {item.is_active ? 'Hide' : 'Show'}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: '#f87171', borderColor: 'rgba(248,113,113,0.3)' }}
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
    </div>
  )
}
