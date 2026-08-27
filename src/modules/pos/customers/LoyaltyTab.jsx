import { useCallback, useEffect, useState } from 'react'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { fetchAllRows } from '../../../shared/fetchAllRows'
import Tip from '../../../components/Tip'
import ReportLoadError from '../../../components/ReportLoadError'
import { pointsValue } from './loyaltyPoints'

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
//     one client-level number (Table Management → Loyalty), because schemes differing in both
//     directions is a thing no cashier can explain at the till.
export default function LoyaltyTab({ pointValue, onPointValueSaved }) {
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()

  const [schemes, setSchemes] = useState([])
  const [members, setMembers] = useState([])
  const [balances, setBalances] = useState({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [msg, setMsg] = useState('')

  const [newName, setNewName] = useState('')
  const [newRate, setNewRate] = useState('1')
  const [newMin, setNewMin] = useState('0')
  const [savingScheme, setSavingScheme] = useState(false)
  const [valueStr, setValueStr] = useState(String(pointValue ?? 1))
  const [savingValue, setSavingValue] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    const [schemeRes, custRes] = await Promise.all([
      scopedFrom('pos_loyalty_schemes', 'id, name, points_per_100, min_spend_to_earn, is_active').order('name'),
      scopedFrom('pos_customers', 'id, name, phone, loyalty_scheme_id').order('name'),
    ])
    // A failed read must not render as "no schemes yet" — that reads as a correct empty state and
    // would have someone re-create schemes that already exist (S594).
    if (schemeRes.error || custRes.error) {
      setLoadError((schemeRes.error || custRes.error).message)
      setSchemes([]); setMembers([]); setLoading(false)
      return
    }
    setSchemes(schemeRes.data || [])
    setMembers(custRes.data || [])

    // One read for every ledger row, summed per customer here. Paged, because this is the whole
    // client's ledger rather than one customer's and it grows with every bill ever rung.
    const { data: rows, error: ledErr } = await fetchAllRows(() =>
      scopedFrom('pos_loyalty_ledger', 'customer_id, points').order('id'))
    if (ledErr) { setLoadError(ledErr.message); setLoading(false); return }
    const byCustomer = {}
    for (const r of rows || []) byCustomer[r.customer_id] = (byCustomer[r.customer_id] || 0) + (r.points || 0)
    setBalances(byCustomer)
    setLoading(false)
  }, [scopedFrom])

  useEffect(() => { load() }, [load])
  useEffect(() => { setValueStr(String(pointValue ?? 1)) }, [pointValue])

  async function addScheme() {
    const name = newName.trim()
    if (!name) return
    setSavingScheme(true)
    setMsg('')
    const { error } = await scopedInsert('pos_loyalty_schemes', {
      name,
      points_per_100: Number(newRate) || 0,
      min_spend_to_earn: Number(newMin) || 0,
    })
    setSavingScheme(false)
    if (error) { setMsg(`error:Couldn't add the scheme — ${error.message}`); return }
    setNewName(''); setNewRate('1'); setNewMin('0')
    await load()
  }

  async function patchScheme(id, patch) {
    setMsg('')
    const { error } = await scopedUpdate('pos_loyalty_schemes', patch).eq('id', id)
    // An optimistic paint that drops the error shows as saved what the database refused (S613).
    if (error) { setMsg(`error:Couldn't save — ${error.message}`); return }
    await load()
  }

  async function removeScheme(s) {
    if (!window.confirm(`Delete "${s.name}"? Anyone tagged to it stops earning, and their existing points are kept.`)) return
    const { error } = await scopedDelete('pos_loyalty_schemes').eq('id', s.id)
    if (error) { setMsg(`error:Couldn't delete — ${error.message}`); return }
    await load()
  }

  async function tag(customerId, schemeId) {
    setMsg('')
    const { error } = await scopedUpdate('pos_customers', { loyalty_scheme_id: schemeId || null }).eq('id', customerId)
    if (error) { setMsg(`error:Couldn't change enrolment — ${error.message}`); return }
    setMembers(prev => prev.map(m => m.id === customerId ? { ...m, loyalty_scheme_id: schemeId || null } : m))
  }

  async function savePointValue() {
    setSavingValue(true)
    setMsg('')
    const v = Number(valueStr)
    if (!Number.isFinite(v) || v <= 0) { setSavingValue(false); setMsg('error:A point has to be worth more than zero.'); return }
    const ok = await onPointValueSaved(v)
    setSavingValue(false)
    if (!ok) setMsg("error:Couldn't save the point value.")
  }

  const enrolled = members.filter(m => m.loyalty_scheme_id)

  return (
    <div>
      {msg && (
        <p role="alert" style={{ fontSize: 12, margin: '0 0 12px', color: msg.startsWith('error:') ? 'var(--theme-red-text)' : 'var(--theme-green-text)' }}>
          {msg.replace(/^(error|ok):/, '')}
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
            />
            <button className="btn btn-ghost" onClick={savePointValue} disabled={savingValue}>
              {savingValue ? 'Saving…' : 'Save'}
            </button>
          </div>
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
                        <td style={{ whiteSpace: 'nowrap' }}>{s.name}</td>
                        <td style={{ textAlign: 'right' }}>
                          <input
                            type="number" min="0" step="0.1" defaultValue={s.points_per_100}
                            className="form-input form-input--auto" style={{ width: 80, textAlign: 'right' }}
                            aria-label={`Points per NPR 100 for ${s.name}`}
                            onBlur={e => { const v = Number(e.target.value); if (v !== Number(s.points_per_100)) patchScheme(s.id, { points_per_100: v }) }}
                          />
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <input
                            type="number" min="0" step="1" defaultValue={s.min_spend_to_earn}
                            className="form-input form-input--auto" style={{ width: 90, textAlign: 'right' }}
                            aria-label={`Minimum spend to earn for ${s.name}`}
                            onBlur={e => { const v = Number(e.target.value); if (v !== Number(s.min_spend_to_earn)) patchScheme(s.id, { min_spend_to_earn: v }) }}
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox" checked={s.is_active}
                            aria-label={`${s.name} is active`}
                            onChange={() => patchScheme(s.id, { is_active: !s.is_active })}
                          />
                        </td>
                        <td style={{ textAlign: 'right' }}>{members.filter(m => m.loyalty_scheme_id === s.id).length}</td>
                        <td style={{ textAlign: 'right' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => removeScheme(s)}>Delete</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', marginTop: schemes.length ? 14 : 0 }}>
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
            </div>
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
              <p style={{ color: 'var(--theme-text3)', fontSize: 13 }}>Add a scheme above before enrolling anyone.</p>
            ) : (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Phone</th>
                      <th>Scheme</th>
                      <th style={{ textAlign: 'right' }}>Points</th>
                      <th style={{ textAlign: 'right' }}>Worth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map(m => {
                      const bal = balances[m.id] || 0
                      return (
                        <tr key={m.id}>
                          <td style={{ whiteSpace: 'nowrap' }}>{m.name}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{m.phone}</td>
                          <td>
                            <select
                              className="form-select" style={{ maxWidth: 200 }}
                              value={m.loyalty_scheme_id || ''}
                              aria-label={`Loyalty scheme for ${m.name}`}
                              onChange={e => tag(m.id, e.target.value)}
                            >
                              <option value="">Not enrolled</option>
                              {schemes.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: bal > 0 ? 700 : 400, color: bal > 0 ? 'var(--theme-purple-text)' : 'var(--theme-text3)' }}>{bal}</td>
                          <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                            {bal > 0 ? `NPR ${pointsValue(bal, pointValue).toLocaleString('en-NP')}` : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
