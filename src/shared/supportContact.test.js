import { COMPANY } from '../legal'
import { SUPPORT_EMAIL, supportPhone, supportPhoneMissing, supportTelHref, supportWhatsappHref, whatsappHrefFor } from './supportContact'

test('SUPPORT_EMAIL is the one legal support address, not a second copy', () => {
  expect(SUPPORT_EMAIL).toBe(COMPANY.supportEmail)
})

test('the phone stays hidden while the [[NEEDS VALUE]] marker stands', () => {
  expect(supportPhoneMissing()).toBe(true)
  expect(supportPhone()).toBeNull()
  expect(supportTelHref()).toBeNull()
  expect(supportWhatsappHref()).toBeNull()
})

test('once a number is supplied, whatsappHrefFor builds a wa.me link off it', () => {
  // Exercises the real logic against a value that does not depend on SUPPORT_PHONE_RAW ever being
  // filled in — supportContact.js's own comment explains why the phone ships unset.
  expect(whatsappHrefFor('9812345678')).toBe('https://wa.me/9779812345678')
  expect(whatsappHrefFor('09812345678')).toBe('https://wa.me/9779812345678')
  expect(whatsappHrefFor('')).toBeNull()
})
