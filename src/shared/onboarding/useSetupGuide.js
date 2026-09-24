// The setup guide's data and actions (S790): who is looking, whether the dashboard offers the
// guide, each person's saved choices (onboarding_progress), and the "is it done" signals.
//
// Everything here is lazy and card-only — nothing is added to AuthContext's per-login reads, so a
// client who is past the guide's window pays one small clients read and one progress read on the
// dashboard, and no signal reads at all.
//
// Crest admin viewing a client is READ-ONLY by construction: every write below returns early for
// admin, and the table's policies refuse an admin write as a second lock. What admin sees is the
// union of the client's logins' choices, so support can tell where a client is stuck.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth, planHasFeature } from '../../context/AuthContext'
import { useScopedDb } from '../hooks/useScopedDb'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { supabase } from '../../supabaseClient'
import { withTimeout } from '../../utils/withTimeout'
import { getBsToday, daysInBsMonth } from '../../utils/bsCalendar'
import { asActionError } from '../../components/ActionError'
import {
  viewerOf, stepsForViewer, signalsNeeded, buildSetupGuide, dashboardMode, eligibleFor, monthEndWindow,
} from './setupSteps'
import { loadSetupSignals } from './setupSignals'

const TABLE = 'onboarding_progress'
const CARD_KEY = 'card'
const FOCUS_PREFIX = 'focus.'
// When two of a client's logins disagree about a step, admin's union view shows the furthest one.
const STATE_RANK = { done: 4, skipped: 3, opened: 2 }

function progressMaps(rows, forAdmin) {
  const steps = {}
  let card = null
  let focus = null
  let focusAt = ''
  for (const r of rows || []) {
    if (r.step_key === CARD_KEY) {
      if (!forAdmin) card = r.state
      else if (r.state === 'reopened') card = 'reopened'
      continue
    }
    if (r.step_key.startsWith(FOCUS_PREFIX)) {
      if (r.state === 'chosen' && (r.updated_at || '') >= focusAt) {
        focus = r.step_key.slice(FOCUS_PREFIX.length)
        focusAt = r.updated_at || ''
      }
      continue
    }
    const prev = steps[r.step_key]
    if (!prev || (STATE_RANK[r.state] || 0) > (STATE_RANK[prev] || 0)) steps[r.step_key] = r.state
  }
  return { steps, card, focus }
}

