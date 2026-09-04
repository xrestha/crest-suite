import { fillTemplate, waLink, telLink } from './whatsappLink'

test('fillTemplate substitutes known placeholders and blanks unknown ones', () => {
  const out = fillTemplate('Hi {name}, {party} at {outlet} on {date} {time}. {nope}', {
    name: 'Ramesh', party: 4, outlet: 'Bhatti Choila', date: '19th Bhadra', time: '7:30 PM',
  })
  expect(out).toBe('Hi Ramesh, 4 at Bhatti Choila on 19th Bhadra 7:30 PM. ')
  expect(fillTemplate(null, {})).toBe('')
  expect(fillTemplate('{name}', null)).toBe('')
})

test('waLink prefixes 977 to a canonical Nepali mobile and URL-encodes the text', () => {
  expect(waLink('9841234567', 'See you at 7:30 PM & bring cake'))
    .toBe('https://wa.me/9779841234567?text=See%20you%20at%207%3A30%20PM%20%26%20bring%20cake')
  // Typed with the country code, with dashes, with a leading zero — one link.
  expect(waLink('+977-984-1234567')).toBe('https://wa.me/9779841234567')
  expect(waLink('09841234567')).toBe('https://wa.me/9779841234567')
})

test('waLink without a usable number falls back to the generic share form', () => {
  expect(waLink('', 'hello')).toBe('https://wa.me/?text=hello')
  expect(waLink('12', 'hello')).toBe('https://wa.me/?text=hello')
})

test('telLink dials in international form', () => {
  expect(telLink('9841234567')).toBe('tel:+9779841234567')
  expect(telLink('977 98 4123 4567')).toBe('tel:+9779841234567')
})
