// The background-audio contract, exercised without a particular browser.
//
// iOS WebKit is the only place the symptom was visible, but the failure was
// ordering: YouTube heard a lifecycle event before RenewTube did. These tests
// make the event boundary and the startup order explicit so a local Chromium
// run can still reject that regression.

import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { keepAwake } from '../src/main/awake.ts'

class HiddenDocument extends EventTarget {
  get hidden(): boolean { return true }
  get visibilityState(): string { return 'hidden' }
  get webkitHidden(): boolean { return true }
  get webkitVisibilityState(): string { return 'hidden' }
  hasFocus(): boolean { return false }
}

test('background lifecycle cannot pause YouTube while RenewTube is running', () => {
  const doc = new HiddenDocument()
  const win = new EventTarget()
  let nudges = 0
  const restore = keepAwake(() => { nudges++ }, doc as unknown as Document, win as unknown as Window)
  const heard: string[] = []

  for (const name of ['visibilitychange', 'webkitvisibilitychange', 'freeze']) {
    doc.addEventListener(name, () => heard.push(`document:${name}`))
  }
  for (const name of ['visibilitychange', 'webkitvisibilitychange', 'freeze', 'pagehide']) {
    win.addEventListener(name, () => heard.push(`window:${name}`))
  }

  expect((doc as unknown as Document).hidden).toBe(false)
  expect((doc as unknown as Document).visibilityState).toBe('visible')
  expect((doc as unknown as Document).hasFocus()).toBe(true)
  for (const name of ['visibilitychange', 'webkitvisibilitychange', 'freeze']) doc.dispatchEvent(new Event(name))
  for (const name of ['visibilitychange', 'webkitvisibilitychange', 'freeze', 'pagehide']) win.dispatchEvent(new Event(name))
  expect(heard).toEqual([])
  expect(nudges).toBeGreaterThan(0)

  restore()
  expect((doc as unknown as Document).hidden).toBe(true)
  expect((doc as unknown as Document).hasFocus()).toBe(false)
  doc.dispatchEvent(new Event('visibilitychange'))
  win.dispatchEvent(new Event('pagehide'))
  expect(heard).toEqual(['document:visibilitychange', 'window:pagehide'])
})

test('the background guard is installed before startup yields', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../src/main/index.ts'), 'utf8')
  const start = source.indexOf('async function start()')
  const guard = source.indexOf('wake = keepAwake(', start)
  const firstYield = source.indexOf('await waitForYtCfg()', start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(guard).toBeGreaterThan(start)
  expect(guard).toBeLessThan(firstYield)
})
