/**
 * The legal gate's wording (S852). v1.0 is the only version ever published, so an Owner held at
 * the gate has never accepted anything, and "We have updated our terms" described a change to
 * documents they had never been shown. The updated wording stays for a real re-acceptance.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'

jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ signOut: jest.fn(), refreshProfile: jest.fn() }),
}))
jest.mock('../shared/adminOp', () => ({ adminOp: jest.fn() }))

const { default: LegalReacceptance, isFirstAcceptance } = require('./LegalReacceptance')

describe('isFirstAcceptance', () => {
  const terms = { docType: 'terms', version: '1.1' }
  const privacy = { docType: 'privacy', version: '1.0' }

  it('is a first acceptance when no pending document has an earlier version', () => {
    expect(isFirstAcceptance([terms, privacy], {})).toBe(true)
  })

  it('is a re-acceptance when any pending document had an earlier version', () => {
    expect(isFirstAcceptance([terms, privacy], { 'terms-1.0': {} })).toBe(false)
  })

  it('does not mistake another document type for this one', () => {
    expect(isFirstAcceptance([privacy], { 'terms-1.0': {} })).toBe(true)
  })
})

describe('LegalReacceptance', () => {
  it('asks for a first acceptance on v1.0, inside the page main landmark', () => {
    render(<LegalReacceptance />)
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Please accept our terms')
    expect(screen.queryByText(/updated our terms/i)).toBeNull()
    expect(screen.queryByText(/since you last accepted/i)).toBeNull()
  })
})
