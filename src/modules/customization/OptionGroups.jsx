import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useConfirm } from '../../shared/hooks/useConfirm'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'
import { npr } from '../../shared/nepalMoney'
import Tip from '../../components/Tip'
import Fab from '../../components/Fab'
import Tabs, { TabPanel } from '../../components/Tabs'
import RowMenu from '../../components/RowMenu'
import ReportLoadError from '../../components/ReportLoadError'
import ActionError from '../../components/ActionError'
import { withTimeout, settleWithin } from '../../utils/withTimeout'
import {
  loadOptionCatalog, KIND_LABEL, DIET_LABEL, CUSTOMIZATION_READ_MS, CUSTOMIZATION_WRITE_MS, PAGE_CHECK, writeFailure,
} from './customizationData'
import { STANDARD_VAT, inclFromEx, ruleText, signedPrice, groupShortfalls, dishesBelowZero, belowZeroAmount } from '../../shared/optionPricing'
import { andList } from '../../shared/offeredPicks'
import { fullPriceBase, optionLossText as lossTextOf, stillHiddenText, stillShownText, notDeletedText, hideBelowZero } from './optionChecks'
import { vatModeOf, VAT_MODE_UNKNOWN_TEXT } from '../ims/recipes/menuPriceVat'
import OptionGroupModal from './OptionGroupModal'
import OptionModal from './OptionModal'
import { allergenLabel } from '../../shared/constants/allergens'
import AttachGroupsModal from './AttachGroupsModal'
import AttachToDishesModal from './AttachToDishesModal'
import BuildYourOwnTemplateModal from './BuildYourOwnTemplateModal'

// Crest Customization (S758) — Option Groups.
//
// The dish itself is still made where it always was (Recipe Costing, or Menu Pricing for a
// POS-only client). This page builds the shared groups ("Size", "Extras", "Spice") and attaches
// them to dishes; a dish with no group attached behaves exactly as before on the till and the guest
// menu.
//
// Who: admin, the Owner, a POS manager or an IMS manager — the database's
// caller_can_set_menu_price(), mirrored here on the RAW pos_role / ims_role columns for the same
// reason MenuPricing.js does (hasPosAccess would also require the module to be on, which the
// database does not). A POS supervisor or waiter is sent to the dashboard by URL as well as by nav.
//
// S759 (critique): ORDER is a fact the owner can set. Options move within a group and groups move
// on the page with ↑↓ (a swap of two `sort` values), because "first N free" is decided by list
// order and the guest sees options in it. Each row shows ONE next step and keeps the rest under ⋯;
// a group can be put on many dishes at once from its own card; and the page says "now attach it"
// the moment a group has an option and no dish, because that is the step that went unnoticed.
//
// S760: build-your-own dishes. The Groups tab offers a template that builds Size / Base / Sauces /
// Toppings for one dish in one transaction; the Dishes tab marks a dish build-your-own (or clears
// it), badges it, and warns when a marked dish offers nothing to build. The mark is read from the
// catalog loader, which tolerates a database the S760 migration has not reached.
//
// S867 (critique): the words on screen follow the owner's list. What a guest taps is a CHOICE, a set
// of them is a CHOICE GROUP (this page is Choice Groups), and the kind stored as 'choice' reads
// Preference. Code names, tables and the stored kind stay as they were. Each card's one accent is its
// next step (nextStepOf), and a Size group's next step is its dishes BEFORE its sizes: a size's price
// box asks for the full menu price only once the group is on a dish, so an owner who added sizes
// first and typed "Full 250" stored +250.

