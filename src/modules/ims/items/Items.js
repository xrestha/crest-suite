import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useSettings } from '../../../context/SettingsContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows, fetchAllRowsChunked } from '../../../shared/fetchAllRows'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Fab from '../../../components/Fab'
import Modal from '../../../components/Modal'
import FieldError, { fieldAria } from '../../../components/FieldError'
import QtyInput from '../../../components/QtyInput'
import UsageChip from '../../../components/UsageChip'
import { Navigate } from 'react-router-dom'
import { printWithTitle } from '../../../utils/printTitle'
import { errorInfo } from '../../../shared/errorText'
import ActionError, { asActionError } from '../../../components/ActionError'
import { readPageCache, writePageCache } from '../../../shared/sessionDataCache'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { ITEM_REF_TABLES, USAGE_LABELS, REF_TABLE_PROSE } from './itemRefTables'

const DEFAULT_CATEGORIES = [
  'Dairy & Bakery',
  'Meats & Poultry',
  'Groceries',
  'Veg & Fruits',
  'Beverage',
  'Misc. Items'
]

const UNITS = ['GM', 'ML', 'KG', 'LTR', 'PCS', 'PKT', 'BTL', 'BOX', 'ROLL', 'BUNCH', 'JAR', 'CTN', 'BAG', 'TIN', 'SACHET']

const HIDE_INSTEAD =
  'Hide it instead: it stops being offered on new entries and keeps every record it is already on. ' +
  'Note that a hidden item is also left out of stock valuation and the monthly summary, so hide it once its stock is down to zero.'

// `rate` here is the price of ONE base unit — the only price the form collects and the exact value
// written to items.rate. There is no pack size on the form or in the row; see the note on `pack`.
// No `base_unit`: it is always the item's own UOM, so a box for it was a choice that only had one
// correct answer — the sibling of the `Purchase Qty` field S597 removed for the same reason.
const EMPTY_FORM = {
  name: '', category_id: '', uom: 'GM',
  rate: '', yield_pct: '100',
  purchase_unit: '', conversion_factor: ''
}

