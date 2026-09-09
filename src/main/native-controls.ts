// YouTube's controls, pointed at RenewTube's queue.
//
// The video surface is still YouTube's own player, so its controls can ask
// YouTube to advance its own autonav list. RenewTube has a different queue.
// Letting that press through briefly loads a foreign video; the engine then
// correctly rejects it and restores the current track, which looks exactly
// like a Next button that repeats the same video (measured 2026-09-10:
// "영상에서 다음재생을 누르면 안넘어가네 ... 같은영상이 계속 나오는상황").

import type { Engine } from './engine.ts'

const NEXT = [
  '.ytp-next-button',
  '.ytp-endscreen-next',
  '.ytp-autonav-endscreen-upnext-play-button',
  '.player-controls-next-button',
  '[data-tooltip-target-id="ytp-next-button"]',
].join(',')

function inNativePlayer(el: Element): boolean {
  return !!el.closest('#movie_player, #player-control-container')
}

/** True only for a Next control in YouTube's player furniture. */
export function isNativeNext(el: Element): boolean {
  if (!inNativePlayer(el)) return false
  if (el.matches(NEXT) || el.closest(NEXT)) return true
  const control = el.closest<HTMLElement>('button, a, [role="button"]')
  if (!control || !inNativePlayer(control)) return false
  const name = control.getAttribute('aria-label')?.trim() ?? ''
  return /^(?:다음|next)(?:\s|\(|$)/i.test(name)
}

/** Captures YouTube's Next before autonav can take the shared player. */
export function installNativeNext(engine: Pick<Engine, 'next'>): () => void {
  const onClick = (ev: MouseEvent) => {
    if (ev.button !== 0) return
    const target = ev.composedPath().find((node): node is Element => node instanceof Element && isNativeNext(node))
    if (!target) return
    ev.preventDefault()
    ev.stopImmediatePropagation()
    engine.next()
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
