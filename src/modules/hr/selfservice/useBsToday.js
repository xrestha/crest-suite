import { useEffect, useRef, useState } from 'react'
import { getBsToday } from '../../../utils/bsCalendar'

const sameBsDay = (a, b) => a.year === b.year && a.month === b.month && a.day === b.day

/**
 * Today's BS date, kept current while Crest Staff sits open or frozen (S798, SELF-SERVICE-3).
 *
 * An installed PWA is frozen rather than reloaded when it is closed (staff-app.md), so a date read
 * once at mount stayed the day the app was opened: unlocked the next evening, Home showed yesterday
 * as "Today" and a shift already worked as "Next shift", and said nothing about tomorrow. This
 * re-reads the date whenever the screen comes back (visibilitychange, a restored pageshow) and once
 * a minute while it is on screen, and only when the BS DAY has changed does it replace the date and
 * call `onDayChange(newToday)`, so the caller can move the week it shows. The roster reload follows
 * from the days that moved; nothing is refetched here.
 *
 * → { year, month, day }, the same object until the day changes.
 */
export function useBsToday(onDayChange) {
  const [today, setToday] = useState(getBsToday)
  const todayRef = useRef(today)
  const onDayChangeRef = useRef(onDayChange)
  useEffect(() => { onDayChangeRef.current = onDayChange }, [onDayChange])

  useEffect(() => {
    function check() {
      if (document.visibilityState === 'hidden') return
      const now = getBsToday()
      if (sameBsDay(todayRef.current, now)) return
      todayRef.current = now
      setToday(now)
      if (onDayChangeRef.current) onDayChangeRef.current(now)
    }
    function onPageShow(e) { if (e.persisted) check() }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('pageshow', onPageShow)
    const timer = setInterval(check, 60 * 1000)
    return () => {
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('pageshow', onPageShow)
      clearInterval(timer)
    }
  }, [])

  return today
}
