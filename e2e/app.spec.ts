// End-to-end: the real built app, driven like a user, against a synthetic library.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createContentLibrary,
  createEdgeLibrary,
  createLibrary,
  createTripLibrary,
  photo,
  createManyFoldersLibrary,
  fingerprint,
  LONG_FOLDER,
  type Library
} from './library.ts'

let lib: Library
let before: string
let app: ElectronApplication
let page: Page
let dataDir: string

test.beforeAll(async () => {
  lib = await createLibrary()
  before = fingerprint(lib.root)
})

/** Starts the app on `dataDir`; folder dialogs answer with `root`. */
async function launch(root: string, env: Record<string, string> = {}) {
  app = await electron.launch({
    args: [join(process.cwd(), 'out', 'main', 'index.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, PHOTO_LIBRARY_DATA_DIR: dataDir, ...env }
  })
  page = await app.firstWindow()
  // Native folder dialogs can't be clicked by tests; answer them with the sample library.
  await app.evaluate(({ dialog }, root) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog
  }, root)
}

/** An empty models folder: no face or content analysis (for libraries too big to analyse in a test). */
const NO_MODELS = () => ({ PHOTO_LIBRARY_MODELS_DIR: mkdtempSync(join(tmpdir(), 'pl-e2e-no-models-')) })

test.beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'pl-e2e-data-'))
  await launch(lib.root)
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

/** Chooses the library and waits for the scan and background analysis to finish. */
async function chooseLibrary(photos = lib.uniquePhotos) {
  await page.getByRole('button', { name: 'Choose photo folder…' }).click()
  await settled(photos)
}

/** Waits until the top bar shows the photo count with nothing in progress (scan or content analysis). */
async function settled(photos: number) {
  // Analysis loads a 400 MB model first; CI machines are slow at that.
  await expect(page.locator('.scan-status')).toContainText(`${photos.toLocaleString('en-US')} photos`, { timeout: 90_000 })
  await expect(page.locator('.scan-status')).not.toContainText('…', { timeout: 90_000 })
  // Analysis starts a moment after the scan ends; wait until every photo is analysed (or it can't be).
  await expect
    .poll(
      async () => {
        const p = await page.evaluate(() => window.api.getContentProgress())
        return p.phase === 'unavailable' || (p.phase === 'idle' && p.done === p.total && p.total === photos)
      },
      { timeout: 90_000 }
    )
    .toBe(true)
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
  // The date follows the system's locale ("24 Aug 2024" in en-GB, "Aug 24, 2024" in en-US).
  await expect(card('Sail Amsterdam').locator('.event-meta')).toHaveText(/^(24 Aug 2024|Aug 24, 2024) · 4 photos$/)
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
  await launch(lib.root)
  await settled(lib.uniquePhotos)
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
  await app.close()
  await launch(edge.root, NO_MODELS()) // 125 photos: analysing them isn't what this tests
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
  await launch(lib.root)
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
  await app.close()
  await launch(many.root, NO_MODELS()) // analysing 2,000 photos isn't what this tests
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
  // ~1.6 s on a Mac; CI machines render without a GPU and are several times slower.
  expect(scrollMs, `scrolled to the end in ${scrollMs} ms`).toBeLessThan(process.env.CI ? 45_000 : 5000)
  // Year headings are the real ones, each once.
  const years = await page.locator('.event-year h2').allTextContents()
  expect(years).toEqual([...new Set(years)])
  console.log(`AC-12: open ${openMs} ms, first page ${first} cards, scroll to 2,000 in ${scrollMs} ms`)

  await app.close()
  expect(fingerprint(many.root)).toBe(manyBefore)
  rmSync(many.root, { recursive: true, force: true })
  await launch(lib.root)
})

// --- search by content (spec 0002) ---

/** Runs `body` against a content library (red and blue photos), then checks the app changed nothing in it. */
async function withContentLibrary(extra: number, env: Record<string, string>, body: (photos: number) => Promise<void>) {
  const content = await createContentLibrary(extra)
  const contentBefore = fingerprint(content.root)
  await app.close()
  await launch(content.root, env)
  await body(content.uniquePhotos)
  await app.close()
  expect(fingerprint(content.root)).toBe(contentBefore)
  rmSync(content.root, { recursive: true, force: true })
  await launch(lib.root) // for afterEach
}

const meta = () => page.locator('.grid-meta')
const searchFor = (text: string) => page.locator('.search').fill(text)

test('search by content (AC-1, AC-2, AC-5, AC-13): name matches, a divider, then what the photos show; nothing over the network', async () => {
  await withContentLibrary(0, {}, async (photos) => {
    // Every request the app makes, from any window or the main process's net module.
    await app.evaluate(({ session }) => {
      const seen: string[] = ((globalThis as unknown as { requests: string[] }).requests = [])
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        seen.push(details.url)
        callback({})
      })
    })
    await chooseLibrary(photos)
    await expect(page.locator('.search')).toHaveAttribute('placeholder', 'Search: “sunset over water”, “jake 2025”, “poland”…')

    // "red": the photo in the "red things" folder first (by name), then the red photos.
    await searchFor('red')
    await expect(meta()).toHaveText('4 photos · 1 by name, then 3 that look like “red”, best match first')
    await expect(page.locator('.grid .tile')).toHaveCount(4)
    await expect(page.locator('.grid-divider')).toHaveText(['Looks like “red”'])
    await expect(page.locator('.grid > *').nth(1)).toHaveClass('grid-divider')
    await expect(page.locator('.grid .tile').first()).toHaveAttribute('title', /^DSC_X\.JPG/)
    for (const tile of await page.locator('.grid .tile').all()) {
      if ((await tile.getAttribute('title'))?.startsWith('DSC_X')) continue
      await expect(tile).toHaveAttribute('title', /^DSC_R/)
    }
    await expect(page.locator('.search-hint')).toHaveCount(0)

    // Selecting across the divider: it isn't a tile.
    await page
      .locator('.grid .tile')
      .first()
      .click({ modifiers: ['ControlOrMeta'] })
    await page
      .locator('.grid .tile')
      .last()
      .click({ modifiers: ['Shift'] })
    await expect(meta()).toHaveText('4 photos · 1 by name, then 3 that look like “red”, best match first · 4 selected')
    await page.getByRole('button', { name: 'Clear' }).click()

    // Content only, with a date filter; and a phrase.
    await searchFor('blue 2026')
    await expect(meta()).toHaveText('3 photos that look like “blue” · best match first')
    await expect(page.locator('.grid-divider')).toHaveCount(0)
    await searchFor('a red square')
    await expect(meta()).toHaveText('3 photos that look like “red square” · best match first')

    // No content phrase: exactly as before, no hint.
    await searchFor('2025')
    await expect(meta()).toHaveText('3 photos · ⌘-click or shift-click to select')

    // Nothing matches.
    await searchFor('xqzv kjrw')
    await expect(page.locator('.empty')).toContainText('No photos matched “xqzv kjrw”.')
    await expect(page.locator('.empty')).toContainText('Search looks at what’s in your photos, and at folder and file names, albums, tags, people and dates.')

    const requests = await app.evaluate(() => (globalThis as unknown as { requests: string[] }).requests)
    const remote = requests.filter((url) => !/^(file|photo|devtools|data|blob|chrome|chrome-extension):/.test(url))
    expect(remote, 'the app made no network requests').toEqual([])
  })
})

test('search by content while photos are being analysed (AC-7): progress, hint, and Refresh results', async () => {
  test.setTimeout(300_000)
  await withContentLibrary(120, {}, async (photos) => {
    await page.getByRole('button', { name: 'Choose photo folder…' }).click()
    const status = page.locator('.scan-status')
    await expect(status).toContainText('Analysing photos for search…', { timeout: 90_000 })
    await expect(status.locator('[title^="Photo Library is learning what’s in each photo"]')).toBeVisible()
    await searchFor('red')
    await expect(page.locator('.search-hint')).toContainText('Still analysing your photos:')
    await expect(page.locator('.search-hint')).toContainText('Photos not analysed yet can only be found by name.')
    // Results don't change by themselves; once analysis is done, the hint says so.
    await expect(page.locator('.search-hint')).toContainText('All photos are now analysed.', { timeout: 240_000 })
    await page.locator('.search-hint').getByRole('button', { name: 'Refresh results' }).click()
    await expect(page.locator('.search-hint')).toHaveCount(0)
    await expect(meta()).toHaveText('4 photos · 1 by name, then 3 that look like “red”, best match first')
    await settled(photos)
  })
})

test('content search unavailable (AC-9): says why and how to fix it; search by name works as before', async () => {
  await withContentLibrary(0, NO_MODELS(), async (photos) => {
    await chooseLibrary(photos)
    // "7 new" outranks it in the top bar; once a rescan finds nothing new, it says content search is unavailable.
    await page.getByRole('button', { name: 'Rescan' }).click()
    await expect(page.locator('.scan-status')).toContainText(`${photos} photos · content search unavailable`)
    const fix = 'its model file is missing. Run “npm run fetch-models”, then restart the app.'
    await expect(page.locator('.scan-status [title]').filter({ hasText: 'content search unavailable' })).toHaveAttribute('title', fix)
    await expect(page.locator('.search')).toHaveAttribute('placeholder', 'Search: “august 2025”, “poland”, “jake”…')
    await searchFor('red')
    await expect(meta()).toHaveText('1 photo · ⌘-click or shift-click to select')
    await expect(page.locator('.search-hint .error')).toHaveText(`Content search is unavailable: ${fix}`)
    await expect(page.locator('.search-hint')).toContainText('Names, albums, tags, people and dates are still searched.')
    await searchFor('giraffe')
    await expect(page.locator('.empty')).toContainText('Content search is unavailable, so only names, albums, tags, people and dates were searched.')
  })
})

