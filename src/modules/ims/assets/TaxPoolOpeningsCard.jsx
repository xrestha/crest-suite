import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import Tip from '../../../components/Tip'
import QtyInput from '../../../components/QtyInput'
import ActionError, { asActionError } from '../../../components/ActionError'
import { nprInt } from '../../../shared/nepalMoney'
import { openingLockedBy } from './taxPoolCompute'
import { POOL_LABELS } from './taxPoolConstants'

const POOLS_AD = ['A', 'B', 'C', 'D']
const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100

// The assets_tax_pool_openings_lock trigger's refusal (hint tax_pool_opening_locked) — worded here,
// since it is this card's own rule. A BEFORE trigger, so nothing was written.
function lockedError(error) {
  const { detail } = asActionError(error)
  return {
    text: 'A tax pool schedule has been posted that already uses this opening value, so it is locked and nothing was changed. Correct the figures with a correction run for the posted year instead.',
    detail,
  }
}

// D40 (S792 stage 4): the opening WDV of Pools A–D, typed once from last year's tax return, for the
// fiscal year on screen — the first year Crest computes. The Tax tab uses it only while the year
// before has no posted schedule here (priorPoolRun); a posted schedule always wins. Locked (Q4) once
// a posted schedule for its year or a later one exists: the database refuses the write, and this
// card shows the value read-only with the reason. Pool E takes no pool figure (Q5): its assets carry
// their own "Depreciation already taken" on the asset form.
//
// `onChanged` tells the tab its preview inputs moved, so a preview built before the save is thrown
// away rather than posted.
export default function TaxPoolOpeningsCard({ fyLabel, priorLabel, canEdit, onChanged }) {
  const { clientId } = useAuth()
  const { scopedFrom, scopedUpsert, scopedDelete } = useScopedDb()
  const [openings, setOpenings] = useState([])
  const [runs, setRuns] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState(null)
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [msg, setMsg] = useState('')
  // Keyed on the client: an admin switching client with the tab open must not land one outlet's
  // openings on another's card.
  const loadReq = useLatestRequest()

  useEffect(() => { load() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    const key = clientId || 'none'
    loadReq.begin(key)
    setLoaded(false); setLoadErr(null)
    const [o, r] = await Promise.all([
      scopedFrom('assets_tax_pool_openings', 'id, pool, fiscal_year, opening_wdv, repair_carry_forward, updated_at').order('pool').order('id'),
      scopedFrom('assets_tax_pool_runs', 'id, fiscal_year').eq('status', 'posted').order('id'),
    ])
    if (!loadReq.isCurrent(key)) return
    // Both are needed: without the runs the card cannot say what is locked, and would offer an
    // edit the database then refuses.
    const error = o.error || r.error
    if (error) { setLoadErr(asActionError(error, 'operator')); return }
    setOpenings(o.data || [])
    setRuns(r.data || [])
    setLoaded(true)
  }

  const byPool = useMemo(() => {
    const m = {}
    openings.forEach(o => { m[o.pool] = o })
    return m
  }, [openings])

  // A posted schedule for this year or later: a new opening for it would be refused too.
  const yearLockedBy = useMemo(() => openingLockedBy({ opening: { fiscal_year: fyLabel }, runs }), [fyLabel, runs])

  // The boxes show what is saved for THIS year; one saved for another year is named beside them.
  useEffect(() => {
    const d = {}
    POOLS_AD.forEach(p => {
      const o = byPool[p]
      d[p] = o && o.fiscal_year === fyLabel
        ? { wdv: String(o.opening_wdv ?? ''), repair: String(o.repair_carry_forward ?? '') }
        : { wdv: '', repair: '' }
    })
    setDraft(d)
  }, [byPool, fyLabel])
  // A message about one year's values does not belong under another's. Not on a reload, though:
  // a save's own message and error must survive the re-read that follows it.
  useEffect(() => { setErr(null); setMsg('') }, [fyLabel])

  function lockOf(pool) {
    const o = byPool[pool]
    return (o && openingLockedBy({ opening: o, runs })) || yearLockedBy
  }

  function setField(pool, field, value) {
    setMsg('')
    setDraft(d => ({ ...d, [pool]: { ...d[pool], [field]: value } }))
  }

  async function save() {
    setErr(null); setMsg('')
    const upserts = [], deletes = []
    for (const p of POOLS_AD) {
      if (lockOf(p)) continue
      const d = draft[p] || { wdv: '', repair: '' }
      const saved = byPool[p]
      const savedHere = saved && saved.fiscal_year === fyLabel ? saved : null
      const blank = d.wdv === '' || d.wdv == null
      if (blank) {
        if (savedHere) deletes.push(savedHere.id)
        continue
      }
      const wdv = parseFloat(d.wdv), repair = d.repair === '' || d.repair == null ? 0 : parseFloat(d.repair)
      if (!Number.isFinite(wdv) || wdv < 0 || !Number.isFinite(repair) || repair < 0) {
        setErr(`Pool ${p}: enter amounts of 0 or more, or leave Opening WDV blank for a pool with no opening value.`)
        return
      }
      if (savedHere && Math.abs(r2(savedHere.opening_wdv) - r2(wdv)) < 0.005 && Math.abs(r2(savedHere.repair_carry_forward) - r2(repair)) < 0.005) continue
      upserts.push({ pool: p, fiscal_year: fyLabel, opening_wdv: r2(wdv), repair_carry_forward: r2(repair) })
    }
    if (!upserts.length && !deletes.length) { setMsg('Nothing to save — the values shown are the ones saved.'); return }

    setSaving(true)
    onChanged()
    const results = []
    if (upserts.length) results.push(await scopedUpsert('assets_tax_pool_openings', upserts, { onConflict: 'client_id,pool' }))
    if (deletes.length) results.push(await scopedDelete('assets_tax_pool_openings').in('id', deletes))
    setSaving(false)
    const failed = results.find(x => x.error)
    if (failed) {
      const e = failed.error
      if (e.hint === 'tax_pool_opening_locked' || /tax_pool_opening_locked/.test(e.message || '')) setErr(lockedError(e))
      else {
        const a = asActionError(e)
        // Two writes: the upsert may have landed before the delete failed. The reload shows which.
        setErr({ text: `The opening values may not all have saved — the table below is re-read, so it shows what is stored now. ${a.text}`, detail: a.detail })
      }
      load()
      return
    }
    setMsg(`Saved — FY ${fyLabel} opens from these values while FY ${priorLabel} has no posted schedule.`)
    load()
  }

  const anyEditable = canEdit && loaded && POOLS_AD.some(p => !lockOf(p))

  return (
    <div className="card no-print" style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 13, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>
        <Tip text="If your business owned assets before it started using Crest, its pools did not start at zero. Copy each pool's Closing WDV from last year's filed tax return here, once. Crest then carries the pools forward itself, year by year, as you post." width={320}>Opening values (from last year's tax return)</Tip> — FY {fyLabel}
      </h3>
      <p style={{ fontSize: 12, color: 'var(--theme-text3)', margin: '0 0 12px', lineHeight: 1.5, maxWidth: 760 }}>
        For the first year Crest works out. Used only while FY {priorLabel} has no posted schedule here — a posted schedule
        always wins. Pool E (software, licences) takes no pool figure: enter "Depreciation already taken" on each Pool E asset instead.
      </p>

      {loadErr ? (
        <div>
          <ActionError error={{ text: `The saved opening values could not be read, so none are shown and nothing can be changed here. ${loadErr.text}`, detail: loadErr.detail }} />
          <button className="btn btn-ghost" style={{ marginTop: 8, fontSize: 12 }} onClick={load}>Try again</button>
        </div>
      ) : !loaded ? (
        <p style={{ fontSize: 12, color: 'var(--theme-text2)' }}>Loading…</p>
      ) : (
        <>
          {yearLockedBy && (
            <p role="status" style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 10px', lineHeight: 1.5 }}>
              <strong style={{ color: 'var(--theme-amber-text)' }}>△ Locked.</strong>{' '}
              FY {yearLockedBy} already has a posted schedule, so an opening value for FY {fyLabel} can no longer be added or
              changed — the posted years carry the pools forward. To correct them, post a correction run for the posted year.
            </p>
          )}
          <div className="table-wrap">
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Pool</th>
                  <th style={{ textAlign: 'right' }}><Tip text={`The pool's Closing WDV at the end of FY ${priorLabel}, from the tax return you filed for that year. Leave it blank for a pool you had nothing in.`} width={280}>Opening WDV</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Repair and maintenance spend above the 5% cap in the year before, which the law adds to this year's pool (Section 16). It is on last year's return; 0 if there was none." width={280}>Repair carried forward</Tip></th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {POOLS_AD.map(p => {
                  const saved = byPool[p]
                  const lock = lockOf(p)
                  const editable = canEdit && !lock
                  const d = draft[p] || { wdv: '', repair: '' }
                  return (
                    <tr key={p}>
                      <td>{POOL_LABELS[p]}</td>
                      <td style={{ textAlign: 'right' }}>
                        {editable
                          ? <QtyInput value={d.wdv} onChange={v => setField(p, 'wdv', v)} className="form-input" style={{ width: 130, textAlign: 'right' }} aria-label={`Pool ${p} opening WDV (NPR)`} />
                          : <span style={{ whiteSpace: 'nowrap' }}>{d.wdv === '' ? '—' : nprInt(d.wdv)}</span>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {editable
                          ? <QtyInput value={d.repair} onChange={v => setField(p, 'repair', v)} className="form-input" style={{ width: 130, textAlign: 'right' }} aria-label={`Pool ${p} repair carried forward (NPR)`} />
                          : <span style={{ whiteSpace: 'nowrap' }}>{d.repair === '' ? '—' : nprInt(d.repair)}</span>}
                      </td>
                      <td style={{ color: 'var(--theme-text2)' }}>
                        {saved && saved.fiscal_year !== fyLabel && (
                          <span>Saved for FY {saved.fiscal_year}: NPR {nprInt(saved.opening_wdv)}.{!lock && ' Saving a value here moves it to this year.'} </span>
                        )}
                        {lock && saved && openingLockedBy({ opening: saved, runs }) && (
                          <span>Locked — FY {openingLockedBy({ opening: saved, runs })} is posted and carries it forward.</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {!canEdit && (
            <p style={{ fontSize: 11, color: 'var(--theme-text3)', margin: '8px 0 0' }}>Only an IMS Manager or the Owner can change these, as for posting the pools.</p>
          )}
          {anyEditable && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save opening values'}</button>
              {msg && <span style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{msg}</span>}
            </div>
          )}
          <ActionError error={err} />
        </>
      )}
    </div>
  )
}
