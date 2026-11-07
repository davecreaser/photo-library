// End-to-end: the real built app, driven like a user, against a synthetic library.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContentLibrary, createEdgeLibrary, createLibrary, photo, createManyFoldersLibrary, fingerprint, LONG_FOLDER, type Library } from './library.ts'

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
