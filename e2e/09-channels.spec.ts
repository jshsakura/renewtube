// The subscription filter: choosing channels narrows 구독, and clearing it
// puts everything back.
//
// **The feed is served from a fixture rather than from the account.** 구독
// needs a session and this browser has none: signed out the endpoint answers
// with nothing at all, which is what the safety suite checks for. So the
// browse is intercepted and answered with a cut of a live response, six rows
// from three channels. That makes the screen deterministic as well as
// reachable: a filter test whose row counts depend on what a real account
// happens to be subscribed to today is a test that fails for the wrong reason.

import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, open } from './fixture.ts'
import { channelsOf, applyFilter, searchChannels } from '../src/main/ui/channels.ts'
import { tracks as parseTracks } from '../src/main/parse.ts'

const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'search-channel-ids.json'), 'utf8')

/** Answers the subscriptions browse, and only that one, with the fixture. */
async function serveSubs(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/youtubei/v1/browse*', async (route) => {
    const body = route.request().postData() ?? ''
    if (!body.includes('FEsubscriptions')) return route.fallback()
    await route.fulfill({ status: 200, contentType: 'application/json', body: fixture })
  })
}

// ── The rule itself, without a browser ─────────────────────────────────────

const parsed = parseTracks(JSON.parse(fixture) as never)

test('the channel list is built from the feed, most prolific first', () => {
  const list = channelsOf(parsed)
  expect(list.length).toBe(3)
  expect(list[0]!.count).toBeGreaterThanOrEqual(list[1]!.count)
  expect(list.reduce((n, c) => n + c.count, 0)).toBe(parsed.length)
  expect(list.every((c) => c.id.startsWith('UC') && c.name.length > 0)).toBe(true)
})

test('an empty filter is no filter, and a chosen one keeps only its channels', () => {
  expect(applyFilter(parsed, [])).toHaveLength(parsed.length)
  const [first] = channelsOf(parsed)
  const only = applyFilter(parsed, [first!.id])
  expect(only).toHaveLength(first!.count)
  expect(only.every((t) => t.channelId === first!.id)).toBe(true)
  // A channel nobody published to leaves the screen empty rather than full.
  expect(applyFilter(parsed, ['UCnotarealchannelid'])).toHaveLength(0)
})

test('channel search ignores case and surrounding spaces', () => {
  const list = channelsOf(parsed)
  const wanted = list[0]!
  expect(searchChannels(list, `  ${wanted.name.toLocaleUpperCase()}  `)).toEqual([wanted])
  expect(searchChannels(list, 'a name that is not here')).toEqual([])
  expect(searchChannels(list, '')).toBe(list)
})

// ── And on the screen ──────────────────────────────────────────────────────

test('choosing a channel narrows the feed, and clearing it brings the rest back', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await serveSubs(h.page)
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()

    const rows = ui.locator('.row:not([aria-hidden])')
    await expect(rows).toHaveCount(parsed.length)

    // Open the checklist and keep only the channel with the most rows.
    await ui.locator('.chanFilter').click()
    const picker = h.page.locator('oc-easy-mode-overlay').locator('.channelRow')
    await expect(picker.first()).toBeVisible()
    await expect(picker).toHaveCount(3)
    const biggest = channelsOf(parsed)[0]!
    await picker.first().click()
    await h.page.locator('oc-easy-mode-overlay').locator('.btn.primary', { hasText: '적용' }).click()

    await expect(rows).toHaveCount(biggest.count)
    // And the button says a filter is on, so a short screen is explained.
    await expect(ui.locator('.chanFilter .chanCount')).toHaveText('1')

    // Clearing puts the feed back.
    await ui.locator('.chanFilter').click()
    await h.page.locator('oc-easy-mode-overlay').locator('.btn.ghost', { hasText: '필터 해제' }).click()
    await expect(rows).toHaveCount(parsed.length)
    await expect(ui.locator('.chanFilter .chanCount')).toHaveCount(0)
  } finally {
    await h.close()
  }
})

test('the subscription channel picker can be searched', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await serveSubs(h.page)
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()
    await ui.locator('.chanFilter').click()

    const overlay = h.page.locator('oc-easy-mode-overlay')
    const list = channelsOf(parsed)
    await overlay.locator('.channelSearch input').fill(list[0]!.name)
    await expect(overlay.locator('.channelRow')).toHaveCount(1)
    await expect(overlay.locator('.channelRow .channelName')).toHaveText(list[0]!.name)

    await overlay.locator('.channelSearch input').fill('없는 채널 이름')
    await expect(overlay.locator('.channelRow')).toHaveCount(0)
    await expect(overlay.locator('.channelList')).toContainText('채널을 찾지 못했습니다.')
  } finally {
    await h.close()
  }
})

test('a video channel name opens that channel, and the player exposes share', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await serveSubs(h.page)
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()

    const first = parsed[0]!
    const channel = ui.locator('.channelLink', { hasText: first.byline }).first()
    await expect(channel).toBeVisible()
    await channel.click()
    await expect(ui.locator('.main h2')).toHaveText(first.byline)

    await ui.locator('.nav', { hasText: '구독' }).click()
    await ui.locator('.row:not([aria-hidden])').first().click()
    const share = ui.locator('.right .shr')
    await expect(share).toBeVisible()
    await expect(share).toBeEnabled()
  } finally {
    await h.close()
  }
})

