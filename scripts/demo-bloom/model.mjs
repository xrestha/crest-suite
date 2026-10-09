// Master data for one outlet: categories, vendors, items, recipes (+ sub-recipe mirrors), option
// groups, tables — as rows ready to insert, plus the lookups the simulation needs (recipe
// explosion per plate, option stock lines, plate costs).
import { uid, round4 } from './lib.mjs'
import { ITEMS, SUB_RECIPES, MENU, OPTION_GROUPS, VENDORS, CATEGORIES, TABLES } from './config.mjs'

export function buildMaster(outlet, { hqMaster = null, createdAt }) {
  const o = outlet.key
  const cid = outlet.clientId
  const id = (...k) => uid(o, ...k)
  const masterOf = (...k) => (hqMaster ? uid('ktm', ...k) : null)   // PKR rows point at HQ's twin

  const categories = CATEGORIES.map((name, i) => ({
    id: id('cat', name), client_id: cid, name, sort_order: i + 1, created_at: createdAt, master_id: masterOf('cat', name),
  }))
  const catId = Object.fromEntries(categories.map(c => [c.name, c.id]))

  const vendors = VENDORS[o].map((v, i) => ({
    id: id('vendor', v.key), client_id: cid, name: v.name, contact_person: v.contact, phone: v.phone,
    is_active: true, created_at: createdAt, address: v.address, pan_vat_no: v.pan,
    vendor_code: `VND-${String(i + 1).padStart(3, '0')}`, payment_terms: v.terms,
  }))
  const vendorByKey = Object.fromEntries(VENDORS[o].map(v => [v.key, { ...v, id: id('vendor', v.key) }]))

  const itemByCode = {}
  const items = ITEMS.map(it => {
    const rate = round4(it.rate * outlet.priceUplift * 1e2) / 1e2   // ≤ 6 dp
    const row = {
      id: id('item', it.code), client_id: cid, category_id: catId[it.cat], name: it.name, uom: it.uom,
      purchase_qty: 1, rate, is_active: true, created_at: createdAt,
      purchase_unit: it.pu || null, base_unit: it.pu ? it.uom : null, conversion_factor: it.cf || 1,
      item_code: it.code, yield_pct: it.yield || 100, is_sub_recipe: false, master_id: masterOf('item', it.code),
    }
    itemByCode[it.code] = { ...it, id: row.id, baseRate: rate, yieldPct: it.yield || 100 }
    return row
  })

  // Sub-recipes, then their mirror items (Recipes.js: name UPPER, uom = yield_uom, code = recipe_code).
  const recipes = []
  const recipeIngredients = []
  const subByCode = {}
  for (const sr of SUB_RECIPES) {
    const rid = id('recipe', sr.code)
    subByCode[sr.code] = { ...sr, id: rid }
    recipes.push({
      id: rid, client_id: cid, name: sr.name, category: 'Sub-Recipe', selling_price: null, vat_rate: 0.13,
      is_active: true, created_at: createdAt, yield_qty: sr.yieldQty, yield_uom: sr.yieldUom, target_fc_pct: 30,
      recipe_code: sr.code, pos_enabled: false, master_id: masterOf('recipe', sr.code), is_build_your_own: false,
    })
    sr.lines.forEach(([code, qty]) => recipeIngredients.push({
      id: id('ri', sr.code, code), recipe_id: rid, item_id: itemByCode[code].id, qty_per_portion: qty, created_at: createdAt,
    }))
  }

  // Raw items per ONE unit of output, walking sub-recipes exactly like recipeCost.walkRecipeTree.
  const explode = (lines, scale = 1) => {
    const agg = {}
    for (const [code, qty0] of lines) {
      const qty = qty0 * scale
      if (code.startsWith('SRC-')) {
        const sr = subByCode[code]
        const sub = explode(sr.lines, qty / sr.yieldQty)
        for (const [k, v] of Object.entries(sub)) agg[k] = (agg[k] || 0) + v
      } else {
        const it = itemByCode[code]
        agg[code] = (agg[code] || 0) + qty / (it.yieldPct / 100)
      }
    }
    return agg
  }
  const costOf = usage => Object.entries(usage).reduce((s, [code, q]) => s + q * itemByCode[code].baseRate, 0)

  // Mirror items for the sub-recipes, priced at the live batch cost ÷ yield.
  for (const sr of SUB_RECIPES) {
    const perUnit = costOf(explode(sr.lines)) / sr.yieldQty
    const mirrorId = id('mirror', sr.code)
    items.push({
      id: mirrorId, client_id: cid, category_id: null, name: sr.name.toUpperCase(), uom: sr.yieldUom,
      purchase_qty: 1, rate: round4(perUnit), is_active: true, created_at: createdAt, item_code: sr.code,
      yield_pct: 100, is_sub_recipe: true, conversion_factor: 1, master_id: masterOf('mirror', sr.code),
    })
    subByCode[sr.code].mirrorId = mirrorId
  }

  const dishByCode = {}
  for (const d of MENU) {
    const rid = id('recipe', d.code)
    const usage = explode(d.lines)
    const cost = costOf(usage)
    dishByCode[d.code] = { ...d, id: rid, usage, cost }
    recipes.push({
      id: rid, client_id: cid, name: d.name, category: d.cat, selling_price: d.price, vat_rate: 0.13,
      is_active: true, created_at: createdAt, yield_qty: 1, yield_uom: 'portion', target_fc_pct: d.cat === 'Food' ? 32 : 25,
      recipe_code: d.code, pos_enabled: true, hsc_code: d.hsc, cost_price: Math.round(cost * 100) / 100,
      description: d.desc, is_veg: d.veg, master_id: masterOf('recipe', d.code), is_build_your_own: false,
    })
    d.lines.forEach(([code, qty]) => recipeIngredients.push(code.startsWith('SRC-')
      ? { id: id('ri', d.code, code), recipe_id: rid, item_id: null, sub_recipe_id: subByCode[code].id, qty_per_portion: qty, created_at: createdAt }
      : { id: id('ri', d.code, code), recipe_id: rid, item_id: itemByCode[code].id, qty_per_portion: qty, created_at: createdAt }))
  }

  // Option groups (Crest Customization).
  const optionGroups = [], options = [], optionIngredients = [], recipeOptionGroups = []
  const optionById = {}
  for (const g of OPTION_GROUPS) {
    const gid = id('optgroup', g.key)
    optionGroups.push({
      id: gid, client_id: cid, name: g.name, kitchen_name: g.kitchen, kind: g.kind, min_select: g.min, max_select: g.max,
      included_count: 0, sort: g.sort, is_active: true, created_at: createdAt, size_scaling: 'none',
    })
    for (const op of g.options) {
      const oid = id('option', g.key, op.key)
      options.push({
        id: oid, client_id: cid, group_id: gid, name: op.name, kitchen_name: op.name, price_delta: op.delta,
        is_removal: false, is_default: !!op.isDefault, diet: 'veg', allergens: op.key === 'oat' ? [] : (op.key === 'lrg' && g.key === 'size_milk' ? ['milk'] : []),
        sort: op.sort, is_active: true, created_at: createdAt,
      })
      const deltas = op.lines.map(([code, qty]) => ({ item_id: itemByCode[code].id, qty }))
      op.lines.forEach(([code, qty]) => optionIngredients.push({
        id: id('optingr', g.key, op.key, code), client_id: cid, option_id: oid, item_id: itemByCode[code].id, qty_per_portion: qty, created_at: createdAt,
      }))
      // Usage per plate in item CODES (yield applied, like deltaItems).
      const usage = {}
      op.lines.forEach(([code, qty]) => { usage[code] = (usage[code] || 0) + qty / (itemByCode[code].yieldPct / 100) })
      optionById[oid] = { id: oid, groupId: gid, groupKey: g.key, groupName: g.name, groupKind: g.kind, groupSort: g.sort,
        key: op.key, name: op.name, kitchen: op.name, delta: op.delta, sort: op.sort, deltas, usage }
    }
  }
  for (const d of MENU) {
    const groups = []
    if (d.sizes === 'black') groups.push(['size_black', 1])
    if (d.sizes === 'milk') groups.push(['size_milk', 1])
    if (d.addons) groups.push(['addons', 2])
    for (const [gk, sort] of groups) {
      recipeOptionGroups.push({
        id: id('rog', d.code, gk), client_id: cid, recipe_id: dishByCode[d.code].id, group_id: id('optgroup', gk),
        default_option_id: gk.startsWith('size') ? id('option', gk, 'reg') : null, sort, created_at: createdAt,
      })
    }
    dishByCode[d.code].groups = groups.map(([gk, sort]) => ({ key: gk, id: id('optgroup', gk), sort }))
  }

  const tables = TABLES[o].map((t, i) => ({
    id: id('table', t.name), client_id: cid, name: t.name, section: t.section, capacity: t.capacity,
    status: 'available', sort_order: i + 1, created_at: createdAt,
  }))

  return {
    categories, catId, vendors, vendorByKey, items, itemByCode, recipes, recipeIngredients, subByCode,
    dishByCode, optionGroups, options, optionIngredients, recipeOptionGroups, optionById, tables, explode, costOf,
  }
}
