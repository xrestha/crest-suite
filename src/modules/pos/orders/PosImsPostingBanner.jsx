import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import { useLatestRequest } from '../../../shared/hooks/useLatestRequest'
import { supabase } from '../../../supabaseClient'
import Tip from '../../../components/Tip'
import ActionError from '../../../components/ActionError'
import { errorInfo } from '../../../shared/errorText'
import { isTimeout } from '../../../utils/withTimeout'
import { BS_MONTHS } from '../../../utils/bsCalendar'
import { loadImsWaiting, summarizeWaiting, countPhrase, postWaitingFromTill } from './posImsWaiting'

// The floor's "not posted to Inventory" banner, and the post itself (S809 3j, owner decision Q12 c).
//
// It used to send its reader to Periods → Post POS bills to Inventory. Its readers are the Owner, the
// operator and POS managers (PosOrders' canSeeImsPosting), and Periods sends a POS manager back to the
// dashboard, so the one person on the floor who saw the warning could do nothing about it. Now the
// banner posts the waiting bills and credit notes of the month OPEN in Inventory itself, through the
// same functions Periods runs, and says where the rest are and who posts them: a closed month only
// the Owner (the database refuses anyone else), a month not started in Inventory once it is started.
// The months come from pos_ims_waiting_counts (numbers per Nepali month); the post reads its own rows.

const BOX = {
  background: 'color-mix(in srgb, var(--theme-amber) 8%, transparent)',
  border: '1px solid color-mix(in srgb, var(--theme-amber) 28%, transparent)',
  borderRadius: 'var(--radius-sm)', padding: '12px 16px', marginBottom: 16, fontSize: 13,
  color: 'var(--theme-text2)',
}
const LINE = { marginTop: 6 }

const periodLabel = p => (p ? `${BS_MONTHS[p.bs_month - 1]} ${p.bs_year}` : 'the open month')
const isAre = (bills, notes) => (bills + notes === 1 ? 'is' : 'are')
const detailOf = err => (!err ? '' : typeof err === 'string' ? err : errorInfo(err, 'operator').detail)

/**
 * `bills` / `notes` are the floor's own counts (billed with no Inventory mark, all months); the
 * banner shows while either is above 0. `onPosted` reloads them after a post.
 */
