import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import QtyInput from '../../../components/QtyInput'
import ActionError, { asActionError } from '../../../components/ActionError'
import { nprInt } from '../../../shared/nepalMoney'
import { nepalBsLong } from '../../../shared/nepalTime'
import { loadProfileNames } from '../../../shared/profileNames'
import { settleWithin } from '../../../utils/withTimeout'
import { openingLockedBy, POOLS_AD } from './taxPoolCompute'
import { POOL_LABELS } from './taxPoolConstants'
import { answerLost, refusedWith, ASSET_CALL_MS } from './assetReads'

const r2 = n => Math.round((n + Number.EPSILON) * 100) / 100
const startOf = label => { const m = /^(\d{1,2})\//.exec(String(label || '')); return m ? Number(m[1]) : null }
const money = v => (v == null ? 'none' : nprInt(v))
// "FY 83/84" / "FY 83/84 and 84/85" / "FY 83/84, 84/85 and 85/86"
const fyList = labels => `FY ${labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`}`

// The assets_tax_pool_openings_lock trigger's refusal (hint tax_pool_opening_locked) — worded here,
// since it is this card's own rule. A BEFORE trigger, so nothing was written.
function lockedError(error) {
  const { detail } = asActionError(error)
  return {
    text: 'A tax pool schedule has been posted that already uses this opening value, so it is locked and nothing was changed. If it was typed wrong, use Correct these values: the reason is recorded, and the years posted from it are listed to post again.',
    detail,
  }
}

// correct_tax_pool_openings() refuses inside its one transaction, so each of these may say nothing
// was recorded (S849, ASSETS-9). Worded here, in the lock's style; anything else goes to the table.
function correctionError(error, { fyLabel, priorLabel }) {
  const { text, detail } = asActionError(error)
  const say = t => ({ text: t, detail })
  if (refusedWith(error, 'tax_pool_opening_not_locked')) return say(`No posted schedule uses FY ${fyLabel}'s opening values yet, so nothing was recorded. Close this and change them on the card with Save opening values instead.`)
  if (refusedWith(error, 'tax_pool_opening_unused')) return say(`FY ${priorLabel} has a posted schedule, so FY ${fyLabel} opens from it, not from typed values, and nothing was recorded. To change what FY ${fyLabel} opens from, post FY ${priorLabel} again with the right figures.`)
  if (refusedWith(error, 'tax_pool_opening_year')) {
    const m = /Pool (\w)'s opening value is saved for FY ([\d/]+)/.exec(error.message || '')
    return say(m
      ? `Pool ${m[1]}'s opening value is saved for FY ${m[2]}, not FY ${fyLabel}, so it cannot be corrected here and nothing was recorded.`
      : `One pool's opening value is saved for another fiscal year, so it cannot be corrected for FY ${fyLabel} and nothing was recorded.`)
  }
  if (refusedWith(error, 'tax_pool_correction_unchanged')) return say('Every value sent is the one already saved, so nothing was recorded. Change a figure, or Cancel.')
  if (refusedWith(error, 'tax_pool_correction_reason')) return say('The reason must be 10 to 500 characters, so nothing was recorded.')
  if (refusedWith(error, 'tax_pool_correction_values')) return say('One of the amounts was not accepted (each must be 0 or more, once per pool), so nothing was recorded.')
  if (refusedWith(error, 'tax_pool_correction_denied')) return say("This login cannot correct this outlet's opening values — only the outlet's own Manager or Owner login can — so nothing was recorded.")
  if (refusedWith(error, 'ims_rank')) return say('Correcting an opening value needs an IMS Manager or the Owner login, so nothing was recorded.')
  return say(`The correction was not recorded. ${text}`)
}