test('sidebar sections (spec 0004): Albums and Tags collapse, People has no toggle without people, choices survive relaunch', async () => {
  test.setTimeout(240_000)
  await app.close()
  await launch(lib.root, NO_MODELS())
  await chooseLibrary()
  await page.evaluate(() => window.api.createAlbum('Holiday', null))
  await page.getByRole('button', { name: 'Rescan' }).click()
  const albumRow = page.locator('.nav-item.album', { hasText: 'Holiday' })
  await expect(albumRow).toBeVisible()
  // AC-1/AC-2: no people named, so no People toggle.
  await expect(page.getByRole('button', { name: /^(Show|Hide) people$/ })).toHaveCount(0)
  // AC-3/AC-4/AC-8: collapse Albums with the keyboard-operable toggle; the count stays.
  const toggle = page.getByRole('button', { name: 'Hide albums' })
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await toggle.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Show albums' })).toHaveAttribute('aria-expanded', 'false')
  await expect(albumRow).toHaveCount(0)
  await expect(page.locator('.sidebar h2', { hasText: 'Albums' }).locator('.heading-count')).toHaveText('1')
  // AC-6: ＋ expands first, then shows the input.
  await page.getByTitle('New album').click()
  await expect(albumRow).toBeVisible()
  await expect(page.getByPlaceholder('Album name')).toBeVisible()
  await page.keyboard.press('Escape')
  // AC-7: collapse again, relaunch, still collapsed.
  await page.getByRole('button', { name: 'Hide albums' }).click()
  await expect(page.getByRole('button', { name: 'Show albums' })).toBeVisible()
  await app.close()
  await launch(lib.root, NO_MODELS())
  await expect(page.getByRole('button', { name: 'Show albums' })).toBeVisible()
  await expect(page.locator('.nav-item.album')).toHaveCount(0)
})

test('sidebar sections (spec 0004): People collapsed by default, toggle does not navigate, active when collapsed, choice survives relaunch', async () => {
  test.setTimeout(240_000)
  await app.close()
  await launch(lib.root, NO_MODELS())
  await chooseLibrary()
  await app.close()
  // Name two people directly in the app's own database (generated photos have no faces to recognise).
  const db = new DatabaseSync(join(dataDir, 'library.db'))
  const photoIds = (db.prepare('SELECT id FROM photos WHERE present = 1 ORDER BY id LIMIT 2').all() as { id: number }[]).map((r) => r.id)
  expect(photoIds.length).toBe(2)
  for (const [i, name] of ['Alex Example', 'Sam Sample'].entries()) {
    const person = db.prepare('INSERT INTO people (name) VALUES (?)').run(name).lastInsertRowid
    db.prepare("INSERT INTO faces (photo_id, x, y, w, h, score, person_id, assigned_by) VALUES (?, 0.1, 0.1, 0.2, 0.2, 0.9, ?, 'user')").run(
      photoIds[i],
      person
    )
  }
  db.close()
  await launch(lib.root, NO_MODELS())
  const person = page.locator('.sidebar .nav-item.person', { hasText: 'Alex Example' })
  const peopleRow = page.locator('.sidebar .nav-item', { hasText: 'People' }).first()
  // AC-2: collapsed by default; AC-4: the count stays.
  const show = page.getByRole('button', { name: 'Show people' })
  await expect(show).toHaveAttribute('aria-expanded', 'false')
  await expect(person).toHaveCount(0)
  await expect(peopleRow.locator('.count')).toHaveText('2')
  // AC-1: the toggle expands without opening the People view; the row itself still opens it.
  await show.click()
  await expect(person).toBeVisible()
  await expect(page.locator('.sidebar .nav-item.person')).toHaveCount(2)
  await expect(peopleRow).not.toHaveClass(/active/)
  await page.getByRole('button', { name: 'Hide people' }).click()
  await expect(person).toHaveCount(0)
  await expect(peopleRow).not.toHaveClass(/active/)
  await peopleRow.locator('.count').click()
  await expect(peopleRow).toHaveClass(/active/)
  // AC-5: viewing a person while collapsed highlights the People row; collapsing never changes the view.
  await page.getByRole('button', { name: 'Show people' }).click()
  await person.click()
  await expect(person).toHaveClass(/active/)
  await page.getByRole('button', { name: 'Hide people' }).click()
  await expect(person).toHaveCount(0)
  await expect(peopleRow).toHaveClass(/active/)
  await expect(page.locator('.grid .tile')).toHaveCount(1)
  // AC-7: an explicit choice (open) wins over the default after relaunch.
  await page.getByRole('button', { name: 'Show people' }).click()
  await app.close()
  await launch(lib.root, NO_MODELS())
  await expect(page.getByRole('button', { name: 'Hide people' })).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.sidebar .nav-item.person', { hasText: 'Alex Example' })).toBeVisible()
})

test('albums move into other albums by drag and by “Move to…”; deleting a parent keeps its sub-albums', async () => {
  await chooseLibrary()
  for (const name of ['Trips', 'Norway', 'Poland']) await page.evaluate((n) => window.api.createAlbum(n, null), name)
  await page.getByRole('button', { name: 'Rescan' }).click()
  const album = (name: string) => page.locator('.sidebar .nav-item.album', { hasText: name })
  const indent = async (name: string) => (await album(name).evaluate((el) => parseInt((el as HTMLElement).style.paddingLeft))) as number
  await page.reload()
  await expect(album('Norway')).toBeVisible()
  expect(await indent('Norway')).toBe(12)

  // Drag Norway onto Trips (AC-1).
  await album('Norway').dragTo(album('Trips'))
  await expect.poll(() => indent('Norway')).toBe(26)

  // Move Poland in with "Move to…" (AC-3); the picker doesn't offer Poland itself.
  await album('Poland').hover()
  await album('Poland').getByTitle('Move to…').click()
  await expect(page.locator('.popover-item', { hasText: 'Poland' })).toHaveCount(0)
  await page.locator('.popover-item', { hasText: 'Trips' }).click()
  await expect.poll(() => indent('Poland')).toBe(26)

  // Drag Norway to the Albums heading: top level (AC-2).
  await album('Norway').dragTo(page.locator('.sidebar h2', { hasText: 'Albums' }))
  await expect.poll(() => indent('Norway')).toBe(12)

  // Deleting Trips keeps Poland, now at the top (AC-6).
  await album('Trips').hover()
  await album('Trips').getByTitle('Delete album').click()
  await expect(page.locator('.confirm')).toContainText('Its sub-album moves up one level.')
  await page.locator('.confirm').getByRole('button', { name: 'Delete' }).click()
  await expect(album('Trips')).toHaveCount(0)
  await expect.poll(() => indent('Poland')).toBe(12)
})

test('albums move: dropping an album into its own sub-album is refused; moving keeps photos and sub-albums (AC-4, AC-5)', async () => {
  await chooseLibrary()
  const parent = await page.evaluate(() => window.api.createAlbum('Outer', null))
  const child = await page.evaluate((p) => window.api.createAlbum('Inner', p), parent.id)
  const dest = await page.evaluate(() => window.api.createAlbum('Dest', null))
  const photos = await page.evaluate(() => window.api.queryPhotos({} as never))
  const ids = photos.photos.slice(0, 2).map((p: { id: number }) => p.id)
  expect(ids.length).toBe(2)
  await page.evaluate(([a, i]) => window.api.addToAlbum(a as number, i as number[]), [parent.id, ids] as const)
  await page.reload()
  const album = (name: string) => page.locator('.sidebar .nav-item.album', { hasText: name })
  const indent = async (name: string) => (await album(name).evaluate((el) => parseInt((el as HTMLElement).style.paddingLeft))) as number
  await expect(album('Inner')).toBeVisible()

  // UI: Outer onto its own sub-album does nothing; the picker for Outer excludes Inner.
  await album('Outer').dragTo(album('Inner'))
  expect(await indent('Outer')).toBe(12)
  expect(await indent('Inner')).toBe(26)
  await album('Outer').hover()
  await album('Outer').getByTitle('Move to…').click()
  await expect(page.locator('.popover-item', { hasText: 'Inner' })).toHaveCount(0)
  await expect(page.locator('.popover-item', { hasText: 'Dest' })).toHaveCount(1)
  // Data layer: refused, nothing changes.
  expect(await page.evaluate((a) => window.api.moveAlbum(a[0], a[1]), [parent.id, child.id])).toBe(false)
  expect(await page.evaluate((a) => window.api.moveAlbum(a, a), parent.id)).toBe(false)

  // Moving Outer into Dest keeps its photos and its sub-album.
  await page.locator('.popover-item', { hasText: 'Dest' }).click()
  await expect.poll(() => indent('Outer')).toBe(26)
  const after = await page.evaluate(() => window.api.listAlbums())
  expect(after.find((a) => a.id === parent.id)?.photoCount).toBe(2)
  expect(after.find((a) => a.id === parent.id)?.parentId).toBe(dest.id)
  expect(after.find((a) => a.id === child.id)?.parentId).toBe(parent.id)
  // afterAll's fingerprint check proves no photo file was touched.
})

