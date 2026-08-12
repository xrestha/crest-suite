import { useState, useCallback } from 'react'

// Caps Lock is the single most common cause of a "wrong password" that isn't one, and the browser
// gives no indication it's on. There's no event for the key's *state* — only `getModifierState`
// on a real keyboard event — so this can only ever report what was true as of the last keystroke
// in the field. That's fine: the warning exists to be visible while someone types a password, and
// it clears on blur so a stale hint never outlives the field it belongs to.
//
// Returns [capsOn, handlers] — spread `handlers` onto the password <input>.
export function useCapsLock() {
  const [capsOn, setCapsOn] = useState(false)

  const read = useCallback(e => {
    // getModifierState is absent on synthetic/older events; treat "can't tell" as "don't warn"
    // rather than guessing, since a false positive here reads as the app being broken.
    if (typeof e.getModifierState !== 'function') return
    setCapsOn(e.getModifierState('CapsLock'))
  }, [])

  const handlers = {
    onKeyDown: read,
    onKeyUp: read,
    onBlur: () => setCapsOn(false),
  }

  return [capsOn, handlers]
}
