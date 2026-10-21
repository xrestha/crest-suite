import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import { useSettings } from '../../context/SettingsContext'
import { useScopedDb } from '../../shared/hooks/useScopedDb'
import { useConfirm } from '../../shared/hooks/useConfirm'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { firstError } from '../../shared/queryError'
import { npr } from '../../shared/nepalMoney'
import { moveRovingFocus, rovingTabIndex } from '../../shared/rovingFocus'
import Tip from '../../components/Tip'
import RowMenu from '../../components/RowMenu'
import ReportLoadError from '../../components/ReportLoadError'
import ActionError from '../../components/ActionError'
import { withTimeout, settleWithin } from '../../utils/withTimeout'
import {
  loadOptionCatalog, KIND_LABEL, DIET_LABEL, CUSTOMIZATION_READ_MS, CUSTOMIZATION_WRITE_MS, PAGE_CHECK, writeFailure,
} from './customizationData'
import { STANDARD_VAT, inclFromEx, ruleText, signedPrice, groupShortfalls, dishesBelowZero, belowZeroText } from '../../shared/optionPricing'
import { andList } from '../../shared/offeredPicks'
import { vatModeOf, VAT_MODE_UNKNOWN_TEXT } from '../ims/recipes/menuPriceVat'
import OptionGroupModal from './OptionGroupModal'
import OptionModal from './OptionModal'
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

