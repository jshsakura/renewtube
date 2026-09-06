// The product: our UI, YouTube's player, one queue between them.

import { expect, test } from '@playwright/test'
import { app, open, searchFor } from './fixture.ts'

const WATCH = 'https://www.youtube.com/watch?v=BzYnNdJhZQw'

test('search returns tracks, and choosing one drives the page\'s player', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()

    const over = await searchFor(h.page, '아이유 밤편지')
    const first = over.locator('.row:not([aria-hidden])').first()

    const title = (await first.locator('.title').textContent())?.trim() ?? ''
    expect(title.length).toBeGreaterThan(0)

    await first.locator('.meta').click()
    // The bar says what the queue says.
    await expect(ui.locator('.bar .now .t')).toHaveText(title)
    // And YouTube's own player agrees, without the page having navigated.
    await expect
      .poll(async () =>
        h.page.evaluate(() => {
          const p = document.getElementById('movie_player') as { getVideoData?: () => { title?: string } } | null
          return p?.getVideoData?.().title ?? ''
        }),
      )
      .not.toBe('')
    expect(h.page.url()).toContain('BzYnNdJhZQw')
  } finally {
    await h.close()
  }
})

test('the picture button opens a Picture-in-Picture window on the desktop, and closes it', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    const over = await searchFor(h.page, 'lofi')
    await over.locator('.row:not([aria-hidden])').first().click()
    // The picture only goes to a window once the video is actually playing.
    await expect
      .poll(() => h.page.evaluate(() => { const v = document.querySelector('video'); return !!v && !v.paused && v.currentTime > 0.3 }), { timeout: 20_000 })
      .toBe(true)
    // No stage of ours on the desktop; the picture is a native PiP window.
    await expect(ui.locator('.slot')).toHaveClass(/hidden/)
    await ui.locator('.bar .vid').click()
    await expect
      .poll(() => h.page.evaluate(() => document.pictureInPictureElement?.tagName ?? null), { timeout: 10_000 })
      .toBe('VIDEO')
    await expect(ui.locator('.bar .vid')).toHaveClass(/on/)
    // And the same button closes it.
    await ui.locator('.bar .vid').click()
    await expect.poll(() => h.page.evaluate(() => document.pictureInPictureElement !== null)).toBe(false)
  } finally {
    await h.close()
  }
})
test('a track pressed on the home page plays where it is, and the desktop picture is a PiP window', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    // The desktop home keeps a player of its own hidden underneath. It plays
    // sound, and our sheet unhides its ancestor so the picture has a box too:
    // no page load, no address change, and the press is the gesture.
    await ui.locator('.tile:not([aria-hidden])').first().click()
    await ui.locator('.rows .row:not([aria-hidden])').nth(1).locator('.meta').click()
    await expect(ui.locator('.bar .now .t')).not.toHaveText('', { timeout: 20_000 })
    await expect
      .poll(() => h.page.evaluate(() => { const v = document.querySelector('video'); return v && !v.paused && v.currentTime > 0.5 }), { timeout: 20_000 })
      .toBe(true)
    expect(new URL(h.page.url()).pathname).toBe('/')
    // The picture goes to a Picture-in-Picture window on the desktop, not a
    // stage of ours, and the address still never changed.
    await ui.locator('.bar .vid').click()
    await expect
      .poll(() => h.page.evaluate(() => document.pictureInPictureElement?.tagName ?? null), { timeout: 10_000 })
      .toBe('VIDEO')
    expect(new URL(h.page.url()).pathname).toBe('/')
  } finally {
    await h.close()
  }
})

test('the bar keeps every button on screen down to a 900px window', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    for (const width of [1100, 1024, 900]) {
      await h.page.setViewportSize({ width, height: 760 })
      await h.page.waitForTimeout(300)
      const m = await ui.locator('.bar').evaluate((bar) => {
        const vid = bar.querySelector('.vid')!.getBoundingClientRect()
        return { overflow: bar.scrollWidth > bar.clientWidth, vidRight: Math.round(vid.right), barRight: Math.round(bar.getBoundingClientRect().right) }
      })
      expect(m.overflow, `${width}px`).toBe(false)
      expect(m.vidRight, `${width}px`).toBeLessThanOrEqual(m.barRight)
    }
  } finally {
    await h.close()
  }
})

