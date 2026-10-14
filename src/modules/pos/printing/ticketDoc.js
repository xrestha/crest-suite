import { BS_MONTHS } from '../../../utils/bsCalendar'
import { nepalTime, nepalBs } from '../../../shared/nepalTime'
import { escapeHtml as esc } from '../../../utils/escapeHtml'
import { changedOnSentUnits, changeNoteText } from '../kitchenNotes'

// A station slip as a document (S837, kitchen and bar printers; contract in docs/kitchen-printers.md).
// The KOT/BOT, the VOID slip and the MOVE slip describe themselves once, as lines; the till's own
// print window, the print station page and the Crest Print Helper all render that one description,
// so the paper is the same whoever prints it. Builders take the arguments the old HTML builders took
// (posOrderPrintHtml.js still exports those, rendered from these). Everything a person typed is
// carried as plain text and escaped by each renderer.

export const TICKET_DOC_VERSION = 1

const SIZES = new Set(['xs', 'sm', 'md', 'lg', 'xl'])

const text = (t, o = {}) => ({ k: 'text', t: String(t ?? ''), ...o })
const row  = (l, r, o = {}) => ({ k: 'row', l: String(l ?? ''), r: String(r ?? ''), ...o })
const HR   = { k: 'hr' }

const bsDateText = stamp => {
  // nepalBs pins the day to Nepal before the converter reads its local getters, so a ticket sent just
  // after midnight Kathmandu cannot print yesterday's date on a tablet set to another zone.
  const bs = nepalBs(stamp)
  return bs ? `${bs.day} ${BS_MONTHS[bs.month - 1]} ${bs.year}` : ''
}
const stampOf = at => (at ? new Date(at) : new Date())

// A line's Crest Customization choices (S758), in either shape a caller holds them: the cart/server
// snapshot ({ option_name, kitchen_name, is_removal }) or a logged ticket's ({ kitchen, is_removal }).
// The kitchen reads its own short name where the owner set one.
const ticketOptionName = o => o.kitchen || o.kitchen_name || o.option_name || ''
const optionLines = options => (options || []).map(o => (o.is_removal
  ? text(`NO ${ticketOptionName(o).replace(/^no\s+/i, '')}`, { indent: 1, bold: true })
  : text(`+ ${ticketOptionName(o)}`, { indent: 1 })))
const noteLine = t => text(t, { indent: 1, size: 'xs', italic: true })
const qtyRow = (name, label, o = {}) => row(name, label, { lBold: true, rBold: true, rSize: 'md', ...o })

export function kotBotDoc({ station, items, ticketNo, outletName, tableName, takenBy, covers, reprint = false, at }) {
  const stamp = stampOf(at)
  const lines = []
  if (outletName) lines.push(text(outletName, { align: 'center', bold: true, size: 'md' }))
  lines.push(text(station === 'BOT' ? 'BAR ORDER TICKET' : 'KITCHEN ORDER TICKET', { align: 'center', bold: true, size: 'lg' }))
  if (reprint) lines.push(text('*** REPRINT — NOT A NEW ORDER ***', { align: 'center', bold: true, size: 'md' }))
  lines.push(HR,
    row(tableName, ticketNo ? `#${ticketNo}` : '', { size: 'md', bold: true }),
    row(takenBy ? `Taken by: ${takenBy}` : '', `Covers: ${covers ?? ''}`),
    row(bsDateText(stamp), nepalTime(stamp), { size: 'xs' }),
    HR)
  for (const i of items || []) {
    const delta = (i.sent_qty || 0) > 0 ? i.qty - i.sent_qty : 0
    const notes = [...optionLines(i.options), ...(i.notes ? [noteLine(`↳ ${i.notes}`)] : [])]
    // Already sent, quantity unchanged — only the note moved (S754). This used to fall through to
    // "×qty", which a station reads as a fresh order and cooks again. It prints no quantity at all.
    // `change` is a logged CHANGE ticket's line being reprinted (S809 3a), whose quantity is 0.
    if (i.change || ((i.sent_qty || 0) > 0 && delta === 0)) {
      lines.push(qtyRow(i.name, 'CHANGE'), text('CHANGE ONLY — not a new order', { indent: 1, size: 'xs', italic: true, bold: true }), ...notes)
      continue
    }
    // A negative delta (qty reduced since the last send, then resent) needs its own label — a plain
    // "×qty" would read as a fresh full order rather than a cut, and the kitchen has no other way to
    // tell "this is 3 now" from "make 3 more".
    const label = delta > 0 ? `+${delta}` : delta < 0 ? `↓${Math.abs(delta)} (now ${i.qty})` : `×${i.qty}`
    lines.push(qtyRow(i.name, label), ...notes)
    // S833: the note changed on the units the station already has as well, so they are told apart
    // from the "+N" (changedOnSentUnits).
    if (changedOnSentUnits(i)) {
      lines.push(qtyRow(i.name, 'CHANGE'),
        text(`CHANGE — the ${i.sent_qty} already sent, now: ${changeNoteText(i)}`, { indent: 1, size: 'xs', italic: true, bold: true }))
    }
  }
  lines.push(HR)
  return { v: TICKET_DOC_VERSION, title: station === 'BOT' ? 'BOT' : 'KOT', lines }
}