// --- Spec 0005 QA: new photos for an album ---

/** A fresh generated library (so the shared one's fingerprint is untouched) with Poland made into an album. */
async function poland() {
  const own = await createLibrary()
  await app.close()
  await launch(own.root)
  await chooseLibrary(own.uniquePhotos)
  await nav('Suggested albums').click()
  await card('Poland').hover()
  await card('Poland').getByRole('button', { name: 'Make album' }).click()
  await page.locator('.event-card .inline-input').press('Enter')
  await expect(albumsNamed('Poland')).toContainText('3')
  return own
}
const rescan = async () => {
  await page.getByRole('button', { name: 'Rescan' }).click()
  await expect(page.locator('.scan-status')).not.toContainText('…')
}
const offerRow = () => page.locator('.offer-row')

test('new photos for an album (AC-1..AC-4): offered after a rescan, listed first, opened in capture order, added exactly; not also suggested', async () => {
  const own = await poland()
  try {
    // Nothing offered yet, and no section (AC-1, AC-8).
    await expect(offerRow()).toHaveCount(0)
    await expect(page.getByText('New photos for your albums')).toHaveCount(0)

    // The next day in the same folder (b), an afternoon photo of the same day in another folder (a),
    // and an unrelated photo that must not be offered.
    await photo(join(own.root, 'fuji/trips/12.25.poland', 'NEW1.JPG'), '2024:12:14 10:00:00')
    await photo(join(own.root, 'fuji/trips/12.25.poland', 'NEW2.JPG'), '2024:12:14 11:00:00')
    await photo(join(own.root, 'phone', 'P1.JPG'), '2024:12:13 15:00:00')
    await photo(join(own.root, 'phone', 'FAR.JPG'), '2023:03:03 15:00:00')
    await rescan()
    await expect(page.locator('.scan-status')).toContainText(`${own.uniquePhotos + 4} photos`)

    // AC-2: listed at the top, counted in the sidebar badge (offer + the 2 other suggestions + the far photo's none).
    await expect(page.locator('.offers h2')).toHaveText('New photos for your albums')
    await expect(offerRow()).toHaveCount(1)
    await expect(offerRow().locator('.event-name')).toHaveText('3 new photos for Poland')
    const badge = Number(await nav('Suggested albums').locator('.count').textContent())
    expect(badge).toBe((await cards().count()) + 1)

    // AC-4: none of the offered photos is in a suggestion card; the far photo is not offered.
    for (const c of await cards().all()) await expect(c.locator('.event-name')).not.toHaveText('Poland')
    await expect(cards().locator('.event-name')).toHaveText(['Sail Amsterdam', 'House Listing'])

    // Look: exactly those photos.
    await offerRow().getByRole('button', { name: 'Look' }).click()
    await expect(page.locator('h1')).toHaveText('New photos for Poland')
    await expect(page.locator('.grid .tile')).toHaveCount(3)

    // Add from the opened offer: goes to the album, count rises by exactly 3.
    await page.getByRole('button', { name: 'Add to Poland' }).click()
    await expect(page.locator('h1')).toHaveText('Poland')
    await expect(page.locator('.grid .tile')).toHaveCount(6)
    await expect(albumsNamed('Poland')).toContainText('6')
    await nav('Suggested albums').click()
    await expect(offerRow()).toHaveCount(0)
    await rescan()
    await expect(offerRow()).toHaveCount(0)
  } finally {
    rmSync(own.root, { recursive: true, force: true })
  }
})

test('new photos for an album (AC-3, AC-5): Add from the row shows a notice; Not these is undoable, remembered through a restart, later photos offered anew', async () => {
  const own = await poland()
  try {
    await photo(join(own.root, 'fuji/trips/12.25.poland', 'NEW1.JPG'), '2024:12:14 10:00:00')
    await rescan()
    await nav('Suggested albums').click()
    await expect(offerRow().locator('.event-name')).toHaveText('1 new photo for Poland')

    // Decline (a double-click still leaves the Undo notice), then undo.
    await offerRow().getByRole('button', { name: 'Not these' }).dblclick()
    await expect(offerRow()).toHaveCount(0)
    await expect(page.locator('.merge-bar')).toContainText('Won’t offer this photo for “Poland” again.')
    await page.locator('.merge-bar').getByRole('button', { name: 'Undo' }).click()
    await expect(offerRow()).toHaveCount(1)

    // Decline for good; stays hidden after a rescan and a restart, and is not suggested instead.
    await offerRow().getByRole('button', { name: 'Not these' }).click()
    await expect(offerRow()).toHaveCount(0)
    await rescan()
    await app.close()
    await launch(own.root)
    await settled(own.uniquePhotos + 1)
    await nav('Suggested albums').click()
    await expect(offerRow()).toHaveCount(0)
    await expect(cards().locator('.event-name')).not.toContainText(['Poland'])

    // A later photo is a new offer of just that photo.
    await photo(join(own.root, 'fuji/trips/12.25.poland', 'NEW2.JPG'), '2024:12:15 10:00:00')
    await rescan()
    await expect(offerRow().locator('.event-name')).toHaveText('1 new photo for Poland')
    await offerRow().getByRole('button', { name: 'Add to Poland' }).click()
    await expect(page.locator('.merge-bar')).toContainText('Added 1 photo to “Poland”.')
    await page.locator('.merge-bar').getByRole('button', { name: 'Open album' }).click()
    await expect(page.locator('.grid .tile')).toHaveCount(4)
  } finally {
    rmSync(own.root, { recursive: true, force: true })
  }
})

test('new photos for an album (AC-1, AC-7): albums made by hand get none; deleting the album removes the offer and brings the suggestion back', async () => {
  const own = await poland()
  try {
    await page.evaluate(() => window.api.createAlbum('By hand', null))
    await photo(join(own.root, 'fuji/trips/12.25.poland', 'NEW1.JPG'), '2024:12:14 10:00:00')
    await rescan()
    await nav('Suggested albums').click()
    await expect(offerRow()).toHaveCount(1)
    await expect(offerRow().locator('.event-name')).not.toContainText('By hand')

    await albumsNamed('Poland').hover()
    await albumsNamed('Poland').getByTitle('Delete album').click()
    await page.locator('.confirm').getByRole('button', { name: 'Delete' }).click()
    await expect(albumsNamed('Poland')).toHaveCount(0)
    await expect(offerRow()).toHaveCount(0)
    await expect(card('Poland')).toHaveCount(1)
    await card('Poland').click()
    await expect(page.locator('.grid .tile')).toHaveCount(4)
  } finally {
    rmSync(own.root, { recursive: true, force: true })
  }
})

// --- best photos (spec 0006) ---

/**
 * Runs `body` against a trip library (30 photos in 5 scenes of 6 shots) held in an album called
 * `albumName`, then checks the app changed nothing in it. `hasVectors` says whether the content
 * model analysed the photos (look-alikes need content vectors).
 */
async function withTrip(albumName: string, body: (ctx: { hasVectors: boolean; albumId: number }) => Promise<void>) {
  const trip = await createTripLibrary()
  const tripBefore = fingerprint(trip.root)
  try {
    await app.close()
    await launch(trip.root)
    await chooseLibrary(trip.uniquePhotos)
    const progress = await page.evaluate(() => window.api.getContentProgress())
    const album = await page.evaluate((n) => window.api.createAlbum(n, null), albumName)
    const all = await page.evaluate(() => window.api.queryPhotos({ limit: 100 } as never))
    await page.evaluate(([a, i]) => window.api.addToAlbum(a as number, i as number[]), [album.id, all.photos.map((p: { id: number }) => p.id)] as const)
    await page.reload()
    await body({ hasVectors: progress.phase !== 'unavailable', albumId: album.id })
  } finally {
    await app.close()
    expect(fingerprint(trip.root)).toBe(tripBefore)
    rmSync(trip.root, { recursive: true, force: true })
  }
}

const albumItem = (name: string) => page.locator('.sidebar .nav-item.album', { hasText: name })
const tileCount = () => page.locator('.grid .tile:not(.add-tile)')
const stepperValue = async () => Number(await page.getByLabel('How many photos').inputValue())

