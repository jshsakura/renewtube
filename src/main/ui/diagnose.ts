// What a report from a phone cannot say: the screen, in words.
//
// Every "something of YouTube's is showing" and every "it loaded but nothing
// plays" arrived as a screenshot, and a screenshot cannot say what is on top,
// where the player is, whether its element is playing, or whether an advert
// is running underneath a bar that shows 0:00. This prints all of it as text,
// so a phone can copy it and a desktop can paste it.
//
// Read-only. Nothing here changes the page, the player or the app.

import type { Engine } from '../engine.ts'
import { narrowNow } from './device.ts'

const OURS = new Set(['OC-EASY-MODE', 'OC-EASY-MODE-OVERLAY'])

/** `tag#id.class.class`, short enough to read on a phone. */
function name(el: Element): string {
  const id = el.id ? `#${el.id}` : ''
  const cls = el.classList.length > 0 ? `.${Array.from(el.classList).slice(0, 3).join('.')}` : ''
  return `${el.tagName.toLowerCase()}${id}${cls}`
}

function rect(el: Element | null): string {
  if (!el) return '없음'
  const r = el.getBoundingClientRect()
  return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`
}

/** The player's classes that say what it is doing, and nothing else. */
function playerClasses(player: Element): string {
  return Array.from(player.classList)
    .filter((c) => /ad-|unstarted|playing|paused|buffering|ended|inline|fullscreen|-mode$/.test(c))
    .join(' ') || '(없음)'
}

/** What is on top at nine points of the viewport, when it is not ours. */
function onTop(): string[] {
  const out: string[] = []
  const w = window.innerWidth
  const h = window.innerHeight
  for (const fy of [0.1, 0.5, 0.9]) {
    for (const fx of [0.1, 0.5, 0.9]) {
      const el = document.elementFromPoint(Math.round(w * fx), Math.round(h * fy))
      if (!el || OURS.has(el.tagName)) continue
      out.push(`  ${Math.round(w * fx)},${Math.round(h * fy)}: ${name(el)}`)
    }
  }
  return out.length > 0 ? out : ['  전부 RenewTube']
}

/** The player's ancestors, with the four properties that decide whether it can be seen. */
function chain(player: HTMLElement): string[] {
  const out: string[] = []
  for (let el: HTMLElement | null = player; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el)
    const hidden = el.hasAttribute('hidden') ? ' [hidden]' : ''
    out.push(`  ${name(el)}${hidden}: ${cs.display} ${cs.visibility} ${cs.position} z=${cs.zIndex}`)
  }
  return out
}

/** The report, as lines. */
export function diagnose(engine: Engine, version: string): string {
  const lines: string[] = []
  const player = document.getElementById('movie_player')
  const video = document.querySelector('video')
  const p = engine.player
  const pos = engine.position
  const win = window as unknown as Record<string, unknown>

  lines.push(`RenewTube ${version} · ${new Date().toISOString()}`)
  lines.push(`${location.host}${location.pathname} · ${window.innerWidth}x${window.innerHeight}${narrowNow() ? ' narrow' : ''} · ${document.visibilityState}${document.hasFocus() ? ' focus' : ''}`)
  lines.push(navigator.userAgent)
  lines.push(`모드 ${engine.state.mode} · 화면 ${engine.state.video} · 광고차단기 ${'__ocAdByePassInstalled' in win ? '있음' : '없음'}`)
  lines.push('')

  lines.push('재생')
  const cur = engine.current
  lines.push(`  대기열 ${engine.state.index + 1}/${engine.state.queue.length} · 현재 ${cur ? `${cur.videoId} ${cur.title.slice(0, 40)}` : '없음'}`)
  lines.push(`  바: ${pos.playing ? '재생' : '정지'}${pos.buffering ? ' 버퍼링' : ''}${pos.stalled ? ' 멈춤' : ''} ${Math.round(pos.current)}/${Math.round(pos.duration)}s · 소리 ${engine.muted ? '꺼짐' : engine.state.volume}`)
  if (p) {
    let st = '?'
    let id = '?'
    let extra = ''
    try {
      st = String(p.getPlayerState())
      id = p.getVideoData()?.video_id ?? '없음'
      extra = ` · inline ${String(p.isInline?.())} · 음소거 ${String(p.isMuted())} · 볼륨 ${p.getVolume()} · 화질 ${p.getPlaybackQuality()}`
    } catch {
      extra = ' · API 응답 없음'
    }
    lines.push(`  플레이어: 상태 ${st} · 영상 ${id}${extra}`)
    lines.push(`  클래스: ${playerClasses(p)}`)
  } else {
    lines.push('  플레이어: 붙지 않음')
  }
  const slot = document.querySelector('.video-ads')
  const adEl = document.querySelector('ytm-video-ad-renderer, .ytp-ad-player-overlay, .ytp-ad-text, .ytp-skip-ad-button')
  lines.push(`  광고: 슬롯 ${slot ? slot.childElementCount : '없음'} · 요소 ${adEl ? name(adEl) : '없음'}`)
  if (video) {
    const src = video.currentSrc || video.src
    lines.push(
      `  video: ${video.paused ? '정지' : '재생'}${video.ended ? ' 끝' : ''} ${video.currentTime.toFixed(1)}/${Number.isFinite(video.duration) ? video.duration.toFixed(1) : '?'}s · 음소거 ${String(video.muted)} · 볼륨 ${video.volume.toFixed(2)} · 배속 ${video.playbackRate} · ready ${video.readyState} net ${video.networkState} · src ${src ? src.slice(0, 5) : '없음'} · 오류 ${video.error ? video.error.code : '없음'} · ${rect(video)}`,
    )
  } else {
    lines.push('  video: 없음')
  }
  // The ladder, which is the half of a "재생이 안 돼요" report that a screenshot
  // can never carry: whether anything was asking for sound, what has already
  // been tried for this track, and how long since the clock last moved.
  const r = engine.recovery
  const spent = [r.spent.nav ? '이동' : '', r.spent.push ? '재요청' : '', r.spent.reload ? '새로고침' : ''].filter(Boolean)
  lines.push(
    `  복구: 요청 ${r.wants ? '있음' : '없음'}${r.failing ? ' · 실패 판정' : ''} · 쓴 수단 ${spent.length > 0 ? spent.join(',') : '없음'} · 포기 ${r.gaveUp ?? '없음'}`,
  )
  lines.push(
    `        요청 후 ${r.sinceAsk < 0 ? '-' : `${(r.sinceAsk / 1000).toFixed(1)}s`} · 시계 멈춘 지 ${r.sinceProgress < 0 ? '-' : `${(r.sinceProgress / 1000).toFixed(1)}s`} · 불러옴 ${r.loaded ? '예' : '아니오'} · 들린적 ${r.heard ? '예' : '아니오'} · 제스처대기 ${r.gesture ? '예' : '아니오'} · 광고판정 ${r.advert ? '예' : '아니오'}`,
  )
  lines.push('')

  lines.push(`플레이어 위치: ${rect(player)}`)
  if (player) {
    lines.push('플레이어 조상:')
    lines.push(...chain(player))
  }
  lines.push('')
  lines.push('맨 위에 있는 것:')
  lines.push(...onTop())
  return lines.join('\n')
}
