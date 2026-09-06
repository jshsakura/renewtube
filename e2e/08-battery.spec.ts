// The battery saver: music mode takes the smallest stream YouTube has, video
// mode puts the picture back.
//
// There is no switch for it, and there should not be: the mode the person
// already chose says which of the two they want. So what these check is that
// choosing a mode is enough, and that the choice survives the next track.
//
// **Asserted on the player's own answer, never on ours.** Asking for a quality
// is not the same as getting one: `setPlaybackQuality` is the documented call
// and YouTube ignores it outright, measured, a 360p stream stayed 360p. Only
// `setPlaybackQualityRange` moves anything, and it returns undefined, so
// `getPlaybackQuality()` read back off the player is the one thing that can
// tell a working cap from a call into the void.

import { expect, test } from '@playwright/test'
import { app, open, searchFor } from './fixture.ts'

const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

/** What the player says it is showing, and what the element actually decoded. */
function look(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const p = document.getElementById('movie_player') as { getPlaybackQuality?: () => string } | null
    const v = document.querySelector('video')
    return { quality: p?.getPlaybackQuality?.() ?? '(none)', height: v?.videoHeight ?? 0 }
  })
}

/**
 * Jumps past everything already downloaded, so what plays next has to be
 * fetched now and under the cap.
 *
 * Kept short of the end, because running off it would advance the queue and
 * the next track is a different question.
 */
async function seekPastBuffer(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    const v = document.querySelector('video')
    if (!v || !v.buffered.length) return
    const ahead = v.buffered.end(v.buffered.length - 1) + 5
    const safe = Number.isFinite(v.duration) ? Math.min(ahead, v.duration - 20) : ahead
    if (safe > v.currentTime) v.currentTime = safe
  })
}

const quality = (page: import('@playwright/test').Page) => look(page).then((s) => s.quality)
const height = (page: import('@playwright/test').Page) => look(page).then((s) => s.height)
const modeNow = (page: import('@playwright/test').Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('oc-easy-mode:state') ?? '{}').mode as string)

/**
 * A queue with somewhere to go.
 *
 * Opening a watch page gives a queue of one, and `next()` on a queue of one
 * returns without doing anything — so a test that pressed next there would
 * watch the same track keep playing and pass for the wrong reason. It did.
 */
async function queueOf(page: import('@playwright/test').Page) {
  const over = await searchFor(page, 'lofi')
  await over.locator('.searchAct', { hasText: '전체 재생' }).click()
  return app(page)
}

test('music mode plays the smallest stream, and still does on the next track', async () => {
  const h = await open(WATCH)
  try {
    const ui = await queueOf(h.page)
    // Music is the default, so the cap should arrive with the first track.
    await expect.poll(() => quality(h.page), { timeout: 60_000 }).toBe('tiny')

    // The track change is where a cap set once and never again falls off: the
    // new video brings its own list of levels and the player forgets.
    const first = await ui.locator('.bar .now .t').textContent()
    await ui.locator('.ctl button[title="다음"]').click()
    await expect(ui.locator('.bar .now .t')).not.toHaveText(first ?? '')
    await expect.poll(() => quality(h.page), { timeout: 60_000 }).toBe('tiny')

    // The decoded frame lags the switch: the player answers `tiny` at once and
    // the element keeps handing back the old size until what is already
    // buffered has played out. The height is what proves bytes were actually
    // saved, so it is worth keeping rather than dropping.
    //
    // **Ahead of the buffer, rather than waiting for it to drain.** Waiting is
    // what made this flaky: the wait is as long as whatever was already
    // fetched at the old quality, which is a property of the connection and
    // not of the product. Measured on one line: 18.1s of natural drain against
    // 1.4s after a seek, and a faster line buffers more and waits longer. A
    // seek past the buffered end forces the next segments to be fetched, and
    // they can only arrive at the quality the cap allows, which is the thing
    // being asserted.
    await seekPastBuffer(h.page)
    await expect.poll(() => height(h.page), { timeout: 30_000 }).toBeLessThanOrEqual(144)
  } finally {
    await h.close()
  }
})

test('video mode asks for the picture back, and music mode takes it away again', async () => {
  const h = await open(WATCH)
  try {
    const ui = await queueOf(h.page)
    await expect.poll(() => quality(h.page), { timeout: 60_000 }).toBe('tiny')

    const picture = ui.locator('.right .vid')
    await expect(picture).toBeVisible({ timeout: 20_000 })
    for (let i = 0; i < 3 && (await modeNow(h.page)) !== 'video'; i++) {
      await picture.click()
      await h.page.waitForTimeout(900)
    }
    expect(await modeNow(h.page)).toBe('video')

    // Restoring takes two calls in one order, and either alone fails quietly:
    // the ceiling by itself never leaves 144p, and `auto` by itself crawls to
    // 360p and stops. On a desktop the ceiling is the video's own best rather
    // than a phone's 1080p battery cap (engine.videoCeiling), so what says both
    // landed is the player reaching the highest level the video offers — 2160p
    // on this one. The test browser is a desktop-sized viewport.
    const best = await h.page.evaluate(() => {
      const p = document.getElementById('movie_player') as { getAvailableQualityLevels?: () => string[] } | null
      return (p?.getAvailableQualityLevels?.() ?? []).filter((l) => l !== 'auto')[0] ?? 'hd1080'
    })
    await expect.poll(() => quality(h.page), { timeout: 60_000 }).toBe(best)

    for (let i = 0; i < 3 && (await modeNow(h.page)) !== 'music'; i++) {
      await picture.click()
      await h.page.waitForTimeout(900)
    }
    expect(await modeNow(h.page)).toBe('music')
    await expect.poll(() => quality(h.page), { timeout: 60_000 }).toBe('tiny')
  } finally {
    await h.close()
  }
})
