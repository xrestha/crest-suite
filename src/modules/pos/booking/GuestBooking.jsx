import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../../../supabaseClient'
import { adToBsSafe, formatBsDay, BS_MONTHS, BS_MONTHS_SHORT } from '../../../utils/bsCalendar'
import { nepalCivilDate, nepalTime, nepalBs, nepalDateLong } from '../../../shared/nepalTime'
import { normalizePhone } from '../../../utils/phone'
import { durationFor } from '../reservations/reservationSettings'
import { loadMapFrom, slotIsFull, dayFlags } from './bookingAvailability'
import './guestBooking.css'

// Fully public, unauthenticated page — reached from the outlet's booking QR or link (printed from
// Table Management → Reservations). Copies the guest menu's shape line for line: the client UUID
// in the URL is the credential, get_booking_page decides whether this outlet takes online
// bookings at all, submit_reservation_request does every check server-side, and the guest's own
// request is polled by its unguessable id. Nothing self-confirms: a request waits for a staff
// Accept on the Reservations page, and this page turns from Requested to Confirmed when it lands.

const DAYS_AHEAD = 14
const SLOT_MINUTES = 30
// English day names, because the first pill says "Today" in English and a strip that switches
// language after one chip reads as a mistake. The BS date under it is where the Nepali calendar
// lives on this page.
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// What the page says for each refusal the server can return. The RPC's own `message` is safe
// to render, but it says "the restaurant" — and a client may be a cafe, a bar, a banquet hall or
// a hotel. The copy lives here so it can name the outlet instead, with the server text as the
// fallback for any code this map does not know.
function refusalCopy(code, outlet, maxParty, lead) {
  const who = outlet || 'them'
  switch (code) {
    case 'closed':   return `Online booking isn't available for ${who} right now. Please call or message directly.`
    case 'name':     return 'Please tell us your name.'
    case 'phone':    return 'Please enter a 10-digit mobile number.'
    case 'party':    return `Online bookings are for 1 to ${maxParty} guests. For a bigger group, please call or message ${who}.`
    case 'too_soon': return `Please book at least ${lead} minutes ahead, or call ${who} for a table right now.`
    case 'too_far':  return 'Online booking is open up to 14 days ahead.'
    case 'hours':    return `That time is outside ${who}'s booking hours — pick another slot.`
    case 'rate':     return `Too many booking requests from this connection. Please call or message ${who} instead.`
    case 'pending':  return `You already have a booking request waiting for ${who} to confirm.`
    case 'closed_day': return `${who} is closed that day — pick another day.`
    case 'walk_in':  return `${who} takes walk-ins only that day — just come by.`
    case 'full':     return `That time is now fully booked. Pick another slot, or call ${who} to ask.`
    default:         return null
  }
}

const sessionKey = clientId => `guestBooking:${clientId}`
function loadStored(clientId) {
  try { const raw = sessionStorage.getItem(sessionKey(clientId)); return raw ? JSON.parse(raw) : null } catch { return null }
}

// 'YYYY-MM-DD' for a Date's LOCAL calendar fields — the formatAd rule, spelled out here so this
// file never reaches for toISOString on a day.
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
const parseHM = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? [Number(m[1]), Number(m[2])] : null }
const label12 = (h, m) => `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`

// The next DAYS_AHEAD days as calendar cells: BS day first (PRODUCT.md), the AD date under it.
// A two-week calendar rather than a scrolling strip, so day twelve is as visible as day one and
// a guest never has to discover a sideways scroll to reach it.
function buildDays(today) {
  const out = []
  for (let i = 0; i < DAYS_AHEAD; i++) {
    const d = new Date(today); d.setDate(d.getDate() + i)
    const bs = adToBsSafe(d)
    out.push({
      iso: ymd(d),
      weekdayIdx: d.getDay(),
      weekday: WEEKDAY[d.getDay()],
      bs,
      bsNum: bs ? String(bs.day) : String(d.getDate()),
      bsMonthShort: bs ? BS_MONTHS_SHORT[bs.month - 1] : MONTH_SHORT[d.getMonth()],
      bsLong: bs ? formatBsDay(bs.day, bs.month) : `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`,
      adLabel: `${d.getDate()} ${MONTH_SHORT[d.getMonth()]}`,
      isToday: i === 0,
    })
  }
  return out
}

