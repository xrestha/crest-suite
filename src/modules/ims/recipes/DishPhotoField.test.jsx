import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useState } from 'react'
import DishPhotoField, { useUnsavedDishPhotos } from './DishPhotoField'
import { supabase } from '../../../supabaseClient'
import { downscalePhoto } from './dishPhoto'
import { fetchAllRows } from '../../../shared/fetchAllRows'

// Nothing in this file reaches real storage: the client is a mock, and downscaling is stubbed to a
// pass-through so the upload path is exercised without a canvas. (jest.mock is hoisted above the
// imports, so the mocks are in place before DishPhotoField loads.)
const mockUpload = jest.fn()
const mockRemove = jest.fn()
const mockGetPublicUrl = jest.fn()
const mockScopedFrom = jest.fn()
jest.mock('../../../supabaseClient', () => ({ supabase: { storage: { from: jest.fn() } } }))
jest.mock('./dishPhoto', () => ({ ...jest.requireActual('./dishPhoto'), downscalePhoto: jest.fn() }))
// S792 RECIPES-8: before an old file is deleted, every dish's link is read fresh — a stored photo
// another dish still shows is kept. `dishes` below is what that read returns.
jest.mock('../../../shared/hooks/useScopedDb', () => ({ useScopedDb: () => ({ scopedFrom: (...a) => mockScopedFrom(...a) }) }))
jest.mock('../../../shared/fetchAllRows', () => ({ fetchAllRows: jest.fn() }))

const BASE = 'https://abcd.supabase.co'
const OLD = `${BASE}/storage/v1/object/public/dish-photos/client-1/rec-1-100.jpg?v=100`
let dishes = []

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
  const chain = { not: () => chain, order: () => chain }
  mockScopedFrom.mockImplementation(() => chain)
  dishes = [{ id: 'rec-1', image_url: OLD }, { id: 'rec-2', image_url: null }]
  fetchAllRows.mockImplementation(async make => { make(); return { data: dishes, error: null } })
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
  // The old file goes only after the row has accepted the new URL, with its thumb beside it (S842).
  expect(mockRemove).toHaveBeenCalledWith(['client-1/rec-1-100.jpg', 'client-1/rec-1-100.thumb.jpg'])
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

