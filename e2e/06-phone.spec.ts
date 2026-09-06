// The phone. Orion on an iPhone is where this extension actually lives, and a
// phone is not a narrow desktop: YouTube serves m.youtube.com there, and the
// sidebar has to become a drawer rather than a rail of unlabelled icons.

import { chromium, expect, test, type BrowserContext } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { isNarrow, screenKind } from '../src/main/ui/device.ts'

// m.youtube.com is slower to hand over a first paint than the desktop site,
// and these launch a fresh profile each time.
test.describe.configure({ timeout: 180_000 })

const DIST = resolve(import.meta.dirname, '../dist')
// Orion on iPhone reports this, a desktop Mac UA — which is exactly why the
// layout is never chosen from the user agent.
const ORION_IPHONE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

async function phone(): Promise<{ context: BrowserContext; page: import('@playwright/test').Page }> {
  const profile = mkdtempSync(join(tmpdir(), 'oc-phone-'))
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=ko-KR'],
    userAgent: ORION_IPHONE_UA,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = context.pages()[0] ?? (await context.newPage())
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oc-easy-mode:on', '1')
      // Pin the language, the way fixture.ts does. The UI follows YouTube's own
      // hl, and a run where YouTube answers in English left this file waiting
      // for a 검색 that said Search — a three-minute timeout with nothing wrong
      // with the product.
      localStorage.setItem('oc-easy-mode:state', JSON.stringify({ lang: 'ko' }))
    } catch {}
  })
  return { context, page }
}

// A phone that YouTube believes, which the one above is not: Orion's user
// agent is a desktop Mac, so m.youtube.com answers it with the desktop site
// and <ytm-app> never exists. The settings sheet below is the mobile site's
// own furniture, so it needs a profile YouTube serves that site to.
const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'

async function mobileSite(): Promise<{ context: BrowserContext; page: import('@playwright/test').Page }> {
  const profile = mkdtempSync(join(tmpdir(), 'oc-mobile-'))
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=ko-KR'],
    userAgent: IPHONE_SAFARI_UA,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  })
  const page = context.pages()[0] ?? (await context.newPage())
  await page.addInitScript(() => {
    try {
      localStorage.setItem('oc-easy-mode:on', '1')
      localStorage.setItem('oc-easy-mode:state', JSON.stringify({ lang: 'ko' }))
    } catch {}
  })
  return { context, page }
}

test('the layout follows the viewport, and the popup follows the screen', () => {
  // In the page: is there room beside the content? Nothing else is asked,
  // because nothing else is reliable — Orion on iPhone claims to be a desktop
  // Mac and is served the desktop site.
  expect(isNarrow(390, 390)).toBe(true)
  // The case that was wrong on the device: a 390px phone handed the desktop
  // site, which has no viewport meta, so the layout viewport is ~980.
  expect(isNarrow(980, 390)).toBe(true)
  // A desktop window dragged narrow has no room either, big monitor or not.
  expect(isNarrow(800, 2560)).toBe(true)
  expect(isNarrow(1512, 1512)).toBe(false)

  // In the popup, where there is no viewport worth asking: the screen, whose
  // short side is the same in either orientation.
  expect(screenKind(390, 844)).toBe('phone')
  expect(screenKind(844, 390)).toBe('phone')
  expect(screenKind(1512, 982)).toBe('desktop')
})

