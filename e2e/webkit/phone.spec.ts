// The phone, in WebKit. What Chromium wearing an iPhone user agent cannot
// tell us: whether a press starts sound here, whether the picture has a box,
// and whether anything of YouTube's paints over ours.

import { expect, test, type Page } from '@playwright/test'
import { app, inject } from './fixture.ts'

async function expectPlayerLiftedOrParked(page: Page, transition: string): Promise<void> {
  const state = await page.evaluate(() => {
    const player = document.getElementById('movie_player')
    if (!player) return null
    const box = player.getBoundingClientRect()
    return {
      left: Math.round(box.left),
      right: Math.round(box.right),
      z: getComputedStyle(document.documentElement).getPropertyValue('--oc-z').trim(),
    }
  })
  expect(state, `${transition}: the page still owns a player`).not.toBeNull()
  if (state!.right > 0) {
    expect(state!.z, `${transition}: an on-screen player is lifted above the app`).toBe('2147482100')
  } else {
    expect(state!.right, `${transition}: a parked player has no pixel on screen`).toBeLessThanOrEqual(0)
    expect(state!.left, `${transition}: a parked player uses the far-left berth`).toBeLessThanOrEqual(-19000)
  }
}

test('mounts on the mobile site, and nothing of YouTube paints over it', async ({ context, page }) => {
  await inject(context, page)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.goto('https://m.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await expect(app(page).locator('.app.narrow')).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(2500)
  expect(errors).toEqual([])
  const onTop = await page.evaluate(() => {
    // The picture is allowed on top only where we put it — see the same rule
    // in e2e/00-safety. Waving the player through wherever it lands is how a
    // parked picture painted across the list without a single test noticing.
    const slot = (document.querySelector('oc-easy-mode') as HTMLElement | null)?.shadowRoot?.querySelector('.slot')
    const showing = slot instanceof HTMLElement && !slot.classList.contains('hidden')
    const box = showing ? (slot as HTMLElement).getBoundingClientRect() : null
    const bad: string[] = []
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 12; j++) {
        const x = Math.round(((i + 0.5) / 8) * innerWidth)
        const y = Math.round(((j + 0.5) / 12) * innerHeight)
        const el = document.elementFromPoint(x, y)
        if (!el) continue
        const tag = el.tagName.toLowerCase()
        if (tag === 'oc-easy-mode' || tag === 'oc-easy-mode-overlay' || tag === 'html' || tag === 'body') continue
        if (el.closest('#movie_player, #player-control-container, bottom-sheet-container')) {
          const inSlot = box !== null && x >= box.left - 2 && x <= box.right + 2 && y >= box.top - 2 && y <= box.bottom + 2
          if (inSlot) continue
        }
        if (bad.length < 6) bad.push(`${tag}#${el.id}`)
      }
    return bad
  })
  expect(onTop).toEqual([])
  // And the screen it drew can be seen. A pane at opacity nothing reads to
  // the person holding the phone exactly like a pane that was never drawn.
  const pane = await page.evaluate(() => {
    const main = (document.querySelector('oc-easy-mode') as HTMLElement).shadowRoot!.querySelector('.main')!
    const kids = Array.from(main.children)
    return { children: kids.length, faintest: kids.length === 0 ? 1 : Math.min(...kids.map((c) => Number(getComputedStyle(c).opacity))) }
  })
  expect(pane.children).toBeGreaterThan(0)
  expect(pane.faintest).toBeGreaterThan(0.3)
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

  // The parked state must be the one compositing state the phone is known to
  // paint: the chain LOWERED (as cover() lowers it for the drawer), never
  // removed. Deleting the rule lets #player-container-id go back to its own
  // `position: fixed; z-index: 2`, and that re-composition is where iOS
  // handed the app's layer back unpainted (2026-09-08, "안보이지만 버튼은
  // 눌린다" — the diagnosis saw a perfect DOM under an unpainted screen).
  // And a parked picture has no scroll to ride, so it gives the composited
  // layer (will-change) back rather than keeping one alive off-screen.
  const parkedCompositing = await page.evaluate(() => {
    const chain = document.getElementById('player-container-id')
    const player = document.getElementById('movie_player')
    return chain && player
      ? { position: getComputedStyle(chain).position, z: getComputedStyle(chain).zIndex, will: getComputedStyle(player).willChange }
      : null
  })
  expect(parkedCompositing).toEqual({ position: 'relative', z: '0', will: 'auto' })
  // ...and the layer is taken back the moment the picture has a seat again.
  await ui.locator('.bar .vid').click()
  await expect(ui.locator('.slot')).toHaveClass(/stage/)
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.getElementById('movie_player')!).willChange), { timeout: 10_000 })
    .toBe('transform')

  // With the drawer out over a seated picture, the picture must not merely be
  // ranked below the app — it must be off the screen, the way 소리만 leaves it.
  // A composited video layer lowered only by z-index is the one state iOS
  // WebKit has twice failed to paint around: the drawer came back cut off at
  // the stage's height (photographed 2026-09-07, reported again 2026-09-08
  // "사이드바 아래쪽이 가려 영상만큼만 보이고"). Parked means gone: no layer
  // above the app at all while the drawer is out.
  await ui.locator('.drawerToggle').click()
  await expect
    .poll(() => page.evaluate(() => Math.round(document.getElementById('movie_player')!.getBoundingClientRect().left)), { timeout: 10_000 })
    .toBeLessThanOrEqual(-19000)
  await ui.locator('.drawerClose').click()
  await expect
    .poll(() => page.evaluate(() => Math.round(document.getElementById('movie_player')!.getBoundingClientRect().left)), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(0)
})

