import { expect, test } from '@playwright/test'
import { app, open } from './fixture.ts'

test('music opens with recently played recommendations and plays them in place', async () => {
  const h = await open('https://www.youtube.com/')
  try {
    await h.page.evaluate(() => {
      localStorage.setItem('oc-easy-mode:history', JSON.stringify([
        {
          videoId: 'BzYnNdJhZQw',
          title: '첫 번째 다시 듣기',
          byline: 'RenewTube 테스트',
          duration: '3:21',
          unavailable: false,
        },
        {
          videoId: 'jfKfPfyJRdk',
          title: '두 번째 다시 듣기',
          byline: 'RenewTube 테스트',
          duration: '4:56',
          unavailable: false,
        },
      ]))
    })
    await h.page.addInitScript(() => {
      try {
        localStorage.setItem('oc-easy-mode:on', '1')
      } catch {
        return
      }
    })
    await h.page.reload({ waitUntil: 'domcontentloaded' })

    const ui = app(h.page)
    await expect(ui.locator('.app')).toBeVisible({ timeout: 60_000 })
    const firstShelf = ui.locator('.shelf').first()
    await expect(firstShelf.locator('h3')).toHaveText('다시 듣기')
    await expect(firstShelf.locator('.tile .t')).toHaveText([
      '첫 번째 다시 듣기',
      '두 번째 다시 듣기',
    ])

    await firstShelf.locator('.tile').nth(1).click()
    await expect(ui.locator('.bar .now .t')).toHaveText('두 번째 다시 듣기')
    expect(new URL(h.page.url()).pathname).toBe('/')
  } finally {
    await h.close()
  }
})
