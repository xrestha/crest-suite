/**
 * The city box on POS Setup and the dashboards (S786). What it may SEND is the point: only the
 * three city columns (settings-row.md: a patch, never the row), and never the Owner's rainy-day
 * figure — and what it SHOWS must not claim a city the page has not read for this client.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let mockAuth
let mockSettings
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../../context/SettingsContext', () => ({ useSettings: () => mockSettings }))

// eslint-disable-next-line import/first
import WeatherCityPicker from './WeatherCityPicker'

const CLIENT = 'c-1'
const row = (extra = {}) => ({ client_id: CLIENT, weather_city: 'kathmandu', weather_lat: 27.72, weather_lon: 85.32, rain_sales_pct: 60, ...extra })

beforeEach(() => {
  mockAuth = { isAdmin: false, isOwner: false, profile: { pos_role: 'manager' } }
  mockSettings = {
    settings: row(), settingsLoadError: null, settingsClientId: CLIENT,
    saveSettings: jest.fn(() => Promise.resolve()),
  }
})

test('saves only the three city columns', async () => {
  render(<WeatherCityPicker clientId={CLIENT} />)
  fireEvent.change(screen.getByLabelText(/City/), { target: { value: 'pokhara' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save city' }))
  await waitFor(() => expect(mockSettings.saveSettings).toHaveBeenCalledTimes(1))
  expect(mockSettings.saveSettings.mock.calls[0][0]).toEqual({ weather_city: 'pokhara', weather_lat: 28.21, weather_lon: 83.99 })
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '✓ Saved')
})

test('Save is off until the city changes', () => {
  render(<WeatherCityPicker clientId={CLIENT} />)
  expect(screen.getByRole('button', { name: 'Save city' }).disabled).toBe(true)
})

test('a refused save is said, and the choice stays on screen to retry', async () => {
  mockSettings.saveSettings = jest.fn(() => Promise.reject(new Error('weather_city_rank: only the Owner or a manager can change the outlet\'s weather city')))
  render(<WeatherCityPicker clientId={CLIENT} />)
  fireEvent.change(screen.getByLabelText(/City/), { target: { value: 'pokhara' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save city' }))
  expect((await screen.findByRole('alert')).textContent).toMatch(/Only the Owner or a manager/)
  expect(screen.getByLabelText(/City/).value).toBe('pokhara')
})

test('a login that may not change it sees the city read-only', () => {
  mockAuth = { isAdmin: false, isOwner: false, profile: { pos_role: 'supervisor' } }
  render(<WeatherCityPicker clientId={CLIENT} />)
  expect(screen.getByText('City: Kathmandu')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save city' })).toBeNull()
})

test('shows nothing it has not read for THIS client, and says so after a failed read', () => {
  mockSettings.settingsClientId = 'another-client'
  const { rerender } = render(<WeatherCityPicker clientId={CLIENT} />)
  expect(screen.getByText('Loading…')).toBeTruthy()
  expect(screen.queryByLabelText(/City/)).toBeNull()

  mockSettings = { ...mockSettings, settingsClientId: CLIENT, settingsLoadError: new Error('boom') }
  rerender(<WeatherCityPicker clientId={CLIENT} />)
  expect(screen.getByRole('alert').textContent).toMatch(/could not be read/)
})

test('a client with no settings row starts on "Not set", and no client means no picker', () => {
  mockSettings.settings = { app_name: 'Crest' }   // DEFAULT_SETTINGS carries no client_id
  const { rerender } = render(<WeatherCityPicker clientId={CLIENT} />)
  expect(screen.getByLabelText(/City/).value).toBe('')
  rerender(<WeatherCityPicker clientId={null} />)
  expect(screen.getByText(/Choose a client/)).toBeTruthy()
})
