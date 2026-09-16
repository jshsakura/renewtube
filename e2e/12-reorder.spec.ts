// Reordering: the rule that keeps the music playing, and the request that
// asks YouTube to do the same to a playlist.
//
// The drag itself is asserted on the screen; these are the two pieces
// underneath it that can be checked without one.

import { expect, test } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { app, open } from './fixture.ts'
import { movedIndex } from '../src/main/engine.ts'

// ── Where the playing track ends up ────────────────────────────────────────
//
// A queue may hold the same video twice, so this cannot be recovered after the
// fact by searching for the track: the index has to be carried through the
// move. Checked against an actual array move rather than against worked
// examples, because the off-by-one lives in the cases nobody thinks to write.

test('the index follows its own track through every possible move', () => {
  const wrong: string[] = []
  let checked = 0
  for (let len = 1; len <= 8; len++) {
    const base = Array.from({ length: len }, (_, i) => i)
    for (let current = 0; current < len; current++) {
      for (let from = 0; from < len; from++) {
        for (let to = 0; to < len; to++) {
          if (from === to) continue
          const q = base.slice()
          const playing = q[current]
          const [lifted] = q.splice(from, 1)
          q.splice(to, 0, lifted!)
          const got = movedIndex(current, from, to)
          checked += 1
          if (q[got] !== playing) wrong.push(`len=${len} current=${current} ${from}->${to}: ${got} holds ${q[got]}, wanted ${playing}`)
        }
      }
    }
  }
  expect(wrong.slice(0, 5)).toEqual([])
  expect(checked).toBeGreaterThan(600)
})

test('an empty queue has no index to move', () => {
  // -1 is "nothing is playing", and it stays that whatever the list does.
  expect(movedIndex(-1, 0, 3)).toBe(-1)
})

// ── What a queue may hold ──────────────────────────────────────────────────

test('a stored queue comes back without the rows it could not play', async () => {
  // The reader's rule, 2026-09-16: "재생할수없는건 애초에담지말자 화면에서
  // 지우진말고". A queue stored by an older build — or a ladder that gave up
  // mid-listen — may still carry a dead row; it leaves at the door, and the
  // cursor stays on the track it was on.
  const h = await open('https://www.youtube.com/')
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    // The harness's background answers musicMode: false and clears the quick
    // flag while the app is up; set both again for the load that follows.
    await h.page.addInitScript(() => {
      try {
        localStorage.setItem('oc-easy-mode:on', '1')
        localStorage.setItem('oc-easy-mode:state', JSON.stringify({
          lang: 'ko',
          queue: [
            { videoId: 'alive1', title: 'alive one', byline: 'lab', duration: '0:30', unavailable: false },
            { videoId: 'dead', title: 'dead one', byline: 'lab', duration: '0:30', unavailable: true },
            { videoId: 'alive2', title: 'alive two', byline: 'lab', duration: '0:30', unavailable: false },
          ],
          index: 2,
          video: 'hidden',
        }))
      } catch {}
    })
    await h.page.reload()
    await expect(ui.locator('.app')).toBeVisible()

    await ui.locator('.nav', { hasText: '대기열' }).click()
    const titles = await ui.locator('.rows .row .title').allTextContents()
    expect(titles).toContain('alive two')
    expect(titles).not.toContain('dead one')
    const after = await queueState(h.page)
    expect(after.ids).toEqual(['alive1', 'alive2'])
    // The cursor is honestly empty: a browse address cannot vouch that
    // anything is still playing, and that rule is older than this one.
    expect(after.index).toBe(-1)
  } finally {
    await h.close()
  }
})

test('the moved row is the one that lands where it was dropped', () => {
  expect(movedIndex(2, 2, 0)).toBe(0)
  expect(movedIndex(0, 0, 4)).toBe(4)
})

// ── And on the screen ──────────────────────────────────────────────────────

const WATCH = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'

const titles = (page: import('@playwright/test').Page) =>
  app(page).locator('.rows .row .title').allTextContents()

const queueState = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('oc-easy-mode:state') ?? '{}')
    return { index: s.index as number, ids: (s.queue ?? []).map((t: { videoId: string }) => t.videoId) as string[] }
  })

test('a queue row moves, and the music does not stop', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    const over = h.page.locator('oc-easy-mode-overlay')
    await ui.locator('.nav', { hasText: '검색' }).click()
    await expect(over.locator('.modal.search')).toBeVisible()
    await over.locator('.searchbox input').fill('lofi')
    await over.locator('.searchbox input').press('Enter')
    await expect(over.locator('.rows .row:not([aria-hidden])').first()).toBeVisible()
    await over.locator('.rows .row:not([aria-hidden])').first().click()

    await ui.locator('.nav', { hasText: '대기열' }).click()
    await expect(ui.locator('.rows .row').first()).toBeVisible()
    const before = await queueState(h.page)
    test.skip(before.ids.length < 3, 'needs a queue of at least three')

    // The third row goes up one, through the menu, which is the path a remote
    // takes and the one that works without a pointer.
    const third = ui.locator('.rows .row').nth(2)
    await third.locator('.more').first().click()
    await over.locator('.menu button', { hasText: '위로' }).click()

    await expect
      .poll(() => queueState(h.page).then((q) => q.ids.join(',')))
      .toBe([...before.ids.slice(0, 1), before.ids[2], before.ids[1], ...before.ids.slice(3)].join(','))

    // The row that was playing is still the row that is playing.
    const after = await queueState(h.page)
    expect(after.ids[after.index]).toBe(before.ids[before.index])
    // And the player was never asked to load anything.
    expect(await h.page.evaluate(() => !document.querySelector('video')?.paused)).toBe(true)
  } finally {
    await h.close()
  }
})