test('the step buttons return from a channel and go forward again', async () => {
  // A jump into a channel used to be one-way for a pointer: the trail existed
  // for the phone's edge swipe and nothing else (2026-09-16, "갔다가 되돌아올
  // 방법이없어 앞뒤로 이동할 수단이 필요하지않냐"). The sidebar carries the
  // pair now, and the keyboard has the browser's own keys for them.
  const h = await open('https://www.youtube.com/')
  try {
    await serveSubs(h.page)
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()

    const first = parsed[0]!
    const leaving = await ui.locator('.main h2').textContent()
    await ui.locator('.channelLink', { hasText: first.byline }).first().click()
    await expect(ui.locator('.main h2')).toHaveText(first.byline)

    const back = ui.locator('.sideHead .step.back')
    const forward = ui.locator('.sideHead .step.forward')
    await expect(back).toBeEnabled()
    await back.click()
    await expect(ui.locator('.main h2')).toHaveText(leaving ?? '')
    await expect(forward).toBeEnabled()
    await forward.click()
    await expect(ui.locator('.main h2')).toHaveText(first.byline)

    // The browser's own keys, both directions.
    await h.page.keyboard.press('Alt+ArrowLeft')
    await expect(ui.locator('.main h2')).toHaveText(leaving ?? '')
    await h.page.keyboard.press('Alt+ArrowRight')
    await expect(ui.locator('.main h2')).toHaveText(first.byline)

    // A fresh destination ends the forward road.
    await ui.locator('.nav', { hasText: '구독' }).click()
    await expect(forward).toBeDisabled()
  } finally {
    await h.close()
  }
})

test('nothing reaches the player while the checklist is open', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await serveSubs(h.page)
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()
    await expect(ui.locator('.row:not([aria-hidden])').first()).toBeVisible()

    await ui.locator('.chanFilter').click()
    await expect(h.page.locator('oc-easy-mode-overlay').locator('.channelRow').first()).toBeVisible()
    // s and r drive shuffle and repeat when nothing is open. With a dialog up
    // they belong to the dialog, and the settings behind it must not move.
    const before = await h.page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('oc-easy-mode:state') ?? '{}')
      return { shuffle: !!s.shuffle, repeat: s.repeat ?? 'off' }
    })
    await h.page.keyboard.press('s')
    await h.page.keyboard.press('r')
    await h.page.waitForTimeout(300)
    const after = await h.page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('oc-easy-mode:state') ?? '{}')
      return { shuffle: !!s.shuffle, repeat: s.repeat ?? 'off' }
    })
    expect(after).toEqual(before)
  } finally {
    await h.close()
  }
})

test('Escape closes the checklist and leaves the filter as it was', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await serveSubs(h.page)
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()

    const rows = ui.locator('.row:not([aria-hidden])')
    const overlay = h.page.locator('oc-easy-mode-overlay')
    await expect(rows).toHaveCount(parsed.length)

    // Ticking and then escaping is a change nobody asked to keep: the dialog
    // resolves with null, not with what was on screen when it closed.
    await ui.locator('.chanFilter').click()
    await expect(overlay.locator('.channelRow').first()).toBeVisible()
    await overlay.locator('.channelRow').first().click()
    await h.page.keyboard.press('Escape')
    await expect(overlay.locator('.channelRow')).toHaveCount(0)
    await expect(rows).toHaveCount(parsed.length)
    await expect(ui.locator('.chanFilter .chanCount')).toHaveCount(0)

    // And the Escape stops there. The shell takes two of them to leave, so a
    // single one that travelled on would arm that, and the next Escape would
    // take the whole mode down with it.
    await h.page.keyboard.press('Escape')
    await expect(ui.locator('.app')).toBeVisible()
    await expect(h.page.locator('oc-easy-mode')).toHaveCount(1)
  } finally {
    await h.close()
  }
})

test('a menu over the screen closes alone', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await serveSubs(h.page)
    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible()
    await ui.locator('.nav', { hasText: '구독' }).click()
    const overlay = h.page.locator('oc-easy-mode-overlay')
    await expect(ui.locator('.row:not([aria-hidden])').first()).toBeVisible()

    // A row's menu is a second layer over the screen. Escaping it must not
    // also take the layer underneath, which is the rule the checklist follows
    // by only closing when it is the last one in the overlay.
    // The menu by name: the row's last tagged button is the quick action now
    // that the menu has its own column before the swipe strip.
    await ui.locator('.row:not([aria-hidden])').first().locator('.more').click()
    await expect(overlay.locator('.menu')).toBeVisible()
    await h.page.keyboard.press('Escape')
    await expect(overlay.locator('.menu')).toHaveCount(0)
    await expect(ui.locator('.app')).toBeVisible()
  } finally {
    await h.close()
  }
})