// S855: a new recipe's photo is uploaded when it is picked, so a form closed without saving must
// take it back out of the bucket. The page (Recipes.js) holds the list in useUnsavedDishPhotos;
// this stands in for it: Cancel and Back release, a written row clears, leaving the page releases.
describe('photos a new recipe uploaded and never saved', () => {
  function NewRecipeForm({ onValue }) {
    const photos = useUnsavedDishPhotos('client-1', BASE)
    const [open, setOpen] = useState(true)
    const [v, setV] = useState('')
    return (
      <>
        {open && (
          <DishPhotoField
            id="photo" clientId="client-1" recipeId={null} value={v} supabaseUrl={BASE}
            onChange={x => { setV(x); onValue?.(x) }}
            onUploaded={photos.track} onReleased={photos.untrack}
          />
        )}
        <button type="button" onClick={() => { photos.release(null); setOpen(false) }}>Cancel</button>
        <button type="button" onClick={() => { photos.clear(); setOpen(false) }}>Save Recipe</button>
      </>
    )
  }
  const NEW_PATH = /^client-1\/new-\d+\.jpg$/
  const thumbOf = p => p.replace(/\.jpg$/, '.thumb.jpg')
  const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

  it('Cancel deletes the photo the form uploaded, with its thumb, after checking no dish uses it', async () => {
    const onValue = jest.fn()
    render(<NewRecipeForm onValue={onValue} />)
    pick(jpg())
    await waitFor(() => expect(onValue).toHaveBeenCalled())
    const path = mockUpload.mock.calls[0][0]
    expect(path).toMatch(NEW_PATH)
    expect(mockRemove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith([path, thumbOf(path)]))
    expect(mockScopedFrom).toHaveBeenCalledWith('recipes', 'id, image_url')
    expect(mockRemove).toHaveBeenCalledTimes(1)
  })

  it('leaving the page with the form open releases it too', async () => {
    const onValue = jest.fn()
    const { unmount } = render(<NewRecipeForm onValue={onValue} />)
    pick(jpg())
    await waitFor(() => expect(onValue).toHaveBeenCalled())
    const path = mockUpload.mock.calls[0][0]

    unmount()

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith([path, thumbOf(path)]))
  })

  it('a saved recipe keeps its photo: the written row clears the list', async () => {
    const onValue = jest.fn()
    const { unmount } = render(<NewRecipeForm onValue={onValue} />)
    pick(jpg())
    await waitFor(() => expect(onValue).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Save Recipe' }))
    unmount()
    await settle()

    expect(fetchAllRows).not.toHaveBeenCalled()
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('keeps the photo when a dish names it after all (a save that landed after it timed out)', async () => {
    const onValue = jest.fn()
    render(<NewRecipeForm onValue={onValue} />)
    pick(jpg())
    await waitFor(() => expect(onValue).toHaveBeenCalled())
    dishes = [...dishes, { id: 'rec-9', image_url: onValue.mock.calls[0][0] }]

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(fetchAllRows).toHaveBeenCalled())
    await settle()
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('keeps the photo, and says so in the console, when it cannot check which dishes use it', async () => {
    const onValue = jest.fn()
    render(<NewRecipeForm onValue={onValue} />)
    pick(jpg())
    await waitFor(() => expect(onValue).toHaveBeenCalled())
    fetchAllRows.mockImplementation(async () => ({ data: null, error: { message: 'Failed to fetch' } }))

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Dish photo kept/), 'Failed to fetch'))
    expect(mockRemove).not.toHaveBeenCalled()
    // Leaving never waits on the clean-up.
    expect(screen.queryByLabelText('Photo (guest menu)')).toBeNull()
  })

  it('Replace inside the form releases the first photo once, and Cancel only the second', async () => {
    let t = 1000
    jest.spyOn(Date, 'now').mockImplementation(() => (t += 1))
    try {
      const onValue = jest.fn()
      render(<NewRecipeForm onValue={onValue} />)
      pick(jpg())
      await waitFor(() => expect(onValue).toHaveBeenCalledTimes(1))
      const first = mockUpload.mock.calls[0][0]

      pick(jpg())
      await waitFor(() => expect(mockRemove).toHaveBeenCalledWith([first, thumbOf(first)]))
      const second = mockUpload.mock.calls[1][0]
      expect(second).not.toBe(first)

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(mockRemove).toHaveBeenCalledTimes(2))
      expect(mockRemove.mock.calls[1][0]).toEqual([second, thumbOf(second)])
    } finally {
      Date.now.mockRestore()
    }
  })

  it('a photo that lands after the form closed is deleted, not put in the form', async () => {
    let finish
    mockUpload.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const onValue = jest.fn()
    render(<NewRecipeForm onValue={onValue} />)
    pick(jpg())
    await waitFor(() => expect(mockUpload).toHaveBeenCalled())
    const path = mockUpload.mock.calls[0][0]

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await act(async () => { finish({ data: { path: 'x' }, error: null }) })

    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith([path]))
    expect(onValue).not.toHaveBeenCalled()
    // Nothing else can name a file that landed a moment ago, so there is nothing to check first.
    expect(fetchAllRows).not.toHaveBeenCalled()
  })

  it('a saved recipe never hands its photo to the list', async () => {
    const onUploaded = jest.fn()
    const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
    render(
      <DishPhotoField
        id="photo" clientId="client-1" recipeId="rec-1" value="" supabaseUrl={BASE}
        onChange={() => {}} persist={persist} onUploaded={onUploaded}
      />
    )
    pick(jpg())
    await waitFor(() => expect(persist).toHaveBeenCalled())
    expect(onUploaded).not.toHaveBeenCalled()
  })
})