test('best of (AC-3, AC-9): the button is disabled with a tooltip under 6 photos, on an album and a suggested album', async () => {
  await chooseLibrary()
  const small = await page.evaluate(() => window.api.createAlbum('Three', null))
  const some = await page.evaluate(() => window.api.queryPhotos({ limit: 3 } as never))
  await page.evaluate(([a, i]) => window.api.addToAlbum(a as number, i as number[]), [small.id, some.photos.map((p: { id: number }) => p.id)] as const)
  await page.reload()
  await albumItem('Three').click()
  await expect(page.locator('.grid .tile')).toHaveCount(3)
  const button = page.getByRole('button', { name: 'Best of', exact: true })
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('title', 'Not enough photos to choose from.')

  await nav('Suggested albums').click()
  await card('Poland').click() // 3 photos
  await expect(page.locator('.grid .tile')).toHaveCount(3)
  await expect(page.getByRole('button', { name: 'Best of', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Best of', exact: true })).toHaveAttribute('title', 'Not enough photos to choose from.')
})

test('best of (AC-3, AC-5, AC-6, AC-7): view, stepper, remove shrinks, Add a photo, Reset, leave prompt, Make album nested, twice', async () => {
  test.setTimeout(240_000)
  await withTrip('Sintra', async () => {
    await albumItem('Sintra').click()
    await expect(tileCount()).toHaveCount(30)
    await page.getByRole('button', { name: 'Best of', exact: true }).click()

    // Title, subtitle, default N = clamp(10% of 30, 12, 60) = 12.
    await expect(page.locator('h1')).toHaveText('Best of Sintra')
    await expect(page.locator('.best-of-bar .subtitle')).toHaveText(/^12 of 30 photos · \d+ moments?$/)
    await expect(tileCount()).toHaveCount(12)
    await expect(page.locator('.add-tile')).toContainText('Add a photo…')
    await expect(page.getByLabel('Focus on…')).toHaveAttribute('placeholder', 'the kids, food, the beach')
    await expect(page.getByRole('button', { name: 'Make album' })).toHaveAttribute(
      'title',
      'Creates a new album with these photos. Nothing is moved or changed on disk.'
    )
    await expect(page.getByRole('button', { name: 'Back to Sintra' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reset' })).toHaveCount(0)
    // Every tile says why (AC-5), in the allowed words.
    const reasons = await tileCount().evaluateAll((els) => els.map((e) => e.getAttribute('title')))
    for (const r of reasons)
      expect(r).toMatch(
        /^(Sharpest of \d+ similar photos|One of \d+ from this moment|The one from this moment|Includes .+|You starred this one|Matches “.+”|Something different from the rest|You chose this one)$/
      )
    // Capture-time order, with day headings (two days).
    await expect.poll(() => page.locator('.grid-divider').count()).toBeGreaterThanOrEqual(2) // the trip spans several days

    // Stepper: + and − change the count; limits are 6 and the set size.
    await page.getByRole('button', { name: 'More photos' }).click()
    await expect(tileCount()).toHaveCount(13)
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible() // a changed count can be reset
    await page.getByLabel('How many photos').fill('6')
    await expect(tileCount()).toHaveCount(6)
    await expect(page.getByRole('button', { name: 'Fewer photos' })).toBeDisabled()
    await page.getByLabel('How many photos').fill('99')
    // At most one photo per look-alike group, so with vectors fewer than 30 can be shown.
    await expect.poll(() => page.locator('.best-of-bar .subtitle').textContent()).toMatch(/ of 30 photos/)
    // The stepper still reads 30 (the set size) though only the distinct photos are shown.
    await expect(page.getByRole('button', { name: 'More photos' })).toBeDisabled()
    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(tileCount()).toHaveCount(12)
    await expect(page.getByRole('button', { name: 'Reset' })).toHaveCount(0)

    // Remove with the tile's ✕ shrinks the pick by one (repeated clicks keep shrinking, never below 6).
    const firstTitle = await tileCount().first().getAttribute('title')
    await tileCount().first().hover()
    await tileCount().first().getByRole('button', { name: 'Remove from this pick' }).click()
    await expect(tileCount()).toHaveCount(11)
    await expect(page.locator('.best-of-bar .subtitle')).toHaveText(/^11 of 30 photos/)
    expect(firstTitle).toBeTruthy()
    await page.getByRole('button', { name: 'Reset' }).waitFor()

    // Add a photo… picks from the rest of the set (the removed one included, none already picked).
    await page.locator('.add-tile').click()
    const picker = page.locator('.modal')
    await expect(picker.locator('.tile')).toHaveCount(30 - 11)
    const addedSrc = await picker.locator('.tile img').first().getAttribute('src')
    await picker.locator('.tile').first().click()
    await expect(picker).toHaveCount(0)
    await expect(page.locator(`.grid .tile img[src="${addedSrc}"]`)).toHaveCount(1) // the added photo is in the pick
    // BUG (reported): removing shrank the pick to 11 but adding does not grow it back; the added photo displaces an automatic one.
    await expect.soft(tileCount(), 'adding a photo should make the pick one bigger').toHaveCount(12)
    const picked = await tileCount().count()

    // Leaving after edits asks first; Stay keeps the view.
    await page.getByRole('button', { name: 'Back to Sintra' }).click()
    await expect(page.locator('.notice-line')).toContainText('Leave without making an album?')
    await page.getByRole('button', { name: 'Stay' }).click()
    await expect(page.locator('.notice-line')).toHaveCount(0)
    await expect(tileCount()).toHaveCount(picked)

    // Make album: a nested "Best of Sintra", the notice, Open album.
    await page.getByRole('button', { name: 'Make album' }).click()
    await expect(page.locator('.notice-line')).toContainText(`Made the album “Best of Sintra” with ${picked} photos.`)
    await expect(page.getByRole('button', { name: 'Make album' })).toBeDisabled() // one click, one album
    const albums = await page.evaluate(() => window.api.listAlbums())
    const source = albums.find((a: { name: string }) => a.name === 'Sintra')
    const made = albums.find((a: { name: string }) => a.name === 'Best of Sintra')
    expect(made).toBeTruthy()
    expect(made.parentId).toBe(source.id)
    expect(made.photoCount).toBe(picked)
    expect(source.photoCount).toBe(30) // the source is unchanged

    // Making it again (after Reset) creates a second album with a numbered name; nothing is overwritten.
    await page.getByRole('button', { name: 'Reset' }).click()
    await page.getByRole('button', { name: 'Make album' }).click()
    await expect(page.locator('.notice-line')).toContainText('Made the album “Best of Sintra 2” with 12 photos.')
    const again = await page.evaluate(() => window.api.listAlbums())
    expect(
      again
        .filter((a: { name: string }) => a.name.startsWith('Best of Sintra'))
        .map((a: { name: string }) => a.name)
        .sort()
    ).toEqual(['Best of Sintra', 'Best of Sintra 2'])

    await page.locator('.notice-line').getByRole('button', { name: 'Open album' }).click()
    await expect(page.locator('h1')).toHaveText('Best of Sintra 2')
    await expect(tileCount()).toHaveCount(12)
    // Back out cleanly: made, so no leave prompt.
    await albumItem('Sintra').first().click()
    await expect(tileCount()).toHaveCount(30)
  })
})

test('best of (AC-5): the viewer shows the reason line; Esc leaves an unedited view; edits last only while open', async () => {
  test.setTimeout(240_000)
  await withTrip('Sintra', async () => {
    await albumItem('Sintra').click()
    await page.getByRole('button', { name: 'Best of', exact: true }).click()
    await expect(tileCount()).toHaveCount(12)
    const title = await tileCount().first().getAttribute('title')
    await tileCount().first().click()
    await expect(page.locator('.best-of-reason')).toHaveText(title!)
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.best-of-reason')).toHaveText((await tileCount().nth(1).getAttribute('title'))!)
    await page.keyboard.press('Escape') // closes the viewer, not the view
    await expect(page.locator('.best-of-reason')).toHaveCount(0)
    await expect(page.locator('h1')).toHaveText('Best of Sintra')
    // The viewer outside a Best of view has no reason line.
    await page.keyboard.press('Escape')
    await expect(page.locator('h1')).toHaveText('Sintra')
    await tileCount().first().click()
    await expect(page.locator('.best-of-reason')).toHaveCount(0)
    await page.keyboard.press('Escape')

    // Edits last until the view closes: remove one, leave, come back to the automatic pick.
    await page.getByRole('button', { name: 'Best of', exact: true }).click()
    await tileCount().first().hover()
    await tileCount().first().getByRole('button', { name: 'Remove from this pick' }).click()
    await expect(tileCount()).toHaveCount(11)
    await page.getByRole('button', { name: 'Back to Sintra' }).click()
    await page.getByRole('button', { name: 'Leave' }).click()
    await expect(page.locator('h1')).toHaveText('Sintra')
    await page.getByRole('button', { name: 'Best of', exact: true }).click()
    await expect(tileCount()).toHaveCount(12)
  })
})

test('best of (AC-3): a suggested album has a Best of view; Make album is a top-level album', async () => {
  test.setTimeout(240_000)
  const trip = await createTripLibrary()
  const tripBefore = fingerprint(trip.root)
  try {
    await app.close()
    await launch(trip.root)
    await chooseLibrary(trip.uniquePhotos)
    await nav('Suggested albums').click()
    await card('Sintra Week').click()
    await expect(page.locator('.grid .tile')).toHaveCount(30)
    await page.getByRole('button', { name: 'Best of', exact: true }).click()
    await expect(page.locator('h1')).toHaveText('Best of Sintra Week')
    await expect(tileCount()).toHaveCount(12)
    await page.getByRole('button', { name: 'Make album' }).click()
    await expect(page.locator('.notice-line')).toContainText('Made the album “Best of Sintra Week” with 12 photos.')
    const made = (await page.evaluate(() => window.api.listAlbums())).find((a: { name: string }) => a.name === 'Best of Sintra Week')
    expect(made.parentId).toBeNull()
    expect(made.photoCount).toBe(12)
    await page.getByRole('button', { name: 'Back to Sintra Week' }).click()
    await expect(page.locator('h1')).toHaveText('Sintra Week')
  } finally {
    await app.close()
    expect(fingerprint(trip.root)).toBe(tripBefore)
    rmSync(trip.root, { recursive: true, force: true })
  }
})

test('best of (AC-2, AC-8): "Show look-alikes together" stacks tiles without changing the album; the stack opens its group', async () => {
  test.setTimeout(240_000)
  await withTrip('Sintra', async ({ hasVectors, albumId }) => {
    await albumItem('Sintra').click()
    await expect(tileCount()).toHaveCount(30)
    const toggle = page.getByLabel('Show look-alikes together')
    await expect(toggle).not.toBeChecked() // off by default
    await toggle.check()
    // Whatever the model finds, the album's count never changes.
    await expect(albumItem('Sintra')).toContainText('30')
    if (!hasVectors) {
      test.info().annotations.push({ type: 'skipped', description: 'content model unavailable: no vectors, so no look-alikes' })
      await expect(tileCount()).toHaveCount(30)
      test.skip(true, 'content model unavailable: look-alike grouping needs content vectors')
    }
    const groups = await page.evaluate((id) => window.api.getLookalikes({ kind: 'album', id }), albumId)
    expect(groups.length).toBeGreaterThan(0)
    const hidden = groups.reduce((n: number, g: number[]) => n + g.length - 1, 0)
    await expect(tileCount()).toHaveCount(30 - hidden)
    await expect(page.locator('.tile .stack-badge')).toHaveCount(groups.length)
    // Groups are chains of one scene: never more than the 6 shots of a cluster's scene, and every group has 2+.
    for (const g of groups) expect(g.length).toBeGreaterThanOrEqual(2)
    expect((await page.evaluate(() => window.api.listAlbums())).find((a: { id: number }) => a.id === albumId).photoCount).toBe(30)

    const badge = page.locator('.tile .stack-badge').first()
    const size = Number(await badge.textContent())
    await badge.click()
    await expect(page.locator('.grid-meta')).toContainText(`${size} similar photos`)
    await expect(page.locator('.grid .tile')).toHaveCount(size)
    await page.locator('.grid-meta').getByRole('button', { name: 'Back' }).click()
    await toggle.uncheck()
    await expect(tileCount()).toHaveCount(30)
    await expect(page.locator('.tile .stack-badge')).toHaveCount(0)
  })
})

test('best of (AC-2, AC-3, AC-6): the Best of view offers a similar photo to swap in; at most one photo per group', async () => {
  test.setTimeout(240_000)
  await withTrip('Sintra', async ({ hasVectors, albumId }) => {
    test.skip(!hasVectors, 'content model unavailable: look-alike grouping needs content vectors')
    await albumItem('Sintra').click()
    await page.getByRole('button', { name: 'Best of', exact: true }).click()
    await expect(tileCount()).toHaveCount(12)
    const groups: number[][] = await page.evaluate((id) => window.api.getLookalikes({ kind: 'album', id }), albumId)
    expect(groups.length).toBeGreaterThan(0)
    const badges = page.locator('.tile .stack-badge')
    await expect(badges.first()).toBeVisible()
    const picked = await page.evaluate(
      async (id) => (await window.api.getBestOf({ source: { kind: 'album', id }, fixed: [], exclude: [] } as never)).photos.map((p: { id: number }) => p.id),
      albumId
    )
    for (const g of groups) expect(picked.filter((id: number) => g.includes(id)).length).toBeLessThanOrEqual(1)

    await badges.first().click()
    const strip = page.locator('.swap-strip')
    await expect(strip).toContainText('Pick another')
    const choices = strip.locator('img')
    await expect(choices.first()).toBeVisible()
    const before = await tileCount().evaluateAll((els) => els.map((e) => e.querySelector('img')!.getAttribute('src')))
    await choices.first().click()
    await expect(strip).toHaveCount(0)
    await expect(tileCount()).toHaveCount(12) // a swap keeps the count
    // The new pick arrives after the click; the count is the same before and after, so wait for the photos to change.
    await expect
      .poll(() => tileCount().evaluateAll((els) => els.map((e) => e.querySelector('img')!.getAttribute('src'))), { timeout: 10_000 })
      .not.toEqual(before)
    await expect(page.locator('.tile .stack-badge').first()).toBeVisible()
  })
})

test('best of (AC-4b): Focus on… refills the pick and clearing returns to the default (or says the model is not ready)', async () => {
  test.setTimeout(240_000)
  await withTrip('Sintra', async ({ hasVectors }) => {
    await albumItem('Sintra').click()
    await page.getByRole('button', { name: 'Best of', exact: true }).click()
    await expect(tileCount()).toHaveCount(12)
    const focus = page.getByLabel('Focus on…')
    await focus.fill('the beach')
    if (!hasVectors) await expect(page.getByText('Search by content isn’t ready yet.')).toBeVisible()
    await expect(tileCount()).toHaveCount(12) // a focus never changes how many
    await page.getByRole('button', { name: 'Clear focus' }).click()
    await expect(focus).toHaveValue('')
    await expect(tileCount()).toHaveCount(12)
    // The focus is not remembered after the view closes.
    await focus.fill('food')
    await page.getByRole('button', { name: 'Back to Sintra' }).click()
    await page.getByRole('button', { name: 'Best of', exact: true }).click()
    await expect(page.getByLabel('Focus on…')).toHaveValue('')
  })
})

test('best of (AC-4a): "Best of settings…" toggles "Lean towards what I star" (on by default) and remembers it', async () => {
  await chooseLibrary()
  await page.getByRole('button', { name: 'Best of settings…' }).click()
  const lean = page.locator('.modal').getByLabel('Lean towards what I star')
  await expect(lean).toBeChecked()
  await expect(page.locator('.modal')).toContainText('Uses only your own stars, on this computer.')
  await expect(page.locator('.modal')).toContainText('you have 0')
  await lean.click()
  // The setting is saved...
  await expect.poll(() => page.evaluate(() => window.api.getLeanTowardsStars())).toMatchObject({ on: false })
  // ...and the checkbox should show it (BUG: LeanDialog reads e.target.checked after an await, when React has
  // already reverted the controlled input, so the box stays ticked although the setting is off).
  await expect(lean).not.toBeChecked()
  await page.locator('.modal').getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.modal')).toHaveCount(0)
  await page.getByRole('button', { name: 'Best of settings…' }).click()
  await expect(page.locator('.modal').getByLabel('Lean towards what I star')).not.toBeChecked()
  expect(await page.evaluate(() => window.api.getLeanTowardsStars())).toMatchObject({ on: false })
})

test('best of (AC-9, AC-11): an empty library and a library with a 0-photo album have no Best of; no data written beside the photos', async () => {
  // Choose the sample library; an empty album shows no stack toggle trouble and a disabled Best of.
  await chooseLibrary()
  await page.evaluate(() => window.api.createAlbum('Empty', null))
  await page.reload()
  await albumItem('Empty').click()
  await expect(page.getByRole('button', { name: 'Best of', exact: true })).toBeDisabled()
  await page.getByLabel('Show look-alikes together').check() // nothing to stack, nothing breaks
  await expect(page.locator('.empty')).toBeVisible()
  // The photo folder's fingerprint is asserted in afterAll for this whole file.
  expect(fingerprint(lib.root)).toBe(before)
})

// --- Spec 0007 QA: save copies to a folder ---

/** Answers the next folder dialogs with `dir` (the default stub answers with the photo folder). */
async function dialogAnswers(dir: string) {
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
  }, dir)
}
const exportDialog = () => page.getByRole('dialog', { name: 'Save copies' })
const newDest = () => mkdtempSync(join(tmpdir(), 'pl-e2e-dest-'))
const selectTiles = async (n: number) => {
  for (let i = 0; i < n; i++) {
    const t = page.locator('.grid .tile').nth(i)
    await t.hover()
    await t.locator('.check').click()
  }
}

test('save copies (AC-1,2,4,7,8,9): selection bar writes numbered JPEGs into a new sub-folder; the photo folder is refused; Done and Show in folder', async () => {
  const dest = newDest()
  try {
    await chooseLibrary()
    // AC-1: nothing selected, no button.
    await expect(page.getByRole('button', { name: 'Save copies…' })).toHaveCount(0)
    await nav('Undated').click() // 2 undated photos
    await selectTiles(2)
    await page.locator('.selection-bar').getByRole('button', { name: 'Save copies…' }).click()
    await expect(exportDialog().locator('h2')).toHaveText('Save copies of 2 photos')
    await expect(exportDialog()).toContainText('Your photo folder is not touched')
    await expect(exportDialog()).toContainText('including where it was taken')
    await expect(exportDialog().getByRole('button', { name: 'Cancel' })).toBeVisible()

    // AC-2: the photo folder itself (the default stub's answer) is refused, nothing written.
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).click()
    await expect(exportDialog().locator('.error')).toHaveText('That folder is inside your photo folder. Choose somewhere else, such as Desktop or Documents.')
    expect(fingerprint(lib.root)).toBe(before)
    expect(readdirSync(lib.root).some((n) => n.startsWith('Photos '))).toBe(false)
    // A sub-folder of the photo folder is refused too.
    await dialogAnswers(join(lib.root, 'house_listing'))
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).click()
    await expect(exportDialog().locator('.error')).toContainText('inside your photo folder')
    expect(fingerprint(lib.root)).toBe(before)

    // A proper destination: new "Photos <date>" sub-folder, 0001.jpg, 0002.jpg (undated, folder-and-name order).
    await dialogAnswers(dest)
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).click()
    await expect(exportDialog()).toContainText(/Saved 2 of 2 copies to Photos \d{4}-\d{2}-\d{2}\./)
    await expect(exportDialog().getByRole('button', { name: 'Show in folder' })).toBeVisible()
    await expect(exportDialog().getByRole('button', { name: 'Done' })).toBeVisible()
    const [sub] = readdirSync(dest)
    expect(sub).toMatch(/^Photos \d{4}-\d{2}-\d{2}$/)
    expect(readdirSync(join(dest, sub)).sort()).toEqual(['0001.jpg', '0002.jpg'])
    for (const f of readdirSync(join(dest, sub)))
      expect(
        readFileSync(join(dest, sub, f))
          .subarray(0, 2)
          .toString('hex')
      ).toBe('ffd8')
    await exportDialog().getByRole('button', { name: 'Done' }).click()
    await expect(exportDialog()).toHaveCount(0)

    // AC-2: the choice is not remembered: asking again opens the dialog again; same name gets a number.
    await page.locator('.selection-bar').getByRole('button', { name: 'Save copies…' }).click()
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).click()
    await expect(exportDialog()).toContainText(/Saved 2 of 2 copies to Photos \d{4}-\d{2}-\d{2} 2\./)
    expect(readdirSync(dest)).toHaveLength(2)
    await exportDialog().getByRole('button', { name: 'Done' }).click()

    // AC-8
    expect(fingerprint(lib.root)).toBe(before)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test('save copies (AC-1,2,3,4,5): album header exports the album and its sub-albums; size limit, date in names, options remembered but not the folder; Esc cancels', async () => {
  const own = await poland()
  const dest = newDest()
  try {
    await dialogAnswers(dest)
    // AC-1: an empty album has no button.
    await page.evaluate(() => window.api.createAlbum('Empty', null))
    await rescan()
    await albumsNamed('Empty').click()
    await expect(page.getByRole('button', { name: 'Save copies…' })).toHaveCount(0)

    await albumsNamed('Poland').click()
    await expect(page.locator('h1')).toHaveText('Poland')
    await page.locator('.header-actions').getByRole('button', { name: 'Save copies…' }).click()
    await expect(exportDialog().locator('h2')).toHaveText('Save copies of 3 photos')

    // Esc before saving cancels, writes nothing.
    await page.keyboard.press('Escape')
    await expect(exportDialog()).toHaveCount(0)
    expect(readdirSync(dest)).toHaveLength(0)

    // Options: 100 px limit isn't offered; choose 1600 (photos are 300x200, so not enlarged) and the date.
    await page.locator('.header-actions').getByRole('button', { name: 'Save copies…' }).click()
    await expect(exportDialog().locator('select option')).toHaveText(['Original size', '4000 px', '2000 px', '1600 px'])
    await exportDialog().locator('select').selectOption('1600')
    await exportDialog().getByLabel('Add the date to file names').check()
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).press('Enter')
    await expect(exportDialog()).toContainText(/Saved 3 of 3 copies to Poland \d{4}-\d{2}-\d{2}\./)
    const sub = join(dest, readdirSync(dest)[0])
    const names = readdirSync(sub).sort()
    expect(names).toHaveLength(3)
    expect(names[0]).toMatch(/^0001 2024-12-13 1000\.jpg$/)
    expect(names[2]).toMatch(/^0003 2024-12-13 1200\.jpg$/)
    const orig_path = join(own.root, 'fuji/trips/12.25.poland', 'DSCF020.JPG')
    const orig = readFileSync(orig_path)
    expect(readFileSync(join(sub, names[0])).equals(orig)).toBe(false) // re-encoded, not copied byte for byte
    await exportDialog().getByRole('button', { name: 'Done' }).click()

    // Options are remembered; the destination is not (the dialog still asks via the folder dialog).
    await page.locator('.header-actions').getByRole('button', { name: 'Save copies…' }).click()
    await expect(exportDialog().locator('select')).toHaveValue('1600')
    await expect(exportDialog().getByLabel('Add the date to file names')).toBeChecked()
    await exportDialog().locator('select').selectOption('0')
    await exportDialog().getByLabel('Add the date to file names').uncheck()
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).click()
    await expect(exportDialog()).toContainText(/Saved 3 of 3 copies to Poland \d{4}-\d{2}-\d{2} 2\./)
    const sub2 = join(
      dest,
      readdirSync(dest).find((n) => n.endsWith(' 2'))!
    )
    expect(readdirSync(sub2).sort()).toEqual(['0001.jpg', '0002.jpg', '0003.jpg'])
    // Original size JPEG: byte for byte.
    expect(readFileSync(join(sub2, '0001.jpg')).equals(orig)).toBe(true)
    await exportDialog().getByRole('button', { name: 'Done' }).click()
    expect(readFileSync(orig_path)).toEqual(orig) // untouched
  } finally {
    rmSync(own.root, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})

test('save copies (AC-6,7): Cancel while saving keeps the dialog usable and says how many were saved; a file missing from disk is skipped and listed', async () => {
  const own = await createLibrary()
  const dest = newDest()
  try {
    await app.close()
    await launch(own.root)
    await chooseLibrary(own.uniquePhotos)
    const ownBefore = fingerprint(own.root)

    // Cancel: the folder dialog is slow, so the dialog sits in its "saving" state and Cancel is pressed there.
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => {
        await new Promise((r) => setTimeout(r, 1500))
        return { canceled: false, filePaths: [dir] }
      }) as typeof dialog.showOpenDialog
    }, dest)
    await nav('Undated').click()
    await selectTiles(2)
    await page.locator('.selection-bar').getByRole('button', { name: 'Save copies…' }).click()
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).click()
    await expect(exportDialog().locator('h2')).toHaveText('Saving copies')
    await exportDialog().getByRole('button', { name: 'Cancel' }).dblclick() // repeated clicks are harmless
    await expect(exportDialog()).toContainText('Stopped. 0 copies were saved.')
    await expect(exportDialog().getByRole('button', { name: 'Show in folder' })).toHaveCount(0)
    await exportDialog().getByRole('button', { name: 'Done' }).click()

    // A photo deleted from disk after the scan: skipped, listed, the rest saved.
    rmSync(join(own.root, 'house_listing', 'scan0.jpg'))
    await dialogAnswers(dest) // the two photos are still selected
    await page.locator('.selection-bar').getByRole('button', { name: 'Save copies…' }).click()
    await exportDialog().getByRole('button', { name: 'Choose folder…' }).click()
    await expect(exportDialog()).toContainText(/Saved 1 of 2 copies to Photos/)
    await expect(exportDialog().locator('.skipped-list li')).toHaveText(["scan0.jpg (couldn't be read)"])
    await expect(exportDialog().getByRole('button', { name: 'Show in folder' })).toBeVisible()
    const subs = readdirSync(dest).sort()
    // Known minor: the cancelled run left its (empty) folder behind.
    expect(subs).toHaveLength(2)
    expect(readdirSync(join(dest, subs[0]))).toEqual([])
    expect(readdirSync(join(dest, subs[1]))).toEqual(['0002.jpg']) // known minor: a skipped photo leaves a gap in the numbering
    await exportDialog().getByRole('button', { name: 'Done' }).click()
    expect(ownBefore).not.toBe(fingerprint(own.root)) // only because the test itself deleted scan0.jpg
  } finally {
    rmSync(own.root, { recursive: true, force: true })
    rmSync(dest, { recursive: true, force: true })
  }
})

