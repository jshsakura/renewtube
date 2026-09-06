// Dragging a shelf sideways with the mouse.
//
// A shelf scrolls sideways, and a finger already does that: touch scrolling is
// the platform's. A mouse has no such gesture. A wheel goes up and down, the
// scrollbar is hidden, and shift-wheel is a thing almost nobody knows, so on a
// desktop a row of cards was a row you could only reach the first five of
// (reported 2026-09-06, "카드 드래그해서 넘길수있게").
//
// **Attached to the row, not built into the card**, for the same reason
// sortable.ts listens on its list: the cards are made elsewhere and a redraw
// replaces them all. Mouse only, by pointer type: a finger keeps its native
// scroll, and a pen behaves like a finger.
//
// A press that travels is a drag; a press that does not is the click it
// always was. Once it has become a drag the click that the browser fires on
// release is swallowed, or letting go of a dragged row would also play
// whatever card the mouse happened to stop on.

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

  row.addEventListener('pointerdown', onDown)
  row.addEventListener('pointermove', onMove)
  row.addEventListener('pointerup', settle)
  row.addEventListener('pointercancel', settle)
  row.addEventListener('lostpointercapture', settle)
  return () => {
    row.removeEventListener('pointerdown', onDown)
    row.removeEventListener('pointermove', onMove)
    row.removeEventListener('pointerup', settle)
    row.removeEventListener('pointercancel', settle)
    row.removeEventListener('lostpointercapture', settle)
  }
}
