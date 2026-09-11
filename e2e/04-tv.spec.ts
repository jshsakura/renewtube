// The television shape: shelves, a grid, and arrow keys that move between them.

import { expect, test } from '@playwright/test'
import { app, open, overlay, searchFor } from './fixture.ts'

const WATCH = 'https://www.youtube.com/watch?v=BzYnNdJhZQw'

test('둘러보기 comes back as titled shelves, signed out', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '음악' }).click()

    const shelves = ui.locator('.shelf:not([aria-hidden])')
    await expect(shelves.first()).toBeVisible()
    expect(await shelves.count()).toBeGreaterThan(3)
    // Each shelf is a titled row of cards.
    expect((await shelves.first().locator('h3').textContent())?.trim().length).toBeGreaterThan(0)
    expect(await shelves.first().locator('.tile:not([aria-hidden])').count()).toBeGreaterThan(2)
  } finally {
    await h.close()
  }
})

test('a card keeps add and options in one roomy action dock', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '음악' }).click()
    // A track tile (not a playlist tile) is the one with a channel to hide.
    const card = ui.locator('.shelf .tile:not([aria-hidden]):has(.tileMenu)').first()
    await expect(card).toBeVisible({ timeout: 30_000 })
    // One dock, two independently focusable commands. They used to float in
    // opposite corners and read as unrelated marks on the poster.
    await expect(card.locator('.tileActions')).toHaveCount(1)
    await expect(card.locator('.tileAdd')).toHaveCount(1)
    await expect(card.locator('.tileMenu')).toHaveCount(1)
    expect(await card.evaluate((el) => el.tagName), 'the card must not contain interactive descendants inside a button').toBe('DIV')
    await expect(card.locator('.tileAdd')).toHaveJSProperty('tagName', 'BUTTON')
    await expect(card.locator('.tileMenu')).toHaveJSProperty('tagName', 'BUTTON')
    await card.hover()
    const cover = (await card.locator('.cover').boundingBox())!
    const dock = (await card.locator('.tileActions').boundingBox())!
    const add = (await card.locator('.tileAdd').boundingBox())!
    const menuButton = (await card.locator('.tileMenu').boundingBox())!
    expect(add.width).toBeGreaterThanOrEqual(34)
    expect(menuButton.width).toBeGreaterThanOrEqual(34)
    expect(Math.round(add.y)).toBe(Math.round(menuButton.y))
    expect(menuButton.x).toBeGreaterThanOrEqual(add.x + add.width)
    expect(dock.x + dock.width).toBeLessThanOrEqual(cover.x + cover.width)
    expect(await card.locator('.tileActions').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
    await card.locator('.tileMenu').click()
    const menu = over.locator('.menu')
    await expect(menu).toBeVisible()
    for (const label of ['다음에 재생', '이 곡으로 라디오', '관심 없음', '유튜브에서 열기']) {
      await expect(menu.getByText(label, { exact: true })).toBeVisible()
    }
  } finally {
    await h.close()
  }
})

test('opening a shelf card opens that playlist', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '음악' }).click()
    const card = ui.locator('.shelf .tile:not([aria-hidden])').first()
    await expect(card).toBeVisible()
    const name = (await card.locator('.t').textContent())?.trim() ?? ''

    await card.click()
    await expect(ui.locator('.head h2')).toHaveText(name)
    await expect(ui.locator('.row:not([aria-hidden])').first()).toBeVisible()
  } finally {
    await h.close()
  }
})

test('a shelf can be dragged sideways with the mouse, and the drag is not a press', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '음악' }).click()
    const row = ui.locator('.shelf:not([aria-hidden]) .shelfRow').first()
    await expect(row.locator('.tile').first()).toBeVisible()
    const before = await row.evaluate((el) => el.scrollLeft)
    const box = (await row.boundingBox())!
    // Press on a card, travel left, let go: the row moves and nothing opens.
    const heading = await ui.locator('.head h2, .main h2').first().textContent().catch(() => null)
    await h.page.mouse.move(box.x + box.width * 0.6, box.y + 40)
    await h.page.mouse.down()
    for (let i = 1; i <= 8; i++) await h.page.mouse.move(box.x + box.width * 0.6 - i * 40, box.y + 40)
    await h.page.mouse.up()
    await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before + 100)
    await h.page.waitForTimeout(300)
    await expect(row.locator('.tile').first()).toBeVisible()
    expect(await ui.locator('.head h2, .main h2').first().textContent().catch(() => null)).toBe(heading)
    // And a plain press still opens the card.
    await row.locator('.tile:not([aria-hidden])').first().click()
    await expect(ui.locator('.row:not([aria-hidden])').first()).toBeVisible()
  } finally {
    await h.close()
  }
})

