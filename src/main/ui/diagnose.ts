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

/**
 * The deepest thing painted at a point, through shadow roots.
 *
 * `elementFromPoint` stops at a shadow host, so asking the document alone
 * answers "RenewTube" for everything of ours and never says *which* part —
 * which is exactly the blind spot when the complaint is that something
 * invisible is covering the screen. Each root is asked in turn until the
 * answer stops changing.
 */
function deepestAt(x: number, y: number): Element | null {
  let el = document.elementFromPoint(x, y)
  for (let step = 0; step < 8; step++) {
    const root = (el as HTMLElement | null)?.shadowRoot
    if (!root) break
    const inner = root.elementFromPoint(x, y)
    if (!inner || inner === el) break
    el = inner
  }
  return el
}

/** What is on top at nine points of the viewport, ours named as well as theirs. */
function onTop(): string[] {
  const out: string[] = []
  const w = window.innerWidth
  const h = window.innerHeight
  for (const fy of [0.1, 0.5, 0.9]) {
    for (const fx of [0.1, 0.5, 0.9]) {
      const x = Math.round(w * fx)
      const y = Math.round(h * fy)
      const el = deepestAt(x, y)
      if (!el) continue
      // Ours is not a reason to say nothing: a scrim, a sheet or a splash of
      // ours left over covers the screen exactly as thoroughly as YouTube's.
      const mine = OURS.has(el.tagName) ? '' : ' ←'
      const cs = getComputedStyle(el)
      // Hit-testable is not the same as visible, and that difference is the
      // whole of a screen that measures perfectly and looks black.
      const faint = cs.opacity !== '1' || cs.visibility !== 'visible' ? ` op ${cs.opacity} vis ${cs.visibility}` : ''
      out.push(`  ${x},${y}: ${name(el)}${mine}${faint}`)
    }
  }
  return out.length > 0 ? out : ['  아무것도 없음']
}

/**
 * Anything painted over the app that the app did not put there.
 *
 * The question a report cannot answer for itself: "뭔가 안 보이는 게 화면을
 * 덮고 있다". The picture is the usual answer — parked, it is click-through,
 * so a tap goes past it to the button underneath while it covers what is
 * there, which is exactly how it reads. Named here rather than left to be
 * worked out from the numbers above.
 */
