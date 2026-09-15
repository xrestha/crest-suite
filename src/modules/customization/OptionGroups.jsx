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
import ReportLoadError from '../../components/ReportLoadError'
import ActionError, { asActionError } from '../../components/ActionError'
import { loadOptionCatalog, KIND_LABEL, DIET_LABEL } from './customizationData'
import { STANDARD_VAT, inclFromEx, ruleText, signedPrice } from '../../shared/optionPricing'
import OptionGroupModal from './OptionGroupModal'
import OptionModal from './OptionModal'
import AttachGroupsModal from './AttachGroupsModal'

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

const vatOf = r => (r.vat_rate === null || r.vat_rate === undefined) ? 0.13 : Number(r.vat_rate)

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
  const [notice, setNotice] = useState('')
  const [search, setSearch] = useState('')

  const [groupModal, setGroupModal] = useState(null)   // { group? }
  const [optionModal, setOptionModal] = useState(null) // { groupId, optionId? }
  const [attachFor, setAttachFor] = useState(null)     // dish

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

  const flash = text => { setNotice(text); window.setTimeout(() => setNotice(n => (n === text ? '' : n)), 6000) }

  function dishesForGroup(groupId) {
    return catalog.attachments.filter(a => a.group_id === groupId).map(a => dishById.get(a.recipe_id)).filter(Boolean)
  }

  async function toggleGroupActive(g) {
    setPageError(null)
    const { data, error } = await scopedUpdate('pos_option_groups', { is_active: !g.is_active }).eq('id', g.id).select('id')
    if (error) { setPageError(asActionError(error)); return }
    if (!data?.length) { setPageError('That group no longer exists — reload the page.'); return }
    flash(g.is_active ? `“${g.name}” is hidden from the till and guest menu.` : `“${g.name}” is offered again.`)
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
              ? <>It is attached to <strong>{n} dish{n === 1 ? '' : 'es'}</strong>. Those dishes will stop offering it, and its {g.options.length} option{g.options.length === 1 ? '' : 's'} and their stock lines are deleted with it.</>
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
      body: <p style={{ margin: 0 }}>It stops being offered on every dish in its group{o.ingredients.length ? ', and its stock lines are deleted with it' : ''}. Bills already rung keep it. To stop offering it for now, untick “Offer this option” instead.</p>,
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

  const openGroup = optionModal ? groupRows.find(g => g.id === optionModal.groupId) : null
  const openOption = openGroup && optionModal.optionId ? openGroup.options.find(o => o.id === optionModal.optionId) : null

  return (
    <div className="page-container">
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Option Groups</h1>
          <p className="page-subtitle">
            Build the choices guests can make — sizes, add-ons, removals and spice — then attach them to the dishes that offer them.
          </p>
        </div>
        {tab === 'groups' && !loading && !loadError && (
          <button className="btn btn-primary" onClick={() => setGroupModal({})}>+ New Group</button>
        )}
      </div>

      {isAdmin && clientModules && !clientModules.customization && (
        <div role="status" className="card" style={{ borderColor: 'color-mix(in srgb, var(--theme-amber) 35%, transparent)', background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)', marginBottom: 16 }}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>Crest Customization is off for this client.</strong>{' '}
          <span style={{ color: 'var(--theme-text2)' }}>You can prepare groups now; nothing is offered on the till or guest menu until it is switched on in Admin → Clients.</span>
        </div>
      )}

      <div className="tab-bar" role="tablist" aria-label="Option Groups views">
        {[['groups', 'Groups'], ['dishes', 'Dishes']].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab-btn${tab === k ? ' tab-btn--active' : ''}`} onClick={() => setTab(k)}>
            {label}
            {!loading && !loadError && (
              <span style={{ fontSize: 11, opacity: 0.65, marginLeft: 6 }}>
                {k === 'groups' ? catalog.groups.length : `${customizableCount}/${dishes.length}`}
              </span>
            )}
          </button>
        ))}
      </div>

      <ActionError error={pageError} className="action-error--top" />
      {notice && <p role="status" style={{ fontSize: 13, color: 'var(--theme-green-text)', margin: '0 0 12px' }}>{notice}</p>}

      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : tab === 'groups' ? (
        groupRows.length === 0 ? (
          <div className="empty-state">
            <p style={{ margin: '0 0 8px' }}>No option groups yet.</p>
            <p style={{ margin: 0, color: 'var(--theme-text2)' }}>
              Start with the choices your menu already has — for example <strong>Size</strong> (Half / Full), <strong>Extras</strong> (Extra cheese, Add egg), <strong>Remove</strong> (No onion) and <strong>Spice</strong> (Mild / Medium / Hot).
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {groupRows.map(g => {
              const onDishes = attachCountByGroup[g.id] || 0
              return (
                <section key={g.id} className="card" aria-labelledby={`grp-${g.id}`} style={{ margin: 0, opacity: g.is_active ? 1 : 0.75 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
                    <h2 id={`grp-${g.id}`} style={{ margin: 0, fontSize: 16 }}>{g.name}</h2>
                    <span className="badge-yellow">{KIND_LABEL[g.kind]}</span>
                    {!g.is_active && <span className="badge-gray">Hidden</span>}
                    <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{ruleText({ min: g.min_select, max: g.max_select, included: g.included_count })}</span>
                    <Tip width={260} text={onDishes ? `Offered on: ${dishesForGroup(g.id).map(d => d.name).join(', ')}` : 'Not attached to any dish yet — use the Dishes tab, or Customize on Menu Pricing.'}>
                      <span style={{ fontSize: 12, color: onDishes ? 'var(--theme-text2)' : 'var(--theme-amber-text)' }}>
                        {onDishes ? `On ${onDishes} dish${onDishes === 1 ? '' : 'es'}` : 'Not on any dish'}
                      </span>
                    </Tip>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button className="btn btn-primary btn-sm" onClick={() => setOptionModal({ groupId: g.id })}>+ Option</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setGroupModal({ group: g })}>Edit</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => toggleGroupActive(g)}>{g.is_active ? 'Hide' : 'Show'}</button>
                      <button className="btn btn-danger btn-sm" onClick={() => deleteGroup(g)}>Delete</button>
                    </div>
                  </div>

                  {g.options.length === 0 ? (
                    <p style={{ margin: 0, fontSize: 13, color: 'var(--theme-text2)' }}>No options yet — add the first one with <strong>+ Option</strong>.</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th><Tip width={220} text="What guests and waiters tap. The kitchen ticket name, if set, is shown under it.">Option</Tip></th>
                            <th style={{ textAlign: 'right' }}>
                              <Tip width={260} text={g.kind === 'size'
                                ? 'For a size group on dishes that all cost the same, the full price of that size. Otherwise, how much it adds or takes off.'
                                : `What guests pay on top of the dish${vatReg ? ', including VAT' : ''}.`}>Price</Tip>
                            </th>
                            <th><Tip width={220} text="Pre-selected options are ticked when the picker opens. Removals print as NO on the kitchen ticket.">Marks</Tip></th>
                            <th><Tip width={220} text="What guests see beside the option on the QR menu.">Diet &amp; allergens</Tip></th>
                            {imsOn && <th><Tip width={260} text="What picking this option does to stock and food cost, per plate.">Stock</Tip></th>}
                            <th style={{ width: 1 }}><span className="sr-only">Actions</span></th>
                          </tr>
                        </thead>
                        <tbody>
                          {g.options.map(o => (
                            <tr key={o.id} style={{ opacity: o.is_active ? 1 : 0.6 }}>
                              <td>
                                <span style={{ whiteSpace: 'nowrap', fontWeight: 500 }}>{o.name}</span>
                                {o.kitchen_name && <div style={{ fontSize: 11, color: 'var(--theme-text3)' }}>Ticket: {o.kitchen_name}</div>}
                              </td>
                              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{priceCell(g, o)}</td>
                              <td>
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                  {o.is_removal && <span className="badge-gray">Removal</span>}
                                  {o.is_default && <span className="badge-yellow">Pre-selected</span>}
                                  {!o.is_active && <span className="badge-gray">Not offered</span>}
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
                                <div style={{ display: 'flex', gap: 4 }}>
                                  <button className="btn btn-ghost btn-sm" onClick={() => setOptionModal({ groupId: g.id, optionId: o.id })} aria-label={`Edit ${o.name}`}>Edit</button>
                                  <button className="btn btn-ghost btn-sm" onClick={() => toggleOptionActive(o)} aria-label={`${o.is_active ? 'Stop offering' : 'Offer'} ${o.name}`}>{o.is_active ? 'Hide' : 'Show'}</button>
                                  <button className="btn btn-danger btn-sm" onClick={() => deleteOption(o)} aria-label={`Delete ${o.name}`}>Delete</button>
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
                    <th><Tip width={240} text="The option groups this dish offers, in the order the picker shows them.">Groups</Tip></th>
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
                          ) : <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>No choices</span>}
                        </td>
                        <td>
                          <button className="btn btn-ghost btn-sm" onClick={() => setAttachFor(d)} disabled={catalog.groups.length === 0}
                            title={catalog.groups.length === 0 ? 'Create an option group first' : undefined}>
                            Choose groups
                          </button>
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

      {groupModal && (
        <OptionGroupModal
          group={groupModal.group}
          nextSort={Math.max(-1, ...catalog.groups.map(g => g.sort || 0)) + 1}
          onClose={() => setGroupModal(null)}
          onSaved={saved => {
            setGroupModal(null)
            flash(groupModal.group ? `“${saved?.name}” was saved.` : `“${saved?.name}” was created — add its options with + Option.`)
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
            if (opts?.keepOpen) setOptionModal({ groupId: openGroup.id, optionId: saved.id })
            else { setOptionModal(null); flash(`“${saved.name}” was saved.`) }
          }}
        />
      )}

      {attachFor && (
        <AttachGroupsModal recipe={attachFor} onClose={() => setAttachFor(null)} onSaved={() => load({ quiet: true })} />
      )}

      {confirmEl}
    </div>
  )
}
