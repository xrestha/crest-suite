import { useEffect } from 'react'
import { PRESETS } from '../../../context/ThemeContext'

// ── The document identity of a public guest page (S767) ──────────────────────────────────────────
// index.html belongs to Crest Suite: its title, its manifest (start_url /dashboard, so "Add to Home
// Screen" from a guest page installed a login page) and its home-screen title and icon. On the guest
// QR menu and the public booking page they belong to the restaurant. Chrome's install flow and iOS's
// Add to Home Screen both read the live DOM when the guest acts, so the swap happens at runtime and
// is undone on unmount — an admin previewing a guest page in a frame must not leave the admin tab
// renamed (the useStaffAppManifest shape, src/modules/hr/selfservice/useStaffApp.js).
//
// The manifest is REMOVED rather than replaced: there is no per-restaurant app to install, and with
// none, "Add to Home Screen" saves a plain shortcut to this page, which is the useful thing.

function setHeadTag(selector, attr, value) {
  const el = document.head.querySelector(selector)
  if (!el) return null
  const previous = el.getAttribute(attr)
  el.setAttribute(attr, value)
  return () => el.setAttribute(attr, previous)
}

function detachHeadTag(selector) {
  const el = document.head.querySelector(selector)
  if (!el) return null
  const parent = el.parentNode
  const next = el.nextSibling
  el.remove()
  return () => { if (!el.isConnected) parent.insertBefore(el, next) }
}

/**
 * @param {string} title     the tab title
 * @param {string} shortName what a saved home-screen shortcut is called (the restaurant)
 * @param {string} logoUrl   the restaurant's logo, used as the home-screen icon when set
 */
export function useGuestDocumentIdentity(title, shortName, logoUrl) {
  useEffect(() => {
    const previousTitle = document.title
    document.title = title
    const restores = [
      setHeadTag('meta[name="theme-color"]', 'content', PRESETS.dark.bg),
      setHeadTag('meta[name="apple-mobile-web-app-title"]', 'content', shortName || title),
      detachHeadTag('link[rel="manifest"]'),
      logoUrl ? setHeadTag('link[rel="apple-touch-icon"]', 'href', logoUrl) : detachHeadTag('link[rel="apple-touch-icon"]'),
    ].filter(Boolean)
    return () => {
      document.title = previousTitle
      restores.reverse().forEach(fn => fn())
    }
  }, [title, shortName, logoUrl])
}
