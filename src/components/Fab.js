// Floating action button — fixed bottom-right, always reachable regardless of scroll.
// Used as the single "+ Add X" create affordance on list pages. Pass `show` to gate
// it on the active tab/view and lock/permission state.
export default function Fab({ onClick, label = '+ Add', show = true, title, disabled = false }) {
  if (!show) return null
  return (
    <button
      className="btn btn-primary no-print"
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      style={{
        position: 'fixed', right: 28, bottom: 28, zIndex: 50,
        padding: '12px 20px', fontSize: 14, fontWeight: 600,
        borderRadius: 0, boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
      }}
    >
      {label}
    </button>
  )
}
