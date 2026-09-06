import { COMPANY } from '../legal'
import {
  SUPPORT_EMAIL, SUPPORT_HOURS, DEFAULT_SUPPORT_CONTACT,
  supportPhone, supportPhoneMissing, supportTelHref, supportWhatsappHref,
  whatsappHrefFor, viberHrefFor, telHrefFor, resolveSupportContact, platformSupportFromRow,
} from './supportContact'

test('SUPPORT_EMAIL is the one legal support address, not a second copy', () => {
  expect(SUPPORT_EMAIL).toBe(COMPANY.supportEmail)
})

test('the floor phone is filled, and both hrefs derive from the one string', () => {
  // Filled S683 with a Nepal mobile. If this ever goes back to a [[NEEDS VALUE]] marker the three
  // expectations below flip to null together — supportContact.js's guard, not the consumers, is
  // what hides the phone — so a regression to "unfilled" fails here rather than shipping silently.
  expect(supportPhoneMissing()).toBe(false)
  expect(supportPhone()).toBe('+977 971 459 8771')
  expect(supportTelHref()).toBe('tel:+9779714598771')                 // spaces stripped, + kept
  expect(supportWhatsappHref()).toBe('https://wa.me/9779714598771')   // 977 not doubled by normalizePhone
})

test('chat links normalise the same way whichever way the number was typed', () => {
  expect(whatsappHrefFor('9812345678')).toBe('https://wa.me/9779812345678')
  expect(whatsappHrefFor('09812345678')).toBe('https://wa.me/9779812345678')
  expect(whatsappHrefFor('+977-981-234-5678')).toBe('https://wa.me/9779812345678')
  expect(whatsappHrefFor('')).toBeNull()
  // Viber: country code, no +, no leading zero, no spaces — the deep-link spec.
  expect(viberHrefFor('+977 981 234 5678')).toBe('viber://chat?number=9779812345678')
  expect(viberHrefFor('')).toBeNull()
  // A Kathmandu landline keeps its trunk-less international form on tel: and gets no chat link.
  expect(telHrefFor('+977 1 4123456')).toBe('tel:+97714123456')
  expect(telHrefFor('01-4123456')).toBe('tel:014123456')
})