// A VOID slip for a station (S817 4i, FLOOR-KITCHEN-4): printed by the void for each station whose
// ticket for this order was still being made, so the paper rail gets the stop the Kitchen Display
// shows. `items` are the cancelled tickets' own lines, exactly as sent, so the cook can match them to
// the KOT on the rail.
export function voidSlipDoc({ station, items, ticketNo, outletName, tableName, voidedBy, voidedAt }) {
  const stamp = stampOf(voidedAt)
  const lines = []
  if (outletName) lines.push(text(outletName, { align: 'center', bold: true, size: 'md' }))
  lines.push(
    text(`*** VOID — ${station === 'BOT' ? 'BAR' : 'KITCHEN'} ***`, { align: 'center', bold: true, size: 'xl' }),
    text('STOP — DO NOT MAKE', { align: 'center', bold: true, size: 'md' }),
    HR,
    row(tableName || 'Takeaway', ticketNo ? `#${ticketNo}` : '', { size: 'md', bold: true }),
    row(voidedBy ? `Voided by: ${voidedBy}` : '', ''),
    row(bsDateText(stamp), nepalTime(stamp), { size: 'xs' }),
    HR)
  for (const i of items || []) {
    if (i.change) lines.push(qtyRow(i.name, 'CHANGE', { strike: true }))
    else lines.push(qtyRow(i.name, `×${i.qty ?? ''}`, { strike: true }), ...optionLines(i.options))
  }
  lines.push(HR, text('This order was voided. Nothing above is wanted.', { align: 'center', size: 'xs' }))
  return { v: TICKET_DOC_VERSION, title: `VOID ${station === 'BOT' ? 'BOT' : 'KOT'}`, lines }
}

// A MOVE slip for a station (S836): printed when a running bill, or some of its dishes, moves to
// another table while that station still has food for it, so the paper rail follows the food to its
// new table. It says it is not a new order, because a slip the kitchen reads as one is a dish cooked
// twice.
export function moveSlipDoc({ station, outletName, fromTable, toTable, orderNo, items, movedBy, movedAt }) {
  const stamp = stampOf(movedAt)
  const to    = toTable || 'Takeaway'
  const lines = []
  if (outletName) lines.push(text(outletName, { align: 'center', bold: true, size: 'md' }))
  lines.push(
    text(station === 'BOT' ? 'BAR' : 'KITCHEN', { align: 'center', bold: true, size: 'md' }),
    text('*** MOVED ***', { align: 'center', bold: true, size: 'xl' }),
    text('NOT A NEW ORDER', { align: 'center', bold: true }),
    HR,
    text(`${fromTable || 'Takeaway'} → ${to}`, { align: 'center', bold: true, size: 'xl' }),
    row('Bill', orderNo != null ? `#${orderNo}` : '', { rBold: true, rSize: 'md' }),
    row(movedBy ? `Moved by: ${movedBy}` : '', ''),
    row(bsDateText(stamp), nepalTime(stamp), { size: 'xs' }),
    HR)
  for (const i of items || []) {
    lines.push(qtyRow(i.name, `×${i.qty ?? ''}`), ...optionLines(i.options), ...(i.notes ? [noteLine(`↳ ${i.notes}`)] : []))
  }
  lines.push(HR, text(`Already ordered — serve it at ${to}.`, { align: 'center', size: 'xs' }))
  return { v: TICKET_DOC_VERSION, title: `MOVED ${station === 'BOT' ? 'BOT' : 'KOT'}`, lines }
}