const vatOf = r => (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : Number(r.vat_rate)

// A row write from this page, with its time limit (S852). A timeout answers as the call's own
// `error`, and the message built from it says to reload and look, never that nothing changed.
const bounded = (q, label) => settleWithin(q, CUSTOMIZATION_WRITE_MS, label)
const pageFailure = error => writeFailure(error, PAGE_CHECK)

const TABS = [['groups', 'Groups'], ['dishes', 'Dishes']]

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
  const [moving, setMoving] = useState(false)

  const [groupModal, setGroupModal] = useState(null)   // { group? }
  const [optionModal, setOptionModal] = useState(null) // { groupId, optionId?, error? }
  const [attachFor, setAttachFor] = useState(null)     // dish
  const [attachGroup, setAttachGroup] = useState(null) // group → dishes
  const [templateOpen, setTemplateOpen] = useState(false)
  const [markBusy, setMarkBusy] = useState(null)       // dish id being marked / cleared

  // An admin switching client mid-load must not let the previous tenant's catalog land.
  const loadSeq = useRef(0)

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!clientId) return
    const seq = ++loadSeq.current
    if (!quiet) setLoading(true)
    setLoadError(null)
    let results
    try {
      results = await withTimeout(Promise.all([
        loadOptionCatalog(scopedFrom, { withIngredients: imsOn }),
        // Every active recipe. A NULL category is a dish (S714's .or form), and a sub-recipe is only
        // offered as an option ingredient, never as something to customize.
        fetchAllRows(() => scopedFrom('recipes', 'id, name, category, selling_price, vat_rate, pos_enabled, yield_uom')
          .not('is_active', 'is', false).order('name').order('id')),
        imsOn
          ? fetchAllRows(() => scopedFrom('items', 'id, name, uom').eq('is_sub_recipe', false)
            .not('is_active', 'is', false).order('name').order('id'))
          : Promise.resolve({ data: [], error: null }),
      ]), CUSTOMIZATION_READ_MS, 'Loading option groups')
    } catch (err) {
      // A hang used to leave Loading… on screen for good, with nothing to press (S852).
      if (seq !== loadSeq.current) return
      setLoadError(err)
      setLoading(false)
      return
    }
    if (seq !== loadSeq.current) return
    const [cat, ...rest] = results
    const failed = cat.error || firstError(rest)
    if (failed) { setLoadError(failed); setLoading(false); return }
    const [{ data: recipes }, { data: items }] = rest
    const all = recipes || []
    setCatalog(cat)
    setDishes(all.filter(r => r.category !== 'Sub-Recipe').map(r => ({
      ...r,
      inclPrice: (Number(r.selling_price) || 0) * (1 + (vatReg ? vatOf(r) : 0)),
    })))
    setItemChoices([
      ...(items || []).map(i => ({ value: `item:${i.id}`, label: `${i.name} (${i.uom})`, unit: i.uom })),
      ...all.filter(r => r.category === 'Sub-Recipe').map(r => ({
        value: `sub:${r.id}`, label: `Sub-recipe: ${r.name}${r.yield_uom ? ` (${r.yield_uom})` : ''}`, unit: r.yield_uom || '',
      })),
    ])
    setLoading(false)
  }, [clientId, scopedFrom, imsOn, vatReg])

  useEffect(() => { load() }, [load])

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

  const flash = (text, action = null) => setNotice({ text, action })
  const switchTab = k => { setTab(k); setNotice(null); setPageError(null) }

  function dishesForGroup(groupId) {
    return catalog.attachments.filter(a => a.group_id === groupId).map(a => dishById.get(a.recipe_id)).filter(Boolean)
  }

  // ── Order ──
  // A move is a swap of two rows' `sort`. Rows the loader ordered by (sort, name, id) can share a
  // sort value (every row created before ordering existed is 0), so the swap writes the rows'
  // POSITIONS as their new sorts rather than exchanging two equal numbers and moving nothing.
  async function swapSort(table, rows, idx, dir) {
    const other = idx + dir
    if (other < 0 || other >= rows.length || moving) return
    setMoving(true)
    setPageError(null)
    const a = rows[idx], b = rows[other]
    const res = await bounded(Promise.all([
      scopedUpdate(table, { sort: other }).eq('id', a.id).select('id'),
      scopedUpdate(table, { sort: idx }).eq('id', b.id).select('id'),
    ]), 'Moving the row')
    setMoving(false)
    if (res.error) { setPageError(pageFailure(res.error)); return }
    const [r1, r2] = res
    const err = r1.error || r2.error
    if (err) { setPageError(pageFailure(err)); return }
    if (!r1.data?.length || !r2.data?.length) { setPageError('One of those rows no longer exists — reload the page.'); return }
    load({ quiet: true })
  }
  // Renumber first when two neighbours share a sort, otherwise the swap above is a no-op.
  async function moveRow(table, rows, idx, dir) {
    const dense = rows.every((r, i) => (r.sort || 0) === i)
    if (dense) return swapSort(table, rows, idx, dir)
    setMoving(true)
    setPageError(null)
    const results = await bounded(Promise.all(rows.map((r, i) => scopedUpdate(table, { sort: i }).eq('id', r.id).select('id'))), 'Moving the row')
    const err = results.error || results.find(r => r.error)?.error
    if (err) { setMoving(false); setPageError(pageFailure(err)); return }
    const renumbered = rows.map((r, i) => ({ ...r, sort: i }))
    setMoving(false)
    return swapSort(table, renumbered, idx, dir)
  }

  // S835 (D17): showing a hidden group or option again puts its choices back on every dish it is
  // on, so it is checked like an edit: refused when it would let one of those dishes be ordered
  // below zero. Until S835 neither "Show again" ran any check, so a choice hidden for a bad price
  // came straight back with it and the till refused the dish by name mid-service.
  function showAgainRefusal(name, groupId, after) {
    const found = dishesBelowZero(dishesForGroup(groupId), after, { before: catalog })
    if (!found.length) return null
    return `“${name}” is still hidden. ${belowZeroText(found)}, and the till refuses a dish priced below zero. Change the prices with Edit first, or take the group off ${found.length === 1 ? 'that dish' : 'those dishes'}.`
  }

  // ── Groups ──
  async function toggleGroupActive(g) {
    setPageError(null)
    if (!g.is_active) {
      const refusal = showAgainRefusal(g.name, g.id, { ...catalog, groups: catalog.groups.map(x => (x.id === g.id ? { ...x, is_active: true } : x)) })
      if (refusal) { setPageError(refusal); return }
    }
    const { data, error } = await bounded(scopedUpdate('pos_option_groups', { is_active: !g.is_active }).eq('id', g.id).select('id'), 'Saving the group')
    if (error) { setPageError(pageFailure(error)); return }
    if (!data?.length) { setPageError('That group no longer exists — reload the page.'); return }
    flash(g.is_active ? `“${g.name}” is hidden from the till and guest menu.` : `“${g.name}” is shown again.`)
    load({ quiet: true })
  }

  function deleteGroup(g) {
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
              ? <>It is on <strong>{n} dish{n === 1 ? '' : 'es'}</strong>. Those dishes will stop offering it, and its {g.options.length} option{g.options.length === 1 ? '' : 's'} and their stock lines are deleted with it.</>
              : <>Its {g.options.length} option{g.options.length === 1 ? '' : 's'} and their stock lines are deleted with it.</>}
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
  // on, said before it happens. Too few left for a dish's minimum takes the dish off the till and
  // the QR menu (the server refuses it); none left drops the group, and the dish sells without it.
  // Only what THIS change causes is named: a dish already short is flagged on the group's card.
  function optionLossText(o) {
    const group = catalog.groups.find(g => g.id === o.group_id)
    if (!o.is_active || !group?.is_active) return null
    const after = catalog.options.map(x => (x.id === o.id ? { ...x, is_active: false } : x))
    const before = new Set(groupShortfalls(group, catalog.options, catalog.attachments).map(x => x.recipe_id))
    const short = groupShortfalls(group, after, catalog.attachments).filter(x => !before.has(x.recipe_id))
    const nameOf = id => dishById.get(id)?.name || 'a dish'
    const left = after.filter(x => x.group_id === group.id && x.is_active).length
    if (short.length) {
      return `${andList(short.map(x => `${nameOf(x.recipe_id)} must pick ${x.need}`))} from “${group.name}”, which would have ${left} left to pick. ${short.length === 1 ? 'It' : 'They'} can’t be ordered on the till or the QR menu until you show an option again or lower the rule.`
    }
    const on = catalog.attachments.filter(a => a.group_id === group.id)
    if (left === 0 && on.length) {
      return `Nothing would be left to pick in “${group.name}”, so ${andList(on.map(a => nameOf(a.recipe_id)))} would be ordered without it.`
    }
    return null
  }

  async function setOptionActive(o, active) {
    setPageError(null)
    const { data, error } = await bounded(scopedUpdate('pos_options', { is_active: active }).eq('id', o.id).select('id'), 'Saving the option')
    if (error) { setPageError(pageFailure(error)); return }
    if (!data?.length) { setPageError('That option no longer exists — reload the page.'); return }
    await load({ quiet: true })
  }

  function toggleOptionActive(o) {
    if (!o.is_active) {
      setPageError(null)
      const refusal = showAgainRefusal(o.name, o.group_id, { ...catalog, options: catalog.options.map(x => (x.id === o.id ? { ...x, is_active: true } : x)) })
      if (refusal) { setPageError(refusal); return }
    }
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
    ask({
      title: `Delete “${o.name}”?`,
      danger: true,
      confirmLabel: 'Delete option',
      busyLabel: 'Deleting…',
      body: (
        <>
          <p style={{ margin: 0 }}>It stops being offered on every dish in its group{o.ingredients.length ? ', and its stock lines are deleted with it' : ''}. Bills already rung keep it. To stop offering it for now, use Hide instead.</p>
          {optionLossText(o) && <p style={{ margin: '8px 0 0' }}>{optionLossText(o)}</p>}
        </>
      ),
      run: async () => {
        setPageError(null)
        const { data, error } = await bounded(scopedDelete('pos_options').eq('id', o.id).select('id'), 'Deleting the option')
        if (error) { setPageError(pageFailure(error)); return }
        if (!data?.length) { setPageError('That option was already gone — reload the page.'); return }
        await load({ quiet: true })
      },
    })
  }

  function priceCell(g, o) {
    if (o.is_removal) return <span style={{ color: 'var(--theme-text3)' }}>Free</span>
    const deltaIncl = inclFromEx(o.price_delta, entryVat)
    if (g.kind === 'size') {
      const prices = Array.from(new Set(dishesForGroup(g.id).map(d => Math.round(d.inclPrice))))
      // S809 4h (CUSTOMIZATION-6): below zero reads as below zero, never as NPR 0.
      if (prices.length === 1) {
        const v = prices[0] + deltaIncl
        return v < 0 ? <span style={{ color: 'var(--theme-red-text)' }}>−{npr(Math.abs(v))}</span> : npr(v)
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
        <div>
          <h1 className="page-title">Option Groups</h1>
          <p className="page-subtitle">
            Build the choices guests can make — sizes, add-ons, “No …” requests and spice — then put each group on the dishes that offer it.
          </p>
        </div>
        {tab === 'groups' && !loading && !loadError && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Tip width={300} text="For a dish guests build in steps, like an acai bowl, pizza or salad. Creates Size, Base, Sauces and Toppings groups on that dish in one go.">
              <button className="btn btn-ghost" onClick={() => setTemplateOpen(true)} disabled={dishes.length === 0}>Build-your-own template</button>
            </Tip>
            <button className="btn btn-primary" onClick={() => setGroupModal({})}>+ New Group</button>
          </div>
        )}
      </div>

      {isAdmin && clientModules && !clientModules.customization && (
        <div role="status" className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Crest Customization is off for this client.</strong>{' '}
          <span style={{ color: 'var(--theme-text2)' }}>You can prepare groups now; nothing is offered on the till or guest menu until it is switched on in Admin → Clients.</span>
        </div>
      )}

      {vatMode == null && !settingsCtx.loading && (
        <div role="status" className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Options cannot be saved right now.</strong>{' '}
          <span style={{ color: 'var(--theme-text2)' }}>{VAT_MODE_UNKNOWN_TEXT}</span>
        </div>
      )}

      <div className="tab-bar" role="tablist" aria-label="Option Groups views"
        onKeyDown={e => moveRovingFocus(e, '[role="tab"]')?.click()}>
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" id={`og-tab-${k}`} aria-selected={tab === k} aria-controls={`og-panel-${k}`}
            tabIndex={rovingTabIndex(tab === k)}
            className={`tab-btn${tab === k ? ' tab-btn--active' : ''}`} onClick={() => switchTab(k)}>
            {label}
            {!loading && !loadError && (
              <span style={{ fontSize: 11, color: 'var(--theme-text3)', marginLeft: 6 }}>
                {k === 'groups' ? catalog.groups.length : `${customizableCount}/${dishes.length}`}
              </span>
            )}
          </button>
        ))}
      </div>

      <ActionError error={pageError} className="action-error--top" />
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

      <div role="tabpanel" id={`og-panel-${tab}`} aria-labelledby={`og-tab-${tab}`}>
      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : loadError ? (
        <>
          <ReportLoadError error={loadError} />
          <button type="button" className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => load()}>Try again</button>
        </>
      ) : tab === 'groups' ? (
        groupRows.length === 0 ? (
          <div className="empty-state">
            <p style={{ margin: '0 0 8px' }}>No option groups yet.</p>
            <p style={{ margin: 0, color: 'var(--theme-text2)' }}>
              Start with the choices your menu already has — for example <strong>Size</strong> (Half / Full), <strong>Extras</strong> (Extra cheese, Add egg, and a “No onion” marked as taking something off) and <strong>Spice</strong> (Mild / Medium / Hot). Then put each group on the dishes that offer it.
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {groupRows.map((g, gi) => {
              const onDishes = attachCountByGroup[g.id] || 0
              const freeN = g.kind === 'addon' ? (g.included_count || 0) : 0
              // S809 4h (CUSTOMIZATION-8): dishes this group now makes unorderable, whatever caused it.
              const shortfalls = groupShortfalls(g, catalog.options, catalog.attachments)
              return (
                <section key={g.id} className="card" aria-labelledby={`grp-${g.id}`} style={{ margin: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                    <h2 id={`grp-${g.id}`} style={{ margin: 0, fontSize: 16, color: g.is_active ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{g.name}</h2>
                    <span className="badge-gray">{KIND_LABEL[g.kind]}</span>
                    {!g.is_active && <span className="badge-gray">Hidden</span>}
                    <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{ruleText({ min: g.min_select, max: g.max_select, included: g.included_count })}</span>
                    <Tip width={260} text={onDishes ? `Offered on: ${dishesForGroup(g.id).map(d => d.name).join(', ')}` : 'Not on any dish yet, so nothing offers it. Use “Put it on dishes”.'}>
                      <span style={{ fontSize: 12, color: onDishes ? 'var(--theme-text2)' : 'var(--theme-amber-text)' }}>
                        {onDishes ? `On ${onDishes} dish${onDishes === 1 ? '' : 'es'}` : 'Not on any dish'}
                      </span>
                    </Tip>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => setOptionModal({ groupId: g.id })}>+ Option</button>
                      <button className={`btn btn-sm ${onDishes ? 'btn-ghost' : 'btn-primary'}`} onClick={() => setAttachGroup(g)}
                        disabled={dishes.length === 0} title={dishes.length === 0 ? 'Make a dish first' : undefined}>
                        Put it on dishes
                      </button>
                      <RowMenu label={`More for ${g.name}`} disabled={moving} items={[
                        { key: 'edit', label: 'Edit group', onSelect: () => setGroupModal({ group: g }) },
                        { key: 'up', label: 'Move up', disabled: gi === 0, onSelect: () => moveRow('pos_option_groups', catalog.groups, gi, -1) },
                        { key: 'down', label: 'Move down', disabled: gi === groupRows.length - 1, onSelect: () => moveRow('pos_option_groups', catalog.groups, gi, 1) },
                        { key: 'hide', label: g.is_active ? 'Hide from till and guest menu' : 'Show again', onSelect: () => toggleGroupActive(g) },
                        '-',
                        { key: 'delete', label: 'Delete group…', danger: true, onSelect: () => deleteGroup(g) },
                      ]} />
                    </div>
                  </div>

                  {freeN > 0 && g.options.length > 0 && (
                    <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--theme-text2)' }}>
                      The first {freeN} pick{freeN === 1 ? '' : 's'} a guest makes {freeN === 1 ? 'is' : 'are'} free — the <strong>earliest in this list</strong> among what they picked, not the cheapest. Put the options you are happy to give away first, with <em>Move up</em>. A “No …” option is never one of them and takes no place under the maximum.
                    </p>
                  )}

                  {shortfalls.length > 0 && (
                    <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--theme-red-text)' }}>
                      {andList(shortfalls.map(x => `${dishById.get(x.recipe_id)?.name || 'A dish'} must pick ${x.need}`))} from this group and {shortfalls[0].offered === 1 ? 'only 1 option is' : `only ${shortfalls[0].offered} options are`} offered, so {shortfalls.length === 1 ? 'it' : 'they'} can’t be ordered on the till or the QR menu. Show an option again, or lower the rule.
                    </p>
                  )}

                  {g.options.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>No options yet — add the first one with <strong>+ Option</strong>.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th style={{ width: 1 }}><span className="sr-only">Order</span></th>
                            <th><Tip width={240} text="What guests and waiters tap, in the order they see it. The kitchen ticket name, if set, is shown under it.">Option</Tip></th>
                            <th style={{ textAlign: 'right' }}>
                              <Tip width={260} text={g.kind === 'size'
                                ? 'For a size group on dishes that all cost the same, the full price of that size. Otherwise, how much it adds or takes off.'
                                : `What guests pay on top of the dish${vatReg ? ', including VAT' : ''}.`}>Price</Tip>
                            </th>
                            <th><Tip width={240} text="Pre-selected options are ticked when the picker opens. A “No …” option prints as NO on the kitchen ticket. Hidden options are kept but not offered.">Shown as</Tip></th>
                            <th><Tip width={220} text="What guests see beside the option on the QR menu.">Diet &amp; allergens</Tip></th>
                            {imsOn && <th><Tip width={260} text="What picking this option does to stock and food cost, per plate.">Stock</Tip></th>}
                            <th style={{ width: 1 }}><span className="sr-only">Actions</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.options.map((o, oi) => (
                            <tr key={o.id}>
                              <td style={{ whiteSpace: 'nowrap', padding: '4px 6px' }}>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                  <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${o.name} up`}
                                    disabled={oi === 0 || moving} onClick={() => moveRow('pos_options', g.options, oi, -1)}>↑</button>
                                  <button type="button" className="btn btn-ghost btn-icon" aria-label={`Move ${o.name} down`}
                                    disabled={oi === g.options.length - 1 || moving} onClick={() => moveRow('pos_options', g.options, oi, 1)}>↓</button>
                                </div>
                              </td>
                              <td>
                                <span style={{ whiteSpace: 'nowrap', fontWeight: 500, color: o.is_active ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{o.name}</span>
                                {o.kitchen_name && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>Ticket: {o.kitchen_name}</div>}
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{priceCell(g, o)}</td>
                              <td>
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                  {o.is_removal && <span className="badge-gray">Takes off</span>}
                                  {o.is_default && <span className="badge-gray">Pre-selected</span>}
                                  {!o.is_active && <span className="badge-gray">Hidden</span>}
                                </div>
                              </td>
                              <td style={{ fontSize: 12, color: 'var(--theme-text2)' }}>
                                {[o.diet ? DIET_LABEL[o.diet] : null, (o.allergens || []).length ? (o.allergens || []).join(', ') : null].filter(Boolean).join(' · ') || '—'}
                              </td>
                              {imsOn && (
                                <td style={{ fontSize: 12 }}>
                                  {o.ingredients.length
                                    ? <span style={{ color: 'var(--theme-text2)' }}>{o.ingredients.length} ingredient line{o.ingredients.length === 1 ? '' : 's'}</span>
                                    : <Tip width={260} text="Picking this option will not change stock or food cost. Fine for a free choice like spice level; for “Extra cheese” add the cheese.">
                                        <span style={{ color: 'var(--theme-amber-text)' }}>No ingredients</span>
                                      </Tip>}
                                </td>
                              )}
                              <td>
                                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                                  <button className="btn btn-ghost btn-sm" onClick={() => setOptionModal({ groupId: g.id, optionId: o.id })} aria-label={`Edit ${o.name}`}>Edit</button>
                                  <RowMenu label={`More for ${o.name}`} disabled={moving} items={[
                                    { key: 'hide', label: o.is_active ? 'Hide' : 'Show again', onSelect: () => toggleOptionActive(o) },
                                    '-',
                                    { key: 'delete', label: 'Delete…', danger: true, onSelect: () => deleteOption(o) },
                                  ]} />
                                </div>
                              </td>
                            </tr>
                          ))}
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
                    <th style={{ textAlign: 'right' }}><Tip width={200} text={vatReg ? 'Menu price including VAT.' : 'Menu price.'}>Price</Tip></th>
                    <th><Tip width={240} text="The option groups this dish offers, in the order the picker shows them.">Choices</Tip></th>
                    <th style={{ width: 1 }}><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDishes.map(d => {
                    const attached = (groupsByDish[d.id] || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0))
                    return (
                      <tr key={d.id}>
                        <td>
                          <span style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{d.name}</span>
                          {byoSet.has(d.id) && (
                            <Tip width={260} text="Build-your-own: the till always opens this dish's choices, and the QR menu walks them one step at a time." style={{ display: 'inline-flex', borderBottom: 'none', cursor: 'default', marginLeft: 6 }}>
                              <span className="badge-gray">Build-your-own</span>
                            </Tip>
                          )}
                          <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>
                            {d.category || 'No category'}{d.pos_enabled ? '' : ' · not on POS'}
                          </div>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{d.inclPrice > 0 ? npr(d.inclPrice) : '—'}</td>
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
                            <button className="btn btn-ghost btn-sm" onClick={() => setAttachFor(d)} disabled={catalog.groups.length === 0}
                              aria-label={`Choices for ${d.name}`}
                              title={catalog.groups.length === 0 ? 'Create an option group first' : undefined}>
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
      </div>

      {groupModal && (
        <OptionGroupModal
          group={groupModal.group}
          attachedCount={groupModal.group ? (attachCountByGroup[groupModal.group.id] || 0) : 0}
          nextSort={Math.max(-1, ...catalog.groups.map(g => g.sort || 0)) + 1}
          onClose={() => setGroupModal(null)}
          onSaved={saved => {
            setGroupModal(null)
            flash(groupModal.group ? `“${saved?.name}” was saved.` : `“${saved?.name}” was created — now add its options with + Option.`)
            load({ quiet: true })
          }}
        />
      )}

      {openGroup && (
        <OptionModal
          key={openOption?.id || 'new'}
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
        <AttachGroupsModal recipe={attachFor} onClose={() => setAttachFor(null)}
          onSaved={n => { load({ quiet: true }); flash(n ? `${attachFor.name} now offers ${n} group${n === 1 ? '' : 's'}.` : `${attachFor.name} now orders with no choices.`) }} />
      )}

      {templateOpen && (
        <BuildYourOwnTemplateModal
          dishes={dishes}
          buildYourOwn={catalog.buildYourOwn || []}
          groupNames={catalog.groups.map(g => g.name)}
          onClose={() => setTemplateOpen(false)}
          onSaved={({ dish }) => {
            setTemplateOpen(false)
            load({ quiet: true })
            flash(`${dish?.name || 'The dish'} now has Size, Base, Sauces and Toppings. Add the bases, sauces and toppings with + Option, then set the prices.`)
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
