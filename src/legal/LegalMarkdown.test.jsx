/**
 * The renderer is small and purpose-built, so the thing worth testing is not CommonMark conformance
 * — it is whether it handles everything the REAL documents contain. A construct nobody thought
 * about does not throw; it renders as literal `**text**` or a row of pipes in the middle of a
 * contract, which reads as a broken page rather than as a parser gap.
 *
 * So these tests render the actual Terms and Privacy Policy and then look for markdown that
 * survived. Adding a document, or a new construct to an existing one, fails here first.
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

import LegalMarkdown, { parseMarkdown } from './LegalMarkdown'
import { LEGAL_TEXT } from './generated/legalText'
import { DOC_TYPES } from './index'

function renderDoc(text) {
  return render(
    <MemoryRouter>
      <LegalMarkdown text={text} />
    </MemoryRouter>
  )
}

describe.each(DOC_TYPES)('rendering the real %s document', (docType) => {
  it('leaves no unparsed markdown syntax in the visible text', () => {
    const { container } = renderDoc(LEGAL_TEXT[docType])
    const text = container.textContent

    // Bold/italic markers, heading hashes at a line start, and table pipes are the four ways an
    // unsupported construct shows itself to a reader.
    expect(text).not.toMatch(/\*\*/)
    expect(text).not.toMatch(/^#{1,4}\s/m)
    expect(text).not.toMatch(/\|/)
    // A link that did not parse leaves its bracket-paren shape behind.
    expect(text).not.toMatch(/\]\(/)
  })

  it('produces headings, paragraphs and at least one link', () => {
    const { container } = renderDoc(LEGAL_TEXT[docType])
    expect(container.querySelectorAll('h2, h3, h4').length).toBeGreaterThan(5)
    expect(container.querySelectorAll('p.legal-p').length).toBeGreaterThan(10)
    expect(container.querySelectorAll('a, a.legal-link, .legal-link').length).toBeGreaterThan(0)
  })

  it('gives every heading a non-empty id, so deep links and a contents list can agree', () => {
    const { container } = renderDoc(LEGAL_TEXT[docType])
    const headings = [...container.querySelectorAll('h2, h3, h4')]
    expect(headings.length).toBeGreaterThan(0)
    for (const h of headings) expect(h.id).toMatch(/.+/)
  })

  it('wraps every table so a wide table scrolls instead of overflowing the page', () => {
    const { container } = renderDoc(LEGAL_TEXT[docType])
    const tables = [...container.querySelectorAll('table')]
    for (const t of tables) expect(t.closest('.table-wrap')).not.toBeNull()
  })

  it('gives every table row the same cell count as its header', () => {
    const { container } = renderDoc(LEGAL_TEXT[docType])
    for (const table of container.querySelectorAll('table')) {
      const cols = table.querySelectorAll('thead th').length
      expect(cols).toBeGreaterThan(0)
      for (const row of table.querySelectorAll('tbody tr')) {
        expect(row.querySelectorAll('td').length).toBe(cols)
      }
    }
  })
})

describe('inline constructs', () => {
  it('renders bold, italic, code and links', () => {
    const { container } = renderDoc(
      'Plain **bold** and *italic* and `code` and [a link](https://example.com).'
    )
    expect(container.querySelector('strong').textContent).toBe('bold')
    expect(container.querySelector('em').textContent).toBe('italic')
    expect(container.querySelector('code').textContent).toBe('code')
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe('https://example.com')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toContain('noopener')
  })

  it('renders an in-app path as a router link that does not reload the bundle', () => {
    const { container } = renderDoc('See the [Privacy Policy](/legal/privacy).')
    const a = container.querySelector('a')
    expect(a.getAttribute('href')).toBe('/legal/privacy')
    expect(a.getAttribute('target')).toBeNull()
  })

  it('does not mistake bold for two empty italics', () => {
    const { container } = renderDoc('**Ownership.** Customer Data belongs to you.')
    expect(container.querySelectorAll('em')).toHaveLength(0)
    expect(container.querySelector('strong').textContent).toBe('Ownership.')
  })
})

describe('block constructs', () => {
  it('joins wrapped lines into one paragraph and splits on a blank line', () => {
    const { container } = renderDoc('One line\nand its continuation.\n\nA second paragraph.')
    const ps = container.querySelectorAll('p.legal-p')
    expect(ps).toHaveLength(2)
    expect(ps[0].textContent).toBe('One line and its continuation.')
  })

  it('demotes the document h1 to an h2, leaving h1 to the page', () => {
    const { container } = renderDoc('# Crest Suite Terms of Service')
    expect(container.querySelector('h1')).toBeNull()
    expect(container.querySelector('h2').textContent).toBe('Crest Suite Terms of Service')
  })

  it('renders a bullet list as a single ul', () => {
    const { container } = renderDoc('- one\n- two\n- three')
    expect(container.querySelectorAll('ul')).toHaveLength(1)
    expect(container.querySelectorAll('li')).toHaveLength(3)
  })

  it('keeps a ## section at h2 rather than demoting it under the contents rail', () => {
    // Every level was shifted down by one for a release. With the document's own # title
    // stripped for render, the only level-2 heading on the page was the rail's "Contents", so a
    // screen reader walking level-2 headings found a table of contents and no document.
    const { container } = renderDoc('## 1. Acceptance\n\n### 1.1 Detail\n\n#### Deeper')
    expect(container.querySelector('h2').textContent).toBe('1. Acceptance')
    expect(container.querySelector('h3').textContent).toBe('1.1 Detail')
    expect(container.querySelector('h4').textContent).toBe('Deeper')
    expect(container.querySelector('h1')).toBeNull()
  })

  it('renders a pipe table with its header', () => {
    renderDoc('| Provider | Purpose |\n|---|---|\n| Supabase | Database |')
    expect(screen.getByRole('columnheader', { name: 'Provider' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: 'Supabase' })).toBeInTheDocument()
  })

  it('labels every body cell with its column name, for the stacked phone layout', () => {
    const { container } = renderDoc('| Provider | **Purpose** |\n|---|---|\n| Supabase | Database |')
    const cells = container.querySelectorAll('tbody td')
    expect(cells[0].getAttribute('data-label')).toBe('Provider')
    // Inline markup is stripped from the label — it is printed by CSS, which cannot render it.
    expect(cells[1].getAttribute('data-label')).toBe('Purpose')
  })

  it('returns nothing for empty or missing input rather than throwing', () => {
    expect(parseMarkdown('')).toHaveLength(0)
    expect(parseMarkdown(null)).toHaveLength(0)
    expect(parseMarkdown(undefined)).toHaveLength(0)
  })
})
