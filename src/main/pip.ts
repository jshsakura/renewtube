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
  if (el?.webkitPresentationMode === 'picture-in-picture' && el.webkitSetPresentationMode) {
    try {
      el.webkitSetPresentationMode('inline')
      return
    } catch {
      /* already gone */
    }
  }
  if (typeof document !== 'undefined' && document.pictureInPictureElement) {
    try {
      await document.exitPictureInPicture()
    } catch {
      /* already gone */
    }
  }
}
