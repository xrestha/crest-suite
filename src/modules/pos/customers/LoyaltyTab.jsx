import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../supabaseClient'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import RowMenu from '../../../components/RowMenu'
import ReportLoadError from '../../../components/ReportLoadError'
import ActionError, { asActionError } from '../../../components/ActionError'
import FieldError, { fieldAria } from '../../../components/FieldError'
import {
  pointsValue, isDeliveryPartnerPhone, schemeNumberCommit, spendablePoints, schemeGivesBack, nprPoints,
  GIVE_BACK_CONFIRM_PCT,
} from './loyaltyPoints'
import { errorLine } from '../../../shared/errorText'
import { phoneMatchesSearch } from '../../../utils/phone'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { settleWithin } from '../../../utils/withTimeout'
import { SETTLE_READ_MS } from './settleCredit'
import { customerBookAfterRead } from './customerBook'
import AdjustPointsModal from './AdjustPointsModal'
import PointsHistoryModal from './PointsHistoryModal'
import MovePointsModal from './MovePointsModal'

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
//
// S815 4g: each member's balance comes from pos_loyalty_balances with the part held on unpaid Credit
// bills (Q19 c: spendable once the bill is settled). History opens the whole points history and the
// one-tap "add the points this bill earned"; Move takes a regular's points to their new number. Each
// scheme says what it gives back in rupees, and a point value or rate that changes what customers get
// asks first, naming the consequence (CUSTOMERS-PARKING-10).
//
// S833 (S809.4 3k, owner decision 2026-10-13): with no scheme at all the member list still shows, with
// its points, History, Adjust and Move, under a note that nobody earns until a scheme is added. Points
// outlive the scheme they were earned under, and the list used to hide, so a balance left after every
// scheme was deleted could not be seen or corrected. None of pos_loyalty_balances, adjust_loyalty_points
// or move_loyalty_points asks for a scheme, and redeem at the till does not either.
//
// S834 (found S833): the tab's reads are bounded and its reloads cannot overlap (`book` below). History's
// one-tap award reloads through the same load; it used to read the balances alone, unguarded.

// How long this tab's reads wait before they count as failed: PosCustomers.jsx's two limits,
// mirrored because that page renders this one and cannot be imported back. The customer book and the
// balances are paged, so they get the list limit; the schemes are one short read.
const LIST_READ_MS = 20000
const ROW_READ_MS = SETTLE_READ_MS

// pos_loyalty_balances rows → each customer's balance and the part held on unpaid Credit bills.
function balancesOf(rows) {
  const balances = {}
  const held = {}
  for (const r of rows || []) { balances[r.customer_id] = Number(r.balance) || 0; held[r.customer_id] = Number(r.held) || 0 }
  return { balances, held }
}

