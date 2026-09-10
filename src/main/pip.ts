// Native Picture-in-Picture.
//
// Modern browsers, including current WebKit, expose the standard Document PiP
// API. Older iPhone WebKit has its video-presentation API instead, and some
// builds offer only the native fullscreen player whose own control hands the
// video to PiP. OC Ad Bye Pass deliberately removes its floating button while
// RenewTube owns the player, so this module has to cover all three routes.

interface WebkitVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
  webkitPresentationMode?: string
  webkitEnterFullscreen?: () => void
}

function video(): WebkitVideo | null {
  return typeof document === 'undefined' ? null : document.querySelector<WebkitVideo>('video')
}

/**
 * The prefixed probe is also the only honest negative on recent iOS WebKit.
 * Some containers expose the standard API while refusing PiP for this video;
 * `webkitSupportsPresentationMode()` reports that refusal correctly.
 */
function webkitPip(el: WebkitVideo | null): boolean | undefined {
  if (!el || typeof el.webkitSetPresentationMode !== 'function') return undefined
  try {
    return el.webkitSupportsPresentationMode?.('picture-in-picture') !== false
  } catch {
    return false
  }
}

const ENTRY_CONFIRM_MS = 3000
let entering: Promise<boolean> | undefined

/** Whether this browser offers a direct Picture-in-Picture route. */
export function pipSupported(): boolean {
  if (typeof document === 'undefined') return false
  const prefixed = webkitPip(video())
  if (prefixed === false) return false
  const standard = 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled
  return standard || prefixed === true
}

/** Whether a Picture-in-Picture window is open right now. */
export function pipOpen(): boolean {
  if (typeof document === 'undefined') return false
  const standard = 'pictureInPictureElement' in document && document.pictureInPictureElement !== null
  return standard || video()?.webkitPresentationMode === 'picture-in-picture'
}

function allowPip(el: WebkitVideo): void {
  el.removeAttribute('disablePictureInPicture')
  el.disablePictureInPicture = false
}

/**
 * Opens the picture in its own floating window. Must be called from a gesture.
 *
 * There is deliberately no await before either WebKit call: iOS expires the
 * tap privilege as soon as control returns to the event loop. If that WebKit
 * only has fullscreen, the native player is still useful — its own PiP button
 * and the Home gesture are the system-supported hand-off.
 */
export function enterPip(onLeave: () => void, onTransitionPause?: () => void): Promise<boolean> {
  // A slow first request used to accept every following tap too. Each one left
  // another presentation listener behind, and when WebKit finally answered
  // they all tried to own the same window. One native transition at a time;
  // a rejected or silently ignored attempt clears itself for the next tap.
  if (entering) return entering
  const attempt = beginEnterPip(onLeave, onTransitionPause)
  const wrapped = attempt.finally(() => {
    if (entering === wrapped) entering = undefined
  })
  entering = wrapped
  return wrapped
}

