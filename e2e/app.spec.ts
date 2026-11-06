// End-to-end: the real built app, driven like a user, against a synthetic library.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLibrary, fingerprint, type Library } from './library.ts'

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

test('a trip split over several days can be merged into one event', async () => {
  await chooseLibrary()
  await nav('Events & trips').click()
  const days = page.locator('.event-card', { hasText: /(Jul|Aug) 2026/ })
  await expect(days).toHaveCount(3)
  for (const card of await days.all()) await card.click({ modifiers: ['ControlOrMeta'] })
  await page.getByRole('button', { name: 'Merge into one trip' }).click()
  await page.locator('.inline-input').fill('Norway')
  await page.locator('.inline-input').press('Enter')
  await expect(page.locator('h1')).toHaveText('Norway')
  await expect(page.locator('.grid .tile')).toHaveCount(3)

  await nav('Events & trips').click()
  await expect(page.locator('.event-card', { hasText: 'Norway' })).toHaveCount(1)
})

test('ignoring a folder removes its photos from the library', async () => {
  await chooseLibrary()
  await page.getByRole('button', { name: 'Ignored folders…' }).click()
  await page.getByPlaceholder('e.g. private').fill('house_listing')
  await page.getByRole('button', { name: 'Add name' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('.scan-status')).toContainText(`${lib.uniquePhotos - 2} photos`)
})
