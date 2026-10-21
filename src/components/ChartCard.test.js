import { useEffect, useState } from 'react'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'
import ChartCard from './ChartCard'

// S852: Recharts 3 makes every chart's <svg> a Tab stop with no name. ChartCard names it after the
// title on the card and in the expanded dialog, including when the svg arrives after mount, the way
// a ResponsiveContainer draws it once it has measured.

// Stands in for a Recharts surface: a focusable svg, drawn one tick after mount.
function LateChart({ id }) {
  const [ready, setReady] = useState(false)
  useEffect(() => { const t = setTimeout(() => setReady(true), 0); return () => clearTimeout(t) }, [])
  return ready ? <svg tabIndex={0} data-testid={id} /> : null
}

test('the chart surface is named by the card title, even when it is drawn after mount', async () => {
  render(<ChartCard title="Daily Purchases vs Sales" renderChart={() => <LateChart id="surface" />} />)
  const svg = await screen.findByTestId('surface')
  await waitFor(() => expect(svg).toHaveAccessibleName('Daily Purchases vs Sales'))
})

test('a chart that names itself keeps its own name', () => {
  render(<ChartCard title="Food cost" renderChart={() => <svg tabIndex={0} aria-label="Food cost by week" data-testid="own" />} />)
  expect(screen.getByTestId('own')).toHaveAccessibleName('Food cost by week')
  expect(screen.getByTestId('own')).not.toHaveAttribute('aria-labelledby')
})

test('the expanded chart is named by the dialog title, and Close is a plain classed button', async () => {
  render(<ChartCard title="Revenue" renderChart={h => <LateChart id={`surface-${h}`} />} />)
  fireEvent.click(screen.getByRole('button', { name: 'Expand chart: Revenue' }))
  const svg = await screen.findByTestId('surface-440')
  await waitFor(() => expect(svg).toHaveAccessibleName('Revenue'))
  const close = screen.getByRole('button', { name: '✕ Close' })
  expect(close).toHaveClass('chart-close-btn')
  // An inline border here beat the class's focus border, which is why it moved into the class.
  expect(close).not.toHaveAttribute('style')
})
