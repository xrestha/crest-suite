// The page's primary "+ Add X" (S797). The page places it in its header's action group, last (or,
// on a tab with no header of its own, at the right of the tab's toolbar): on a computer or tablet it
// is an ordinary primary button there, and under 768px CSS alone turns the same element into the
// floating bottom-right button a thumb reaches (`.fab` in Layout.css). It used to float everywhere,
// fixed bottom-right with no space reserved, so on a desktop it sat on the Edit/Del buttons of
// whichever row was scrolled behind it. Pass `show` to gate it on the active tab/view and on
// lock/permission state; the page's header is shared across views, so `show` must carry every
// condition the old placement's enclosing branches carried.
export default function Fab({ onClick, label = '+ Add', show = true, title, disabled = false }) {
  if (!show) return null
  return (
    <button
      type="button"
      className="btn btn-primary fab no-print"
      onClick={onClick}
      disabled={disabled}
      title={title || label}
    >
      {label}
    </button>
  )
}
