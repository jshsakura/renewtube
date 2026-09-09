// Keep YouTube from pausing in the background.
//
// A backgrounded tab still plays audio in every browser this runs in — but
// YouTube's own player watches the Page Visibility API and pauses (and on some
// surfaces tears the player down) when it decides the page is hidden. So the
// sound stops the moment you switch tabs or turn the screen off, the very
// thing the browser would have carried on playing ("백그라운드에서 제대로
// 재생안되는 문제 … 브라우저는 지원하는대").
//
// The fix is to let the page go on reporting itself visible: the element keeps
// playing, the engine's tick keeps advancing the queue, and nothing here reads
// real visibility (the queue advances on the element's own `ended` event, not
// on a poll, so a throttled hidden-tab timer was never what moved it). Undone
// on the way out, so a page we no longer drive gets its own visibility back.

export function keepAwake(source: Document = document, host: Window = window): () => void {
  const doc = source as Document & Record<string, unknown>
  const removed: string[] = []
  const spoof = (key: string, value: unknown): void => {
    // These live on Document.prototype, so an own property shadows them and a
    // delete restores the real getter. A build that refuses the definition
    // still gets the event swallow below.
    if (Object.getOwnPropertyDescriptor(doc, key)) return
    try {
      Object.defineProperty(doc, key, { configurable: true, get: () => value })
      removed.push(key)
    } catch {
      /* non-configurable here */
    }
  }
  spoof('hidden', false)
  spoof('visibilityState', 'visible')
  spoof('webkitHidden', false)
  spoof('webkitVisibilityState', 'visible')
  spoof('hasFocus', () => true)

  // Visibility events are targeted at document. Catch them at window as an
  // ancestor, before *every* document listener regardless of which script was
  // installed first; the document listener is the fallback for WebKit builds
  // that do not put window in that event's path. Blur/pagehide/freeze are the
  // other three signals the mobile player uses to put itself down. Suppressing
  // an event does not keep a genuinely unloaded page alive — it only prevents
  // YouTube from pausing the media while the browser hands it to background
  // audio.
  const swallow = (e: Event): void => e.stopImmediatePropagation()
  const documentEvents = ['visibilitychange', 'webkitvisibilitychange', 'freeze'] as const
  const windowEvents = ['visibilitychange', 'webkitvisibilitychange', 'freeze', 'blur', 'pagehide'] as const
  const capture = { capture: true }
  for (const ev of documentEvents) source.addEventListener(ev, swallow, capture)
  for (const ev of windowEvents) host.addEventListener(ev, swallow, capture)

  return () => {
    for (const ev of documentEvents) source.removeEventListener(ev, swallow, capture)
    for (const ev of windowEvents) host.removeEventListener(ev, swallow, capture)
    for (const key of removed) {
      try {
        delete doc[key]
      } catch {
        /* leave it; the getter is harmless */
      }
    }
  }
}
