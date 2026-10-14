// The Combos setup screen's pure half (S839, docs/pos-combos.md): what the editor holds, how it is
// checked before a save, and the exact `p_combo` it sends to save_pos_combo. No React, no Supabase,
// so comboEditor.test.js can pin the payload the server receives.
//
// Editor state:
//   { id, name, price, description, is_active, on_guest_menu, sort,
//     picks: [{ key, id, name, items: [{ key, recipe_id, extra, is_default }] }] }
// `price` and `extra` are the strings in their boxes. A pick's `key` is its id once saved and a
// local "new-N" before, so the price split can be previewed for a pick the database has not seen;
// `id` is sent back for a saved pick so it keeps its id (the till's and the reports' combo_group_id).

let seq = 0
export const newKey = () => `new-${++seq}`

const round2 = n => Math.round((Number(n) || 0) * 100) / 100
const norm = s => String(s || '').trim().toLowerCase()

/** A Sub-Recipe is an ingredient, never a dish; an inactive recipe is not on the menu. */
export function isComboDish(recipe) {
  return !!recipe && recipe.is_active !== false && recipe.category !== 'Sub-Recipe'
}

/** A blank combo for "+ New combo". */
export function emptyCombo(nextSort = 0) {
  return { id: null, name: '', price: '', description: '', is_active: true, on_guest_menu: true, sort: nextSort, picks: [] }
}

/** A blank pick, appended by "+ Add a pick". */
export function emptyPick() {
  return { key: newKey(), id: null, name: '', items: [] }
}

/** A dish row inside a pick. */
export function newPickItem(recipeId) {
  return { key: newKey(), recipe_id: recipeId, extra: '', is_default: false }
}

/**
 * The saved rows as one list of combos, each with its picks and their dishes, all in display order:
 * { ...combo, groups: [{ ...group, items: [...] }] }.
 */
export function assembleCombos(combos, groups, items) {
  const bySortName = (a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0)
    || String(a.name || '').localeCompare(String(b.name || ''))
    || String(a.id).localeCompare(String(b.id))
  const itemsByGroup = {}
  ;(items || []).forEach(it => { (itemsByGroup[it.group_id] = itemsByGroup[it.group_id] || []).push(it) })
  const groupsByCombo = {}
  ;(groups || []).forEach(g => { (groupsByCombo[g.combo_id] = groupsByCombo[g.combo_id] || []).push(g) })
  return [...(combos || [])].sort(bySortName).map(c => ({
    ...c,
    groups: (groupsByCombo[c.id] || []).slice().sort(bySortName).map(g => ({
      ...g,
      items: (itemsByGroup[g.id] || []).slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.id).localeCompare(String(b.id))),
    })),
  }))
}

/** "Pick a momo (3) · Pick a drink (2)" — each pick with how many dishes it offers. */
export function pickSummary(groups) {
  return (groups || []).map(g => `${g.name} (${(g.items || []).length})`).join(' · ')
}

/** Every pick lists exactly one dish: the till adds it in one tap, nothing is asked. */
export function isSetMeal(groups) {
  return (groups || []).length > 0 && groups.every(g => (g.items || []).length === 1)
}

/** Editor state for a saved combo (from assembleCombos). */
export function editorFromCombo(combo) {
  return {
    id: combo.id,
    name: combo.name || '',
    price: combo.guest_price == null ? '' : String(Number(combo.guest_price)),
    description: combo.description || '',
    is_active: combo.is_active !== false,
    on_guest_menu: combo.on_guest_menu !== false,
    sort: Number(combo.sort) || 0,
    picks: (combo.groups || []).map(g => ({
      key: g.id,
      id: g.id,
      name: g.name || '',
      items: (g.items || []).map(it => ({
        key: it.id || newKey(),
        recipe_id: it.recipe_id,
        extra: Number(it.extra_price) ? String(Number(it.extra_price)) : '',
        is_default: !!it.is_default,
      })),
    })),
  }
}

/**
 * A new combo started from Combo Builder: one pick per dish, named after the dish's category (or the
 * dish when it has none, or when another pick already took that name), at the suggested price, and
 * called after its dishes ("Veg Momo + Coke") so it can be saved as it stands. Dishes that are not on
 * the menu any more are left out.
 */
export function prefillFromDishes(dishIds, price, recipeById, nextSort = 0) {
  const state = emptyCombo(nextSort)
  const p = Number(price)
  state.price = p > 0 ? String(round2(p)) : ''
  const get = id => (recipeById.get ? recipeById.get(id) : recipeById[id])
  const taken = new Set()
  const seen = new Set()
  ;(dishIds || []).forEach(id => {
    const r = get(id)
    if (!isComboDish(r) || seen.has(id)) return
    seen.add(id)
    let name = (r.category || '').trim() || r.name
    if (taken.has(norm(name))) name = r.name
    let n = 2
    const base = name
    while (taken.has(norm(name))) name = `${base} ${n++}`
    taken.add(norm(name))
    state.picks.push({ ...emptyPick(), name, items: [newPickItem(id)] })
  })
  state.name = state.picks.map(p => get(p.items[0].recipe_id).name).join(' + ')
  return state
}

/** Moves list[idx] by dir (−1 up, +1 down); the same list when the move would leave it. */
export function moveItem(list, idx, dir) {
  const to = idx + dir
  if (idx < 0 || idx >= list.length || to < 0 || to >= list.length) return list
  const next = list.slice()
  ;[next[idx], next[to]] = [next[to], next[idx]]
  return next
}

