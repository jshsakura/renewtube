// Every way a track can fail to play, and the answer to each.
//
// The rest of the suite runs against the real YouTube, signed out, where the
// player always plays — so it cannot reach the failures that actually reach the
// owner. Those happen on a signed-in account: a player that takes the track and
// fetches nothing, one that loads it and sits on it, an advert that never ends.
// Here the player is built to fail on purpose, the real engine is attached to
// it, and each behaviour is asked the one question that matters: **does
// something end up playing?**
//
// The failures are drawn from what was measured on the owner's machine and from
// the diagnostics screen; see `docs/playback.md` for the ladder these tests
// hold in place. A rescue that navigates navigates for real here, and the page
// it lands on is served the same way — so what is under test is the whole
// recovery across pages, not one step of it.

import { expect, test } from '@playwright/test'
import { expectSound, lab, labLog, playQueue, view, type Fault } from './lab/fixture.ts'

/** The behaviours a track must survive on its own page, with a healthy watch page behind them. */
const RECOVERABLE: Array<[Fault, string]> = [
  ['dormant', 'takes the track and fetches nothing'],
  ['loaded-paused', 'loads the track and sits on it'],
  ['ad-phantom', 'wears the advert clothes with nothing playing'],
  ['error', 'gives up on the source'],
  ['throws', 'throws at every call'],
  ['no-player', 'has no player at all'],
]

for (const [fault, what] of RECOVERABLE) {
  test(`a player that ${what} still ends with the track playing`, async ({ page }) => {
    await lab(page, { fault, watch: 'healthy' })
    await playQueue(page)
    await expectSound(page)
    // It got there by handing the track to a page with a live player, which is
    // the first rung and the one that costs an address change.
    const v = await view(page)
    expect(v.path).toBe('/watch')
    expect(v.videoId).toBe('v1')
    // And the track that plays is the one that was pressed, not the next.
    expect(v.queue[0]!.unavailable).toBe(false)
  })
}

test('a healthy player plays where it stands, and never changes the address', async ({ page }) => {
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page, 8000)
  await page.waitForTimeout(3000)
  const v = await view(page)
  expect(v.path).toBe('/')
  expect(v.sounding).toBe(true)
})

test('a slow start is waited for, not rescued', async ({ page }) => {
  // Four seconds of waiting, then sound. Nothing about it is broken, and a
  // rescue would throw away the load that was about to land — so the address
  // must not change and the track must be the same one.
  await lab(page, { fault: 'slow' })
  await playQueue(page)
  await expectSound(page, 15_000)
  const v = await view(page)
  expect(v.path).toBe('/')
  expect(v.playingTitle).toBe('track 1')
})

test('a real advert is left to finish, and the track plays after it', async ({ page }) => {
  await lab(page, { fault: 'ad-real' })
  await playQueue(page)
  await expectSound(page, 10_000)
  // Long enough for the advert to end and the track to take over.
  await page.waitForTimeout(4000)
  const v = await view(page)
  expect(v.path, 'an advert is not a failure').toBe('/')
  expect(v.sounding).toBe(true)
  expect(v.playingTitle).toBe('track 1')
})

test('a player stuck at Unstarted plays anyway, and the speed still reaches the sound', async ({ page }) => {
  await lab(page, { fault: 'stuck-unstarted' })
  await playQueue(page)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { engine: { setRate(r: number): void } } }).LAB.engine.setRate(1.5))
  // The player's own rate setter is ignored in this state; the element's is
  // what carries the sound, and it is re-asserted on the tick.
  await expect
    .poll(() => page.evaluate(() => document.querySelector('video')?.playbackRate ?? 0), { timeout: 8000 })
    .toBe(1.5)
  expect((await view(page)).path, 'a playing track is never handed away').toBe('/')
})

test('a wait that never ends is not waited for for ever', async ({ page }) => {
  // A buffering element is left alone, because that is what a slow start looks
  // like from outside. Past the point where the transport has already given up
  // claiming to load, it is the same silence as a player that took nothing.
  await lab(page, { fault: 'stall', watch: 'healthy' })
  await playQueue(page)
  await expectSound(page, 40_000)
  expect((await view(page)).path).toBe('/watch')
})

