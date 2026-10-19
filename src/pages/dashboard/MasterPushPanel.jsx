import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../supabaseClient'
import Tip from '../../components/Tip'
import ReportLoadError from '../../components/ReportLoadError'
import ActionError from '../../components/ActionError'
import { errorInfo } from '../../shared/errorText'
import { fetchAllRows } from '../../shared/fetchAllRows'
import { settleWithin } from '../../utils/withTimeout'
import { useConfirm, CONFIRM_TIMEOUT_MS } from '../../shared/hooks/useConfirm'
import { readPushResult, countOf, countsLine, pushOutcome, PUSH_UNKNOWN_TEXT } from './masterPushResult'

// HQ -> branch master-data push (S617). The UI half of push_master_data().
//
// The design rule this screen exists to enforce: NOTHING is written until an operator has seen a
// per-record plan of what would change. The RPC's dry run returns exactly the rows its write pass
// then applies, so "preview" is not a separate estimate that can drift from the real thing — it
// is the real thing, not committed.
//
// S849 (GROUP-6): the RPC answers one shape for both modes — a 'total' row, a 'summary' row per
// branch × entity × action, then the 'row' rows (masterPushResult.js reads it). A set-returning call
// is cut at 1,000 rows, so the PREVIEW is read in pages by row_no (a dry run writes nothing, so
// reading it again is safe) and the PUSH is called exactly once; its reply lists only the rows that
// need a look, and the counts come from the summary rows, which are never cut.
//
// Entities map to the RPC's p_entities. 'prices' is deliberately separable from 'recipes': a
// branch in a mall legitimately charges more than one on a high street, so pushing the recipe
// definition must not drag its selling price along unless that was actually asked for.
const ENTITY_CHOICES = [
  {
    key: 'items',
    keys: ['categories', 'items'],
    label: 'Items & categories',
    tip: 'The item master and its categories. Purchases, stock count and every IMS report key off items, so this is what makes branch figures comparable at all. A branch keeps its own purchase rate — only the definition is pushed.',
  },
  {
    key: 'recipes',
    keys: ['recipes'],
    label: 'Recipes & ingredients',
    // S849 GROUP-2 (owner SU2 a) and GROUP-12 (owner SU8 a).
    tip: 'Recipe cards and their ingredient lines, remapped to each branch’s own items. A dish whose recipe uses an ingredient this branch does not have is left exactly as the branch has it and listed as skipped, so nothing is lost; a dish new to the branch is added with the lines that match, and the preview names what is missing. The Veg / Egg / Non-veg mark follows HQ, and the preview names every dish whose mark changes. A new dish takes HQ’s description but not its photo — add the photo at the branch. Each branch keeps its own On POS and Active switch for a dish it already has; a new dish starts as it is at HQ, except that it arrives off the till, unpriced, when HQ has no price for it or the branch charges VAT differently.',
  },
  {
    key: 'prices',
    keys: ['prices'],
    label: 'Selling prices',
    tip: 'Also overwrite each branch’s menu prices with HQ’s, and the extra charge on each Crest Customization choice when Choices is ticked. Leave this off if branches price differently — the recipe itself still gets standardised either way. A dish HQ has not priced keeps the branch’s price.',
    requires: 'recipes',
  },
  // S838: Crest Customization. Needs Recipes, because the groups sit on dishes and a choice's
  // stock lines name sub-recipes.
  {
    key: 'options',
    keys: ['options'],
    label: 'Choices and combos (sizes, add-ons, build-your-own, combos)',
    tip: 'Crest Customization’s choice groups and choices, what each one takes from stock, the groups on each dish, the build-your-own mark, and combos with their picks and dishes. A new choice or combo arrives at HQ’s price; after that its price follows Selling prices, and whether it is switched on stays the branch’s own. A choice or combo HQ deletes is switched off at the branch, never deleted, so past bills keep its name. A group the branch made itself is left alone. A new combo whose dish is not at the branch yet arrives switched off, and the preview names the dish.',
    requires: 'recipes',
  },
]