export default function Items() {
  const { clientId, isAdmin, hasImsAccess } = useAuth()
  const { settings } = useSettings()
  const { scopedFrom, scopedInsert, scopedUpsert, scopedUpdate } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  // Seeded from the short-lived session cache so a revisit paints the last-known list instantly
  // while the fresh reads reload quietly underneath (S460 pattern). Safe here: saves on this page
  // write only the one item being edited; the delete guard's usageMap is never cached — it always
  // comes from the live reads.
  const [cachedItems] = useState(() => readPageCache('items', 'items', clientId))
  const [items, setItems] = useState(cachedItems ?? [])
  const [categories, setCategories] = useState(() => readPageCache('items', 'categories', clientId) ?? [])
  const [loading, setLoading] = useState(!cachedItems)
  const [showForm, setShowForm] = useState(false)
  // The form's `error` renders inside the Add/Edit modal, so it is unreachable from the toolbar and
  // the row actions. Those failures used to go to `alert('Error: ' + error.message)` — the browser's
  // own chrome, carrying a Postgres string with the word "Error" as its headline.
  const [pageError, setPageError] = useState(null)
  const [activeTab, setActiveTab] = useState('details') // 'details' | 'conversion'
  const [form, setForm] = useState(EMPTY_FORM)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // The raw `code · message` behind `error`, kept as fine print rather than the headline. A save
  // that dies at the network layer surfaces as "TypeError: Failed to fetch", which says nothing an
  // owner can act on and — worse — nothing about whether the row landed (S618).
  const [errorDetail, setErrorDetail] = useState('')
  // Per-field validation, separate from `error` above. `error` stays the FORM-level channel — a
  // save that the server rejected, or a rule spanning several fields (the conversion trio) that no
  // single box owns. A message about one box belongs under that box (S603).
  const [fieldErr, setFieldErr] = useState({})
  const [filterCat, setFilterCat] = useState('all')
  const [search, setSearch] = useState('')
  const [sortConvFirst, setSortConvFirst] = useState(false)
  const [initingCats, setInitingCats] = useState(false)
  // TWO maps out of one set of reads, because the badge and the delete guard ask different
  // questions. `usageMap` is live usage (qty > 0 where the table has a qty) and drives the chip and
  // the Used In filter. `refMap` is any referencing row at all, and is the only thing the delete
  // guard may consult — three of the eleven tables cascade, so a zero-quantity row that does not
  // earn a badge still gets destroyed by a delete that thinks the item is unreferenced.
  const [usageMap, setUsageMap] = useState({})
  const [refMap, setRefMap] = useState({})
  // Whether the usage scan actually answered. An absent chip must always mean "no records" and
  // never "we could not check" (the UsageChip rule), and the delete guard must refuse rather than
  // promise that nothing references an item it failed to look up.
  const [usageScan, setUsageScan] = useState({ ok: false, failed: [] })
  const [filterUsage, setFilterUsage] = useState('all')
  // A failed READ of the item book is not an empty item book. Without this, `data || []` renders
  // "No items yet. Add your first ingredient to get started." over a client's whole master list.
  const [loadError, setLoadError] = useState(null)
  const [togglingId, setTogglingId] = useState(null)
  // Working-out, never data: "I bought 500 GM for NPR 388.50" → NPR 0.777 per GM, which is what
  // actually gets stored. Deliberately cleared every time the dialog opens — items.purchase_qty is
  // always 1 and there is no column to remember a pack size in. If the pack is a standing fact
  // about the item ("this always comes in 500 GM bottles"), that belongs on the Conversion tab,
  // which is also what the Purchase Bill reads to decide whether its Qty column means bottles or
  // grams. Two boxes, one meaning each — the old Purchase Qty / Rate pair meant the pack price
  // while you typed and the per-unit price once you reopened it (S597).
  const [pack, setPack] = useState({ qty: '', total: '' })

  // Which client the list on screen belongs to. An admin switching clients in the top bar does not
  // remount this page, and `loading` was only raised when the list happened to be empty — so the
  // previous client's items stayed on screen, under the new client's name, filterable and
  // editable, until the fetch landed. A ref rather than state: it is read synchronously by the
  // loaders below to reject a response that belongs to the client we just left.
  const loadedClientRef = useRef(clientId)

  useEffect(() => {
    if (!clientId) return
    const switched = loadedClientRef.current !== clientId
    loadedClientRef.current = clientId
    if (switched) {
      // Repaint from the NEW client's cache (or nothing), never leave the old client's rows up.
      const cached = readPageCache('items', 'items', clientId)
      setItems(cached ?? [])
      setCategories(readPageCache('items', 'categories', clientId) ?? [])
      setUsageMap({}); setRefMap({}); setUsageScan({ ok: false, failed: [] })
      setLoadError(null); setPageError(null)
      setLoading(!cached)
    } else if (items.length === 0) {
      setLoading(true) // a cached list keeps showing while this refreshes
    }
    Promise.all([loadCategories(clientId), loadItems(clientId), checkAllUsage(clientId)])
      .finally(() => { if (loadedClientRef.current === clientId) setLoading(false) })
  }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function checkAllUsage(forClient = clientId) {
    // None of these tables were filtered at all — for an admin "viewing as" a client, RLS
    // allows every tenant's rows, so this pulled every client's ENTIRE purchase/stock/wastage/
    // requisition/return history into the browser just to compute a "Used In" badge (a real
    // cross-tenant data exposure + unbounded-payload perf bug). Most of these tables are
    // period/parent-scoped rather than client_id-scoped directly (see CLAUDE.md), so the
    // reliable fix across all of them is to intersect on this client's own item ids instead — an
    // item_id can only ever belong to one client, so this is exactly as tight as a client_id
    // filter would be, without needing per-table-specific scoping logic.
    //
    // Paged, because this read is the one that decides whether an item is safe to delete: past
    // 1000 SKUs the bare select silently stopped listing items, and every item after the cap was
    // never checked for usage at all.
    const { data: myItems, error: myItemsErr } = await fetchAllRows(() =>
      scopedFrom('items', 'id').order('id'))
    if (loadedClientRef.current !== forClient) return
    // A failed read must not blank the usage map — it feeds the delete guard, and an empty map
    // reads as "nothing references this item" (S612 silent-zero class). Record that it failed, so
    // the guard refuses instead of promising the item is unreferenced.
    if (myItemsErr) { setUsageScan({ ok: false, failed: ['the item list'] }); return }
    const myItemIds = (myItems || []).map(i => i.id)
    if (myItemIds.length === 0) {
      setUsageMap({}); setRefMap({}); setUsageScan({ ok: true, failed: [] }); return
    }

    // CHUNKED, not one big `.in()`. A `.in()` list is spelled out in the request URL and a uuid
    // costs ~37 characters, so the reference client's 254 items already put ~9 KB of ids on every
    // one of these requests — past what proxies accept, and the resulting 414 was then SKIPPED
    // QUIETLY below, blanking the whole Used In column and opening the delete guard. The row cap
    // still applies underneath: purchase_entries alone crosses 1000 on any real client.
    //
    // The reads are independent of each other, so they run together rather than as one round trip
    // per table on the critical path of every page load.
    const results = await Promise.all(ITEM_REF_TABLES.map(({ table, qtyCol }) =>
      fetchAllRowsChunked(myItemIds, ids => supabase.from(table)
        .select(qtyCol ? `item_id, ${qtyCol}` : 'item_id').in('item_id', ids).order('id'))
        .catch(err => ({ data: null, error: err }))))
    if (loadedClientRef.current !== forClient) return

    const map = {}      // live usage — the badge
    const refs = {}     // any reference at all — the delete guard
    const failed = []
    ITEM_REF_TABLES.forEach(({ label, name, qtyCol }, idx) => {
      const { data, error } = results[idx]
      // A table that could not be read is NOT a table with no rows. Name it, so the guard can say
      // what it was unable to check rather than silently treating it as clear.
      if (error || !data) { failed.push(name); return }
      data.forEach(row => {
        if (!row.item_id) return
        if (!refs[row.item_id]) refs[row.item_id] = []
        if (!refs[row.item_id].includes(label)) refs[row.item_id].push(label)
        if (qtyCol && (!row[qtyCol] || parseFloat(row[qtyCol]) <= 0)) return
        if (!map[row.item_id]) map[row.item_id] = []
        if (!map[row.item_id].includes(label)) map[row.item_id].push(label)
      })
    })
    setUsageMap(map)
    setRefMap(refs)
    setUsageScan({ ok: failed.length === 0, failed })
  }

  async function deleteItem(item) {
    setPageError(null)
    // The guard reads refMap, not usageMap: a zero-quantity row earns no badge and still cascades.
    const refs = refMap[item.id] || []
    // And it refuses outright when the scan did not answer. Three of the eleven referencing tables
    // are ON DELETE CASCADE, so "the database will stop me" is true for five of them and false for
    // three — a delete run on an unchecked item does not fail safely, it destroys requisition
    // lines, staff meals and vendor returns without asking.
    if (refs.length === 0 && !usageScan.ok) {
      setPageError(
        `Crest could not check where "${item.name}" is used${usageScan.failed.length ? ` — ${usageScan.failed.join(', ')} could not be read` : ''}, so it will not delete it. ` +
        'Some of those records would be removed along with the item rather than blocking the delete, and there is no undo. Reload the page and try again; if the check keeps failing, hide the item instead.'
      )
      return
    }
    if (refs.length > 0) {
      const fullNames = refs.map(code => USAGE_LABELS[code] || code).join(', ')
      if (!isAdmin) {
        setPageError(`"${item.name}" can't be deleted — it already appears in ${fullNames}, and deleting it would take those records with it. ${HIDE_INSTEAD}`)
        return
      }
      // Admin: offer to force-delete (removes the referencing records too). The most destructive
      // action in IMS, so the ask is the product's own dialog with the consequence spelled out
      // (S682; was a window.confirm with the same text squeezed into an OS box).
      askForceDelete(item, `"${item.name}" is referenced in ${fullNames}.`)
      return
    }
    askConfirm({
      title: `Delete "${item.name}"?`,
      confirmLabel: 'Delete Item', danger: true, busyLabel: 'Deleting…',
      body: <p style={{ margin: 0 }}>Nothing references this item, so no purchase, count or recipe changes — it is simply removed from Item Master. This cannot be undone.</p>,
      run: async () => {
        setPageError(null)
        const { error } = await supabase.from('items').delete().eq('id', item.id)
        if (error) {
          // Foreign-key violation from a reference the scan didn't see. `23503` is the exact code;
          // the text match stays only as a fallback for an error that arrives without one.
          const isFk = error.code === '23503' || /foreign key|violates|referenced/i.test(error.message || '')
          if (isFk && isAdmin) {
            askForceDelete(item, `"${item.name}" still has references that did not show against it here.`)
            return
          }
          if (isFk) {
            setPageError(`"${item.name}" can't be deleted — an older record still refers to it (a purchase, stock count, wastage, requisition, vendor return, par level, purchase order, stock movement or recipe line) even though nothing shows against it here. ${HIDE_INSTEAD}`)
          } else {
            const { text, detail } = asActionError(error)
            setPageError({ text: `"${item.name}" was not deleted. ${text}`, detail })
          }
          return
        }
        loadItems()
        checkAllUsage()
      },
    })
  }

  function askForceDelete(item, lead) {
    askConfirm({
      title: `Force-delete "${item.name}"?`,
      confirmLabel: 'Force Delete', danger: true, busyLabel: 'Deleting…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>{lead}</p>
          <p style={{ margin: '0 0 8px' }}>
            Force-delete permanently removes the item <strong>and every record that references it</strong> — {REF_TABLE_PROSE}.
            Every report covering those periods changes.
          </p>
          <p style={{ margin: 0 }}>To keep the history, hide the item instead. This cannot be undone.</p>
        </>
      ),
      run: () => forceDeleteItem(item),
    })
  }

  // Admin-only hard delete: clears every FK reference, then removes the item.
  //
  // The list is ITEM_REF_TABLES, in its declared order, so this can no longer clear a different
  // set from the one the badge checks — that divergence is what left par_levels,
  // purchase_order_items and stock_movements holding the item after everything else had been
  // destroyed. Order matters: vendor_returns before purchase_entries, which it also references.
  async function forceDeleteItem(item) {
    const id = item.id
    const cleared = []
    const refused = []
    for (const { table, name } of ITEM_REF_TABLES) {
      // Sequential on purpose — the order above is a dependency order, not a preference.
      const { error } = await supabase.from(table).delete().eq('item_id', id)
      if (error) refused.push(name); else cleared.push(name)
    }
    const { error } = await supabase.from('items').delete().eq('id', id)
    if (error) {
      // The reference-clearing loop has already run, so this is never a no-op failure: say what
      // state the record is in now, and do not tell the operator to retry when a refused clear is
      // the reason — retrying repeats the same refusal and clears nothing further.
      const { text, detail } = asActionError(error)
      const gone = cleared.length ? `Its ${cleared.map(n => n.toLowerCase()).join(', ')} records have already been removed and reports covering those periods will have changed.` : 'No referencing records were removed.'
      const next = refused.length
        ? `Crest could not clear ${refused.map(n => n.toLowerCase()).join(', ')}, which is what is still holding the item — retrying will not get past it. Remove those records directly, or leave the item in place and hide it.`
        : 'Try the delete again.'
      setPageError({ text: `"${item.name}" was not deleted. ${gone} ${next}

${text}`, detail })
      loadItems()
      checkAllUsage()
      return
    }
    loadItems()
    checkAllUsage()
  }

  async function clearAllConversions() {
    const withConversion = items.filter(i => i.purchase_unit)
    setPageError(null)
    if (withConversion.length === 0) { setPageError('No items have a purchase-unit conversion set, so there is nothing to clear.'); return }
    askConfirm({
      title: `Clear conversions on ${withConversion.length} item${withConversion.length !== 1 ? 's' : ''}?`,
      confirmLabel: 'Clear Conversions', danger: true, busyLabel: 'Clearing…',
      body: <p style={{ margin: 0 }}>Purchase Unit, Base Unit, Conversion Factor and Purchase Qty reset to 1 on each affected item, so the next purchase bill for any of them is entered in the base unit. Existing purchases keep the quantities they were stored with. This cannot be undone.</p>,
      run: async () => {
        // `.eq('is_sub_recipe', false)` so the update matches the population the count above was
        // taken from — `items` excludes sub-recipe mirror rows, and without this the dialog said
        // "12 items" and cleared however many mirrors also carried a purchase unit.
        const { error } = await scopedUpdate('items', { purchase_unit: null, base_unit: null, conversion_factor: 1, purchase_qty: 1 })
          .eq('is_sub_recipe', false)
          .not('purchase_unit', 'is', null)
        if (error) { setPageError(asActionError(error)); return }
        await loadItems()
      },
    })
  }

  // Both loaders drop nothing. A dropped read error rendered as an empty book — "No items yet.
  // Add your first ingredient to get started" over a client's entire master list — and then WROTE
  // that empty array into the 10-minute session cache, so the next visit repainted it instantly
  // with no read in flight to correct it. Neither loader caches a result it did not get.
  async function loadCategories(forClient = clientId) {
    const { data, error } = await scopedFrom('categories').order('sort_order')
    if (loadedClientRef.current !== forClient) return []
    if (error) { setLoadError(asActionError(error)); return [] }
    const filtered = (data || []).filter(c => c.name !== 'Sub-Recipes')
    setCategories(filtered)
    writePageCache('items', 'categories', forClient, filtered)
    return filtered
  }

  async function loadItems(forClient = clientId) {
    // Paged: a bare select stops at PostgREST's 1000 rows with no error and nothing in the data to
    // say so, which on this page means a partial item book presented as the whole one — and
    // getNextItemCode() then takes its max over the visible slice and mints a duplicate code.
    // `.order('id')` is the unique tiebreaker paging requires after the display order.
    const { data, error } = await fetchAllRows(() =>
      scopedFrom('items', '*, categories(name)')
        .eq('is_sub_recipe', false)
        .order('name')
        .order('id'))
    if (loadedClientRef.current !== forClient) return
    if (error) { setLoadError(asActionError(error)); return }
    setLoadError(null)
    setItems(data || [])
    writePageCache('items', 'items', forClient, data || [])
  }

  async function initDefaultCategories() {
    // scopedUpsert refuses (and returns an error) if no client is selected, instead of
    // seeding a null-client_id row — see memory: bug-null-client-id.
    setInitingCats(true)
    setPageError(null)
    const inserts = DEFAULT_CATEGORIES.map((name, i) => ({ name, sort_order: i }))
    const { error } = await scopedUpsert('categories', inserts, { onConflict: 'client_id,name', ignoreDuplicates: true })
    if (error) setPageError(asActionError(error))
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
  // ONE derivation feeds both the "→ NPR x per uom" preview and the rate written into the form —
  // they briefly had independent copies of this division with different rounding, which is how a
  // preview comes to state a price the form did not save. Number(), not parseFloat: a prefix
  // parse of a not-quite-numeric string ("5oo" → 5, "1,200" → 1) must never price an item.
  function perUnitOf(qty, total) {
    const q = Number(qty), t = Number(total)
    return q > 0 && t > 0 ? Number((t / q).toFixed(6)) : null
  }
  const packPerUnit = perUnitOf(pack.qty, pack.total)
  // Both boxes filled but the division can't run (zero, negative, unparseable): the rate box
  // above deliberately KEEPS its last value in that state, so it must be flagged here or the
  // pack line and the saved price silently disagree on screen. One message spans both boxes, so
  // both carry fieldAria with the SAME id — the one the FieldError below derives its own id from.
  const packInvalid = pack.qty !== '' && pack.total !== '' && packPerUnit == null
  const packErr = packInvalid
    ? `Both boxes need a number above zero — Price per ${form.uom} above still shows its last value.`
    : ''

  function setPackField(field, val) {
    const next = { ...pack, [field]: val }
    setPack(next)
    const v = perUnitOf(next.qty, next.total)
    if (v != null) setForm(prev => ({ ...prev, rate: String(v) }))
  }

  function openNew() {
    setEditing(null)
    setForm({ ...EMPTY_FORM, category_id: categories[0]?.id || '' })
    setActiveTab('details')
    setPack({ qty: '', total: '' })
    showError('')
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
      conversion_factor: item.conversion_factor && item.conversion_factor !== 1 ? item.conversion_factor : ''
    })
    setActiveTab('details')
    showError('')
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

  // One entry point for the modal's error line, so a stale technical detail can never outlive the
  // message it belonged to.
  function showError(text, detail = '') { setError(text); setErrorDetail(detail) }

  // A write that failed. `errorInfo(..., 'operator')` says what happened in words the owner can
  // act on; the raw `code · message` is kept underneath, because whoever diagnoses it still needs
  // it. Deliberately never asserts the row was not written — a fetch can die after the server has
  // already committed, and `items` has no UNIQUE(client_id, name) to catch a retried duplicate.
  function showSaveError(err) {
    const { text, detail } = errorInfo(err, 'operator')
    showError(text, detail)
  }

  // Core save — validates + writes, returns true on success. Does NOT close the modal or reload,
  // so callers can chain a "save & next" navigation.
  async function doSave() {
    if (!clientId) { showError('No client selected. Pick a client in the top-left switcher before saving.'); return false }
    const fe = {}
    if (!form.name.trim()) fe.name = 'Item name is required.'
    // parseFloat, not truthiness: "0" is truthy as a string, and a price of NPR 0 stored here
    // misprices the item in every valuation at once with nothing to flag it (S612).
    if (!form.rate || !(parseFloat(form.rate) > 0)) fe.rate = `Price per ${form.uom} is required and must be above zero — type it in, or use "Bought a pack?" to work it out.`
    // `min`/`max` on the input are decorative: this dialog is not a <form> and Save is a plain
    // onClick, so nothing enforced them. yield_pct is numeric(5,2), and every recipe cost divides
    // by it — a typed 500 makes every dish using this item cost a fifth of what it does, silently
    // and everywhere at once. A 0 or a negative used to become 100 with no message, which is a
    // different number from the one the user typed.
    const yieldNum = parseFloat(form.yield_pct)
    if (form.yield_pct === '' || !isFinite(yieldNum) || yieldNum <= 0 || yieldNum > 100) {
      fe.yield_pct = 'Yield must be a number from 1 to 100 — it is the usable percentage left after trim, so 100 means no loss. Leave it at 100 if you are not sure.'
    }
    // `items` has no UNIQUE(client_id, name), so a second "CHICKEN BREAST" saves happily and the
    // client's purchases then split across two master rows that every report treats as two items.
    const nameKey = form.name.trim().toUpperCase()
    if (nameKey && items.some(i => i.id !== editing && (i.name || '').toUpperCase() === nameKey)) {
      fe.name = `You already have an item called "${nameKey}". Two items with one name split that ingredient's purchases and stock between them. Edit the existing one, or give this a name that tells them apart.`
    }
    setFieldErr(fe)
    if (fe.name || fe.rate || fe.yield_pct) { setActiveTab('details'); return false }

    // Conversion validation. Base Unit is no longer collected — it is always the item's own UOM
    // (see the Conversion tab), so the rule is the remaining pair.
    const hasPurchaseUnit = form.purchase_unit.trim() !== ''
    const hasFactor = form.conversion_factor !== '' && parseFloat(form.conversion_factor) > 0
    if (hasPurchaseUnit !== hasFactor) {
      showError('Conversion needs both fields: the Purchase Unit you buy in, and how many ' + form.uom + ' come in one of them.')
      setActiveTab('conversion')
      return false
    }

    setSaving(true)
    showError('')

    const cf = hasFactor ? parseFloat(form.conversion_factor) : 1

    // purchase_qty is pinned to 1 and deliberately NOT set from the conversion factor: a
    // buy-in-CTN / count-in-BTL relationship belongs to the Conversion tab, which is what the
    // Purchase Bill reads to pick its qty unit. Mirroring it here would store a per-CTN price in a
    // column every valuation reads as per-BTL.
    const payload = {
      name: nameKey,
      category_id: form.category_id || null,
      uom: form.uom,
      purchase_qty: 1,
      rate: parseFloat(parseFloat(form.rate).toFixed(6)),
      purchase_unit: hasPurchaseUnit ? form.purchase_unit.trim().toUpperCase() : null,
      // Always the item's own UOM. `base_unit` is read by NOTHING downstream — the Purchase Bill
      // scales qty × conversion_factor into `uom` — so a base_unit that disagreed with the UOM was
      // always a mistake, and the only screen showing it (this form's own preview) labelled the
      // rate "per {base_unit}" when the rate is per UOM. Storing the derived value keeps the badge
      // and the preview honest and repairs a legacy row on its next save.
      base_unit: hasPurchaseUnit ? form.uom : null,
      conversion_factor: cf,
      yield_pct: yieldNum,
    }

    if (editing) {
      const { error } = await supabase.from('items').update(payload).eq('id', editing)
      if (error) { showSaveError(error); setSaving(false); return false }
    } else {
      const { error } = await scopedInsert('items', { ...payload, item_code: getNextItemCode() })
      if (error) { showSaveError(error); setSaving(false); return false }
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

  // Hide / Show. A bare `await` with nothing destructured discarded the only evidence this failed,
  // and the row then reloaded unchanged — which reads as the item already being in that state.
  // It matters more here than on most rows: hiding is what every delete refusal above offers as
  // the alternative, so a silently-failed Hide leaves the operator with no working option at all.
  async function toggleActive(item) {
    if (togglingId) return
    setTogglingId(item.id)
    setPageError(null)
    const hiding = item.is_active
    const { error } = await supabase.from('items').update({ is_active: !item.is_active }).eq('id', item.id)
    if (error) {
      const { text, detail } = asActionError(error)
      setPageError({ text: `"${item.name}" is still ${hiding ? 'visible' : 'hidden'} — the change was not saved. ${text}`, detail })
    } else {
      await loadItems()
    }
    setTogglingId(null)
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

  const catsWithItems   = useMemo(
    () => categories.filter(c => items.some(i => i.category_id === c.id)),
    [categories, items])
  const showCategoryCol = filterCat === 'all'

  // One memoized pass replaces what used to be a fresh filter here PLUS a full items.filter()
  // inside every category tab's render (O(tabs × items), with the same predicate re-evaluated
  // ~20× per keystroke of the search box). tabCounts is the per-category count of items matching
  // search + usage (category deliberately excluded — each tab shows what it WOULD hold).
  const { filtered, tabCounts } = useMemo(() => {
    const s = search.toLowerCase()
    const tabCounts = { all: 0 }
    const searchMatched = []
    items.forEach(item => {
      const matchSearch = item.name.toLowerCase().includes(s) || (item.item_code || '').toLowerCase().includes(s)
      const usage = usageMap[item.id] || []
      const matchUsage =
        filterUsage === 'all'    ? true :
        filterUsage === 'unused' ? usage.length === 0 :
        filterUsage === 'stock'  ? (usage.includes('OS') || usage.includes('CS')) :
        usage.includes(filterUsage)
      if (!matchSearch || !matchUsage) return
      searchMatched.push(item)
      tabCounts.all += 1
      if (item.category_id) tabCounts[item.category_id] = (tabCounts[item.category_id] || 0) + 1
    })
    const filtered = (filterCat === 'all' ? searchMatched : searchMatched.filter(i => i.category_id === filterCat))
      .sort((a, b) => {
        if (!sortConvFirst) return 0
        const aHas = !!(a.purchase_unit && a.conversion_factor > 1)
        const bHas = !!(b.purchase_unit && b.conversion_factor > 1)
        return bHas - aHas
      })
    return { filtered, tabCounts }
  }, [items, search, usageMap, filterUsage, filterCat, sortConvFirst])

  if (!hasImsAccess('supervisor')) return <Navigate to="/dashboard" replace />

  // .panel-tab is the shared class for exactly this row (it carries the underline, the type, the
  // 40px height, the coarse-pointer target and a focus ring); this file had hand-rolled it.
  // What the printed sheet is actually a list of, in the same words as the controls that narrowed
  // it. Built here rather than inline so the header and the sheet cannot describe different things.
  const usageScopeLabel = { all: null, R: 'used in recipes', P: 'used in purchases', stock: 'in stock counts', unused: 'unused items only' }
  const printScope = [
    filterCat === 'all' ? 'All categories' : (categories.find(c => c.id === filterCat)?.name || 'One category'),
    search.trim() ? `matching "${search.trim()}"` : null,
    usageScopeLabel[filterUsage],
  ].filter(Boolean).join(' · ')

  const tabProps = (tab) => ({
    type: 'button',
    role: 'tab',
    'aria-selected': activeTab === tab,
    className: `panel-tab${activeTab === tab ? ' panel-tab--active' : ''}`,
    onClick: () => setActiveTab(tab),
  })

  return (
    <div>
      {/* Print-only header. The scope line is not decoration: every filter control on this page is
          `no-print`, so a sheet printed while a category tab, a search or a Used In chip was active
          showed a SUBSET of the book under the bare title "Item Master" — a partial list vouched
          for as the whole one. A report that states a scope must state it everywhere it goes. */}
      <div className="print-only" style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Item Master</h2>
        <p style={{ margin: '4px 0 0', fontSize: 12 }}>
          {printScope} — {filtered.length} of {items.length} item{items.length !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="page-header page-header--split no-print">
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
              style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
              onClick={clearAllConversions}
            >
              ✕ Clear All Conversions
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => printWithTitle('Item Master')}>Print</button>
        </div>
      </div>

      {categories.length === 0 && !loading && (
        <div className="card" style={{ marginBottom: 20, borderColor: 'color-mix(in srgb, var(--theme-accent) 30%, transparent)' }}>
          <p style={{ color: 'var(--theme-accent-ink)', fontSize: 13, margin: 0 }}>
            You have no item categories yet, so there is nothing to file a new item under. Click <strong>⚡ Load Default Categories</strong> to add the {DEFAULT_CATEGORIES.length} Crest starts with — {DEFAULT_CATEGORIES.slice(0, -1).join(', ')} and {DEFAULT_CATEGORIES[DEFAULT_CATEGORIES.length - 1]}. Rename them or add your own afterwards.
          </p>
        </div>
      )}

      {/* A refresh that failed over a list already on screen: the rows below are the last good
          read, not the current one, and the page must say so rather than looking freshly loaded. */}
      {loadError && items.length > 0 && (
        <ActionError
          error={{ text: `This list could not be refreshed, so it may be out of date. ${loadError.text}`, detail: loadError.detail }}
          className="action-error--top"
        />
      )}
      {/* Same for the usage scan: with it unanswered, an empty Used In cell means "not checked". */}
      {!loading && !usageScan.ok && items.length > 0 && (
        <ActionError
          error={`Crest could not check where these items are used${usageScan.failed.length ? ` — ${usageScan.failed.join(', ')} could not be read` : ''}, so the Used In column is incomplete and deleting is blocked. Everything else on this page works normally.`}
          className="action-error--top"
        />
      )}
      <ActionError error={pageError} className="action-error--top" />

      {showForm && (
        <Modal onClose={() => setShowForm(false)} title={editing ? 'Edit Item' : 'Add Item'}>
          {/* Tab bar */}
          <div className="panel-tab-bar" role="tablist" aria-label="Item form sections">
            <button {...tabProps('details')}>
              Details
            </button>
            <button {...tabProps('conversion')}>
              Conversion
              {form.purchase_unit && form.conversion_factor
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
                    {...fieldAria('items-f3', fieldErr.yield_pct)}
                  />
                  <FieldError id="items-f3" message={fieldErr.yield_pct} />
                  {!fieldErr.yield_pct && <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Usable % after trim/prep. 100 = no loss</span>}
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
                  <Tip text={`Here to do the division for you, nothing more. Type what you actually bought — "500 ${form.uom} for NPR 388.50" — and the price above fills in. Both boxes take sums as well as plain numbers: "12*4" commits 48. Neither box is saved. To record that this item ALWAYS comes in a pack, set it up on the Conversion tab instead: that is what the Purchase Bill reads to decide whether its Qty column means packs or ${form.uom}.`} width={320}>
                    Bought a pack?
                  </Tip>
                </span>
                <QtyInput id="items-pack-qty"
                  aria-label={`Pack size, in ${form.uom}`}
                  className="form-input"
                  value={pack.qty}
                  onChange={v => setPackField('qty', v)}
                  placeholder="500"
                  style={{ width: 92 }}
                  {...fieldAria('items-pack-qty', packErr)}
                />
                <span style={{ fontSize: 13, color: 'var(--theme-text2)' }}>{form.uom} for NPR</span>
                <QtyInput id="items-pack-total"
                  aria-label="Price paid for that whole pack"
                  className="form-input"
                  value={pack.total}
                  onChange={v => setPackField('total', v)}
                  placeholder="388.50"
                  style={{ width: 112 }}
                  {...fieldAria('items-pack-qty', packErr)}
                />
                {packPerUnit != null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--theme-accent-ink)' }}>
                    → NPR {fmtPerUom(packPerUnit)} per {form.uom}
                  </span>
                )}
                <FieldError id="items-pack-qty" message={packErr} />
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
                {/* Base Unit is the item's own UOM and nothing downstream reads the stored column,
                    so this states the value rather than offering a choice that has one answer. */}
                <div className="form-field">
                  <span className="field-label">Base Unit</span>
                  <div className="form-input" style={{ display: 'flex', alignItems: 'center', color: 'var(--theme-text2)' }}>
                    {form.uom}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>Always the UOM you count in — change it on the Details tab</span>
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
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginTop: 4, display: 'block' }}>{form.uom} per purchase unit</span>
                </div>
              </div>

              {/* Live preview */}
              {conversionPreview(form.purchase_unit, form.uom, form.conversion_factor) && (
                <div style={{
                  marginTop: 16, display: 'inline-flex', alignItems: 'center', gap: 10,
                  background: 'color-mix(in srgb, var(--theme-green) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--theme-green) 25%, transparent)',
                  borderRadius: 'var(--radius-sm)', padding: '10px 18px'
                }}>
                  <span style={{ fontSize: 18 }}>🔄</span>
                  <div>
                    <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--theme-green-text)' }}>
                      {conversionPreview(form.purchase_unit, form.uom, form.conversion_factor)}
                    </p>
                    {form.rate && form.conversion_factor && (
                      <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--theme-text2)' }}>
                        NPR {fmtPerUom(form.rate)} per {form.uom} → NPR {(parseFloat(form.rate) * parseFloat(form.conversion_factor)).toFixed(2)} per {form.purchase_unit?.toUpperCase()}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* Clear conversion */}
              {(form.purchase_unit || form.conversion_factor) && (
                <div style={{ marginTop: 12 }}>
                  <button
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                    onClick={() => setForm(f({ purchase_unit: '', conversion_factor: '' }))}
                  >
                    ✕ Clear Conversion
                  </button>
                </div>
              )}
            </>
          )}

          <ActionError error={error ? { text: error, detail: errorDetail } : null} />
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
          const count = tabCounts[tab.id] || 0
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
                background: active ? 'color-mix(in srgb, var(--theme-accent) 12%, transparent)' : 'color-mix(in srgb, var(--theme-text2) 12%, transparent)',
                color: active ? 'var(--theme-accent-ink)' : 'var(--theme-text2)'
              }}>{count}</span>
            </button>
          )
        })}
      </div>

      <div className="card" style={{ borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
        {loading ? (
          <p style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading…</p>
        ) : loadError && items.length === 0 ? (
          // A failed read is not an empty book, and must never offer "add your first ingredient"
          // to a client who already has hundreds.
          <div role="alert">
            <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--theme-red-text)', margin: '0 0 6px' }}>
              Item Master could not be loaded
            </p>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: '0 0 6px' }}>
              This is a failed read, not an empty list — nothing has been lost. Reload the page, and
              if it keeps happening send the detail below to support.
            </p>
            <p style={{ fontSize: 13, color: 'var(--theme-text2)', margin: 0 }}>{loadError.text}</p>
            {loadError.detail && <p className="action-error-detail">{loadError.detail}</p>}
          </div>
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
                  <th><Tip text="Where this item already has records. An item with any of these can't be deleted — hide it instead, which keeps its history but also leaves it out of stock valuation. R = Recipes, P = Purchases, OS/CS = Stock counts, W = Wastage, SM = Staff Meals, RQ = Requisitions, VR = Vendor Returns, PAR = Par Levels, PO = Purchase Orders, MV = Stock Movements." width={320}>Used In</Tip></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(item => {
                  // `base_unit` is deliberately NOT part of this test and not what the chip prints:
                  // it is derived from the UOM on save and a legacy row may hold something else or
                  // nothing at all, which used to hide the badge on a real conversion.
                  const hasConversion = item.purchase_unit && item.conversion_factor && item.conversion_factor !== 1
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
                            fontSize: 11, background: 'color-mix(in srgb, var(--theme-green) 8%, transparent)',
                            color: 'var(--theme-green-text)', border: '1px solid color-mix(in srgb, var(--theme-green) 25%, transparent)',
                            borderRadius: 'var(--radius-xs)', padding: '2px 7px', whiteSpace: 'nowrap'
                          }}>
                            🔄 1 {item.purchase_unit} = {item.conversion_factor} {item.uom}
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
                          <UsageChip codes={usageMap[item.id]}
                            text={`Has records in: ${usageMap[item.id].map(code => USAGE_LABELS[code] || code).join(', ')}`} />
                        ) : !usageScan.ok ? (
                          // The chip must never be able to mean two things: with the scan
                          // unanswered, a dash would read as "no records" when it means "we could
                          // not check", and this column is what the delete guard is read from.
                          <Tip text="Crest could not read every table this item could appear in, so this is unknown rather than empty. Deleting is blocked until the check succeeds." width={280}>
                            <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>not checked</span>
                          </Tip>
                        ) : (
                          <span style={{ color: 'var(--theme-text3)', fontSize: 12 }}>—</span>
                        )}
                      </td>
                      {/* `display: flex` was on the <td> itself, which takes the cell out of the
                          row's layout — the row's other cells then size against a box that is no
                          longer a table cell. The flex row belongs to a div inside it. */}
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => openEdit(item)}>Edit</button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px' }}
                          onClick={() => toggleActive(item)} disabled={togglingId != null}>
                          {togglingId === item.id ? '…' : item.is_active ? 'Hide' : 'Show'}
                        </button>
                        <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', color: 'var(--theme-red-text)', borderColor: 'color-mix(in srgb, var(--theme-red) 30%, transparent)' }}
                          onClick={() => deleteItem(item)}>Del</button>
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

      <Fab onClick={openNew} label="+ Add Item" show={!showForm} />
      {confirmEl}
    </div>
  )
}