test('a browser that wants a gesture is given one, not a navigation', async ({ page }) => {
  // WebKit refuses `play()` under script until a press has started media once.
  // The track is loaded and a press away: navigating would throw that away and
  // land on a page that cannot start itself either.
  await lab(page, { fault: 'play-rejects' })
  await playQueue(page)
  await page.waitForTimeout(7000)
  const waiting = await view(page)
  expect(waiting.sounding).toBe(false)
  expect(waiting.path, 'a loaded track waiting for a press must stay put').toBe('/')
  expect(waiting.trouble, 'and it must not be given up on').toBeUndefined()
  await page.evaluate(() => (window as unknown as { LAB: { toggle(): void } }).LAB.toggle())
  await expectSound(page, 10_000)
})

test('a player swapped out from under a playing track takes the track with it', async ({ page }) => {
  // YouTube rebuilds its player as it navigates itself, and the new one knows
  // nothing about what was playing. The music must not stop there.
  await lab(page, { fault: 'swap' })
  await playQueue(page)
  await expectSound(page, 15_000)
  const v = await view(page)
  expect(v.path, 'and it is picked up in place, without an address change').toBe('/')
  expect(v.playingTitle).toBe('track 1')
})

test('a watch page that is dead too is rebuilt, and then plays', async ({ page }) => {
  // The last resort before giving up: the arrival is dormant as well, so the
  // page itself is built again from nothing, which is the one thing left that
  // makes a live player.
  await lab(page, { fault: 'dormant', watch: 'dormant', reload: 'healthy' })
  await playQueue(page)
  await expectSound(page, 25_000)
  const v = await view(page)
  expect(v.path).toBe('/watch')
  expect(v.visit, 'the watch page was opened a second time').toBeGreaterThan(1)
})

test('a track nothing will play is given up and the queue carries on', async ({ page }) => {
  // Every rung spent on one track. Sitting on it is the failure the listener
  // actually feels — the music simply stopped — so the queue moves on and the
  // row is marked, and the next track plays.
  await lab(page, { fault: 'dormant', watch: 'dormant', reload: 'dormant', dead: ['v1'] })
  await playQueue(page, 3)
  await expectSound(page, 45_000)
  const v = await view(page)
  expect(v.playingTitle, 'the dead track was left behind').toBe('track 2')
  expect(v.queue[0]!.unavailable, 'and marked, so nothing walks back into it').toBe(true)
  expect(v.index).toBe(1)
})

test('a queue with nothing playable in it stops, rather than looping for ever', async ({ page }) => {
  await lab(page, { fault: 'dormant', watch: 'dormant', reload: 'dormant' })
  await playQueue(page, 1)
  await expect
    .poll(async () => (await view(page)).trouble, { timeout: 45_000 })
    .toBe('v1')
  // Bounded: one navigation and one reload for the track, and then it stops.
  // A ladder that forgot what it had spent would still be going.
  const before = (await labLog(page)).filter((l) => l.what === 'boot').length
  await page.waitForTimeout(8000)
  const after = (await labLog(page)).filter((l) => l.what === 'boot').length
  expect(after, 'no more pages were opened after it gave up').toBe(before)
  expect(before, 'home, the watch page, and one rebuild of it').toBeLessThanOrEqual(3)
})

test('a track paused on purpose is left alone', async ({ page }) => {
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { toggle(): void } }).LAB.toggle())
  await page.waitForTimeout(7000)
  const v = await view(page)
  expect(v.sounding, 'a pause is a pause').toBe(false)
  expect(v.path, 'and never a reason to move').toBe('/')
  expect(v.trouble).toBeUndefined()
})

test('the end of a track is the start of the next one', async ({ page }) => {
  await lab(page, { fault: 'healthy' })
  await playQueue(page, 2)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { skipToEnd(): void } }).LAB.skipToEnd())
  await expect.poll(async () => (await view(page)).playingTitle, { timeout: 15_000 }).toBe('track 2')
  await expectSound(page, 10_000)
})

