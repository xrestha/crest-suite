import {
  kotBotDoc, voidSlipDoc, moveSlipDoc, testDoc, withLateLine, renderTicketDocHtml, ticketDocFits,
  TICKET_DOC_MAX_LINES,
} from './ticketDoc'

// renderTicketDocHtml returns an HTML string, not a component render, which the testing-library lint
// cannot tell from its name.
/* eslint-disable testing-library/render-result-naming-convention */
const toHtml = renderTicketDocHtml

// S837: every station slip is one document that three printers render (docs/kitchen-printers.md).
const AT = '2026-10-12T14:20:00Z' // 08:05 PM in Nepal

describe('kotBotDoc', () => {
  const doc = kotBotDoc({
    station: 'KOT', ticketNo: 23, outletName: 'Bloom Cafe', tableName: 'Table 4', takenBy: 'Sita', covers: 3, at: AT,
    items: [
      { name: 'Veg Momo', qty: 2, sent_qty: 0, options: [{ kitchen: 'No onion', is_removal: true }, { kitchen: 'Extra chutney' }], notes: 'less spicy' },
      { name: 'दाल भात', qty: 3, sent_qty: 1 },
      { name: 'Thukpa', qty: 1, sent_qty: 2 },
    ],
  })

  test('is a version 1 document with only the three line kinds', () => {
    expect(doc.v).toBe(1)
    expect(doc.title).toBe('KOT')
    expect(doc.lines.every(l => ['text', 'row', 'hr'].includes(l.k))).toBe(true)
  })

  test('heads with the outlet, the station and the table, number, waiter, covers and Nepal time', () => {
    expect(doc.lines[0]).toMatchObject({ k: 'text', t: 'Bloom Cafe', align: 'center' })
    expect(doc.lines[1]).toMatchObject({ k: 'text', t: 'KITCHEN ORDER TICKET', size: 'lg' })
    expect(doc.lines).toContainEqual(expect.objectContaining({ k: 'row', l: 'Table 4', r: '#23' }))
    expect(doc.lines).toContainEqual(expect.objectContaining({ k: 'row', l: 'Taken by: Sita', r: 'Covers: 3' }))
    expect(doc.lines).toContainEqual(expect.objectContaining({ k: 'row', r: '08:05 PM', size: 'xs' }))
  })

  test('labels a fresh dish ×qty, an added one +N, a cut one ↓N, with its choices and note', () => {
    const rows = doc.lines.filter(l => l.k === 'row' && l.rSize === 'md').map(l => [l.l, l.r])
    expect(rows).toEqual([['Veg Momo', '×2'], ['दाल भात', '+2'], ['Thukpa', '↓1 (now 1)']])
    expect(doc.lines).toContainEqual(expect.objectContaining({ t: 'NO onion', indent: 1, bold: true }))
    expect(doc.lines).toContainEqual(expect.objectContaining({ t: '+ Extra chutney', indent: 1 }))
    expect(doc.lines).toContainEqual(expect.objectContaining({ t: '↳ less spicy', italic: true }))
  })

  test('a bar ticket says so', () => {
    expect(kotBotDoc({ station: 'BOT', items: [], at: AT }).lines[0].t).toBe('BAR ORDER TICKET')
  })
})

describe('the VOID and MOVE slips', () => {
  test('VOID strikes each dish', () => {
    const doc = voidSlipDoc({ station: 'BOT', items: [{ name: 'Lassi', qty: 2 }], voidedAt: AT })
    expect(doc.lines[0].t).toBe('*** VOID — BAR ***')
    expect(doc.lines).toContainEqual(expect.objectContaining({ k: 'row', l: 'Lassi', r: '×2', strike: true }))
  })

  test('MOVE names both tables and says it is not a new order', () => {
    const doc = moveSlipDoc({ station: 'KOT', fromTable: 'T3', toTable: 'T5', orderNo: 9, items: [], movedAt: AT })
    expect(doc.lines.map(l => l.t)).toEqual(expect.arrayContaining(['*** MOVED ***', 'NOT A NEW ORDER', 'T3 → T5']))
  })
})

