// Serves the laboratory in place of youtube.com.
//
// A real origin, so `localStorage` and `sessionStorage` are real; a real
// address, so a rescue that navigates lands somewhere and is caught here and
// answered with the same page again. Nothing leaves the machine: every request
// to the origin is fulfilled from `dist-lab`.

import { expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BUNDLE = resolve(import.meta.dirname, '../../dist-lab/lab.js')

export type Fault =
  | 'healthy'
  | 'dormant'
  | 'loaded-paused'
  | 'play-rejects'
  | 'stuck-unstarted'
  | 'ad-phantom'
  | 'ad-real'
  | 'error'
  | 'throws'
  | 'slow'
  | 'stall'
  | 'swap'
  | 'no-player'

export interface LabConfig {
  fault?: Fault
  watch?: Fault
  reload?: Fault
  dead?: string[]
}

export interface LabView {
  path: string
  videoId: string | undefined
  sounding: boolean
  currentTime: number
  playingTitle: string
  index: number
  queue: Array<{ id: string; unavailable: boolean }>
  trouble: string | undefined
  visit: number
  fault: Fault
}

const HTML = `<!doctype html><meta charset="utf-8"><title>lab</title>
<style>body{font:14px system-ui;margin:0}#stage{width:640px;height:360px;background:#111}</style>
<div id="stage"></div>
<script src="/__lab.js"></script>`

/**
 * Opens the laboratory with `config` in force.
 *
 * Every page the run reaches afterwards — a rescue's watch page, a reload — is
 * served the same way and reads the same configuration out of the tab, so the
 * whole recovery happens for real rather than being asserted a step at a time.
 */
export async function lab(page: Page, config: LabConfig = {}, path = '/'): Promise<void> {
  await page.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/__lab.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: readFileSync(BUNDLE, 'utf8') })
    }
    if (route.request().resourceType() !== 'document') {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: '' })
    }
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML })
  })
  const sep = path.includes('?') ? '&' : '?'
  await page.goto(`https://www.youtube.com${path}${sep}lab=${encodeURIComponent(JSON.stringify(config))}`)
  await page.waitForFunction(() => (window as unknown as { LAB?: unknown }).LAB !== undefined)
}

/** A queue of `n` tracks, named so a test can say which one it means. */
export function tracks(n: number): Array<{ videoId: string; title: string; byline: string; duration: string; unavailable: boolean }> {
  return Array.from({ length: n }, (_, i) => ({
    videoId: `v${i + 1}`,
    title: `track ${i + 1}`,
    byline: 'lab',
    duration: '0:30',
    unavailable: false,
  }))
}

/** Presses the queue's first track, the way a list does. */
export async function playQueue(page: Page, n = 2): Promise<void> {
  await ask(page, (list) => (window as unknown as { LAB: { play(t: unknown[]): void } }).LAB.play(list), tracks(n))
}

/**
 * Reads the laboratory, through a navigation if one is happening.
 *
 * The whole point of these runs is that the product may move the page under
 * them, so an execution context destroyed mid-question is an expected answer
 * and not a failure. Waits for the page that arrives and asks it again.
 */
async function ask<T, A>(page: Page, fn: (arg: A) => T, arg?: A): Promise<T> {
  let last: unknown
  for (let go = 0; go < 8; go++) {
    try {
      await page.waitForFunction(() => (window as unknown as { LAB?: unknown }).LAB !== undefined, { timeout: 20_000 })
      return await page.evaluate(fn, arg as A)
    } catch (e) {
      last = e
      if (!/destroyed|navigat|Target closed/i.test((e as Error).message)) throw e
      await page.waitForTimeout(250)
    }
  }
  throw last
}

export async function view(page: Page): Promise<LabView> {
  return ask(page, () => (window as unknown as { LAB: { view(): LabView } }).LAB.view())
}

/**
 * Waits for sound, whatever it takes to get there.
 *
 * The one assertion the whole suite is built around: not that a particular
 * rung was taken, but that within a human's patience something is playing.
 */
export async function expectSound(page: Page, within = 20_000): Promise<void> {
  await expect
    .poll(async () => ask(page, () => (window as unknown as { LAB: { moving(): Promise<boolean> } }).LAB.moving()), {
      timeout: within,
      message: 'the clock never moved',
    })
    .toBe(true)
}

export async function labLog(page: Page): Promise<Array<{ what: string; detail?: string; where: string }>> {
  return ask(page, () =>
    (window as unknown as { LAB: { log(): Array<{ what: string; detail?: string; where: string }> } }).LAB.log(),
  )
}