test('a video YouTube autoplays outside the queue is rejected', async ({ page }) => {
  // The phone showed one title in the bar and another video in the picture
  // (2026-09-09, "화면에보이는 영상하고 하단 재생기의 영상이 다른시점").
  // That is not a stalled clock: the wrong video is healthy and moving, which
  // is why accepting movement alone left the split state there for ever.
  await lab(page, { fault: 'healthy' })
  await playQueue(page, 2)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { autoplay(id: string): void } }).LAB.autoplay('outside'))
  await expect.poll(async () => (await view(page)).playerVideoId, { timeout: 8000 }).toBe('v1')
  const v = await view(page)
  expect(v.playingTitle).toBe('track 1')
  expect(v.index).toBe(0)
  await expectSound(page, 5000)
})

test('YouTube video controls advance RenewTube queue instead of autonav', async ({ page }) => {
  // The visible player and the bar share one media element but not one queue.
  // Measured 2026-09-10: "영상에서 다음재생을 누르면 안넘어가네 ... 같은영상이
  // 계속 나오는상황 그러나 재생기쪽 다음영상은 잘됨". The native press must
  // become the exact same engine action as the bar's Next button.
  await lab(page, { fault: 'healthy' })
  await playQueue(page, 3)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { nativeNext(): void } }).LAB.nativeNext())
  await expect.poll(async () => (await view(page)).playerVideoId, { timeout: 8000 }).toBe('v2')
  const v = await view(page)
  expect(v.playingTitle).toBe('track 2')
  expect(v.index).toBe(1)
})

test('an unrequested autoplay is stopped without inventing a current track', async ({ page }) => {
  await lab(page, { fault: 'healthy' })
  await page.evaluate(() => (window as unknown as { LAB: { autoplay(id: string): void } }).LAB.autoplay('outside'))
  // Past the foreign-video grace: checking at time zero would pass merely
  // because the fake video's first clock tick had not happened yet.
  await page.waitForTimeout(3500)
  expect(await page.evaluate(() => document.querySelector('video')?.paused)).toBe(true)
  const v = await view(page)
  expect(v.sounding).toBe(false)
  expect(v.playingTitle).toBe('')
  expect(v.index).toBe(-1)
})

test('a swallowed next load cannot leave the previous video playing under the next title', async ({ page }) => {
  // The other observed ending, 2026-09-09: "하나 재생후 다음꺼 재생안되고
  // 멈추는". The fake player accepts and plays v1, then ignores every request
  // for v2 while v1 keeps moving. The bounded ladder must get v2 onto a healthy
  // watch player rather than calling v1's clock success.
  await lab(page, { fault: 'keeps-previous', watch: 'healthy' })
  await playQueue(page, 3)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { next(): void } }).LAB.next())
  await expect.poll(async () => (await view(page)).playerVideoId, { timeout: 12_000 }).toBe('v2')
  const v = await view(page)
  expect(v.playingTitle).toBe('track 2')
  expect(v.index).toBe(1)
  await expectSound(page, 5000)
})

test('a stored queue never claims its old track over an empty player', async ({ page }) => {
  // localStorage remembers the queue, not a fact about a media element that
  // died with the last document. With no watch id and no player id, the cursor
  // is stale and the bar must start empty; the rows remain available to press.
  await page.addInitScript(() => {
    localStorage.setItem('oc-easy-mode:state', JSON.stringify({
      queue: [{ videoId: 'stale', title: 'stale track', byline: 'lab', duration: '0:30', unavailable: false }],
      index: 0,
      video: 'stage',
    }))
  })
  await lab(page, { fault: 'healthy' })
  const v = await view(page)
  expect(v.playingTitle).toBe('')
  expect(v.index).toBe(-1)
  expect(v.queue.map((track) => track.id)).toEqual(['stale'])
})