// D40 (S792 stage 4): the opening WDV of Pools A–D, typed once from last year's tax return, for the
// fiscal year on screen — the first year Crest computes. The Tax tab uses it only while the year
// before has no posted schedule here (priorPoolRun); a posted schedule always wins. Locked (Q4) once
// a posted schedule for its year or a later one exists: the database refuses the write, and this
// card shows the value read-only with the reason. Pool E takes no pool figure (Q5): its assets carry
// their own "Depreciation already taken" on the asset form.
//
// S849 (ASSETS-9, owner decision SU7 b): a locked value that was typed wrong is corrected here by the
// business itself, with "Correct these values…": a Manager or the Owner gives a reason and the right
// figures, correct_tax_pool_openings() records old → new with their name and the date, and the posted
// schedules stay as filed. The Tax tab then lists the years to post again (`onCorrected`).
//
// `onChanged` tells the tab its preview inputs moved, so a preview built before the save is thrown
// away rather than posted. `refreshKey` changes after a post, which may have locked these values.
export default function TaxPoolOpeningsCard({ fyLabel, priorLabel, canEdit, onChanged, onCorrected, refreshKey }) {
  const { clientId } = useAuth()
  const { scopedFrom, scopedUpsert, scopedDelete } = useScopedDb()
  const [openings, setOpenings] = useState([])
  const [runs, setRuns] = useState([])
  const [corrections, setCorrections] = useState([])
  const [names, setNames] = useState({})
  const [loaded, setLoaded] = useState(false)
  const [loadErr, setLoadErr] = useState(null)
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [msg, setMsg] = useState('')
  // The correction dialog: its own boxes, reason, busy flag and error.
  const [correcting, setCorrecting] = useState(false)
  const [cDraft, setCDraft] = useState({})
  const [cReason, setCReason] = useState('')
  const [cSaving, setCSaving] = useState(false)
  const [cErr, setCErr] = useState(null)
  // Keyed on the client: an admin switching client with the tab open must not land one outlet's
  // openings on another's card.
  const loadReq = useLatestRequest()

  useEffect(() => { load() }, [clientId, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  async function load() {
    const key = clientId || 'none'
    loadReq.begin(key)
    setLoaded(false); setLoadErr(null)
    const [o, r, c] = await Promise.all([
      settleWithin(scopedFrom('assets_tax_pool_openings', 'id, pool, fiscal_year, opening_wdv, repair_carry_forward, updated_at').order('pool').order('id'), ASSET_CALL_MS, 'Reading the opening values'),
      settleWithin(scopedFrom('assets_tax_pool_runs', 'id, fiscal_year').eq('status', 'posted').order('id'), ASSET_CALL_MS, 'Reading the posted tax schedules'),
      settleWithin(scopedFrom('assets_tax_pool_opening_corrections', 'id, pool, fiscal_year, old_opening_wdv, old_repair_carry_forward, new_opening_wdv, new_repair_carry_forward, reason, corrected_by, corrected_at')
        .order('corrected_at', { ascending: false }).order('id'), ASSET_CALL_MS, 'Reading the opening corrections'),
    ])
    if (!loadReq.isCurrent(key)) return
    // All three are needed: without the runs the card cannot say what is locked, and would offer an
    // edit the database then refuses; without the corrections it would show a corrected value with
    // no record of the change.
    const error = o.error || r.error || c.error
    if (error) { setLoadErr(asActionError(error, 'operator')); return }
    setOpenings(o.data || [])
    setRuns(r.data || [])
    setCorrections(c.data || [])
    setLoaded(true)
    // Names never hold the card up; an unnamed login is worded as such.
    const ids = (c.data || []).map(x => x.corrected_by).filter(Boolean)
    if (ids.length) {
      const { map } = await loadProfileNames(supabase, clientId, ids)
      if (loadReq.isCurrent(key)) setNames(map)
    }
  }

  const byPool = useMemo(() => {
    const m = {}
    openings.forEach(o => { m[o.pool] = o })
    return m
  }, [openings])

  // A posted schedule for this year or later: a new opening for it would be refused too.
  const yearLockedBy = useMemo(() => openingLockedBy({ opening: { fiscal_year: fyLabel }, runs }), [fyLabel, runs])
  // The year before is posted: this year opens from that schedule, and a typed value is never used.
  const priorPosted = runs.some(r => r.fiscal_year === priorLabel)
  // The posted years that used this year's openings (its own and every later one), oldest first.
  const postedFromHere = useMemo(() => {
    const from = startOf(fyLabel)
    return [...new Set(runs.map(r => r.fiscal_year))]
      .filter(l => startOf(l) != null && from != null && startOf(l) >= from)
      .sort((a, b) => startOf(a) - startOf(b))
  }, [fyLabel, runs])
  const yearCorrections = corrections.filter(c => c.fiscal_year === fyLabel)

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
  useEffect(() => { setErr(null); setMsg(''); setCorrecting(false) }, [fyLabel])

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
      if (refusedWith(e, 'tax_pool_opening_locked')) setErr(lockedError(e))
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

  // Pools whose saved value is for another year cannot be corrected for this one (the database
  // refuses it too, tax_pool_opening_year); they are shown, read-only, with the reason.
  const correctable = p => !byPool[p] || byPool[p].fiscal_year === fyLabel

  function openCorrection() {
    const d = {}
    POOLS_AD.forEach(p => {
      const o = byPool[p]
      d[p] = o && o.fiscal_year === fyLabel
        ? { wdv: String(o.opening_wdv ?? ''), repair: String(o.repair_carry_forward ?? '0') }
        : { wdv: '', repair: '' }
    })
    setCDraft(d); setCReason(''); setCErr(null); setMsg(''); setErr(null)
    setCorrecting(true)
  }

  async function submitCorrection() {
    setCErr(null)
    const reason = cReason.trim()
    if (reason.length < 10 || reason.length > 500) {
      setCErr('Give a reason of 10 to 500 characters: it is kept with the correction, with your name and the date, for your accountant and the Audit Log.')
      return
    }
    const values = []
    for (const p of POOLS_AD) {
      if (!correctable(p)) continue
      const d = cDraft[p] || {}
      if (d.wdv === '' || d.wdv == null) continue // left blank: not part of this correction
      const wdv = parseFloat(d.wdv), rep = d.repair === '' || d.repair == null ? 0 : parseFloat(d.repair)
      if (!Number.isFinite(wdv) || wdv < 0 || !Number.isFinite(rep) || rep < 0) {
        setCErr(`Pool ${p}: enter amounts of 0 or more.`)
        return
      }
      const saved = byPool[p]
      if (saved && Math.abs(r2(saved.opening_wdv) - r2(wdv)) < 0.005 && Math.abs(r2(saved.repair_carry_forward) - r2(rep)) < 0.005) continue
      if (!saved && r2(wdv) === 0 && r2(rep) === 0) continue
      values.push({ pool: p, opening_wdv: r2(wdv), repair_carry_forward: r2(rep) })
    }
    if (!values.length) { setCErr('Nothing to correct: every value shown is the one already saved. Change a figure, or Cancel.'); return }

    setCSaving(true)
    onChanged()
    const { data, error } = await settleWithin(supabase.rpc('correct_tax_pool_openings', {
      p_client_id: clientId, p_fiscal_year: fyLabel, p_values: values, p_reason: reason,
    }), ASSET_CALL_MS, 'Recording the correction')
    setCSaving(false)
    if (error) {
      if (answerLost(error)) {
        // A second press is safe: a value already recorded comes back as "unchanged".
        const { detail } = asActionError(error)
        setCErr({ text: 'The connection dropped before the server answered, so the correction may have been recorded. The card re-reads: check the saved values and the corrections list before pressing Record again.', detail })
        load(); onCorrected?.()
        return
      }
      setCErr(correctionError(error, { fyLabel, priorLabel }))
      return
    }
    const count = Number(data) || values.length
    setCorrecting(false)
    setMsg(`Recorded — ${count} ${count === 1 ? 'pool was' : 'pools were'} corrected for FY ${fyLabel}. The schedules posted from them are listed under Schedules to post again.`)
    load(); onCorrected?.()
  }

  const anyEditable = canEdit && loaded && POOLS_AD.some(p => !lockOf(p))
  const canCorrect = canEdit && loaded && !!yearLockedBy && !priorPosted

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
              {priorPosted
                ? <>FY {yearLockedBy} already has a posted schedule, so an opening value for FY {fyLabel} can no longer be changed here — and FY {priorLabel} is posted, so FY {fyLabel} opens from that schedule, not from typed values.</>
                : <>FY {yearLockedBy} already has a posted schedule, so an opening value for FY {fyLabel} can no longer be changed here. If a value was typed wrong, use Correct these values.</>}
            </p>
          )}
          <div className="table-wrap">
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Pool</th>
                  <th style={{ textAlign: 'right' }}><Tip text={`The pool's Closing WDV at the end of FY ${priorLabel}, from the tax return you filed for that year. Leave it blank for a pool you had nothing in.`} width={280}>Opening WDV</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Repair and maintenance spend above the 7% cap in the year before, which the law adds to this year's pool (Section 16). It is on last year's return; 0 if there was none." width={280}>Repair carried forward</Tip></th>
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
          {(anyEditable || canCorrect || msg) && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
              {anyEditable && <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save opening values'}</button>}
              {canCorrect && (
                <Tip text="For a locked value that was typed wrong. The posted schedules are not changed; you give a reason, and the years posted from these values are listed to post again." width={300}>
                  <button className="btn btn-ghost" onClick={openCorrection}>Correct these values…</button>
                </Tip>
              )}
              {msg && <span role="status" style={{ fontSize: 12, color: 'var(--theme-text2)' }}>{msg}</span>}
            </div>
          )}
          <ActionError error={err} />

          {yearCorrections.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <h4 style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--theme-text2)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                <Tip text="Every correction of a locked opening value for this year: who made it, when, the old and new figures, and the reason. Kept for good; it cannot be edited or deleted." width={300}>Corrections to FY {fyLabel}'s opening values</Tip>
              </h4>
              <div className="table-wrap">
                <table className="data-table" style={{ fontSize: 12 }}>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>By</th>
                      <th>Pool</th>
                      <th style={{ textAlign: 'right' }}>Opening WDV</th>
                      <th style={{ textAlign: 'right' }}>Repair carried forward</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {yearCorrections.map(c => (
                      <tr key={c.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{nepalBsLong(c.corrected_at) || '—'}</td>
                        <td>{c.corrected_by ? (names[c.corrected_by] || '—') : 'a removed login'}</td>
                        <td>{c.pool}</td>
                        <td style={{ textAlign: 'right' }}><span style={{ whiteSpace: 'nowrap' }}>{money(c.old_opening_wdv)} → {nprInt(c.new_opening_wdv)}</span></td>
                        <td style={{ textAlign: 'right' }}><span style={{ whiteSpace: 'nowrap' }}>{money(c.old_repair_carry_forward)} → {nprInt(c.new_repair_carry_forward)}</span></td>
                        <td>{c.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {correcting && (
        <Modal onClose={() => { if (!cSaving) setCorrecting(false) }} title={`Correct FY ${fyLabel}'s opening values`} maxWidth={720}>
          <div className="table-wrap">
            <table className="data-table" style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Pool</th>
                  <th style={{ textAlign: 'right' }}>Saved now</th>
                  <th style={{ textAlign: 'right' }}><Tip text={`The right Closing WDV at the end of FY ${priorLabel}, from the tax return filed for that year. Leave blank to leave the pool as it is.`} width={280}>New opening WDV</Tip></th>
                  <th style={{ textAlign: 'right' }}><Tip text="Repair spend above the 7% cap in the year before, as on last year's return; 0 if there was none." width={260}>New repair carried forward</Tip></th>
                </tr>
              </thead>
              <tbody>
                {POOLS_AD.map(p => {
                  const saved = byPool[p]
                  const d = cDraft[p] || { wdv: '', repair: '' }
                  return (
                    <tr key={p}>
                      <td>{POOL_LABELS[p]}</td>
                      <td style={{ textAlign: 'right', color: 'var(--theme-text2)' }}>
                        <span style={{ whiteSpace: 'nowrap' }}>{saved ? `${nprInt(saved.opening_wdv)} / ${nprInt(saved.repair_carry_forward)}` : 'none typed'}</span>
                      </td>
                      {correctable(p) ? (
                        <>
                          <td style={{ textAlign: 'right' }}>
                            <QtyInput value={d.wdv} onChange={v => setCDraft(x => ({ ...x, [p]: { ...x[p], wdv: v } }))} className="form-input" style={{ width: 130, textAlign: 'right' }} aria-label={`Pool ${p} corrected opening WDV (NPR)`} />
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            <QtyInput value={d.repair} onChange={v => setCDraft(x => ({ ...x, [p]: { ...x[p], repair: v } }))} className="form-input" style={{ width: 130, textAlign: 'right' }} aria-label={`Pool ${p} corrected repair carried forward (NPR)`} />
                          </td>
                        </>
                      ) : (
                        <td colSpan={2} style={{ color: 'var(--theme-text2)' }}>Saved for FY {saved.fiscal_year}, so it cannot be corrected for FY {fyLabel}.</td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="form-field" style={{ marginTop: 12 }}>
            <label htmlFor="taxpool-correct-reason">Reason</label>
            <textarea id="taxpool-correct-reason" className="form-input" rows={3} maxLength={500} value={cReason} onChange={e => setCReason(e.target.value)}
              placeholder="Required — e.g. Pool D was copied from the wrong line of the FY 82/83 return" style={{ width: '100%', resize: 'vertical' }} />
          </div>
          <p style={{ margin: '12px 0 0', fontSize: 13, lineHeight: 1.6, color: 'var(--theme-text2)' }}>
            {fyList(postedFromHere)} {postedFromHere.length === 1 ? 'was' : 'were'} posted from these values. {postedFromHere.length === 1 ? 'It is' : 'They are'} not
            changed or deleted: {postedFromHere.length === 1 ? 'it stays' : 'they stay'} on record as posted. After you save, this tab lists {postedFromHere.length === 1 ? 'it' : 'them'} under
            'Schedules to post again'. Post each one again, oldest first; the new schedule is the one the next year opens from. If a tax
            return was already filed from the old figures, ask your accountant whether to amend it. Your name, the date and the reason are
            kept with the correction.
          </p>
          <ActionError error={cErr} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
            <button className="btn btn-ghost" onClick={() => setCorrecting(false)} disabled={cSaving}>Cancel</button>
            <button className="btn btn-primary" onClick={submitCorrection} disabled={cSaving}>{cSaving ? 'Recording…' : 'Record the correction'}</button>
          </div>
        </Modal>
      )}
    </div>
  )
}
