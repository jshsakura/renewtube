// Native Picture-in-Picture, for the desktop.
//
// The desktop stage put YouTube's player — a fixed, light-DOM element — over
// our shadow-DOM app and then fought the app for it on every scroll, every
// hide and every fullscreen ("영역을 고정할때보다 안좋아졌지"). The browser has
// a window built for exactly this, and it floats on its own outside our
// layout, so none of those fights exist. On the desktop the picture goes there
// instead of onto a stage of our own.

type Video = HTMLVideoElement & { disablePictureInPicture?: boolean }

/** Whether this browser offers Picture-in-Picture at all. */
export function pipSupported(): boolean {
  return typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && (document as Document).pictureInPictureEnabled
}

/** Whether a Picture-in-Picture window is open right now. */
export function pipOpen(): boolean {
  return typeof document !== 'undefined' && document.pictureInPictureElement !== null
}

/**
 * Opens the picture in its own floating window. Must be called from a gesture.
 *
 * `onLeave` fires once when the window closes, however it closes — our button
 * or the window's own — so the bar can drop back to sound and lower the
 * quality it no longer needs.
 */
export async function enterPip(onLeave: () => void): Promise<boolean> {
  const el = document.querySelector<Video>('video')
  if (!el || !pipSupported()) return false
  try {
    // YouTube sets this to keep its own button off; the request throws while it
    // is set, so clear it first.
    el.disablePictureInPicture = false
    await el.requestPictureInPicture()
    el.addEventListener('leavepictureinpicture', onLeave, { once: true })
    return true
  } catch {
    return false
  }
}

/** Closes the window if it is open. */
export async function exitPip(): Promise<void> {
  if (typeof document !== 'undefined' && document.pictureInPictureElement) {
    try {
      await document.exitPictureInPicture()
    } catch {
      /* already gone */
    }
  }
}