test('a dead track in the middle of a queue does not stop the ones after it', async ({ page }) => {
  // The whole point of the ladder, said in one run: press the first track,
  // walk away, and the queue is still playing when you come back.
  await lab(page, { fault: 'dormant', watch: 'dormant', reload: 'dormant', dead: ['v2'] })
  await playQueue(page, 3)
  await expectSound(page, 15_000)
  await page.evaluate(() => (window as unknown as { LAB: { skipToEnd(): void } }).LAB.skipToEnd())
  await expect.poll(async () => (await view(page)).playingTitle, { timeout: 60_000 }).toBe('track 3')
  await expectSound(page, 15_000)
})

test('a phone recovers the same way a desktop does', async ({ page }) => {
  // The phone is where the owner meets this most, and it used to be exempt
  // from the rescue on the grounds that an arrival cannot start itself. It
  // lands paused there, but that player's play button works, unlike the dead
  // one it came from.
  await page.setViewportSize({ width: 390, height: 844 })
  await lab(page, { fault: 'dormant', watch: 'healthy' })
  await playQueue(page)
  await expectSound(page)
  expect((await view(page)).path).toBe('/watch')
})

test('nothing plays, and nothing moves, on a page nobody has pressed', async ({ page }) => {
  // The ladder only ever answers for a track someone asked to hear. A page
  // sitting there with a queue and no press must be left exactly as it is —
  // an address change out of nowhere would be the worst bug in the set.
  await lab(page, { fault: 'dormant' })
  await page.waitForTimeout(9000)
  const v = await view(page)
  expect(v.path).toBe('/')
  expect(v.sounding).toBe(false)
  expect(v.trouble).toBeUndefined()
})

test('a watch page opened by hand plays nothing by itself and is never rescued', async ({ page }) => {
  // Arriving on a video without our mark is the reader's own doing: the page's
  // start is held down until they press, and a held track is not a failing one.
  await lab(page, { fault: 'healthy' }, '/watch?v=v1')
  await page.waitForTimeout(9000)
  const v = await view(page)
  expect(v.sounding, 'the page\'s own start stays held').toBe(false)
  expect(v.path).toBe('/watch')
  expect(v.trouble).toBeUndefined()
})

test('a remembered watch track that collapses into paused buffering is recovered', async ({ page }) => {
  // Real iPhone, 2026-09-09: URL, player and queue all named T6GNG4A8U0c,
  // but the engine said "요청 없음 · 도착 보류 중" while the player stayed
  // State.Buffering and its loaded element stayed paused at zero for 21.4s.
  // This is a reload of the track already being heard, not an unrelated watch
  // autoplay; carry its intent over, then make the bounded ladder answer when
  // the impossible paused-buffering combination does not clear.
  await page.addInitScript(() => {
    localStorage.setItem('oc-easy-mode:state', JSON.stringify({
      queue: [{ videoId: 'v1', title: 'track 1', byline: 'lab', duration: '0:30', unavailable: false }],
      index: 0,
      video: 'stage',
    }))
  })
  await lab(page, { fault: 'paused-buffering', reload: 'healthy' }, '/watch?v=v1')
  // It really is heard first; do not let that short healthy window satisfy
  // the assertion that is meant to answer what happens after the collapse.
  await expectSound(page, 5000)
  await expect
    .poll(async () => (await view(page)).sounding, { timeout: 5000 })
    .toBe(false)
  await expectSound(page, 30_000)
  const v = await view(page)
  expect(v.videoId).toBe('v1')
  expect(v.playerVideoId).toBe('v1')
  expect(v.playingTitle).toBe('track 1')
  expect(v.visit, 'the stuck watch player was rebuilt').toBeGreaterThan(1)
})

test('repeating one track restarts it rather than rescuing it', async ({ page }) => {
  await lab(page, { fault: 'healthy' })
  await playQueue(page, 2)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { setRepeat(m: string): void } }).LAB.setRepeat('one'))
  await page.evaluate(() => (window as unknown as { LAB: { skipToEnd(): void } }).LAB.skipToEnd())
  await page.waitForTimeout(5000)
  const v = await view(page)
  expect(v.playingTitle, 'the same track, again').toBe('track 1')
  expect(v.path, 'and no rescue for a track that is playing').toBe('/')
  expect(v.sounding).toBe(true)
})