// --- assistant access (spec 0008) ---

/** Runs the relay exactly as the Claude Desktop setup shown in the dialog says; returns a JSON-RPC caller. */
function assistantFrom(desktopJson: string) {
  const entry = JSON.parse(desktopJson).mcpServers['photo-library']
  expect(entry.command).toBe('node')
  const proc = spawn(process.execPath, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let buf = ''
  const waiting = new Map<number, (m: any) => void>()
  proc.stdout!.setEncoding('utf8').on('data', (c: string) => {
    out += c
    buf += c
    let at
    while ((at = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, at))
      buf = buf.slice(at + 1)
      waiting.get(m.id)?.(m)
    }
  })
  let id = 0
  const rpc = (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const myId = ++id
      const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 5000)
      waiting.set(myId, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
    })
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const m = await rpc('tools/call', { name, arguments: args })
    if (m.error) return { rpcError: m.error.message as string }
    return m.result.isError ? { error: m.result.content[0].text as string } : JSON.parse(m.result.content[0].text)
  }
  return { proc, rpc, tool, out: () => out }
}

test('assistant access (spec 0008): off by default; the shown setup connects; all its tools; live AI album; turning off cuts it', async () => {
  await chooseLibrary()
  const link = page.locator('.sidebar-footer').getByRole('button', { name: 'Assistant access…' })
  await expect(link).toBeVisible()
  await link.click()
  const dialog = page.getByRole('dialog', { name: 'Assistant access' })
  const toggle = dialog.getByLabel('Let AI assistants use this library')
  await expect(toggle).not.toBeChecked()
  await expect(dialog.getByText('Set up an assistant')).toHaveCount(0)
  await toggle.check()
  await expect(dialog.getByText('Set up an assistant')).toBeVisible({ timeout: 2000 })
  await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Assistant access (on)…' })).toBeVisible()
  const desktopJson = (await dialog.getByLabel('Claude Desktop setup').textContent())!
  await expect(dialog.getByLabel('Claude Code setup')).toContainText('claude mcp add --scope user')
  await dialog.getByRole('button', { name: 'Copy' }).first().click()
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(desktopJson)

  const a = assistantFrom(desktopJson)
  try {
    expect(
      (await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })).result.serverInfo.name
    ).toBe('photo-library')
    expect((await a.rpc('tools/list')).result.tools).toHaveLength(8)
    const overview = await a.tool('library_overview')
    expect(overview.photos).toBe(lib.uniquePhotos)
    const all = await a.tool('search_photos', { limit: 200 })
    expect(all.total).toBe(lib.uniquePhotos)
    expect((await a.tool('search_photos', { text: 'secret' })).total).toBe(0) // private folders stay invisible
    const ids = all.photos.map((p: { id: number }) => p.id)
    const made = await a.tool('create_album', { name: 'Picked by Claude', photo_ids: ids.slice(0, 2) })
    expect(made.added).toBe(2)
    // The album appears in the open window within a second, marked.
    const row = page.locator('.sidebar .nav-item.album', { hasText: 'Picked by Claude' })
    await expect(row).toBeVisible({ timeout: 1000 })
    await expect(row.locator('.ai-pill')).toHaveText('AI')
    expect((await a.tool('add_to_album', { album_id: made.album_id, photo_ids: [ids[2]] })).added).toBe(1)
    expect((await a.tool('remove_from_album', { album_id: made.album_id, photo_ids: [ids[0]] })).removed).toBe(1)
    await expect(row.locator('.count')).toHaveText('2', { timeout: 1000 })
    // Nothing about files or folders reaches the assistant.
    for (const leak of [lib.root, 'secret', '.jpg', '.JPG', 'fuji']) expect(a.out()).not.toContain(leak)

    // Turned off: the assistant is told to turn it back on.
    await toggle.uncheck()
    await expect(dialog.getByText('Set up an assistant')).toHaveCount(0)
    const off = await a.tool('library_overview')
    expect(off.rpcError).toMatch(/Open Photo Library and turn on assistant access|turned off/)
    await dialog.getByRole('button', { name: 'Done' }).click()

    // The owner opens the album: the subtitle says who made it.
    await row.click()
    await expect(page.locator('.content-header .subtitle')).toContainText('Made by an AI assistant')

    // Choosing a different photo folder turns access off (AC-1).
    await link.click()
    await toggle.check()
    await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Assistant access (on)…' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Done' }).click()
    const other = mkdtempSync(join(tmpdir(), 'pl-e2e-other-'))
    try {
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
      }, other)
      await page.getByRole('button', { name: /Change folder/ }).click()
      await expect(page.locator('.sidebar-footer').getByRole('button', { name: 'Assistant access…' })).toBeVisible()
      expect((await page.evaluate(() => window.api.getAssistantAccess())).state).toBe('off')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  } finally {
    a.proc.kill()
  }
})

