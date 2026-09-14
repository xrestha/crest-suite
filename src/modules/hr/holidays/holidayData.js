// ── What can be seeded, and what genuinely cannot ────────────────────────────────────────────
//
// Nepal's holiday calendar splits three ways, and only the first is derivable in code:
//
//   1. FIXED   — the same BS date every year. Republic Day is always Jestha 15. Seedable for any
//                fiscal year, forever.
//   2. MOVABLE — lunar, so the BS date moves every year (Dashain, Tihar, Shivaratri, the three
//                Lhosars), plus the AD-fixed ones (Christmas, Workers' Day, Women's Day) which
//                move in BS for the mirror-image reason. These are TRANSCRIBED from the Nepal
//                Gazette once the Ministry of Home Affairs publishes the year's list — usually in
//                Falgun of the preceding year. Nothing here can compute them.
//   3. SIGHTED — Eid al-Fitr, Eid al-Adha, Mohammad Jayanti, Guru Nanak Jayanti and Bhoto Jatra
//                carry no date in the gazette at all. Manual entry only, every year.
//
// Until S635 only (1) existed: five rows, a button labelled "Seed Fixed", and a hint to add the
// movable ones "manually". Reported live from an FY 2083/84 calendar showing five holidays and no
// Dashain — because nobody transcribes thirty gazette rows by hand, so in practice the calendar
// stayed empty of precisely the days it exists to flag. That is not cosmetic: Overtime.jsx reads
// this table to decide the 2× public-holiday rate, and a missing Dashain pays 1.5× on the biggest
// working days of the Nepali year.

// Same BS date every year, so this list is correct for any fiscal year. The BS YEAR is derived by
// resolveYear() below and never stored per row — the old list carried its own `yearOffset` field
// saying the same thing, which is one rule too many for a value both sides have to agree on.
//
// Martyrs' Day sat at Magh 5 here from the beginning, and Sahid Diwas is Magh 16 — the day the
// four martyrs were executed in 1997 BS. Every client who ever pressed the old button holds a
// wrong row, which is why seeding now CORRECTS a fixed holiday found on the wrong date rather
// than skipping it as already present (see seedYear).
export const FIXED_HOLIDAYS = [
  { name: 'Nepali New Year (Nawa Barsha)',              bs_month: 1,  bs_day: 1  },
  { name: 'Republic Day (Ganatantra Diwas)',            bs_month: 2,  bs_day: 15 },
  { name: 'Constitution Day (Sambidhan Diwas)',         bs_month: 6,  bs_day: 3  },
  // `legacy` lists names this holiday has been seeded under before. The seed matches on it so a
  // rename here UPDATES the client's existing row instead of inserting a second one on the same
  // day — without it, renaming "Prithvi Narayan Shah's Birthday" would have quietly given every
  // client who ever pressed the old button two Poush 27 holidays.
  { name: 'Prithvi Jayanti (National Unity Day)',       bs_month: 9,  bs_day: 27,
    legacy: ["Prithvi Narayan Shah's Birthday"] },
  { name: 'Maghe Sankranti (Maghi)',                    bs_month: 10, bs_day: 1  },
  { name: "Martyrs' Day (Sahid Diwas)",                 bs_month: 10, bs_day: 16 },
  { name: 'National Democracy Day (Prajatantra Diwas)', bs_month: 11, bs_day: 7  },
]

