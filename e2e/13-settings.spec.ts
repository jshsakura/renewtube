// The way back to YouTube's own settings, and the promise that going there is
// not a one-way trip.
//
// Three things are being asked, and the third is the one that matters:
//
//   1. the gear in the drawer's own row opens the sheet
//   2. the sheet offers YouTube's two pages
//   3. /account is YouTube's page, with nothing of ours over it, and a watch
//      URL afterwards has the mode back without anyone re-enabling it
//
// **The assertions on /account are about our absence, never about YouTube's
// content.** The test browser is signed out, so that page may be a sign-in
// screen, a consent interstitial or a redirect to accounts.google.com. What is
// being tested is that we did not cover whatever it turned out to be. Because
// signed out it *is* a redirect, off youtube.com entirely, the last test here
// serves the two paths itself: the extension still loads on them, because the
// manifest matches the address and not the body, so a page of our own is the
// only way to watch the check actually decline.
//
// **The round trip is entered through the config, not through the fixture's
// flag.** The flag is a cache of chrome.storage, rewritten from it on every
// page load, so a profile that only ever set the flag has the mode for exactly
// one navigation and plain YouTube on the next. That is the fixture being a
// shortcut, not the product misbehaving, and a test that navigates twice has
// to come in the way the toolbar does. 11-reentry says the same thing.

import { expect, test, type Page } from '@playwright/test'
import { app, open, overlay } from './fixture.ts'

/** The toolbar switch's own path: write the setting, let the bridge tell the page. */
const flip = (page: Page, musicMode: boolean) =>
  page.evaluate((on) => {
    window.postMessage({ ns: 'oc-easy-mode', type: 'set-config', patch: { musicMode: on } }, location.origin)
  }, musicMode)

/** Turns the mode on the way the toolbar does, so it survives a navigation. */
async function enterThroughConfig(page: Page): Promise<void> {
  await page.evaluate(() => {
    try {
      localStorage.setItem('oc-easy-mode:state', JSON.stringify({ lang: 'ko' }))
    } catch {
      /* a browser that refuses storage will answer in YouTube's language */
    }
  })
  await flip(page, true)
  await expect(app(page).locator('.app')).toBeVisible({ timeout: 60_000 })
}

/** Opens the settings sheet the way a reader does, and hands back the overlay root. */
async function openSettings(page: import('@playwright/test').Page) {
  const ui = app(page)
  await expect(ui.locator('.app')).toBeVisible()
  await ui.locator('.sideHead .gear').click()
  const over = overlay(page)
  await expect(over.locator('.modal.settings')).toBeVisible()
  return over
}

test('the gear opens a sheet with YouTube\'s own pages in it', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    const over = await openSettings(h.page)
    await expect(over.locator('.modal.settings .setLink', { hasText: '계정' })).toBeVisible()
    await expect(over.locator('.modal.settings .setLink', { hasText: '환경설정' })).toBeVisible()
    // And the group it belongs to says whose pages these are.
    await expect(over.locator('.modal.settings .setGroup').first()).toHaveText('유튜브')
  } finally {
    await h.close()
  }
})

test('the sheet surfaces the settings that already exist', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    const over = await openSettings(h.page)
    const sheet = over.locator('.modal.settings')
    // Theme and mode are answers, not switches to invent.
    await expect(sheet.locator('.setRow', { hasText: '테마' }).locator('.seg button')).toHaveCount(3)
    await expect(sheet.locator('.setRow', { hasText: '기본 모드' }).locator('.seg button')).toHaveCount(2)

    // Choosing one takes, and is written where the next page load reads it.
    await sheet.locator('.setRow', { hasText: '기본 모드' }).locator('.seg button', { hasText: '영상' }).click()
    await expect
      .poll(() => h.page.evaluate(() => JSON.parse(localStorage.getItem('oc-easy-mode:state') ?? '{}').mode))
      .toBe('video')

    // The keys are printed rather than offered.
    await expect(sheet.locator('.keyList kbd').first()).toBeVisible()
  } finally {
    await h.close()
  }
})

