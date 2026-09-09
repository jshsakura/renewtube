// The promise this extension makes: YouTube is never altered, and there is
// always a way back. Everything else can be rebuilt; this cannot be broken.

import { expect, test } from '@playwright/test'
import { app, open } from './fixture.ts'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const WATCH = 'https://www.youtube.com/watch?v=BzYnNdJhZQw'

/**
 * What Chromium calls an unpacked extension: the path it was loaded from,
 * hashed, with each nibble written as a letter from a to p. This extension has
 * no background worker to ask, so the id is worked out rather than looked up.
 */
function extensionId(): string {
  const dist = process.env.DIST_DIR ?? resolve(import.meta.dirname, '../dist')
  const hash = createHash('sha256').update(dist).digest('hex').slice(0, 32)
  return [...hash].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('')
}

test('does nothing at all while switched off', async () => {
  const h = await open('https://www.youtube.com/', false)
  try {
    await h.page.waitForTimeout(4000)
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(0)
    await expect(h.page.locator('#oc-easy-mode')).toHaveCount(0)
    expect(await h.page.evaluate(() => document.documentElement.getAttribute('style') ?? '')).not.toContain('--oc-')
    // YouTube's own chrome is untouched.
    await expect(h.page.locator('ytd-app')).toBeVisible()
  } finally {
    await h.close()
  }
})

test('mounts exactly two nodes and touches nothing else', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    const counts = await h.page.evaluate(() => ({
      style: document.querySelectorAll('#oc-easy-mode').length,
      host: document.querySelectorAll('oc-easy-mode').length,
      overlay: document.querySelectorAll('oc-easy-mode-overlay').length,
      // Nothing of YouTube's carries a mark of ours. (This said `oc-tube` for
      // a while after the rename, which matched nothing and checked nothing.)
      marked: document.querySelectorAll('[class*="oc-easy"], [data-oc-easy]').length,
      // Added wherever the document declares no viewport of its own, which
      // includes desktop YouTube. What matters is that it is ours and that it
      // leaves with us — the Escape test checks the second half.
      viewport: document.querySelectorAll('#oc-easy-mode-viewport').length,
      ytdApp: document.querySelectorAll('ytd-app').length,
    }))
    expect(counts).toEqual({ style: 1, host: 1, overlay: 1, marked: 0, viewport: 1, ytdApp: 1 })
    // The player's position lives in our sheet, not on the page's root element.
    expect(await h.page.evaluate(() => document.documentElement.getAttribute('style') ?? '')).not.toContain('--oc-')
  } finally {
    await h.close()
  }
})

test('nothing of YouTube shows through, even with its guide drawer open', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    // Polymer's drawer declares visibility: visible on its own content when
    // opened, which inherited hidden cannot beat. Opened here the way the
    // page would open it, then counted: every YouTube element with a box on
    // screen that our sheet has not whitelisted, computed through shadow roots.
    await h.page.evaluate(() => {
      const drawer = document.querySelector('tp-yt-app-drawer') as { opened?: boolean } | null
      if (drawer) drawer.opened = true
    })
    await h.page.waitForTimeout(800)
    const visible = await h.page.evaluate(() => {
      const out: string[] = []
      const walk = (root: Document | ShadowRoot) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.closest('oc-easy-mode, oc-easy-mode-overlay')) continue
          if (el.shadowRoot) walk(el.shadowRoot)
          // The document canvas is expected to cover the viewport. It is not
          // YouTube chrome and the stricter hit-test below likewise permits
          // html/body; counting the two roots made this census fail while the
          // only things it named were the page itself.
          if (el === document.documentElement || el === document.body) continue
          if (el.closest('#movie_player, #player-control-container, bottom-sheet-container')) continue
          const cs = getComputedStyle(el)
          if (cs.visibility !== 'visible' || cs.display === 'none') continue
          const r = el.getBoundingClientRect()
          if (r.width >= 40 && r.height >= 40) {
            out.push(`${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].slice(0, 3).join('.')} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`)
          }
        }
      }
      walk(document)
      return out
    })
    expect(visible).toEqual([])
  } finally {
    await h.close()
  }
})

