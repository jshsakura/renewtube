// Arrow keys, the way a television works.
//
// Every focusable thing carries `data-nav`, and a press moves to whichever one
// lies furthest in the pressed direction and least to the side of it. One
// geometric rule covers shelves, grids, lists and the sidebar, which is why
// there is no per-screen navigation code anywhere else: a new screen is
// reachable the moment its elements carry the attribute.
//
// Focus is real DOM focus rather than a highlight of our own. The browser then
// handles scrolling into view, screen readers, and the fact that a tab press
// should do something sensible.

const KEYS: Record<string, Dir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
}

type Dir = 'left' | 'right' | 'up' | 'down'

interface Box {
  el: HTMLElement
  x: number
  y: number
  left: number
  right: number
  top: number
  bottom: number
}

function boxes(root: ParentNode): Box[] {
  const out: Box[] = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-nav]')) {
    const r = el.getBoundingClientRect()
    // Zero-sized means scrolled out of a collapsed row or not laid out yet.
    if (r.width < 2 || r.height < 2) continue
    out.push({
      el,
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
    })
  }
  return out
}

/**
 * The next thing in that direction.
 *
 * Distance along the press counts once and distance across it counts three
 * times, so a press goes to the neighbour rather than to whatever happens to
 * be nearest as the crow flies. Anything not strictly ahead is out.
 */
function nextIn(dir: Dir, from: Box, all: Box[]): HTMLElement | null {
  let best: Box | null = null
  let bestCost = Infinity
  for (const b of all) {
    if (b.el === from.el) continue
    let ahead: number
    let aside: number
    if (dir === 'left') {
      ahead = from.left - b.right
      aside = Math.abs(b.y - from.y)
    } else if (dir === 'right') {
      ahead = b.left - from.right
      aside = Math.abs(b.y - from.y)
    } else if (dir === 'up') {
      ahead = from.top - b.bottom
      aside = Math.abs(b.x - from.x)
    } else {
      ahead = b.top - from.bottom
      aside = Math.abs(b.x - from.x)
    }
    // A neighbour may overlap slightly; it may not be behind.
    if (ahead < -2) continue
    const cost = Math.max(ahead, 0) + aside * 3
    if (cost < bestCost) {
      bestCost = cost
      best = b
    }
  }
  return best?.el ?? null
}

/** Whether a key press belongs to the thing being typed into. */
function isTyping(el: Element | null): boolean {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

/**
 * Turns the arrow keys and Enter into a remote control. Returns the removal.
 *
 * Bound to the document rather than to our shadow root, because focus is not
 * always inside it: a screen that has just re-rendered has thrown its focused
 * element away, and focus falls back to the body. An event that starts there
 * never enters a shadow tree, so a root-bound listener would go quiet exactly
 * when someone reaches for the arrow keys. From the document, the first press
 * picks the nearest thing up instead.
 *
 * The capture phase, so it beats YouTube's own shortcuts — the page is hidden
 * but its keyboard handlers are not, and an arrow key reaching the player
 * would seek the video.
 *
 * While a menu or a dialog is open the arrows belong to it, not to us.
 */
export function installRemote(root: ShadowRoot, overlay: ShadowRoot): () => void {
  const onKey = (ev: KeyboardEvent) => {
    // A modified key is not a remote press. Alt and the arrows are the
    // browser's own history steps — taken further down the same document, in
    // the shortcuts — and a Ctrl or Cmd combination belongs to whoever asked
    // for it, never to a focus walk.
    if (ev.altKey || ev.ctrlKey || ev.metaKey) return
    // The topmost floating thing, if any, keeps the arrows to itself unless it
    // says otherwise. A menu and a dialog drive themselves; a panel that is a
    // whole screen of things to reach (the search) carries data-remote, and
    // then the same rule that walks the app walks the panel, and only the
    // panel. Opting in by attribute, not by having tagged elements: every
    // dialog's close button is tagged, and a rule that read that as consent
    // sent the first arrow press in a dialog straight to its own X.
    const floating = Array.from(overlay.querySelectorAll<HTMLElement>('.menu, .scrim')).at(-1)
    if (floating && !floating.hasAttribute('data-remote')) return
    const scope: ParentNode = floating ?? root
    const active = (floating ? overlay : root).activeElement as HTMLElement | null

    if (ev.key === 'Enter' || ev.key === ' ') {
      if (isTyping(active) || !active?.hasAttribute('data-nav')) return
      ev.preventDefault()
      active.click()
      return
    }

    const dir = KEYS[ev.key]
    if (!dir) return

    // Left and right belong to the caret while typing; up and down are how you
    // get out of the search field and into the results.
    if (isTyping(active) && (dir === 'left' || dir === 'right')) return

    const all = boxes(scope)
    if (all.length === 0) return
    ev.preventDefault()

    const from = all.find((b) => b.el === active)
    const target = from ? nextIn(dir, from, all) : all[0]?.el
    if (!target) return
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  document.addEventListener('keydown', onKey as EventListener, true)
  return () => document.removeEventListener('keydown', onKey as EventListener, true)
}