test('화면 진단 prints the screen in words, and the text is the report', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    const over = await openSettings(h.page)
    const sheet = over.locator('.modal.settings')
    const pre = sheet.locator('.diag')
    await expect(pre).toBeHidden()
    await sheet.locator('.setLink', { hasText: '화면 진단' }).click()
    await expect(pre).toBeVisible()
    const text = (await pre.textContent()) ?? ''
    // The four answers a report needs: version and screen, the player and
    // its element, the ancestors, and what is on top.
    expect(text).toMatch(/^RenewTube \d+\.\d+\.\d+/)
    expect(text).toContain('플레이어 위치:')
    expect(text).toContain('플레이어 조상:')
    expect(text).toContain('맨 위에 있는 것:')
    expect(text).toContain('video:')
    expect(text).toContain('광고:')
    // And the fifth, added with the recovery ladder: what has been tried to
    // make this track play, which is the half of the report a screenshot of a
    // dead player can never carry.
    expect(text).toContain('복구:')
    expect(text).toContain('시계 멈춘 지')
    // And the sixth: what is covering the screen, named. A report that says
    // "전부 RenewTube" while something of ours sits over the list is the one
    // answer this screen must never give ("뭐가 덮고있는겨", 2026-09-07).
    expect(text).toContain('덮고 있는 것:')
    expect(text).toContain('맨 위에 있는 것:')
    // The two the hit test can never answer: what is painted over the screen
    // without taking a press, and what threw while the screen was being drawn.
    expect(text).toContain('화면을 채우고 있는 것')
    expect(text).toContain('그리다 실패한 것:')
  } finally {
    await h.close()
  }
})

test('the sheet is reachable on a phone too', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await h.page.setViewportSize({ width: 390, height: 844 })
    const ui = app(h.page)
    await expect(ui.locator('.app.narrow')).toBeVisible()
    // On a narrow screen the pane is a drawer, so the gear is one press in.
    await ui.locator('.drawerToggle').click()
    await ui.locator('.sideHead .gear').click()
    await expect(overlay(h.page).locator('.modal.settings')).toBeVisible()
  } finally {
    await h.close()
  }
})

test('/account is YouTube\'s own page, and coming back brings the mode with it', async () => {
  const h = await open('https://www.youtube.com/', false)
  try {
    await enterThroughConfig(h.page)
    const over = await openSettings(h.page)
    await over.locator('.modal.settings .setLink', { hasText: '계정' }).click()
    await h.page.waitForURL(/\/account|accounts\.google\.com|signin/, { timeout: 60_000 })

    // Nothing of ours is over whatever it turned out to be.
    await h.page.waitForTimeout(5000)
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(0)
    await expect(h.page.locator('#oc-easy-mode')).toHaveCount(0)
    expect(await h.page.evaluate(() => getComputedStyle(document.body).visibility)).toBe('visible')

    // And the switch was never touched, which is the whole design: coming home
    // is an ordinary page load that finds the mode still on.
    await h.page.goto('https://www.youtube.com/watch?v=BzYnNdJhZQw', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
  } finally {
    await h.close()
  }
})

test('the mode declines to mount on the settings paths, and returns after them', async () => {
  const h = await open('https://www.youtube.com/', false)
  try {
    // Signed out, YouTube hands both of these to a Google sign-in on another
    // origin, where this extension is not loaded at all and absence proves
    // nothing. Served from here they stay on youtube.com, the content scripts
    // run, and declining is the only reason nothing comes up.
    await h.page.route(
      (url) => url.hostname === 'www.youtube.com' && (url.pathname.startsWith('/account') || url.pathname.startsWith('/view_all_settings')),
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: '<!doctype html><title>YouTube</title><body><div id="ytSettings">계정 설정</div></body>',
        }),
    )
    // **Watched rather than sampled.** Mounting on one of these pages does not
    // leave a mess behind to find afterwards: the shell goes in at
    // document_start, the app never finishes because there is no ytcfg here,
    // and the watchdog pulls both nodes back out. A check at the end of that
    // sees a clean page and calls it a pass. This records every sighting from
    // the first moment of the document instead, so the mount that happened and
    // undid itself is still an answer.
    await h.page.addInitScript(() => {
      const w = window as unknown as { __ocSeen?: string[] }
      w.__ocSeen = []
      const look = () => {
        if (!document.getElementById('oc-easy-mode') && !document.querySelector('oc-easy-mode')) return
        if (!w.__ocSeen!.includes(location.pathname)) w.__ocSeen!.push(location.pathname)
      }
      look()
      setInterval(look, 20)
    })
    await enterThroughConfig(h.page)

    for (const path of ['/account', '/view_all_settings', '/account_privacy']) {
      await h.page.goto(`https://www.youtube.com${path}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      // Past the watchdog's eight seconds, so a mount that was going to be
      // taken back has had time to be taken back, and still counts.
      await h.page.waitForTimeout(9000)
      expect(await h.page.evaluate(() => (window as unknown as { __ocSeen: string[] }).__ocSeen), path).toEqual([])
      await expect(h.page.locator('#ytSettings'), path).toBeVisible()
      expect(await h.page.evaluate(() => getComputedStyle(document.documentElement).overflow), path).not.toBe('hidden')
    }

    // Back to YouTube proper, with nobody having re-enabled anything.
    await h.page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
  } finally {
    await h.close()
  }
})
