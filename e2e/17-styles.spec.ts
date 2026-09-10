// Rules the stylesheet has to keep, checked against the stylesheet itself.
//
// No browser: these are properties of the CSS text, and a browser could only
// tell us that the animation ran on the one machine running the test — which is
// exactly the machine where it always runs. The failures worth guarding here
// are the ones that happen where an animation does *not* run.

import { expect, test } from '@playwright/test'
import { STYLES } from '../src/main/ui/styles.ts'

type CssRule = { selector: string; declarations: Array<{ property: string; value: string }> }

function cssRules(css: string): CssRule[] {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => {
    const declarations = match[2]!
      .split(';')
      .map((text) => /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(text))
      .filter((decl): decl is RegExpExecArray => decl !== null)
      .map((decl) => ({ property: decl[1]!, value: decl[2]! }))
    return match[1]!
      .split(',')
      .map((selector) => selector.trim())
      .filter((selector) => selector !== '' && !selector.startsWith('@'))
      .map((selector) => ({ selector, declarations }))
  })
}

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

test('only a transient menu may blur what is behind it', () => {
  // One small, short-lived exception. The phone menu was transparent without
  // doing anything to what showed through it, so the transport and seek line
  // cut straight through every label (measured 2026-09-10: "투명하게 블러라도
  // 넣던가"). It is not an app surface and disappears after one selection.
  //
  // A backdrop-filter makes its element a compositing layer whose backdrop is
  // re-rendered as things move behind it, and on iOS WebKit that layer can come
  // back with nothing painted in it while every element inside still takes a
  // press. This product moves YouTube's player in and out of a stage, which is
  // that change over and over. The owner's screen: the header perfect and the
  // pane black, the drawer painted for 250 pixels and black below, buttons
  // still working when pressed blind ("안 보이지만 눌린다", 2026-09-07).
  //
  // And it showed nothing. Every surface here stands on our own flat ground, so
  // each blur was one colour seen through the same colour. The first fix took
  // it off the two scrolling panes and left it on the drawer, which is the
  // phone's own rule and the one in the photograph — so now there are no
  // surface exceptions to keep track of. The transient menu above is the
  // complete whitelist and this test names both of its declarations.
  const code = STYLES.replace(/\/\*[\s\S]*?\*\//g, '')
  const backdrop = cssRules(STYLES).flatMap(({ selector, declarations }) =>
    declarations
      .filter(({ property }) => property === 'backdrop-filter' || property === '-webkit-backdrop-filter')
      .map(({ property, value }) => ({ selector, property, value })),
  )
  expect(backdrop).toEqual([
    { selector: '.menu', property: '-webkit-backdrop-filter', value: 'blur(18px) saturate(140%)' },
    { selector: '.menu', property: 'backdrop-filter', value: 'blur(18px) saturate(140%)' },
  ])
  expect(code, 'and no blur is left to ask for').not.toMatch(/--(pane|pop)-blur:\s*(?!none)\S/)
  // The shell's own surfaces are opaque as well: a colour against the same
  // colour is not translucency, it is a layer for nothing.
  for (const decl of [...code.matchAll(/--(?:pane|pop-solid):\s*([^;]+);/g)]) {
    expect(decl[1], 'a full-screen surface is opaque').not.toMatch(/rgba|hsla/)
  }

  // Search, settings and confirmations are reading surfaces, not little
  // palettes. They must use the opaque token even though they share this
  // shadow root with the deliberately blurred menu.
  for (const selector of ['.modal', '.toast']) {
    const rule = cssRules(STYLES).find((candidate) => candidate.selector === selector)
    expect(rule?.declarations).toContainEqual({ property: 'background', value: 'var(--pop-solid)' })
  }
})

test('dialog hierarchy comes from surfaces and space, never divider lines', () => {
  // Reported 2026-09-10: the detail player's little menu and the larger
  // dialogs had a rule under their heading but still did not read as a head
  // and a body. A distinct inset surface is the hierarchy; a separator line
  // is not a substitute for it.
  for (const selector of ['.menuHead', '.modalHead', '.searchHead']) {
    const rule = cssRules(STYLES).find((candidate) => candidate.selector === selector)
    expect(rule, `${selector} exists`).toBeDefined()
    expect(rule?.declarations).toContainEqual({ property: 'background', value: 'var(--secondary)' })
    expect(rule?.declarations.some(({ property }) => property.startsWith('border-') && property.endsWith('bottom'))).toBe(false)
  }

  const divider = cssRules(STYLES).find((candidate) => candidate.selector === '.menu hr')
  expect(divider?.declarations).toContainEqual({ property: 'border', value: '0' })
  expect(divider?.declarations).toContainEqual({ property: 'height', value: '6px' })

  const suggestions = cssRules(STYLES).find((candidate) => candidate.selector === '.searchSuggest')
  expect(suggestions?.declarations).toContainEqual({ property: 'background', value: 'var(--secondary)' })
  expect(suggestions?.declarations.some(({ property }) => property === 'border-bottom')).toBe(false)
})

test('app-level surfaces never ask the compositor for a layer', () => {
  // A player is either above these surfaces or parked off-screen. Giving one
  // of the surfaces its own transform, filter or will-change creates a third
  // compositing state between those two, and that is the state iOS WebKit did
  // not paint: 2026-09-07, "사이드바 아래쪽이 가려 영상만큼만 보이고";
  // 2026-09-08, "안보이지만 버튼은 눌린다".
  const forbidden = new Set([
    'will-change',
    'filter',
    '-webkit-filter',
    'transform',
    '-webkit-transform',
    'backdrop-filter',
    '-webkit-backdrop-filter',
  ])
  const isSurface = (selector: string) => {
    const subject = selector.split(/[\s>+~]+/).at(-1) ?? ''
    const classes = [...subject.matchAll(/\.([\w-]+)/g)].map((match) => match[1])
    return classes.some((name) => ['app', 'side', 'main', 'slot', 'upnext', 'drawerScrim', 'scrim', 'modal'].includes(name!))
      || (classes.includes('bar') && selector.includes('.sheet-open'))
  }
  const bad = cssRules(STYLES).flatMap(({ selector, declarations }) =>
    isSurface(selector)
      ? declarations.filter(({ property }) => forbidden.has(property)).map(({ property, value }) => `${selector} { ${property}: ${value} }`)
      : [],
  )
  expect(bad, 'full-screen and pane surfaces stay in the app\'s one paint layer').toEqual([])

  // Momentum scrolling is the one shadow-stylesheet exception, on the small
  // horizontal row that needs it. The other deliberate exceptions live in a
  // different, page-level sheet: shell.ts HIDE_CSS gives #movie_player its
  // scroll transform and will-change only while the picture has a seat.
  const momentumWhitelist = new Map([['.shelfRow', 'touch']])
  const momentum = cssRules(STYLES).flatMap(({ selector, declarations }) =>
    declarations
      .filter(({ property }) => property === '-webkit-overflow-scrolling')
      .map(({ value }) => ({ selector, value })),
  )
  expect(momentum).toEqual([...momentumWhitelist].map(([selector, value]) => ({ selector, value })))
})

test('the opened phone player keeps the ordinary stage size', () => {
  // The detail sheet used to inset the same video by its 20px page padding,
  // turning the ordinary 393x221 phone stage into a separate 353x199 card.
  // Moving the slot is enough; opening details must not resize it.
  const rule = cssRules(STYLES).find(({ selector }) => selector === '.app.narrow.sheet-open.slot-in-sheet .slot.stage')
  expect(rule, 'the slot-in-sheet rule exists').toBeDefined()
  const declarations = Object.fromEntries(rule!.declarations.map(({ property, value }) => [property, value]))
  expect(declarations.width).toBe('100dvw')
  expect(declarations.height).toBe('var(--stage-h)')
  expect(declarations.background).toBe('transparent')
  expect(declarations['border-radius']).toBe('0')
  expect(declarations['box-shadow']).toBe('none')
})

test('a video seated in the phone player cannot leave its poster behind it', () => {
  // The slot-in-sheet flag is the placement fact; has-stage is a second class
  // updated on a different line. Measured 2026-09-10: the square cover flashed
  // behind the live video. The cover is gone for the whole seated interval.
  const rule = cssRules(STYLES).find(({ selector }) => selector === '.app.narrow.sheet-open.slot-in-sheet .bar .now .thumb')
  expect(rule?.declarations).toContainEqual({ property: 'display', value: 'none' })
})