/**
 * The strict check: nothing but ours is on top, anywhere on the screen.
 *
 * Not computed styles but the hit test: elementFromPoint on a grid over the
 * whole viewport must land on our host, our overlay, the player, or the
 * sibling blocker's PiP button. This catches a YouTube element that paints
 * above us for any reason at all, a z-index we did not expect, a top-layer
 * popover, a stylesheet of YouTube's that undoes our hiding, without knowing
 * the reason in advance. A Shorts row floated over the lists on a desktop
 * (2026-09-06) and the visibility census did not see it; this does.
 */
async function nothingOnTopBut(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() => {
    // The picture is allowed on top only where we put it.
    //
    // This used to wave the player through wherever it landed, on the grounds
    // that the picture is drawn above the app on purpose. That is true of the
    // picture in its slot and of nothing else — and it is exactly why a parked
    // player painting across the list went unnoticed until a phone showed it
    // (2026-09-07). With the slot hidden the player has no business anywhere on
    // the screen, and with it up, only inside it.
    const slot = (document.querySelector('oc-easy-mode') as HTMLElement | null)?.shadowRoot?.querySelector('.slot')
    const showing = slot instanceof HTMLElement && !slot.classList.contains('hidden')
    const box = showing ? (slot as HTMLElement).getBoundingClientRect() : null
    const inSlot = (x: number, y: number): boolean =>
      box !== null && x >= box.left - 2 && x <= box.right + 2 && y >= box.top - 2 && y <= box.bottom + 2
    const ok = (el: Element | null, x: number, y: number): boolean => {
      if (!el) return true // outside the document: nothing painted there
      const tag = el.tagName.toLowerCase()
      if (tag === 'oc-easy-mode' || tag === 'oc-easy-mode-overlay') return true
      if (tag === 'html' || tag === 'body') return true
      // The player, its controls, the mobile sheet it opens and the sibling
      // blocker's button that follows it: all of them belong to the picture,
      // and the picture belongs in the slot.
      if (el.closest('#movie_player, #player-control-container, bottom-sheet-container, #oc-abp-pip')) return inSlot(x, y)
      return false
    }
    const bad: string[] = []
    const w = innerWidth, h = innerHeight
    for (let i = 0; i < 16; i++) {
      for (let j = 0; j < 10; j++) {
        const x = Math.round(((i + 0.5) / 16) * w), y = Math.round(((j + 0.5) / 10) * h)
        const el = document.elementFromPoint(x, y)
        if (!ok(el, x, y) && bad.length < 8) bad.push(`${x},${y}: ${el!.tagName.toLowerCase()}#${el!.id}.${[...el!.classList].slice(0, 2).join('.')}`)
      }
    }
    return bad
  })
}

/**
 * The faintest thing the pane is drawing, and how much of it there is.
 *
 * A screen can be perfectly laid out and still not be there: the pane's
 * children fade in as they land, and an entrance animation whose resting state
 * is invisible leaves the list at nothing while the header and the bar above
 * and below it stay perfect. That is a black rectangle where the content is,
 * and it is what the phone reported (2026-09-07). Geometry cannot see it, so
 * this asks what is actually painted.
 */
async function paneShows(page: import('@playwright/test').Page): Promise<{ children: number; faintest: number }> {
  return page.evaluate(() => {
    const main = (document.querySelector('oc-easy-mode') as HTMLElement).shadowRoot!.querySelector('.main')!
    const kids = Array.from(main.children)
    return {
      children: kids.length,
      faintest: kids.length === 0 ? 1 : Math.min(...kids.map((c) => Number(getComputedStyle(c).opacity))),
    }
  })
}