// Movable holidays, keyed by REAL BS year — not fiscal year, because a Nepali FY spans two of them
// (Shrawan–Chaitra of one, Baishakh–Ashadh of the next) and the gazette is published per BS year.
//
// `optional: true` means community-, region- or gender-specific. Overtime.jsx pays the 2× holiday
// rate on `public` rows ONLY, so this flag decides money and is not a label: a nationwide day off
// is public, a Newar jatra or a women-only parva or Christmas is optional.
//
// Source for 2083: the Nepal Gazette notice of 18 Falgun 2082 (Ministry of Home Affairs),
// cross-read against Hamro Patro and NepalHRM — all three agree on every date below, and every one
// validates against bsCalendar.js's own month lengths for 2083. Extending this table is a
// transcription job against the next gazette, never a calculation; verify each date in two places
// before adding a year, because a wrong date here is a wrong OT rate on a real payslip.
export const MOVABLE_HOLIDAYS = {
  2083: [
    { m: 1,  d: 18, name: 'Buddha Jayanti (Chandi Purnima / Ubhauli)' },
    { m: 1,  d: 18, name: "International Workers' Day" },
    { m: 5,  d: 12, name: 'Janai Purnima / Rakshya Bandhan' },
    { m: 5,  d: 13, name: 'Gai Jatra', optional: true },
    { m: 5,  d: 19, name: 'Krishna Janmashtami' },
    { m: 5,  d: 19, name: 'Gaura Parva', optional: true },
    { m: 5,  d: 29, name: 'Haritalika Teej', optional: true },
    { m: 6,  d: 9,  name: 'Indra Jatra', optional: true },
    { m: 6,  d: 18, name: 'Jitiya', optional: true },
    { m: 6,  d: 25, name: 'Ghatasthapana (Dashain)' },
    { m: 6,  d: 31, name: 'Fulpati (Dashain)' },
    // The gazette gives Dashain seven days and Tihar five, and several of them carry no tithi name
    // of their own. They are named by BS day rather than left as three identical "Dashain holiday"
    // rows, because the NAME is the seed's dedupe key: identical names meant only the first was
    // ever inserted and Kartik 5, 6 and 26 silently never seeded. holidayData.test.js asserts it.
    { m: 7,  d: 1,  name: 'Maha Ashtami (Dashain)' },
    { m: 7,  d: 2,  name: 'Dashain holiday (Kartik 2)' },
    { m: 7,  d: 3,  name: 'Maha Navami (Dashain)' },
    { m: 7,  d: 4,  name: 'Bijaya Dashami (Dashain)' },
    { m: 7,  d: 5,  name: 'Dashain holiday (Kartik 5)' },
    { m: 7,  d: 6,  name: 'Dashain holiday (Kartik 6)' },
    { m: 7,  d: 22, name: 'Laxmi Puja (Tihar)' },
    { m: 7,  d: 23, name: 'Tihar holiday (Kartik 23)' },
    { m: 7,  d: 24, name: 'Mha Puja / Gobardhan Puja (Tihar)' },
    { m: 7,  d: 25, name: 'Bhai Tika (Tihar)' },
    { m: 7,  d: 25, name: 'Falgunanda Jayanti', optional: true },
    { m: 7,  d: 26, name: 'Tihar holiday (Kartik 26)' },
    { m: 7,  d: 29, name: 'Chhath Parva' },
    { m: 8,  d: 17, name: 'International Day of Persons with Disabilities', optional: true },
    { m: 9,  d: 9,  name: 'Yomari Punhi / Udhauli / Jyapu Diwas' },
    { m: 9,  d: 10, name: 'Christmas', optional: true },
    { m: 9,  d: 15, name: 'Tamu Lhosar' },
    { m: 10, d: 24, name: 'Sonam Lhosar' },
    { m: 10, d: 28, name: 'Basanta Panchami', optional: true },
    { m: 11, d: 22, name: 'Maha Shivaratri' },
    { m: 11, d: 24, name: "International Women's Day", optional: true },
    { m: 11, d: 25, name: 'Gyalpo Lhosar' },
    // Holi is a real day off in both halves of the country and falls a day apart in each. Both are
    // seeded, as public, with the region in the name — rather than one of them being guessed at
    // from nothing. The seed result says to delete whichever does not apply to the outlet.
    { m: 12, d: 7,  name: 'Fagu Purnima / Holi (Hill districts)' },
    { m: 12, d: 8,  name: 'Fagu Purnima / Holi (Terai)' },
    { m: 12, d: 23, name: 'Ghode Jatra', optional: true },
  ],
}

