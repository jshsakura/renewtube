// Which arrivals may resume a place, and which must begin a track from zero.
//
// A place follows only a continuation: a reload of the track being heard, a
// reload the queue outgrew, and the two recovery rungs. Ordinary selections
// and cold navigations start from zero no matter what old place they match,
// and media that is not positively the expected track can neither spend the
// place nor receive its seek. The first half fails against 0.24.28 and the
// second must not.

import { expect, test, type Page } from '@playwright/test'
import { expectSound, lab, playQueue, view } from './lab/fixture.ts'

/** Where 0.24.28 keeps the place, and where its successor keeps it instead. */
const LOCAL_KEY = 'oc-easy-mode:left-at'
const SESSION_KEY = 'oc-easy-mode:resume-position'
const ARRIVAL_KEY = 'oc-easy-mode:resume-arrival'

interface Stored { id: string; t: number }

const readStored = (page: Page): Promise<Stored | null> =>
  page.evaluate((session) => {
    const fromSession = sessionStorage.getItem(session)
    if (!fromSession) return null
    const got = JSON.parse(fromSession) as { videoId?: unknown; seconds?: unknown }
    return typeof got.videoId === 'string' && typeof got.seconds === 'number' ? { id: got.videoId, t: got.seconds } : null
  }, SESSION_KEY)

/** Puts a place in both stores: the one 0.24.28 reads and the one it should. */
const seedStored = (page: Page, id: string, t: number): Promise<void> =>
  page.evaluate((all) => {
    const [id, t, local, session] = all as [string, number, string, string]
    localStorage.setItem(local, JSON.stringify({ id, t }))
    sessionStorage.setItem(session, JSON.stringify({ videoId: id, seconds: t, duration: 30 }))
  }, [id, t, LOCAL_KEY, SESSION_KEY])

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

/** Freezes the delivery's clock mid-track: started, nothing arriving. */
const killDelivery = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const v = document.querySelector('video') as (HTMLVideoElement & { labState: { waiting: boolean } }) | null
    if (v) v.labState.waiting = true
  })

async function pauseQueue(page: Page): Promise<void> {
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  await page.evaluate(() => (window as unknown as { LAB: { toggle(): void } }).LAB.toggle())
}

const waitForAdvert = (page: Page, showing: boolean): Promise<void> =>
  page.waitForFunction((want) => document.getElementById('movie_player')?.classList.contains('ad-showing') === want, showing, { timeout: 10_000 })

test('a pressed track begins from zero even with an old place stored for it', async ({ page }) => {
  // Given: an old place for v1 sitting in both stores
  await lab(page, { fault: 'no-player', watch: 'healthy' })
  await seedStored(page, 'v1', 12)
  // When: v1 is pressed on a page with no player, the ordinary way a listen starts
  await playQueue(page)
  await expectSound(page)
  // Then: a selection is not a recovery; nothing may carry the old place over
  expect((await view(page)).currentTime, 'a fresh press resumed a stale place').toBeLessThan(3)
})

