import { useEffect, useRef, useState } from 'react'
import { PREVIEW_DEBOUNCE_MS } from './posOrdersConstants'

/**
 * The payment window's dynamic QR (EMVCo, this bill's amount), as a data URL, or '' when none shows.
 *
 * The first QR paints at once (the window opening, a QR method picked). After that a changed amount
 * waits PREVIEW_DEBOUNCE_MS, as the bill preview does (2026-10-15 audit): QRCode.toDataURL runs on the
 * main thread, and every keystroke of a discount or a tendered amount used to draw a new image and
 * re-render the whole till for it. The QR on screen keeps its amount until the hand pauses; one that
 * vanished per keystroke would also restart the payment-confirmation poll, which keys on whether a QR
 * shows.
 *
 * @param {object} p
 * @param {boolean} p.active     the window is open on a QR method with a positive amount and a merchant QR
 * @param {number}  p.amount     what the QR asks for
 * @param {?string} p.reference  the bill reference carried in the QR
 * @param {string}  [p.source]   the merchant's QR payload; a new one draws a new QR
 * @param {(amount: number, reference: ?string) => Promise<string>} p.make  builds the data URL
 */
export function useBillQr({ active, amount, reference, source = '', make, delayMs = PREVIEW_DEBOUNCE_MS }) {
  const [url, setUrl] = useState('')
  const urlRef = useRef(url)
  urlRef.current = url
  const makeRef = useRef(make)
  makeRef.current = make

  useEffect(() => {
    if (!active) { setUrl(''); return undefined }
    let cancelled = false
    const run = () => {
      Promise.resolve(makeRef.current(amount, reference)).then(
        next => { if (!cancelled) setUrl(next || '') },
        () => { if (!cancelled) setUrl('') },
      )
    }
    if (!urlRef.current) { run(); return () => { cancelled = true } }
    const timer = setTimeout(run, delayMs)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [active, amount, reference, source, delayMs])

  return url
}
