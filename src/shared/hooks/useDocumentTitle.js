import { useEffect } from 'react'

// The tab, the bookmark and the history entry (WCAG 2.4.2, Level A). index.html's <title> is a
// static "Crest Suite", so before S852 every signed-out route (sign in, the trial form, reset,
// pricing, the PIN pads) read identically in the tab strip and a screen reader announced nothing
// on arrival. Legal.jsx and the guest pages already set their own; this is the same
// save-and-restore shape, in one place.
//
// The restore is GUARDED: it puts the previous title back only while the tab still shows the one
// this hook set. Two titles in one component restore in declaration order, not in reverse
// (SelfServiceLogin sets "Crest Staff" through useStaffAppManifest, then its own), and
// printWithTitle swaps the title for a print job; an unguarded restore would leave whichever
// stale title happened to run last.
export function useDocumentTitle(title) {
  useEffect(() => {
    if (!title) return undefined
    const previous = document.title
    document.title = title
    return () => {
      if (document.title === title) document.title = previous
    }
  }, [title])
}

// "Sign in · Crest Suite". The brand is the page's own wordmark (a white-labelled client's
// app_name on the sign-in pages), so the tab names the same brand the header does.
export function pageTitle(page, brand = 'Crest Suite') {
  return page ? `${page} · ${brand || 'Crest Suite'}` : (brand || 'Crest Suite')
}
