// S818 RESERVATIONS-10 (D25): a booking handed over from Reservations' Seat onto a table that cannot
// take it is dropped, never kept for the next table tapped. The floor's sentence is then the only
// record of it, so it must name the table, the party and the way back.
import { seatRefusedText } from './posOrdersConstants'

test('names the table, the party with its size, and Reservations', () => {
  expect(seatRefusedText('Table 5', { customer_name: 'Sharma', party_size: 4 }, 'already has an open order'))
    .toBe('Table 5 already has an open order, so Sharma ×4 was not seated. Seat them again from Reservations.')
  expect(seatRefusedText('Terrace 2', { customer_name: 'Gurung', party_size: 8 }, 'is out of service'))
    .toBe('Terrace 2 is out of service, so Gurung ×8 was not seated. Seat them again from Reservations.')
})

test('a hand-off missing its name or size still reads as a sentence', () => {
  expect(seatRefusedText('Table 1', null, 'is out of service'))
    .toBe('Table 1 is out of service, so the booking was not seated. Seat them again from Reservations.')
  expect(seatRefusedText('Table 1', { customer_name: 'Rai' }, 'is out of service'))
    .toBe('Table 1 is out of service, so Rai was not seated. Seat them again from Reservations.')
})