export function useSetupGuide({ surface = 'dashboard' } = {}) {
  const { profile, isAdmin, isOwner, clientId, clientModules, hasFeature, loading: authLoading } = useAuth()
  const { scopedFrom, scopedUpsert, scopedDelete } = useScopedDb()
  const req = useLatestRequest()

  const viewerRaw = viewerOf({ isAdmin, isOwner, profile })
  // Keyed on its values, not the object: profile is replaced on every profile reload, and the
  // effects below must not re-run their reads for a viewer that has not changed.
  const viewerKey = viewerRaw ? `${viewerRaw.kind}:${viewerRaw.module || ''}:${viewerRaw.rank || ''}` : ''
  const viewer = useMemo(() => viewerRaw, [viewerKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const userId = profile?.id || null
  const readOnly = viewer?.kind === 'admin'

  // undefined = still loading, null = the read failed
  const [clientRow, setClientRow] = useState(undefined)
  const [clientFlags, setClientFlags] = useState(null)
  const [rows, setRows] = useState(undefined)
  const [signalState, setSignalState] = useState({ signals: {}, firstPeriod: null, loaded: false })
  const [actionError, setActionError] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  // The CLIENT's plan decides which steps exist. For admin, hasFeature() is always true, so a
  // Starter client's guide would show Growth steps to support and not to the client.
  const feature = useCallback(key => (readOnly
    ? planHasFeature(key, { plan: clientRow?.plan || 'starter', flags: clientFlags, posEnabled: !!clientModules.pos })
    : hasFeature(key)), [readOnly, clientRow, clientFlags, clientModules.pos, hasFeature])

  const progressOk = Array.isArray(rows)
  const maps = useMemo(() => progressMaps(progressOk ? rows : [], readOnly), [rows, progressOk, readOnly])
  // Opted in: they asked for it from Help ('reopened'), or have it and shrank it to one line
  // ('hidden'). Either keeps it on their dashboard past the new-client window, so an established
  // client who started it and then pressed Hide for now gets the one line, not nothing.
  const optedIn = maps.card === 'reopened' || maps.card === 'hidden'
  const eligible = useMemo(() => (clientRow === undefined ? undefined
    : eligibleFor({ clientRow, now: new Date(), reopened: optedIn })), [clientRow, optedIn])

  // Phase 1: the client row (window + plan) and this person's saved choices.
  useEffect(() => {
    if (authLoading) return
    if (!viewer || !clientId || !userId) {
      setClientRow(undefined); setRows(undefined); setSignalState({ signals: {}, firstPeriod: null, loaded: false })
      return
    }
    const key = req.begin(`${clientId}:${userId}:${reloadKey}`)
    setClientRow(undefined); setRows(undefined); setSignalState({ signals: {}, firstPeriod: null, loaded: false })
    ;(async () => {
      const progressQuery = readOnly
        ? scopedFrom(TABLE, 'user_id, step_key, state, updated_at')
        : scopedFrom(TABLE, 'user_id, step_key, state, updated_at').eq('user_id', userId)
      const settle = (p, label) => withTimeout(p, 15000, label).catch(err => ({ data: null, error: err }))
      const [c, f, p] = await Promise.all([
        // `clients` is the one table scopedDb does not cover (CLAUDE.md), so it is read raw by id.
        settle(supabase.from('clients').select('created_at, is_trial, trial_approved_at, plan').eq('id', clientId).maybeSingle(), 'Client'),
        readOnly ? settle(scopedFrom('feature_flags', '*').maybeSingle(), 'Feature flags') : Promise.resolve({ data: null, error: null }),
        // A handful of rows per person (one per step they touched) — far below the 1000-row cap,
        // even for admin's union over every login of one client.
        settle(progressQuery.order('updated_at'), 'Setup progress'),
      ])
      if (!req.isCurrent(key)) return
      if (c.error) console.error('Setup guide: client read failed', c.error)
      if (p.error) console.error('Setup guide: progress read failed', p.error)
      setClientRow(c.error ? null : (c.data || null))
      setClientFlags(f.error ? null : (f.data || null))
      setRows(p.error ? null : (p.data || []))
    })()
  }, [authLoading, viewerKey, clientId, userId, readOnly, reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Phase 2: the signals, only once we know the guide can be shown here, and only the ones this
  // viewer's own steps need. Keyed on the sorted signal list rather than on `feature`, which is a
  // new function whenever AuthContext re-renders and would otherwise re-run every read.
  const wantSignals = !!viewer && clientRow !== undefined && rows !== undefined &&
    (surface === 'help' || eligible === true)
  const neededKey = useMemo(() => (viewer
    ? [...signalsNeeded(stepsForViewer({ viewer, modules: clientModules, hasFeature: feature }))].sort().join(',')
    : ''), [viewer, clientModules, feature])
  useEffect(() => {
    if (!wantSignals || !clientId) return
    const needed = new Set(neededKey ? neededKey.split(',') : [])
    const key = req.begin(`${clientId}:${userId}:${reloadKey}:signals`)
    ;(async () => {
      const today = getBsToday()
      const out = await loadSetupSignals({ needed, clientId, scopedFrom, today })
      if (!req.isCurrent(key)) return
      setSignalState({ ...out, loaded: true })
    })()
  }, [wantSignals, clientId, neededKey, reloadKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const monthEndOpen = useMemo(() => monthEndWindow({
    firstPeriod: signalState.firstPeriod, today: getBsToday(), daysIn: daysInBsMonth,
  }), [signalState.firstPeriod])

  const guide = useMemo(() => {
    if (!viewer || !signalState.loaded) return null
    return buildSetupGuide({
      viewer, modules: clientModules, hasFeature: feature,
      signals: signalState.signals, progress: maps.steps, focus: maps.focus, monthEndOpen,
    })
  }, [viewer, clientModules, feature, signalState, maps, monthEndOpen])

  const mode = useMemo(() => dashboardMode({
    viewer, eligible, cardState: maps.card, progressOk, guide,
  }), [viewer, eligible, maps.card, progressOk, guide])

  // ── Writes ──
  // Optimistic: the screen changes at once, and a refused write puts it back and says so. A
  // "started" mark is fire-and-forget (it is a hint, never a tick); everything the person chose
  // on purpose is awaited so a failure can be shown.
  const canWrite = !readOnly && !!userId && !!clientId

  const setLocal = useCallback((stepKey, state) => {
    setRows(prev => {
      if (!Array.isArray(prev)) return prev
      const rest = prev.filter(r => !(r.user_id === userId && r.step_key === stepKey))
      return state == null ? rest : [...rest, { user_id: userId, step_key: stepKey, state, updated_at: new Date().toISOString() }]
    })
  }, [userId])

  const write = useCallback(async (stepKey, state) => {
    if (!canWrite) return false
    // No saved choice is written over progress we could not read — it might be one they made.
    if (!progressOk) {
      setActionError("Your saved setup progress couldn't be read, so nothing was changed. Reload the page and try again.")
      return false
    }
    const before = (rows || []).find(r => r.user_id === userId && r.step_key === stepKey)?.state ?? null
    setActionError(null)
    setLocal(stepKey, state)
    let res
    try {
      res = await withTimeout(
        scopedUpsert(TABLE, { user_id: userId, step_key: stepKey, state, updated_at: new Date().toISOString() },
          { onConflict: 'user_id,client_id,step_key' }),
        15000, 'Saving your setup progress')
    } catch (err) { res = { error: err } }
    if (res?.error) {
      setLocal(stepKey, before)
      setActionError(asActionError(res.error, 'operator'))
      return false
    }
    return true
  }, [canWrite, progressOk, rows, userId, setLocal, scopedUpsert])

  const remove = useCallback(async stepKey => {
    if (!canWrite) return false
    if (!progressOk) {
      setActionError("Your saved setup progress couldn't be read, so nothing was changed. Reload the page and try again.")
      return false
    }
    const before = (rows || []).find(r => r.user_id === userId && r.step_key === stepKey)?.state ?? null
    setActionError(null)
    setLocal(stepKey, null)
    let res
    try {
      res = await withTimeout(
        scopedDelete(TABLE).eq('user_id', userId).eq('step_key', stepKey),
        15000, 'Saving your setup progress')
    } catch (err) { res = { error: err } }
    if (res?.error) {
      setLocal(stepKey, before)
      setActionError(asActionError(res.error, 'operator'))
      return false
    }
    return true
  }, [canWrite, progressOk, rows, userId, setLocal, scopedDelete])

  const markOpened = useCallback(stepKey => {
    if (!canWrite || !progressOk) return
    const have = (rows || []).find(r => r.user_id === userId && r.step_key === stepKey)
    if (have) return
    setLocal(stepKey, 'opened')
    // ignoreDuplicates: never overwrite a 'done' or 'skipped' made on another device.
    void scopedUpsert(TABLE, { user_id: userId, step_key: stepKey, state: 'opened', updated_at: new Date().toISOString() },
      { onConflict: 'user_id,client_id,step_key', ignoreDuplicates: true })
      .then(({ error }) => { if (error) console.error('Setup guide: could not record a started step', error) },
        err => console.error('Setup guide: could not record a started step', err))
  }, [canWrite, progressOk, rows, userId, setLocal, scopedUpsert])

  const actions = useMemo(() => ({
    markOpened,
    markDone: key => write(key, 'done'),
    skip: key => write(key, 'skipped'),
    unskip: key => remove(key),
    chooseFocus: moduleKey => write(`${FOCUS_PREFIX}${moduleKey}`, 'chosen'),
    hide: () => write(CARD_KEY, 'hidden'),
    // From the one-line bar: back to the full card. Stored as 'reopened', not by deleting the row —
    // for an established client the row IS the opt-in, and deleting it would make the guide vanish.
    unhide: () => write(CARD_KEY, 'reopened'),
    dismiss: () => write(CARD_KEY, 'dismissed'),
    // Only offered once every step is done or skipped with nothing unknown (dashboardMode 'celebrate').
    finish: () => (guide?.allDone ? write(CARD_KEY, 'finished') : Promise.resolve(false)),
    reopen: () => write(CARD_KEY, 'reopened'),
    reload: () => setReloadKey(k => k + 1),
  }), [markOpened, write, remove, guide])

  // No client in view (an admin with none selected) or no login yet: there is no guide to show,
  // and "loading" would never end, so the card sees no viewer at all.
  const active = !!viewer && !!clientId && !!userId
  return {
    viewer: active ? viewer : null, readOnly, guide, mode, eligible, cardState: maps.card,
    loading: clientRow === undefined || rows === undefined || (wantSignals && !signalState.loaded),
    progressOk, actions, actionError, clearActionError: () => setActionError(null),
  }
}
