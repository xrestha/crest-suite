import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import DishPhotoField from './DishPhotoField'
import { supabase } from '../../../supabaseClient'
import { downscalePhoto } from './dishPhoto'

// Nothing in this file reaches real storage: the client is a mock, and downscaling is stubbed to a
// pass-through so the upload path is exercised without a canvas. (jest.mock is hoisted above the
// imports, so the mocks are in place before DishPhotoField loads.)
const mockUpload = jest.fn()
const mockRemove = jest.fn()
const mockGetPublicUrl = jest.fn()
jest.mock('../../../supabaseClient', () => ({ supabase: { storage: { from: jest.fn() } } }))
jest.mock('./dishPhoto', () => ({ ...jest.requireActual('./dishPhoto'), downscalePhoto: jest.fn() }))

const BASE = 'https://abcd.supabase.co'
const OLD = `${BASE}/storage/v1/object/public/dish-photos/client-1/rec-1-100.jpg?v=100`

function Harness({ initial = '', persist = null, recipeId = 'rec-1', onValue }) {
  const [v, setV] = useState(initial)
  return (
    <DishPhotoField
      id="photo" clientId="client-1" recipeId={recipeId} value={v}
      onChange={x => { setV(x); onValue?.(x) }} persist={persist} supabaseUrl={BASE}
    />
  )
}

// The hidden file input is what the visible field label names.
const pick = f => fireEvent.change(screen.getByLabelText('Photo (guest menu)'), { target: { files: [f] } })
const jpg = (size = 1000) => new File([new Uint8Array(size)], 'dish.jpg', { type: 'image/jpeg' })
const confirmRemove = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }))
}

beforeEach(() => {
  // CRA's jest config resets every mock before each test, factory mocks included, so every
  // implementation is (re)applied here rather than in the factories.
  supabase.storage.from.mockImplementation(() => ({ upload: mockUpload, remove: mockRemove, getPublicUrl: mockGetPublicUrl }))
  downscalePhoto.mockImplementation(async f => f)
  mockGetPublicUrl.mockImplementation(p => ({ data: { publicUrl: `${BASE}/storage/v1/object/public/dish-photos/${p}` } }))
  mockUpload.mockResolvedValue({ data: { path: 'x' }, error: null })
  mockRemove.mockResolvedValue({ data: [], error: null })
  jest.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { console.error.mockRestore() })

it('uploads into the client folder with a plain insert, saves the row, then deletes the old file', async () => {
  const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  pick(jpg())

  await waitFor(() => expect(mockRemove).toHaveBeenCalled())
  expect(supabase.storage.from).toHaveBeenCalledWith('dish-photos')
  const [path, , opts] = mockUpload.mock.calls[0]
  expect(path).toMatch(/^client-1\/rec-1-\d+\.jpg$/)
  expect(opts).toMatchObject({ upsert: false, contentType: 'image/jpeg' })
  const saved = persist.mock.calls[0][0]
  expect(saved).toMatch(new RegExp(`^${BASE}/storage/v1/object/public/dish-photos/client-1/rec-1-\\d+\\.jpg\\?v=\\d+$`))
  expect(onValue).toHaveBeenCalledWith(saved)
  // The old file goes only after the row has accepted the new URL.
  expect(mockRemove).toHaveBeenCalledWith(['client-1/rec-1-100.jpg'])
  expect(persist.mock.invocationCallOrder[0]).toBeLessThan(mockRemove.mock.invocationCallOrder[0])
})

it('a failed upload shows an error and leaves the existing photo untouched', async () => {
  mockUpload.mockResolvedValue({ data: null, error: { statusCode: '403', message: 'new row violates row-level security policy' } })
  const persist = jest.fn()
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  pick(jpg())

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/The photo was not uploaded\. Your login is not allowed/))
  expect(screen.getByRole('alert')).toHaveTextContent(/row-level security/)   // detail kept
  expect(persist).not.toHaveBeenCalled()
  expect(onValue).not.toHaveBeenCalled()
  expect(mockRemove).not.toHaveBeenCalled()
  expect(screen.getByAltText('The dish as guests see it')).toHaveAttribute('src', OLD)
})

it('a refused row write removes the NEW file and keeps the old photo', async () => {
  const persist = jest.fn(async () => ({ data: [], error: null }))   // RLS: 0 rows, no error
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  pick(jpg())

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/still shows the previous photo/))
  expect(onValue).not.toHaveBeenCalled()
  expect(mockRemove).toHaveBeenCalledTimes(1)
  expect(mockRemove.mock.calls[0][0][0]).toMatch(/^client-1\/rec-1-\d+\.jpg$/)
  expect(mockRemove.mock.calls[0][0][0]).not.toBe('client-1/rec-1-100.jpg')
})

it('refuses a file over 2 MB before uploading', async () => {
  render(<Harness />)
  pick(jpg(2 * 1024 * 1024 + 1))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/limit is 2 MB/))
  expect(mockUpload).not.toHaveBeenCalled()
})

it('refuses a non-image type before uploading', async () => {
  render(<Harness />)
  pick(new File(['x'], 'menu.pdf', { type: 'application/pdf' }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/not a JPG, PNG or WebP/))
  expect(mockUpload).not.toHaveBeenCalled()
})

it('an unsaved recipe keeps the URL in the form only', async () => {
  const onValue = jest.fn()
  render(<Harness recipeId={null} onValue={onValue} />)
  pick(jpg())
  await waitFor(() => expect(onValue).toHaveBeenCalledWith(expect.stringMatching(/dish-photos\/client-1\/new-/)))
  expect(mockUpload.mock.calls[0][0]).toMatch(/^client-1\/new-\d+\.jpg$/)
  expect(screen.queryByText(/saves straight away/)).toBeNull()
})

it('Remove clears the row and the form, then deletes the stored file', async () => {
  const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  confirmRemove()

  await waitFor(() => expect(mockRemove).toHaveBeenCalledWith(['client-1/rec-1-100.jpg']))
  expect(persist).toHaveBeenCalledWith(null)
  expect(onValue).toHaveBeenCalledWith('')
})

it('Remove whose row write fails keeps the photo and deletes nothing', async () => {
  const persist = jest.fn(async () => ({ data: null, error: { code: '42501', message: 'recipes: changing a recipe needs an IMS supervisor' } }))
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  confirmRemove()

  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/still on the recipe/))
  expect(onValue).not.toHaveBeenCalled()
  expect(mockRemove).not.toHaveBeenCalled()
})

it('never deletes a pasted link, and warns that guests will not see it', async () => {
  const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
  const onValue = jest.fn()
  render(<Harness initial="https://scontent.fbcdn.net/dish.jpg" persist={persist} onValue={onValue} />)

  expect(screen.getByText(/Guests will not see this photo/)).toBeInTheDocument()
  confirmRemove()
  await waitFor(() => expect(onValue).toHaveBeenCalledWith(''))
  expect(persist).toHaveBeenCalledWith(null)
  expect(mockRemove).not.toHaveBeenCalled()
})

it('shows no link warning for a photo stored in Crest', () => {
  render(<Harness initial={OLD} />)
  expect(screen.queryByText(/Guests will not see this photo/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Replace photo' })).toBeInTheDocument()
})
