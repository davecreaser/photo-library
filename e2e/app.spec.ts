// End-to-end: the real built app, driven like a user, against a synthetic library.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEdgeLibrary, createLibrary, createManyFoldersLibrary, fingerprint, LONG_FOLDER, type Library } from './library.ts'

let lib: Library
let before: string
let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  lib = await createLibrary()
  before = fingerprint(lib.root)
})

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pl-e2e-data-'))
  app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, PHOTO_LIBRARY_DATA_DIR: dataDir }
  })
  page = await app.firstWindow()
  // Native folder dialogs can't be clicked by tests; answer them with the sample library.
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog
  }, lib.root)
})

test.afterEach(async () => {
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test.afterAll(() => {
  // The whole point of the app: nothing in the photo folder was changed.
  expect(fingerprint(lib.root)).toBe(before)
  rmSync(lib.root, { recursive: true, force: true })
})

async function chooseLibrary() {
  await page.getByRole('button', { name: 'Choose photo folder…' }).click()
  await expect(page.locator('.scan-status')).toContainText(`${lib.uniquePhotos} photos`)
  await expect(page.locator('.scan-status')).not.toContainText('…')
}

const nav = (name: string) => page.locator('.sidebar .nav-item', { hasText: name }).first()

test('first run: choose a folder, photos appear, private folders and copies are left out', async () => {
  await expect(page.getByText('Your photos are only ever read')).toBeVisible()
  await chooseLibrary()
  await expect(page.locator('.grid .tile')).toHaveCount(lib.uniquePhotos)
  await nav('Undated').click()
  await expect(page.locator('.grid .tile')).toHaveCount(2)
})

test('the camera clock fix is suggested and corrects dates (inside the app only)', async () => {
  await chooseLibrary()
  const banner = page.locator('.banner')
  await expect(banner).toContainText('FUJIFILM X-T50’s clock looks 1 year behind')
  await page.locator('.search').fill('august 2025')
  await expect(page.locator('.grid-meta')).toContainText('0 photos')

  await banner.getByRole('button', { name: 'Fix dates' }).click()
  await expect(banner).toHaveCount(0)
  await page.locator('.search').fill('august 2025')
  await expect(page.locator('.grid .tile')).toHaveCount(4)
})

test('suggested albums: named folders at any size; small bursts only once the minimum is lowered; combine a split trip', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  const cards = page.locator('.event-card')
  // Named folders (any size), and no one-photo bursts at the default minimum of 20.
  await expect(cards.locator('.event-name')).toHaveText(['Poland', 'Sail Amsterdam', 'House Listing'])

  // Lower the minimum: the three one-photo days of the holiday appear (AC-10).
  await page.locator('#min-burst-size').fill('1')
  await page.locator('#min-burst-size').press('Enter')
  const days = page.locator('.event-card', { hasText: /(Jul|Aug) 2026/ })
  await expect(days).toHaveCount(3)

  // Combine them into one album (AC-4).
  for (const card of await days.all()) await card.click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'Combine into one album' }).click()
  await page.getByPlaceholder('Album name, e.g. Norway').fill('Norway')
  await page.getByPlaceholder('Album name, e.g. Norway').press('Enter')
  await expect(page.locator('.merge-bar')).toContainText('Made album “Norway” with 3 photos from 3 suggestions.')
  await expect(days).toHaveCount(0)
  await page.getByRole('button', { name: 'Open album' }).click()
  await expect(page.locator('h1')).toHaveText('Norway')
  await expect(page.locator('.grid .tile')).toHaveCount(3)
})

test('suggested albums: dismiss with undo, and restore from the dismissed list', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  const poland = page.locator('.event-card', { hasText: 'Poland' })
  await poland.hover()
  await poland.getByRole('button', { name: 'Dismiss' }).click()
  await expect(poland).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(poland).toHaveCount(1)

  await poland.hover()
  await poland.getByRole('button', { name: 'Dismiss' }).click()
  await page.getByRole('button', { name: 'Dismissed (1)…' }).click()
  await expect(page.locator('.modal')).toContainText('Poland')
  await page.locator('.modal').getByRole('button', { name: 'Restore' }).click()
  await page.locator('.modal').getByRole('button', { name: 'Done' }).click()
  await expect(poland).toHaveCount(1)
})

