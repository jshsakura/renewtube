// The personal playlist library: a bounded page, a useful order, and cards
// that remain dense on a phone.
//
// A signed-out browser has no honest version of this screen, so the view is
// bundled into a plain document and handed the same Playlist objects the
// authenticated endpoint would have returned. The DOM and stylesheet are the
// product's; only the account-bound request is replaced.

import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

let bundle = ''

test.beforeAll(async () => {
  const built = await build({
    stdin: {
      contents: `export { render } from '${resolve(import.meta.dirname, '../src/main/ui/views.ts')}'
                 export { STYLES } from '${resolve(import.meta.dirname, '../src/main/ui/styles.ts')}'`,
      resolveDir: resolve(import.meta.dirname, '..'),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    globalName: '__playlists',
    write: false,
    target: 'es2022',
  })
  bundle = built.outputFiles[0]!.text
})

async function library(page: import('@playwright/test').Page): Promise<void> {
  await page.setContent('<div id="host"></div>')
  await page.evaluate(bundle)
  await page.evaluate(async () => {
    const api = (window as unknown as {
      __playlists: { render(ctx: unknown, main: HTMLElement): Promise<void>; STYLES: string }
    }).__playlists
    const root = document.getElementById('host')!.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = api.STYLES
    const main = document.createElement('main')
    main.id = 'main'
    main.className = 'main'
    root.append(style, main)
    const playlists = Array.from({ length: 27 }, (_, i) => ({
      id: `PL${i + 1}`,
      title: `Playlist ${String(27 - i).padStart(2, '0')}`,
      subtitle: `${i + 1} tracks`,
    }))
    const ctx = {
      view: { kind: 'playlists' },
      playlists,
      refreshPlaylists: async () => {},
      addToPlaylist: async () => null,
      go: (view: unknown) => { (window as unknown as { __opened?: unknown }).__opened = view },
    }
    await api.render(ctx, main)
  })
}

test('the playlist library pages twelve cards and sorts from the first page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await library(page)
  const cards = page.locator('.playlistCard:not([aria-hidden])')
  await expect(cards).toHaveCount(12)
  await expect(page.locator('.playlistPage')).toHaveText('1 / 3')
  await expect(cards.first().locator('.title')).toHaveText('Playlist 27')

  await page.getByRole('button', { name: '다음' }).click()
  await expect(page.locator('.playlistPage')).toHaveText('2 / 3')
  await expect(cards.first().locator('.title')).toHaveText('Playlist 15')

  await page.locator('.playlistSortSelect').selectOption('name')
  await expect(page.locator('.playlistPage')).toHaveText('1 / 3')
  await expect(cards.first().locator('.title')).toHaveText('Playlist 01')
  await page.locator('.playlistSortSelect').selectOption('name-desc')
  await expect(cards.first().locator('.title')).toHaveText('Playlist 27')

  await cards.first().click()
  expect(await page.evaluate(() => (window as unknown as { __opened?: unknown }).__opened)).toEqual({
    kind: 'playlist', id: 'PL1', title: 'Playlist 27',
  })
})

test('playlist cards use two columns on a wide pane and one on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await library(page)
  const cards = page.locator('.playlistCard:not([aria-hidden])')
  const first = (await cards.nth(0).boundingBox())!
  const second = (await cards.nth(1).boundingBox())!
  expect(Math.round(first.y)).toBe(Math.round(second.y))
  expect(second.x).toBeGreaterThan(first.x + first.width)

  await page.setViewportSize({ width: 390, height: 844 })
  const narrowFirst = (await cards.nth(0).boundingBox())!
  const narrowSecond = (await cards.nth(1).boundingBox())!
  const narrowGrid = (await page.locator('.playlistGrid').boundingBox())!
  expect(narrowSecond.y).toBeGreaterThan(narrowFirst.y + narrowFirst.height - 1)
  expect(Math.abs(narrowFirst.width - narrowGrid.width)).toBeLessThan(1)
})