test('choosing another track while one is failing plays the new one, and forgets the old', async ({ page }) => {
  // The press that matters is the last one. A ladder still working on the
  // abandoned track would navigate out from under the new one, which reads as
  // the app choosing its own music.
  await lab(page, { fault: 'dormant', dead: ['v1'] })
  await playQueue(page, 3)
  await page.waitForTimeout(800)
  await page.evaluate(() => (window as unknown as { LAB: { jumpTo(i: number): void } }).LAB.jumpTo(1))
  await expectSound(page, 10_000)
  await page.waitForTimeout(4000)
  const v = await view(page)
  expect(v.playingTitle).toBe('track 2')
  expect(v.path, 'the abandoned track took nothing with it').toBe('/')
  expect(v.sounding).toBe(true)
})

test('a track that dies halfway is picked back up', async ({ page }) => {
  // Playing, and then nothing: the element still there, not paused, the clock
  // simply stopped. Nobody pressed anything, so this is a failure like any
  // other and the ladder answers for it.
  await lab(page, { fault: 'healthy', watch: 'healthy' })
  await playQueue(page)
  await expectSound(page, 10_000)
  await page.evaluate(() => {
    const v = document.querySelector('video') as (HTMLVideoElement & { labState: { waiting: boolean } }) | null
    if (v) v.labState.waiting = true
  })
  await expectSound(page, 35_000)
  expect((await view(page)).path, 'and the track it died on is the one that plays').toBe('/watch')
  expect((await view(page)).videoId).toBe('v1')
})

test('a track paused from outside the app stays paused', async ({ page }) => {
  // The pause button in a Picture-in-Picture window, the one on a lock screen,
  // the one on a headset: none of them goes through our transport, and all of
  // them look from here exactly like a track that stopped by itself. A track
  // that has been heard is never taken back by the ladder.
  await lab(page, { fault: 'healthy', watch: 'healthy' })
  await playQueue(page)
  await expectSound(page, 10_000)
  await page.evaluate(() => {
    const v = document.querySelector('video')
    v?.pause()
  })
  await page.waitForTimeout(9000)
  const v = await view(page)
  expect(v.sounding, 'a pause somebody made is a pause').toBe(false)
  expect(v.path, 'and never a reason to move the page').toBe('/')
})

test('a track iOS pauses while entering the background is handed back to background audio', async ({ page }) => {
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page, 10_000)
  await page.evaluate(() => (window as unknown as { LAB: { background(): void } }).LAB.background())
  await expectSound(page, 10_000)
  const v = await view(page)
  expect(v.path, 'background hand-off does not reload the player').toBe('/')
  expect(v.playingTitle).toBe('track 1')
})

test('a late WebKit pause during background hand-off is recovered only once', async ({ page }) => {
  await lab(page, { fault: 'healthy' })
  await playQueue(page)
  await expectSound(page, 10_000)
  // Measured on iPhone Safari/Orion, 2026-09-10: "나갈때간헐적으로 재생을
  // 놓치네 중단되는데". The hidden signal can arrive while sound still runs;
  // WebKit pauses the element only after that callback has already returned.
  await page.evaluate(() => (window as unknown as { LAB: { backgroundLate(): void } }).LAB.backgroundLate())
  await page.waitForTimeout(2600)
  await expectSound(page, 10_000)

  // The hand-off must not become a general keep-playing switch. Once its short
  // window has passed, a lock-screen, headset or PiP pause still belongs to
  // the reader and stays paused.
  await page.waitForTimeout(700)
  await page.evaluate(() => document.querySelector('video')?.pause())
  await page.waitForTimeout(3000)
  expect((await view(page)).sounding, 'a later deliberate pause is left alone').toBe(false)
})