test('suggested albums: accept one, and deleting its album brings it back', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  const sail = page.locator('.event-card', { hasText: 'Sail Amsterdam' })
  await sail.hover()
  await sail.getByRole('button', { name: 'Make album' }).click()
  await page.locator('.event-card .inline-input').press('Enter')
  await expect(sail).toHaveCount(0)
  const album = page.locator('.sidebar .nav-item.album', { hasText: 'Sail Amsterdam' })
  await expect(album).toContainText('4')
  await album.hover()
  await album.getByTitle('Delete album').click()
  await expect(page.locator('.sidebar .confirm')).toContainText('it goes back to Suggested albums')
  await page.locator('.sidebar .confirm').getByRole('button', { name: 'Delete' }).click()
  await expect(sail).toHaveCount(1)
})

test('ignoring a folder removes its photos from the library', async () => {
  await chooseLibrary()
  await page.getByRole('button', { name: 'Ignored folders…' }).click()
  await page.getByPlaceholder('e.g. private').fill('house_listing')
  await page.getByRole('button', { name: 'Add name' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.scan-status')).toContainText(`${lib.uniquePhotos - 2} photos`)
})

// --- Spec 0001 QA: suggested albums, edge cases ---

const cards = () => page.locator('.event-card')
const card = (name: string) => page.locator('.event-card', { hasText: name })
const albumsNamed = (name: string) => page.locator('.sidebar .nav-item.album', { hasText: name })

test('suggested albums (AC-2): waiting count in the sidebar, newest first by year, Undated last; opening one shows exactly its photos; a favourite is the cover', async () => {
  await chooseLibrary()
  await expect(nav('Suggested albums').locator('.count')).toHaveText('3')
  await nav('Suggested albums').click()
  await expect(nav('Suggested albums')).toHaveClass(/active/)
  await expect(page.locator('.event-year h2')).toHaveText(['2024', 'Undated'])
  await expect(card('Sail Amsterdam').locator('.event-meta')).toHaveText('24 Aug 2024 · 4 photos')
  await expect(card('House Listing').locator('.event-meta')).toContainText('2 photos')

  await card('Poland').click()
  await expect(page.locator('h1')).toHaveText('Poland')
  await expect(page.locator('.subtitle')).toContainText('3 photos')
  await expect(nav('Suggested albums')).toHaveClass(/active/)
  await expect(page.locator('.grid .tile')).toHaveCount(3)
  // Star the last photo: it becomes the cover (the default is the middle one).
  const last = page.locator('.grid .tile').nth(2)
  const lastSrc = await last.locator('img').getAttribute('src')
  expect(await page.locator('.grid .tile').nth(1).locator('img').getAttribute('src')).not.toBe(lastSrc)
  await last.click()
  await page.locator('.viewer .star').click()
  await expect(page.locator('.viewer .star')).toHaveClass(/on/)
  await page.keyboard.press('Escape')
  await nav('Suggested albums').click()
  await expect(card('Poland').locator('img')).toHaveAttribute('src', lastSrc!)
})

test('suggested albums (AC-3): an empty name is refused, and a fast double Enter makes one album', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  const sail = card('Sail Amsterdam')
  await sail.hover()
  await sail.getByRole('button', { name: 'Make album' }).click()
  // While naming, the card's name line is the input, so find it by class, not by the card's text.
  const input = page.locator('.event-card .inline-input')
  await expect(input).toHaveValue('Sail Amsterdam')
  await input.fill('   ')
  await input.press('Enter')
  await expect(page.locator('.event-card:has(.inline-input) .event-meta')).toHaveText('An album needs a name.')
  await expect(albumsNamed('Sail')).toHaveCount(0)

  await input.fill('Sail 2025')
  // Two Enters before the first one has finished (impatient user, key repeat).
  await input.evaluate((el) => {
    for (let i = 0; i < 2; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await expect(sail).toHaveCount(0)
  await expect(page.locator('.merge-bar')).toContainText('Made album “Sail 2025” with 4 photos.')
  await page.waitForTimeout(500)
  expect((await page.evaluate(() => window.api.listAlbums())).length).toBe(1)
  await expect(albumsNamed('Sail 2025')).toHaveCount(1)
})

test('suggested albums (AC-5): dismiss several from the bar, ⌘Z undo; undo is gone after the minimum changes', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  await card('Poland').click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.merge-bar')).toContainText('Select another suggestion to combine with.')
  await expect(page.getByRole('button', { name: 'Combine into one album' })).toBeDisabled()
  await card('House Listing').click({ modifiers: ['ControlOrMeta'] })
  await page.locator('.merge-bar').getByRole('button', { name: 'Dismiss' }).click()
  await expect(cards().locator('.event-name')).toHaveText(['Sail Amsterdam'])
  await expect(page.locator('.merge-bar')).toContainText('Dismissed 2 suggestions.')
  await expect(nav('Suggested albums').locator('.count')).toHaveText('1')
  await page.locator('.event-year h2').first().click() // focus the view, not an input
  await page.keyboard.press('ControlOrMeta+z')
  await expect(cards().locator('.event-name')).toHaveText(['Poland', 'Sail Amsterdam', 'House Listing'])
  await expect(nav('Suggested albums').locator('.count')).toHaveText('3')

  // Dismiss, then change the minimum: the undo step is gone, the dismissal stays.
  await card('Poland').hover()
  await card('Poland').getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.locator('.merge-bar')).toContainText('Dismissed “Poland”.')
  await page.locator('#min-burst-size').fill('1')
  await page.locator('#min-burst-size').press('Enter')
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0)
  await expect(card('Poland')).toHaveCount(0)

  // The dismissed list notes it, restore puts it back.
  await page.getByRole('button', { name: 'Dismissed (1)…' }).click()
  await expect(page.locator('.modal .dismissed-row')).toHaveCount(1)
  await expect(page.locator('.modal .dismissed-row')).toContainText('3 photos')
  await page.locator('.modal').getByRole('button', { name: 'Restore' }).click()
  await expect(page.locator('.modal .dismissed-row')).toHaveCount(0)
  await page.locator('.modal').getByRole('button', { name: 'Done' }).click()
  await expect(card('Poland')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /^Dismissed \(/ })).toHaveCount(0)
})

