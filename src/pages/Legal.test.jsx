/**
 * The legal page by address. Every acceptance row links to /legal/<doc>/<version>, so a superseded
 * version the bundle holds must render ITS OWN text, date and hash (Privacy 1.0 since 1.1 shipped,
 * 2026-11-03), and a version it does not hold must render no text and no hash at all, never the
 * current wording under another version's banner (S678).
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

const Legal = require('./Legal').default
const { legalDoc, priorLegalDoc } = require('../legal')

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/legal/:docType" element={<Legal />} />
        <Route path="/legal/:docType/:version" element={<Legal />} />
      </Routes>
    </MemoryRouter>
  )
}

const SENTRY_ROW = /Sentry \(Functional Software, Inc\.\)/

describe('Legal page', () => {
  it('the current Privacy Policy shows 1.1, its hash and the Sentry row, with no banner', async () => {
    renderAt('/legal/privacy')
    expect(await screen.findByText(SENTRY_ROW)).toBeTruthy()
    expect(screen.queryByText(/This is not the current version/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Check this is the real text/ }))
    expect(screen.getByText(legalDoc('privacy').sha256)).toBeTruthy()
    expect(screen.getByText('sha256sum privacy-v1.1.md')).toBeTruthy()
  })

  it('Privacy 1.0 shows its own text, date and hash under a superseded banner', async () => {
    const v10 = priorLegalDoc('privacy', '1.0')
    renderAt('/legal/privacy/1.0')
    // A heading both versions share, so this waits for the text rather than for a difference.
    expect(await screen.findByRole('heading', { name: /Who we share information with/ })).toBeTruthy()
    expect(screen.queryByText(SENTRY_ROW)).toBeNull()
    expect(screen.getByText(/took effect on/).textContent).toMatch(/Version 1\.0 took effect on 3 September 2026/)
    expect(screen.getByRole('link', { name: /1\.1, effective 3 November 2026/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Check this is the real text/ }))
    expect(screen.getByText(v10.sha256)).toBeTruthy()
    expect(screen.queryByText(legalDoc('privacy').sha256)).toBeNull()
    expect(screen.getByText('sha256sum privacy-v1.0.md')).toBeTruthy()
  })

  it('a version that was never published shows no text and no hash', () => {
    renderAt('/legal/privacy/0.9')
    expect(screen.getByText(/is not a/).textContent).toMatch(/Version 0\.9 is not a\s+version of this document that we published/)
    expect(screen.queryByRole('button', { name: /Check this is the real text/ })).toBeNull()
    expect(screen.queryByText(/Loading/)).toBeNull()
  })
})
