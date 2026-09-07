// Rules the stylesheet has to keep, checked against the stylesheet itself.
//
// No browser: these are properties of the CSS text, and a browser could only
// tell us that the animation ran on the one machine running the test — which is
// exactly the machine where it always runs. The failures worth guarding here
// are the ones that happen where an animation does *not* run.

import { expect, test } from '@playwright/test'
import { STYLES } from '../src/main/ui/styles.ts'

test('a view animation can never leave the pane invisible', () => {
  // The black screen, as a rule rather than a screenshot.
  //
  // The pane's children fade in as they land. The first cut of that started at
  // opacity 0 and held its ends with a fill mode of `both` — and a fill mode
  // paints the first frame during the whole of the *before* phase, which for an
  // animation the device never gets round to running is for ever. The header
  // and the bar are outside the pane, so what that produces is the app's top
  // and bottom, perfect, over a black rectangle where the list should be.
  //
  // Measured in isolation, 2026-09-07: with `both` and a delay, the computed
  // opacity is 0; with neither, it is 1. So two things are required of the
  // rule, and both of them are about what happens when nothing animates:
  // no fill mode, so the resting state is the element's own; and a floor under
  // the opacity, so a first frame held on screen is dim rather than gone.
  const rule = /\.main > \*\s*\{\s*animation:\s*([A-Za-z][\w-]*)([^;}]*)[;}]/.exec(STYLES)
  expect(rule, 'the pane children still carry an entrance animation').not.toBeNull()
  const [, name, rest] = rule!
  expect(rest, 'a fill mode paints the first frame while the animation waits').not.toMatch(/\b(both|backwards|forwards)\b/)

  const frames = new RegExp(`@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n`).exec(STYLES)
  expect(frames, 'the keyframes are where the first frame is written').not.toBeNull()
  const from = /from\s*\{([^}]*)\}/.exec(frames![1]!)
  expect(from, 'there is a first frame').not.toBeNull()
  const opacity = /opacity:\s*([\d.]+)/.exec(from![1]!)
  // No opacity at all is fine: it cannot hide anything.
  if (opacity) {
    expect(Number(opacity[1]), 'the first frame has to be readable on its own').toBeGreaterThanOrEqual(0.3)
  }
})