export default function PosImsPostingBanner({ bills = 0, notes = 0, onPosted }) {
  const { clientId, isAdmin, isOwner } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate } = useScopedDb()
  const latest = useLatestRequest()
  const [waiting, setWaiting] = useState(null) // { rows, error }, null while the first read runs
  const [reloadKey, setReloadKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)   // { kind: 'ok', text } | { kind: 'error', text, detail }
  const shown = bills > 0 || notes > 0
  // The Owner and the operator post a closed month themselves, from Periods.
  const ownsClosedMonths = isAdmin || isOwner

  useEffect(() => {
    if (!clientId || !shown) { setWaiting(null); return }
    const id = latest.begin(Symbol('pos-ims-waiting'))
    loadImsWaiting(supabase, clientId).then(r => { if (latest.isCurrent(id)) setWaiting(r) })
  }, [clientId, shown, bills, notes, reloadKey, latest])

  async function post() {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const r = await postWaitingFromTill({ supabase, scopedFrom, scopedInsert, scopedUpdate, clientId })
      if (r.reason === 'no_open') {
        setResult({ kind: 'error', text: 'No month is open in Inventory, so nothing was posted. The month has to be started in Inventory first (by the Owner or whoever runs Inventory); then press Post to Inventory again.' })
        return
      }
      const label = periodLabel(r.period)
      if (r.error) {
        const text = r.step === 'notes'
          ? `Posted ${countPhrase(r.bills.posted, 0) || '0 bills'} into ${label}, but the credit notes were not posted. Press Post to Inventory again: anything already in Inventory is skipped.`
          : r.step === 'bills'
            ? `The bills from ${label} were not posted. Press Post to Inventory again: anything that did go in is skipped, never added twice.`
            : 'Could not check which month is open in Inventory, so nothing was posted. Check the connection and press Post to Inventory again.'
        setResult({ kind: 'error', text, detail: detailOf(r.error) })
        return
      }
      const posted = countPhrase(r.bills.posted, r.notes.posted)
      const skipped = (r.bills.skipped || 0) + (r.notes.skipped || 0)
      setResult({
        kind: 'ok',
        text: (posted ? `Posted ${posted} into ${label}.` : `Nothing from ${label} was left to post.`)
          + (skipped > 0 ? ` ${skipped} skipped: already in Inventory, nothing to post, or refused (press again to retry; if one keeps failing, tell the Owner).` : ''),
      })
    } catch (err) {
      setResult({
        kind: 'error',
        text: isTimeout(err)
          ? 'Posting took too long and was stopped. Whatever went in stays in Inventory and is skipped next time: press Post to Inventory again to post the rest.'
          : 'Could not post to Inventory. Whatever went in stays in Inventory and is skipped next time: press Post to Inventory again.',
        detail: detailOf(err),
      })
    } finally {
      setBusy(false)
      setReloadKey(k => k + 1)
      onPosted?.()
    }
  }

  if (!shown && !result) return null

  const resultEl = result && (result.kind === 'error'
    ? <div style={LINE}><ActionError error={{ text: result.text, detail: result.detail }} /></div>
    : (
      <div role="status" style={{ ...LINE, display: 'flex', alignItems: 'center', gap: 10, color: 'var(--theme-green-text)' }}>
        <span style={{ flex: 1 }}>✓ {result.text}</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setResult(null)} aria-label="Dismiss">×</button>
      </div>
    ))

  // Posted everything there was: only the outcome is left to show.
  if (!shown) return <div style={BOX}>{resultEl}</div>

  const sum = waiting?.rows ? summarizeWaiting(waiting.rows) : null
  const button = (
    <Tip text="Adds these bills' sales and ingredient use to the month open in Inventory, and takes these credit notes' sales back out of it, the same as Periods → Post POS bills to Inventory. Safe to press more than once: anything already in Inventory is skipped, never added twice." width={300}>
      <button type="button" className="amber-action-btn" onClick={post} disabled={busy} aria-busy={busy}>
        {busy ? 'Posting…' : 'Post to Inventory'}
      </button>
    </Tip>
  )

  return (
    <div role="alert" style={BOX}>
      {bills > 0 && (
        <>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            ⚠ {bills} bill{bills === 1 ? '' : 's'} not posted to Inventory
          </strong>
          <div style={{ marginTop: 4 }}>
            These bills closed normally and are valid, but their sales and ingredient use are not in
            Inventory yet, so Inventory reports read short until they are posted.
          </div>
        </>
      )}
      {notes > 0 && (
        <div style={bills > 0 ? { marginTop: 10 } : undefined}>
          <strong style={{ color: 'var(--theme-amber-text)' }}>
            ⚠ {notes} credit note{notes === 1 ? '' : 's'} not yet taken off Inventory sales
          </strong>
          <div style={{ marginTop: 4 }}>
            {notes === 1 ? 'It is' : 'They are'} valid and printed, but Inventory still counts the sales
            {notes === 1 ? ' it cancels' : ' they cancel'} until {notes === 1 ? 'it is' : 'they are'} posted.
          </div>
        </div>
      )}

      {sum && sum.bills + sum.notes > 0 ? (
        <>
          {sum.open && (
            <div style={{ ...LINE, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ flex: '1 1 260px' }}>
                {countPhrase(sum.open.bills, sum.open.notes)} {isAre(sum.open.bills, sum.open.notes)} from{' '}
                <strong>{sum.open.label}</strong>, the month open in Inventory.
              </span>
              {button}
            </div>
          )}
          {sum.closed.map(m => (
            <div key={`c-${m.year}-${m.month}`} style={LINE}>
              {countPhrase(m.bills, m.notes)} from <strong>{m.label}</strong>:{' '}
              {ownsClosedMonths
                ? <>that month is closed in Inventory, so post {m.bills + m.notes === 1 ? 'it' : 'them'} from <Link to="/periods">Periods</Link> → Post POS bills to Inventory on {m.label}.</>
                : <>that month is closed in Inventory, and only the Owner can post into a closed month (from Periods). Let the Owner know.</>}
            </div>
          ))}
          {sum.unstarted.map(m => (
            <div key={`u-${m.year}-${m.month}`} style={LINE}>
              {countPhrase(m.bills, m.notes)} from <strong>{m.label}</strong>: that month has not been started in
              Inventory yet (the Owner or whoever runs Inventory starts it). Once it is, they can be posted here.
            </div>
          ))}
        </>
      ) : (
        <div style={{ ...LINE, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 260px' }}>
            Post to Inventory posts the ones from the month open in Inventory. Any from a closed month are
            posted by the Owner, from Periods.
            {waiting?.error && <span style={{ color: 'var(--theme-text3)' }}> (Couldn't check which months they are from.)</span>}
          </span>
          {button}
        </div>
      )}
      {resultEl}
    </div>
  )
}
