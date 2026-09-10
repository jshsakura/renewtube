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

export function keepAwake(onBackground: () => void = () => {}, source: Document = document, host: Window = window): () => void {
  const doc = source as Document & Record<string, unknown>
  // Keep one honest getter before the own-property lie shadows it. Return
  // visibility events must not restart a pause made from the lock screen.
  let realHidden: (() => boolean) | undefined
  for (let proto = Object.getPrototypeOf(source); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'hidden')
    if (descriptor?.get) {
      realHidden = () => descriptor.get!.call(source) === true
      break
    }
  }
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

  // WebKit commonly sends visibilitychange, webkitvisibilitychange, freeze
  // and pagehide for one trip out. They are four descriptions of one hand-off,
  // not four permissions to restart media. Reset only after the honest getter
  // says the page came back (or pageshow announces it), so the recovery window
  // cannot be extended by a late duplicate lifecycle event.
  let backgrounded = false
  const returned = (): void => {
    backgrounded = false
  }

  // Visibility events are targeted at document. Catch them at window as an
  // ancestor, before *every* document listener regardless of which script was
  // installed first; the document listener is the fallback for WebKit builds
  // that do not put window in that event's path. Blur/pagehide/freeze are the
  // other three signals the mobile player uses to put itself down. Suppressing
  // an event does not keep a genuinely unloaded page alive — it only prevents
  // YouTube from pausing the media while the browser hands it to background
  // audio.
  const swallow = (e: Event): void => {
    e.stopImmediatePropagation()
    // iOS has already paused the video by the time the departure signal is
    // delivered (measured again on Orion, 2026-09-10: sound stopped outside,
    // then the same 649s video resumed on return). The visibility lie prevents
    // YouTube tearing the player down; this nudge is the other half, handing
    // that still-loaded element back to Orion's enabled background playback.
    const departing = e.type === 'pagehide' || e.type === 'freeze' || realHidden?.() === true
    if (!departing) {
      returned()
      return
    }
    if (backgrounded) return
    backgrounded = true
    onBackground()
  }
  const documentEvents = ['visibilitychange', 'webkitvisibilitychange', 'freeze'] as const
  // blur is deliberately absent: touching the address bar and opening a popup
  // blur the window too, and neither means the page is going to background.
  const windowEvents = ['visibilitychange', 'webkitvisibilitychange', 'freeze', 'pagehide'] as const
  const capture = { capture: true }
  for (const ev of documentEvents) source.addEventListener(ev, swallow, capture)
  for (const ev of windowEvents) host.addEventListener(ev, swallow, capture)
  host.addEventListener('pageshow', returned, capture)

  return () => {
    for (const ev of documentEvents) source.removeEventListener(ev, swallow, capture)
    for (const ev of windowEvents) host.removeEventListener(ev, swallow, capture)
    host.removeEventListener('pageshow', returned, capture)
    for (const key of removed) {
      try {
        delete doc[key]
      } catch {
        /* leave it; the getter is harmless */
      }
    }
  }
}