describe('resolveSupportContact — the one merge', () => {
  const platform = {
    mobile: '+977 980 111 2222', landline: '+977 1 4123456',
    whatsapp: '', viber: '+977 980 333 4444',
    email: 'help@crest.example', website: 'crest.example',
    hours: 'Sun–Fri 10:00–17:00', emergency_enabled: true, emergency_channel: 'mobile',
  }

  test('with nothing stored, the constants are the floor', () => {
    const r = resolveSupportContact({ platform: null, client: null })
    expect(r.phone).toBe('+977 971 459 8771')
    expect(r.landline).toBe('')
    expect(r.email).toBe(SUPPORT_EMAIL)
    expect(r.hours).toBe(SUPPORT_HOURS)
    // The S673 promise is kept by default, not silently withdrawn, and it names the number.
    expect(r.emergency).toEqual({ channel: 'mobile', label: 'Mobile', value: '+977 971 459 8771' })
    expect(r.whatsappHref).toBe('https://wa.me/9779714598771')
    expect(r.viberHref).toBe('viber://chat?number=9779714598771')
  })

  test('the platform row wins over the constants, field by field', () => {
    const r = resolveSupportContact({ platform, client: null })
    expect(r.phone).toBe('+977 980 111 2222')          // mobile is the primary call number
    expect(r.landline).toBe('+977 1 4123456')
    expect(r.landlineHref).toBe('tel:+97714123456')
    expect(r.whatsapp).toBe('+977 980 111 2222')       // blank → falls back to mobile, never landline
    expect(r.viber).toBe('+977 980 333 4444')          // its own slot when filled
    expect(r.email).toBe('help@crest.example')
    expect(r.hours).toBe('Sun–Fri 10:00–17:00')
  })

  test('a landline-only platform still has a call number and no chat links', () => {
    const r = resolveSupportContact({ platform: { ...platform, mobile: '', viber: '' }, client: null })
    // No mobile stored → the constant floor supplies one; a real landline-only business would
    // clear the constant too, so assert the landline path on its own as well.
    expect(r.phone).toBe('+977 971 459 8771')
    const bare = resolveSupportContact({ platform: { ...DEFAULT_SUPPORT_CONTACT, landline: '01-4123456', emergency_enabled: false } })
    expect(bare.landline).toBe('01-4123456')
    expect(bare.landlineHref).toBe('tel:014123456')
  })

  test('the emergency promise renders only while switched on, and names the chosen channel', () => {
    expect(resolveSupportContact({ platform: { ...platform, emergency_enabled: false } }).emergency).toBeNull()
    const viber = resolveSupportContact({ platform: { ...platform, emergency_channel: 'viber' } }).emergency
    expect(viber).toEqual({ channel: 'viber', label: 'Viber', value: '+977 980 333 4444' })
    // A channel with no number behind it makes no promise.
    expect(resolveSupportContact({ platform: { ...platform, emergency_channel: 'whatsapp', whatsapp: '', mobile: '' } }).emergency)
      .toEqual({ channel: 'whatsapp', label: 'WhatsApp', value: '+977 971 459 8771' }) // floor mobile feeds whatsapp
    expect(resolveSupportContact({ platform: { ...DEFAULT_SUPPORT_CONTACT, landline: '', emergency_channel: 'landline' } }).emergency).toBeNull()
  })

  test("a client's consultant replaces the whole phone family, and only what it sets", () => {
    const client = { contact_phone: '9801 234 567', contact_email: '' }
    const r = resolveSupportContact({ platform, client })
    expect(r.phone).toBe('9801 234 567')
    expect(r.landline).toBe('')                        // the consultant IS the contact — no office line beside them
    expect(r.whatsappHref).toBe('https://wa.me/9779801234567')
    expect(r.viberHref).toBe('viber://chat?number=9779801234567')
    expect(r.email).toBe('help@crest.example')         // blank consultant email → platform email, not the constant
    expect(r.hours).toBe('Sun–Fri 10:00–17:00')        // hours are Crest's, a consultant does not set them
  })

  test("the platform row's legacy contact_* seed the platform contact, and lose to a saved support_contact", () => {
    // What /login showed on 2026-09-06: the NULL row's old Contact-tab values, wearing a client's column names.
    const legacyRow = { client_id: null, contact_phone: '9803727572', contact_email: 'xrestha@gmail.com', contact_website: '', support_contact: null }
    const seeded = platformSupportFromRow(legacyRow)
    expect(seeded).toEqual({ ...DEFAULT_SUPPORT_CONTACT, mobile: '9803727572', email: 'xrestha@gmail.com', website: '' })
    expect(resolveSupportContact({ platform: seeded, client: null }).phone).toBe('9803727572')
    // Once the Support tab has been saved, the legacy columns are ignored entirely.
    const saved = platformSupportFromRow({ ...legacyRow, support_contact: { ...DEFAULT_SUPPORT_CONTACT, mobile: '+977 971 459 8771' } })
    expect(resolveSupportContact({ platform: saved, client: null }).phone).toBe('+977 971 459 8771')
    // A row with nothing in either place seeds nothing, so the constants stay the floor.
    expect(platformSupportFromRow({ client_id: null, contact_phone: '', contact_email: null })).toBeNull()
    expect(platformSupportFromRow(null)).toBeNull()
  })

  test('AnyDesk is Crest\'s remote-help address: platform only, untouched by a consultant, blank by default', () => {
    expect(resolveSupportContact({ platform: null, client: null }).anydesk).toBe('')
    const r = resolveSupportContact({ platform: { ...platform, anydesk: ' crest@ad ' }, client: { contact_phone: '9801234567' } })
    expect(r.anydesk).toBe('crest@ad')
  })
})

test("'no phone line' drops the whole phone family, the floor included, and the promise with it (S684)", () => {
  const r = resolveSupportContact({ platform: { phone_enabled: false }, client: null })
  expect(r.phone).toBe('')
  expect(r.telHref).toBeNull()
  expect(r.whatsappHref).toBeNull()
  expect(r.viberHref).toBeNull()
  expect(r.emergency).toBeNull()          // no number, so no "answered any time" sentence
  expect(r.email).toBe(SUPPORT_EMAIL)     // email always floors
  // A chat number given explicitly is still a channel the business answers.
  const r2 = resolveSupportContact({
    platform: { phone_enabled: false, whatsapp: '+977 980 555 6666', emergency_enabled: true, emergency_channel: 'whatsapp' },
    client: null,
  })
  expect(r2.phone).toBe('')
  expect(r2.whatsappHref).toBe('https://wa.me/9779805556666')
  expect(r2.emergency).toEqual({ channel: 'whatsapp', label: 'WhatsApp', value: '+977 980 555 6666' })
  // A consultant still routes that one client to a person.
  const r3 = resolveSupportContact({ platform: { phone_enabled: false }, client: { contact_phone: '9812345678' } })
  expect(r3.phone).toBe('9812345678')
  expect(r3.telHref).toBe('tel:9812345678')
  // The default is on, so a row saved before the switch existed keeps publishing its number.
  expect(DEFAULT_SUPPORT_CONTACT.phone_enabled).toBe(true)
  expect(resolveSupportContact({ platform: { mobile: '+977 980 111 2222' }, client: null }).phone).toBe('+977 980 111 2222')
})
