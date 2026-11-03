import { render, screen } from '@testing-library/react'
import FcBandKey from './FcBandKey'

// S864: the key names the three food-cost marks a tablet reader could not open a tooltip for, at the
// outlet's own thresholds, from fcBand itself.
describe('FcBandKey', () => {
  test('names all three bands at the outlet\'s own thresholds', () => {
    render(<FcBandKey settings={{ fc_warning_pct: 30, fc_critical_pct: 38 }} />)
    const key = screen.getByText(/Food cost:/)
    expect(key).toHaveTextContent('✓ Healthy (≤30%)')
    expect(key).toHaveTextContent('△ Watch (30–38%)')
    expect(key).toHaveTextContent('▲ Too high (>38%)')
  })

  test('falls back to the default thresholds the cells use', () => {
    render(<FcBandKey settings={null} />)
    expect(screen.getByText(/Food cost:/)).toHaveTextContent('✓ Healthy (≤35%) · △ Watch (35–45%) · ▲ Too high (>45%)')
  })
})