const vatOf = r => (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : Number(r.vat_rate)

// A row write from this page, with its time limit (S852). A timeout answers as the call's own
// `error`, and the message built from it says to reload and look, never that nothing changed.
const bounded = (q, label) => settleWithin(q, CUSTOMIZATION_WRITE_MS, label)
const pageFailure = error => writeFailure(error, PAGE_CHECK)

const TABS = [['groups', 'Groups'], ['dishes', 'Dishes']]

const NO_DISH_YET = 'Make a dish first in Recipe Costing (or Menu Pricing on a POS-only plan)'

// S863: a priced choice with no stock lines is the one likely to be missing them ("Extra cheese"
// adds NPR 50 and takes no cheese off stock). A free choice (spice, a "No …") and a size that
// scales the portion are fine without, so they are not flagged.
const missingIngredients = (g, o) => !o.is_removal && Math.abs(Number(o.price_delta) || 0) >= 0.005
  && !(g.kind === 'size' && o.portion_factor != null)

// The data attribute an arrow carries, so focus can find it again after the list reloads.
const moveKey = (table, id, dir) => `${table}:${id}:${dir}`

// S867: the one step a group is waiting on, worn as its card's only primary button: 'attach' (Put
// it on dishes), 'option' (+ Choice) or null when it has both. A Size group goes on its dishes
// first, so each size it is given is priced as the full menu price; every other kind gets its
// choices first, since a group with nothing in it offers a dish nothing. With no dish on the
// client at all, 'attach' still points at the button, whose press says to make a dish first.
function nextStepOf(g, onDishes) {
  const hasChoices = (g.options || []).length > 0
  if (g.kind === 'size') return !onDishes ? 'attach' : !hasChoices ? 'option' : null
  return !hasChoices ? 'option' : !onDishes ? 'attach' : null
}

// S869: what a confirmed write did, put on the catalog on screen without waiting for a re-read.
// A move: the rows it renumbered (`ids`, in their new order) take the slots those rows held, each
// with its position as its sort, which is what writeMove wrote. A row gone from the list since the
// press (another device) leaves the list as it is, for the re-read to settle.
export function withMove(list, ids) {
  const byId = new Map(list.map(r => [r.id, r]))
  if (!ids.every(id => byId.has(id))) return list
  const moved = new Set(ids)
  let k = 0
  return list.map(r => {
    if (!moved.has(r.id)) return r
    const sort = k++
    return { ...byId.get(ids[sort]), sort }
  })
}
export const withActive = (list, id, isActive) => list.map(r => (r.id === id ? { ...r, is_active: isActive } : r))

// S867: a ticket name that only repeats the choice ("Ticket: Regular" under "Regular") says nothing.
const sameName = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()

export default function OptionGroups() {
  const { isAdmin, isOwner, profile, clientId, clientModules } = useAuth()
  const settingsCtx = useSettings()
  const { scopedFrom, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask, confirmEl } = useConfirm()

  const imsOn = !!clientModules?.ims
  // S809 2h (CUSTOMIZATION-1): the outlet's VAT basis is vatModeOf's, as on Menu Pricing (S792 D31).
  // It was `!!settings?.is_vat_registered`, which read a settings row still loading, a failed read
  // and another client's row all as "no VAT": an option price typed then (or an option merely renamed,
  // since every save rewrites the price) was stored without VAT taken off, and a VAT outlet charged
  // 13% over what was typed. Now an unknown mode saves no option (OptionModal) and the page says so;
  // the figures on screen read it as VAT, as the till does.
  const vatMode = vatModeOf(settingsCtx, clientId)
  const vatReg = vatMode !== 'pan'
  const entryVat = vatReg ? STANDARD_VAT : 0
  // S867: the settings row on hand is THIS client's, read to an end. `loading` covers only the first
  // load, so on a client switch it was already false while the previous client's row was still on
  // screen, and "cannot be saved" flashed until the new row landed. The provider sets
  // `settingsClientId` with the row (or the failure) of the load that won, so with it matching, an
  // unknown mode is a real failed read and not one still on its way.
  const settingsSettled = !!clientId && !settingsCtx.loading && settingsCtx.settingsClientId === clientId

  const [tab, setTab] = useState('groups')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [catalog, setCatalog] = useState({ groups: [], options: [], attachments: [], ingredients: [] })
  const [dishes, setDishes] = useState([])
  const [itemChoices, setItemChoices] = useState([])
  const [pageError, setPageError] = useState(null)
  // { text, action?: { label, run } } — stays until the next action replaces it or the tab changes,
  // rather than vanishing on a timer nobody can recall.
  const [notice, setNotice] = useState(null)
  const [search, setSearch] = useState('')
  // The move in flight: { table, id, dir, via: 'arrow' | 'menu', from }. The control pressed stays
  // enabled and wears aria-busy (DESIGN.md, Buttons), so keyboard focus is not dropped to the page;
  // `movingRef` is the second-press guard, a ref so two quick taps cannot both read it as idle.
  const [moving, setMoving] = useState(null)
  const movingRef = useRef(null)
  const focusAfterMove = useRef(null)
  const pageErrorRef = useRef(null)

  const [groupModal, setGroupModal] = useState(null)   // { group? }
  const [optionModal, setOptionModal] = useState(null) // { groupId, optionId?, error? }
  const [attachFor, setAttachFor] = useState(null)     // dish
  const [attachGroup, setAttachGroup] = useState(null) // group → dishes
  const [templateOpen, setTemplateOpen] = useState(false)
  const [markBusy, setMarkBusy] = useState(null)       // dish id being marked / cleared

  // An admin switching client mid-load must not let the previous tenant's catalog land.
  const loadSeq = useRef(0)

  // `recheck` (S869): the quiet re-read behind a change already on screen. The change was confirmed
  // by the write's own answer, so a failed or hung re-read keeps what is shown instead of replacing
  // the page with the load error; the next action or visit reads again.
  const load = useCallback(async ({ quiet = false, recheck = false } = {}) => {
    if (!clientId) return
    const seq = ++loadSeq.current
    if (!quiet) setLoading(true)
    if (!recheck) setLoadError(null)
    let results
    try {
      results = await withTimeout(Promise.all([
        loadOptionCatalog(scopedFrom, { withIngredients: imsOn }),
        // Every recipe. A NULL category is a dish (S714's .or form), and a sub-recipe is only
        // offered as an option ingredient, never as something to customize. S862 SETUP-7: hidden
        // recipes and items are read too, and filtered below (dishes stay active-only), so a stock
        // line on a hidden item or sub-recipe shows what it takes off stock instead of a blank box.
        fetchAllRows(() => scopedFrom('recipes', 'id, name, category, selling_price, vat_rate, pos_enabled, yield_uom, is_active')
          .order('name').order('id')),
        imsOn
          ? fetchAllRows(() => scopedFrom('items', 'id, name, uom, is_active').eq('is_sub_recipe', false)
            .order('name').order('id'))
          : Promise.resolve({ data: [], error: null }),
      ]), CUSTOMIZATION_READ_MS, 'Loading choice groups')
    } catch (err) {
      // A hang used to leave Loading… on screen for good, with nothing to press (S852).
      if (seq !== loadSeq.current) return
      if (recheck) { console.error('Choice Groups: the re-check after a change did not answer', err); return }
      setLoadError(err)
      setLoading(false)
      return
    }
    if (seq !== loadSeq.current) return
    const [cat, ...rest] = results
    const failed = cat.error || firstError(rest)
    if (failed && recheck) { console.error('Choice Groups: the re-check after a change failed', failed); return }
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: recipes }, { data: items }] = rest
    const all = recipes || []
    const shown = r => r.is_active !== false
    setCatalog(cat)
    setDishes(all.filter(r => r.category !== 'Sub-Recipe' && shown(r)).map(r => ({
      ...r,
      inclPrice: (Number(r.selling_price) || 0) * (1 + (vatReg ? vatOf(r) : 0)),
    })))
    // `hidden` ones are offered only on a line that already holds them (OptionModal).
    setItemChoices([
      ...(items || []).map(i => ({
        value: `item:${i.id}`, label: `${i.name} (${i.uom})${shown(i) ? '' : ' — hidden in Item Master'}`, unit: i.uom, hidden: !shown(i),
      })),
      ...all.filter(r => r.category === 'Sub-Recipe').map(r => ({
        value: `sub:${r.id}`,
        label: `Sub-recipe: ${r.name}${r.yield_uom ? ` (${r.yield_uom})` : ''}${shown(r) ? '' : ' — hidden in Recipe Costing'}`,
        unit: r.yield_uom || '',
        hidden: !shown(r),
      })),
    ])
    setLoading(false)
  }, [clientId, scopedFrom, imsOn, vatReg])

  useEffect(() => { load() }, [load])

  // After a move lands and the list has reloaded (S863): focus the moved row's same arrow, or its
  // other one when the row reached an end and that arrow turned disabled. A move from the group ⋯
  // menu goes back to that menu's trigger. Skipped when the reader has gone somewhere else meanwhile.
  useEffect(() => {
    const t = focusAfterMove.current
    if (!t || moving) return
    focusAfterMove.current = null
    const active = document.activeElement
    if (active && active !== document.body && active !== t.from && document.body.contains(active)) return
    if (t.via === 'menu') {
      document.querySelector(`[data-group-actions="${t.id}"] [aria-haspopup="menu"]`)?.focus()
      return
    }
    const arrow = dir => document.querySelector(`[data-move="${moveKey(t.table, t.id, dir)}"]`)
    const same = arrow(t.dir)
    ;(same && !same.disabled ? same : arrow(-t.dir))?.focus()
  }, [moving, catalog])

  // ── Derived, once per catalog change ──
  const { groupRows, attachCountByGroup, groupsByDish, dishById } = useMemo(() => {
    const optsByGroup = {}
    catalog.options.forEach(o => { (optsByGroup[o.group_id] = optsByGroup[o.group_id] || []).push(o) })
    const ingByOption = {}
    catalog.ingredients.forEach(i => { (ingByOption[i.option_id] = ingByOption[i.option_id] || []).push(i) })
    const countByGroup = {}
    const byDish = {}
    catalog.attachments.forEach(a => {
      countByGroup[a.group_id] = (countByGroup[a.group_id] || 0) + 1
      ;(byDish[a.recipe_id] = byDish[a.recipe_id] || []).push(a)
    })
    return {
      groupRows: catalog.groups.map(g => ({
        ...g,
        options: (optsByGroup[g.id] || []).map(o => ({ ...o, ingredients: ingByOption[o.id] || [] })),
      })),
      attachCountByGroup: countByGroup,
      groupsByDish: byDish,
      dishById: new Map(dishes.map(d => [d.id, d])),
    }
  }, [catalog, dishes])

  const groupNameById = useMemo(() => new Map(catalog.groups.map(g => [g.id, g.name])), [catalog.groups])

  const filteredDishes = useMemo(() => {
    const q = search.trim().toLowerCase()
    return q ? dishes.filter(d => d.name.toLowerCase().includes(q) || (d.category || '').toLowerCase().includes(q)) : dishes
  }, [dishes, search])

  const customizableCount = useMemo(() => dishes.filter(d => (groupsByDish[d.id] || []).length > 0).length, [dishes, groupsByDish])

  // ── Guard, after every hook ──
  const canEdit = isAdmin || isOwner || profile?.pos_role === 'manager' || profile?.ims_role === 'manager'
  if (!canEdit) return <Navigate to="/dashboard" replace />

  const heading = (
    <div>
      <h1 className="page-title">Choice Groups</h1>
      <p className="page-subtitle">
        Build the choices guests can make — sizes, add-ons, “No …” requests and spice — then put each group on the dishes that offer it.
      </p>
    </div>
  )

  // S867: the Crest admin view with no client picked. `load` has nothing to read then, so the page
  // sat on Loading… for good under "Crest Customization is off for this client". This return
  // renders no dialog and no banner; everything else lives in the one below.
  if (!clientId) {
    return (
      <div className="page-container">
        <div className="page-header">{heading}</div>
        <div className="empty-state">No client selected. Pick a client in the top-left switcher to see its choice groups.</div>
      </div>
    )
  }

  const flash = (text, action = null) => setNotice({ text, action })
  const switchTab = k => { setTab(k); setNotice(null); setPageError(null) }
  // A precondition press (S863): the button stays pressable and says what is missing, because a
  // disabled button cannot be focused and its title never shows on a tablet.
  const explain = text => {
    setNotice(null)
    setPageError(text)
    requestAnimationFrame(() => pageErrorRef.current?.scrollIntoView?.({ block: 'nearest' }))
  }

  function dishesForGroup(groupId) {
    return catalog.attachments.filter(a => a.group_id === groupId).map(a => dishById.get(a.recipe_id)).filter(Boolean)
  }

  // ── Order ──
  // A move is a swap of two rows' `sort`. Rows the loader ordered by (sort, name, id) can share a
  // sort value (every row created before ordering existed is 0), so the swap writes the rows'
  // POSITIONS as their new sorts rather than exchanging two equal numbers and moving nothing.
  async function swapSort(table, rows, idx, dir) {
    const other = idx + dir
    const a = rows[idx], b = rows[other]
    const res = await bounded(Promise.all([
      scopedUpdate(table, { sort: other }).eq('id', a.id).select('id'),
      scopedUpdate(table, { sort: idx }).eq('id', b.id).select('id'),
    ]), 'Moving the row')
    if (res.error) { setPageError(pageFailure(res.error)); return false }
    const [r1, r2] = res
    const err = r1.error || r2.error
    if (err) { setPageError(pageFailure(err)); return false }
    if (!r1.data?.length || !r2.data?.length) { setPageError('One of those rows no longer exists — reload the page.'); return false }
    return true
  }
  // Renumber first when two neighbours share a sort, otherwise the swap above is a no-op.
  async function writeMove(table, rows, idx, dir) {
    const dense = rows.every((r, i) => (r.sort || 0) === i)
    if (dense) return swapSort(table, rows, idx, dir)
    const results = await bounded(Promise.all(rows.map((r, i) => scopedUpdate(table, { sort: i }).eq('id', r.id).select('id'))), 'Moving the row')
    const err = results.error || results.find(r => r.error)?.error
    if (err) { setPageError(pageFailure(err)); return false }
    return swapSort(table, rows.map((r, i) => ({ ...r, sort: i })), idx, dir)
  }
  // S863: the arrows must never go live on the OLD order: clearing them while the list still showed
  // it let a quick second press write sort values worked out from rows that had already moved. They
  // waited for a whole reload for that. S869 (owner decision): the new order goes on screen as soon
  // as both writes answer, since it is exactly what they wrote (withMove), so the arrows unlock on
  // the order the server now holds, one wait sooner; the re-read follows in the background.
  async function moveRow(table, rows, idx, dir, via = 'arrow') {
    const other = idx + dir
    if (movingRef.current || other < 0 || other >= rows.length) return
    const target = { table, id: rows[idx].id, dir, via, from: document.activeElement }
    movingRef.current = target
    setMoving(target)
    setPageError(null)
    const ids = rows.map(r => r.id)
    ;[ids[idx], ids[other]] = [ids[other], ids[idx]]
    try {
      if (await writeMove(table, rows, idx, dir)) {
        const key = table === 'pos_option_groups' ? 'groups' : 'options'
        setCatalog(c => ({ ...c, [key]: withMove(c[key], ids) }))
        load({ quiet: true, recheck: true })
      }
    } finally {
      movingRef.current = null
      focusAfterMove.current = target
      setMoving(null)
    }
  }
  const isMoving = (table, id, dir, via = 'arrow') =>
    !!moving && moving.table === table && moving.id === id && moving.dir === dir && moving.via === via

  // S835 (D17): showing a hidden group or option again puts its choices back on every dish it is
  // on, so it is checked like an edit: refused when it would let one of those dishes be ordered
  // below zero. Until S835 neither "Show again" ran any check, so a choice hidden for a bad price
  // came straight back with it and the till refused the dish by name mid-service.
  function showAgainRefusal(name, groupId, after) {
    const found = dishesBelowZero(dishesForGroup(groupId), after, { before: catalog })
    return found.length ? stillHiddenText(name, found) : null
  }
  // S862 SETUP-3: hiding is checked the same way. A hidden group or choice can be the paid pick a
  // cheaper size was leaning on, so hiding it can let the dish be ordered below zero too.
  // A delete takes it away exactly as Hide does, so it is refused the same way, before the ask.
  function hideRefusal(name, groupId, target, { deleting = false } = {}) {
    const found = hideBelowZero(dishesForGroup(groupId), catalog, target)
    if (!found.length) return null
    return deleting ? notDeletedText(name, found) : stillShownText(name, found)
  }

  // ── Groups ──
  async function toggleGroupActive(g) {
    setPageError(null)
    const refusal = g.is_active
      ? hideRefusal(g.name, g.id, { groupId: g.id })
      : showAgainRefusal(g.name, g.id, { ...catalog, groups: catalog.groups.map(x => (x.id === g.id ? { ...x, is_active: true } : x)) })
    if (refusal) { setPageError(refusal); return }
    const { data, error } = await bounded(scopedUpdate('pos_option_groups', { is_active: !g.is_active }).eq('id', g.id).select('id'), 'Saving the group')
    if (error) { setPageError(pageFailure(error)); return }
    if (!data?.length) { setPageError('That group no longer exists — reload the page.'); return }
    flash(g.is_active ? `“${g.name}” is hidden from the till and guest menu.` : `“${g.name}” is shown again.`)
    // S869: the confirmed change on screen at once, the re-read behind it.
    setCatalog(c => ({ ...c, groups: withActive(c.groups, g.id, !g.is_active) }))
    load({ quiet: true, recheck: true })
  }

  function deleteGroup(g) {
    setPageError(null)
    const refusal = g.is_active ? hideRefusal(g.name, g.id, { groupId: g.id }, { deleting: true }) : null
    if (refusal) { setPageError(refusal); return }
    const n = attachCountByGroup[g.id] || 0
    ask({
      title: `Delete “${g.name}”?`,
      danger: true,
      confirmLabel: 'Delete group',
      busyLabel: 'Deleting…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            {n > 0
              ? <>It is on <strong>{n} dish{n === 1 ? '' : 'es'}</strong>. Those dishes will stop offering it, and its {g.options.length} choice{g.options.length === 1 ? '' : 's'} and their stock lines are deleted with it.</>
              : <>Its {g.options.length} choice{g.options.length === 1 ? '' : 's'} and their stock lines are deleted with it.</>}
          </p>
          <p style={{ margin: 0, color: 'var(--theme-text2)' }}>Bills already rung keep what was chosen. To stop offering it without losing it, use Hide instead.</p>
        </>
      ),
      run: async () => {
        setPageError(null)
        const { data, error } = await bounded(scopedDelete('pos_option_groups').eq('id', g.id).select('id'), 'Deleting the group')
        if (error) { setPageError(pageFailure(error)); return }
        if (!data?.length) { setPageError('That group was already gone — reload the page.'); return }
        flash(`“${g.name}” was deleted.`)
        await load({ quiet: true })
      },
    })
  }

  // ── Options ──
  // S809 4h (CUSTOMIZATION-8): what taking an offered option away does to the dishes its group is
  // on, said before it happens (optionChecks.js since S862, so the option editor asks it too).
  const optionLossText = o => lossTextOf(o, catalog, id => dishById.get(id)?.name || 'a dish')

  async function setOptionActive(o, active) {
    setPageError(null)
    const { data, error } = await bounded(scopedUpdate('pos_options', { is_active: active }).eq('id', o.id).select('id'), 'Saving the choice')
    if (error) { setPageError(pageFailure(error)); return }
    if (!data?.length) { setPageError('That choice no longer exists — reload the page.'); return }
    // S869: the confirmed change on screen at once, the re-read behind it.
    setCatalog(c => ({ ...c, options: withActive(c.options, o.id, active) }))
    load({ quiet: true, recheck: true })
  }

  function toggleOptionActive(o) {
    setPageError(null)
    const refusal = o.is_active
      ? hideRefusal(o.name, o.group_id, { optionId: o.id })
      : showAgainRefusal(o.name, o.group_id, { ...catalog, options: catalog.options.map(x => (x.id === o.id ? { ...x, is_active: true } : x)) })
    if (refusal) { setPageError(refusal); return }
    const loss = optionLossText(o)
    if (!loss) { setOptionActive(o, !o.is_active); return }
    ask({
      title: `Hide “${o.name}”?`,
      confirmLabel: 'Hide it',
      busyLabel: 'Hiding…',
      body: <p style={{ margin: 0 }}>{loss}</p>,
      run: () => setOptionActive(o, false),
    })
  }

  function deleteOption(o) {
    setPageError(null)
    const refusal = o.is_active ? hideRefusal(o.name, o.group_id, { optionId: o.id }, { deleting: true }) : null
    if (refusal) { setPageError(refusal); return }
    ask({
      title: `Delete “${o.name}”?`,
      danger: true,
      confirmLabel: 'Delete choice',
      busyLabel: 'Deleting…',
      body: (
        <>
          <p style={{ margin: 0 }}>It stops being offered on every dish in its group{o.ingredients.length ? ', and its stock lines are deleted with it' : ''}. Bills already rung keep it. To stop offering it for now, use Hide instead.</p>
          {optionLossText(o) && <p style={{ margin: '8px 0 0' }}>{optionLossText(o)}</p>}
        </>
      ),
      run: async () => {
        setPageError(null)
        const { data, error } = await bounded(scopedDelete('pos_options').eq('id', o.id).select('id'), 'Deleting the choice')
        if (error) { setPageError(pageFailure(error)); return }
        if (!data?.length) { setPageError('That choice was already gone — reload the page.'); return }
        // S867: said, as a group delete is, rather than the row just vanishing.
        flash(`“${o.name}” was deleted.`)
        await load({ quiet: true })
      },
    })
  }

  function priceCell(g, o) {
    if (o.is_removal) return <span style={{ color: 'var(--theme-text3)' }}>Free</span>
    const deltaIncl = inclFromEx(o.price_delta, entryVat)
    if (g.kind === 'size') {
      // S862 SETUP-1: the same full-price test as the option editor, to the paisa.
      const base = fullPriceBase(dishesForGroup(g.id))
      // S809 4h (CUSTOMIZATION-6): below zero reads as below zero, never as NPR 0.
      if (base != null) {
        const v = base + deltaIncl
        return v < 0 ? <span style={{ color: 'var(--theme-red-text)' }}>{belowZeroAmount(v)}</span> : npr(v)
      }
    }
    return signedPrice(deltaIncl) || <span style={{ color: 'var(--theme-text3)' }}>No charge</span>
  }

  async function toggleBuildYourOwn(d, on) {
    if (markBusy) return
    setMarkBusy(d.id)
    setPageError(null)
    const { data, error } = await bounded(scopedUpdate('recipes', { is_build_your_own: on }).eq('id', d.id).select('id'), 'Saving the dish')
    setMarkBusy(null)
    if (error) { setPageError(pageFailure(error)); return }
    if (!data?.length) { setPageError(`${d.name} could not be changed — it may have been removed. Reload the page.`); return }
    flash(on
      ? `${d.name} is build-your-own: the till always opens its choices and the guest menu walks them step by step.`
      : `${d.name} is an ordinary dish again.`)
    load({ quiet: true })
  }

  const byoSet = new Set(catalog.buildYourOwn || [])

  const openGroup = optionModal ? groupRows.find(g => g.id === optionModal.groupId) : null
  const openOption = openGroup && optionModal.optionId ? openGroup.options.find(o => o.id === optionModal.optionId) : null

  const attachAction = g => ({ label: 'Put it on dishes', run: () => setAttachGroup(g) })

  return (
    <div className="page-container">
      <div className="page-header page-header--split">
        {heading}
        {tab === 'groups' && !loading && !loadError && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Tip width={300} text="For a dish guests build in steps, like an acai bowl, pizza or salad. Creates Size, Base, Sauces and Toppings groups on that dish in one go.">
              <button type="button" className="btn btn-ghost" aria-disabled={dishes.length === 0 || undefined}
                onClick={() => (dishes.length === 0 ? explain(`${NO_DISH_YET}, then use the template on it.`) : setTemplateOpen(true))}>
                Build-your-own template
              </button>
            </Tip>
            {/* S867: the shared Fab, last in the group. With no group yet the empty state's own
                + New Group is the page's one accent, so this one waits for the first group. */}
            <Fab label="+ New Group" onClick={() => setGroupModal({})}
              show={tab === 'groups' && !loading && !loadError && groupRows.length > 0} />
          </div>
        )}
      </div>

      {isAdmin && clientModules && !clientModules.customization && (
        <div role="status" className="amber-banner">
          <strong>Crest Customization is off for this client.</strong>{' '}
          You can prepare groups now; nothing is offered on the till or guest menu until it is switched on in Admin → Clients.
        </div>
      )}

      {settingsSettled && vatMode == null && (
        <div role="status" className="amber-banner">
          <strong>Choices cannot be saved right now.</strong>{' '}
          {VAT_MODE_UNKNOWN_TEXT}
        </div>
      )}

      {/* The count is its own phrase in the tab name ("Groups, 5"), not run into it ("Groups5"). */}
      <Tabs idBase="og" label="Choice Groups views" hasPanel active={tab} onChange={switchTab}
        tabs={TABS.map(([k, label]) => ({
          key: k,
          label: (
            <>
              {label}
              {!loading && !loadError && (k === 'groups' ? (
                <>
                  <span className="sr-only">, </span>
                  <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 6 }}>{catalog.groups.length}</span>
                </>
              ) : (
                <>
                  <span className="sr-only">, {customizableCount} of {dishes.length} offer choices</span>
                  <span aria-hidden="true" style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 6 }}>{customizableCount}/{dishes.length}</span>
                </>
              ))}
            </>
          ),
        }))} />

      <div ref={pageErrorRef}><ActionError error={pageError} className="action-error--top" /></div>
      {notice && (
        <p role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13, color: 'var(--theme-green-text)', margin: '0 0 12px' }}>
          <span>{notice.text}</span>
          {notice.action && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => { notice.action.run(); setNotice(null) }}>
              {notice.action.label} →
            </button>
          )}
        </p>
      )}

      <TabPanel idBase="og" active={tab}>
      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} onRetry={() => load()} />
      ) : tab === 'groups' ? (
        groupRows.length === 0 ? (
          // S867: the empty state carries its own + New Group, the page's one accent while there is
          // no group (the header's waits for the first one), and says the Size order up front.
          <div className="empty-state">
            <p style={{ margin: '0 0 8px' }}>No choice groups yet.</p>
            <p style={{ margin: '0 0 8px', color: 'var(--theme-text2)' }}>
              Start with the choices your menu already has — for example <strong>Size</strong> (Half / Full), <strong>Extras</strong> (Extra cheese, Add egg, and a “No onion” marked as taking something off) and <strong>Spice</strong> (Mild / Medium / Hot).
            </p>
            <p style={{ margin: '0 0 12px', color: 'var(--theme-text2)' }}>
              Put a Size group on its dishes before you add its sizes, so each size takes its full menu price.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setGroupModal({})}>+ New Group</button>
          </div>
        ) : (
          <div className="fab-clear" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {groupRows.map((g, gi) => {
              const onDishes = attachCountByGroup[g.id] || 0
              const freeN = g.kind === 'addon' ? (g.included_count || 0) : 0
              // S809 4h (CUSTOMIZATION-8): dishes this group now makes unorderable, whatever caused it.
              const shortfalls = groupShortfalls(g, catalog.options, catalog.attachments)
              // S867: the card's one primary button is the step this group is waiting on.
              const next = nextStepOf(g, onDishes)
              const rule = <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{ruleText({ min: g.min_select, max: g.max_select, included: g.included_count })}</span>
              return (
                <section key={g.id} className="card" aria-labelledby={`grp-${g.id}`} style={{ margin: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                    <h2 id={`grp-${g.id}`} style={{ margin: 0, fontSize: 16, color: g.is_active ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{g.name}</h2>
                    <span className="badge-gray">{KIND_LABEL[g.kind]}</span>
                    {!g.is_active && <span className="badge-gray">Hidden</span>}
                    {!onDishes && (
                      <Tip width={260} text="Not on any dish yet, so nothing offers it. Use “Put it on dishes”."
                        style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default' }}>
                        <span className="badge-amber">Not on any dish</span>
                      </Tip>
                    )}
                    {/* S867: "first N free" is explained on the rule itself, not in a paragraph on every card. */}
                    {freeN > 0 ? (
                      <Tip width={300} text={`The first ${freeN} choice${freeN === 1 ? '' : 's'} a guest makes ${freeN === 1 ? 'is' : 'are'} free: the earliest in this list among what they picked, not the cheapest. Use ↑ (Move up) to put the ones you are happy to give away at the top. A “No …” choice never counts, and takes no place under the maximum.`}>
                        {rule}
                      </Tip>
                    ) : rule}
                    {onDishes > 0 && (
                      <Tip width={260} text={`Offered on: ${dishesForGroup(g.id).map(d => d.name).join(', ')}`}>
                        <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>On {onDishes} dish{onDishes === 1 ? '' : 'es'}</span>
                      </Tip>
                    )}
                    {/* Every card has these two buttons, so each is described by its group's name (S863). */}
                    <div data-group-actions={g.id} style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button type="button" className={`btn btn-sm ${next === 'option' ? 'btn-primary' : 'btn-ghost'}`} aria-describedby={`grp-${g.id}`}
                        onClick={() => setOptionModal({ groupId: g.id })}>+ Choice</button>
                      <button type="button" className={`btn btn-sm ${next === 'attach' ? 'btn-primary' : 'btn-ghost'}`} aria-describedby={`grp-${g.id}`}
                        aria-disabled={dishes.length === 0 || undefined}
                        onClick={() => (dishes.length === 0 ? explain(`${NO_DISH_YET}, then put “${g.name}” on it.`) : setAttachGroup(g))}>
                        Put it on dishes
                      </button>
                      <RowMenu label={`More for ${g.name}`}
                        disabled={!!moving && moving.id !== g.id} busy={!!moving && moving.id === g.id && moving.via === 'menu'} items={[
                        { key: 'edit', label: 'Edit group', onSelect: () => setGroupModal({ group: g }) },
                        { key: 'up', label: 'Move up', disabled: gi === 0, onSelect: () => moveRow('pos_option_groups', catalog.groups, gi, -1, 'menu') },
                        { key: 'down', label: 'Move down', disabled: gi === groupRows.length - 1, onSelect: () => moveRow('pos_option_groups', catalog.groups, gi, 1, 'menu') },
                        { key: 'hide', label: g.is_active ? 'Hide from till and guest menu' : 'Show again', onSelect: () => toggleGroupActive(g) },
                        '-',
                        { key: 'delete', label: 'Delete group…', danger: true, onSelect: () => deleteGroup(g) },
                      ]} />
                    </div>
                  </div>

                  {shortfalls.length > 0 && (
                    <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--theme-red-text)' }}>
                      {andList(shortfalls.map(x => `${dishById.get(x.recipe_id)?.name || 'A dish'} must pick ${x.need}`))} from this group and {shortfalls[0].offered === 1 ? 'only 1 choice is' : `only ${shortfalls[0].offered} choices are`} offered, so {shortfalls.length === 1 ? 'it' : 'they'} can’t be ordered on the till or the QR menu. Show a choice again, or lower the rule.
                    </p>
                  )}

                  {g.options.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>No choices yet — add the first one with <strong>+ Choice</strong>.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th style={{ width: 1 }}><span className="sr-only">Order</span></th>
                            <th><Tip width={240} text="What guests and waiters tap, in the order they see it. A kitchen ticket name, if it differs, is shown under it.">Choice</Tip></th>
                            <th style={{ textAlign: 'right' }}>
                              <Tip width={260} text={g.kind === 'size'
                                ? 'For a size group on dishes that all cost the same, the full price of that size. Otherwise, how much it adds or takes off.'
                                : `What guests pay on top of the dish${vatReg ? ', including VAT' : ''}.`}>Price</Tip>
                            </th>
                            {/* On a phone these three fold away (S863), so Edit and ⋯ fit at 360px; the
                                badges and a stock warning ride under the option name instead. */}
                            <th className="phone-hide"><Tip width={240} text="A pre-selected choice is already ticked when the guest or waiter opens the list. A “No …” choice prints as NO on the kitchen ticket. A hidden choice is kept but not offered.">Shown as</Tip></th>
                            <th className="phone-hide"><Tip width={220} text="What guests see beside the choice on the QR menu.">Diet &amp; allergens</Tip></th>
                            {imsOn && <th className="phone-hide"><Tip width={260} text="What picking this choice does to stock and food cost, per plate.">Stock</Tip></th>}
                            <th style={{ width: 1 }}><span className="sr-only">Actions</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.options.map((o, oi) => {
                            const upLabel = `Move ${o.name} up`, downLabel = `Move ${o.name} down`
                            const upBusy = isMoving('pos_options', o.id, -1), downBusy = isMoving('pos_options', o.id, 1)
                            const badges = [
                              o.is_removal && <span key="off" className="badge-gray">Takes off</span>,
                              o.is_default && <span key="def" className="badge-gray">Pre-selected</span>,
                              !o.is_active && <span key="hid" className="badge-gray">Hidden</span>,
                            ].filter(Boolean)
                            const noStock = imsOn && o.ingredients.length === 0
                            const stockWarn = noStock && missingIngredients(g, o)
                            return (
                            <tr key={o.id}>
                              <td style={{ whiteSpace: 'nowrap', padding: '4px 6px' }}>
                                {/* S867: 8px apart, so a tablet tap meant for one arrow cannot land on the other and reorder a live menu. */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  <button type="button" className="btn btn-ghost btn-icon" aria-label={upLabel} title={upLabel}
                                    data-move={moveKey('pos_options', o.id, -1)} aria-busy={upBusy || undefined}
                                    disabled={oi === 0 || (!!moving && !upBusy)} onClick={() => moveRow('pos_options', g.options, oi, -1)}>↑</button>
                                  <button type="button" className="btn btn-ghost btn-icon" aria-label={downLabel} title={downLabel}
                                    data-move={moveKey('pos_options', o.id, 1)} aria-busy={downBusy || undefined}
                                    disabled={oi === g.options.length - 1 || (!!moving && !downBusy)} onClick={() => moveRow('pos_options', g.options, oi, 1)}>↓</button>
                                </div>
                              </td>
                              <td style={{ overflowWrap: 'break-word' }}>
                                <span style={{ fontWeight: 500, color: o.is_active ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{o.name}</span>
                                {o.kitchen_name && !sameName(o.kitchen_name, o.name) && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>Ticket: {o.kitchen_name}</div>}
                                {(badges.length > 0 || stockWarn) && (
                                  <div className="phone-only" style={{ marginTop: 4 }}>
                                    {badges.length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{badges}</div>}
                                    {stockWarn && <div style={{ fontSize: 11, color: 'var(--theme-amber-text)', marginTop: 2 }}>△ No ingredients</div>}
                                  </div>
                                )}
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{priceCell(g, o)}</td>
                              <td className="phone-hide">
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{badges}</div>
                              </td>
                              <td className="phone-hide" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                                {[o.diet ? DIET_LABEL[o.diet] : null, (o.allergens || []).length ? (o.allergens || []).map(allergenLabel).join(', ') : null].filter(Boolean).join(' · ') || '—'}
                              </td>
                              {imsOn && (
                                <td className="phone-hide" style={{ fontSize: 12 }}>
                                  {o.ingredients.length
                                    ? <span style={{ color: 'var(--theme-text2)' }}>{o.ingredients.length} ingredient line{o.ingredients.length === 1 ? '' : 's'}</span>
                                    : stockWarn
                                      ? <Tip width={260} text="This choice adds to the price but takes nothing off stock, so food cost reads low. For “Extra cheese”, add the cheese.">
                                          <span style={{ color: 'var(--theme-amber-text)' }}>△ No ingredients</span>
                                        </Tip>
                                      : <Tip width={260} text="Picking this choice does not change stock or food cost. That is fine for a free one like spice level.">
                                          <span style={{ color: 'var(--theme-text3)' }}>No ingredients</span>
                                        </Tip>}
                                </td>
                              )}
                              <td>
                                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOptionModal({ groupId: g.id, optionId: o.id })} aria-label={`Edit ${o.name}`}>Edit</button>
                                  <RowMenu label={`More for ${o.name}`} disabled={!!moving} items={[
                                    { key: 'hide', label: o.is_active ? 'Hide' : 'Show again', onSelect: () => toggleOptionActive(o) },
                                    '-',
                                    { key: 'delete', label: 'Delete…', danger: true, onSelect: () => deleteOption(o) },
                                  ]} />
                                </div>
                              </td>
                            </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        )
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <input className="form-input form-input--auto" style={{ width: 260 }} placeholder="Search dishes…"
              aria-label="Search dishes by name or category" value={search} onChange={e => setSearch(e.target.value)} />
            <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
              {customizableCount} of {dishes.length} dish{dishes.length === 1 ? '' : 'es'} offer choices. The rest order exactly as before.
            </span>
          </div>
          {dishes.length === 0 ? (
            <div className="empty-state">No dishes yet. Dishes are made in Recipe Costing (or Menu Pricing on a POS-only plan).</div>
          ) : filteredDishes.length === 0 ? (
            <div className="empty-state">No dishes match “{search.trim()}”.</div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Dish</th>
                    {/* The menu price folds away on a phone (S863): the choices are what this tab is for. */}
                    <th className="phone-hide" style={{ textAlign: 'right' }}><Tip width={200} text={vatReg ? 'Menu price including VAT.' : 'Menu price.'}>Price</Tip></th>
                    <th><Tip width={240} text="The choice groups this dish offers, in the order the till and the QR menu show them.">Choices</Tip></th>
                    <th style={{ width: 1 }}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDishes.map(d => {
                    const attached = (groupsByDish[d.id] || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0))
                    return (
                      <tr key={d.id}>
                        <td style={{ overflowWrap: 'break-word' }}>
                          <span style={{ fontWeight: 500 }}>{d.name}</span>
                          {byoSet.has(d.id) && (
                            <Tip width={260} text="Build-your-own: the till always opens this dish's choices, and the QR menu walks them one step at a time." style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default', marginLeft: 6 }}>
                              <span className="badge-gray">Build-your-own</span>
                            </Tip>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                            {d.category || 'No category'}{d.pos_enabled ? '' : ' · not on POS'}
                          </div>
                        </td>
                        <td className="phone-hide" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{d.inclPrice > 0 ? npr(d.inclPrice) : '—'}</td>
                        <td>
                          {attached.length ? (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {attached.map(a => <span key={a.id} className="badge-gray">{groupNameById.get(a.group_id) || '—'}</span>)}
                            </div>
                          ) : byoSet.has(d.id) ? (
                            <span style={{ fontSize: 12, color: 'var(--theme-amber-text)' }}>△ Build-your-own, but it offers nothing to build. Add choices or use the template.</span>
                          ) : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No choices</span>}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <button type="button" className="btn btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }}
                              aria-disabled={catalog.groups.length === 0 || undefined}
                              onClick={() => (catalog.groups.length === 0
                                ? explain(`Make a choice group first on the Groups tab, then add it to ${d.name}.`)
                                : setAttachFor(d))}
                              aria-label={attached.length ? `Choices for ${d.name}` : `Add choices for ${d.name}`}>
                              {attached.length ? 'Choices…' : 'Add choices'}
                            </button>
                            <RowMenu label={`More for ${d.name}`} busy={markBusy === d.id} items={[
                              byoSet.has(d.id)
                                ? { key: 'byo-off', label: 'Make it an ordinary dish', onSelect: () => toggleBuildYourOwn(d, false) }
                                : { key: 'byo-on', label: 'Mark as build-your-own', onSelect: () => toggleBuildYourOwn(d, true),
                                    hint: 'The till always opens its choices; the QR menu walks them step by step' },
                            ]} />
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      </TabPanel>

      {groupModal && (
        <OptionGroupModal
          group={groupModal.group}
          attachedCount={groupModal.group ? (attachCountByGroup[groupModal.group.id] || 0) : 0}
          catalog={catalog}
          attachedDishes={groupModal.group ? dishesForGroup(groupModal.group.id) : []}
          nextSort={Math.max(-1, ...catalog.groups.map(g => g.sort || 0)) + 1}
          onClose={() => setGroupModal(null)}
          onSaved={saved => {
            setGroupModal(null)
            // S867: a new group is told its next step, the one its card now wears as primary. The
            // insert hands back the whole row, which is all AttachToDishesModal reads of a group.
            if (groupModal.group) flash(`“${saved?.name}” was saved.`)
            else if (saved?.kind !== 'size') flash(`“${saved?.name}” was created. Now add its choices with + Choice.`)
            else if (saved?.id && dishes.length > 0) flash(`“${saved.name}” was created. Put it on its dishes first, so each size takes its full menu price.`, attachAction(saved))
            else flash(`“${saved?.name}” was created. ${NO_DISH_YET}, then put “${saved?.name}” on it before you add the sizes.`)
            load({ quiet: true })
          }}
        />
      )}

      {openGroup && (
        <OptionModal
          // S862 SETUP-6: keyed on the VAT rate the figures use, so a basis that resolves after the
          // editor opened (unknown, read as VAT, then PAN) re-seeds the price box instead of leaving
          // the figure worked out on the old rate. Unknown to VAT changes no figure, so no remount.
          key={`${openOption?.id || 'new'}:${entryVat}`}
          group={openGroup}
          option={openOption}
          ingredients={openOption?.ingredients || []}
          attachedDishes={dishesForGroup(openGroup.id)}
          catalog={catalog}
          vat={entryVat}
          vatUnknown={vatMode == null}
          imsEnabled={imsOn}
          itemChoices={itemChoices}
          initialError={optionModal.error || null}
          onClose={() => setOptionModal(null)}
          onSaved={async (saved, opts) => {
            await load({ quiet: true })
            // A new option remounts here (its key becomes its id), so its message rides across.
            if (opts?.keepOpen) { setOptionModal({ groupId: openGroup.id, optionId: saved.id, error: opts.error || null }); return }
            setOptionModal(null)
            // The step that goes unnoticed: a group with options and no dish offers nothing.
            if (!(attachCountByGroup[openGroup.id] > 0) && dishes.length > 0) {
              flash(`“${saved.name}” was saved. “${openGroup.name}” is not on any dish yet, so nothing offers it.`, attachAction(openGroup))
            } else {
              flash(`“${saved.name}” was saved.`)
            }
          }}
        />
      )}

      {attachFor && (
        <AttachGroupsModal recipe={attachFor} catalog={catalog} onClose={() => setAttachFor(null)}
          onSaved={(n, r) => {
            load({ quiet: true })
            // A save that stopped part-way keeps the dialog open with its own message (S862 SETUP-10).
            if (r?.partial) return
            flash(n ? `${attachFor.name} now offers ${n} group${n === 1 ? '' : 's'}.` : `${attachFor.name} now orders with no choices.`)
          }} />
      )}

      {templateOpen && (
        <BuildYourOwnTemplateModal
          dishes={dishes}
          buildYourOwn={catalog.buildYourOwn || []}
          groupNames={catalog.groups.map(g => g.name)}
          groups={catalog.groups}
          attachments={catalog.attachments}
          onClose={() => setTemplateOpen(false)}
          onSaved={({ dish }) => {
            setTemplateOpen(false)
            load({ quiet: true })
            flash(`${dish?.name || 'The dish'} now has Size, Base, Sauces and Toppings. Add the bases, sauces and toppings with + Choice, then set the prices.`)
          }}
        />
      )}

      {attachGroup && (
        <AttachToDishesModal group={attachGroup} dishes={dishes} attachments={catalog.attachments} catalog={catalog}
          onClose={() => setAttachGroup(null)}
          onSaved={r => {
            load({ quiet: true })
            if (r?.partial) return
            const parts = [r.added ? `put on ${r.added} dish${r.added === 1 ? '' : 'es'}` : null, r.removed ? `taken off ${r.removed}` : null].filter(Boolean)
            flash(`“${attachGroup.name}” ${parts.join(' and ')}.`)
          }} />
      )}

      {confirmEl}
    </div>
  )
}
