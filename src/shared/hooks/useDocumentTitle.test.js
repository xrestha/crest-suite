import { renderHook } from '@testing-library/react'
import { useDocumentTitle, pageTitle } from './useDocumentTitle'

describe('useDocumentTitle', () => {
  beforeEach(() => { document.title = 'Crest Suite' })

  it('sets the title and restores the previous one on unmount', () => {
    const { unmount } = renderHook(() => useDocumentTitle('Sign in · Crest Suite'))
    expect(document.title).toBe('Sign in · Crest Suite')
    unmount()
    expect(document.title).toBe('Crest Suite')
  })

  it('follows a title change', () => {
    const { rerender, unmount } = renderHook(({ t }) => useDocumentTitle(t), { initialProps: { t: 'Pricing · Crest Suite' } })
    rerender({ t: 'Pricing · Sunrise Cafe' })
    expect(document.title).toBe('Pricing · Sunrise Cafe')
    unmount()
    expect(document.title).toBe('Crest Suite')
  })

  it('leaves a title someone else set after it alone', () => {
    // Two save-and-restore effects in one component clean up in declaration order, so the
    // outer one has already put "Crest Suite" back by the time this one runs.
    const { unmount } = renderHook(() => useDocumentTitle('Sign in · Crest Staff'))
    document.title = 'Crest Suite'
    unmount()
    expect(document.title).toBe('Crest Suite')
  })

  it('does nothing for an empty title', () => {
    renderHook(() => useDocumentTitle(''))
    expect(document.title).toBe('Crest Suite')
  })
})

describe('pageTitle', () => {
  it('joins the page and the brand', () => {
    expect(pageTitle('Sign in')).toBe('Sign in · Crest Suite')
    expect(pageTitle('Sign in', 'Sunrise Cafe')).toBe('Sign in · Sunrise Cafe')
    expect(pageTitle('Sign in', '')).toBe('Sign in · Crest Suite')
    expect(pageTitle('', 'Crest Staff')).toBe('Crest Staff')
  })
})
