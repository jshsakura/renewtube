// Where a listening place may live, and what may be written into it.
//
// 0.24.28 keeps the place in `localStorage` under whatever track the queue
// names, written by the tick whatever the element is really playing, and it
// never expires. These tests hold the intended shape instead: a place belongs
// to one tab, survives only as a well-formed record, is written only for media
// proven to be the track it names, and is not kept at the boundaries of a
// track. They fail against 0.24.28 for exactly the first two of those, and the
// rest must simply stay true.

import { expect, test, type Page } from '@playwright/test'
import { expectSound, lab, playQueue, view } from './lab/fixture.ts'

/** Where 0.24.28 keeps the place, and where its successor keeps it instead. */
const LOCAL_KEY = 'oc-easy-mode:left-at'
const SESSION_KEY = 'oc-easy-mode:resume-position'

/** One place, read out of whichever store is holding it. */
interface Stored { id: string; t: number }

/** Mutable because these are page-side instrumentation accumulators. */
interface StorageAttemptCounts { get: number; set: number; remove: number; setAt: number[] }
interface StorageAttempts { legacy: StorageAttemptCounts; session: StorageAttemptCounts }

declare global {
  interface Window { readonly storageAttempts: StorageAttempts }
}

async function readStored(page: Page): Promise<Stored | null> {
  return page.evaluate((keys) => {
    const [local, session] = keys as [string, string]
    const fromLocal = localStorage.getItem(local)
    if (fromLocal) {
      try {
        const got = JSON.parse(fromLocal) as { id?: unknown; t?: unknown }
        if (typeof got.id === 'string' && typeof got.t === 'number') return { id: got.id, t: got.t }
      } catch {}
    }
    const fromSession = sessionStorage.getItem(session)
    if (fromSession) {
      try {
        const got = JSON.parse(fromSession) as { videoId?: unknown; seconds?: unknown }
        if (typeof got.videoId === 'string' && typeof got.seconds === 'number') {
          return { id: got.videoId, t: got.seconds }
        }
      } catch {}
    }
    return null
  }, [LOCAL_KEY, SESSION_KEY])
}

/** Puts a place in both stores: the one 0.24.28 reads and the one it should. */
async function seedStored(page: Page, id: string, t: number): Promise<void> {
  await page.evaluate((all) => {
    const [id, t, local, session] = all as [string, number, string, string]
    localStorage.setItem(local, JSON.stringify({ id, t }))
    sessionStorage.setItem(session, JSON.stringify({ videoId: id, seconds: t, duration: 30 }))
  }, [id, t, LOCAL_KEY, SESSION_KEY])
}

const seekTo = (page: Page, seconds: number): Promise<void> =>
  page.evaluate((s) => {
    const v = document.querySelector('video')
    if (v) v.currentTime = s
  }, seconds)

/** Waits until the place in either store is one `want` accepts. */
async function untilStored(page: Page, want: (s: Stored | null) => boolean): Promise<void> {
  await expect
    .poll(async () => (want(await readStored(page)) ? 'ready' : 'waiting'), { timeout: 10_000 })
    .toBe('ready')
}

/** Samples both stores for `ms`, requiring no sample to be one `bad` accepts. */
async function noStored(page: Page, ms: number, bad: (s: Stored) => boolean, because: string): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const stored = await readStored(page)
    if (stored && bad(stored)) expect(stored, because).toBe(null)
    await page.waitForTimeout(200)
  }
}

test('the moving clock of the previous track cannot be written down as the next track\'s place', async ({ page }) => {
  // Given: v1 well into its track on the watch page, its place honestly written
  await lab(page, { fault: 'no-player', watch: 'keeps-previous', reload: 'healthy' })
  await playQueue(page, 3)
  await expectSound(page)
  await seekTo(page, 12)
  await untilStored(page, (s) => s?.id === 'v1' && s.t >= 11.9)
  // When: the queue advances while the player keeps v1 running underneath
  await page.waitForTimeout(1500)
  await page.evaluate(() => (window as unknown as { LAB: { next(): void } }).LAB.next())
  // Then: no store may pair v2 with v1's position, now or in the beats after
  await noStored(page, 5000, (s) => s.id === 'v2' && s.t > 10, 'the next track inherited the previous track\'s clock')
  // And the recovery page that eventually plays v2 begins it near zero
  await expect
    .poll(async () => {
      const v = await view(page)
      return v.playingTitle === 'track 2' && v.sounding ? v.currentTime : -1
    }, { timeout: 15_000 })
    .toBeLessThan(4)
})

test('a second page of the same origin cannot read the first page\'s place', async ({ page, context }) => {
  // Given: one tab listening well into v1, its place written down
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  await seekTo(page, 12)
  await untilStored(page, (s) => s?.id === 'v1' && s.t >= 11.9)
  // When: another page of the same origin opens and goes looking for it
  const other = await context.newPage()
  await lab(other, { fault: 'healthy' })
  // Then: the place is the first tab's alone, in every store the second can reach
  expect(await readStored(other), 'the place escaped the tab it belongs to').toBeNull()
})

test('a track held under three seconds leaves no place behind', async ({ page }) => {
  // Given: v1 paused just after it began
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  await seekTo(page, 1)
  await page.evaluate(() => (window as unknown as { LAB: { toggle(): void } }).LAB.toggle())
  // When: the write beats come and go
  // Then: a place this early is not worth keeping
  await noStored(page, 6000, () => true, 'a track under three seconds kept a place')
})

