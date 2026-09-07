// Loads the built extension into a real Chromium and opens YouTube.
//
// Headed-in-headless via the new headless mode, because MV3 content scripts in
// the MAIN world are not delivered by the old one.

import { chromium, expect, type BrowserContext, type Page } from '@playwright/test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertFresh } from './fresh.ts'

// Normally the local build. `DIST_DIR` points it somewhere else — at a package
// unzipped from the live page, say, which is the only way to prove that what
// the download button hands out is what actually installs.
const DIST = process.env.DIST_DIR ?? resolve(import.meta.dirname, '../dist')

/**
 * A copy of the build with `world: "MAIN"` taken off the main script, which is
 * what Safari and Orion do to it. The file then loads into the isolated world,
 * where it must refuse to run and let the injection fallback carry it across.
 */
export function orionFlavour(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-easy-mode-orion-'))
  cpSync(DIST, dir, { recursive: true })
  const manifestPath = join(dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    content_scripts: Array<{ js: string[]; world?: string }>
  }
  for (const entry of manifest.content_scripts) {
    if (entry.js.includes('main.js')) delete entry.world
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  return dir
}

export interface Harness {
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

/** Opens `url` with the mode already switched on, unless `on` is false. */
export async function open(url: string, on = true): Promise<Harness> {
  // Not when DIST_DIR points somewhere else: that is a package downloaded from
  // the live page, and it is *meant* to be older than the working tree.
  if (process.env.DIST_DIR === undefined) {
    assertFresh(join(DIST, 'main.js'), [resolve(import.meta.dirname, '../src'), resolve(import.meta.dirname, '../public')], 'npm run build')
  }
  const profile = mkdtempSync(join(tmpdir(), 'oc-easy-mode-'))
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--lang=ko-KR'],
  })
  const page = context.pages()[0] ?? (await context.newPage())
  if (on) {
    await page.addInitScript(() => {
      try {
        // Only when nothing has been decided yet. Setting it on every
        // navigation would switch the mode back on immediately after a test
        // turned it off — and leaving can navigate, so the page that came back
        // would be hidden again and the test would be watching its own script.
        if (localStorage.getItem('oc-easy-mode:on') === null) {
          localStorage.setItem('oc-easy-mode:on', '1')
        }
        // Pin the language. The UI follows YouTube's own `hl`, which is not
        // ours to decide in a test browser — and a suite that asserts on
        // Korean labels fails on a machine where YouTube answers in English,
        // for a reason that has nothing to do with the product.
        if (localStorage.getItem('oc-easy-mode:state') === null) {
          localStorage.setItem('oc-easy-mode:state', JSON.stringify({ lang: 'ko' }))
        }
      } catch {
        /* first-run about:blank has no storage; the real page will */
      }
    })
  }
  // Live YouTube over a home line: generous, because a slow first byte is not
  // a failing product. And tried again, because one bad minute of somebody
  // else's network is not a failing product either — a run that goes red for
  // that teaches the reader to ignore red, which costs more than the minute.
  let last: unknown
  for (let go = 0; go < 3; go++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      last = undefined
      break
    } catch (e) {
      last = e
      await page.waitForTimeout(1500)
    }
  }
  if (last) throw last
  return {
    context,
    page,
    async close() {
      await context.close()
      rmSync(profile, { recursive: true, force: true })
    },
  }
}

/** The app's shadow root, as a locator that pierces it. */
export function app(page: Page) {
  return page.locator('oc-easy-mode')
}

/** The other root: menus, dialogs, toasts and the search panel live here. */
export function overlay(page: Page) {
  return page.locator('oc-easy-mode-overlay')
}

/**
 * Opens the search panel, asks it `query`, and waits for the first answer.
 * Returns the overlay root, which is where the panel and its rows are.
 */
export async function searchFor(page: Page, query: string) {
  await app(page).locator('.nav', { hasText: '검색' }).click()
  const over = overlay(page)
  const box = over.locator('.searchbox input')
  await box.fill(query)
  await box.press('Enter')
  await expect(over.locator('.row:not([aria-hidden])').first()).toBeVisible()
  return over
}