const ACTION_STYLE = {
  create: 'badge-green',
  adopt: 'badge-yellow',
  update: 'badge-gray',
  replaced: 'badge-gray',
  partial: 'badge-amber',
  skipped: 'badge-amber',   // S849 GROUP-2: the branch's own dish (or choice stock lines) kept whole
  change: 'badge-amber',    // S849 GROUP-12: the Veg / Egg / Non-veg mark changes at the branch
  conflict: 'badge-red',
  hide: 'badge-amber',
  warning: 'badge-amber',
}

// A preview recomputes the whole plan on every page it reads, so it gets a longer bound than one
// page would need; the push itself is one statement under the database's own 8-second timeout, and
// its bound stays under the confirm's 30 s so the run reports in its own words first (useConfirm).
const PREVIEW_TIMEOUT_MS = 30000
const PUSH_TIMEOUT_MS = 25000

const s = (n, one, many) => `${n} ${n === 1 ? one : many}`

// outlets: every outlet of the group (get_group_summary's rows, not AuthContext's list).
// readOnly: Crest support's view of a client's group (S849 ACCESS-8) — the push is the Owner's alone,
// so it shows which outlet is HQ and nothing to press.
export default function MasterPushPanel({ outlets, groupId, readOnly = false }) {
  const [hq, setHq] = useState(null)
  const [hqLoading, setHqLoading] = useState(true)
  const [hqError, setHqError] = useState(null)
  const [picked, setPicked] = useState({ items: true, recipes: false, prices: false, options: false })
  const [targets, setTargets] = useState([])
  // The read reply (readPushResult's shape), from a preview or from the push.
  const [plan, setPlan] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [pushError, setPushError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [applied, setApplied] = useState(false)
  const { ask, confirmEl } = useConfirm({
    timeoutMs: CONFIRM_TIMEOUT_MS,
    onTimeout: () => setPushError({ text: PUSH_UNKNOWN_TEXT, detail: '' }),
  })

  const loadHq = useCallback(async () => {
    if (!groupId) return
    setHqLoading(true)
    setHqError(null)
    const { data, error } = await settleWithin(
      supabase.from('client_groups').select('hq_client_id').eq('id', groupId).maybeSingle(),
      20000, 'Reading the HQ outlet')
    // A failed read must not render as "no HQ configured" — that is a different fact and would
    // send an owner to support to fix something that is already set (S594). It has its own slot,
    // shown whatever `hq` holds (it was once rendered only inside the `hq &&` block, so the failure
    // fell through to the "no HQ" sentence).
    if (error) setHqError(error)
    else setHq(data?.hq_client_id || null)
    setHqLoading(false)
  }, [groupId])

  useEffect(() => { loadHq() }, [loadHq])

  // S849 GROUP-1: an HQ that has left the group is no HQ. The server clears it when the HQ moves out
  // and push_master_data refuses one still recorded (hint group_hq_outside); this says why up front.
  const hqInGroup = !!hq && outlets.some(o => o.id === hq)
  const hqLeft = !!hq && !hqInGroup
  const branches = outlets.filter(o => o.id !== hq)
  const hqName = outlets.find(o => o.id === hq)?.name

  const entityKeys = ENTITY_CHOICES
    .filter(c => picked[c.key] && (!c.requires || picked[c.requires]))
    .flatMap(c => c.keys)

  const ready = hqInGroup && targets.length > 0 && entityKeys.length > 0

  async function preview() {
    setBusy(true)
    setPreviewError(null)
    setPushError(null)
    setPlan(null)
    setApplied(false)
    const args = { p_target_client_ids: targets, p_entities: entityKeys, p_dry_run: true }
    const { data, error } = await settleWithin(
      fetchAllRows(() => supabase.rpc('push_master_data', args).order('row_no')),
      PREVIEW_TIMEOUT_MS, 'Preview changes')
    setBusy(false)
    // A preview never writes, so "nothing was pushed" is true whatever went wrong. The error OBJECT
    // goes to ReportLoadError, which words it and keeps the code (S682).
    if (error) { setPreviewError(error); return }
    setPlan(readPushResult(data))
  }

  async function push() {
    setBusy(true)
    setPushError(null)
    // Called once, never paged: a second call would push again.
    const { data, error } = await settleWithin(
      supabase.rpc('push_master_data', { p_target_client_ids: targets, p_entities: entityKeys, p_dry_run: false }),
      PUSH_TIMEOUT_MS, 'Push to branches')
    setBusy(false)
    if (error) {
      // GROUP-10: a database answer means the one transaction rolled back; anything else (our
      // timeout, a dropped connection) means we do not know, and the message never claims either.
      const outcome = pushOutcome(error)
      const info = errorInfo(error, 'operator')
      setPushError({ text: outcome.kind === 'not_run' ? `${outcome.text} ${info.text}` : outcome.text, detail: info.detail })
      return
    }
    setPlan(readPushResult(data))
    setApplied(true)
  }

  function askPush() {
    if (!plan) return
    const c = plan.counts
    const skippedDishes = countOf(plan, 'recipes', 'skipped')
    const skippedChoices = countOf(plan, 'choice stock lines', 'skipped')
    const partial = countOf(plan, 'ingredients', 'partial') + countOf(plan, 'choice stock lines', 'partial')
    const marks = countOf(plan, 'food marks', 'change')
    ask({
      title: 'Push master data',
      confirmLabel: 'Push now',
      busyLabel: 'Pushing…',
      danger: true,
      body: (
        <>
          <p style={{ margin: 0 }}>
            {c.create || 0} record(s) will be created, {c.adopt || 0} existing record(s)
            will be taken over by HQ, and {c.update || 0} will be overwritten with HQ’s
            version across {targets.length} branch{targets.length === 1 ? '' : 'es'}.
            {c.hide ? ` ${c.hide} choice(s), combo(s) or group(s) HQ no longer has will be switched off.` : ''}
            {skippedDishes ? ` ${s(skippedDishes, 'dish', 'dishes')} will be left as the branch has ${skippedDishes === 1 ? 'it' : 'them'} because an ingredient is missing there.` : ''}
            {skippedChoices ? ` ${s(skippedChoices, 'choice keeps', 'choices keep')} the branch’s own stock lines for the same reason.` : ''}
            {partial ? ` ${s(partial, 'new dish or choice arrives', 'new dishes or choices arrive')} without the lines the branch cannot match — listed above.` : ''}
            {marks ? ` ${s(marks, 'dish changes', 'dishes change')} food mark — listed above.` : ''}
            {c.conflict ? ` ${c.conflict} record(s) in conflict will be skipped — each row says what stands in the way.` : ''}
          </p>
          <p style={{ margin: '10px 0 0', color: 'var(--theme-text2)' }}>
            Branch purchase rates are not touched. This cannot be undone from here — a branch would
            have to re-enter anything it had changed.
          </p>
        </>
      ),
      run: push,
    })
  }

  function toggleTarget(id) {
    setTargets(t => t.includes(id) ? t.filter(x => x !== id) : [...t, id])
    setPlan(null); setApplied(false); setPushError(null)
  }
  function toggleEntity(key) {
    setPicked(p => ({ ...p, [key]: !p[key] }))
    setPlan(null); setApplied(false); setPushError(null)
  }

  const subtitle = hqLoading ? 'Checking which outlet is HQ…'
    : hqError ? null
    : hqLeft ? (readOnly
      ? 'This group’s HQ outlet has left the group, so there is nothing to push from. Set a new HQ outlet in Admin → Clients → the client’s Billing tab.'
      : 'This group’s HQ outlet has left the group, so there is nothing to push from. Ask Crest support to set a new HQ outlet.')
    : !hq ? (readOnly
      ? 'No HQ outlet is set for this group yet, so there is nothing to push from. Set one in Admin → Clients → the client’s Billing tab.'
      : 'No HQ outlet is set for this group yet, so there is nothing to push from — your consultant sets that.')
    : readOnly ? <>HQ outlet: <strong>{hqName}</strong>. Only the group’s Owner can push or change access.</>
    : <>Copies from <strong>{hqName}</strong> into the branches you pick. Nothing is written until you have seen the preview.</>

  return (
    <div className="card" style={{ marginTop: 28 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px', color: 'var(--theme-text1)' }}>
          Push master data to branches
        </h2>
        {subtitle && <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0 }}>{subtitle}</p>}
        {hqError && (
          <div style={{ marginTop: 8 }}>
            <ReportLoadError error={hqError} />
            <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '6px 0 0' }}>
              Could not read which outlet is the HQ, so nothing can be pushed yet.{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadHq}>Try again</button>
            </p>
          </div>
        )}
      </div>

      {hqInGroup && !readOnly && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 16 }}>
            <div className="form-field" style={{ margin: 0 }} role="group" aria-labelledby="push-what-label">
              <span className="field-label" id="push-what-label">What to push</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {ENTITY_CHOICES.map(c => {
                  const blocked = c.requires && !picked[c.requires]
                  return (
                    <label key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: blocked ? 'not-allowed' : 'pointer', opacity: blocked ? 0.5 : 1 }}>
                      <input
                        type="checkbox"
                        checked={!!picked[c.key] && !blocked}
                        disabled={blocked || busy}
                        onChange={() => toggleEntity(c.key)}
                      />
                      <Tip text={c.tip} width={320}>{c.label}</Tip>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="form-field" style={{ margin: 0 }} role="group" aria-labelledby="push-where-label">
              <span className="field-label" id="push-where-label">Which branches</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                {branches.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>This group has no branches besides HQ.</span>
                ) : branches.map(o => (
                  <label key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer' }}>
                    <input type="checkbox" checked={targets.includes(o.id)} disabled={busy} onChange={() => toggleTarget(o.id)} />
                    {o.name}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <button className="btn btn-ghost" onClick={preview} disabled={!ready || busy}>
              {busy && !plan ? 'Checking…' : 'Preview changes'}
            </button>
            <button
              className="btn btn-primary"
              onClick={askPush}
              disabled={!plan || applied || plan.total === 0 || busy}
            >
              Apply to {targets.length} branch{targets.length === 1 ? '' : 'es'}
            </button>
            {!ready && (
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                Pick at least one thing to push and one branch.
              </span>
            )}
          </div>

          {previewError && (
            <div style={{ marginTop: 14 }}>
              <ReportLoadError error={previewError} />
              <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '6px 0 0' }}>The preview could not be built, so nothing was pushed.</p>
            </div>
          )}
          {pushError && <div style={{ marginTop: 14 }}><ActionError error={pushError} /></div>}

          {plan && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px', color: applied ? 'var(--theme-green-text)' : 'var(--theme-text1)' }} role="status">
                {applied ? 'Done — ' : 'Preview — '}
                {Object.keys(plan.counts).length === 0
                  ? (applied ? 'nothing needed changing; these branches already matched HQ.' : 'nothing to change; these branches already match HQ.')
                  : countsLine(plan.counts)}
              </p>
              {plan.byBranch.length > 1 && (
                <ul style={{ margin: '0 0 8px', paddingLeft: 18, fontSize: 12, color: 'var(--theme-text2)' }}>
                  {plan.byBranch.map(b => <li key={b.id}>{b.name}: {countsLine(b.counts)}</li>)}
                </ul>
              )}
              {applied && plan.rows.length > 0 && (
                <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: '0 0 8px' }}>
                  Routine creates and updates are counted above; the rows below need a look.
                </p>
              )}
              {!plan.complete && (
                <p className="note-banner" style={{ margin: '0 0 8px', fontSize: 12 }}>
                  The list was too long to show in full: {plan.rows.length.toLocaleString('en-IN')} of {plan.total.toLocaleString('en-IN')} rows arrived.
                  {applied ? ' Everything listed in the counts was applied; Preview again to read each branch.' : ' Preview again to read the rest.'}
                </p>
              )}
              {plan.rows.length > 0 && (
                <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Branch</th>
                        <th>Type</th>
                        <th>Action</th>
                        <th>Record</th>
                        <th>Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.rows.map((r, i) => (
                        <tr key={r.row_no ?? i}>
                          <td style={{ whiteSpace: 'nowrap' }}>{r.target_client_name}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>{r.entity}</td>
                          <td><span className={ACTION_STYLE[r.action] || 'badge-gray'}>{r.action}</span></td>
                          <td>{r.record_name}</td>
                          <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{r.detail || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {confirmEl}
    </div>
  )
}
