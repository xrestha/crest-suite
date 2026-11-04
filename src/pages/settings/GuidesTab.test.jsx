/**
 * Admin Settings → Guides fetches one module's guide at a time (S878). The five files are ~780 KB of
 * source and the tab used to download all of them before the first one showed. Pinned here: the
 * chosen module is the one fetched, a failed fetch says so with a Try again (never an empty guide),
 * and no other source file imports a guide data file statically, which would put it back in the chunk.
 */
import fs from 'fs'
import path from 'path'
import { render, screen, fireEvent } from '@testing-library/react'

// Plain names that start with "mock", so the hoisted factories may read them.
let mockHrFailures = 0
const mockLoaded = []
jest.mock('./ModuleGuideTab', () => ({ docTitle, groups }) =>
  require('react').createElement('p', null, `${docTitle} (${groups.length} groups)`))
jest.mock('./imsGuideData', () => { mockLoaded.push('ims'); return { IMS_GUIDE_GROUPS: [{ id: 'a' }, { id: 'b' }] } })
jest.mock('./hrGuideData', () => {
  if (mockHrFailures > 0) { mockHrFailures -= 1; throw new Error('connection reset') }
  mockLoaded.push('hr')
  return { HR_GUIDE_GROUPS: [{ id: 'c' }] }
})
jest.mock('./posGuideData', () => { mockLoaded.push('pos'); return { POS_GUIDE_GROUPS: [] } })
jest.mock('./customizationGuideData', () => { mockLoaded.push('customization'); return { CUSTOMIZATION_GUIDE_GROUPS: [] } })
jest.mock('./suiteGuideData', () => { mockLoaded.push('suite'); return { SUITE_GUIDE_GROUPS: [] } })

// eslint-disable-next-line import/first
import GuidesTab from './GuidesTab'

it('opens on the IMS guide and fetches no other module', async () => {
  render(<GuidesTab />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading the Crest IMS guide')
  expect(await screen.findByText('Crest IMS — Module Guide (2 groups)')).toBeInTheDocument()
  expect(mockLoaded).toEqual(['ims'])
})

it('fetches a module when its tab is chosen, and a failed fetch offers Try again', async () => {
  mockHrFailures = 1
  const quiet = jest.spyOn(console, 'error').mockImplementation(() => {})
  render(<GuidesTab />)
  // Fetched once already, so it shows at once.
  expect(screen.getByText('Crest IMS — Module Guide (2 groups)')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Crest HR' }))
  const retry = await screen.findByRole('button', { name: 'Try again' })
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.queryByText(/Crest HR — Module Guide/)).toBeNull()
  fireEvent.click(retry)
  expect(await screen.findByText('Crest HR — Module Guide (1 groups)')).toBeInTheDocument()
  expect(mockLoaded).toEqual(['ims', 'hr'])
  quiet.mockRestore()
})

// A static import anywhere else would bundle that guide with its importer again.
it('no source file imports a guide data file statically', () => {
  const SRC = path.join(__dirname, '..', '..')
  const STATIC = /(?:^|\n)\s*(?:import|export)\s[^'"`;]*?from\s+['"][^'"]*(ims|hr|pos|suite|customization)GuideData['"]/
  const offenders = []
  const walk = dir => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else if (/\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name) && STATIC.test(fs.readFileSync(full, 'utf8'))) {
        offenders.push(path.relative(SRC, full))
      }
    }
  }
  walk(SRC)
  expect(offenders).toEqual([])
})