async function beginEnterPip(onLeave: () => void, onTransitionPause?: () => void): Promise<boolean> {
  const el = video()
  if (!el) return false
  allowPip(el)

  // iPhone WebKit can announce the PiP presentation, show its loading UI and
  // only then pause the element. Once a track has been heard the engine must
  // treat an ordinary pause as the reader's, so this short entry handoff is
  // the only place that can distinguish WebKit's pause from a PiP control.
  // Measured 2026-09-10: the pause landed after the loading transition and the
  // system window stayed stopped. The first transition pause only is taken
  // back; a PiP pause button pressed afterwards remains somebody's command.
  let guarding = true
  let transitionPauseAvailable = true
  let guardTimer = 0
  const restore = () => {
    if (!guarding || !el.paused || el.ended) return
    onTransitionPause?.()
    void el.play().catch(() => {})
  }
  const onPause = () => {
    if (!transitionPauseAvailable) return
    transitionPauseAvailable = false
    el.removeEventListener('pause', onPause)
    restore()
  }
  const stopGuard = () => {
    if (!guarding) return
    guarding = false
    window.clearTimeout(guardTimer)
    el.removeEventListener('pause', onPause)
  }
  el.addEventListener('pause', onPause)
  guardTimer = window.setTimeout(stopGuard, ENTRY_CONFIRM_MS)

  // A paused element is refused by WebKit. This is still inside the button's
  // gesture, and the press explicitly asked to watch it.
  if (el.paused) restore()

  const prefixed = webkitPip(el)
  if (prefixed === false) {
    stopGuard()
    return false
  }

  // WebKit's own modern media controls prefer the standard API whenever it
  // exists. Its promise confirms that the multi-process transition actually
  // finished; the legacy setter returns void even when WebKit silently ignores
  // it. Using the same order keeps our button on the browser's maintained path.
  if (typeof el.requestPictureInPicture === 'function' && document.pictureInPictureEnabled) {
    const left = () => {
      stopGuard()
      onLeave()
    }
    el.addEventListener('leavepictureinpicture', left, { once: true })
    try {
      await el.requestPictureInPicture()
      if (document.pictureInPictureElement !== el) throw new Error('PiP request resolved without a window')
      restore()
      window.setTimeout(restore, 0)
      return true
    } catch {
      el.removeEventListener('leavepictureinpicture', left)
      stopGuard()
      return false
    }
  }

  if (prefixed === true && el.webkitSetPresentationMode) {
    // The legacy setter has no return value and is allowed to fail silently.
    // Resolve only after its property/event says a window really opened, and
    // remove the listener after a bounded miss so a failed first tap cannot
    // poison all later taps.
    return new Promise<boolean>((resolve) => {
      let opened = false
      let settled = false
      let confirmTimer = 0
      const settle = (value: boolean): void => {
        if (settled) return
        settled = true
        window.clearTimeout(confirmTimer)
        if (!value) {
          el.removeEventListener('webkitpresentationmodechanged', changed)
          stopGuard()
        }
        resolve(value)
      }
      const changed = (): void => {
        if (el.webkitPresentationMode === 'picture-in-picture') {
          opened = true
          restore()
          window.setTimeout(restore, 0)
          settle(true)
          return
        }
        if (!opened) {
          settle(false)
          return
        }
        stopGuard()
        el.removeEventListener('webkitpresentationmodechanged', changed)
        onLeave()
      }
      el.addEventListener('webkitpresentationmodechanged', changed)
      confirmTimer = window.setTimeout(() => {
        if (el.webkitPresentationMode === 'picture-in-picture') changed()
        else settle(false)
      }, ENTRY_CONFIRM_MS)
      try {
        el.webkitSetPresentationMode?.('picture-in-picture')
        // Some builds update the property synchronously without dispatching
        // the event until a later task.
        if (el.webkitPresentationMode === 'picture-in-picture') changed()
      } catch {
        settle(false)
      }
    })
  }

  if (typeof el.webkitEnterFullscreen === 'function') {
    try {
      el.webkitEnterFullscreen()
      restore()
      return true
    } catch {
      /* unsupported for this media */
    }
  }
  stopGuard()
  return false
}

/** Closes the window if it is open, preserving sound through WebKit's handoff. */
export async function exitPip(onTransitionPause?: () => void): Promise<void> {
  const el = video()
  // iPhone WebKit may pause the media element while changing its presentation
  // back to inline. Closing a window is not a pause command: remember whether
  // it was sounding before the change and restore only that case. Measured
  // 2026-09-10: pressing the PiP button a second time returned the video
  // "중지된채로 백그라운드에".
  const keepPlaying = !!el && !el.paused && !el.ended
  const restore = () => {
    if (!keepPlaying || !el || !el.paused || el.ended) return
    // The engine calls both YouTube's player API and the element. Give it the
    // paused state, before the direct play call can optimistically clear it;
    // if WebKit rejects one route, the other still owns the recovery.
    onTransitionPause?.()
    void el.play().catch(() => {})
  }
  // On the device the pause can arrive after the presentation-change event
  // and after exitPip has returned, especially while RenewTube's video is
  // parked for 소리만. Keep a narrow guard over that handoff instead of
  // treating every later pause as PiP's. Consume at most one pause: even
  // inside this transition, the next one can already be the reader's.
  let guardTimer = 0
  const stopGuard = () => {
    if (!el) return
    window.clearTimeout(guardTimer)
    el.removeEventListener('pause', onPause)
  }
  const onPause = () => {
    stopGuard()
    restore()
  }
  if (keepPlaying && el) {
    el.addEventListener('pause', onPause)
    guardTimer = window.setTimeout(stopGuard, ENTRY_CONFIRM_MS)
  }
  if (el?.webkitPresentationMode === 'picture-in-picture' && el.webkitSetPresentationMode) {
    el.addEventListener('webkitpresentationmodechanged', restore, { once: true })
    try {
      el.webkitSetPresentationMode('inline')
      // Some WebKit builds dispatch the presentation event before applying
      // their pause. The immediate call keeps the gesture; the next task sees
      // the final state and catches that ordering too.
      restore()
      window.setTimeout(restore, 0)
      return
    } catch {
      el.removeEventListener('webkitpresentationmodechanged', restore)
      stopGuard()
      /* already gone */
    }
  }
  if (typeof document !== 'undefined' && document.pictureInPictureElement) {
    try {
      await document.exitPictureInPicture()
      restore()
    } catch {
      stopGuard()
      /* already gone */
    }
  }
}
