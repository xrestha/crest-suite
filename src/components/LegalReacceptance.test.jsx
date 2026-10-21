/**
 * The legal gate's wording, from this outlet's own ledger (S855). A document is a first acceptance
 * when the business holds no row of its type in any version; a row from the trial signup or a signed
 * paper agreement counts as an earlier acceptance. Before S855 the gate guessed from whether an
 * earlier version had ever been published (S852), which could not tell an Owner who accepted v1.0
 * from one who never accepted anything once v1.1 shipped.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'

let mockAuth = { signOut: jest.fn(), refreshProfile: jest.fn(), legalAccepted: [] }
jest.mock('../context/AuthContext', () => ({ useAuth: () => mockAuth }))
jest.mock('../shared/adminOp', () => ({ adminOp: jest.fn() }))

const {
  default: LegalReacceptance, splitPendingDocs, gateCopy, lastAcceptedVersion,
} = require('./LegalReacceptance')
const { docsRequiringReacceptance } = require('../legal')

const terms = { docType: 'terms', title: 'Terms of Service', version: '1.1' }
const privacy = { docType: 'privacy', title: 'Privacy Policy', version: '1.1' }
const row = (doc_type, doc_version) => ({ doc_type, doc_version })

describe('splitPendingDocs', () => {
  it('a document type with no row in any version is a first acceptance', () => {
    const { firstTime, changed } = splitPendingDocs([terms, privacy], [])
    expect(firstTime.map(d => d.docType)).toEqual(['terms', 'privacy'])
    expect(changed).toEqual([])
  })

  it('a row of an earlier version makes it a changed document, whatever wrote the row', () => {
    // The ledger read carries no method column: a clickwrap_trial or signed_paper row is a row.
    const { firstTime, changed } = splitPendingDocs([terms, privacy], [row('terms', '1.0')])
    expect(changed.map(d => d.docType)).toEqual(['terms'])
    expect(firstTime.map(d => d.docType)).toEqual(['privacy'])
  })

  it('a failed read (null) counts nothing as accepted', () => {
    expect(splitPendingDocs([terms], null).firstTime).toEqual([terms])
  })
})

describe('gateCopy', () => {
  it('every document new to the business: the plain ask', () => {
    expect(gateCopy([terms, privacy], []).heading).toBe('Please accept our terms')
    expect(gateCopy([terms], []).body).toBe('Please review and accept this document to continue using Crest Suite.')
  })

  it('every document accepted before: the update', () => {
    const c = gateCopy([terms, privacy], [row('terms', '1.0'), row('privacy', '1.0')])
    expect(c.heading).toBe('We have updated our terms')
    expect(c.body).toMatch(/^These documents have changed since you last accepted them\./)
    expect(gateCopy([terms], [row('terms', '1.0')]).body).toMatch(/^This document has changed since you last accepted it\./)
  })

  it('a mix names which document changed and which is new', () => {
    const c = gateCopy([terms, privacy], [row('terms', '1.0')])
    expect(c.heading).toBe('We have updated our terms')
    expect(c.body).toBe('The Terms of Service has changed since you last accepted it, and you have not accepted the Privacy Policy before. Please review and accept them to continue using Crest Suite.')
  })
})

describe('lastAcceptedVersion', () => {
  it('the newest version by number, not by text', () => {
    expect(lastAcceptedVersion([row('terms', '1.9'), row('terms', '1.10'), row('privacy', '2.0')], 'terms')).toBe('1.10')
    expect(lastAcceptedVersion([row('privacy', '1.0')], 'terms')).toBeNull()
  })
})

describe('LegalReacceptance', () => {
  const pending = docsRequiringReacceptance()

  it('asks for a first acceptance when this business has accepted nothing, inside the page main landmark', () => {
    mockAuth = { ...mockAuth, legalAccepted: [] }
    render(<LegalReacceptance />)
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Please accept our terms')
    expect(screen.queryByText(/updated our terms/i)).toBeNull()
    expect(screen.queryByText(/since you last accepted/i)).toBeNull()
    expect(screen.queryByText(/last accepted: version/i)).toBeNull()
  })

  it('says the terms were updated when every pending document was accepted in an earlier version', () => {
    mockAuth = { ...mockAuth, legalAccepted: pending.map(d => row(d.docType, '0.9')) }
    render(<LegalReacceptance />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('We have updated our terms')
    expect(screen.getByText(/since you last accepted/i)).toBeTruthy()
    expect(screen.getAllByText(/last accepted: version 0\.9/i)).toHaveLength(pending.length)
  })
})