test('assistant best of (spec 0009, AC-7, AC-8, AC-10, AC-12): a year to an AI album, best_of, a proposal the owner adjusts and approves; Back closes the next', async () => {
  test.setTimeout(240_000)
  await withTrip('Sintra', async ({ hasVectors }) => {
    test.skip(!hasVectors, 'content model unavailable: swapping needs look-alike groups')
    const status = await page.evaluate(() => window.api.setAssistantAccess(true))
    expect(status.state).toBe('on')
    const a = assistantFrom(status.desktopJson!)
    try {
      await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
      expect((await a.rpc('tools/list')).result.tools).toHaveLength(8)
      expect((await a.tool('library_overview')).photos).toBeGreaterThan(0)
      const year = await a.tool('search_photos', { from: '2026-01-01', to: '2026-12-31', limit: 200 })
      const made = await a.tool('create_album', { name: '2026 by Claude', photo_ids: year.photos.map((p: { id: number }) => p.id) })
      const best = await a.tool('best_of', { album_id: made.album_id, count: 12 })
      expect(best.photos).toHaveLength(12)
      const pick: number[] = best.photos.map((p: { id: number }) => p.id)
      const proposal = await a.tool('propose_selection', { album_id: made.album_id, photo_ids: pick })
      expect(proposal.status).toBe('waiting')

      // The window shows exactly the assistant's pick, said to be a proposal.
      await expect(page.getByRole('heading', { name: 'Best of 2026 by Claude' })).toBeVisible({ timeout: 2000 })
      await expect(page.locator('.content-header .subtitle')).toContainText('Picked by your AI assistant for you to look over')
      await expect(tileCount()).toHaveCount(12)
      const shown = () => tileCount().evaluateAll((els) => els.map((e) => Number(e.querySelector('img')!.getAttribute('src')!.split('/').pop())))
      expect([...(await shown())].sort((x, y) => x - y)).toEqual([...pick].sort((x, y) => x - y))
      await expect(tileCount().first()).toHaveAttribute('title', 'Picked by your AI assistant')
      expect(await page.getByLabel('How many photos').inputValue()).toBe('12')
      await expect(page.getByRole('button', { name: 'Reset' })).toHaveCount(0)

      // The owner swaps one from its look-alikes and removes another, then makes the album.
      const stacked = tileCount()
        .filter({ has: page.locator('.stack-badge') })
        .first()
      const swappedOut = Number((await stacked.locator('img').getAttribute('src'))!.split('/').pop())
      await stacked.locator('.stack-badge').click()
      const choice = page.locator('.swap-strip img').first()
      const swappedIn = Number((await choice.getAttribute('src'))!.split('/').pop())
      await choice.click()
      await expect.poll(shown, { timeout: 10_000 }).toContain(swappedIn)
      await expect(tileCount().filter({ has: page.locator(`img[src$="/${swappedIn}"]`) })).toHaveAttribute('title', 'You chose this one')
      const removed = (await shown()).find((id) => id !== swappedIn)!
      await tileCount()
        .filter({ has: page.locator(`img[src$="/${removed}"]`) })
        .getByRole('button', { name: 'Remove from this pick' })
        .click()
      await expect(tileCount()).toHaveCount(11)
      await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible()
      expect((await a.tool('proposal_status', { proposal_id: proposal.proposal_id })).edited).toBe(true)
      await page.getByRole('button', { name: 'Make album' }).click()
      await expect(page.locator('.notice-line')).toContainText('Made the album “Best of 2026 by Claude” with 11 photos.')
      await expect(page.locator('.content-header .subtitle')).toContainText("The album is yours; the assistant can't change it.")
      const approved = await a.tool('proposal_status', { proposal_id: proposal.proposal_id })
      expect(approved).toMatchObject({ status: 'approved', name: 'Best of 2026 by Claude', photos: 11, kept: 10, added: [swappedIn] })
      expect([...approved.removed].sort()).toEqual([removed, swappedOut].sort())
      expect((await a.tool('add_to_album', { album_id: approved.album_id, photo_ids: [pick[0]] })).error).toMatch(/owner's/)

      // A second proposal, which the owner leaves with Back: closed, and no album made.
      const albumsBefore = (await page.evaluate(() => window.api.listAlbums())).length
      const second = await a.tool('propose_selection', { album_id: made.album_id, photo_ids: pick })
      await expect(page.locator('.notice-line')).toContainText('Your AI assistant sent a new pick.', { timeout: 2000 })
      expect((await a.tool('proposal_status', { proposal_id: proposal.proposal_id })).status).toBe('approved')
      await page.getByRole('button', { name: 'Back to 2026 by Claude' }).click()
      await expect.poll(async () => (await a.tool('proposal_status', { proposal_id: second.proposal_id })).status).toBe('closed')
      expect((await page.evaluate(() => window.api.listAlbums())).length).toBe(albumsBefore)
      expect((await a.tool('remove_from_album', { album_id: made.album_id, photo_ids: [pick[0]] })).removed).toBe(1)
      for (const leak of ['sintra_week', '.JPG', 'S0_', 'One0']) expect(a.out()).not.toContain(leak)
    } finally {
      a.proc.kill()
    }
  })
})

test('assistant best of (spec 0009, AC-7, AC-9, AC-11): a new pick over edits asks first; Stay closes it, Leave replaces; access off keeps the screen', async () => {
  await chooseLibrary()
  const status = await page.evaluate(() => window.api.setAssistantAccess(true))
  const a = assistantFrom(status.desktopJson!)
  try {
    await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
    const all = (await a.tool('search_photos', { limit: 200 })).photos.map((p: { id: number }) => p.id)
    const album = await a.tool('create_album', { name: 'Iceland', photo_ids: all })
    const propose = async () => (await a.tool('propose_selection', { album_id: album.album_id, photo_ids: all.slice(0, 7) })).proposal_id as number
    const state = async (id: number) => (await a.tool('proposal_status', { proposal_id: id })).status
    const first = await propose()
    await expect(tileCount()).toHaveCount(7, { timeout: 2000 })
    await tileCount().first().getByRole('button', { name: 'Remove from this pick' }).click()
    await expect(tileCount()).toHaveCount(6)

    const second = await propose()
    const prompt = page.locator('.notice-line', { hasText: 'Your AI assistant sent a new pick of “Iceland”. Leave without making an album?' })
    await expect(prompt).toBeVisible({ timeout: 2000 })
    await expect(tileCount()).toHaveCount(6) // the owner's screen is untouched
    await prompt.getByRole('button', { name: 'Stay' }).click()
    await expect(prompt).toHaveCount(0)
    expect(await state(second)).toBe('closed')
    expect(await state(first)).toBe('waiting')

    const third = await propose()
    await expect(prompt).toBeVisible({ timeout: 2000 })
    await prompt.getByRole('button', { name: 'Leave' }).click()
    await expect(tileCount()).toHaveCount(7)
    expect(await a.tool('proposal_status', { proposal_id: first })).toMatchObject({ status: 'replaced', by_proposal_id: third })

    // Access off: the screen stays, now an ordinary Best of; the proposal has expired.
    await tileCount().first().getByRole('button', { name: 'Remove from this pick' }).click()
    await page.evaluate(() => window.api.setAssistantAccess(false))
    await expect(page.locator('.content-header .subtitle')).toContainText("Assistant access is off, so your assistant won't hear what you decide.")
    await expect(tileCount()).toHaveCount(6)
    await expect(page.getByRole('button', { name: 'Make album' })).toBeEnabled()
    const again = await page.evaluate(() => window.api.setAssistantAccess(true))
    const b = assistantFrom(again.desktopJson!)
    try {
      await b.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
      expect((await b.tool('proposal_status', { proposal_id: third })).status).toBe('expired')
      // Deleting the source album while a proposal shows leaves the screen and closes the proposal (AC-9).
      const fourth = (await b.tool('propose_selection', { album_id: album.album_id, photo_ids: all.slice(0, 7) })).proposal_id
      await expect(prompt).toBeVisible({ timeout: 2000 }) // the screen still has the owner's edit
      const row = albumItem('Iceland')
      await row.hover()
      await row.getByTitle('Delete album').click()
      await page.locator('.sidebar .confirm').getByRole('button', { name: 'Delete' }).click()
      await expect(page.getByRole('heading', { name: 'Best of Iceland' })).toHaveCount(0)
      await expect(prompt).toHaveCount(0)
      expect((await b.tool('proposal_status', { proposal_id: fourth })).status).toBe('closed')
    } finally {
      b.proc.kill()
    }
  } finally {
    a.proc.kill()
  }
})

test('assistant best of (QA, AC-7, AC-8): a proposal restores a minimised window; − stops at the pick; Reset returns to the proposal', async () => {
  await chooseLibrary()
  const status = await page.evaluate(() => window.api.setAssistantAccess(true))
  const a = assistantFrom(status.desktopJson!)
  try {
    await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
    const all: number[] = (await a.tool('search_photos', { limit: 200 })).photos.map((p: { id: number }) => p.id)
    const album = await a.tool('create_album', { name: 'Faroe', photo_ids: all })
    const windowState = () =>
      app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows()[0]
        return { minimized: w.isMinimized(), visible: w.isVisible() }
      })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await expect.poll(async () => (await windowState()).minimized).toBe(true)

    const pick = all.slice(0, 7)
    const id = (await a.tool('propose_selection', { album_id: album.album_id, photo_ids: pick })).proposal_id
    await expect.poll(windowState, { timeout: 2000 }).toEqual({ minimized: false, visible: true })
    await expect(tileCount()).toHaveCount(7, { timeout: 2000 })
    const shown = async () =>
      (await tileCount().evaluateAll((els) => els.map((e) => Number(e.querySelector('img')!.getAttribute('src')!.split('/').pop())))).sort((x, y) => x - y)
    expect(await shown()).toEqual([...pick].sort((x, y) => x - y))

    // − can't drop the assistant's picks; + adds the engine's own.
    const fewer = page.getByRole('button', { name: 'Fewer photos' })
    await expect(fewer).toBeDisabled()
    await expect(fewer).toHaveAttribute('title', 'To show fewer, remove photos with ✕')
    await page.getByRole('button', { name: 'More photos' }).click()
    await expect(tileCount()).toHaveCount(8)
    for (const p of pick) await expect(tileCount().filter({ has: page.locator(`img[src$="/${p}"]`) })).toHaveCount(1)
    await expect.poll(async () => (await a.tool('proposal_status', { proposal_id: id })).edited).toBe(true)

    // Reset goes back to the assistant's pick, not the automatic one, and it is unedited again.
    await page.getByRole('button', { name: 'Reset' }).click()
    await expect(tileCount()).toHaveCount(7)
    expect(await shown()).toEqual([...pick].sort((x, y) => x - y))
    await expect(page.getByRole('button', { name: 'Reset' })).toHaveCount(0)
    await expect.poll(async () => (await a.tool('proposal_status', { proposal_id: id })).edited).toBe(false)
  } finally {
    a.proc.kill()
  }
})