test('search opens over the screen, and its answers are rows', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '검색' }).click()
    // A panel, not a screen: the sidebar still says where we are.
    await expect(over.locator('.modal.search')).toBeVisible()
    await expect(ui.locator('.nav.on')).toHaveText('음악')
    await over.locator('.searchbox input').fill('lofi')
    await over.locator('.searchbox input').press('Enter')
    await expect(over.locator('.rows .row:not([aria-hidden])').first()).toBeVisible()

    // Escape puts the panel away and is spent on it: one press does not count
    // towards leaving the mode.
    await h.page.keyboard.press('Escape')
    await expect(over.locator('.modal.search')).toHaveCount(0)
    await expect(ui.locator('.app')).toBeVisible()
  } finally {
    await h.close()
  }
})

test('choosing a result plays it, and the panel closes over the screen it left', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '대기열' }).click()
    await expect(ui.locator('.nav.on')).toHaveText('대기열')

    await ui.locator('.nav', { hasText: '검색' }).click()
    const box = over.locator('.searchbox input')
    await expect(box).toBeFocused()
    // Typed, not filled: the answers arrive as the typing settles, without
    // Enter.
    await box.pressSequentially('아이유 밤편지', { delay: 20 })
    const first = over.locator('.row:not([aria-hidden])').first()
    await expect(first).toBeVisible()
    const title = (await first.locator('.title').textContent())?.trim() ?? ''

    await first.locator('.meta').click()
    await expect(over.locator('.modal.search')).toHaveCount(0)
    await expect(ui.locator('.bar .now .t')).toHaveText(title)
    // The screen underneath was never left.
    await expect(ui.locator('.nav.on')).toHaveText('대기열')
  } finally {
    await h.close()
  }
})

test('a result chosen from the queue screen becomes the row the queue sits on', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '대기열' }).click()
    await expect(ui.locator('.nav.on')).toHaveText('대기열')

    // The third answer, not the first. Choosing the top one would land on
    // index 0 whether the jump carried the index across or dropped it, and
    // this is the half of the panel that a queue screen makes visible: the
    // answers become the queue, and it is already sat on the one chosen.
    await searchFor(h.page, 'lofi')
    const third = over.locator('.rows .row:not([aria-hidden])').nth(2)
    await expect(third).toBeVisible()
    const id = await third.getAttribute('data-id')
    const title = (await third.locator('.title').textContent())?.trim() ?? ''
    expect(id).toBeTruthy()
    await third.locator('.meta').click()
    await expect(over.locator('.modal.search')).toHaveCount(0)

    // Still the queue screen, and it redrew itself around what was chosen:
    // third row, marked as playing, with 지금 재생 중 written above it.
    await expect(ui.locator('.nav.on')).toHaveText('대기열')
    const rows = ui.locator('.rows .row:not([aria-hidden])')
    await expect(rows.nth(2)).toHaveAttribute('data-id', id!)
    await expect(rows.nth(2)).toHaveClass(/now/)
    await expect(ui.locator('.queueMark').first()).toHaveText('지금 재생 중')
    await expect(ui.locator('.bar .now .t')).toHaveText(title)

    // And YouTube's own player was moved to that video, which is the half our
    // own state cannot vouch for: a queue can say anything.
    await expect
      .poll(() =>
        h.page.evaluate(() => {
          const p = document.getElementById('movie_player') as { getVideoData?: () => { video_id?: string } } | null
          return p?.getVideoData?.().video_id ?? ''
        }),
      )
      .toBe(id)
  } finally {
    await h.close()
  }
})

test('arrow keys move focus, and Enter opens what is focused', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    const over = overlay(h.page)
    await ui.locator('.nav', { hasText: '검색' }).click()
    await over.locator('.searchbox input').fill('아이유 밤편지')
    await over.locator('.searchbox input').press('Enter')
    await expect(over.locator('.row:not([aria-hidden])').first()).toBeVisible()

    // The panel is drawn in the overlay root, so that is where focus lives.
    const focused = () =>
      h.page.evaluate(() => {
        const root = document.querySelector('oc-easy-mode-overlay')!.shadowRoot!
        const el = root.activeElement as HTMLElement | null
        return el ? `${el.className}|${el.textContent?.slice(0, 24) ?? ''}` : null
      })

    // Down out of the search field walks into the answers and stops at a
    // track, and 전체 재생 is on the way rather than stepped over: the two
    // actions are as wide as the field for exactly that reason. What stands
    // between the field and them is the query's playlists and channels, when
    // it found any, so the walk is followed rather than counted.
    const classesOf = (state: string | null) => (state ?? '').split('|')[0]!.split(' ')
    await over.locator('.searchbox input').focus()
    const walk: string[][] = []
    for (let i = 0; i < 16; i++) {
      await h.page.keyboard.press('ArrowDown')
      walk.push(classesOf(await focused()))
      if (walk[walk.length - 1]!.includes('row')) break
    }
    expect(walk.flat()).toContain('searchAct')
    expect(walk[walk.length - 1]).toContain('row')

    // Enter plays it, the panel goes, and the bar agrees.
    await h.page.keyboard.press('Enter')
    await expect(over.locator('.modal.search')).toHaveCount(0)
    await expect(ui.locator('.bar .now .t')).not.toHaveText('재생 중인 항목 없음')
  } finally {
    await h.close()
  }
})