test('it runs on m.youtube.com and lays itself out narrow', async () => {
  const { context, page } = await phone()
  try {
    await page.goto('https://m.youtube.com/watch?v=BzYnNdJhZQw', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const ui = page.locator('oc-easy-mode')
    await expect(ui.locator('.app.narrow')).toBeVisible()
    // Deliberately no wait on content: this is a test of the layout, and
    // waiting for m.youtube.com to fill three shelves made it the slowest and
    // flakiest thing in the suite. 04-tv covers the shelves.

    // The sidebar is a drawer: parked off the left edge, and the content has
    // the whole width until it is asked for.
    const app = (await ui.locator('.app').boundingBox())!
    const parked = (await ui.locator('.side').boundingBox())!
    expect(parked.x + parked.width).toBeLessThanOrEqual(0)
    const main = (await ui.locator('.main').boundingBox())!
    expect(Math.round(main.width)).toBe(Math.round(app.width))

    // The header is a row of its own, above everything the player can cover.
    const top = (await ui.locator('.top').boundingBox())!
    expect(top.y).toBe(0)
    expect(Math.round(top.width)).toBe(Math.round(app.width))
    // The header names the screen, and it is the only place that name appears.
    await expect(ui.locator('.top .name')).toHaveText('음악')
    await expect(ui.locator('.main > h2')).toBeHidden()

    // Its button opens the drawer, and choosing a destination closes it.
    await ui.locator('.drawerToggle').click()
    await expect.poll(async () => (await ui.locator('.side').boundingBox())!.x).toBe(0)
    // The drawer has no 검색 line on a phone: the header carries it. Any
    // destination closes the drawer.
    await expect(ui.locator('.nav').filter({ hasText: '검색' })).toHaveCount(0)
    await ui.locator('.nav').filter({ hasText: '대기열' }).click()
    await expect
      .poll(async () => (await ui.locator('.side').boundingBox())!.x)
      .toBeLessThan(0)
    await ui.locator('.top .searchOpen').click()
    const over = page.locator('oc-easy-mode-overlay')
    await expect(over.locator('.searchbox input')).toBeVisible()

    // On a phone the panel is the whole screen, hung from the top so the field
    // is nowhere near the keyboard, and its own close button puts it away.
    const panel = (await over.locator('.modal.search').boundingBox())!
    expect(panel.y).toBe(0)
    expect(Math.round(panel.width)).toBe(Math.round(app.width))
    await over.locator('.modal.search .modalClose').click()
    await expect(over.locator('.modal.search')).toHaveCount(0)

    // And the header has its own way in, beside the theme, for every screen.
    await ui.locator('.top .searchOpen').click()
    await expect(over.locator('.modal.search')).toBeVisible()
    await expect(over.locator('.searchbox input')).toBeFocused()
    await over.locator('.modal.search .modalClose').click()

    // Nothing of ours is wider than the phone. The document's own scroll
    // width is YouTube's (a hidden desktop element of theirs measures 425);
    // what matters is that no box in the app, outside a sideways-scrolling
    // shelf, reaches past the right edge, because a phone answers a page
    // wider than itself by zooming out. The swipe strip once did exactly
    // that, parked past the edge of a row that was not positioned.
    const overhang = await page.evaluate(() => {
      const root = document.querySelector('oc-easy-mode')!.shadowRoot!
      const out: string[] = []
      for (const el of Array.from(root.querySelectorAll<HTMLElement>('.app *'))) {
        // Sideways shelves scroll; the swipe strip is clipped by its row.
        if (el.closest('.shelfRow, .rowActions')) continue
        const b = el.getBoundingClientRect()
        if (b.width > 0 && b.right > 391) out.push(`${el.className}:${Math.round(b.right)}`)
      }
      return out
    })
    expect(overhang).toEqual([])

    // The drawer's head is one line, not a band.
    await ui.locator('.drawerToggle').click()
    const head = (await ui.locator('.sideHead').boundingBox())!
    expect(head.height).toBeLessThan(80)
    await ui.locator('.drawerClose').click()

    // A row's menu is a small card at the foot of the screen with a name and
    // a close button, never taller than two fifths of it. The drawer has to
    // be out for its lines to be pressed.
    await ui.locator('.drawerToggle').click()
    await ui.locator('.nav').filter({ hasText: '음악' }).click()
    await ui.locator('.shelf .tile:not([aria-hidden])').first().click()
    const more = ui.locator('.main .row .more').first()
    const pressed = (await more.boundingBox())!
    await more.click()
    // Where it was pressed: under the button, aligned to its right edge, and
    // wholly on the screen.
    const menu = over.locator('.menu.touch')
    await expect(menu).toBeVisible()
    const box = (await menu.boundingBox())!
    expect(Math.abs(box.x + box.width - (pressed.x + pressed.width))).toBeLessThanOrEqual(12)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y + box.height).toBeLessThanOrEqual(844)
    await expect(menu.locator('.menuTitle')).not.toHaveText('')
    await menu.locator('.menuClose').click()
    await expect(over.locator('.menu')).toHaveCount(0)

    // The opened player fits the screen: its row of actions, at the foot,
    // is on the screen and not 74px under it.
    await ui.locator('.main .row .meta').first().click()
    await ui.locator('.bar .now').click()
    await expect(ui.locator('.app.sheet-open')).toBeVisible()
    const bar = (await ui.locator('.bar').boundingBox())!
    expect(Math.round(bar.height)).toBe(844)
    const actions = (await ui.locator('.bar .right').boundingBox())!
    expect(actions.y + actions.height).toBeLessThanOrEqual(844)
    expect(actions.y).toBeGreaterThan(400)

  } finally {
    await context.close()
  }
})