test('a track within ten seconds of its end leaves no place behind', async ({ page }) => {
  // Given: v1 paused just before its end
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  await seekTo(page, 29)
  await page.evaluate(() => (window as unknown as { LAB: { toggle(): void } }).LAB.toggle())
  // When: the write beats come and go
  // Then: resuming into a track's last breath is not a resume at all
  await noStored(page, 6000, () => true, 'a nearly finished track kept a place')
})

test('a place that cannot be parsed is ignored, not obeyed and not fatal', async ({ page }) => {
  // Given: v1 honestly begun on its watch page, to be reloaded over and over.
  // Every broken record goes into both stores: the session key the place is
  // moving to, and the local one 0.24.28 still reads, so the same rejection is
  // asked of whichever parser is in force.
  await lab(page, { fault: 'no-player', watch: 'healthy', reload: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  const junk = [
    '{oops',
    '{"videoId":12,"seconds":12,"duration":30}',
    '{"videoId":"v1","seconds":"12","duration":30}',
    '{"videoId":"v1","seconds":-5,"duration":30}',
    '{"videoId":"v1","seconds":1e999,"duration":30}',
    '{"videoId":"","seconds":12,"duration":30}',
    '{"videoId":"v1","seconds":12,"duration":0}',
    '{"videoId":"v1","seconds":12,"duration":1e999}',
    '{"videoId":"v1","seconds":25,"duration":30}',
  ]
  for (const raw of junk) {
    // When: the reload arrives to find a broken record where the place should be
    await page.evaluate(() => (window as unknown as { LAB: { toggle(): void } }).LAB.toggle())
    await page.evaluate((all) => {
      const [local, session, raw] = all as [string, string, string]
      localStorage.setItem(local, raw)
      sessionStorage.setItem(session, raw)
    }, [LOCAL_KEY, SESSION_KEY, raw])
    await page.reload()
    await expectSound(page)
    // Then: the track plays from its beginning and the page never came to harm
    const at = (await view(page)).currentTime
    expect(at, `the record ${raw} sought a place outside the track`).toBeGreaterThanOrEqual(0)
    expect(at, `the record ${raw} moved the track`).toBeLessThan(10)
  }
})

test('storage that refuses the place costs the resume, not the page', async ({ page }) => {
  // Given: a place that exists in both stores; reading or clearing either
  // throws, and so does the very first attempt to write the session one —
  // after that one refusal, the session store takes the write
  await page.addInitScript((keys) => {
    const [local, session] = keys as [string, string]
    localStorage.setItem(local, JSON.stringify({ id: 'v1', t: 12 }))
    sessionStorage.setItem(session, JSON.stringify({ videoId: 'v1', seconds: 12, duration: 30 }))
    window.storageAttempts = {
      legacy: { get: 0, set: 0, remove: 0, setAt: [] },
      session: { get: 0, set: 0, remove: 0, setAt: [] },
    }
    const ours = (key: string): boolean => key === local || key === session
    const refuse = (): never => {
      throw new DOMException('lab: storage refuses', 'SecurityError')
    }
    const realGet = Storage.prototype.getItem
    const realSet = Storage.prototype.setItem
    const realRemove = Storage.prototype.removeItem
    Storage.prototype.getItem = function (key: string) {
      if (ours(key)) {
        const attempts = key === local ? window.storageAttempts.legacy : window.storageAttempts.session
        attempts.get += 1
        refuse()
      }
      return realGet.call(this, key)
    }
    Storage.prototype.setItem = function (key: string, value: string) {
      if (ours(key)) {
        const attempts = key === local ? window.storageAttempts.legacy : window.storageAttempts.session
        attempts.set += 1
        attempts.setAt.push(performance.now())
        if (key === local || attempts.set === 1) refuse()
      }
      realSet.call(this, key, value)
    }
    Storage.prototype.removeItem = function (key: string) {
      if (ours(key)) {
        const attempts = key === local ? window.storageAttempts.legacy : window.storageAttempts.session
        attempts.remove += 1
        refuse()
      }
      realRemove.call(this, key)
    }
  }, [LOCAL_KEY, SESSION_KEY])
  await lab(page, { fault: 'no-player', watch: 'healthy' })
  // When: v1 is pressed on a page with no player, the ordinary way a listen starts
  await playQueue(page)
  await expectSound(page)
  await seekTo(page, 12)
  const position = await page.evaluate(() => {
    const video = document.querySelector('video')
    return { currentTime: video?.currentTime ?? -1, duration: video?.duration ?? -1 }
  })
  expect(position.currentTime).toBeGreaterThanOrEqual(3)
  expect(position.currentTime).toBeLessThanOrEqual(position.duration - 10)
  // Then: the refused write is tried again on the next beat, not five seconds
  // later: the throttle belongs to writes that happened, and a beat is 500 ms.
  await expect
    .poll(
      () => page.evaluate(() => window.storageAttempts.session.setAt.length),
      { timeout: 10_000, message: 'the refused write was never tried again' },
    )
    .toBeGreaterThanOrEqual(2)
  const retriedWithin = await page.evaluate(() => {
    const [first, second] = window.storageAttempts.session.setAt
    return first !== undefined && second !== undefined ? second - first : Number.POSITIVE_INFINITY
  })
  expect(retriedWithin, 'a refused write waited for the five-second throttle').toBeLessThan(2500)
  // And: the refusal cost one beat of persistence; the expected track stays alive.
  const after = await view(page)
  expect(after.playingTitle).toBe('track 1')
  expect(after.sounding).toBe(true)
  expect(after.currentTime).toBeGreaterThanOrEqual(12)
})
