/**
 * A guest-menu logo save whose answer never arrived is read back, never assumed to have failed
 * (S814, GUEST-8).
 */

import { logoSaveOutcome } from './guestLogoSave'

const OLD = 'https://x.supabase.co/storage/v1/object/public/dish-photos/c1/guest-menu-logo-1.png?v=1'
const NEW = 'https://x.supabase.co/storage/v1/object/public/dish-photos/c1/guest-menu-logo-2.png?v=2'
const OTHER = 'https://x.supabase.co/storage/v1/object/public/dish-photos/c1/guest-menu-logo-3.png?v=3'

describe('an upload', () => {
  test('the stored logo is the new one: it landed, slowly', () => {
    expect(logoSaveOutcome({ wanted: NEW, before: OLD, stored: NEW })).toBe('landed')
  })
  test('the stored logo is still the old one: it may still go through', () => {
    expect(logoSaveOutcome({ wanted: NEW, before: OLD, stored: OLD })).toBe('pending')
  })
  test('the first logo, with nothing stored yet: still pending', () => {
    expect(logoSaveOutcome({ wanted: NEW, before: '', stored: null })).toBe('pending')
  })
  test('the read-back failed too: unknown', () => {
    expect(logoSaveOutcome({ wanted: NEW, before: OLD, stored: undefined })).toBe('unknown')
  })
  test('a third logo is stored: another device saved one', () => {
    expect(logoSaveOutcome({ wanted: NEW, before: OLD, stored: OTHER })).toBe('elsewhere')
  })
})

describe('a remove', () => {
  test('nothing stored: it landed', () => {
    expect(logoSaveOutcome({ wanted: null, before: OLD, stored: null })).toBe('landed')
    expect(logoSaveOutcome({ wanted: null, before: OLD, stored: '' })).toBe('landed')
  })
  test('the logo is still stored: the removal may still go through', () => {
    expect(logoSaveOutcome({ wanted: null, before: OLD, stored: OLD })).toBe('pending')
  })
  test('another logo is stored: saved from another device', () => {
    expect(logoSaveOutcome({ wanted: null, before: OLD, stored: OTHER })).toBe('elsewhere')
  })
})