test('an intervening page spends recovery intent before a later cold target', async ({ page }) => {
  // Given: a warm saved queue, position, and one-time recovery intent for v1
  await page.addInitScript(() => { if (location.pathname !== '/') return
    const queue = [{ videoId: 'v1', title: 'track 1', byline: 'lab', duration: '0:30', unavailable: false }, { videoId: 'v2', title: 'track 2', byline: 'lab', duration: '0:30', unavailable: false }]
    localStorage.setItem('oc-easy-mode:state', JSON.stringify({
      queue, index: 0, video: 'stage', savedAt: Date.now(),
    }))
    localStorage.setItem('oc-easy-mode:left-at', JSON.stringify({ id: 'v1', t: 12 }))
    sessionStorage.setItem('oc-easy-mode:resume-position', JSON.stringify({ videoId: 'v1', seconds: 12, duration: 30 }))
    sessionStorage.setItem('oc-easy-mode:resume-arrival', 'v1')
  })
  // When: this tab visits a non-watch page, then cold-opens the formerly marked target
  await lab(page, { fault: 'healthy' })
  const markerAfterInterveningPage = await page.evaluate((key) => sessionStorage.getItem(key), ARRIVAL_KEY)
  await page.goto('https://www.youtube.com/watch?v=v1')
  await page.waitForFunction(() => (window as unknown as { LAB?: unknown }).LAB !== undefined)
  const cold = await page.evaluate(() => {
    const engine = (window as unknown as { LAB: { engine: { wantsSound: boolean } } }).LAB.engine
    const video = document.querySelector('video')
    return { intended: engine.wantsSound, sounding: video !== null && !video.paused, at: video?.currentTime ?? 0 }
  })
  // Then: the intervening classification spent the marker, so matching ids grant nothing
  expect(markerAfterInterveningPage, 'a non-watch arrival retained one-time resume intent').toBeNull()
  expect(cold.intended, 'a cold navigation acquired listening intent').toBe(false)
  expect(cold.sounding, 'a cold navigation auto-played').toBe(false)
  expect(cold.at, 'a cold navigation jumped to the stored place').toBeLessThan(3)
})

