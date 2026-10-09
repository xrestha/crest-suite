import { useCallback, useEffect, useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import { pointsValue, isDeliveryPartnerPhone, schemeNumberCommit } from './loyaltyPoints'
import { errorLine } from '../../../shared/errorText'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import AdjustPointsModal from './AdjustPointsModal'

// Loyalty & Rewards — schemes, who is enrolled, and each member's balance (S618).
//
// Its own file rather than a fourth section of PosCustomers.jsx, which is already 559 lines: this
// panel owns its own data and reports nothing back, so it is the "self-contained sub-component"
// case in the splitting rule rather than the tangled-state one.
//
// Two things about the shape are deliberate and worth not undoing:
//
//   * A customer belongs to exactly ONE scheme, or none. Untagged earns nothing, so enrolment is
//     opt-in per person — flipping the feature on does not start accruing points for an entire
//     existing customer book.
//   * A scheme sets the earn RATE and a minimum spend, and nothing else. What a point is WORTH is
//     one client-level number (POS Setup → Loyalty), because schemes differing in both
//     directions is a thing no cashier can explain at the till.
//
// Who may change it (S754, owner decision): schemes, the point value and who is enrolled are set by
// a POS manager or the Owner — the database refuses anyone else (loyalty_rank, loyalty_enrol_rank,
// pos_setup_rank). A supervisor still opens this tab to look a balance up, so it renders read-only
// for them with one line saying who can change it, rather than as controls that each fail.
//
// `pointValue` is null until the outlet's settings were read (S809 2g): the box stays empty, Save waits,
// and the Worth column shows nothing, rather than a guessed NPR 1 a manager could save over the real
// value. `pointValueError` is the failed read, when there was one.
//
// S809 3k (owner decision Q13 b): the Owner and POS managers add or take off points by hand here
// (Adjust, AdjustPointsModal → adjust_loyalty_points), the place every till message about points that
// did not land now names. `deliveryPartners` is settings.pos_delivery_partners: a partner's row is in
// the book only because picking it puts its name and phone on a bill, so it is shown as a partner and
// never offered for enrolment or for added points (2g: a partner neither earns nor spends).
export default function LoyaltyTab({ pointValue, pointValueError = null, onPointValueSaved, canManage = false, deliveryPartners = [] }) {
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()

  const [schemes, setSchemes] = useState([])
  const [members, setMembers] = useState([])
  const [balances, setBalances] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [msg, setMsg] = useState('')
  const [search, setSearch] = useState('')
  const [adjusting, setAdjusting] = useState(null) // the member whose points are being adjusted

  const [newName, setNewName] = useState('')
  const [newRate, setNewRate] = useState('1')
  const [newMin, setNewMin] = useState('0')
  const [savingScheme, setSavingScheme] = useState(false)
  const [valueStr, setValueStr] = useState(pointValue == null ? '' : String(pointValue))
  const [savingValue, setSavingValue] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const [schemeRes, custRes] = await Promise.all([
      scopedFrom('pos_loyalty_schemes', 'id, name, points_per_100, min_spend_to_earn, is_active').order('name'),
      // S809 3k (CUSTOMERS-PARKING-8): paged. A bare select stopped at 1,000 customers with no error, so
      // anyone past "R" could not be enrolled and every count read low. The id breaks ties between
      // customers of the same name, so no one is skipped or repeated across pages.
      fetchAllRows(() => scopedFrom('pos_customers', 'id, name, phone, loyalty_scheme_id').order('name').order('id')),
    ])
    // A failed read must not render as "no schemes yet" — that reads as a correct empty state and
    // would have someone re-create schemes that already exist (S594).
    if (schemeRes.error || custRes.error) {
      setLoadError(schemeRes.error || custRes.error)
      setSchemes([]); setMembers([]); setLoading(false)
      return
    }
    setSchemes(schemeRes.data || [])
    setMembers(custRes.data || [])

    // One read for every ledger row, summed per customer here. Paged, because this is the whole
    // client's ledger rather than one customer's and it grows with every bill ever rung.
    const { data: rows, error: ledErr } = await fetchAllRows(() =>
      scopedFrom('pos_loyalty_ledger', 'customer_id, points').order('id'))
    if (ledErr) { setLoadError(ledErr); setLoading(false); return }
    const byCustomer = {}
    for (const r of rows || []) byCustomer[r.customer_id] = (byCustomer[r.customer_id] || 0) + (r.points || 0)
    setBalances(byCustomer)
    setLoading(false)
  }, [scopedFrom])

  useEffect(() => { load() }, [load])
  useEffect(() => { setValueStr(pointValue == null ? '' : String(pointValue)) }, [pointValue])

  async function addScheme() {
    const name = newName.trim()
    if (!name || !canManage) return
    // S809 3k (CUSTOMERS-PARKING-12): a cleared rate box used to add a scheme that earns nothing.
    if (newRate.trim() === '' || !(Number(newRate) >= 0)) { setMsg('error:Enter how many points a member earns per NPR 100, for example 1.'); return }
    setSavingScheme(true)
    setMsg('')
    const { error } = await scopedInsert('pos_loyalty_schemes', {
      name,
      points_per_100: Number(newRate) || 0,
      min_spend_to_earn: Number(newMin) || 0,
    })
    setSavingScheme(false)
    if (error) { setMsg(`error:The scheme was not added. ${errorLine(error)}`); return }
    setNewName(''); setNewRate('1'); setNewMin('0')
    await load()
  }

  // Returns whether the change was stored, so a scheme's box can go back to the stored value when it
  // was not (S809 3k, CUSTOMERS-PARKING-12).
  async function patchScheme(id, patch) {
    if (!canManage) return false
    setMsg('')
    const { error } = await scopedUpdate('pos_loyalty_schemes', patch).eq('id', id)
    // An optimistic paint that drops the error shows as saved what the database refused (S613).
    if (error) { setMsg(`error:That change was not saved — the box shows what is stored again. ${errorLine(error)}`); return false }
    await load()
    return true
  }

  function removeScheme(s) {
    const enrolled = members.filter(m => m.loyalty_scheme_id === s.id).length
    askConfirm({
      title: `Delete the "${s.name}" scheme?`,
      confirmLabel: 'Delete Scheme', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          {enrolled > 0
            ? <>The <strong>{enrolled} customer{enrolled === 1 ? '' : 's'}</strong> enrolled in it stop earning points from their next bill.</>
            : 'No customers are enrolled in it.'}{' '}
          Points already earned are kept and can still be redeemed. This cannot be undone.
        </p>
      ),
      run: async () => {
        const { error } = await scopedDelete('pos_loyalty_schemes').eq('id', s.id)
        if (error) { setMsg(`error:"${s.name}" was not deleted — it is still active. ${errorLine(error)}`); return }
        await load()
      },
    })
  }

  async function tag(customerId, schemeId) {
    if (!canManage) return
    setMsg('')
    const { error } = await scopedUpdate('pos_customers', { loyalty_scheme_id: schemeId || null }).eq('id', customerId)
    if (error) { setMsg(`error:The enrolment was not changed. ${errorLine(error)}`); return }
    setMembers(prev => prev.map(m => m.id === customerId ? { ...m, loyalty_scheme_id: schemeId || null } : m))
  }

  async function savePointValue() {
    setSavingValue(true)
    setMsg('')
    const v = Number(valueStr)
    if (!Number.isFinite(v) || v <= 0) { setSavingValue(false); setMsg('error:A point has to be worth more than zero.'); return }
    const failure = await onPointValueSaved(v)
    setSavingValue(false)
    // A string is a sentence the page wrote; anything else is a Supabase error to word (S754).
    if (failure) setMsg(`error:The point value was not changed. ${typeof failure === 'string' ? failure : errorLine(failure)}`)
  }

  // A hand correction landed: the balance is the one the server returned, never a sum worked out here.
  function onAdjusted(member, newBalance, change) {
    setAdjusting(null)
    setBalances(prev => ({ ...prev, [member.id]: newBalance }))
    const n = Math.abs(change).toLocaleString('en-IN')
    setMsg(`ok:${change > 0 ? `${n} points added for` : `${n} points taken off`} ${member.name}. New balance: ${Number(newBalance).toLocaleString('en-IN')} points.`)
  }

  const enrolled = members.filter(m => m.loyalty_scheme_id)
  const q = search.trim().toLowerCase()
  const qDigits = q.replace(/\D/g, '')
  const shownMembers = !q ? members : members.filter(m =>
    String(m.name || '').toLowerCase().includes(q)
    || (qDigits.length >= 3 && String(m.phone || '').replace(/\D/g, '').includes(qDigits)))

  return (
    <div>
      {msg && (
        <p role="alert" style={{ fontSize: 12, margin: '0 0 12px', color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
          {msg.replace(/^(error|ok):/, '')}
        </p>
      )}

      {!canManage && (
        <p role="note" style={{ fontSize: 12, margin: '0 0 12px', color: 'var(--theme-text2)' }}>
          Balances are shown for looking a customer up. Schemes, the value of a point, who is enrolled and
          points added or taken off by hand are changed by a POS manager or the Owner.
        </p>
      )}

      {/* What a point is worth — one number for the whole outlet. */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="form-field" style={{ margin: 0, maxWidth: 320 }}>
          <label htmlFor="loyalty-point-value">
            <Tip text="What one point takes off a bill when it is redeemed. Schemes differ in how fast points are earned; everyone redeems at this same value, so staff only ever have to explain one rate." width={320}>
              Value of one point (NPR)
            </Tip>
          </label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              id="loyalty-point-value" type="number" min="0.01" step="0.01"
              className="form-input" value={valueStr}
              onChange={e => setValueStr(e.target.value)}
              readOnly={!canManage || pointValue == null}
            />
            {canManage && (
              <button className="btn btn-ghost" onClick={savePointValue} disabled={savingValue || pointValue == null}>
                {savingValue ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
          {pointValueError && (() => {
            const why = asActionError(pointValueError, 'operator')
            return <ActionError error={{ text: `This outlet’s point value could not be read, so the box is left empty, the Worth column shows nothing and Save waits. Reload the page to try again. ${why.text}`, detail: why.detail }} />
          })()}
        </div>
      </div>

      {loading ? (
        <p role="status" aria-live="polite" style={{ color: 'var(--theme-text2)', fontSize: 13 }}>Loading loyalty…</p>
      ) : loadError ? (
        <ReportLoadError error={loadError} />
      ) : (
        <>
          {/* ── Schemes ── */}
          <div className="card" style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Schemes</h3>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
              How fast a member earns. A customer belongs to one scheme at a time.
            </p>

            {schemes.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Scheme</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="Points earned per NPR 100 of the bill, measured before VAT and after any discount — the same base the rest of POS uses.">Points / NPR 100</Tip>
                      </th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="A bill below this earns nothing. Once a bill qualifies, the whole bill earns — the minimum is a qualifier, not an amount deducted first.">Min. spend</Tip>
                      </th>
                      <th style={{ textAlign: 'center' }}>Active</th>
                      <th style={{ textAlign: 'right' }}>Members</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {schemes.map(s => (
                      <tr key={s.id}>
                        <td>{s.name}</td>
                        <td style={{ textAlign: 'right' }}>
                          <SchemeNumberInput
                            stored={s.points_per_100} step="0.1" width={80}
                            label={`Points per NPR 100 for ${s.name}`} canManage={canManage}
                            onSave={v => patchScheme(s.id, { points_per_100: v })} onInvalid={t => setMsg(`error:${t}`)}
                          />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <SchemeNumberInput
                            stored={s.min_spend_to_earn} step="1" width={90}
                            label={`Minimum spend to earn for ${s.name}`} canManage={canManage}
                            onSave={v => patchScheme(s.id, { min_spend_to_earn: v })} onInvalid={t => setMsg(`error:${t}`)}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox" checked={s.is_active}
                            aria-label={`${s.name} is active`}
                            disabled={!canManage}
                            onChange={() => patchScheme(s.id, { is_active: !s.is_active })}
                          />
                        </td>
                        <td style={{ textAlign: 'right' }}>{members.filter(m => m.loyalty_scheme_id === s.id).length}</td>
                        <td style={{ textAlign: 'right' }}>
                          {canManage && <button className="btn btn-ghost btn-sm" onClick={() => removeScheme(s)}>Delete</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {!canManage && schemes.length === 0 && (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13, margin: 0 }}>No schemes yet — a POS manager or the Owner adds them.</p>
            )}
            {canManage && <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: schemes.length ? 14 : 0 }}>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="new-scheme-name">Name</label>
                <input id="new-scheme-name" className="form-input" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Regulars" />
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="new-scheme-rate">Points / NPR 100</label>
                <input id="new-scheme-rate" type="number" min="0" step="0.1" className="form-input" style={{ width: 120 }} value={newRate} onChange={e => setNewRate(e.target.value)} />
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="new-scheme-min">Min. spend</label>
                <input id="new-scheme-min" type="number" min="0" step="1" className="form-input" style={{ width: 120 }} value={newMin} onChange={e => setNewMin(e.target.value)} />
              </div>
              <button className="btn btn-primary" onClick={addScheme} disabled={savingScheme || !newName.trim()}>
                {savingScheme ? 'Adding…' : '+ Add scheme'}
              </button>
            </div>}
          </div>

          {/* ── Members ── */}
          <div className="card">
            <h3 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: 'var(--theme-text1)' }}>Who is enrolled</h3>
            <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--theme-text2)' }}>
              {enrolled.length} of {members.length} customer{members.length === 1 ? '' : 's'} enrolled. Anyone left on “Not enrolled” earns nothing.
            </p>
            {members.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>
                No customers yet — the book fills itself from any bill closed with a name and phone.
              </p>
            ) : schemes.length === 0 ? (
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>{canManage ? 'Add a scheme above before enrolling anyone.' : 'Nobody can be enrolled until a scheme exists.'}</p>
            ) : (
              <>
              <div className="form-field" style={{ margin: '0 0 10px', maxWidth: 320 }}>
                <label htmlFor="loyalty-member-search">Find a customer</label>
                <input id="loyalty-member-search" type="search" className="form-input" value={search}
                  onChange={e => setSearch(e.target.value)} placeholder="Name or phone" autoComplete="off" />
              </div>
              {q && (
                <p role="status" style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--theme-text2)' }}>
                  {shownMembers.length === 0 ? 'No customer matches.' : `Showing ${shownMembers.length} of ${members.length}.`}
                </p>
              )}
              {shownMembers.length > 0 && (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Scheme</th>
                      <th style={{ textAlign: 'right' }}>Points</th>
                      <th style={{ textAlign: 'right' }}>Worth</th>
                      {canManage && (
                        <th style={{ textAlign: 'right' }}>
                          <Tip text="Add points by hand (a bill whose points did not reach the till, a goodwill gift) or take them off (a mistake, or points moving to the guest's new number: take them off here, then add them on the new number). A reason is kept with every change. The Owner and POS managers only." width={340}>
                            Adjust
                          </Tip>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {shownMembers.map(m => {
                      const bal = balances[m.id] || 0
                      const partner = isDeliveryPartnerPhone(m.phone, deliveryPartners)
                      return (
                        <tr key={m.id}>
                          <td>{m.name}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{m.phone}</td>
                          <td>
                            {partner ? (
                              // S809 2g/3k: a delivery partner earns and spends nothing, so it is never enrolled.
                              // One still on a scheme from before can be taken off it.
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <Tip text="A delivery platform (Foodmandu, Pathao and the like) owes its bills and pays later, so it does not earn or spend points. It is in this list only because picking it on a bill puts its name and phone there." width={320}>
                                  <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Delivery partner — earns no points</span>
                                </Tip>
                                {m.loyalty_scheme_id && canManage && (
                                  <button className="btn btn-ghost btn-sm" onClick={() => tag(m.id, '')}>Take off scheme</button>
                                )}
                              </span>
                            ) : (
                              <select
                                className="form-select" style={{ maxWidth: 200 }}
                                value={m.loyalty_scheme_id || ''}
                                aria-label={`Loyalty scheme for ${m.name}`}
                                disabled={!canManage}
                                onChange={e => tag(m.id, e.target.value)}
                              >
                                <option value="">Not enrolled</option>
                                {schemes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                              </select>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: bal > 0 ? 700 : 400, color: bal > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text3)' }}>{bal}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                            {bal > 0 && pointValue != null ? `NPR ${pointsValue(bal, pointValue).toLocaleString('en-IN')}` : '—'}
                          </td>
                          {canManage && (
                            <td style={{ textAlign: 'right' }}>
                              {/* A partner can only lose points, so it is offered only while it holds some. */}
                              {(!partner || bal > 0) && (
                                <button className="btn btn-ghost btn-sm" onClick={() => { setMsg(''); setAdjusting(m) }}
                                  aria-label={`Adjust points for ${m.name}`}>Adjust</button>
                              )}
                            </td>
                          )}
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
        </>
      )}
      {adjusting && (
        <AdjustPointsModal
          customer={adjusting}
          balance={balances[adjusting.id] || 0}
          pointValue={pointValue}
          isPartner={isDeliveryPartnerPhone(adjusting.phone, deliveryPartners)}
          onClose={() => setAdjusting(null)}
          onAdjusted={(newBalance, change) => onAdjusted(adjusting, newBalance, change)}
        />
      )}
      {confirmEl}
    </div>
  )
}

// A scheme's rate or minimum box (S809 3k, CUSTOMERS-PARKING-12). Controlled and seeded from the stored
// value, so a change the database refused goes back to what is stored instead of staying on screen; a
// cleared box keeps the stored value instead of saving 0 (which stopped a scheme earning, or dropped its
// minimum); Enter saves like leaving the box.
function SchemeNumberInput({ stored, step, width, label, canManage, onSave, onInvalid }) {
  const [value, setValue] = useState(stored == null ? '' : String(stored))
  const [saving, setSaving] = useState(false)
  useEffect(() => { setValue(stored == null ? '' : String(stored)) }, [stored])

  async function commit() {
    const r = schemeNumberCommit(value, stored)
    if (r.action === 'keep') { setValue(stored == null ? '' : String(stored)); return }
    if (r.action === 'invalid') { onInvalid(r.text); setValue(stored == null ? '' : String(stored)); return }
    setSaving(true)
    const ok = await onSave(r.value)
    setSaving(false)
    if (!ok) setValue(stored == null ? '' : String(stored))
  }

  return (
    <input
      type="number" min="0" step={step} value={value}
      className="form-input form-input--auto" style={{ width, textAlign: 'right' }}
      aria-label={label} aria-busy={saving || undefined}
      disabled={!canManage || saving}
      onChange={e => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
    />
  )
}
