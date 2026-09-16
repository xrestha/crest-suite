// What the public guest menu says when submit_guest_order refuses an order (S754).
//
// Page-local rather than in shared/errorText.js, for GuestBooking.jsx's reason (refusalCopy): the
// reader is an anonymous diner on their own phone, the copy names the outlet, and codes like
// `empty` or `inactive` mean something only on this page. The server raises a stable code in HINT
// (migration 20260916110000, §8), which supabase-js keeps as `error.hint`. The raw `message` is
// NEVER shown here — it is a Postgres string on an unauthenticated surface.
//
// Every one of these refusals is raised inside the function before its INSERT, so each may say
// the order was not sent. A dropped connection is not one of them: it proves nothing about whether
// the request landed, so it says so. Resending is still safe — a table holds one waiting request
// (the unique index behind `pending`), so a resend of an order that did land is refused, not doubled.

// `timed out` is withTimeout's own wording (S767): the page bounds the submit at 20 s, and a request
// that outran it is exactly as unknown as one whose connection dropped.
const NETWORK_RE = /failed to fetch|networkerror|load failed|network request failed|timed out/i

// "Momo", "Momo and Thukpa", "Momo, Thukpa and Sel Roti".
export function joinNames(names) {
  const list = (names || []).filter(Boolean)
  if (list.length <= 1) return list[0] || ''
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
}

// `details` is a JSON array string of dish names for unavailable_items, e.g. '["Chicken Momo","Thukpa"]'.
// A dish that no longer exists at all arrives as "An item". A malformed detail yields [].
export function unavailableNames(err) {
  try {
    const parsed = JSON.parse(err?.details || '[]')
    return Array.isArray(parsed) ? parsed.filter(n => typeof n === 'string' && n.trim()) : []
  } catch {
    return []
  }
}

/**
 * → { text, refreshMenu }. `refreshMenu` is true when the menu the guest is looking at is out of
 * date, so the page should re-read it.
 */
export function guestOrderRefusal(err, outletName, { online = true } = {}) {
  const who = outletName || 'the restaurant'
  const hint = err?.hint || ''

  switch (hint) {
    case 'unavailable_items': {
      const names = unavailableNames(err)
      const real = names.filter(n => n !== 'An item')
      const subject = real.length === 0
        ? 'Something in your order'
        : joinNames(real) + (names.length > real.length ? ' and another item' : '')
      const plural = real.length > 1 || (real.length === 1 && names.length > 1)
      return {
        text: `${subject} ${plural ? 'are' : 'is'} no longer available, so your order was not sent — remove ${plural ? 'them' : 'it'} and send again.`,
        // For when the page has re-read the menu and taken the dishes off the order itself.
        removedText: `${subject} ${plural ? 'are' : 'is'} no longer available, so your order was not sent. ${plural ? 'They have' : 'It has'} been taken off your order — check it and send again.`,
        refreshMenu: true,
      }
    }
    // S758: a dish's choices (size, extras) are no longer offered, or a dish that needs a choice
    // arrived without one — usually a menu opened before the owner changed its options.
    case 'unavailable_options': {
      const names = unavailableNames(err)
      const subject = names.length ? joinNames(names) : 'a dish in your order'
      const plural = names.length > 1
      return {
        text: `The choices for ${subject} have changed, so your order was not sent — open ${plural ? 'them' : 'it'} from your order, choose again and send.`,
        removedText: `The choices for ${subject} have changed, so your order was not sent. ${plural ? 'They have' : 'It has'} been taken off your order — add ${plural ? 'them' : 'it'} again with the new choices and send.`,
        refreshMenu: true,
      }
    }
    case 'not_accepting':
      return { text: `${who} isn't taking orders from this menu right now, so your order was not sent. Please ask a staff member to take it.`, refreshMenu: true }
    case 'inactive':
      return { text: "This table isn't taking orders right now, so your order was not sent. Please ask a staff member to take it.", refreshMenu: true }
    case 'table_not_found':
      return { text: "This table's QR code isn't recognised any more, so your order was not sent. Please ask a staff member to take it.", refreshMenu: false }
    case 'empty':
    case 'no_valid_items':
      return { text: 'Your order is empty — add something from the menu, then send it.', refreshMenu: false }
    case 'too_many_items':
      return { text: 'That order has more than 30 different dishes, so it was not sent. Send part of it now and the rest as a second order.', refreshMenu: false }
    case 'pending':
      return { text: `This table already has an order waiting for ${who} to accept, so this one was not sent. Please wait for that one first.`, refreshMenu: false }
    default:
      break
  }

  // Held to the guest menu's copy rule (S767, PRODUCT.md): two short sentences, no subclause —
  // most guests read English as a second or third language, and this is read mid-panic. Sending
  // again stays safe without saying so: while the first order waits, a second is refused as
  // `pending` above rather than doubled.
  if (!online || NETWORK_RE.test(err?.message || '')) {
    return {
      text: "The connection dropped, so we can't tell if your order was sent. Try again, or ask a member of staff.",
      refreshMenu: false,
    }
  }
  return { text: "We couldn't send that order. Try again, or ask a member of staff.", refreshMenu: false }
}
