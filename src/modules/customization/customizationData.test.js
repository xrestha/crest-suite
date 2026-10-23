import { errorInfo } from '../../shared/errorText'
import { withTimeout } from '../../utils/withTimeout'
import { writeFailure, detachFailure, DIALOG_CHECK, PAGE_CHECK } from './customizationData'

jest.mock('../../supabaseClient', () => ({ supabase: {} }))

// S852: the Option Groups page and its dialogs bound every save with a time limit. A save that ran
// out of time may still land after the clock stopped, and repeating an insert that landed makes a
// second group or option, so the message says where to check and never that nothing was saved.

async function timedOut() {
  try {
    await withTimeout(new Promise(() => {}), 1, 'Saving the group')
  } catch (err) {
    return err
  }
  throw new Error('withTimeout did not time out')
}

describe('writeFailure', () => {
  it('says a timed-out save may have landed, and where to check', async () => {
    const err = await timedOut()
    const { text, detail } = writeFailure(err)
    expect(text).toMatch(/may have saved or may not/)
    expect(text).toContain(DIALOG_CHECK)
    expect(text).not.toMatch(/not saved|did not save|nothing was saved|was not changed/i)
    // The technical line survives as fine print.
    expect(detail).toBeTruthy()
  })

  it('takes the page-level wording when asked', async () => {
    const err = await timedOut()
    expect(writeFailure(err, PAGE_CHECK).text).toContain(PAGE_CHECK)
  })

  it('leaves every other failure to the shared error table', () => {
    const err = { code: '42501', message: 'new row violates row-level security policy' }
    expect(writeFailure(err)).toEqual(errorInfo(err, 'operator'))
  })
})

// S852: "Offer on…" removes a group from dishes in chunks, so a failure can land part-way. The
// message names which dishes are off and which still offer it, never a blanket failure.
describe('detachFailure', () => {
  const refused = { code: '42501', message: 'new row violates row-level security policy' }
  const retry = 'Saving again is safe.'

  it('names the dishes that are off and the ones that still offer the group', () => {
    const { text, detail } = detachFailure({
      groupName: 'Size', added: true, off: ['Momo', 'Chowmein'], still: ['Thukpa'], error: refused, retry,
    })
    expect(text).toMatch(/^The dishes you ticked now offer “Size”\. /)
    expect(text).toContain('It is off Momo and Chowmein, but Thukpa still offers it.')
    expect(text).toContain(errorInfo(refused, 'operator').text)
    expect(detail).toBe(errorInfo(refused, 'operator').detail)
  })

  it('says only what is still on when nothing came off, with no lead when nothing was added', () => {
    const { text } = detachFailure({
      groupName: 'Size', added: false, off: [], still: ['Thukpa', 'Pizza'], error: refused, retry,
    })
    expect(text).toMatch(/^Thukpa and Pizza still offer it\. /)
  })

  it('says a timed-out chunk may still offer it, and that a retry is safe', async () => {
    const err = await timedOut()
    const { text } = detachFailure({
      groupName: 'Size', added: false, off: ['Momo'], still: ['Thukpa', 'Pizza'], error: err, retry,
    })
    expect(text).toBe('It is off Momo, but the server took too long to answer about Thukpa and Pizza, so those dishes may still offer it. Saving again is safe.')
  })

  // S862 SETUP-10: every chunk answered, but fewer rows came off than were sent.
  it('says to reload when a delete touched fewer rows than it sent', () => {
    const { text, detail } = detachFailure({
      groupName: 'Size', added: true, off: ['Momo'], still: ['Thukpa'], error: null, retry,
    })
    expect(text).toBe('The dishes you ticked now offer “Size”. It is off Momo, but Thukpa may still offer it: that dish may have changed on another device. Reload the page to check before you save again.')
    expect(detail).toBeNull()
    expect(text).not.toMatch(/'/)
  })

  it('shortens a long list rather than printing a whole menu', () => {
    const still = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
    const { text } = detachFailure({ groupName: 'Size', added: false, off: [], still, error: refused, retry })
    expect(text).toMatch(/^A, B, C, D, E and 2 more still offer it\./)
  })
})
