/**
 * A long register renders a page of rows at a time, and says so (S842, useRowWindow + ShowMoreRows).
 * The Bill Register and KOT Register rendered every row fetchAllRows read, up to 1,00,000.
 */
import React, { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useRowWindow } from './useRowWindow'
import ShowMoreRows from './ShowMoreRows'

const rowsOf = n => Array.from({ length: n }, (_, i) => ({ id: i + 1 }))

function Register({ initialRows, initialKey = 'a' }) {
  const [rows, setRows] = useState(initialRows)
  const [key, setKey] = useState(initialKey)
  const win = useRowWindow(key)
  const shown = win.slice(rows)
  return (
    <div>
      <button onClick={() => { setKey('b'); setRows(rowsOf(450)) }}>new range</button>
      <button onClick={() => setRows(rowsOf(450))}>reload same range</button>
      <ul>{shown.map(r => <li key={r.id}>row {r.id}</li>)}</ul>
      <p>TOTAL {rows.length}</p>
      <ShowMoreRows shown={shown.length} total={rows.length} step={win.step} noun="rows" note="The TOTAL row covers all of them."
        onMore={win.showMore} onAll={win.showAll} onFirst={win.showFirst} />
    </div>
  )
}

const rendered = () => screen.queryAllByRole('listitem').length

test('the first 200 rows render, with "N of M shown", while the total counts every row', () => {
  render(<Register initialRows={rowsOf(450)} />)
  expect(rendered()).toBe(200)
  expect(screen.getByRole('status').textContent).toBe('200 of 450 rows shown. The TOTAL row covers all of them.')
  expect(screen.getByText('TOTAL 450')).toBeTruthy()
})

test('Show more adds a page, then the remainder; Show all and Show the first 200 move both ways', () => {
  render(<Register initialRows={rowsOf(450)} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show 200 more' }))
  expect(rendered()).toBe(400)
  fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }))
  expect(rendered()).toBe(450)
  expect(screen.getByRole('status').textContent).toMatch(/^All 450 rows shown\./)
  expect(screen.queryByRole('button', { name: /more$/ })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Show the first 200 only' }))
  expect(rendered()).toBe(200)
  fireEvent.click(screen.getByRole('button', { name: 'Show all 450' }))
  expect(rendered()).toBe(450)
})

test('the button pressed keeps focus when Show all becomes Show the first 200', () => {
  render(<Register initialRows={rowsOf(450)} />)
  const all = screen.getByRole('button', { name: 'Show all 450' })
  all.focus()
  fireEvent.click(all)
  expect(screen.getByRole('button', { name: 'Show the first 200 only' })).toHaveFocus()
})

test('a new range starts again at one page; a reload of the same range keeps what was opened', () => {
  render(<Register initialRows={rowsOf(450)} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show all 450' }))
  fireEvent.click(screen.getByRole('button', { name: 'reload same range' }))
  expect(rendered()).toBe(450)
  fireEvent.click(screen.getByRole('button', { name: 'new range' }))
  expect(rendered()).toBe(200)
})

test('a browser print renders every row, and the page returns to its window afterwards', () => {
  render(<Register initialRows={rowsOf(450)} />)
  act(() => { window.dispatchEvent(new Event('beforeprint')) })
  expect(rendered()).toBe(450)
  act(() => { window.dispatchEvent(new Event('afterprint')) })
  expect(rendered()).toBe(200)
})

test('a list that fits in one page renders whole, with no control', () => {
  render(<Register initialRows={rowsOf(200)} />)
  expect(rendered()).toBe(200)
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('button', { name: /Show/ })).toBeNull()
})