// "Bhadra 2083" or "Bhadra – Ashwin 2083": the caption over the grid, so the BS day numbers in
// the cells are never read against the wrong month.
function monthCaption(days) {
  const first = days[0]?.bs, last = days[days.length - 1]?.bs
  if (!first || !last) return ''
  const name = i => BS_MONTHS[i - 1]
  if (first.month === last.month && first.year === last.year) return `${name(first.month)} ${first.year}`
  if (first.year === last.year) return `${name(first.month)} – ${name(last.month)} ${first.year}`
  return `${name(first.month)} ${first.year} – ${name(last.month)} ${last.year}`
}

// Half-hour slots inside the outlet's hours. An overnight range (17:00 → 02:00) runs to midnight
// on the chosen day; the small hours belong to the next date and are rare enough to phone about.
function buildSlots(openTime, closeTime) {
  const o = parseHM(openTime) || [10, 0]
  const c = parseHM(closeTime) || [22, 0]
  let start = o[0] * 60 + o[1]
  let end = c[0] * 60 + c[1]
  if (end <= start) end = 24 * 60 - SLOT_MINUTES
  // Round the first slot up to the grid, and stop a slot before close so a party is not booked
  // for the minute the doors shut.
  start = Math.ceil(start / SLOT_MINUTES) * SLOT_MINUTES
  const out = []
  for (let t = start; t <= end - SLOT_MINUTES; t += SLOT_MINUTES) out.push({ h: Math.floor(t / 60), m: t % 60 })
  return out
}

