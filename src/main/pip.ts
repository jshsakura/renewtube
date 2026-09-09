// Native Picture-in-Picture.
//
// Chromium exposes the standard Document PiP API. iPhone WebKit exposes its
// older video presentation API instead, and some builds offer only the native
// fullscreen player whose own control hands the video to PiP. OC Ad Bye Pass
// deliberately removes its floating button while RenewTube owns the player,
// so this module has to cover all three routes itself.

interface WebkitVideo extends HTMLVideoElement {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
  webkitPresentationMode?: string
  webkitEnterFullscreen?: () => void
}

function video(): WebkitVideo | null {
  return typeof document === 'undefined' ? null : document.querySelector<WebkitVideo>('video')
}

function webkitPip(el: WebkitVideo | null): boolean {
  if (!el || typeof el.webkitSetPresentationMode !== 'function') return false
  try {
    return el.webkitSupportsPresentationMode?.('picture-in-picture') !== false
  } catch {
    return false
  }
}

/** Whether this browser offers a direct Picture-in-Picture route. */
export function pipSupported(): boolean {
  if (typeof document === 'undefined') return false
  const standard = 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled
  return standard || webkitPip(video())
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
export async function enterPip(onLeave: () => void): Promise<boolean> {
  const el = video()
  if (!el) return false
  allowPip(el)

  // A paused element is refused by WebKit. This is still inside the button's
  // gesture, and the press explicitly asked to watch it.
  if (el.paused) void el.play().catch(() => {})

  if (webkitPip(el) && el.webkitSetPresentationMode) {
    const changed = (): void => {
      if (el.webkitPresentationMode === 'picture-in-picture') return
      el.removeEventListener('webkitpresentationmodechanged', changed)
      onLeave()
    }
    el.addEventListener('webkitpresentationmodechanged', changed)
    try {
      el.webkitSetPresentationMode('picture-in-picture')
      return true
    } catch {
      el.removeEventListener('webkitpresentationmodechanged', changed)
      // A standard implementation may coexist and still accept the request.
    }
  }

  if (typeof el.requestPictureInPicture === 'function' && document.pictureInPictureEnabled) {
    try {
      await el.requestPictureInPicture()
      el.addEventListener('leavepictureinpicture', onLeave, { once: true })
      return true
    } catch {
      // The last iPhone route is its native fullscreen player.
    }
  }

  if (typeof el.webkitEnterFullscreen === 'function') {
    try {
      el.webkitEnterFullscreen()
      return true
    } catch {
      /* unsupported for this media */
    }
  }
  return false
}

/** Closes the window if it is open. */
export async function exitPip(): Promise<void> {
  const el = video()
  // iPhone WebKit may pause the media element while changing its presentation
  // back to inline. Closing a window is not a pause command: remember whether
  // it was sounding before the change and restore only that case. Measured
  // 2026-09-10: pressing the PiP button a second time returned the video
  // "중지된채로 백그라운드에".
  const keepPlaying = !!el && !el.paused && !el.ended
  const restore = () => {
    if (!keepPlaying || !el || !el.paused || el.ended) return
    void el.play().catch(() => {})
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
      /* already gone */
    }
  }
  if (typeof document !== 'undefined' && document.pictureInPictureElement) {
    try {
      await document.exitPictureInPicture()
      restore()
    } catch {
      /* already gone */
    }
  }
}
