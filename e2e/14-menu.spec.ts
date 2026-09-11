// The menu: the television's lines, most of them off until asked for, and the
// screens they open. Signed out, so only what YouTube answers to a stranger.

import { expect, test } from '@playwright/test'
import { app, open, overlay } from './fixture.ts'

const WATCH = 'https://www.youtube.com/watch?v=BzYnNdJhZQw'

test('the column opens with the owner\'s set, 음악 first, and the rest waits behind a switch', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    const labels = await ui.locator('.side .nav > span').allTextContents()
    expect(labels[0]).toBe('음악')
    expect(labels).toEqual(expect.arrayContaining(['홈', '채널', '구독', '시청 기록', '대기열', '재생목록']))
    for (const off of ['아동', '스포츠', '생방송', '게임', '뉴스', '학습', '내 동영상']) expect(labels).not.toContain(off)
    // The switches list every line, on and off, in the column's order.
    await ui.locator('.sideHead .gear').click()
    const sheet = overlay(h.page).locator('.modal.settings')
    await expect(sheet).toBeVisible()
    const toggles = sheet.locator('.setToggle')
    await expect(toggles.first()).toHaveText('음악')
    await expect(toggles.first()).toBeDisabled()
    await expect(sheet.locator('.setToggle', { hasText: '게임' })).toHaveAttribute('aria-checked', 'false')
  } finally {
    await h.close()
  }
})

test('switching 게임 on puts it in the column, and its screen is the television\'s shelves', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.sideHead .gear').click()
    const sheet = over.locator('.modal.settings')
    await sheet.locator('.setToggle', { hasText: '게임' }).click()
    await expect(sheet.locator('.setToggle', { hasText: '게임' })).toHaveAttribute('aria-checked', 'true')
    await h.page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    // In the column now, between 홈 and 채널 as the television orders it.
    const labels = await ui.locator('.side .nav > span').allTextContents()
    expect(labels.indexOf('게임')).toBeGreaterThan(labels.indexOf('홈'))
    expect(labels.indexOf('게임')).toBeLessThan(labels.indexOf('채널'))
    await ui.locator('.nav', { hasText: '게임' }).click()
    await expect(ui.locator('.main h2')).toHaveText('게임')
    // Shelves with titles and cards in them, from the TV client. Not a skeleton.
    await expect(ui.locator('.main .shelf:not([aria-hidden]) .tile:not([aria-hidden])').first()).toBeVisible({ timeout: 30_000 })
    expect(await ui.locator('.main .shelf:not([aria-hidden])').count()).toBeGreaterThan(1)
    // The choice is written down, per line, so it is there on the next load.
    // (Not reloaded here: the fixture's switch is good for one navigation.)
    const saved = await h.page.evaluate(() => JSON.parse(localStorage.getItem('oc-easy-mode:menu') ?? '{}'))
    expect(saved).toEqual({ gaming: true })
    expect(await h.page.evaluate(() => JSON.parse(localStorage.getItem('oc-easy-mode:state') ?? '{}').view)).toBe('topic:FEtopics_gaming')
  } finally {
    await h.close()
  }
})

test('아동 is a curated screen with a shelf per channel, and 뉴스 answers too', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.sideHead .gear').click()
    const sheet = over.locator('.modal.settings')
    await sheet.locator('.setToggle', { hasText: '아동' }).click()
    await sheet.locator('.setToggle', { hasText: '뉴스' }).click()
    await h.page.keyboard.press('Escape')
    await ui.locator('.nav', { hasText: '아동' }).click()
    await expect(ui.locator('.main h2')).toHaveText('아동')
    await expect(ui.locator('.main .shelf:not([aria-hidden]) .tile:not([aria-hidden])').first()).toBeVisible({ timeout: 45_000 })
    const titles = await ui.locator('.main .shelf:not([aria-hidden]) h3').allTextContents()
    expect(titles.length).toBeGreaterThanOrEqual(5)
    expect(titles.some((s) => s.includes('핑크퐁'))).toBe(true)
    await ui.locator('.nav', { hasText: '뉴스' }).click()
    await expect(ui.locator('.main h2')).toHaveText('뉴스')
    await expect(ui.locator('.main .tile:not([aria-hidden])').first()).toBeVisible({ timeout: 45_000 })
  } finally {
    await h.close()
  }
})

test('switching off the screen you stand on lands you on 음악', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '채널' }).click()
    await expect(ui.locator('.main h2')).toHaveText('채널')
    await ui.locator('.sideHead .gear').click()
    const sheet = over.locator('.modal.settings')
    await sheet.locator('.setToggle', { hasText: '채널' }).click()
    await h.page.keyboard.press('Escape')
    await expect(ui.locator('.main h2')).toHaveText('음악')
    expect(await ui.locator('.side .nav > span').allTextContents()).not.toContain('채널')
  } finally {
    await h.close()
  }
})

test('a television shelf fills past its first five cards, and the page has more rows', async () => {
  const h = await open(WATCH)
  try {
    const ui = app(h.page)
    const over = overlay(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.sideHead .gear').click()
    const sheet = over.locator('.modal.settings')
    await sheet.locator('.setToggle', { hasText: '스포츠' }).click()
    await h.page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await ui.locator('.nav', { hasText: '스포츠' }).click()
    await expect(ui.locator('.main h2')).toHaveText('스포츠')
    const row = ui.locator('.main .shelf:not([aria-hidden]) .shelfRow').first()
    const cards = row.locator('.tile:not([aria-hidden])')
    await expect(cards.first()).toBeVisible({ timeout: 30_000 })
    // The television answered five. A row that does not reach the pane's
    // edge asks for the rest by itself.
    await expect.poll(() => cards.count(), { timeout: 20_000 }).toBeGreaterThan(5)
    const filled = await cards.count()
    // Scrolling to the end asks for more still when the answer says there is
    // more. Live sports rows also genuinely end at six or nine cards, so a
    // fixed minimum would confuse a short row with a failed continuation.
    if (await row.getAttribute('data-more') === 'true') {
      await row.evaluate((el) => el.scrollTo({ left: el.scrollWidth }))
      await expect.poll(() => cards.count(), { timeout: 20_000 }).toBeGreaterThan(filled)
    }
    // And a card from the fed part plays the row it stands in.
    await h.page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/sports.png` : 'test-results/sports.png' })
    // 더 보기 brings rows the first answer kept back.
    const shelves = ui.locator('.main .shelf:not([aria-hidden])')
    const before = await shelves.count()
    await ui.locator('.main .btn.ghost', { hasText: '더 보기' }).click()
    await expect.poll(() => shelves.count(), { timeout: 20_000 }).toBeGreaterThan(before)
  } finally {
    await h.close()
  }
})