export default function LoyaltyTab({ pointValue, pointValueError = null, onPointValueSaved, canManage = false, deliveryPartners = [] }) {
  const { clientId, scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()

  // S834 (found S833): the tab as last read, and for which outlet, in customerBook.js' shape: `rows` is
  // { schemes, members, balances, held } once a read has landed (held, S815 4g: points on unpaid
  // Credit bills, by customer). A failed first read is the error card, never figures from it; a reload
  // that fails (after an add, an edit, a move or a History award) keeps what is on screen and says so.
  // A load is keyed on its outlet plus a counter, so only the newest one lands.
  const [book, setBook] = useState({ clientId: null, rows: null, error: null, stale: null })
  const loadReq = useLatestRequest()
  const loadSeq = useRef(0)
  const [msg, setMsg] = useState('')
  const [search, setSearch] = useState('')
  const [adjusting, setAdjusting] = useState(null) // the member whose points are being adjusted
  const [viewing, setViewing] = useState(null)     // the member whose points history is open
  const [moving, setMoving] = useState(null)       // the member whose points are moving to a new number

  const [newName, setNewName] = useState('')
  const [nameMissing, setNameMissing] = useState(false) // S833: "+ Add scheme" was pressed with no name
  const [newRate, setNewRate] = useState('1')
  const [newMin, setNewMin] = useState('0')
  const [savingScheme, setSavingScheme] = useState(false)
  const [valueStr, setValueStr] = useState(pointValue == null ? '' : String(pointValue))
  const [savingValue, setSavingValue] = useState(false)

  // Still loading until a read has landed for this outlet: a reload leaves the tab on screen.
  const loading = !clientId || book.clientId !== clientId
  const loadError = book.error
  const { schemes = [], members = [], balances = {}, held = {} } = book.rows || {}

  const load = useCallback(async () => {
    if (!clientId) return
    const forClient = clientId
    const key = loadReq.begin(`${forClient}#${++loadSeq.current}`) // before any await
    // The three reads go together (the balances used to wait for the other two), each bounded, so a
    // hung one is a failed read rather than "Loading loyalty…" for ever.
    const [schemeRes, custRes, balRes] = await Promise.all([
      settleWithin(scopedFrom('pos_loyalty_schemes', 'id, name, points_per_100, min_spend_to_earn, is_active').order('name'),
        ROW_READ_MS, 'Reading the loyalty schemes'),
      // S809 3k (CUSTOMERS-PARKING-8): paged. A bare select stopped at 1,000 customers with no error, so
      // anyone past "R" could not be enrolled and every count read low. The id breaks ties between
      // customers of the same name, so no one is skipped or repeated across pages.
      settleWithin(fetchAllRows(() => scopedFrom('pos_customers', 'id, name, phone, loyalty_scheme_id, loyalty_enrolled_at').order('name').order('id')),
        LIST_READ_MS, 'Reading the customer book'),
      // S815 4g: summed by the server, one row per customer with points history, with the part held on
      // unpaid Credit bills. Paged: a set-returning call stops at 1,000 rows like any read, and the id
      // is unique per row.
      settleWithin(fetchAllRows(() => supabase.rpc('pos_loyalty_balances', { p_client_id: forClient }).order('customer_id')),
        LIST_READ_MS, 'Reading the points balances'),
    ])
    if (!loadReq.isCurrent(key)) return // a newer load owns the tab
    // A failed read must not render as "no schemes yet" — that reads as a correct empty state and
    // would have someone re-create schemes that already exist (S594).
    const error = schemeRes.error || custRes.error || balRes.error
    if (error) console.error('loyalty read failed:', error)
    const data = error ? null : { schemes: schemeRes.data || [], members: custRes.data || [], ...balancesOf(balRes.data) }
    setBook(prev => customerBookAfterRead(prev, forClient, { data, error }))
  }, [clientId, scopedFrom, loadReq]) // loadReq is the same object every render

  useEffect(() => { load() }, [load])
  useEffect(() => { setValueStr(pointValue == null ? '' : String(pointValue)) }, [pointValue])

  // CUSTOMERS-PARKING-10: a rate that gives back half a bill or more asks first, saying what it gives
  // back. Returns false when it asked, so the caller leaves the stored value on screen meanwhile.
  function askIfGenerous(rate, schemeName, save) {
    const back = schemeGivesBack(rate, pointValue)
    if (back == null || back < GIVE_BACK_CONFIRM_PCT) return true
    askConfirm({
      title: `Give back ${back}% of every bill?`,
      confirmLabel: 'Save the rate', busyLabel: 'Saving…',
      body: (
        <p style={{ margin: 0 }}>
          At {rate} points per NPR 100 and {nprPoints(pointValue)} a point, a member of “{schemeName}” gets{' '}
          <strong>{nprPoints(back)} back for every NPR 100</strong> they spend: {back}% of each qualifying bill,
          spendable on their next visit.
        </p>
      ),
      run: save,
    })
    return false
  }

  async function addScheme() {
    const name = newName.trim()
    if (!canManage || savingScheme) return
    // S833 (S809.4 3k): the S759 pattern. The button used to sit greyed out with no reason; a press now
    // says what is missing and moves to the box.
    if (!name) { setNameMissing(true); document.getElementById('new-scheme-name')?.focus(); return }
    // S809 3k (CUSTOMERS-PARKING-12): a cleared rate box used to add a scheme that earns nothing.
    if (newRate.trim() === '' || !(Number(newRate) >= 0)) { setMsg('error:Enter how many points a member earns per NPR 100, for example 1.'); return }
    if (!askIfGenerous(Number(newRate), name, insertScheme)) return
    await insertScheme()
  }

  async function insertScheme() {
    const name = newName.trim()
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
    // S815 4g: the stored row comes back, because the server dates a join (loyalty_enrolled_at) and the
    // customer's History offers only bills since then.
    const { data, error } = await scopedUpdate('pos_customers', { loyalty_scheme_id: schemeId || null }).eq('id', customerId)
      .select('loyalty_scheme_id, loyalty_enrolled_at')
    if (error) { setMsg(`error:The enrolment was not changed. ${errorLine(error)}`); return }
    if (!data?.length) { setMsg('error:The enrolment was not changed — this customer is not in the book any more. Reload the page.'); return }
    setBook(prev => (prev.rows
      ? { ...prev, rows: { ...prev.rows, members: prev.rows.members.map(m => m.id === customerId ? { ...m, ...data[0] } : m) } }
      : prev))
  }

  // A scheme's rate box: a rate that gives back half a bill or more asks first (CUSTOMERS-PARKING-10).
  function saveRate(s, v) {
    if (!askIfGenerous(v, s.name, () => patchScheme(s.id, { points_per_100: v }))) return false
    return patchScheme(s.id, { points_per_100: v })
  }

  // CUSTOMERS-PARKING-10: the point value re-prices every balance at once and changes what every scheme
  // gives back, so a change asks first and says both. It used to save on the press.
  function savePointValue() {
    setMsg('')
    const v = Number(valueStr)
    if (!Number.isFinite(v) || v <= 0) { setMsg('error:A point has to be worth more than zero.'); return }
    if (pointValue != null && v === Number(pointValue)) return
    const total = Object.values(balances).reduce((s, n) => s + Math.max(0, n || 0), 0)
    const active = schemes.filter(s => s.is_active)
    askConfirm({
      title: `Make one point worth ${nprPoints(v)}?`,
      confirmLabel: 'Change the value', busyLabel: 'Saving…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            {total > 0
              ? <>Customers hold <strong>{total.toLocaleString('en-IN')} points</strong>, worth {nprPoints(pointsValue(total, pointValue))} now and <strong>{nprPoints(pointsValue(total, v))}</strong> after this change. Every balance changes at once, and the next redemption at any till pays out at the new value.</>
              : <>No customer holds points yet. The next redemption at any till pays out at the new value.</>}
          </p>
          {active.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {active.map(s => {
                const back = schemeGivesBack(s.points_per_100, v)
                return (
                  <li key={s.id} style={back != null && back >= GIVE_BACK_CONFIRM_PCT ? { color: 'var(--theme-amber-text)' } : undefined}>
                    {s.name} gives back {back == null ? '—' : `${nprPoints(back)} per NPR 100 (${back}%)`}
                  </li>
                )
              })}
            </ul>
          )}
        </>
      ),
      run: () => storePointValue(v),
    })
  }

  async function storePointValue(v) {
    setSavingValue(true)
    const failure = await onPointValueSaved(v)
    setSavingValue(false)
    // A string is a sentence the page wrote; anything else is a Supabase error to word (S754).
    if (failure) setMsg(`error:The point value was not changed. ${typeof failure === 'string' ? failure : errorLine(failure)}`)
  }

  // A points move landed (S815 4g). Both numbers' rows changed (enrolment too), so the tab reads again.
  async function onMoved(member, res) {
    setMoving(null)
    const n = Number(res?.moved) || 0
    const left = Number(res?.held_left) || 0
    setMsg(`ok:${n.toLocaleString('en-IN')} points moved from ${member.phone} to ${res?.to_phone}${res?.created ? ' (added to the customer book)' : ''}.`
      + (res?.enrolled ? ' The new number joined the scheme.' : '')
      + (res?.unenrolled ? ` ${member.phone} left its scheme.` : '')
      + (left > 0 ? ` ${left.toLocaleString('en-IN')} points from an unpaid Credit bill stay on ${member.phone} until it is settled.` : ''))
    await load()
  }

  // A hand correction landed: the balance is the one the server returned, never a sum worked out here.
  function onAdjusted(member, newBalance, change) {
    setAdjusting(null)
    setBook(prev => (prev.rows ? { ...prev, rows: { ...prev.rows, balances: { ...prev.rows.balances, [member.id]: newBalance } } } : prev))
    const n = Math.abs(change).toLocaleString('en-IN')
    setMsg(`ok:${change > 0 ? `${n} points added for` : `${n} points taken off`} ${member.name}. New balance: ${Number(newBalance).toLocaleString('en-IN')} points.`)
  }

  const enrolled = members.filter(m => m.loyalty_scheme_id)
  const anyPoints = Object.values(balances).some(n => n > 0) // S833: words the no-scheme note
  const q = search.trim().toLowerCase()
  // S815 4g: a phone matches by its digits, "+977" and a leading 0 taken off (phoneMatchesSearch).
  const shownMembers = !q ? members : members.filter(m =>
    String(m.name || '').toLowerCase().includes(q) || phoneMatchesSearch(m.phone, q))

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
          {/* S834: a reload that failed keeps what was on screen, and says so. */}
          {book.stale && (() => {
            const why = asActionError(book.stale, 'operator')
            return <ActionError error={{ text: `Loyalty could not be read again, so the schemes, members and points below are as they were last read. Reload the page to try again. ${why.text}`, detail: why.detail }} />
          })()}

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
                        <Tip text="What a member gets back for every NPR 100 they spend: points per NPR 100 × the value of one point. The same number is the share of the bill given back — 100% means the whole bill comes back as points. Amber from 50%." width={320}>Gives back</Tip>
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
                            onSave={v => saveRate(s, v)} onInvalid={t => setMsg(`error:${t}`)}
                          />
                        </td>
                        {(() => {
                          const back = schemeGivesBack(s.points_per_100, pointValue)
                          return (
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap', color: back != null && back >= GIVE_BACK_CONFIRM_PCT ? 'var(--theme-amber-text)' : 'var(--theme-text1)' }}>
                              {back == null ? '—' : `${nprPoints(back)} per NPR 100 · ${back}%`}
                            </td>
                          )
                        })()}
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
                <input id="new-scheme-name" className="form-input" value={newName} placeholder="Regulars"
                  onChange={e => { setNewName(e.target.value); setNameMissing(false) }}
                  {...fieldAria('new-scheme-name', nameMissing ? 'Type a scheme name first.' : '')} />
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="new-scheme-rate">Points / NPR 100</label>
                <input id="new-scheme-rate" type="number" min="0" step="0.1" className="form-input" style={{ width: 120 }} value={newRate} onChange={e => setNewRate(e.target.value)} />
              </div>
              <div className="form-field" style={{ margin: 0 }}>
                <label htmlFor="new-scheme-min">Min. spend</label>
                <input id="new-scheme-min" type="number" min="0" step="1" className="form-input" style={{ width: 120 }} value={newMin} onChange={e => setNewMin(e.target.value)} />
              </div>
              {/* aria-disabled, not disabled (the S759 pattern): a press says what is missing and moves to it.
                  disabled is only for the add in flight. */}
              <button className="btn btn-primary" onClick={addScheme} disabled={savingScheme}
                aria-disabled={!savingScheme && !newName.trim() ? true : undefined}>
                {savingScheme ? 'Adding…' : '+ Add scheme'}
              </button>
              {/* Its own line under the row, so the boxes beside the name stay level. */}
              {nameMissing && (
                <div style={{ flexBasis: '100%' }}>
                  <FieldError id="new-scheme-name" message="Type a scheme name first." />
                </div>
              )}
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
            ) : (
              <>
              {/* S833 (S809.4 3k): no scheme no longer hides the members. Their points stay, so they stay
                  listed, with History, Adjust and Move as usual (none of those needs a scheme). */}
              {schemes.length === 0 && (
                <div className="note-banner" role="note">
                  <strong>No scheme exists, so nobody earns new points.</strong>{' '}
                  {canManage ? 'Add one above, then enrol customers in it.' : 'A POS manager or the Owner adds schemes.'}
                  {anyPoints && ` Points customers already hold are kept: they are listed below and can still be spent at the till${canManage ? ', adjusted or moved' : ''}.`}
                </div>
              )}
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
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="The customer's points balance. Points earned on a Credit bill that is not paid yet show as held: they can be spent once the bill is settled in Outstanding Credit." width={320}>Points</Tip>
                      </th>
                      <th style={{ textAlign: 'right' }}>Worth</th>
                      <th style={{ textAlign: 'right' }}>
                        <Tip text="History: every change to the customer's points, and their bills with no points — the Owner or a POS manager adds those in one tap. ⋯ (Owner and POS managers): Adjust adds or takes off points by hand with a reason; Move takes the points to the guest's new number." width={340}>
                          History
                        </Tip>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownMembers.map(m => {
                      const bal = balances[m.id] || 0
                      const onTab = held[m.id] || 0
                      const partner = isDeliveryPartnerPhone(m.phone, deliveryPartners)
                      const movable = spendablePoints(bal, onTab)
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
                            ) : schemes.length === 0 && !m.loyalty_scheme_id ? (
                              // S833: with no scheme there is nothing to pick, so the row says where it stands.
                              <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Not enrolled</span>
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
                          <td style={{ textAlign: 'right', fontWeight: bal > 0 ? 700 : 400, color: bal > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text3)' }}>
                            {bal.toLocaleString('en-IN')}
                            {onTab > 0 && (
                              <span style={{ display: 'block', fontSize: 11, fontWeight: 400, color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>
                                {onTab.toLocaleString('en-IN')} held
                              </span>
                            )}
                          </td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                            {bal > 0 && pointValue != null ? `NPR ${pointsValue(bal, pointValue).toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                              <button className="btn btn-ghost btn-sm" onClick={() => { setMsg(''); setViewing(m) }}
                                aria-label={`Points history for ${m.name}`}>History</button>
                              {canManage && (
                                <RowMenu label={`More for ${m.name}`} items={[
                                  // A partner can only lose points, so Adjust is offered only while it holds some.
                                  (!partner || bal > 0) && { key: 'adjust', label: 'Adjust points…', onSelect: () => { setMsg(''); setAdjusting(m) } },
                                  !partner && {
                                    key: 'move', label: 'Move to a new number…', onSelect: () => { setMsg(''); setMoving(m) },
                                    disabled: movable <= 0,
                                    hint: movable <= 0 ? (onTab > 0 ? 'Its points are held on an unpaid Credit bill' : 'No points to move') : undefined,
                                  },
                                ]} />
                              )}
                            </span>
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
        </>
      )}
      {viewing && (
        <PointsHistoryModal
          customer={viewing}
          scheme={schemes.find(s => s.id === viewing.loyalty_scheme_id) || null}
          balance={balances[viewing.id] || 0}
          held={held[viewing.id] || 0}
          pointValue={pointValue}
          canManage={canManage}
          onClose={() => setViewing(null)}
          onChanged={load}
        />
      )}
      {moving && (
        <MovePointsModal
          customer={moving}
          schemeName={schemes.find(s => s.id === moving.loyalty_scheme_id)?.name || null}
          balance={balances[moving.id] || 0}
          held={held[moving.id] || 0}
          pointValue={pointValue}
          partners={deliveryPartners}
          onClose={() => setMoving(null)}
          onMoved={res => onMoved(moving, res)}
        />
      )}
      {adjusting && (
        <AdjustPointsModal
          customer={adjusting}
          balance={balances[adjusting.id] || 0}
          held={held[adjusting.id] || 0}
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