function covers(engine: Engine): string[] {
  const out: string[] = []
  const player = document.getElementById('movie_player')
  const slot = document.querySelector('oc-easy-mode')?.shadowRoot?.querySelector('.slot') as HTMLElement | null
  const hidden = slot === null || slot.classList.contains('hidden')
  if (player) {
    const r = player.getBoundingClientRect()
    const onScreen = r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight && r.width > 1 && r.height > 1
    if (onScreen && hidden) {
      out.push(`  ⚠ 화면을 숨겼는데 재생기가 화면 안에 있습니다: ${rect(player)} · 터치통과 ${getComputedStyle(player).pointerEvents}`)
    } else if (onScreen && slot) {
      const s = slot.getBoundingClientRect()
      const off = Math.round(Math.abs(r.left - s.left)) + Math.round(Math.abs(r.top - s.top))
      if (off > 8) out.push(`  ⚠ 재생기가 자리(${rect(slot)})를 벗어나 있습니다: ${rect(player)}`)
    }
  }
  // Anything of ours that is still floating: a menu, a sheet, a scrim, the
  // boot splash. Each of these is meant to be gone the moment it is dismissed.
  const over = document.querySelector('oc-easy-mode-overlay')?.shadowRoot
  const floating = over ? Array.from(over.querySelectorAll('.scrim, .menu, .splash, .modal')) : []
  for (const el of floating) out.push(`  ⚠ 떠 있는 것: ${name(el)} ${rect(el)}`)
  if (engine.arrivalHeld) out.push('  · 도착 보류 중(누르면 재생)')
  return out.length > 0 ? out : ['  없음']
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
  // The app's own box against the screen it is supposed to be.
  //
  // Two reports arrived with the header perfect and everything under it black,
  // and in both of them the player bar was missing as well — which a blank list
  // does not explain, because the bar is not in the list. An app taller than
  // the visible area does explain it: the bar is below the fold, off the bottom
  // of the phone, and the middle is empty ground. `dvh` is meant to be exactly
  // the visible area, and if it is not on some browser then that is the bug,
  // so the numbers that would say so are printed here.
  const host = document.querySelector('oc-easy-mode') as HTMLElement | null
  const shadow = host?.shadowRoot
  const appEl = shadow?.querySelector('.app') ?? null
  const mainEl = shadow?.querySelector('.main') ?? null
  const barEl = shadow?.querySelector('.bar') ?? null
  const vv = window.visualViewport
  lines.push('')
  lines.push('앱의 자리')
  lines.push(`  앱 ${rect(appEl)} · 목록 ${rect(mainEl)} (자식 ${mainEl ? mainEl.children.length : 0}개) · 바 ${rect(barEl)}`)
  // The gap at the top of the list, and what would make one.
  //
  // The list reserves room for the picture by padding its own top, and it
  // scrolls inside itself. Either of those left where it does not belong is a
  // band of empty ground above the content — invisible while the picture is
  // over it, and the whole screen the moment the picture is put away. Nothing
  // else in this report would show it.
  if (mainEl) {
    const m = getComputedStyle(mainEl)
    const first = mainEl.firstElementChild
    lines.push(
      `  목록 안: 위여백 ${m.paddingTop} · 스크롤 ${Math.round(mainEl.scrollTop)}/${mainEl.scrollHeight} · 첫 자식 ${first ? `${name(first)} ${rect(first)}` : '없음'}`,
    )
  }
  if (appEl) lines.push(`  앱 클래스: ${appEl.className}`)
  if (shadow) {
    const sl = shadow.querySelector('.slot')
    lines.push(`  슬롯: ${sl ? `${sl.className} ${rect(sl)} · ${getComputedStyle(sl).display}` : '없음'} · --stage-h ${getComputedStyle(appEl ?? document.documentElement).getPropertyValue('--stage-h').trim() || '없음'} · --stage-scroll ${getComputedStyle(document.documentElement).getPropertyValue('--stage-scroll').trim() || '없음'}`)
  }
  lines.push(
    `  보이는 영역 ${window.innerWidth}x${window.innerHeight} · visual ${vv ? `${Math.round(vv.width)}x${Math.round(vv.height)} @${Math.round(vv.offsetTop)}` : '없음'} · client ${document.documentElement.clientWidth}x${document.documentElement.clientHeight} · 화면 ${window.screen.width}x${window.screen.height}`,
  )
  if (barEl) {
    const b = barEl.getBoundingClientRect()
    if (b.bottom > window.innerHeight + 1) lines.push(`  ⚠ 바가 화면 아래로 ${Math.round(b.bottom - window.innerHeight)}px 넘어갑니다`)
    if (b.width < 1 || b.height < 1) lines.push('  ⚠ 바가 그려지지 않았습니다')
  }
  if (mainEl && mainEl.children.length === 0) lines.push('  ⚠ 목록이 비어 있습니다')
  // What the list is actually showing.
  //
  // Two reports of the same screen, one broken and one not, had identical
  // geometry, nothing covering, and our own elements under every probe — and
  // still one of them was black to look at. Elements can be laid out, sized and
  // hit-testable while painting nothing at all: empty text, a picture that
  // never arrived, a colour that matches the ground. So the rows are asked what
  // they are carrying rather than only where they are.
  // The palette, in case the answer is that the ink and the paper became the
  // same colour. A screen that measures perfectly and looks black is either
  // painting nothing or painting it in the background's own colour, and this
  // is the half of that question the boxes above cannot answer.
  if (appEl && mainEl) {
    const a = getComputedStyle(appEl)
    const m = getComputedStyle(mainEl)
    lines.push('')
    lines.push('색')
    lines.push(`  앱 ${a.backgroundColor} / 글자 ${a.color} · 목록 ${m.backgroundColor} · 테마 ${appEl.classList.contains('light') ? 'light' : 'dark'}`)
    lines.push(`  ground ${a.getPropertyValue('--ground').trim() || '없음'} · foreground ${a.getPropertyValue('--foreground').trim() || '없음'} · panel ${a.getPropertyValue('--panel').trim() || '없음'}`)
  }
  lines.push('')
  lines.push('목록이 그리고 있는 것')
  const rowsSeen = shadow ? Array.from(shadow.querySelectorAll('.row, .tile, .card, .shelf')).slice(0, 4) : []
  if (rowsSeen.length === 0) {
    lines.push(`  줄이 없습니다 (목록 자식 ${mainEl ? mainEl.children.length : 0}개)`)
  }
  for (const el of rowsSeen) {
    const cs = getComputedStyle(el)
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
    const img = el.querySelector('img')
    const src = img?.getAttribute('src') ?? ''
    lines.push(
      `  ${name(el)} ${rect(el)} · 글자 ${text.length}자 "${text.slice(0, 24)}" · 그림 ${img ? (src ? `${img.naturalWidth}x${img.naturalHeight}` : '주소없음') : '없음'} · op ${cs.opacity} vis ${cs.visibility} 색 ${cs.color}`,
    )
  }
  lines.push('')
  lines.push('덮고 있는 것:')
  lines.push(...covers(engine))
  lines.push('')
  lines.push('맨 위에 있는 것:')
  lines.push(...onTop())
  return lines.join('\n')
}