test('the queue advances and the mode survives it', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    const over = await searchFor(h.page, 'lofi')
    await over.locator('.searchAct', { hasText: '전체 재생' }).click()
    const firstTitle = await ui.locator('.bar .now .t').textContent()

    await ui.locator('.ctl button[title="다음"]').click()
    await expect(ui.locator('.bar .now .t')).not.toHaveText(firstTitle ?? '')

    // Still in our UI, still one host, YouTube still hidden.
    await expect(ui.locator('.app')).toBeVisible()
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(1)
  } finally {
    await h.close()
  }
})

test('arriving on a watch page plays nothing until play is pressed', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    // The page's own autoplay was stopped, and stays stopped.
    await expect.poll(() => h.page.evaluate(() => document.querySelector('video')?.paused ?? null), { timeout: 15_000 }).toBe(true)
    await h.page.waitForTimeout(3000)
    expect(await h.page.evaluate(() => document.querySelector('video')?.paused)).toBe(true)
    // The track is in the bar, waiting for the press.
    await expect(ui.locator('.bar .now .t')).not.toHaveText('재생 중인 항목 없음')
    await ui.locator('.ctl button[title="재생 / 일시정지"]').click()
    await expect.poll(() => h.page.evaluate(() => document.querySelector('video')?.paused), { timeout: 15_000 }).toBe(false)
  } finally {
    await h.close()
  }
})

test('an arrival of our own is allowed to play', async () => {
  // A track pressed where there is no player navigates to its page and
  // leaves this mark behind; the page that arrives reads it and lets the
  // video go. The mark is set the way load() sets it.
  const h = await open(WATCH, true)
  try {
    // The harness's quick flag is cleared by the background's answer once the
    // app is up; set again for the load that follows.
    await h.page.addInitScript(() => {
      try {
        localStorage.setItem('oc-easy-mode:on', '1')
      } catch {}
    })
    await h.page.evaluate(() => localStorage.setItem('oc-easy-mode:arriving', 'BzYnNdJhZQw'))
    await h.page.reload({ waitUntil: 'domcontentloaded' })
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible({ timeout: 60_000 })
    await expect.poll(() => h.page.evaluate(() => { const v = document.querySelector('video'); return v ? !v.paused && v.currentTime > 0 : null }), { timeout: 30_000 }).toBe(true)
    // And the mark is spent.
    expect(await h.page.evaluate(() => localStorage.getItem('oc-easy-mode:arriving'))).toBeNull()
  } finally {
    await h.close()
  }
})

test('the mute button silences the video element, and hands the level back', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()

    // Playing first. The engine writes our mute onto the element again on
    // every tick while there is sound, so a press over a stopped player would
    // never exercise the path that actually keeps a phone quiet.
    await expect(ui.locator('.bar .now .t')).not.toHaveText('재생 중인 항목 없음')
    await ui.locator('.ctl button[title="재생 / 일시정지"]').click()
    await expect
      .poll(() => h.page.evaluate(() => document.querySelector('video')?.paused), { timeout: 30_000 })
      .toBe(false)

    // The element decides whether anything is heard; the player's own answer
    // is asked for as well, because on some builds the two disagree and that
    // disagreement is the bug this guards.
    const sound = () =>
      h.page.evaluate(() => {
        const el = document.querySelector('video')
        const p = document.getElementById('movie_player') as { isMuted?: () => boolean } | null
        let api: boolean | null = null
        try {
          api = p?.isMuted?.() ?? null
        } catch {
          api = null
        }
        return { el: el ? el.muted : null, api }
      })
    expect(await sound()).toEqual({ el: false, api: false })

    const mute = ui.locator('.bar .right button[title="음소거"]')
    await mute.click()
    await expect.poll(sound).toEqual({ el: true, api: true })

    await mute.click()
    await expect.poll(sound).toEqual({ el: false, api: false })
    // Back to the level it was at rather than to a number chosen by the
    // button: the same action as the m key, not a second one beside it.
    expect(await h.page.evaluate(() => JSON.parse(localStorage.getItem('oc-easy-mode:state') ?? '{}').volume)).toBeGreaterThan(0)
  } finally {
    await h.close()
  }
})