test('the player is always lifted or parked through every phone transition', async ({ context, page }) => {
  await inject(context, page)
  await page.goto('https://m.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
  const ui = app(page)
  await expect(ui.locator('.app.narrow')).toBeVisible({ timeout: 60_000 })
  await ui.locator('.tile:not([aria-hidden])').first().click()
  await ui.locator('.rows .row:not([aria-hidden])').nth(1).locator('.meta').click()
  await expect
    .poll(() => page.evaluate(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0.5 }), { timeout: 25_000 })
    .toBe(true)
  expect(new URL(page.url()).pathname).toBe('/')

  // Measured on real iOS WebKit, 2026-09-07: "사이드바 아래쪽이 가려
  // 영상만큼만 보이고". Measured again 2026-09-08: "안보이지만 버튼은
  // 눌린다". Both screens came from the same forbidden middle state: the
  // player still had pixels on the phone after its z-index had gone below the
  // app. Check after every press, not only after the matrix returns home.
  await expectPlayerLiftedOrParked(page, 'track starts in sound-only mode')

  await ui.locator('.bar .vid').click()
  await expectPlayerLiftedOrParked(page, 'picture shown')
  await ui.locator('.drawerToggle').click()
  await expectPlayerLiftedOrParked(page, 'drawer opened over picture mode')
  await ui.locator('.drawerClose').click()
  await expectPlayerLiftedOrParked(page, 'drawer closed into picture mode')

  await ui.locator('.bar .now').click()
  await expectPlayerLiftedOrParked(page, 'player sheet opened in picture mode')
  let title = await ui.locator('.bar .now .t').textContent()
  await ui.locator('.ctl .nx').click()
  await expectPlayerLiftedOrParked(page, 'next track pressed in picture sheet')
  await expect(ui.locator('.bar .now .t')).not.toHaveText(title ?? '')
  await ui.locator('.sheetClose').click()
  await expectPlayerLiftedOrParked(page, 'player sheet closed in picture mode')

  await ui.locator('.bar .vid').click()
  await expectPlayerLiftedOrParked(page, 'sound-only mode restored')
  await ui.locator('.drawerToggle').click()
  await expectPlayerLiftedOrParked(page, 'drawer opened in sound-only mode')
  await ui.locator('.drawerClose').click()
  await expectPlayerLiftedOrParked(page, 'drawer closed in sound-only mode')

  await ui.locator('.bar .now').click()
  await expectPlayerLiftedOrParked(page, 'player sheet opened in sound-only mode')
  title = await ui.locator('.bar .now .t').textContent()
  await ui.locator('.ctl .nx').click()
  await expectPlayerLiftedOrParked(page, 'next track pressed in sound-only sheet')
  await expect(ui.locator('.bar .now .t')).not.toHaveText(title ?? '')
  await ui.locator('.sheetClose').click()
  await expectPlayerLiftedOrParked(page, 'player sheet closed in sound-only mode')
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