// ── What we ask YouTube for ────────────────────────────────────────────────
//
// **The playlist half cannot be driven from here.** Moving a row needs a
// setVideoId, the handle a slot only has on a list you own, and this browser
// has no session: measured on two public lists, 151 tracks and not one
// setVideoId between them. So there is no honest fixture of that screen, and
// what is checked instead is the request itself, with the real function called
// against a held fetch. Whether YouTube accepts the body needs an account.

test('a move names the slot, and the row it should follow', async () => {
  const built = await build({
    stdin: {
      contents: `export { movePlaylistTrack } from '${resolve(import.meta.dirname, '../src/main/api.ts')}'
                 export { readYtCfg } from '${resolve(import.meta.dirname, '../src/main/ytcfg.ts')}'`,
      resolveDir: resolve(import.meta.dirname, '..'),
      loader: 'ts',
    },
    bundle: true, format: 'iife', globalName: '__mv', write: false, target: 'es2022',
  })

  const h = await open('https://www.youtube.com/')
  try {
    await h.page.evaluate(built.outputFiles[0]!.text)
    const sent = await h.page.evaluate(async () => {
      const { movePlaylistTrack, readYtCfg } = (window as unknown as {
        __mv: {
          movePlaylistTrack(cfg: unknown, id: string, slot: string, after?: string): Promise<void>
          readYtCfg(): unknown
        }
      }).__mv
      const cfg = readYtCfg()
      const bodies: string[] = []
      const real = window.fetch.bind(window)
      window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (url.includes('/youtubei/v1/browse/edit_playlist')) {
          bodies.push(String(init?.body ?? ''))
          return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
        }
        return real(input as RequestInfo, init)
      }) as typeof fetch
      try {
        await movePlaylistTrack(cfg, 'PL_test', 'SLOT_MOVED', 'SLOT_ABOVE')
        await movePlaylistTrack(cfg, 'PL_test', 'SLOT_MOVED', undefined)
      } finally {
        window.fetch = real
      }
      return bodies.map((b) => JSON.parse(b) as { playlistId: string; actions: Array<Record<string, string>> })
    })

    expect(sent).toHaveLength(2)
    // Placed after another row, which is the only kind of move YouTube has.
    expect(sent[0]!.playlistId).toBe('PL_test')
    expect(sent[0]!.actions[0]).toEqual({
      action: 'ACTION_MOVE_VIDEO_AFTER',
      setVideoId: 'SLOT_MOVED',
      movedSetVideoIdPredecessor: 'SLOT_ABOVE',
    })
    // Dropped at the top: there is nothing to follow, and the field is left
    // out rather than sent empty.
    expect(sent[1]!.actions[0]).toEqual({
      action: 'ACTION_MOVE_VIDEO_AFTER',
      setVideoId: 'SLOT_MOVED',
    })
  } finally {
    await h.close()
  }
})

test('a queue row can be dragged to a new place', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = h.page.locator('oc-easy-mode-overlay')
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '검색' }).click()
    await over.locator('.searchbox input').fill('lofi')
    await over.locator('.searchbox input').press('Enter')
    await expect(over.locator('.rows .row:not([aria-hidden])').first()).toBeVisible()
    await over.locator('.rows .row:not([aria-hidden])').first().click()

    await ui.locator('.nav', { hasText: '대기열' }).click()
    await expect(ui.locator('.rows .row').first()).toBeVisible()
    const before = await queueState(h.page)
    test.skip(before.ids.length < 4, 'needs a queue of at least four')

    // Carry the fourth row up into the top half of the second.
    //
    // The half matters: a drop is decided against the middle of the row under
    // the pointer, so finishing on that middle exactly is a drop *below* it,
    // and the row lands one place further down than the reader meant. Aiming
    // at the upper quarter is what a person does when they mean "above this".
    const rows = ui.locator('.rows .row')
    const fourth = (await rows.nth(3).boundingBox())!
    const second = (await rows.nth(1).boundingBox())!
    const startY = fourth.y + fourth.height / 2
    const endY = second.y + second.height / 4
    const x = fourth.x + fourth.width / 2
    await h.page.mouse.move(x, startY)
    await h.page.mouse.down()
    for (let i = 1; i <= 6; i++) {
      await h.page.mouse.move(x, startY + ((endY - startY) * i) / 6, { steps: 2 })
    }
    // The line says where it will land before it lands.
    await expect(ui.locator('.dropLine')).toHaveCount(1)
    await h.page.mouse.up()

    await expect
      .poll(() => queueState(h.page).then((q) => q.ids[1]))
      .toBe(before.ids[3])
    const after = await queueState(h.page)
    expect(after.ids).toHaveLength(before.ids.length)
    // Still the same track playing, and still playing it.
    expect(after.ids[after.index]).toBe(before.ids[before.index])
    expect(await h.page.evaluate(() => !document.querySelector('video')?.paused)).toBe(true)
  } finally {
    await h.close()
  }
})