// S839 (docs/pos-combos.md): a combo's dish goes to its own station like any dish, with its combo under
// it in an existing line style, so no renderer changes. The doc only prints; the logged ticket items keep
// their recipe_id and full selection_key (with the '@' tail) for the Clear rule and the KDS pulls.
describe('combos on the station slips', () => {
  const KEY = '@7f0c2c1e-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-00000000000a'
  const MOMO = { recipe_id: 'r-momo', name: 'Chicken Momo', qty: 1, sent_qty: 0, selection_key: `opt1${KEY}`, combo_name: 'Momo Combo', options: [{ kitchen: 'Extra cheese' }], notes: 'less spicy' }
  const tagOf = doc => doc.lines.filter(l => l.k === 'text' && l.t.startsWith('↳ Momo'))
  const after = (doc, name) => doc.lines[doc.lines.findIndex(l => l.k === 'row' && l.l === name) + 1]

  test('the KOT prints ↳ <combo> right under the dish, small and indented, not italic like a note', () => {
    const doc = kotBotDoc({ station: 'KOT', items: [MOMO, { name: 'Tea', qty: 1, sent_qty: 0 }], at: AT })
    expect(tagOf(doc)).toEqual([{ k: 'text', t: '↳ Momo Combo', indent: 1, size: 'xs' }])
    expect(after(doc, 'Chicken Momo')).toEqual({ k: 'text', t: '↳ Momo Combo', indent: 1, size: 'xs' })
    expect(after(doc, 'Tea')).not.toMatchObject({ t: expect.stringMatching(/^↳/) })
    expect(doc.lines.every(l => ['text', 'row', 'hr'].includes(l.k))).toBe(true)
    // The renderer needs nothing new: it is an ordinary indented line.
    expect(toHtml(doc)).toContain('<div class="t in xs">↳ Momo Combo</div>')
  })

  test('a CHANGE line and a cart line holding its combo as an object are tagged too; a dish with none is not', () => {
    const change = kotBotDoc({ station: 'KOT', items: [{ ...MOMO, change: true, qty: 0 }], at: AT })
    expect(after(change, 'Chicken Momo')).toMatchObject({ t: '↳ Momo Combo' })
    const cart = kotBotDoc({ station: 'KOT', items: [{ name: 'Coke', qty: 1, combo: { name: 'Momo Combo' } }], at: AT })
    expect(after(cart, 'Coke')).toMatchObject({ t: '↳ Momo Combo' })
    const plain = kotBotDoc({ station: 'KOT', items: [{ name: 'Coke', qty: 1, combo_name: '  ' }], at: AT })
    expect(plain.lines.some(l => l.k === 'text' && l.t.startsWith('↳'))).toBe(false)
  })

  test('the VOID and MOVE slips tag the dish the same way', () => {
    const v = voidSlipDoc({ station: 'KOT', items: [MOMO], voidedAt: AT })
    expect(after(v, 'Chicken Momo')).toEqual({ k: 'text', t: '↳ Momo Combo', indent: 1, size: 'xs' })
    const m = moveSlipDoc({ station: 'KOT', fromTable: 'T3', toTable: 'T5', items: [MOMO], movedAt: AT })
    expect(after(m, 'Chicken Momo')).toEqual({ k: 'text', t: '↳ Momo Combo', indent: 1, size: 'xs' })
  })

  test('a combo name a person typed is escaped by the renderer', () => {
    const doc = kotBotDoc({ station: 'KOT', items: [{ ...MOMO, combo_name: '<img src=x>' }], at: AT })
    expect(toHtml(doc)).toContain('↳ &lt;img src=x&gt;')
    expect(toHtml(doc)).not.toContain('<img')
  })
})

describe('withLateLine', () => {
  test('puts the late line under the title, in Nepal time, without changing the original', () => {
    const doc = kotBotDoc({ station: 'KOT', outletName: 'Bloom', items: [], at: AT })
    const late = withLateLine(doc, AT)
    expect(late.lines[2]).toMatchObject({ k: 'text', t: 'PRINTED LATE — sent 08:05 PM', bold: true })
    expect(late.lines[1].t).toBe('KITCHEN ORDER TICKET')
    expect(doc.lines).toHaveLength(late.lines.length - 1)
  })

  test('goes first when the doc has no title line', () => {
    expect(withLateLine({ v: 1, lines: [{ k: 'hr' }] }, AT).lines[0].t).toMatch(/^PRINTED LATE/)
  })
})

describe('renderTicketDocHtml', () => {
  test('escapes everything a person typed, in every field', () => {
    const html = toHtml({
      v: 1, title: '<x>',
      lines: [
        { k: 'text', t: '<img src=x onerror=alert(1)>' },
        { k: 'row', l: 'A & B', r: '"quoted"' },
      ],
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('A &amp; B')
    expect(html).toContain('&quot;quoted&quot;')
    expect(html).toContain('<title>&lt;x&gt;</title>')
  })

  test('survives a malformed doc from the database: unknown kinds and bad sizes print nothing odd', () => {
    const html = toHtml({ lines: [null, 7, { k: 'script', t: 'x' }, { k: 'text', t: 'ok', size: 'huge' }] })
    expect(html).toContain('<div class="t">ok</div>')
    expect(html).not.toContain('script')
    expect(toHtml(null)).toContain('<body>')
  })

  test('prints the Nepali line of the test ticket', () => {
    expect(toHtml(testDoc({ deviceName: 'Counter PC', station: 'KOT', at: AT }))).toContain('दाल भात')
  })
})

describe('ticketDocFits', () => {
  test('a normal ticket fits; one past the line limit does not', () => {
    expect(ticketDocFits(testDoc({ station: 'KOT' }))).toBe(true)
    expect(ticketDocFits({ v: 1, lines: Array.from({ length: TICKET_DOC_MAX_LINES + 1 }, () => ({ k: 'hr' })) })).toBe(false)
    expect(ticketDocFits({ v: 1, lines: [{ k: 'text', t: 'x'.repeat(40000) }] })).toBe(false)
  })
})