/** Makes one dish the pick's default, or none (`itemKey` null); never two. */
export function setDefault(pick, itemKey) {
  return { ...pick, items: pick.items.map(it => ({ ...it, is_default: itemKey != null && it.key === itemKey })) }
}

/**
 * Replaces a pick's dishes with `ids`, keeping the extra charge and default of a dish that stays and
 * its place in the list; new dishes go to the end in the order given.
 */
export function setPickDishes(pick, ids) {
  const want = new Set(ids)
  const kept = pick.items.filter(it => want.has(it.recipe_id))
  const have = new Set(kept.map(it => it.recipe_id))
  const added = ids.filter(id => !have.has(id)).map(newPickItem)
  return { ...pick, items: [...kept, ...added] }
}

const parseMoney = raw => {
  if (raw === '' || raw == null) return null
  const n = Number(String(raw).replace(/,/g, '').trim())
  return Number.isFinite(n) ? n : NaN
}

/**
 * Everything save_pos_combo would refuse that the screen can say first, in the box it is about.
 * @param {object} state         the editor state
 * @param {object} ctx
 * @param {(id) => object} ctx.recipeOf       a recipe row by id (any recipe, active or not)
 * @param {string[]} [ctx.otherNames]         the names of the client's OTHER combos
 * @returns {{ ok: boolean, name?, price?, picks?, pickName: {}, pickDishes: {}, extra: {} }}
 */
export function validateCombo(state, { recipeOf = () => null, otherNames = [] } = {}) {
  const e = { pickName: {}, pickDishes: {}, extra: {} }
  const name = (state.name || '').trim()
  if (!name) e.name = 'Give the combo a name — guests and the bill see it, e.g. “Momo Combo”.'
  else if (otherNames.some(n => norm(n) === norm(name))) e.name = `There is already a combo called “${name}”. Give this one its own name.`

  const price = parseMoney(state.price)
  if (price == null) e.price = 'Type what the guest pays for the whole combo.'
  else if (!(price > 0)) e.price = 'The combo price must be more than 0.'

  if (!state.picks.length) e.picks = 'Add at least one pick — for example “Pick a momo”, then the dishes a guest can choose from.'

  const seenNames = new Set()
  state.picks.forEach((p, i) => {
    const pn = (p.name || '').trim()
    if (!pn) e.pickName[p.key] = `Name pick ${i + 1} — guests see it, e.g. “Pick a drink”.`
    else if (seenNames.has(norm(pn))) e.pickName[p.key] = `Another pick is already called “${pn}”. Give each pick its own name.`
    if (pn) seenNames.add(norm(pn))

    const label = pn ? `“${pn}”` : `pick ${i + 1}`
    if (!p.items.length) e.pickDishes[p.key] = `Add at least one dish to ${label}.`
    else {
      const gone = p.items.filter(it => !isComboDish(recipeOf(it.recipe_id)))
      if (gone.length) {
        const names = gone.map(it => recipeOf(it.recipe_id)?.name).filter(Boolean)
        e.pickDishes[p.key] = `${names.length ? names.map(n => `“${n}”`).join(', ') : 'A dish'} ${gone.length === 1 ? 'is' : 'are'} no longer an active dish. Take ${gone.length === 1 ? 'it' : 'them'} out of ${label}.`
      } else if (p.items.filter(it => it.is_default).length > 1) {
        e.pickDishes[p.key] = `Only one dish can be the default in ${label}.`
      }
    }
    p.items.forEach(it => {
      const x = parseMoney(it.extra)
      if (x != null && !(x >= 0)) e.extra[it.key] = 'An extra charge is 0 or more.'
    })
  })

  const ok = !e.name && !e.price && !e.picks
    && !Object.keys(e.pickName).length && !Object.keys(e.pickDishes).length && !Object.keys(e.extra).length
  return { ...e, ok }
}

/**
 * The `p_combo` save_pos_combo takes (docs/pos-combos.md), from a VALID editor state. `client_id` is
 * always sent: an admin viewing a client has no active outlet of their own, and the server needs it
 * for a new combo. A saved pick sends its id so it stays the same pick; a new one sends none.
 */
export function comboPayload(state, clientId) {
  const p_combo = {
    client_id: clientId,
    name: state.name.trim(),
    guest_price: round2(parseMoney(state.price)),
    description: (state.description || '').trim() || null,
    is_active: !!state.is_active,
    on_guest_menu: !!state.on_guest_menu,
    sort: Number(state.sort) || 0,
    groups: state.picks.map((p, i) => ({
      ...(p.id ? { id: p.id } : {}),
      name: p.name.trim(),
      sort: i,
      items: p.items.map((it, j) => ({
        recipe_id: it.recipe_id,
        extra_price: round2(parseMoney(it.extra) || 0),
        is_default: !!it.is_default,
        sort: j,
      })),
    })),
  }
  if (state.id) p_combo.id = state.id
  return p_combo
}

/** The editor state in the shape comboShares() reads, so the split can be previewed before a save. */
export function comboForShares(state) {
  const price = parseMoney(state.price)
  return {
    guest_price: price > 0 ? price : 0,
    groups: state.picks.map((p, i) => ({ id: p.key, sort: i, items: p.items.map(it => ({ recipe_id: it.recipe_id })) })),
  }
}

/** Two editor states that would save the same combo (the Modal's "typed in" guard). */
export function sameEditorState(a, b) {
  const strip = s => ({ ...s, picks: s.picks.map(p => ({ id: p.id, name: p.name, items: p.items.map(({ key, ...rest }) => rest) })) })
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}