test('suggested albums (AC-10): values outside 1–1,000 are refused with a hint, Esc puts the value back', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  const field = page.locator('#min-burst-size')
  await expect(field).toHaveValue('20')
  for (const bad of ['0', '1001', '2.5', '-4', '']) {
    await field.fill(bad)
    await field.press('Enter')
    await expect(field, bad).toHaveClass(/invalid/)
    await expect(page.getByText('Use a number from 1 to 1,000.')).toBeVisible()
    await expect(cards()).toHaveCount(3)
  }
  await field.press('Escape')
  await expect(field).toHaveValue('20')
  await expect(field).not.toHaveClass(/invalid/)
  // Blur applies too.
  await field.fill('1')
  await page.locator('.event-year h2').first().click()
  await expect(cards()).toHaveCount(7)
  await expect(nav('Suggested albums').locator('.count')).toHaveText('7')
  // Persisted across a reload of the view.
  await nav('All photos').click()
  await nav('Suggested albums').click()
  await expect(field).toHaveValue('1')
})

test('suggested albums (AC-11): when nothing is left it says so, with a link to the dismissed list', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  for (const name of ['Poland', 'Sail Amsterdam', 'House Listing']) {
    await card(name).hover()
    await card(name).getByRole('button', { name: 'Dismiss' }).click()
    await expect(card(name)).toHaveCount(0)
  }
  await expect(page.locator('.empty')).toContainText('Nothing to suggest right now.')
  await expect(page.locator('.empty')).toContainText('no other group has at least 20 photos')
  await expect(page.locator('#min-burst-size')).toBeVisible()
  await expect(nav('Suggested albums').locator('.count')).toHaveText('')
  await page.getByRole('button', { name: 'See dismissed suggestions (3)' }).click()
  await expect(page.locator('.modal .dismissed-row')).toHaveCount(3)
  // Most recently dismissed first.
  await expect(page.locator('.modal .dismissed-row strong')).toHaveText(['House Listing', 'Sail Amsterdam', 'Poland'])
})

