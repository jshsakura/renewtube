// The hand on YouTube's own player.
//
// `#movie_player` is the page's player element, and it carries the same API the
// IFrame player does: loadVideoById, playVideo, seekTo and the rest. Driving it
// directly, rather than navigating, is what keeps the page still: `ytd-app`
// never re-renders, the URL never changes, and the player response still goes
// through whatever else is hooked into the page (an ad blocker, say).

export const enum State {
  Unstarted = -1,
  Ended = 0,
  Playing = 1,
  Paused = 2,
  Buffering = 3,
  Cued = 5,
}

export interface VideoData {
  video_id: string
  title: string
  author: string
}

export interface YtPlayer extends HTMLElement {
  loadVideoById(id: string | { videoId: string; startSeconds?: number }): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead?: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  getVideoData(): VideoData
  getVolume(): number
  setVolume(v: number): void
  setPlaybackRate(rate: number): void
  getPlaybackRate(): number
  /**
   * The only quality control the page still honours.
   *
   * `setPlaybackQuality` is the documented one and it does nothing: measured
   * 2026-09-04 against a live watch page, asking for `tiny` left a 360p stream
   * at 360p. The range form changes the stream within a few seconds.
   */
  setPlaybackQualityRange(min: string, max?: string): void
  getPlaybackQuality(): string
  /** Highest first, with `auto` last. What this video actually offers. */
  getAvailableQualityLevels(): string[]
  isMuted(): boolean
  mute(): void
  unMute(): void
  /**
   * YouTube's own account of *why* it is muted, and whether it is running as
   * an inline preview. Measured 2026-09-04: both exist on the live player,
   * alongside setInline, setInlinePreview, setSize and setInternalSize. On a
   * signed-out watch page they answer false, so the feed-preview case they
   * describe could not be reproduced here; they are declared optional and
   * called defensively for that reason.
   */
  isMutedByMutedAutoplay?(): boolean
  isInline?(): boolean
  setInline?(inline: boolean): void
  setInlinePreview?(preview: boolean): void
  addEventListener(name: string, fn: (...args: unknown[]) => void): void
  removeEventListener(name: string, fn: (...args: unknown[]) => void): void
}

/** The player, when the page has one and it has finished wiring its API. */
export function findPlayer(): YtPlayer | null {
  const el = document.getElementById('movie_player') as Partial<YtPlayer> | null
  if (!el || typeof el.loadVideoById !== 'function' || typeof el.getPlayerState !== 'function') {
    return null
  }
  return el as YtPlayer
}

/** Resolves when the player exists, or with null after `timeoutMs`. */
export function waitForPlayer(timeoutMs = 20_000): Promise<YtPlayer | null> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const p = findPlayer()
      if (p) return resolve(p)
      if (Date.now() > deadline) return resolve(null)
      setTimeout(tick, 250)
    }
    tick()
  })
}

/**
 * Turns the page's own autoplay off, so a track ending does not race our
 * queue with YouTube's "up next" navigation. The toggle is a control in the
 * player chrome and its state is a user preference the page remembers.
 */
export function disableAutonav(): void {
  const btn = document.querySelector<HTMLElement>('.ytp-autonav-toggle-button')
  if (btn && btn.getAttribute('aria-checked') === 'true') btn.click()
}

/** The video id in the current URL, if this is a watch page. */
export function videoIdInUrl(): string | undefined {
  return new URLSearchParams(location.search).get('v') ?? undefined
}