it('Remove clears the row and the form, then deletes the stored file', async () => {
  const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  confirmRemove()

  await waitFor(() => expect(mockRemove).toHaveBeenCalledWith(['client-1/rec-1-100.jpg', 'client-1/rec-1-100.thumb.jpg']))
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

// S792 RECIPES-8: Veg Momo and Chicken Momo sharing one stored photo through a pasted link.
it('Replace keeps the old file when another dish still shows it', async () => {
  dishes = [{ id: 'rec-1', image_url: OLD }, { id: 'rec-2', image_url: OLD }]
  const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  pick(jpg())

  await waitFor(() => expect(onValue).toHaveBeenCalled())
  await waitFor(() => expect(fetchAllRows).toHaveBeenCalled())
  expect(mockScopedFrom).toHaveBeenCalledWith('recipes', 'id, image_url')
  expect(mockRemove).not.toHaveBeenCalled()
})

it('Remove on the dish that pasted the link leaves the other dish its photo', async () => {
  dishes = [{ id: 'rec-1', image_url: OLD }, { id: 'rec-2', image_url: OLD }]
  const persist = jest.fn(async () => ({ data: [{ id: 'rec-2' }], error: null }))
  const onValue = jest.fn()
  render(<Harness initial={OLD} recipeId="rec-2" persist={persist} onValue={onValue} />)

  confirmRemove()

  await waitFor(() => expect(onValue).toHaveBeenCalledWith(''))
  await waitFor(() => expect(fetchAllRows).toHaveBeenCalled())
  expect(persist).toHaveBeenCalledWith(null)
  expect(mockRemove).not.toHaveBeenCalled()
})

it('keeps the old file when it cannot check which dishes use it', async () => {
  fetchAllRows.mockImplementation(async () => ({ data: null, error: { message: 'Failed to fetch' } }))
  const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
  const onValue = jest.fn()
  render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

  confirmRemove()

  await waitFor(() => expect(onValue).toHaveBeenCalledWith(''))
  await waitFor(() => expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/Dish photo kept/), 'Failed to fetch'))
  expect(mockRemove).not.toHaveBeenCalled()
})

it('shows no link warning for a photo stored in Crest', () => {
  render(<Harness initial={OLD} />)
  expect(screen.queryByText(/Guests will not see this photo/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Replace photo' })).toBeInTheDocument()
})

// S842: a 256px copy beside each new photo, marked on the stored URL, for the guest menu's thumbnail.
describe('the thumbnail copy', () => {
  const small = () => new Blob([new Uint8Array(50)], { type: 'image/jpeg' })
  beforeEach(() => {
    downscalePhoto.mockImplementation(async (f, env) => (env?.maxSide ? small() : f))
  })

  it('uploads a thumb beside the photo and marks the stored URL', async () => {
    const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
    render(<Harness initial={OLD} persist={persist} />)

    pick(jpg())

    await waitFor(() => expect(persist).toHaveBeenCalled())
    expect(mockUpload).toHaveBeenCalledTimes(2)
    const [mainPath] = mockUpload.mock.calls[0]
    const [thumbPath, thumbFile, thumbOpts] = mockUpload.mock.calls[1]
    expect(thumbPath).toBe(mainPath.replace(/\.jpg$/, '.thumb.jpg'))
    expect(thumbFile.size).toBe(50)
    expect(thumbOpts).toMatchObject({ upsert: false, contentType: 'image/jpeg' })
    expect(downscalePhoto).toHaveBeenCalledWith(expect.anything(), { maxSide: 256 })
    expect(persist.mock.calls[0][0]).toMatch(/\.jpg\?v=\d+&thumb=1$/)
  })

  it('a thumb that fails to upload keeps the photo, with no mark', async () => {
    mockUpload
      .mockResolvedValueOnce({ data: { path: 'x' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { statusCode: '500', message: 'boom' } })
    const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
    const onValue = jest.fn()
    render(<Harness initial={OLD} persist={persist} onValue={onValue} />)

    pick(jpg())

    await waitFor(() => expect(onValue).toHaveBeenCalled())
    expect(persist.mock.calls[0][0]).toMatch(/\.jpg\?v=\d+$/)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a photo the browser could not shrink stores no thumb', async () => {
    downscalePhoto.mockImplementation(async f => f)
    const persist = jest.fn(async () => ({ data: [{ id: 'rec-1' }], error: null }))
    render(<Harness initial={OLD} persist={persist} />)

    pick(jpg())

    await waitFor(() => expect(persist).toHaveBeenCalled())
    expect(mockUpload).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0][0]).not.toMatch(/thumb=1/)
  })

  it('a refused row write removes the new photo and its thumb', async () => {
    const persist = jest.fn(async () => ({ data: [], error: null }))
    render(<Harness initial={OLD} persist={persist} />)

    pick(jpg())

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/still shows the previous photo/))
    expect(mockRemove).toHaveBeenCalledTimes(1)
    const [paths] = mockRemove.mock.calls[0]
    expect(paths).toHaveLength(2)
    expect(paths[1]).toBe(paths[0].replace(/\.jpg$/, '.thumb.jpg'))
    expect(paths).not.toContain('client-1/rec-1-100.jpg')
  })
})
