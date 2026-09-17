import { useState, useEffect, useCallback } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../../context/AuthContext'
import { useScopedDb } from '../../../shared/hooks/useScopedDb'
import Tip from '../../../components/Tip'
import Modal from '../../../components/Modal'
import { BS_MONTHS, getBsToday, daysInBsMonth } from '../../../utils/bsCalendar'
import { errorText, errorLine } from '../../../shared/errorText'
import { useConfirm } from '../../../shared/hooks/useConfirm'
import { SIGHTED_HOLIDAYS, resolveYear, planSeed } from './holidayData'
import { fiscalYearOf } from '../payroll/tds'

function fyLabel(fy) {
  return `FY ${fy}/${(fy + 1).toString().slice(2)}`
}

function fyYearsFrom(holidays) {
  const today = getBsToday()
  const curFy = fiscalYearOf(today.year, today.month).fyStart
  const set = new Set([curFy])
  holidays.forEach(h => set.add(fiscalYearOf(h.bs_year, h.bs_month).fyStart))
  return [...set].sort((a, b) => b - a)
}

const BLANK = { name: '', bs_month: 6, bs_day: 3, holiday_type: 'public', demand_multiplier: '' }

const lbl = {
  fontSize: 11, color: 'var(--theme-text3)', fontWeight: 600,
  letterSpacing: '0.04em', textTransform: 'uppercase',
  display: 'block', marginBottom: 4,
}
const inp = {
  background: 'var(--theme-input-bg)', border: '1px solid var(--theme-border)', borderRadius: 0,
  padding: '8px 10px', fontSize: 13, color: 'var(--theme-text1)', outline: 'none',
  fontFamily: 'inherit', width: '100%', boxSizing: 'border-box',
}

