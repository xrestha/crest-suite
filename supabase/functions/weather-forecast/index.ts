import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Rain per trading day for one outlet, for the dashboard's weather-adjusted sales forecast (S784).
//
// The source is MET Norway's Locationforecast (CC BY 4.0, commercial use allowed). Their terms are
// why this is a server function and not a browser call: every request must carry an identifying
// User-Agent (a browser cannot set one), clients must cache and send If-Modified-Since, and
// coordinates are truncated. Open-Meteo's free tier was ruled out because it is non-commercial.
//
// The caller names a client; the function reads THAT client's saved coordinates from `settings`,
// never coordinates from the request, so it is not a free proxy for anywhere in the world. Its two
// tables (weather_locations, weather_daily) are service-role only.
//
// A day's trading window is 05:45–23:45 Nepal time, which is exactly 00:00–18:00 UTC of the same
// date — MET's 6-hourly blocks start at 00/06/12/18 UTC, so they tile it with no remainder, and the
// 23:45–05:45 block (overnight monsoon rain, which keeps nobody from dinner) falls outside it.
//
// A day is `complete` when the forecast covered its whole window from the moment it opened. Days
// ahead always are; today is not once the forecast begins after 05:45. An incomplete row never
// overwrites a complete one, so each stored past day ends up as the last full-day forecast made
// before it began — which is what the dashboard measures a rainy-day effect against.
//
// S785: each day also carries its high and low temperature, mean cloud cover and whether thunder is
// forecast, over the same window, for the Dashboard header's weather strip. The sales forecast
// still reads rain alone. A day already stored whole keeps its rain and its high/low; its sky and
// thunder follow later fetches (display only — see the refresh after the upsert).
//
// A MET failure never turns into a 500: the stored rows come back with `reason` saying why no
// fresh forecast came, and the function backs off for BACKOFF_MS rather than asking again on every
// dashboard load. `stale` is a separate fact: the last good fetch is more than 12 hours old.

const MET_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact'
const NEPAL = { latMin: 26.3, latMax: 30.5, lonMin: 80.0, lonMax: 88.3 }
const MIN_REFRESH_MS = 3 * 60 * 60 * 1000
const BACKOFF_MS = 15 * 60 * 1000
const STALE_AFTER_MS = 12 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000
const NPT_OFFSET_MS = 345 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const WINDOW_MS = 18 * HOUR_MS
// A day counts as complete with at most an hour of its window uncovered: MET's hourly section
// hands over to the 6-hourly one without always lining up, and a one-hour seam is not a part day.
const COMPLETE_MIN_MS = WINDOW_MS - HOUR_MS
const PAST_DAYS = 60
const AHEAD_DAYS = 9

const round2 = (n: number) => Math.round(n * 100) / 100
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const dayStartUtc = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

type DayTotal = {
  mm: number; covered: number; first: number
  // S785, for the Dashboard's weather strip: filled in from `samples` once the walk is done.
  tempMax: number | null; tempMin: number | null; cloudPct: number | null; thunder: boolean | null
}
type Samples = { tMax: number; tMin: number; tN: number; cloudSum: number; cloudN: number }
type MetEntry = {
  time: string
  data?: {
    instant?: { details?: { air_temperature?: number; cloud_area_fraction?: number } }
    next_1_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } }
    next_6_hours?: { summary?: { symbol_code?: string }; details?: { precipitation_amount?: number } }
  }
}

