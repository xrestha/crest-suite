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
import ActionError, { asActionError } from '../../components/ActionError'
import { loadOptionCatalog, KIND_LABEL, DIET_LABEL } from './customizationData'
import { STANDARD_VAT, inclFromEx, ruleText, signedPrice } from '../../shared/optionPricing'
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

const TABS = [['groups', 'Groups'], ['dishes', 'Dishes']]

export default function OptionGroups() {
  const { isAdmin, isOwner, profile, clientId, clientModules } = useAuth()
  const { settings } = useSettings()
  const { scopedFrom, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask, confirmEl } = useConfirm()

  const imsOn = !!clientModules?.ims
  const vatReg = !!settings?.is_vat_registered
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
  const [optionModal, setOptionModal] = useState(null) // { groupId, optionId? }
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
    const [cat, ...rest] = await Promise.all([
      loadOptionCatalog(scopedFrom, { withIngredients: imsOn }),
      // Every active recipe. A NULL category is a dish (S714's .or form), and a sub-recipe is only
      // offered as an option ingredient, never as something to customize.
      fetchAllRows(() => scopedFrom('recipes', 'id, name, category, selling_price, vat_rate, pos_enabled, yield_uom')
        .not('is_active', 'is', false).order('name').order('id')),
      imsOn
        ? fetchAllRows(() => scopedFrom('items', 'id, name, uom').eq('is_sub_recipe', false)
          .not('is_active', 'is', false).order('name').order('id'))
        : Promise.resolve({ data: [], error: null }),
    ])
    if (seq !== loadSeq.current) return
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
    const [r1, r2] = await Promise.all([
      scopedUpdate(table, { sort: other }).eq('id', a.id).select('id'),
      scopedUpdate(table, { sort: idx }).eq('id', b.id).select('id'),
    ])
    setMoving(false)
    const err = r1.error || r2.error
    if (err) { setPageError(asActionError(err)); return }
    if (!r1.data?.length || !r2.data?.length) { setPageError('One of those rows no longer exists — reload the page.'); return }
    load({ quiet: true })
  }
  // Renumber first when two neighbours share a sort, otherwise the swap above is a no-op.
  async function moveRow(table, rows, idx, dir) {
    const dense = rows.every((r, i) => (r.sort || 0) === i)
    if (dense) return swapSort(table, rows, idx, dir)
    setMoving(true)
    setPageError(null)
    const results = await Promise.all(rows.map((r, i) => scopedUpdate(table, { sort: i }).eq('id', r.id).select('id')))
    const err = results.find(r => r.error)?.error
    if (err) { setMoving(false); setPageError(asActionError(err)); return }
    const renumbered = rows.map((r, i) => ({ ...r, sort: i }))
    setMoving(false)
    return swapSort(table, renumbered, idx, dir)
  }

  // ── Groups ──
  async function toggleGroupActive(g) {
    setPageError(null)
    const { data, error } = await scopedUpdate('pos_option_groups', { is_active: !g.is_active }).eq('id', g.id).select('id')
    if (error) { setPageError(asActionError(error)); return }
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
        const { data, error } = await scopedDelete('pos_option_groups').eq('id', g.id).select('id')
        if (error) { setPageError(asActionError(error)); return }
        if (!data?.length) { setPageError('That group was already gone — reload the page.'); return }
        flash(`“${g.name}” was deleted.`)
        await load({ quiet: true })
      },
    })
  }

  // ── Options ──
  async function toggleOptionActive(o) {
    setPageError(null)
    const { data, error } = await scopedUpdate('pos_options', { is_active: !o.is_active }).eq('id', o.id).select('id')
    if (error) { setPageError(asActionError(error)); return }
    if (!data?.length) { setPageError('That option no longer exists — reload the page.'); return }
    load({ quiet: true })
  }

  function deleteOption(o) {
    ask({
      title: `Delete “${o.name}”?`,
      danger: true,
      confirmLabel: 'Delete option',
      busyLabel: 'Deleting…',
      body: <p style={{ margin: 0 }}>It stops being offered on every dish in its group{o.ingredients.length ? ', and its stock lines are deleted with it' : ''}. Bills already rung keep it. To stop offering it for now, use Hide instead.</p>,
      run: async () => {
        setPageError(null)
        const { data, error } = await scopedDelete('pos_options').eq('id', o.id).select('id')
        if (error) { setPageError(asActionError(error)); return }
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
      if (prices.length === 1) return npr(Math.max(0, prices[0] + deltaIncl))
    }
    return signedPrice(deltaIncl) || <span style={{ color: 'var(--theme-text3)' }}>No charge</span>
  }

  async function toggleBuildYourOwn(d, on) {
    if (markBusy) return
    setMarkBusy(d.id)
    setPageError(null)
    const { data, error } = await scopedUpdate('recipes', { is_build_your_own: on }).eq('id', d.id).select('id')
    setMarkBusy(null)
    if (error) { setPageError(asActionError(error)); return }
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
        <ReportLoadError error={loadError} />
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
              return (
                <section key={g.id} className="card" aria-labelledby={`grp-${g.id}`} style={{ margin: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                    <h2 id={`grp-${g.id}`} style={{ margin: 0, fontSize: 16, color: g.is_active ? 'var(--theme-text1)' : 'var(--theme-text3)' }}>{g.name}</h2>
                    <span className="badge-yellow">{KIND_LABEL[g.kind]}</span>
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
                      The first {freeN} pick{freeN === 1 ? '' : 's'} a guest makes {freeN === 1 ? 'is' : 'are'} free — the <strong>earliest in this list</strong> among what they picked, not the cheapest. Put the options you are happy to give away first, with <em>Move up</em>.
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
                                  {o.is_default && <span className="badge-yellow">Pre-selected</span>}
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
                              <span className="badge-yellow">Build-your-own</span>
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
                              {attached.map(a => <span key={a.id} className="badge-yellow">{groupNameById.get(a.group_id) || '—'}</span>)}
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
          vat={entryVat}
          imsEnabled={imsOn}
          itemChoices={itemChoices}
          onClose={() => setOptionModal(null)}
          onSaved={async (saved, opts) => {
            await load({ quiet: true })
            if (opts?.keepOpen) { setOptionModal({ groupId: openGroup.id, optionId: saved.id }); return }
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
        <AttachToDishesModal group={attachGroup} dishes={dishes} attachments={catalog.attachments}
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