export default function HolidayCalendar() {
  const { clientId, hasHrAccess } = useAuth()
  const { scopedFrom, scopedInsert, scopedUpdate, scopedDelete } = useScopedDb()
  const { ask: askConfirm, confirmEl } = useConfirm()
  const [holidays, setHolidays] = useState([])
  const [loading,  setLoading]  = useState(true)
  // Seed dedupes against the list on screen, so it may only run over a list that actually loaded —
  // after a failed read the list is empty or stale and Seed inserted the whole year again (S748).
  const [loadedOk, setLoadedOk] = useState(false)
  // A holiday decides the 2× overtime rate and scales the Demand Forecast, so changing one is a
  // supervisor's call, as recording overtime is. Staff still read the calendar. The database
  // enforces the same rank (migration 20260914150000).
  const canEdit = hasHrAccess('supervisor')
  const [fyYear,   setFyYear]   = useState(() => {
    const t = getBsToday()
    return fiscalYearOf(t.year, t.month).fyStart
  })
  const [form, setForm] = useState({ open: false, editing: null, ...BLANK })
  const [busy, setBusy] = useState(false)
  const [msg,  setMsg]  = useState('')
  // What the last seed actually did — kept out of `msg` because the coverage note is several
  // sentences and belongs on the page, not squeezed into the header's one-line status span.
  const [seedReport, setSeedReport] = useState(null)

  const load = useCallback(async () => {
    if (!clientId) return
    setLoading(true)
    const { data, error } = await scopedFrom('hr_holiday_calendar')
      .order('bs_year').order('bs_month').order('bs_day')
    setLoading(false)
    // A failed read is not "no holidays" — that is the difference between the 1× and 2× OT rate
    // for every day in the table (S682). Keep the last-good list and say so.
    if (error) { setLoadedOk(false); setMsg('error:Could not load the holiday calendar — the list is from the last successful load, and Seed is off until it loads. ' + errorLine(error)); return }
    setHolidays(data || [])
    setLoadedOk(true)
  }, [clientId, scopedFrom])

  useEffect(() => { load() }, [load])

  const fyYears = fyYearsFrom(holidays)
  if (!fyYears.includes(fyYear)) fyYears.unshift(fyYear)

  // Every row for the year, removed ones included — Seed must see those to leave them out.
  const fyAllRows = holidays
    .filter(h => fiscalYearOf(h.bs_year, h.bs_month).fyStart === fyYear)
  // The calendar itself. A removed holiday (removed_at) is not a holiday for anything: not this
  // table, not the counts, not Overtime or the forecast. It is listed under "Removed" below.
  const fyHolidays = fyAllRows.filter(h => !h.removed_at)
  const fyRemoved  = fyAllRows.filter(h => h.removed_at)

  function openAdd() { setForm({ open: true, editing: null, ...BLANK }); setMsg('') }
  function openEdit(h) {
    setForm({ open: true, editing: h, name: h.name, bs_month: h.bs_month, bs_day: h.bs_day, holiday_type: h.holiday_type, demand_multiplier: h.demand_multiplier ?? '' })
    setMsg('')
  }
  function closeForm() { setForm(f => ({ ...f, open: false, editing: null })) }

  async function saveForm() {
    if (busy) return   // Enter in the name box could submit twice and insert the holiday twice
    if (!clientId) { setMsg('error:No client selected'); return }
    if (!form.name.trim()) { setMsg('error:Holiday name is required'); return }
    const bs_month = parseInt(form.bs_month, 10)
    const bs_day   = parseInt(form.bs_day, 10)
    const bs_year  = resolveYear(fyYear, bs_month)
    const maxDay   = daysInBsMonth(bs_year, bs_month)
    if (!bs_day || bs_day < 1 || bs_day > maxDay) {
      setMsg(`error:Day must be 1–${maxDay} for ${BS_MONTHS[bs_month - 1]}`); return
    }
    const multiplierStr = String(form.demand_multiplier).trim()
    if (multiplierStr && (isNaN(parseFloat(multiplierStr)) || parseFloat(multiplierStr) < 0)) {
      setMsg('error:Demand multiplier must be a positive number (e.g. 0.3 or 1.5), or left blank'); return
    }
    setBusy(true); setMsg('')
    const payload = {
      bs_year, bs_month, bs_day, name: form.name.trim(), holiday_type: form.holiday_type,
      demand_multiplier: multiplierStr ? parseFloat(multiplierStr) : null,
    }
    // Typing in a holiday that was removed puts THAT row back rather than inserting a second one
    // on the same day under the same name — which the unique index would refuse anyway.
    const removedTwin = !form.editing && fyRemoved.find(h =>
      h.bs_year === bs_year && h.bs_month === bs_month && h.bs_day === bs_day && h.name === payload.name)
    const { error } = form.editing
      ? await scopedUpdate('hr_holiday_calendar', payload).eq('id', form.editing.id)
      : removedTwin
        ? await scopedUpdate('hr_holiday_calendar', { ...payload, removed_at: null }).eq('id', removedTwin.id)
        : await scopedInsert('hr_holiday_calendar', payload)
    if (error) { setMsg('error:This holiday was not saved. ' + errorLine(error)); setBusy(false); return }
    await load(); closeForm(); setMsg('ok:Saved'); setBusy(false)
  }

  // A holiday drives the 2× OT rate for its date and the demand-forecast multiplier, so the ask
  // names both (S682; was window.confirm).
  //
  // Remove STAMPS the row rather than deleting it (S748, decided with Aashish): Seed matches by
  // name, so a deleted seeded holiday came straight back the next time anyone pressed Seed. A
  // stamped row stays findable, is ignored everywhere a holiday matters, and can be put back.
  function removeHoliday(h) {
    askConfirm({
      title: `Remove "${h.name}"?`,
      confirmLabel: 'Remove Holiday', danger: true, busyLabel: 'Removing…',
      body: (
        <>
          <p style={{ margin: '0 0 8px' }}>
            {BS_MONTHS[h.bs_month - 1]} {h.bs_day}, {h.bs_year} stops being a holiday: overtime entered for it from now on is
            suggested at the weekday rate instead of the holiday rate{h.demand_multiplier != null ? `, and the ×${h.demand_multiplier} demand-forecast multiplier is dropped the next time the forecast runs` : ''}.
            Overtime already entered keeps the rate it was entered at, and attendance for that day is not changed.
          </p>
          <p style={{ margin: 0 }}>
            It moves to the Removed list below this year's calendar. Seed will not add it back, and you can put it back yourself at any time.
          </p>
        </>
      ),
      run: async () => {
        setMsg('')
        const { error } = await scopedUpdate('hr_holiday_calendar', { removed_at: new Date().toISOString() }).eq('id', h.id)
        if (error) { setMsg('error:This holiday was not removed — it is still in the calendar. ' + errorLine(error)); return }
        await load()
      },
    })
  }

  async function putBack(h) {
    if (busy) return
    setBusy(true); setMsg('')
    const { error } = await scopedUpdate('hr_holiday_calendar', { removed_at: null }).eq('id', h.id)
    if (error) { setMsg('error:' + h.name + ' was not put back — it is still removed. ' + errorLine(error)); setBusy(false); return }
    // A Seed report still on screen says this one was "not added back, because you removed it" —
    // stale the moment it is put back, and it sat right beside the "is back" confirmation.
    setSeedReport(r => r && r.keptRemoved.includes(h.name) ? { ...r, keptRemoved: r.keptRemoved.filter(n => n !== h.name) } : r)
    await load(); setMsg('ok:' + h.name + ' is back in the calendar'); setBusy(false)
  }

  // Deleting for good forgets the removal too, so for a gazetted holiday the next Seed adds it
  // again — which is exactly what someone reaching for this (a typo'd hand-entered day) wants, and
  // exactly what the confirm has to say for everyone else.
  function deleteForGood(h) {
    askConfirm({
      title: `Delete "${h.name}" for good?`,
      confirmLabel: 'Delete for good', danger: true, busyLabel: 'Deleting…',
      body: (
        <p style={{ margin: 0 }}>
          This erases the row entirely, including the note that you removed it. If it is a gazetted holiday, the next Seed
          for {fyLabel(fyYear)} will add it back. To keep it out of the calendar, leave it in the Removed list instead.
        </p>
      ),
      run: async () => {
        setMsg('')
        const { error } = await scopedDelete('hr_holiday_calendar').eq('id', h.id)
        if (error) { setMsg('error:' + h.name + ' was not deleted — it is still in the Removed list. ' + errorLine(error)); return }
        await load()
      },
    })
  }

  // Seed one fiscal year from both tables. Deliberately additive and name-keyed: a client who has
  // already entered "Bijaya Dashami" by hand keeps their row, and a client who has customised a
  // movable date (a local jatra observed a day apart) is never overruled — the gazette is a
  // starting point for those, not an authority over a decision the owner already made.
  //
  // The one exception is a FIXED holiday found on the wrong date. Those dates are definitional, so
  // a mismatch is an error rather than a preference, and skipping it would leave the Magh 5
  // Martyrs' Day bug sitting in every calendar that already has one. The correction is named in
  // the result so it is never silent.
  async function seedYear() {
    if (!clientId) { setMsg('error:No client selected'); return }
    if (!loadedOk) { setMsg('error:The calendar has not loaded, so Seed cannot tell what is already there — reload the page first.'); return }
    setBusy(true); setMsg(''); setSeedReport(null)

    // fyAllRows, not fyHolidays: a removed holiday must count as present or Seed re-adds it.
    const { toInsert, corrections: planned, missing, keptRemoved } = planSeed(fyYear, fyAllRows)
    const corrections = planned.map(c => ({
      ...c,
      from: `${BS_MONTHS[c.fromMonth - 1]} ${c.fromDay}`,
      to:   `${BS_MONTHS[c.toMonth - 1]} ${c.toDay}`,
    }))

    if (toInsert.length > 0) {
      const { error } = await scopedInsert('hr_holiday_calendar', toInsert)
      if (error) { setMsg('error:' + errorText(error, 'operator')); setBusy(false); return }
    }
    for (const c of corrections) {
      const { error } = await scopedUpdate('hr_holiday_calendar', c.patch).eq('id', c.id)
      if (error) { setMsg('error:' + errorText(error, 'operator')); setBusy(false); return }
    }

    await load()
    setSeedReport({ added: toInsert.length, corrections, missing, keptRemoved })
    setMsg(toInsert.length || corrections.length
      ? `ok:${toInsert.length} added${corrections.length ? `, ${corrections.length} corrected` : ''}`
      : 'ok:Already up to date')
    setBusy(false)
  }

  const bs_month_form = parseInt(form.bs_month, 10)
  const bs_year_form  = resolveYear(fyYear, bs_month_form)
  const maxDay        = daysInBsMonth(bs_year_form, bs_month_form)

  const publicCount   = fyHolidays.filter(h => h.holiday_type === 'public').length
  const optionalCount = fyHolidays.filter(h => h.holiday_type === 'optional').length

  if (!hasHrAccess('staff')) return <Navigate to="/dashboard" replace />

  return (
    <div>
      {/* Header */}
      <div className="page-header page-header--split">
        <div>
          <h1 className="page-title">Holiday Calendar</h1>
          <p className="page-subtitle">Nepal public and optional holidays per fiscal year — used for OT rate and attendance reference</p>
        </div>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            className="form-select"
            aria-label="Fiscal year"
            value={fyYear}
            onChange={e => { setFyYear(parseInt(e.target.value, 10)); setMsg('') }}
          >
            {fyYears.map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
          </select>
          {canEdit && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Tip text={`Fills this fiscal year from the Nepal Gazette — the fixed-date holidays (New Year, Republic Day, Constitution Day, Prithvi Jayanti, Maghe Sankranti, Martyrs' Day, Democracy Day) plus every gazetted movable one we hold for it: Dashain, Tihar, Chhath, Shivaratri, the three Lhosars, Holi and the rest. It never changes the date or type of a holiday you entered or edited, and it tells you what it could not cover. A fixed-date holiday found on the wrong date is corrected, and a holiday you removed stays removed. ${SIGHTED_HOLIDAYS} have no gazetted date and always need adding by hand.`} width={360}>
              <button className="btn btn-ghost" onClick={seedYear} disabled={busy || !loadedOk} style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                ＋ Seed {fyLabel(fyYear)}
              </button>
            </Tip>
            <button className="btn btn-primary" onClick={openAdd} style={{ whiteSpace: 'nowrap' }}>
              + Add Holiday
            </button>
          </div>
          )}
          {msg && <span role="status" style={{ fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)', marginLeft: 'auto' }}>{msg.split(':').slice(1).join(':')}</span>}
        </div>
      </div>

      {/* What the seed did, and what it could not do. The coverage gap is the important half: a
          fiscal year runs into a BS year whose gazette is published only in Falgun of the year
          before, so the tail of the current FY genuinely cannot be filled yet — and saying so is
          the difference between a known gap and a calendar the owner believes is complete. */}
      {seedReport && (
        <div className="card" role="status" style={{ padding: '12px 16px', marginBottom: 16, fontSize: 12, color: 'var(--theme-text2)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <strong style={{ color: 'var(--theme-text1)' }}>
              {seedReport.added > 0 ? `Added ${seedReport.added} holiday${seedReport.added > 1 ? 's' : ''} to ${fyLabel(fyYear)}.` : `${fyLabel(fyYear)} was already up to date.`}
            </strong>
            <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setSeedReport(null)}>Dismiss</button>
          </div>
          {seedReport.corrections.map(c => (
            <div key={c.id} style={{ color: 'var(--theme-amber-text)' }}>
              {c.movedDate ? (
                <>Corrected <strong>{c.name}</strong>: {c.from} → {c.to}. The old date was wrong, so overtime worked on the real holiday was being paid at the weekday rate.</>
              ) : (
                <>Renamed <strong>{c.renamed}</strong> to <strong>{c.name}</strong> — same day, current wording.</>
              )}
            </div>
          ))}
          {seedReport.keptRemoved.length > 0 && (
            <div>
              Not added back, because you removed {seedReport.keptRemoved.length > 1 ? 'them' : 'it'}: <strong>{seedReport.keptRemoved.join(', ')}</strong>. Put one back from the Removed list if you want it.
            </div>
          )}
          {seedReport.missing.length > 0 && (
            <div>
              No movable holidays are held for <strong>BS {seedReport.missing.join(' and ')}</strong> yet — Nepal gazettes them only in Falgun of the preceding year, so {seedReport.missing.length > 1 ? 'those months' : 'that part of this fiscal year'} carries fixed-date holidays only for now. Add any you need by hand.
            </div>
          )}
          <div style={{ color: 'var(--theme-text3)' }}>
            {SIGHTED_HOLIDAYS} have no gazetted date and are never seeded. Holi is seeded for both Hill (Chaitra 7) and Terai (Chaitra 8) — remove whichever does not apply to your outlet; Seed will not add it back.
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Gazetted public holidays — staff are entitled to the day off. Overtime entered for a public holiday in Overtime is suggested at the 2× holiday rate." width={280}>
              Public Holidays
            </Tip>
          </div>
          <div className="stat-value" style={{ color: 'var(--theme-accent-ink)' }}>{publicCount}</div>
          <div className="stat-sub">{fyLabel(fyYear)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">
            <Tip text="Holidays gazetted only for part of the country or a community — Teej for women, Gai Jatra in the Kathmandu Valley, Christmas — plus any floating day you add. Overtime on them is suggested at the weekday rate." width={280}>
              Optional Holidays
            </Tip>
          </div>
          <div className="stat-value" style={{ color: 'var(--theme-purple-text)' }}>{optionalCount}</div>
          <div className="stat-sub">{fyLabel(fyYear)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total</div>
          <div className="stat-value">{publicCount + optionalCount}</div>
          <div className="stat-sub">this fiscal year</div>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="loading-state">Loading…</div>
      ) : fyHolidays.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📆</div>
          <p className="empty-state-text">
            No holidays for {fyLabel(fyYear)} yet.{' '}
            {canEdit
              ? <>Click <strong>Seed {fyLabel(fyYear)}</strong> to fill it from the Nepal Gazette — Dashain, Tihar, Chhath, Shivaratri, the Lhosars and the fixed-date national holidays. {SIGHTED_HOLIDAYS} carry no gazetted date and need adding by hand.</>
              : <>A supervisor or manager can fill it from the Nepal Gazette.</>}
          </p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 32, textAlign: 'center' }}>#</th>
                  <th>Holiday Name</th>
                  <th><Tip text="BS month the holiday falls in." width={160}>Month</Tip></th>
                  <th style={{ textAlign: 'center' }}>Day</th>
                  <th style={{ textAlign: 'center' }}>
                    <Tip text="The actual BS year of this date. Months 1–3 (Baishakh–Ashadh) belong to the second BS year of the fiscal year." width={280}>
                      BS Year
                    </Tip>
                  </th>
                  <th>
                    <Tip text="Public = gazetted (2× OT if staff work). Optional = floating, at employer discretion." width={260}>
                      Type
                    </Tip>
                  </th>
                  <th>
                    <Tip text="Scales Demand Forecast on this day. Blank = flagged but unadjusted." width={260}>
                      Demand
                    </Tip>
                  </th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {fyHolidays.map((h, i) => (
                  <tr key={h.id}>
                    <td style={{ textAlign: 'center', color: 'var(--theme-text3)', fontSize: 11 }}>{i + 1}</td>
                    <td style={{ fontWeight: 600, color: 'var(--theme-text1)' }}>{h.name}</td>
                    <td style={{ color: 'var(--theme-text2)' }}>{BS_MONTHS[h.bs_month - 1]}</td>
                    <td style={{ textAlign: 'center', color: 'var(--theme-text3)' }}>{h.bs_day}</td>
                    <td style={{ textAlign: 'center', color: 'var(--theme-text3)', fontSize: 12 }}>{h.bs_year}</td>
                    <td>
                      {/* Brass / purple, matching this page's own two stat cards above (Public =
                          accent-ink, Optional = purple-text). They used to be amber / grey down
                          here, so the same two categories were coloured twice, differently, on one
                          screen — and amber additionally means "waiting on you" throughout HR,
                          which a gazetted holiday is not. */}
                      <span className={h.holiday_type === 'public' ? 'badge-yellow' : 'badge-purple'} style={{ fontSize: 11 }}>
                        {h.holiday_type === 'public' ? 'Public' : 'Optional'}
                      </span>
                    </td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>
                      {h.demand_multiplier != null ? `×${h.demand_multiplier}` : <span style={{ color: 'var(--theme-text3)' }}>—</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {canEdit && (
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => openEdit(h)} aria-label={`Edit ${h.name}`}>Edit</button>
                          <button className="btn btn-danger btn-sm" onClick={() => removeHoliday(h)} aria-label={`Remove ${h.name}`}>Remove</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Removed holidays (S748). Kept so Seed leaves them out, shown so that is never a mystery,
          and reversible. Not a holiday for anything — no count, no overtime rate, no forecast. */}
      {!loading && fyRemoved.length > 0 && (
        <div className="card" style={{ padding: 0, marginTop: 16 }}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--theme-border)' }}>
            <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--theme-text1)' }}>
              <Tip text="Holidays taken out of this fiscal year. They are not holidays for overtime or the Demand Forecast, and Seed will not add them back. Put one back to restore it exactly as it was." width={300}>
                Removed from {fyLabel(fyYear)} ({fyRemoved.length})
              </Tip>
            </h2>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Holiday Name</th>
                  <th>Date</th>
                  <th>Type</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {fyRemoved.map(h => (
                  <tr key={h.id}>
                    <td style={{ color: 'var(--theme-text2)' }}>{h.name}</td>
                    <td style={{ color: 'var(--theme-text2)', whiteSpace: 'nowrap' }}>{BS_MONTHS[h.bs_month - 1]} {h.bs_day}, {h.bs_year}</td>
                    <td style={{ color: 'var(--theme-text2)', fontSize: 12 }}>{h.holiday_type === 'public' ? 'Public' : 'Optional'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {canEdit && (
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button className="btn btn-ghost btn-sm" onClick={() => putBack(h)} disabled={busy} aria-label={`Put back ${h.name}`}>Put back</button>
                          <button className="btn btn-danger btn-sm" onClick={() => deleteForGood(h)} aria-label={`Delete ${h.name} for good`}>Delete for good</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, fontSize: 11, color: 'var(--theme-text2)', lineHeight: 1.7 }}>
        <strong style={{ color: 'var(--theme-text2)' }}>Holiday overtime:</strong> overtime entered in Overtime for a public holiday is suggested at 2× the regular hourly rate; optional holidays follow company policy. Each overtime entry keeps the rate it was entered at, so a later change here does not reprice it.
        <br />Seed fills each fiscal year from the Nepal Gazette, for every BS year we hold a gazette for. {SIGHTED_HOLIDAYS} have no gazetted date and are always added by hand.
        {!canEdit && <><br />View only — holidays set the overtime rate, so only an HR supervisor or manager can change them.</>}
      </div>

      {/* Add / Edit Modal */}
      {form.open && (
        <Modal onClose={closeForm} title={form.editing ? 'Edit Holiday' : `Add Holiday — ${fyLabel(fyYear)}`} maxWidth={460}>
          {/* Name */}
          <label style={lbl} htmlFor="hol-name">Holiday Name *</label>
          <input
            id="hol-name"
            style={inp}
            value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            placeholder="e.g. Vijaya Dashami"
            autoFocus
            onKeyDown={e => e.key === 'Enter' && saveForm()}
          />

          {/* Month + Day */}
          <div style={{ display: 'flex', gap: 12, marginTop: 14 }}>
            <div style={{ flex: 2 }}>
              <label style={lbl} htmlFor="hol-bs-month">
                <Tip text="Select the BS month. FY months 4–12 are Shrawan–Chaitra of the FY start year; months 1–3 are Baishakh–Ashadh of the following BS year." width={300}>
                  BS Month *
                </Tip>
              </label>
              <select
                id="hol-bs-month"
                className="form-select"
                style={{ width: '100%' }}
                value={form.bs_month}
                onChange={e => setForm(f => ({ ...f, bs_month: parseInt(e.target.value, 10), bs_day: 1 }))}
              >
                {BS_MONTHS.map((name, i) => (
                  <option key={i + 1} value={i + 1}>{i + 1} — {name}</option>
                ))}
              </select>
              <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 4 }}>
                stored as BS year {bs_year_form}
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={lbl} htmlFor="hol-bs-day">Day *</label>
              <input
                id="hol-bs-day"
                type="number"
                style={{ ...inp, textAlign: 'center' }}
                value={form.bs_day}
                min={1}
                max={maxDay}
                onChange={e => setForm(f => ({ ...f, bs_day: e.target.value }))}
              />
              <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 4, textAlign: 'center' }}>
                max {maxDay}
              </div>
            </div>
          </div>

          {/* Type — a radio group has no single control to point a htmlFor at, so the
              group gets a real <fieldset>/<legend> instead; each option's own label wraps
              its input and is therefore already associated. */}
          <fieldset style={{ border: 'none', padding: 0, margin: '14px 0 0', minWidth: 0 }}>
            <legend style={{ ...lbl, padding: 0 }}>
              <Tip text="Public = gazetted by Nepal government (all staff entitled to day off; 2× OT rate if worked). Optional = employer-discretion floating holiday." width={300}>
                Holiday Type *
              </Tip>
            </legend>
            <div style={{ display: 'flex', gap: 20, marginTop: 6 }}>
              {[{ key: 'public', label: 'Public (Gazetted)' }, { key: 'optional', label: 'Optional / Floating' }].map(t => (
                <label key={t.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer', color: 'var(--theme-text1)' }}>
                  <input
                    type="radio"
                    name="htype"
                    value={t.key}
                    checked={form.holiday_type === t.key}
                    onChange={() => setForm(f => ({ ...f, holiday_type: t.key }))}
                  />
                  {t.label}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Demand Multiplier */}
          <div style={{ marginTop: 14 }}>
            <label style={lbl} htmlFor="hol-demand-multiplier">
              <Tip text="Scales this day's Demand Forecast (covers, revenue, and item quantities) by this factor — e.g. 0.3 if you close/run quiet on this day, 1.5 if it's your busiest day of the year. Leave blank for no adjustment; the day still shows a holiday flag either way." width={320}>
                Demand Multiplier (optional)
              </Tip>
            </label>
            <input
              id="hol-demand-multiplier"
              type="number" min="0" step="0.1"
              style={{ ...inp, width: 120 }}
              value={form.demand_multiplier}
              onChange={e => setForm(f => ({ ...f, demand_multiplier: e.target.value }))}
              placeholder="e.g. 1.5"
            />
            <div style={{ fontSize: 10, color: 'var(--theme-text2)', marginTop: 4 }}>
              Feeds Demand Forecast and Roster's Labor Forecast tab. Blank = forecast unaffected.
            </div>
          </div>

          {msg && (
            <div role="alert" style={{ marginTop: 12, fontSize: 12, color: msg.startsWith('ok') ? 'var(--theme-green-text)' : 'var(--theme-red-text)' }}>
              {msg.split(':').slice(1).join(':')}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
            <button className="btn btn-ghost" onClick={closeForm}>Cancel</button>
            <button className="btn btn-primary" onClick={saveForm} disabled={busy}>
              {busy ? 'Saving…' : 'Save Holiday'}
            </button>
          </div>
        </Modal>
      )}
      {confirmEl}
    </div>
  )
}