test('left from the first card reaches the sidebar', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '음악' }).click()
    // Wait for the shelves to settle: focusing an element that a redraw is
    // about to replace loses the focus and the press with it.
    //
    // The first shelf, not the fourth. How many YouTube sends back is its
    // business and it varies — this failed twice in a row on a run that
    // returned three, which says nothing about arrow keys.
    await expect(ui.locator('.shelf:not([aria-hidden])').first()).toBeVisible()
    await expect(ui.locator('.shelf .tile:not([aria-hidden])').first()).toBeVisible()

    await ui.locator('.shelf .tile:not([aria-hidden])').first().focus()
    await h.page.keyboard.press('ArrowLeft')

    const inSidebar = await h.page.evaluate(() => {
      const root = document.querySelector('oc-easy-mode')!.shadowRoot!
      const el = root.activeElement
      return el !== null && root.querySelector('.side')!.contains(el)
    })
    expect(inSidebar).toBe(true)
  } finally {
    await h.close()
  }
})

test('the wheel turns a shelf sideways, and lets the page have it at the end', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '음악' }).click()
    const row = ui.locator('.shelf:not([aria-hidden]) .shelfRow').first()
    await expect(row.locator('.tile').first()).toBeVisible()
    // Only a row with somewhere to go can answer this; a shelf that fits is
    // not a failure, it is a shelf that fits.
    const overflows = await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    test.skip(!overflows, 'this shelf has nothing past its edge')

    const left = () => row.evaluate((el) => el.scrollLeft)
    const box = (await row.boundingBox())!
    await h.page.mouse.move(box.x + box.width / 2, box.y + 40)
    await h.page.mouse.wheel(0, 300)
    await expect.poll(left).toBeGreaterThan(100)

    // At the end the wheel belongs to the page again. Without this the reader
    // is stopped half way down a screen of shelves with nothing to say why.
    await row.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    await h.page.waitForTimeout(300)
    const wall = await left()
    const main = ui.locator('.main')
    const before = await main.evaluate((el) => el.scrollTop)
    await h.page.mouse.move(box.x + box.width / 2, box.y + 40)
    await h.page.mouse.wheel(0, 400)
    await expect.poll(() => main.evaluate((el) => el.scrollTop)).toBeGreaterThan(before)
    expect(await left()).toBe(wall)
  } finally {
    await h.close()
  }
})

test('the arrows say a shelf has more, and only where there is more', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '음악' }).click()
    const shelf = ui.locator('.shelf:not([aria-hidden])').first()
    const row = shelf.locator('.shelfRow')
    await expect(row.locator('.tile').first()).toBeVisible()
    const overflows = await row.evaluate((el) => el.scrollWidth > el.clientWidth + 1)
    test.skip(!overflows, 'this shelf has nothing past its edge')

    // At the start there is nowhere to go back to, so that one is not drawn.
    //
    // Asked of the computed display rather than of the `hidden` property, and
    // that is the whole point of the assertion: the property was set correctly
    // all along while the button went on showing, because the stylesheet's own
    // `display` beat the browser's [hidden] rule. A test that read the
    // property passed on a screen that was visibly wrong (2026-09-06).
    const back = shelf.locator('.shelfArrow.back')
    const forward = shelf.locator('.shelfArrow.on')
    const drawn = (el: HTMLElement) => getComputedStyle(el).display !== 'none'
    await row.evaluate((el) => {
      el.scrollLeft = 0
    })
    await expect.poll(() => back.evaluate(drawn)).toBe(false)
    await expect.poll(() => forward.evaluate(drawn)).toBe(true)

    // Pressing it moves the row, and then there is a way back.
    await forward.click()
    await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100)
    await expect.poll(() => back.evaluate(drawn)).toBe(true)
  } finally {
    await h.close()
  }
})
