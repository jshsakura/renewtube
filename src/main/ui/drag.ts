// Reaching the rest of a shelf with a mouse.
//
// A shelf scrolls sideways, and a finger already does that: touch scrolling is
// the platform's. A mouse had nothing. The scrollbar is hidden, shift-wheel is
// a thing almost nobody knows, and measured on a desktop 2026-09-06 a plain
// wheel over a shelf moved it by exactly zero — so a row of cards was a row
// you could only reach the first five of ("카드 드래그해서 넘길수있게",
// "PC 에서 마우스로 옆으로 못 넘긴다").
//
// Three ways in, because they answer different instincts:
//
//   drag    a press that travels. Discoverable only once you try it.
//   wheel   what most people reach for first, turned sideways.
//   arrows  the one that can be *seen*, which is why the other two were not
//           enough on their own.
//
// **Attached to the row, not built into the card**, for the same reason
// sortable.ts listens on its list: the cards are made elsewhere and a redraw
// replaces them all. Drag is mouse only, by pointer type: a finger keeps its
// native scroll, and a pen behaves like a finger.
//
// A press that travels is a drag; a press that does not is the click it
// always was. Once it has become a drag the click that the browser fires on
// release is swallowed, or letting go of a dragged row would also play
// whatever card the mouse happened to stop on.

import { h, icon } from './dom.ts'
import { t } from '../../shared/i18n.ts'

/** How far the mouse travels before a press becomes a drag. */
const SLOP_PX = 5

/** Starts listening. Returns the way to stop. */
export function makeDraggable(row: HTMLElement): () => void {
  let pressed = false
  let dragging = false
  let startX = 0
  let originLeft = 0
  let pointerId = -1
  // Snap and drag fight: the snap pulls the row back to a card edge on
  // every scrollLeft write. Off while the mouse is down, back on release, so
  // the row still settles on a card once it is let go.
  let snap = ''

  const onDown = (ev: PointerEvent) => {
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return
    // Nothing to drag when everything already fits.
    if (row.scrollWidth <= row.clientWidth + 1) return
    pressed = true
    dragging = false
    pointerId = ev.pointerId
    startX = ev.clientX
    originLeft = row.scrollLeft
  }

  const onMove = (ev: PointerEvent) => {
    if (!pressed || ev.pointerId !== pointerId) return
    const dx = ev.clientX - startX
    if (!dragging) {
      if (Math.abs(dx) < SLOP_PX) return
      dragging = true
      snap = row.style.scrollSnapType
      row.style.scrollSnapType = 'none'
      row.classList.add('dragging')
      try {
        row.setPointerCapture(pointerId)
      } catch {
        // Capture is a nicety: without it the drag ends at the row's edge.
      }
    }
    ev.preventDefault()
    row.scrollLeft = originLeft - dx
  }

  const settle = () => {
    if (!pressed) return
    pressed = false
    if (!dragging) return
    row.style.scrollSnapType = snap
    row.classList.remove('dragging')
    try {
      row.releasePointerCapture(pointerId)
    } catch {
      // Already released, or never captured.
    }
    // The click that follows a release belongs to this drag, not to the card
    // under the mouse. Capture phase, once, and only the very next click.
    const swallow = (click: Event) => {
      click.stopPropagation()
      click.preventDefault()
    }
    row.addEventListener('click', swallow, { capture: true, once: true })
    // If no click comes (released outside), the listener must not lie in
    // wait for a genuine one later.
    setTimeout(() => row.removeEventListener('click', swallow, { capture: true }), 0)
    dragging = false
  }

  /**
   * The wheel, turned sideways.
   *
   * **It is handed back at the ends, and that is the whole design.** A row
   * that swallowed the wheel whenever the pointer was over it would trap the
   * reader half way down a screen of shelves: the page would stop moving and
   * there would be no way to tell why. So the row takes the wheel only while
   * it still has somewhere to go in that direction, and the moment it runs out
   * the event goes to the page as if none of this existed.
   *
   * A sideways delta is left alone: a trackpad and a tilt wheel already send
   * one, and the platform's own handling of it is better than ours.
   */
  const onWheel = (ev: WheelEvent) => {
    if (row.scrollWidth <= row.clientWidth + 1) return
    if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) return
    const by = ev.deltaY
    const at = row.scrollLeft
    const max = row.scrollWidth - row.clientWidth
    if (by > 0 && at >= max - 1) return
    if (by < 0 && at <= 0) return
    ev.preventDefault()
    row.scrollLeft = at + by
  }

  row.addEventListener('pointerdown', onDown)
  row.addEventListener('pointermove', onMove)
  row.addEventListener('pointerup', settle)
  row.addEventListener('pointercancel', settle)
  row.addEventListener('lostpointercapture', settle)
  // Not passive: turning the wheel sideways means preventing the page's own
  // use of it, which a passive listener is not allowed to do.
  row.addEventListener('wheel', onWheel, { passive: false })
  return () => {
    row.removeEventListener('pointerdown', onDown)
    row.removeEventListener('pointermove', onMove)
    row.removeEventListener('pointerup', settle)
    row.removeEventListener('pointercancel', settle)
    row.removeEventListener('lostpointercapture', settle)
    row.removeEventListener('wheel', onWheel)
  }
}

/**
 * The two buttons that say a shelf has more in it.
 *
 * Drag and wheel both work and neither can be seen, which is what the report
 * was actually about: not that the cards were unreachable, but that nothing
 * on the screen said they were there. These are the affordance.
 *
 * Each one hides itself when there is nowhere to go that way, so a shelf that
 * fits shows none and a shelf at its end shows one. Hidden rather than
 * disabled: a dimmed button that never becomes usable is furniture.
 *
 * A page at a time, less a card, so the card at the edge stays on screen and
 * the eye has something to carry across. Touch is not offered these at all
 * (see the stylesheet): a finger has the whole row already.
 */
export function shelfArrows(row: HTMLElement): HTMLElement[] {
  const step = () => Math.max(160, row.clientWidth - 176)
  const make = (dir: -1 | 1) =>
    h(
      'button',
      {
        class: dir < 0 ? 'shelfArrow back' : 'shelfArrow on',
        'data-nav': '',
        tabindex: '-1',
        'aria-label': dir < 0 ? t('이전') : t('다음'),
        title: dir < 0 ? t('이전') : t('다음'),
        onclick: () => row.scrollBy({ left: dir * step(), behavior: 'smooth' }),
      },
      icon('caret', 18),
    )
  const back = make(-1)
  const on = make(1)
  const sync = () => {
    const max = row.scrollWidth - row.clientWidth
    back.hidden = row.scrollLeft <= 1
    on.hidden = max <= 1 || row.scrollLeft >= max - 1
  }
  sync()
  row.addEventListener('scroll', sync, { passive: true })
  // The row is filled after it is built — a shelf fetches the rest of itself —
  // so how far it reaches is not known yet at this point.
  try {
    new ResizeObserver(sync).observe(row)
  } catch {
    // No observer: the scroll listener still keeps them honest once moved.
  }
  return [back, on]
}