test('assistant best of (QA, AC-7, macOS): with the window closed, a proposal opens a new one showing the pick', async () => {
  test.skip(process.platform !== 'darwin', 'only macOS keeps running with no window open')
  await chooseLibrary()
  const status = await page.evaluate(() => window.api.setAssistantAccess(true))
  const a = assistantFrom(status.desktopJson!)
  try {
    await a.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } })
    const all: number[] = (await a.tool('search_photos', { limit: 200 })).photos.map((p: { id: number }) => p.id)
    const album = await a.tool('create_album', { name: 'Lofoten', photo_ids: all })
    const old = (await a.tool('propose_selection', { album_id: album.album_id, photo_ids: all.slice(0, 6) })).proposal_id
    await expect(tileCount()).toHaveCount(6, { timeout: 2000 })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
    expect((await a.tool('proposal_status', { proposal_id: old })).status).toBe('closed')

    const opened = app.waitForEvent('window')
    await a.tool('propose_selection', { album_id: album.album_id, photo_ids: all.slice(0, 7) })
    page = await opened
    await expect(page.getByRole('heading', { name: 'Best of Lofoten' })).toBeVisible({ timeout: 5000 })
    await expect(tileCount()).toHaveCount(7)
  } finally {
    a.proc.kill()
  }
})

