// The app inside real WebKit.
//
// Playwright's WebKit cannot load an extension, and Chromium with an iPhone
// user agent is not an iPhone: the media rules are WebKit's (a page load
// cannot start a video, only a press can), and that is exactly the kind of
// thing this product gets wrong on the device and right in the suite.
//
// So the built main.js goes into the document itself. Not with addInitScript
// or addScriptTag: youtube.com enforces Trusted Types and a nonce, and both of
// those doors are shut. The document is fetched, a <script src> carrying the
// page's own nonce is put at the head, and the script is served from the
// page's origin with an explicit UTF-8 charset (without it WebKit read the
// bundle as Windows-1252 and choked on the first Korean object key). That is
// the same position a content script at document_start takes, and main.js
// finds no chrome.runtime and so behaves as it does in the page world.
//
// What it is not: the isolated-world bridge is absent, so the toolbar switch
// and chrome.storage are not here; the on flag is set in localStorage, which
// is what the page reads anyway.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'

const MAIN = readFileSync(resolve(import.meta.dirname, '../../dist/main.js'), 'utf8')

export async function inject(context: BrowserContext, page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (localStorage.getItem('oc-easy-mode:on') === null) localStorage.setItem('oc-easy-mode:on', '1')
      if (localStorage.getItem('oc-easy-mode:state') === null) localStorage.setItem('oc-easy-mode:state', JSON.stringify({ lang: 'ko' }))
    } catch {}
  })
  await context.route(
    (url) => /youtube\.com$/.test(url.hostname) && !/\.(js|css|png|jpg|webp|svg|json|woff2?)(\?|$)/.test(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue()
      const res = await route.fetch()
      const html = await res.text()
      const nonce = /<script[^>]*\bnonce="([^"]+)"/.exec(html)?.[1]
      const tag = `<script${nonce ? ` nonce="${nonce}"` : ''} src="/__renewtube.js"></script>`
      await route.fulfill({ response: res, body: html.replace(/<head[^>]*>/i, (m) => m + tag), headers: { ...res.headers(), 'content-type': 'text/html; charset=utf-8' } })
    },
  )
  // Registered last, so it is matched first.
  await context.route('**/__renewtube.js', (route) =>
    route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }, body: Buffer.from('\uFEFF' + MAIN, 'utf8') }),
  )
}

/** The app's shadow root, as a locator that pierces it. */
export function app(page: Page) {
  return page.locator('oc-easy-mode')
}

export function overlay(page: Page) {
  return page.locator('oc-easy-mode-overlay')
}
