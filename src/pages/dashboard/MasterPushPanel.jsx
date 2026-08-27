import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../../supabaseClient'
import Tip from '../../components/Tip'
import ConfirmModal from '../../components/ConfirmModal'
import ReportLoadError from '../../components/ReportLoadError'

// HQ -> branch master-data push (S617). The UI half of push_master_data().
//
// The design rule this screen exists to enforce: NOTHING is written until an operator has seen a
// per-record plan of what would change. The RPC's dry run returns exactly the rows its write pass
// then applies, so "preview" is not a separate estimate that can drift from the real thing — it
// is the real thing, not committed.
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
    tip: 'Recipe cards and their ingredient lines, remapped to each branch’s own items. An ingredient with no counterpart at that branch is reported, never silently dropped.',
  },
  {
    key: 'prices',
    keys: ['prices'],
    label: 'Selling prices',
    tip: 'Also overwrite each branch’s menu prices with HQ’s. Leave this off if branches price differently — the recipe itself still gets standardised either way.',
    requires: 'recipes',
  },
]

const ACTION_STYLE = {
  create: 'badge-green',
  adopt: 'badge-yellow',
  update: 'badge-gray',
  replaced: 'badge-gray',
  partial: 'badge-amber',
}

export default function MasterPushPanel({ outlets, groupId }) {
  const [hq, setHq] = useState(null)
  const [hqLoading, setHqLoading] = useState(true)
  const [picked, setPicked] = useState({ items: true, recipes: false, prices: false })
  const [targets, setTargets] = useState([])
  const [plan, setPlan] = useState(null)
  const [planError, setPlanError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applied, setApplied] = useState(false)

  const loadHq = useCallback(async () => {
    setHqLoading(true)
    const { data, error } = await supabase
      .from('client_groups')
      .select('hq_client_id')
      .eq('id', groupId)
      .maybeSingle()
    // A failed read must not render as "no HQ configured" — that is a different fact and would
    // send an owner to support to fix something that is already set (S594).
    if (error) setPlanError(error.message)
    else setHq(data?.hq_client_id || null)
    setHqLoading(false)
  }, [groupId])

  useEffect(() => { loadHq() }, [loadHq])

  const branches = outlets.filter(o => o.id !== hq)
  const hqName = outlets.find(o => o.id === hq)?.name

  const entityKeys = ENTITY_CHOICES
    .filter(c => picked[c.key] && (!c.requires || picked[c.requires]))
    .flatMap(c => c.keys)

  const ready = !!hq && targets.length > 0 && entityKeys.length > 0

  async function run(dryRun) {
    setBusy(true)
    setPlanError(null)
    if (dryRun) { setPlan(null); setApplied(false) }
    const { data, error } = await supabase.rpc('push_master_data', {
      p_target_client_ids: targets,
      p_entities: entityKeys,
      p_dry_run: dryRun,
    })
    setBusy(false)
    setConfirmOpen(false)
    if (error) { setPlanError(error.message); setPlan(null); return }
    setPlan(data || [])
    setApplied(!dryRun)
  }

  function toggleTarget(id) {
    setTargets(t => t.includes(id) ? t.filter(x => x !== id) : [...t, id])
    setPlan(null); setApplied(false)
  }
  function toggleEntity(key) {
    setPicked(p => ({ ...p, [key]: !p[key] }))
    setPlan(null); setApplied(false)
  }

  const counts = (plan || []).reduce((acc, r) => {
    acc[r.action] = (acc[r.action] || 0) + 1
    return acc
  }, {})

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 700, margin: '0 0 4px', color: 'var(--theme-text1)' }}>
          Push master data to branches
        </h2>
        <p style={{ fontSize: 12, color: 'var(--theme-text2)', margin: 0 }}>
          {hqLoading ? 'Checking which outlet is HQ…'
            : hq ? <>Copies from <strong>{hqName || 'your HQ outlet'}</strong> into the branches you pick. Nothing is written until you have seen the preview.</>
            : 'No HQ outlet is set for this group yet, so there is nothing to push from — your consultant sets that.'}
        </p>
      </div>

      {hq && (
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
            <button className="btn btn-ghost" onClick={() => run(true)} disabled={!ready || busy}>
              {busy && !confirmOpen ? 'Checking…' : 'Preview changes'}
            </button>
            <button
              className="btn btn-primary"
              onClick={() => setConfirmOpen(true)}
              disabled={!plan || applied || plan.length === 0 || busy}
            >
              Apply to {targets.length} branch{targets.length === 1 ? '' : 'es'}
            </button>
            {!ready && (
              <span style={{ fontSize: 12, color: 'var(--theme-text3)' }}>
                Pick at least one thing to push and one branch.
              </span>
            )}
          </div>

          {planError && <div style={{ marginTop: 14 }}><ReportLoadError error={planError} /></div>}

          {plan && (
            <div style={{ marginTop: 16 }}>
              <p style={{ fontSize: 13, fontWeight: 600, margin: '0 0 8px', color: applied ? 'var(--theme-green-text)' : 'var(--theme-text1)' }} role="status">
                {applied ? 'Done — ' : 'Preview — '}
                {plan.length === 0
                  ? 'nothing to change; these branches already match HQ.'
                  : Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')}
              </p>
              {plan.length > 0 && (
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
                      {plan.map((r, i) => (
                        <tr key={i}>
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

      {confirmOpen && (
        <ConfirmModal
          title="Push master data"
          confirmLabel="Push now"
          danger
          busy={busy}
          onConfirm={() => run(false)}
          onCancel={() => setConfirmOpen(false)}
        >
          <p style={{ margin: 0 }}>
            {counts.create || 0} record(s) will be created, {counts.adopt || 0} existing record(s)
            will be taken over by HQ, and {counts.update || 0} will be overwritten with HQ’s
            version across {targets.length} branch{targets.length === 1 ? '' : 'es'}.
          </p>
          <p style={{ margin: '10px 0 0', color: 'var(--theme-text2)' }}>
            Branch purchase rates are not touched. This cannot be undone from here — a branch would
            have to re-enter anything it had changed.
          </p>
        </ConfirmModal>
      )}
    </div>
  )
}