// Sums each block's rain into the trading window of every date it overlaps, pro rata, and tracks
// how much of each window the forecast covered and the earliest moment of it covered. Beside the
// rain (S785): the high and low temperature and the mean cloud cover of the instants that fall
// inside each window, and whether a block overlapping it names thunder.
//
// Only the rain walk creates a day. The samples are kept apart and merged into days that exist,
// because MET's last few entries carry an instant and no block: a day made from those alone would be
// a no-rain row the forecast never covered, which the dashboard would read as a dry day.
function aggregate(timeseries: MetEntry[]) {
  const days: Record<string, DayTotal> = {}
  const samples: Record<string, Samples> = {}
  const thunderSeen: Record<string, boolean> = {}
  let coveredUntil = -Infinity
  for (const entry of timeseries) {
    const start = Date.parse(entry.time)
    if (!Number.isFinite(start)) continue

    // An instant belongs to the day whose window contains it, and to no day outside a window.
    const instantDay = dayStartUtc(isoDay(start))
    if (start - instantDay < WINDOW_MS) {
      const temp = entry.data?.instant?.details?.air_temperature
      const cloud = entry.data?.instant?.details?.cloud_area_fraction
      const key = isoDay(instantDay)
      const s = samples[key] || (samples[key] = { tMax: -Infinity, tMin: Infinity, tN: 0, cloudSum: 0, cloudN: 0 })
      if (typeof temp === 'number' && Number.isFinite(temp)) {
        s.tMax = Math.max(s.tMax, temp); s.tMin = Math.min(s.tMin, temp); s.tN++
      }
      if (typeof cloud === 'number' && Number.isFinite(cloud)) { s.cloudSum += cloud; s.cloudN++ }
    }

    const one = entry.data?.next_1_hours?.details?.precipitation_amount
    const six = entry.data?.next_6_hours?.details?.precipitation_amount
    let end: number, amount: number, symbol: string | undefined
    if (typeof one === 'number') { end = start + HOUR_MS; amount = one; symbol = entry.data?.next_1_hours?.summary?.symbol_code }
    else if (typeof six === 'number') { end = start + 6 * HOUR_MS; amount = six; symbol = entry.data?.next_6_hours?.summary?.symbol_code }
    else continue
    // Hourly entries also carry a 6-hour figure; the walk takes the hourly one and skips whatever
    // a later block repeats, so nothing is counted twice.
    const from = Math.max(start, coveredUntil)
    if (from >= end) continue
    const share = (end - from) / (end - start)
    const blockAmount = amount * share
    const blockLen = end - from
    for (let dayMs = dayStartUtc(isoDay(from)); dayMs < end; dayMs += 24 * HOUR_MS) {
      const overlap = Math.min(end, dayMs + WINDOW_MS) - Math.max(from, dayMs)
      if (overlap <= 0) continue
      const key = isoDay(dayMs)
      const d = days[key] || (days[key] = { mm: 0, covered: 0, first: Infinity, tempMax: null, tempMin: null, cloudPct: null, thunder: null })
      d.mm += blockAmount * (overlap / blockLen)
      d.covered += overlap
      d.first = Math.min(d.first, Math.max(from, dayMs))
      if (typeof symbol === 'string') thunderSeen[key] = (thunderSeen[key] || false) || symbol.includes('thunder')
    }
    coveredUntil = end
  }
  for (const [key, d] of Object.entries(days)) {
    const s = samples[key]
    if (s && s.tN > 0) { d.tempMax = Math.round(s.tMax * 10) / 10; d.tempMin = Math.round(s.tMin * 10) / 10 }
    if (s && s.cloudN > 0) d.cloudPct = Math.min(100, Math.max(0, Math.round(s.cloudSum / s.cloudN)))
    // null, not false, when no block carried a symbol at all: "no thunder" is a forecast, and the
    // absence of a symbol is not one.
    if (key in thunderSeen) d.thunder = thunderSeen[key]
  }
  return days
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  try {
    const url  = Deno.env.get('SUPABASE_URL')!
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!
    const svc  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(url, svc, { auth: { autoRefreshToken: false, persistSession: false } })

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Unauthorized' }, 401)
    const caller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } })
    const { data: { user }, error: authErr } = await caller.auth.getUser()
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const body = await req.json().catch(() => ({}))
    const clientId = typeof body?.client_id === 'string' ? body.client_id : null
    if (!clientId) return json({ error: 'client_id is required' }, 400)

    const { data: profile, error: profileErr } = await admin
      .from('profiles').select('role, client_id, active_client_id').eq('id', user.id).maybeSingle()
    if (profileErr) return json({ error: 'Could not read the caller profile' }, 500)
    // The outlet the caller is working in: my_client_id()'s rule, as in admin-user-ops.
    const isCallerAdmin = profile?.role === 'admin'
    const callerClientId = profile?.active_client_id || profile?.client_id
    if (!isCallerAdmin && callerClientId !== clientId) return json({ error: 'Forbidden' }, 403)

    const { data: settings, error: settingsErr } = await admin
      .from('settings').select('weather_lat, weather_lon').eq('client_id', clientId).maybeSingle()
    if (settingsErr) return json({ error: 'Could not read the outlet location' }, 500)
    const lat = settings?.weather_lat == null ? null : Number(settings.weather_lat)
    const lon = settings?.weather_lon == null ? null : Number(settings.weather_lon)
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ days: [], reason: 'no_location' })
    }
    if (lat < NEPAL.latMin || lat > NEPAL.latMax || lon < NEPAL.lonMin || lon > NEPAL.lonMax) {
      return json({ days: [], reason: 'outside_nepal' })
    }
    const latKey = round2(lat), lonKey = round2(lon)

    const { data: loc, error: locErr } = await admin
      .from('weather_locations').select('*').eq('lat_key', latKey).eq('lon_key', lonKey).maybeSingle()
    if (locErr) return json({ error: 'Could not read the weather cache' }, 500)

    const now = Date.now()
    const fetchedAt = loc?.fetched_at ? Date.parse(loc.fetched_at) : null
    const expiresAt = loc?.expires_at ? Date.parse(loc.expires_at) : null
    const nextAllowed = Math.max(expiresAt ?? 0, fetchedAt != null ? fetchedAt + MIN_REFRESH_MS : 0)
    let reason: string | null = null
    let lastFetch = fetchedAt

    if (now >= nextAllowed) {
      // Serve what is stored for BACKOFF_MS, keeping the last good fetch and its Last-Modified, so a
      // failure is not retried on every dashboard load.
      const backOff = async (lastError: string) => {
        const { error: locWriteErr } = await admin.from('weather_locations').upsert({
          lat_key: latKey, lon_key: lonKey, fetched_at: loc?.fetched_at ?? null,
          expires_at: new Date(now + BACKOFF_MS).toISOString(),
          last_modified: loc?.last_modified ?? null, last_error: lastError,
        }, { onConflict: 'lat_key,lon_key' })
        if (locWriteErr) console.error('weather-forecast: location write failed', locWriteErr.message)
      }

      const userAgent = Deno.env.get('MET_USER_AGENT')
      if (!userAgent) {
        reason = 'not_configured'
      } else {
        const headers: Record<string, string> = { 'User-Agent': userAgent, 'Accept': 'application/json' }
        if (loc?.last_modified) headers['If-Modified-Since'] = loc.last_modified
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
        let res: Response | null = null
        let series: MetEntry[] | null = null
        let fetchErr = ''
        // The body is read under the same timer as the request: a body that stalls or does not
        // parse is a MET failure like any other, and goes to the back-off rather than a 500.
        try {
          res = await fetch(`${MET_URL}?lat=${latKey}&lon=${lonKey}`, { headers, signal: ctrl.signal })
          if (res.status === 200 || res.status === 203) {
            const payload = await res.json()
            const timeseries = payload?.properties?.timeseries
            if (Array.isArray(timeseries)) series = timeseries
            else fetchErr = `HTTP ${res.status}, no timeseries in the body`
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          fetchErr = res ? `HTTP ${res.status}, body unreadable: ${msg}` : msg
        } finally {
          clearTimeout(timer)
        }

        const expiresHeader = res?.headers.get('Expires')
        const metExpires = expiresHeader ? Date.parse(expiresHeader) : NaN
        const nextExpires = new Date(Number.isFinite(metExpires) ? metExpires : now + MIN_REFRESH_MS).toISOString()

        if (res && series) {
          // 203 means the product version is deprecated: the data is still good, and the log is how
          // anyone hears about it.
          if (res.status === 203) console.warn('weather-forecast: MET returned 203 (deprecated product)')
          const totals = aggregate(series)
          const incoming = Object.entries(totals).map(([date, t]) => {
            // Covered from the moment the window opened, not merely 17 of its 18 hours: a fetch made
            // an hour or two into the day covers the rest of it, and that must never overwrite the
            // forecast made before the day began.
            const complete = t.first <= dayStartUtc(date) && t.covered >= COMPLETE_MIN_MS
            // A one-hour seam is scaled over rather than read as dry.
            const mm = complete && t.covered < WINDOW_MS ? t.mm * (WINDOW_MS / t.covered) : t.mm
            return {
              lat_key: latKey, lon_key: lonKey, ad_date: date, precip_mm: Math.round(mm * 10) / 10, complete,
              temp_max: t.tempMax, temp_min: t.tempMin, cloud_pct: t.cloudPct, thunder: t.thunder,
              fetched_at: new Date(now).toISOString(),
            }
          })
          const dates = incoming.map(r => r.ad_date)
          const { data: existing, error: existingErr } = dates.length
            ? await admin.from('weather_daily').select('ad_date, complete, temp_max')
                .eq('lat_key', latKey).eq('lon_key', lonKey).in('ad_date', dates)
            : { data: [], error: null }
          let writeErr = ''
          if (existingErr) {
            writeErr = `reading existing rows failed: ${existingErr.message}`
          } else {
            const storedComplete = new Map((existing || []).filter(r => r.complete).map(r => [r.ad_date, r]))
            const rows = incoming.filter(r => r.complete || !storedComplete.has(r.ad_date))
            const { error: upsertErr } = rows.length
              ? await admin.from('weather_daily').upsert(rows, { onConflict: 'lat_key,lon_key,ad_date' })
              : { error: null }
            if (upsertErr) writeErr = `upsert failed: ${upsertErr.message}`

            // S785: a day already stored whole keeps its rain and its `complete` flag — the sales
            // forecast is measured against the forecast made before the day began. But the sky and
            // thunder are display only, so they follow the latest forecast for the rest of the day:
            // otherwise a "Sunny" tile stands under "updated 11:00" after MET has added afternoon
            // storms. The high/low stays the full-day one, and is filled from this fetch only where
            // the stored row has none (a row written before S785). Display only, so a failure here
            // is logged and never turns the fetch into cache_write_failed: the rain rows above landed.
            if (!upsertErr) {
              for (const r of incoming) {
                const stored = storedComplete.get(r.ad_date)
                if (r.complete || !stored) continue
                const patch: Record<string, number | boolean> = {}
                if (r.cloud_pct != null) patch.cloud_pct = r.cloud_pct
                if (r.thunder != null) patch.thunder = r.thunder
                if (stored.temp_max == null && r.temp_max != null && r.temp_min != null) {
                  patch.temp_max = r.temp_max
                  patch.temp_min = r.temp_min
                }
                if (!Object.keys(patch).length) continue
                const { error: patchErr } = await admin.from('weather_daily').update(patch)
                  .eq('lat_key', latKey).eq('lon_key', lonKey).eq('ad_date', r.ad_date)
                if (patchErr) console.error('weather-forecast: display refresh failed', r.ad_date, patchErr.message)
              }
            }
          }
          if (writeErr) {
            // Nothing was stored, so back off as for a MET failure: otherwise every load fetches
            // again and fails the same way. The old Last-Modified is kept, or the next fetch would
            // get a 304 for a forecast that never landed.
            reason = 'cache_write_failed'
            console.error('weather-forecast:', writeErr)
            await backOff(`cache write: ${writeErr}`)
          } else {
            lastFetch = now
            const { error: locWriteErr } = await admin.from('weather_locations').upsert({
              lat_key: latKey, lon_key: lonKey, fetched_at: new Date(now).toISOString(),
              expires_at: nextExpires, last_modified: res.headers.get('Last-Modified'), last_error: null,
            }, { onConflict: 'lat_key,lon_key' })
            if (locWriteErr) console.error('weather-forecast: location write failed', locWriteErr.message)
          }
        } else if (res && res.status === 304) {
          lastFetch = now
          const { error: locWriteErr } = await admin.from('weather_locations').upsert({
            lat_key: latKey, lon_key: lonKey, fetched_at: new Date(now).toISOString(),
            expires_at: nextExpires, last_modified: loc?.last_modified ?? null, last_error: null,
          }, { onConflict: 'lat_key,lon_key' })
          if (locWriteErr) console.error('weather-forecast: location write failed', locWriteErr.message)
        } else {
          // 429, 5xx, a timeout, no network, or a body that would not read: back off and serve what
          // is stored.
          reason = 'met_unavailable'
          const lastError = fetchErr || (res ? `HTTP ${res.status}` : 'no response')
          console.error('weather-forecast: MET fetch failed', lastError)
          await backOff(lastError)
        }
      }
    }

    // Nepal's today, then the window the dashboard needs: this month's past days, the Target's
    // 28-day history before it, and the days ahead.
    const todayNpt = isoDay(now + NPT_OFFSET_MS)
    const todayMs = dayStartUtc(todayNpt)
    const { data: rows, error: rowsErr } = await admin
      .from('weather_daily').select('ad_date, precip_mm, complete, temp_max, temp_min, cloud_pct, thunder')
      .eq('lat_key', latKey).eq('lon_key', lonKey)
      .gte('ad_date', isoDay(todayMs - PAST_DAYS * 24 * HOUR_MS))
      .lte('ad_date', isoDay(todayMs + AHEAD_DAYS * 24 * HOUR_MS))
      .order('ad_date')
    if (rowsErr) return json({ error: 'Could not read the weather cache' }, 500)

    const stale = lastFetch == null || now - lastFetch > STALE_AFTER_MS
    return json({
      days: (rows || []).map(r => ({
        date: r.ad_date, precip_mm: Number(r.precip_mm), complete: r.complete,
        temp_max: r.temp_max == null ? null : Number(r.temp_max),
        temp_min: r.temp_min == null ? null : Number(r.temp_min),
        cloud_pct: r.cloud_pct == null ? null : Number(r.cloud_pct),
        thunder: r.thunder,
      })),
      today: todayNpt,
      fetched_at: lastFetch != null ? new Date(lastFetch).toISOString() : null,
      stale,
      reason,
    })
  } catch (err) {
    console.error('weather-forecast:', err)
    return json({ error: err instanceof Error ? err.message : 'Unexpected error' }, 500)
  }
})
