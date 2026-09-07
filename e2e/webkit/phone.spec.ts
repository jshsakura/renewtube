// The phone, in WebKit. What Chromium wearing an iPhone user agent cannot
// tell us: whether a press starts sound here, whether the picture has a box,
// and whether anything of YouTube's paints over ours.

import { expect, test } from '@playwright/test'
import { app, inject } from './fixture.ts'

test('mounts on the mobile site, and nothing of YouTube paints over it', async ({ context, page }) => {
  await inject(context, page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.goto('https://m.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await expect(app(page).locator('.app.narrow')).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(2500)
  expect(errors).toEqual([])
  const onTop = await page.evaluate(() => {
    const bad: string[] = []
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 12; j++) {
        const el = document.elementFromPoint(Math.round(((i + 0.5) / 8) * innerWidth), Math.round(((j + 0.5) / 12) * innerHeight))
        if (!el) continue
        const tag = el.tagName.toLowerCase()
        if (tag === 'oc-easy-mode' || tag === 'oc-easy-mode-overlay' || tag === 'html' || tag === 'body') continue
        if (el.closest('#movie_player, #player-control-container, bottom-sheet-container')) continue
        if (bad.length < 6) bad.push(`${tag}#${el.id}`)
      }
    return bad
  })
  expect(onTop).toEqual([])
})

test('a track pressed on home plays here, and 영상 mode shows a picture', async ({ context, page }) => {
  await inject(context, page)
  await page.goto('https://m.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const ui = app(page)
  await expect(ui.locator('.app.narrow')).toBeVisible({ timeout: 60_000 })
  await ui.locator('.tile:not([aria-hidden])').first().click()
  await ui.locator('.rows .row:not([aria-hidden])').nth(1).locator('.meta').click()
  // WebKit starts media only from a press. The press on the row is that press,
  // and it only counts if playback happens here rather than after a page load.
  await expect
    .poll(() => page.evaluate(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0.5 }), { timeout: 25_000 })
    .toBe(true)
  expect(new URL(page.url()).pathname).toBe('/')
  await ui.locator('.bar .now').click()
  await ui.locator('button[title="화면 보기"]:visible').first().click()
  await expect
    .poll(() => page.evaluate(() => document.querySelector('video')!.getBoundingClientRect().width), { timeout: 15_000 })
    .toBeGreaterThan(300)
  // And it kept playing through the change of layout.
  await expect
    .poll(() => page.evaluate(() => { const v = document.querySelector('video')!; return !v.paused }), { timeout: 10_000 })
    .toBe(true)

  // Now hide it again, which is where the owner's screen broke: the parked
  // picture came back painted over the list. It has to leave the screen
  // altogether, and the sound has to stay.
  // Out of the full player first: with the stage up the picture is seated in
  // the sheet, over the very button that would put it away.
  await ui.locator('.sheetClose').click()
  await ui.locator('.bar .vid').click()
  await expect(ui.locator('.slot')).toHaveClass(/hidden/)
  await expect
    .poll(() => page.evaluate(() => Math.round(document.getElementById('movie_player')!.getBoundingClientRect().right)), { timeout: 10_000 })
    .toBeLessThanOrEqual(0)
  expect(await page.evaluate(() => { const v = document.querySelector('video')!; return !v.paused })).toBe(true)
})

test('the settings sheet opens and the menu switches work here too', async ({ context, page }) => {
  await inject(context, page)
  await page.goto('https://m.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const ui = app(page)
  await expect(ui.locator('.app.narrow')).toBeVisible({ timeout: 60_000 })
  await ui.locator('.drawerToggle').click()
  await ui.locator('.sideHead .gear').click()
  const sheet = page.locator('oc-easy-mode-overlay .modal.settings')
  await expect(sheet).toBeVisible()
  await sheet.locator('.setToggle', { hasText: '게임' }).click()
  await expect(sheet.locator('.setToggle', { hasText: '게임' })).toHaveAttribute('aria-checked', 'true')
  await sheet.locator('.modalClose').click()
  await ui.locator('.drawerToggle').click()
  await expect(ui.locator('.nav', { hasText: '게임' })).toBeVisible()
})