for (const [name, url] of [
  ['the home page', 'https://www.youtube.com/'],
  ['a watch page', WATCH],
  ['a playlist page', 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'],
  ['a search page', 'https://www.youtube.com/results?search_query=shorts'],
] as const) {
  test(`nothing of YouTube paints on top of ours on ${name}, even with the guide open`, async () => {
    const h = await open(url)
    try {
      await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
      await h.page.waitForTimeout(2500)
      expect(await nothingOnTopBut(h.page)).toEqual([])
      // And what it draws can be seen. A screen drawn at opacity nothing is
      // the same to the reader as a screen not drawn at all.
      const pane = await paneShows(h.page)
      expect(pane.children, `${name}: the pane drew something`).toBeGreaterThan(0)
      expect(pane.faintest, `${name}: and all of it is visible`).toBeGreaterThan(0.3)
      await h.page.evaluate(() => {
        const drawer = document.querySelector('tp-yt-app-drawer') as { opened?: boolean } | null
        if (drawer) drawer.opened = true
      })
      await h.page.waitForTimeout(800)
      expect(await nothingOnTopBut(h.page)).toEqual([])
    } finally {
      await h.close()
    }
  })
}

test('a page that puts its player on top still cannot show it while the picture is hidden', async () => {
  // The owner's screen, made on purpose. Parking the picture used to mean
  // "behind the app", which is a bet on our z-index outranking whatever
  // YouTube's own stacking works out to — and one stacking context of theirs
  // around the player wins that bet outright, whatever number we write on
  // ours. Signed in, on a phone, one did: the parked picture painted across
  // the list (2026-09-07).
  //
  // Asked of the geometry, not of the hit test. A parked player is
  // click-through by design, and `elementFromPoint` cannot see a thing with
  // pointer-events none — so the sweep in this file would call this screen
  // clean however badly it was painted. Where the box *is* cannot be argued
  // with, and off the screen is off the screen whatever the page ranks it.
  const h = await open('https://www.youtube.com/')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    await h.page.waitForTimeout(2000)
    const seen = await h.page.evaluate(() => {
      const player = document.getElementById('movie_player')
      if (!player) return null
      // Whatever the page's own chain is, give the top of it everything it
      // would need to beat us: its own stacking context, above ours. Not
      // visibility — the page stays hidden, as our sheet leaves it, so the
      // player is the one thing in that chain that can paint at all.
      let top: HTMLElement = player
      for (let el = player.parentElement; el && el !== document.body; el = el.parentElement) top = el
      top.style.setProperty('position', 'fixed', 'important')
      top.style.setProperty('z-index', '2147483000', 'important')
      top.style.setProperty('transform', 'translateZ(0)', 'important')
      const r = player.getBoundingClientRect()
      return { right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width) }
    })
    expect(seen, 'there is a player to lift').not.toBeNull()
    // Nothing of it on the screen, and still a box with a size: a picture
    // squashed to nothing is one YouTube starts making decisions about.
    expect(seen!.right).toBeLessThanOrEqual(0)
    expect(seen!.width).toBeGreaterThan(100)
    expect(await nothingOnTopBut(h.page)).toEqual([])
  } finally {
    await h.close()
  }
})

test('Escape twice puts YouTube back', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    await h.page.keyboard.press('Escape')
    await h.page.keyboard.press('Escape')
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(0)
    await expect(h.page.locator('#oc-easy-mode')).toHaveCount(0)
    await expect(h.page.locator('#oc-easy-mode-viewport')).toHaveCount(0)
    await expect(h.page.locator('ytd-app')).toBeVisible()
    expect(await h.page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden')
  } finally {
    await h.close()
  }
})