test('a reload of the track being heard comes back where it was left', async ({ page }) => {
  // Given: v1 well into its track on its watch page, the place written down
  await lab(page, { fault: 'no-player', watch: 'healthy', reload: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  await seekTo(page, 12)
  await page.evaluate(() => (window as unknown as { LAB: { engine: { departForBackground(): void } } }).LAB.engine.departForBackground())
  const departed = await readStored(page)
  expect(departed?.id === 'v1' && departed.t >= 12, 'departure did not sample the live media clock').toBe(true)
  // When: the page is reloaded
  await page.reload()
  // Then: the same track resumes within two seconds of its saved place
  await expectSound(page)
  const v = await view(page)
  expect(v.videoId).toBe('v1')
  expect(v.playingTitle).toBe('track 1')
  expect(v.currentTime, 'the reload restarted the track instead of resuming it').toBeGreaterThanOrEqual(10)
})

test('a reload the queue has outgrown redirects and resumes the queue\'s own track', async ({ page }) => {
  // Given: the queue has moved to v2 while the address still names v1
  await lab(page, { fault: 'no-player', watch: 'healthy' })
  await playQueue(page, 2)
  await expectSound(page)
  await seekTo(page, 12)
  await untilStored(page, (s) => s?.id === 'v1' && s.t >= 11.9)
  await page.evaluate(() => (window as unknown as { LAB: { skipToEnd(): void } }).LAB.skipToEnd())
  await expect
    .poll(async () => {
      const v = await view(page)
      return v.playingTitle === 'track 2' && v.sounding ? v.currentTime : -1
    }, { timeout: 15_000 })
    .toBeGreaterThan(0)
  await seekTo(page, 8)
  await untilStored(page, (s) => s?.id === 'v2' && s.t >= 7.9)
  // When: the stale address is reloaded
  await page.reload()
  // Then: the redirect lands on v2 and applies v2's own place once
  await expect
    .poll(async () => {
      const v = await view(page)
      return v.videoId === 'v2' && v.sounding ? v.currentTime : -1
    }, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(6)
  expect((await view(page)).playingTitle).toBe('track 2')
})

test('a mid-track rescue to a watch page keeps the place', async ({ page }) => {
  // Given: v1 playing at its place on the home page
  await lab(page, { fault: 'healthy', watch: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  await seekTo(page, 12)
  await untilStored(page, (s) => s?.id === 'v1' && s.t >= 11.9)
  // When: the delivery dies mid-track and the ladder hands the page to a watch page
  await killDelivery(page)
  await expectSound(page, 45_000)
  // Then: that navigation is a continuation, not a new selection
  const v = await view(page)
  expect(v.path).toBe('/watch')
  expect(v.videoId).toBe('v1')
  expect(v.currentTime, 'the rescue restarted the track instead of resuming it').toBeGreaterThanOrEqual(10)
})

test('a rescue that rebuilds the watch page keeps the place', async ({ page }) => {
  // Given: v1 heard briefly at its place before its page collapses under it
  await lab(page, { fault: 'no-player', watch: 'paused-buffering', reload: 'healthy' })
  await playQueue(page)
  await page.waitForFunction(() => document.querySelector('video') !== null)
  await seekTo(page, 12)
  await untilStored(page, (s) => s?.id === 'v1' && s.t >= 11.9)
  // When: the collapse spends the ladder's rungs down to a rebuild of the page
  await expectSound(page, 45_000)
  // Then: the rebuilt page is still the same listen, and it comes back to the place
  const v = await view(page)
  expect(v.path).toBe('/watch')
  expect(v.videoId).toBe('v1')
  expect(v.visit, 'the watch page was not rebuilt').toBeGreaterThan(1)
  expect(v.currentTime, 'the rebuild restarted the track instead of resuming it').toBeGreaterThanOrEqual(10)
})

test('an advert cannot spend the track\'s place', async ({ page }) => {
  // Given: v1 was being heard at its place, and its reload meets an advert first
  await lab(page, { fault: 'no-player', watch: 'healthy', reload: 'ad-real' })
  await playQueue(page)
  await expectSound(page)
  await seekTo(page, 12)
  await untilStored(page, (s) => s?.id === 'v1' && s.t >= 11.9)
  // When: the page reloads into the advert
  await page.reload()
  await waitForAdvert(page, true)
  await waitForAdvert(page, false)
  // Then: once the advert is gone the track resumes at its place, not from zero
  await expect
    .poll(() => page.evaluate(() => document.querySelector('video')?.currentTime ?? 0), { timeout: 6000 })
    .toBeGreaterThanOrEqual(10)
})

test('unknown, empty, foreign, and advertising media do not spend the pending place', async ({ page }) => {
  // Given: v1 playing, the clock held still, and a pending place armed for it
  await pauseQueue(page)
  // When: readiness arrives for unknown, empty, foreign, and a minute-long advert before the target
  const saw = await page.evaluate(() => {
    const engine = (window as unknown as { LAB: { engine: { resumeAt?: { id: string; t: number; tries: number; confirmedAt?: number } } } }).LAB.engine
    const player = document.getElementById('movie_player') as unknown as { getVideoData: () => { video_id: string }; classList: DOMTokenList }
    const video = document.querySelector('video')
    const real = player.getVideoData
    const start = video?.currentTime ?? 0
    player.classList.remove('ad-showing', 'ad-interrupting')
    document.querySelectorAll('ytm-video-ad-renderer, .ytp-ad-player-overlay, .video-ads > *').forEach((node) => node.remove())
    engine.resumeAt = { id: 'v1', t: 12, tries: 0 }
    const ask = (video_id: string | undefined): { at: number; tries: number | undefined } => {
      player.getVideoData = video_id === undefined ? () => { throw new Error('lab: the player is mid-teardown') } : () => ({ video_id, title: '', author: '' })
      video?.dispatchEvent(new Event('playing'))
      return { at: video?.currentTime ?? 0, tries: engine.resumeAt?.tries }
    }
    const unknown = ask(undefined)
    const empty = ask('')
    const foreign = ask('outside')
    player.classList.add('ad-showing')
    const realNow = Date.now
    Date.now = () => realNow() + 60_000
    const advert = ask('advert')
    const confirmedInAdvert = engine.resumeAt?.confirmedAt
    Date.now = realNow
    player.classList.remove('ad-showing')
    player.getVideoData = real
    video?.dispatchEvent(new Event('playing'))
    return { start, unknown, empty, foreign, advert, confirmedInAdvert, named: video?.currentTime ?? 0 }
  })
  // Then: none spends it or starts expiry, and the exact target can still use it
  expect(saw.unknown).toEqual({ at: saw.start, tries: 0 })
  expect(saw.empty).toEqual({ at: saw.start, tries: 0 })
  expect(saw.foreign).toEqual({ at: saw.start, tries: 0 })
  expect(saw.advert).toEqual({ at: saw.start, tries: 0 })
  expect(saw.confirmedInAdvert).toBeUndefined()
  expect(saw.named, 'the place was spent by media that was not the track').toBeGreaterThanOrEqual(10)
})

// The seek is tallied rather than performed and the element's clock is
// hand-fed, so each bound on an armed place is observed without waiting on
// real time. Four pursuits, one per bound: the third readiness after two
// attempts, a window expired by hand, a place armed for a track the queue no
// longer expects, and a track heard past three seconds after a failed seek.
function driveBounded(): Record<'attempts' | 'expired' | 'elsewhere' | 'begun', number> {
  const engine = (window as unknown as { LAB: { engine: { resumeAt?: { id: string; t: number; tries: number; confirmedAt?: number }; state: { index: number }; tick(): void } } }).LAB.engine
  const player = document.getElementById('movie_player') as unknown as { seekTo: (s: number, ahead?: boolean) => void; getVideoData: () => { video_id: string } }
  const video = document.querySelector('video') as HTMLVideoElement
  let clock = 0
  Object.defineProperty(video, 'currentTime', { configurable: true, get: () => clock, set() {} })
  let seeks = 0
  player.seekTo = () => { seeks++ }
  const arm = (id: string): void => { engine.resumeAt = { id, t: 12, tries: 0 } }
  const ready = (named: string, at: number): number => {
    clock = at
    player.getVideoData = () => ({ video_id: named, title: '', author: '' })
    video.dispatchEvent(new Event('playing'))
    return seeks
  }
  arm('v1')
  ready('v1', 0); ready('v1', 0.5)
  const attempts = ready('v1', 1)
  arm('v1')
  if (engine.resumeAt) engine.resumeAt.confirmedAt = Date.now() - 16_000
  const expired = ready('v1', 0)
  arm('v2')
  engine.tick()
  engine.state.index = 1
  const elsewhere = ready('v2', 0)
  engine.state.index = 0
  arm('v1'); ready('v1', 0)
  clock = 4
  player.getVideoData = () => ({ video_id: 'v1' })
  engine.tick()
  const begun = ready('v1', 0)
  return { attempts, expired, elsewhere, begun }
}

test('a pursuit that cannot reach the place stands down on every bound', async ({ page }) => {
  // Given: a paused listen, its place armed, and a seek that goes nowhere
  await pauseQueue(page)
  // When: readiness keeps answering without the place ever being reached
  const saw = await page.evaluate(driveBounded)
  // Then: each bound stops the pursuit, and no later readiness jumps the track
  expect(saw.attempts, 'a third readiness sought again').toBe(2)
  expect(saw.expired, 'an expired window sought again').toBe(2)
  expect(saw.elsewhere, 'a track the queue no longer expects was sought').toBe(2)
  expect(saw.begun, 'a track that continued after a failed seek was jumped').toBe(3)
})

test('a tick on a ready exact target performs the first resume attempt', async ({ page }) => {
  // Given: an exact ready target naturally past three seconds before any seek was attempted
  await pauseQueue(page)
  // When: the engine observes it on its regular tick
  const seeks = await page.evaluate(() => {
    const engine = (window as unknown as { LAB: { engine: { resumeAt?: { id: string; t: number; tries: number }; tick(): void } } }).LAB.engine
    const player = document.getElementById('movie_player') as unknown as { seekTo: () => void; getVideoData: () => { video_id: string } }
    const video = document.querySelector('video') as HTMLVideoElement
    let count = 0
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 4, set() {} })
    player.getVideoData = () => ({ video_id: 'v1' })
    player.seekTo = () => { count++ }
    engine.resumeAt = { id: 'v1', t: 12, tries: 0 }
    engine.tick()
    return count
  })
  // Then: natural progress alone did not spend the continuation before its first attempt
  expect(seeks, 'the untouched resume was discarded before its first seek').toBe(1)
})