// Holidays whose date is set by moon sighting, or by a body other than the Home Ministry, so they
// appear in the gazette without one. Named on screen so their absence reads as a known gap rather
// than as an oversight in the table above.
export const SIGHTED_HOLIDAYS = 'Eid al-Fitr, Eid al-Adha, Mohammad Jayanti, Guru Nanak Jayanti and Bhoto Jatra'

// Actual BS year for a holiday given FY start year and month. Shrawan (4) onwards is the FY's own
// year; Baishakh–Ashadh belong to the next one.
export function resolveYear(fyYear, bs_month) {
  return bs_month >= 4 ? fyYear : fyYear + 1
}

// What Seed would do to one fiscal year, given every row the calendar holds for it — REMOVED rows
// included (removed_at set). Pure, so the rules below are tested rather than re-read.
//
// Additive and name-keyed: a holiday already present under its name (or a legacy name) is never
// inserted again, and its date and type are the owner's. The one exception is a FIXED holiday on
// the wrong date, which is corrected and named (Martyrs' Day, Magh 5 → 16).
//
// A REMOVED row counts as present (S748, decided with Aashish): the owner took it out on purpose —
// the Terai Holi at a hill outlet, typically — and until this rule pressing Seed again put it back.
// It is reported as `keptRemoved` so the result says why it was not added, and it is never
// "corrected" either: fixing the date of a holiday the owner removed would be a write about
// nothing anyone can see.
export function planSeed(fyYear, fyRows) {
  const byName = new Map((fyRows || []).map(h => [h.name, h]))
  const toInsert = []
  const corrections = []
  const keptRemoved = []

  FIXED_HOLIDAYS.forEach(h => {
    const bs_year = resolveYear(fyYear, h.bs_month)
    const existing = byName.get(h.name) || (h.legacy || []).map(n => byName.get(n)).find(Boolean)
    if (!existing) {
      toInsert.push({ bs_year, bs_month: h.bs_month, bs_day: h.bs_day, name: h.name, holiday_type: 'public' })
      return
    }
    if (existing.removed_at) { keptRemoved.push(existing.name); return }
    const movedDate = existing.bs_month !== h.bs_month || existing.bs_day !== h.bs_day
    const renamed   = existing.name !== h.name
    if (!movedDate && !renamed) return
    corrections.push({
      id: existing.id,
      name: h.name,
      renamed: renamed ? existing.name : null,
      fromMonth: existing.bs_month, fromDay: existing.bs_day,
      toMonth: h.bs_month, toDay: h.bs_day,
      movedDate,
      patch: { bs_year, bs_month: h.bs_month, bs_day: h.bs_day, name: h.name },
    })
  })

  const { rows: movable, missing } = movableForFy(fyYear)
  movable.forEach(h => {
    const existing = byName.get(h.name)
    if (existing) { if (existing.removed_at) keptRemoved.push(existing.name); return }
    toInsert.push({
      bs_year: h.bs_year, bs_month: h.m, bs_day: h.d, name: h.name,
      holiday_type: h.optional ? 'optional' : 'public',
    })
  })

  return { toInsert, corrections, missing, keptRemoved }
}

// Every movable holiday falling inside one fiscal year, drawn from the two BS years it spans, plus
// any BS year whose gazette has not been transcribed yet. A partially-covered FY is REPORTED, never
// silently seeded short: an owner who reads "34 added" and then finds no Dashain has no way to tell
// a gap in this table from a gap in the gazette.
export function movableForFy(fyYear) {
  const rows = []
  const missing = []
  const take = (bsYear, inHalf) => {
    const list = MOVABLE_HOLIDAYS[bsYear]
    if (!list) { missing.push(bsYear); return }
    list.filter(h => inHalf(h.m)).forEach(h => rows.push({ ...h, bs_year: bsYear }))
  }
  take(fyYear,     m => m >= 4)
  take(fyYear + 1, m => m <= 3)
  return { rows, missing }
}