test('a narrow screen never floats the picture in a corner', async () => {
  const { context, page } = await phone()
  try {
    await page.goto('https://m.youtube.com/watch?v=BzYnNdJhZQw', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const ui = page.locator('oc-easy-mode')
    await expect(ui.locator('.app.narrow')).toBeVisible()
    // A 280px window has nowhere to float on a 390px screen; it would sit on
    // top of the list. Here the picture is either across the top or nowhere.
    await expect(ui.locator('.slot')).not.toHaveClass(/corner/)
  } finally {
    await context.close()
  }
})

test('the picture never covers the header', async () => {
  const { context, page } = await phone()
  try {
    await page.goto('https://m.youtube.com/watch?v=BzYnNdJhZQw', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const ui = page.locator('oc-easy-mode')
    await expect(ui.locator('.app.narrow')).toBeVisible()

    // Playing something puts the picture across the top of the screen, and
    // YouTube's player is drawn above the whole app — it has to be, or our
    // panels would hide it. So anything of ours up there has to start below
    // the stage, or it is unreachable: this is how the drawer button was
    // buried, leaving no way out but Escape.
    const first = ui.locator('.tile:not([aria-hidden]), .row:not([aria-hidden])').first()
    await first.waitFor({ timeout: 60_000 })
    await first.click()
    // The picture is the bar's own button now: two states on a phone, off
    // and across the top.
    await ui.locator('.bar .vid').click()
    await expect(ui.locator('.slot')).toHaveClass(/stage/)

    const top = (await ui.locator('.top').boundingBox())!
    const stage = (await ui.locator('.slot').boundingBox())!
    expect(stage.y).toBeGreaterThanOrEqual(top.y + top.height - 1)

    // And the way back is still there to be pressed — which was the whole
    // point: the video used to cover the button that opens this.
    await ui.locator('.drawerToggle').click()
    await expect.poll(async () => (await ui.locator('.side').boundingBox())!.x).toBe(0)
  } finally {
    await context.close()
  }
})

test('the player bar opens into a full player and closes again', async () => {
  const { context, page } = await phone()
  try {
    await page.goto('https://m.youtube.com/watch?v=BzYnNdJhZQw', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const ui = page.locator('oc-easy-mode')
    await expect(ui.locator('.app.narrow')).toBeVisible()

    // Closed, the bar is a strip at the foot with the shuffle and repeat
    // buttons put away; there is no room for them beside a track title.
    const app = (await ui.locator('.app').boundingBox())!
    const closed = (await ui.locator('.bar').boundingBox())!
    expect(closed.height).toBeLessThan(app.height / 3)
    await expect(ui.locator('.ctl .sh')).toBeHidden()

    // Tapping what is playing opens the same element full-screen, with
    // everything on it.
    await ui.locator('.bar .now').click()
    await expect(ui.locator('.ctl .sh')).toBeVisible()
    await expect(ui.locator('.right')).toBeVisible()
    const open = (await ui.locator('.bar').boundingBox())!
    expect(open.height).toBeGreaterThan(app.height / 2)

    await ui.locator('.sheetClose').click()
    await expect(ui.locator('.ctl .sh')).toBeHidden()
  } finally {
    await context.close()
  }
})

test('the picture does not come back after the drawer closes', async () => {
  const { context, page } = await phone()
  try {
    await page.goto('https://m.youtube.com/watch?v=BzYnNdJhZQw', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const ui = page.locator('oc-easy-mode')
    await expect(ui.locator('.app.narrow')).toBeVisible()

    // The picture is parked behind the app when there is nowhere for it to be,
    // and that only works while the app is above it. Closing the drawer used
    // to put the player's z-index back whether or not it had anywhere to be —
    // so a 320x180 window appeared in the top-left corner and stayed there,
    // with the slot still saying hidden. Geometry could not catch it; this
    // asks the page who is on top.
    const first = ui.locator('.tile:not([aria-hidden]), .row:not([aria-hidden])').first()
    await first.waitFor({ timeout: 60_000 })
    await first.click()

    // One open, both presses, one close. The switch does not close the drawer,
    // so toggling it again in between would shut the drawer and leave the next
    // press aimed at a button parked off the side of the screen.
    await ui.locator('.bar .vid').click()
    await expect(ui.locator('.slot')).toHaveClass(/stage/)
    await ui.locator('.bar .vid').click()
    await expect(ui.locator('.slot')).toHaveClass(/hidden/)

    await expect
      .poll(async () =>
        page.evaluate(() => {
          const b = document.getElementById('movie_player')!.getBoundingClientRect()
          const x = Math.min(Math.max(b.x + b.width / 2, 1), window.innerWidth - 2)
          const y = Math.min(Math.max(b.y + b.height / 2, 1), window.innerHeight - 2)
          return document.elementsFromPoint(x, y)[0]?.tagName ?? ''
        }),
      )
      .toBe('OC-EASY-MODE')
  } finally {
    await context.close()
  }
})

test('search on a phone asks YouTube and comes back with rows to choose from', async () => {
  const { context, page } = await phone()
  try {
    await page.goto('https://m.youtube.com/watch?v=BzYnNdJhZQw', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const ui = page.locator('oc-easy-mode')
    const over = page.locator('oc-easy-mode-overlay')
    await expect(ui.locator('.app.narrow')).toBeVisible()

    // The header's way in, because the drawer has no 검색 line on a phone.
    await ui.locator('.top .searchOpen').click()
    const box = over.locator('.searchbox input')
    await expect(box).toBeFocused()
    await box.fill('아이유 밤편지')
    await box.press('Enter')

    // Real answers, not the skeleton that stands in while they are fetched:
    // the placeholders wear the same class names, so a locator without this
    // passes on an empty panel.
    const rows = over.locator('.rows .row:not([aria-hidden])')
    await expect(rows.first()).toBeVisible()
    expect(await rows.count()).toBeGreaterThan(2)
    const title = (await rows.first().locator('.title').textContent())?.trim() ?? ''
    expect(title.length).toBeGreaterThan(0)

    // And one of them can be taken: the panel goes away and the bar says what
    // was chosen, on the layout where the panel is the whole screen.
    await rows.first().locator('.meta').click()
    await expect(over.locator('.modal.search')).toHaveCount(0)
    await expect(ui.locator('.bar .now .t')).toHaveText(title)
  } finally {
    await context.close()
  }
})

test('the gear on the mobile player opens YouTube own sheet, and it can be seen', async () => {
  const { context, page } = await mobileSite()
  try {
    await page.goto('https://m.youtube.com/watch?v=BzYnNdJhZQw', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    const ui = page.locator('oc-easy-mode')
    await expect(ui.locator('.app.narrow')).toBeVisible()
    // The mobile site, which is what puts a <bottom-sheet-container> on the
    // page at all. Without it this test would be measuring the desktop player.
    expect(await page.locator('ytm-app').count()).toBe(1)

    const first = ui.locator('.tile:not([aria-hidden]), .row:not([aria-hidden])').first()
    await first.waitFor({ timeout: 60_000 })
    await first.click()
    // 영상 mode: the picture across the top, which is where the gear is.
    await ui.locator('.bar .vid').click()
    await expect(ui.locator('.slot')).toHaveClass(/stage/)

    const closed = () =>
      page.evaluate(() => {
        const c = document.querySelector('bottom-sheet-container')
        return c ? { kids: c.children.length, display: getComputedStyle(c).display } : null
      })
    // Shut, it is display:none from YouTube's own stylesheet with nothing in
    // it, which is why our rule is not scoped to the hidden attribute.
    await expect.poll(closed).toEqual({ kids: 0, display: 'none' })

    // The controls are built on the first tap of the picture and fade a few
    // seconds later, so the tap and the press are retried together rather
    // than waited on separately.
    const box = (await ui.locator('.slot').boundingBox())!
    const gear = page.locator('.player-settings-icon')
    await expect(async () => {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await expect(gear).toBeVisible({ timeout: 2500 })
    }).toPass({ timeout: 60_000 })
    await gear.click()

    // What the gear opens is not in the player: YouTube builds the quality,
    // speed and caption menu into a direct child of <ytm-app>, which the
    // stylesheet that hides the page had not been letting through. Visible
    // was never the whole question, so this asks for a box on the screen and
    // then asks the page who is on top of it.
    const sheet = () =>
      page.evaluate(() => {
        const c = document.querySelector('bottom-sheet-container')
        if (!c) return { found: false }
        // The container itself is a 0x0 wrapper and the scrim inside it fills
        // the screen; the panel is the one box that is large and neither.
        let panel: HTMLElement | null = null
        let biggest = 0
        for (const el of Array.from(c.querySelectorAll<HTMLElement>('*'))) {
          const b = el.getBoundingClientRect()
          if (b.width >= window.innerWidth || b.height < 200 || b.width < 200) continue
          if (getComputedStyle(el).visibility !== 'visible') continue
          if (b.width * b.height > biggest) {
            biggest = b.width * b.height
            panel = el
          }
        }
        if (!panel) return { found: true, panel: false }
        const b = panel.getBoundingClientRect()
        const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
        return {
          found: true,
          panel: true,
          containerVisibility: getComputedStyle(c).visibility,
          containerZ: Number(getComputedStyle(c).zIndex),
          panelVisibility: getComputedStyle(panel).visibility,
          onScreen: b.y >= 0 && b.y + b.height <= window.innerHeight && b.x >= 0,
          reachable: !!top && c.contains(top),
        }
      })
    // Polled: the sheet slides up, so the frame the gear was pressed on has
    // it off the bottom of the screen and nothing to measure yet.
    await expect.poll(sheet, { timeout: 30_000 }).toEqual({
      found: true,
      panel: true,
      containerVisibility: 'visible',
      // Above our own overlay, which sits at 2147483100: while the sheet is
      // up it is the thing being used.
      containerZ: 2147483500,
      panelVisibility: 'visible',
      onScreen: true,
      reachable: true,
    })
  } finally {
    await context.close()
  }
})

test('on the mobile site a track pressed on home plays where it is, and 영상 mode has a picture', async () => {
  const { context, page } = await mobileSite()
  try {
    await page.goto('https://m.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const ui = page.locator('oc-easy-mode')
    await expect(ui.locator('.app.narrow')).toBeVisible({ timeout: 60_000 })
    // m.youtube.com keeps a player under its home inside #player[hidden]. The
    // sheet unhides that ancestor, so the press plays here: no page load, no
    // address change, and the press itself is the gesture WebKit wants.
    await ui.locator('.tile:not([aria-hidden])').first().click()
    await ui.locator('.rows .row:not([aria-hidden])').nth(1).locator('.meta').click()
    await expect
      .poll(() => page.evaluate(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0.5 }), { timeout: 20_000 })
      .toBe(true)
    expect(new URL(page.url()).pathname).toBe('/')
    await ui.locator('.bar .now').click()
    await ui.locator('button[title="화면 보기"]:visible').first().click()
    await expect
      .poll(() => page.evaluate(() => document.querySelector('video')!.getBoundingClientRect().width), { timeout: 15_000 })
      .toBeGreaterThan(300)
  } finally {
    await context.close()
  }
})