// POS Setup → Printers' Test print, and the print station page's own test. The Nepali line proves the
// printer computer can print a Nepali dish name, which a printer's built-in font cannot.
export function testDoc({ outletName, deviceName, station, at }) {
  const stamp = stampOf(at)
  const lines = []
  if (outletName) lines.push(text(outletName, { align: 'center', bold: true, size: 'md' }))
  lines.push(
    text('TEST PRINT', { align: 'center', bold: true, size: 'xl' }),
    text(station === 'BOT' ? 'Bar tickets' : 'Kitchen tickets', { align: 'center', bold: true }),
    HR,
    row('Printer computer', deviceName || ''),
    row(bsDateText(stamp), nepalTime(stamp), { size: 'xs' }),
    HR,
    qtyRow('VEG MOMO', '×2'),
    noteLine('↳ less spicy'),
    qtyRow('दाल भात', '+1'),
    HR,
    text('If this is readable, tickets will print here.', { align: 'center', size: 'xs' }))
  return { v: TICKET_DOC_VERSION, title: 'TEST', lines }
}

// A device adds this when it prints a job claimed more than 2 minutes after the till queued it, so
// the kitchen reads the delay off the paper instead of thinking the guest just ordered.
export function withLateLine(doc, createdAtIso) {
  const lines = Array.isArray(doc?.lines) ? [...doc.lines] : []
  const late  = text(`PRINTED LATE — sent ${nepalTime(new Date(createdAtIso))}`, { align: 'center', bold: true, size: 'md' })
  const title = lines.findIndex(l => l?.k === 'text' && (l.size === 'lg' || l.size === 'xl'))
  lines.splice(title + 1, 0, late)
  return { ...doc, lines }
}

const TICKET_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'Courier New','Nirmala UI','Noto Sans Devanagari',monospace; font-size:13px; width:80mm; padding:8px 10px; color:#000; }
  .t  { padding:1px 0; overflow-wrap:anywhere; }
  .c  { text-align:center; }
  .b  { font-weight:bold; }
  .i  { font-style:italic; }
  .in { padding-left:10px; }
  .xs { font-size:11px; } .sm { font-size:13px; } .md { font-size:15px; } .lg { font-size:17px; } .xl { font-size:20px; }
  .c.lg { letter-spacing:1px; } .c.xl { letter-spacing:2px; }
  hr  { border:none; border-top:1px dashed #000; margin:7px 0; }
  .row { display:flex; justify-content:space-between; align-items:baseline; gap:8px; padding:3px 0; }
  .row > span:first-child { overflow-wrap:anywhere; }
  .row > span:last-child  { text-align:right; white-space:nowrap; }
`

const sizeOf = s => (SIZES.has(s) ? s : 'sm')
const cls = parts => parts.filter(Boolean).join(' ')
const attr = c => (c ? ` class="${c}"` : '')
const struck = (t, strike) => (strike ? `<s>${esc(t)}</s>` : esc(t))

// One line of a doc as HTML. A doc can come from the database (a queued job), so every field is
// coerced and an unknown kind prints nothing rather than throwing.
function lineHtml(l) {
  if (!l || typeof l !== 'object') return ''
  if (l.k === 'hr') return '<hr>'
  if (l.k === 'row') {
    const size  = sizeOf(l.size)
    const rSize = l.rSize ? sizeOf(l.rSize) : size
    const left  = cls([(l.lBold ?? l.bold) && 'b'])
    const right = cls([(l.rBold ?? l.bold) && 'b', rSize !== size && rSize])
    return `<div class="${cls(['row', size !== 'sm' && size])}"><span${attr(left)}>${struck(String(l.l ?? ''), l.strike)}</span><span${attr(right)}>${esc(String(l.r ?? ''))}</span></div>`
  }
  if (l.k === 'text') {
    const size = sizeOf(l.size)
    const c = cls(['t', l.align === 'center' && 'c', l.bold && 'b', l.italic && 'i', l.indent ? 'in' : '', size !== 'sm' && size])
    return `<div class="${c}">${struck(String(l.t ?? ''), l.strike)}</div>`
  }
  return ''
}

export function renderTicketDocHtml(doc) {
  const lines = Array.isArray(doc?.lines) ? doc.lines : []
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(String(doc?.title ?? 'Ticket'))}</title>
<style>${TICKET_CSS}</style>
</head><body>
${lines.map(lineHtml).join('\n')}
</body></html>`
}

// What the database refuses (docs/kitchen-printers.md): checked before a job is queued, so a slip too
// big to queue prints on the till instead of failing at the server.
export const TICKET_DOC_MAX_LINES = 300
export const TICKET_DOC_MAX_BYTES = 32768
export function ticketDocFits(doc) {
  return Array.isArray(doc?.lines) && doc.lines.length <= TICKET_DOC_MAX_LINES
    && new TextEncoder().encode(JSON.stringify(doc)).length <= TICKET_DOC_MAX_BYTES
}