test('leaving gives the picture its size back', async () => {
  // The player was a 320px corner window for the whole session; afterwards
  // YouTube's own layout must own it again, video and all.
  const h = await open('https://www.youtube.com/watch?v=BzYnNdJhZQw')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    await h.page.keyboard.press('Escape')
    await h.page.keyboard.press('Escape')
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(0)
    await expect
      .poll(
        () =>
          h.page.evaluate(() => {
            const player = document.getElementById('movie_player')?.getBoundingClientRect()
            const video = document.querySelector('video')?.getBoundingClientRect()
            if (!player || !video) return 'missing'
            return Math.abs(player.width - video.width) < 4 && player.width > 400 ? 'fits' : `${Math.round(video.width)} in ${Math.round(player.width)}`
          }),
        { timeout: 10_000 },
      )
      .toBe('fits')
  } finally {
    await h.close()
  }
})

test('a single Escape is left to YouTube', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    await h.page.keyboard.press('Escape')
    await h.page.waitForTimeout(1500)
    await h.page.keyboard.press('Escape')
    await h.page.waitForTimeout(500)
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
  } finally {
    await h.close()
  }
})

test('the sidebar button leaves too, and the flag stays off across a reload', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    await app(h.page).locator('.exit').click()
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(0)
    expect(await h.page.evaluate(() => localStorage.getItem('oc-easy-mode:on'))).toBe('0')
  } finally {
    await h.close()
  }
})

test('the toolbar switch turns it on and off through storage', async () => {
  const h = await open('https://www.youtube.com/', false)
  try {
    await expect(h.page.locator('ytd-app')).toBeVisible()
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(0)

    // The same path the popup takes: write the setting, let the bridge tell
    // the page. Driving the popup's own DOM would test the button, not this.
    const flip = (musicMode: boolean) =>
      h.page.evaluate((on) => {
        window.postMessage({ ns: 'oc-easy-mode', type: 'set-config', patch: { musicMode: on } }, location.origin)
      }, musicMode)

    await flip(true)
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })

    await flip(false)
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(0)
    await expect(h.page.locator('#oc-easy-mode')).toHaveCount(0)
    await expect(h.page.locator('ytd-app')).toBeVisible()
  } finally {
    await h.close()
  }
})

test('signed out, a personal feed says so instead of looking empty', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()
    await expect(ui.locator('.err')).toContainText('로그인')
  } finally {
    await h.close()
  }
})

test('the toolbar popup can pull the diagnosis out of a page, whatever the page looks like', async () => {
  // The report has to be reachable when the screen is the broken thing. The
  // in-page one is not: it opens as a sheet over a page that will not paint,
  // and it came up half-drawn on the owner's phone ("화면이 막혀있는데 설정창은
  // 반절만 나오고"). The popup is the browser's own furniture, so it opens
  // whatever the page is doing, and it asks the page world through the bridge.
  const h = await open('https://www.youtube.com/')
  try {
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    // The popup's own page, in a tab of its own, exactly as the toolbar opens
    // it. An unpacked extension's id is Chromium's hash of the path it was
    // loaded from, and this extension has no background worker to ask for it.
    const id = extensionId()
    const popup = await h.context.newPage()
    await popup.goto(`chrome-extension://${id}/popup.html`)
    await expect(popup.locator('#diag')).toBeVisible()
    // The YouTube tab has to be the active one for the popup to find it, which
    // is what happens when a toolbar button is pressed.
    await h.page.bringToFront()
    const text = await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = tabs.find((t) => /youtube\.com/.test(t.url ?? ''))
      if (!tab?.id) return 'no tab'
      const answer = (await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' })) as { text?: string }
      return answer?.text ?? ''
    })
    expect(text).toMatch(/^RenewTube \d+\.\d+\.\d+/)
    expect(text).toContain('덮고 있는 것:')
    expect(text).toContain('앱의 자리')

    // And the way out, from the same place: the screen is built again without
    // the mode going off or the queue being lost. Wanted exactly when the
    // screen itself cannot be pressed.
    await popup.evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
      const tab = tabs.find((t) => /youtube\.com/.test(t.url ?? ''))
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'restart' })
    })
    await expect(app(h.page).locator('.app')).toBeVisible({ timeout: 60_000 })
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(1)
    await popup.close()
  } finally {
    await h.close()
  }
})
