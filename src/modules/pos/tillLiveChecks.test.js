// A source-reading test for four small things the S856 live check found on a real phone and till,
// none of which has a runtime symptom a unit test of the page could reach without the whole till.
import fs from 'fs'
import path from 'path'

const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8')
const orders = read('orders', 'PosOrders.jsx')
const creditNote = read('creditnotes', 'IssueCreditNoteModal.jsx')
const tables = read('tables', 'PosTableManagement.jsx')

test('the payment preview prints the order\'s covers, as the bill does', () => {
  const draft = orders.slice(orders.indexOf('const previewDraftOrder = {'), orders.indexOf('const previewHtml'))
  expect(draft).toMatch(/\bcovers,/)
})

test('on a touch screen Send carries no tip over the message line above it', () => {
  expect(orders).toMatch(/const coarsePointer = \(\) =>/)
  expect(orders).toMatch(/return coarsePointer\(\)\s*\?\s*<div style=\{\{ flex: 1, minWidth: 0 \}\}>\{sendButton\}<\/div>\s*:\s*<Tip text=\{sendTip\}/)
})

test('a credit note asks Inventory twice before saying it is not known, and never blames the connection', () => {
  expect(creditNote).toMatch(/ims = await readIms\(20000\)[\s\S]{0,400}ims = await readIms\(10000\)/)
  expect(creditNote).not.toMatch(/the connection dropped before the answer came back/)
  expect(creditNote).toMatch(/the check got no answer in time/)
})

test('the table QR dialog says guests can order, not that the menu is read-only', () => {
  const at = tables.indexOf('— Guest Menu QR`}')
  expect(at).toBeGreaterThan(-1)
  const dialog = tables.slice(at, at + 600)
  expect(dialog).not.toMatch(/read-only/)
  expect(dialog).toMatch(/where guests can order/)
  expect(dialog).toMatch(/waits for Accept on the till/)
})