export default function GuestBooking() {
  const { clientId } = useParams()
  const [page, setPage] = useState(null)        // null = loading; false = not available; {...} = ready
  const [error, setError] = useState(false)

  const [dayIso, setDayIso] = useState('')
  const [time, setTime] = useState('')
  const [party, setParty] = useState(2)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [occasion, setOccasion] = useState('')
  const [notes, setNotes] = useState('')
  const [fieldErr, setFieldErr] = useState({})
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const [request, setRequest] = useState(() => loadStored(clientId)) // { id, name, party, reservedFor }
  const [status, setStatus] = useState(null)   // { status, reserved_for, party_size, outlet_name, cancel_reason }
  const [statusStale, setStatusStale] = useState(false)
  // 'YYYY-MM-DD|hour' → booked covers, for greying out full slots. Empty when the read fails: the
  // page then offers every slot and the server's own check still refuses a full one.
  const [load, setLoad] = useState({})

  // Today, in Nepal — the day grid must start on the outlet's date, not the phone's.
  const today = useMemo(() => nepalCivilDate(new Date()) || new Date(), [])
  const days = useMemo(() => buildDays(today).map(d => ({ ...d, ...dayFlags(d, page || null) })), [today, page])
  const slots = useMemo(() => (page ? buildSlots(page.open_time, page.close_time) : []), [page])

  useEffect(() => {
    let cancelled = false
    supabase.rpc('get_booking_page', { p_client_id: clientId }).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) { setError(true); return }
      const row = data?.[0]
      setPage(row || false)
    })
    supabase.rpc('get_booking_availability', { p_client_id: clientId }).then(({ data, error: err }) => {
      if (cancelled || err) return
      setLoad(loadMapFrom(data))
    })
    return () => { cancelled = true }
  }, [clientId])

  useEffect(() => {
    const outlet = page?.outlet_name || status?.outlet_name
    if (!outlet) return
    const prev = document.title
    document.title = `Book a table — ${outlet}`
    return () => { document.title = prev }
  }, [page, status])

  // Poll the guest's own request. Same visibility gating and same two-miss stale banner as the
  // guest menu: one dropped request on a cafe's wifi is normal, a flickering banner teaches the
  // guest to ignore it, and a failed read must never render as "declined".
  useEffect(() => {
    if (!request?.id) return
    let cancelled = false
    let failures = 0
    let id = null
    const poll = () => supabase.rpc('get_reservation_request_status', { p_request_id: request.id }).then(({ data, error: err }) => {
      if (cancelled) return
      if (err) { failures += 1; if (failures >= 2) setStatusStale(true); return }
      failures = 0
      setStatusStale(false)
      const row = data?.[0]
      if (row) setStatus(row)
    })
    const start = () => { if (id === null) { poll(); id = setInterval(poll, 5000) } }
    const stop = () => { if (id !== null) { clearInterval(id); id = null } }
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop())
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => { cancelled = true; stop(); document.removeEventListener('visibilitychange', onVisibility) }
  }, [request?.id])

  // The instant the guest picked, pinned to Nepal's offset — never the phone's timezone.
  const reservedFor = dayIso && time ? `${dayIso}T${time}:00+05:45` : null
  const minLeadMs = (page?.min_lead_minutes ?? 60) * 60000
  const slotIsPast = slot => {
    if (!dayIso) return false
    const t = new Date(`${dayIso}T${hm(slot.h, slot.m)}:00+05:45`).getTime()
    return t < Date.now() + minLeadMs
  }
  const visibleSlots = slots.filter(s => !slotIsPast(s))
  const selectedDay = days.find(d => d.iso === dayIso) || null
  // How long this party is expected to sit, from the outlet's own per-band setting — the same
  // number the server uses when it decides whether the slot is full.
  const sittingMinutes = durationFor(party, { duration_by_band: page?.duration_by_band || {} })
  const isFull = slot => slotIsFull({
    dayIso, hm: hm(slot.h, slot.m), party, durationMinutes: sittingMinutes, load, totalSeats: page?.total_seats || 0,
  })
  const allFull = visibleSlots.length > 0 && visibleSlots.every(isFull)

  function validate() {
    const e = {}
    if (!dayIso) e.day = 'Pick a day.'
    if (!time) e.time = 'Pick a time.'
    if (!name.trim()) e.name = 'Please tell us your name.'
    const canonical = normalizePhone(phone)
    if (!canonical || canonical.length !== 10) e.phone = 'Please enter a 10-digit mobile number.'
    setFieldErr(e)
    return Object.keys(e).length === 0
  }

  async function submit(ev) {
    ev.preventDefault()
    if (!validate()) return
    setSubmitting(true); setSubmitError('')
    const { data, error: err } = await supabase.rpc('submit_reservation_request', {
      p_client_id: clientId, p_name: name.trim(), p_phone: phone.trim(), p_party_size: party,
      p_reserved_for: reservedFor, p_occasion: occasion || null, p_notes: notes.trim() || null,
    })
    setSubmitting(false)
    const outlet = page?.outlet_name || ''
    if (err) {
      // Never err.message on a public page (S604): a raw PostgREST string tells the guest nothing
      // they can act on and leaks schema detail. Offline is the one distinction worth drawing.
      console.error('submit_reservation_request failed', err)
      setSubmitError(navigator.onLine === false
        ? `You appear to be offline. Reconnect and try again, or call ${outlet || 'them'}.`
        : `We couldn't send that request. Please try again, or call ${outlet || 'them'}.`)
      return
    }
    if (!data?.ok) {
      // The function's refusals carry a code; the page words them so the outlet is named.
      setSubmitError(
        refusalCopy(data?.code, outlet, page?.max_party_online || 20, page?.min_lead_minutes ?? 60)
        || data?.message
        || `We couldn't take that booking. Please call or message ${outlet || 'them'}.`
      )
      return
    }
    const stored = { id: data.id, name: name.trim(), party, reservedFor }
    try { sessionStorage.setItem(sessionKey(clientId), JSON.stringify(stored)) } catch { /* private mode */ }
    setRequest(stored)
    setStatus(null)
  }

  function bookAnother() {
    try { sessionStorage.removeItem(sessionKey(clientId)) } catch { /* private mode */ }
    setRequest(null); setStatus(null); setStatusStale(false)
    setDayIso(''); setTime(''); setParty(2); setOccasion(''); setNotes('')
  }

  const whenLabel = iso => {
    const bs = nepalBs(iso)
    return `${bs ? `${formatBsDay(bs.day, bs.month)} ${bs.year} ` : ''}(${nepalDateLong(iso)}) at ${nepalTime(iso)}`
  }

  // ── Render ─────────────────────────────────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="guest-booking"><div className="gb-wrap"><div className="gb-empty">
        We couldn't load the booking page just now. Please try again in a moment.
      </div></div></div>
    )
  }
  if (page === null && !request) {
    return <div className="guest-booking"><div className="gb-wrap"><div className="gb-empty">Loading…</div></div></div>
  }

  // A submitted request shows its status card even if the outlet has since switched the page off.
  if (request) {
    const s = status?.status
    const stage = s === 'confirmed' || s === 'arrived' || s === 'seated' || s === 'completed' ? 'confirmed'
      : s === 'cancelled' || s === 'no_show' ? 'declined' : 'requested'
    const outlet = status?.outlet_name || page?.outlet_name || ''
    return (
      <div className="guest-booking"><div className="gb-wrap">
        <header className="gb-head">
          <h1 className="gb-outlet">{outlet}</h1>
          <p className="gb-tagline">Table booking</p>
        </header>
        <div className={`gb-card gb-status gb-status--${stage}`} role="status" aria-live="polite">
          {stage === 'requested' && (<>
            <p className="gb-status-stage">Request sent</p>
            <p className="gb-status-detail">{outlet || 'They'} will confirm shortly. Keep this page open, or come back to it — it updates by itself.</p>
          </>)}
          {stage === 'confirmed' && (<>
            <p className="gb-status-stage">Confirmed ✓</p>
            <p className="gb-status-detail">Your table is booked. See you soon!</p>
          </>)}
          {stage === 'declined' && (<>
            <p className="gb-status-stage">Not available</p>
            <p className="gb-status-detail">
              {status?.cancel_reason ? `${status.cancel_reason}. ` : ''}Please call or message {outlet || 'them'} for another time.
            </p>
          </>)}
          <div className="gb-summary">
            <strong>{request.name}</strong> · {status?.party_size || request.party} guest{(status?.party_size || request.party) === 1 ? '' : 's'}<br />
            {whenLabel(status?.reserved_for || request.reservedFor)}
          </div>
          {statusStale && <p className="gb-alert gb-alert--stale" style={{ marginTop: 12 }}>We've lost touch with the booking system for a moment — this may be out of date. Reconnecting…</p>}
          <button type="button" className="gb-linkbtn" onClick={bookAnother}>Make another booking</button>
        </div>
        <p className="gb-foot">Powered by Crest POS</p>
      </div></div>
    )
  }

  if (page === false) {
    return (
      <div className="guest-booking"><div className="gb-wrap"><div className="gb-empty">
        Online booking isn't available here right now. Please call or message directly.
      </div></div></div>
    )
  }

  return (
    <div className="guest-booking"><div className="gb-wrap">
      <header className="gb-head">
        <h1 className="gb-outlet">{page.outlet_name}</h1>
        <p className="gb-tagline">Book a table · {page.outlet_name} will confirm by message or call</p>
        {page.page_notice && <p className="gb-notice">{page.page_notice}</p>}
      </header>

      <form onSubmit={submit} noValidate>
        <div className="gb-card">
          <div className="gb-cal-top">
            <span className="gb-label" id="gb-day-label" style={{ margin: 0 }}>Day</span>
            <span className="gb-cal-caption">{monthCaption(days)} · next 14 days</span>
          </div>
          <div className="gb-cal" role="group" aria-labelledby="gb-day-label">
            {WEEKDAY.map(w => <span key={w} className="gb-cal-head" aria-hidden="true">{w.slice(0, 3)}</span>)}
            {Array.from({ length: days[0]?.weekdayIdx || 0 }, (_, i) => <span key={`pad-${i}`} aria-hidden="true" />)}
            {days.map(d => {
              const off = d.closed || d.walkIn
              const why = d.closed ? 'closed' : d.walkIn ? 'walk-ins only' : ''
              return (
                <button key={d.iso} type="button" className="gb-day" aria-pressed={dayIso === d.iso} disabled={off}
                  aria-label={`${d.isToday ? 'Today, ' : ''}${d.weekday} ${d.bsLong} (${d.adLabel})${why ? `, ${why}` : ''}`}
                  onClick={() => { setDayIso(d.iso); setTime(''); setFieldErr(e => ({ ...e, day: undefined })) }}>
                  <span className="gb-day-bs">{d.bsNum}</span>
                  <small>{off ? (d.closed ? 'Closed' : 'Walk-in') : d.isToday ? 'Today' : d.bsMonthShort}</small>
                  <small>{d.adLabel}</small>
                </button>
              )
            })}
          </div>
          {fieldErr.day && <span className="gb-err" role="alert">{fieldErr.day}</span>}
        </div>

        <div className="gb-card">
          <span className="gb-label" id="gb-time-label">Time</span>
          {!dayIso ? (
            <p className="gb-note" style={{ margin: 0 }}>Pick a day first.</p>
          ) : visibleSlots.length === 0 ? (
            <p className="gb-note" style={{ margin: 0 }}>No times left today — try another day, or call {page.outlet_name}.</p>
          ) : (
            <>
              <div className="gb-chips gb-chips--wrap" role="group" aria-labelledby="gb-time-label">
                {visibleSlots.map(s => {
                  const v = hm(s.h, s.m)
                  const full = isFull(s)
                  return (
                    <button key={v} type="button" className="gb-chip gb-chip--time" aria-pressed={time === v} disabled={full}
                      aria-label={`${label12(s.h, s.m)}${full ? ', fully booked' : ''}`}
                      onClick={() => { setTime(v); setFieldErr(e => ({ ...e, time: undefined })) }}>
                      {label12(s.h, s.m)}
                      {full && <small>Full</small>}
                    </button>
                  )
                })}
              </div>
              {allFull ? (
                <p className="gb-note">Fully booked for {party} guest{party === 1 ? '' : 's'} on {selectedDay?.bsLong || 'that day'} — try another day, or call {page.outlet_name} to ask about a wait.</p>
              ) : visibleSlots.some(isFull) ? (
                <p className="gb-note">Greyed times cannot seat {party} guest{party === 1 ? '' : 's'} — change the number or pick another time.</p>
              ) : null}
            </>
          )}
          {fieldErr.time && <span className="gb-err" role="alert">{fieldErr.time}</span>}
        </div>

        <div className="gb-card">
          <span className="gb-label" id="gb-party-label">Guests</span>
          <div className="gb-stepper" role="group" aria-labelledby="gb-party-label">
            <button type="button" aria-label="Fewer guests" onClick={() => setParty(p => Math.max(1, p - 1))} disabled={party <= 1}>−</button>
            <output aria-live="polite">{party}</output>
            <button type="button" aria-label="More guests" onClick={() => setParty(p => Math.min(page.max_party_online || 20, p + 1))} disabled={party >= (page.max_party_online || 20)}>+</button>
          </div>
          {party >= (page.max_party_online || 20) && (
            <p className="gb-note">For a bigger group, please call or message {page.outlet_name}.</p>
          )}
        </div>

        <div className="gb-card">
          <div className="gb-field">
            <label htmlFor="gb-name">Your name</label>
            <input id="gb-name" className="gb-input" value={name} onChange={e => setName(e.target.value)} autoComplete="name"
              aria-invalid={fieldErr.name ? 'true' : undefined} aria-describedby={fieldErr.name ? 'gb-name-err' : undefined} />
            {fieldErr.name && <span id="gb-name-err" className="gb-err" role="alert">{fieldErr.name}</span>}
          </div>
          <div className="gb-field">
            <label htmlFor="gb-phone">Mobile number</label>
            <input id="gb-phone" className="gb-input" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="98XXXXXXXX"
              aria-invalid={fieldErr.phone ? 'true' : undefined} aria-describedby={fieldErr.phone ? 'gb-phone-err' : undefined} />
            {fieldErr.phone && <span id="gb-phone-err" className="gb-err" role="alert">{fieldErr.phone}</span>}
          </div>
          <div className="gb-field">
            <label htmlFor="gb-occasion">Occasion (optional)</label>
            <select id="gb-occasion" className="gb-input" value={occasion} onChange={e => setOccasion(e.target.value)}>
              <option value="">—</option>
              {['Birthday', 'Anniversary', 'Business', 'Family gathering', 'Date', 'Other'].map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </div>
          <div className="gb-field" style={{ marginBottom: 0 }}>
            <label htmlFor="gb-notes">Anything we should know? (optional)</label>
            <textarea id="gb-notes" className="gb-textarea" value={notes} onChange={e => setNotes(e.target.value.slice(0, 300))} placeholder="Window seat, a cake at 8, wheelchair access…" />
          </div>
        </div>

        {submitError && <p className="gb-alert gb-alert--danger" role="alert">{submitError}</p>}

        <button type="submit" className="gb-submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Request this table'}
        </button>
        <p className="gb-note">
          Your name and number go only to {page.outlet_name}, to confirm this booking. <a href="/legal/privacy" target="_blank" rel="noreferrer">Privacy</a>.
        </p>
      </form>
      <p className="gb-foot">Powered by Crest POS</p>
    </div></div>
  )
}