test('suggested albums (AC-6): decisions survive a restart and a rescan', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  await card('Poland').hover()
  await card('Poland').getByRole('button', { name: 'Dismiss' }).click()
  await card('Sail Amsterdam').hover()
  await card('Sail Amsterdam').getByRole('button', { name: 'Make album' }).click()
  await page.locator('.event-card .inline-input').press('Enter')
  await expect(cards().locator('.event-name')).toHaveText(['House Listing'])

  await app.close()
  app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, PHOTO_LIBRARY_DATA_DIR: dataDir }
  })
  page = await app.firstWindow()
  await expect(page.locator('.scan-status')).toContainText(`${lib.uniquePhotos} photos`)
  await expect(page.locator('.scan-status')).not.toContainText('…')
  await nav('Suggested albums').click()
  await expect(cards().locator('.event-name')).toHaveText(['House Listing'])
  await expect(nav('Suggested albums').locator('.count')).toHaveText('1')
  await page.getByRole('button', { name: 'Rescan' }).click()
  await expect(page.locator('.scan-status')).not.toContainText('…')
  await expect(cards().locator('.event-name')).toHaveText(['House Listing'])
})

test('suggested albums: accepting while a rescan runs still makes the album', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  await card('Poland').hover()
  await card('Poland').getByRole('button', { name: 'Make album' }).click()
  await page.evaluate(() => void window.api.startScan())
  await page.locator('.event-card .inline-input').press('Enter')
  await expect(card('Poland')).toHaveCount(0)
  await expect(albumsNamed('Poland')).toContainText('3')
  await expect(page.locator('.scan-status')).not.toContainText('…')
  await expect(card('Poland')).toHaveCount(0)
})

test('suggested albums (AC-11, AC-1): the scanning state, a very long folder name, and an undated named folder', async () => {
  const edge = await createEdgeLibrary()
  const edgeBefore = fingerprint(edge.root)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog
  }, edge.root)
  await page.getByRole('button', { name: 'Choose photo folder…' }).click()
  await nav('Suggested albums').click()
  // Either caught mid-scan, or already finished: never an empty list mid-scan.
  const scanningOrDone = page.getByText('Suggested albums will appear when the scan finishes.').or(page.locator('.event-card').first())
  await expect(scanningOrDone).toBeVisible()
  await expect(page.locator('.scan-status')).toContainText(`${edge.uniquePhotos} photos`)
  await expect(page.locator('.scan-status')).not.toContainText('…')

  // 120 loose photos two days apart: no bursts at 20. The long name and the undated folder are listed.
  await expect(cards()).toHaveCount(2)
  await expect(page.locator('.event-year h2')).toHaveText(['2025', 'Undated'])
  const long = cards().first()
  await expect(long.locator('.event-name')).toContainText('A Very Long Folder Name')
  await expect(card('Old Scans').locator('.event-meta')).toContainText('3 photos')
  // The long name is cut with an ellipsis inside its card, not spilling out of it.
  const box = (await long.boundingBox())!
  const nameBox = (await long.locator('.event-name').boundingBox())!
  expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(box.x + box.width + 1)
  const view = (await page.locator('main').boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(view.x + view.width + 1)

  // Make an album with the full long name.
  await long.hover()
  await long.getByRole('button', { name: 'Make album' }).click()
  await page.locator('.event-card .inline-input').press('Enter')
  const albums = await page.evaluate(() => window.api.listAlbums())
  expect(albums.map((a: { name: string }) => a.name)).toEqual([expect.stringMatching(/End$/)])
  expect(LONG_FOLDER.endsWith('end')).toBe(true)

  // Open the undated named folder: its photos, no date in the meta.
  await card('Old Scans').click()
  await expect(page.locator('.grid .tile')).toHaveCount(3)
  await expect(page.locator('.subtitle')).toContainText('3 photos')

  await app.close()
  expect(fingerprint(edge.root)).toBe(edgeBefore)
  rmSync(edge.root, { recursive: true, force: true })
  // afterEach closes `app` again; relaunch a throwaway instance so that works.
  app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, PHOTO_LIBRARY_DATA_DIR: dataDir }
  })
})

