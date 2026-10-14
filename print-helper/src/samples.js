'use strict'
// Sample ticket documents, shaped like the till's builders (src/modules/pos/printing/ticketDoc.js):
// the --test-print ticket, and the KOT and VOID slips tools/preview.js draws.

const text = (t, o = {}) => ({ k: 'text', t, ...o })
const row = (l, r, o = {}) => ({ k: 'row', l, r, ...o })
const HR = { k: 'hr' }
const qtyRow = (name, label, o = {}) => row(name, label, { lBold: true, rBold: true, rSize: 'md', ...o })
const note = t => text(t, { indent: 1, size: 'xs', italic: true })

function testPrintDoc({ host, port, width, now = new Date() }) {
  const nepal = new Date(now.getTime() + (5 * 60 + 45) * 60000)
  const hhmm = `${String(nepal.getUTCHours()).padStart(2, '0')}:${String(nepal.getUTCMinutes()).padStart(2, '0')}`
  return {
    v: 1,
    title: 'TEST',
    lines: [
      text('TEST PRINT', { align: 'center', bold: true, size: 'xl' }),
      text('Crest Print Helper', { align: 'center', bold: true }),
      HR,
      row('Printer', `${host}:${port}`),
      row('Paper', `${width} mm`),
      row('Time (Nepal)', hhmm, { size: 'xs' }),
      HR,
      qtyRow('VEG MOMO', '×2'),
      note('↳ less spicy'),
      qtyRow('दाल भात', '+1'),
      note('↳ कम पिरो'),
      HR,
      text('If this is readable, tickets will print here.', { align: 'center', size: 'xs' }),
    ],
  }
}

function sampleKotDoc({ reprint = true } = {}) {
  const lines = [
    text('Himalayan Kitchen & Bar', { align: 'center', bold: true, size: 'md' }),
    text('KITCHEN ORDER TICKET', { align: 'center', bold: true, size: 'lg' }),
  ]
  if (reprint) lines.push(text('*** REPRINT — NOT A NEW ORDER ***', { align: 'center', bold: true, size: 'md' }))
  lines.push(
    HR,
    row('Table 4', '#23', { size: 'md', bold: true }),
    row('Taken by: Sita', 'Covers: 3'),
    row('28 Asoj 2083', '14:05', { size: 'xs' }),
    HR,
    qtyRow('VEG MOMO', '×2'),
    text('NO onion', { indent: 1, bold: true }),
    text('+ extra achar', { indent: 1 }),
    note('↳ less spicy'),
    qtyRow('CHICKEN CHOWMEIN', '+2'),
    qtyRow('BUFF SEKUWA', '↓1 (now 2)'),
    qtyRow('MASALA TEA', 'CHANGE'),
    text('CHANGE ONLY — not a new order', { indent: 1, size: 'xs', italic: true, bold: true }),
    note('↳ no sugar, extra ginger'),
    qtyRow('दाल भात', '×3'),
    note('↳ कम पिरो'),
    qtyRow('VERY LONG DISH NAME THAT WILL HAVE TO WRAP ONTO A SECOND LINE OK', '×12'),
    qtyRow('खसीको मासु र चिउरा सेट (स्पेशल)', '×1'),
    text('Cancelled dish shown struck through', { strike: true }),
    row('PANEER TIKKA', '×1', { lBold: true, rBold: true, rSize: 'md', strike: true }),
    HR,
    text('Supercalifragilisticexpialidocious_long_unbroken_word_from_a_guest_note_1234567890', { size: 'xs' }),
    text('<b>not bold</b> & plain text', { size: 'xs' }),
    HR,
  )
  return { v: 1, title: 'KOT', lines }
}

function sampleVoidDoc() {
  return {
    v: 1,
    title: 'VOID KOT',
    lines: [
      text('Himalayan Kitchen & Bar', { align: 'center', bold: true, size: 'md' }),
      text('*** VOID — KITCHEN ***', { align: 'center', bold: true, size: 'xl' }),
      text('STOP — DO NOT MAKE', { align: 'center', bold: true, size: 'md' }),
      HR,
      row('Table 4', '#23', { size: 'md', bold: true }),
      row('Voided by: Ram', ''),
      row('28 Asoj 2083', '14:20', { size: 'xs' }),
      HR,
      qtyRow('VEG MOMO', '×2', { strike: true }),
      text('NO onion', { indent: 1, bold: true }),
      qtyRow('दाल भात', '×3', { strike: true }),
      qtyRow('MASALA TEA', 'CHANGE', { strike: true }),
      HR,
      text('This order was voided. Nothing above is wanted.', { align: 'center', size: 'xs' }),
    ],
  }
}

function sampleMoveDoc() {
  return {
    v: 1,
    title: 'MOVED KOT',
    lines: [
      text('Himalayan Kitchen & Bar', { align: 'center', bold: true, size: 'md' }),
      text('KITCHEN', { align: 'center', bold: true, size: 'md' }),
      text('*** MOVED ***', { align: 'center', bold: true, size: 'xl' }),
      text('NOT A NEW ORDER', { align: 'center', bold: true }),
      HR,
      text('Table 4 → Table 9', { align: 'center', bold: true, size: 'xl' }),
      row('Bill', '#23', { rBold: true, rSize: 'md' }),
      row('Moved by: Sita', ''),
      HR,
      qtyRow('VEG MOMO', '×2'),
      note('↳ less spicy'),
      HR,
      text('Already ordered — serve it at Table 9.', { align: 'center', size: 'xs' }),
    ],
  }
}

module.exports = { testPrintDoc, sampleKotDoc, sampleVoidDoc, sampleMoveDoc }