test('assistant access (spec 0008, AC-6, AC-7): forgetting in the dialog cuts off the old setup; a data folder too long for a socket says why and the app works on', async () => {
  await chooseLibrary()
  const footer = page.locator('.sidebar-footer')
  await footer.getByRole('button', { name: 'Assistant access…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Assistant access' })
  const toggle = dialog.getByLabel('Let AI assistants use this library')
  await toggle.check()
  const oldJson = (await dialog.getByLabel('Claude Desktop setup').textContent())!
  const a = assistantFrom(oldJson)
  try {
    expect((await a.tool('library_overview')).photos).toBe(lib.uniquePhotos)
    await dialog.getByRole('button', { name: 'Forget connected assistants…' }).click()
    await dialog.getByRole('button', { name: 'Forget', exact: true }).click()
    await expect(dialog.getByText('Done. Copy the setup again')).toBeVisible()
    await expect(dialog.getByLabel('Claude Desktop setup')).not.toHaveText(oldJson)
    expect((await a.tool('library_overview')).rpcError).toBe("This assistant's setup is out of date: copy it again from Photo Library's settings")
    const b = assistantFrom((await dialog.getByLabel('Claude Desktop setup').textContent())!)
    try {
      expect((await b.tool('library_overview')).photos).toBe(lib.uniquePhotos)
    } finally {
      b.proc.kill()
    }
  } finally {
    a.proc.kill()
  }
  await dialog.getByRole('button', { name: 'Done' }).click()

  // A Unix socket path has a length limit (named pipes don't).
  if (process.platform === 'win32') return
  await app.close()
  rmSync(dataDir, { recursive: true, force: true })
  dataDir = mkdtempSync(join(tmpdir(), `pl-e2e-${'long'.repeat(25)}-`))
  await launch(lib.root, NO_MODELS())
  await chooseLibrary()
  // Locators belong to the old window: look again in the new one.
  const footer2 = page.locator('.sidebar-footer')
  const dialog2 = page.getByRole('dialog', { name: 'Assistant access' })
  const toggle2 = dialog2.getByLabel('Let AI assistants use this library')
  await footer2.getByRole('button', { name: 'Assistant access…' }).click()
  await toggle2.check()
  await expect(dialog2.getByText("Couldn't start assistant access: the app's data folder path is too long for this system.")).toBeVisible()
  await expect(toggle2).not.toBeChecked()
  await expect(footer2.getByRole('button', { name: "Assistant access (couldn't start)…" })).toBeVisible()
  await dialog2.getByRole('button', { name: 'Done' }).click()
  await expect(footer2.getByRole('button', { name: 'Assistant access…' })).toBeVisible()
  // The rest of the app works normally.
  await expect(page.locator('.scan-status')).toContainText(`${lib.uniquePhotos} photos`)
  await expect(page.locator('.grid .tile')).toHaveCount(lib.uniquePhotos)
})