test('suggested albums (AC-13): ignoring a folder forgets its dismissed suggestion and the folder name', async () => {
  await chooseLibrary()
  await nav('Suggested albums').click()
  await card('House Listing').hover()
  await card('House Listing').getByRole('button', { name: 'Dismiss' }).click()
  await expect(page.getByRole('button', { name: 'Dismissed (1)…' })).toBeVisible()
  await page.getByRole('button', { name: 'Ignored folders…' }).click()
  await expect(page.locator('.modal')).toContainText('suggested-album decisions')
  await page.getByPlaceholder('e.g. private').fill('house_listing')
  await page.getByRole('button', { name: 'Add name' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.scan-status')).toContainText(`${lib.uniquePhotos - 2} photos`)
  await expect(page.getByRole('button', { name: /^Dismissed \(/ })).toHaveCount(0)
  expect(await page.evaluate(() => window.api.getDismissedSuggestions())).toEqual([])
})

test('suggested albums (AC-12): 2,000 suggestions open quickly and load more as you scroll', async () => {
  test.setTimeout(300_000)
  const many = await createManyFoldersLibrary(2000)
  const manyBefore = fingerprint(many.root)
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog
  }, many.root)
  await page.getByRole('button', { name: 'Choose photo folder…' }).click()
  await expect(page.locator('.scan-status')).toContainText('2,000 photos', { timeout: 240_000 })
  await expect(page.locator('.scan-status')).not.toContainText('…', { timeout: 240_000 })
  await expect(nav('Suggested albums').locator('.count')).toHaveText('2,000')

  const t = Date.now()
  await nav('Suggested albums').click()
  await expect(cards().first()).toBeVisible()
  const openMs = Date.now() - t
  expect(openMs, `opened in ${openMs} ms`).toBeLessThan(2000)
  // Paged: not all 2,000 cards at once; scrolling to the end loads the rest.
  const first = await cards().count()
  expect(first).toBeLessThanOrEqual(400)
  const scroller = page.locator('.grid-scroller.suggestions')
  const s = Date.now()
  for (let i = 0; i < 40 && (await cards().count()) < 2000; i++) {
    await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await page.waitForTimeout(50)
  }
  await expect(cards()).toHaveCount(2000)
  const scrollMs = Date.now() - s
  expect(scrollMs, `scrolled to the end in ${scrollMs} ms`).toBeLessThan(5000)
  // Year headings are the real ones, each once.
  const years = await page.locator('.event-year h2').allTextContents()
  expect(years).toEqual([...new Set(years)])
  console.log(`AC-12: open ${openMs} ms, first page ${first} cards, scroll to 2,000 in ${scrollMs} ms`)

  await app.close()
  expect(fingerprint(many.root)).toBe(manyBefore)
  rmSync(many.root, { recursive: true, force: true })
  app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, PHOTO_LIBRARY_DATA_DIR: dataDir }
  })
})
