// One track row, and the menu behind its three dots. Every list in the app is
// made of these, so the actions on a track are defined once.

import { t } from '../../shared/i18n.ts'
import * as api from '../api.ts'
import { thumbnail, type Track } from '../parse.ts'
import { art, h, icon, type IconName } from './dom.ts'
import { clock, explain, type Ctx } from './ctx.ts'
import { showMenu, type MenuItem } from './overlay.ts'

export interface RowOptions {
  /** 1-based number shown at the left. Omitted for search results. */
  index?: number
  /** Plays this row: usually "play the whole list from here". */
  onPlay(): void
  /**
   * Extra items at the end of the menu, e.g. "remove from this playlist".
   *
   * A function, and given the row, because the actions that go here are the
   * ones that act on the row itself: taking a track out of a playlist should
   * take that row off the screen, not re-fetch the screen.
   */
  extra?: (row: HTMLElement) => Array<MenuItem | '-'>
  /**
   * The one-press action, shown beside the menu.
   *
   * Putting a track into a playlist, or taking it out, was two presses and a
   * submenu — open ⋯, find the item, and for a removal answer a dialog as
   * well. Those are the two things done most often to a row, so they get a
   * button. The menu keeps its versions for everything else.
   */
  quick?: { icon: IconName; title: string; run(row: HTMLElement): void }
}

export function row(ctx: Ctx, track: Track, opts: RowOptions): HTMLElement {
  const playing = ctx.engine.current?.videoId === track.videoId
  const classes = ['row', playing ? 'now' : '', track.unavailable ? 'dead' : ''].filter(Boolean).join(' ')

  const menuButton = h('button', { class: 'more', title: t('더보기'), 'aria-label': t('더보기'), 'data-nav': '' }, icon('more', 18))
  const openMenu = (ev: Event, el: HTMLElement) => {
    ev.stopPropagation()
    showMenu(ctx.overlay, menuButton, [
      { label: t('지금 재생'), icon: 'play', onSelect: () => ctx.engine.playNow([track]) },
      { label: t('다음에 재생'), icon: 'queue', onSelect: () => { ctx.engine.playNext([track]); ctx.say(t('다음에 재생합니다.')) } },
      { label: t('대기열에 추가'), icon: 'plus', onSelect: () => { ctx.engine.enqueue([track]); ctx.say('대기열에 넣었습니다.') } },
      '-',
      { label: t('이 곡으로 라디오'), icon: 'radio', onSelect: () => void startRadio(ctx, track) },
      { label: t('재생목록에 추가'), icon: 'library', onSelect: () => void ctx.addToPlaylist([track]) },
      '-',
      { label: t('공유'), icon: 'share', onSelect: () => void shareTrack(ctx, track) },
      { label: t('유튜브에서 열기'), icon: 'external', onSelect: () => window.open(`https://www.youtube.com/watch?v=${track.videoId}`, '_blank') },
      ...(opts.extra?.(el) ?? []),
    ], track.title)
  }

  const open = () => {
    // A drag ends in a click. Left alone, every swipe would also start playing
    // the row it revealed — and a tap on an open row closes it rather than
    // playing, which is what a phone has taught the gesture to mean.
    if (swipeAte(el)) return
    if (track.unavailable) return ctx.say(t('재생할 수 없는 항목입니다.'), true)
    opts.onPlay()
  }

  // An empty cell when there is no quick action, so every row in a list keeps
  // the same columns and the menus stay in one vertical line.
  // Its own class, not the menu's. Sharing `.more` put two of them in a row
  // and every locator that meant "the menu" then meant "either button".
  const quickButton = opts.quick
    ? h('button', { class: 'quick', 'data-nav': '', title: opts.quick.title, 'aria-label': opts.quick.title }, icon(opts.quick.icon, 18))
    : h('span')
  if (opts.quick) {
    quickButton.addEventListener('click', (ev) => {
      ev.stopPropagation()
      opts.quick!.run(el)
    })
  }

  // One handler on the row rather than one per part: the whole row is the
  // target, which is also what makes it work under a remote control.
  // data-id names the track the element is, so a view can take this one row
  // out of the screen again without redrawing anything to find it.
  const inner = h(
    'div',
    { class: 'rowInner' },
    h(
      'div',
      { class: 'idx' },
      playing
        ? h('span', { class: 'eq' }, h('i'), h('i'), h('i'))
        : opts.index !== undefined
          ? String(opts.index)
          : '',
    ),
    art('thumb', thumbnail(track.videoId)),
    h(
      'div',
      { class: 'meta' },
      h('div', { class: 'title', title: track.title }, track.title || track.videoId),
      h('div', { class: 'by' }, track.unavailable ? t('재생할 수 없음') : track.byline),
    ),
    h('div', { class: 'dur' }, track.duration),
  )
  // The menu is always at the right-hand edge of the row, on every device:
  // asked for on 2026-09-04, "...은 항상 우측에 보이게". Only the quick action
  // waits in the swipe strip, just past the edge where there is no pointer,
  // and a leftward drag brings it in; with a pointer it simply sits inline.
  const actions = h('div', { class: 'rowActions' }, quickButton)
  const el = h(
    'div',
    { class: classes, 'data-nav': '', 'data-id': track.videoId, tabindex: '0', role: 'button', onclick: open },
    inner,
    menuButton,
    actions,
  )
  menuButton.addEventListener('click', (ev) => openMenu(ev, el))
  swipeable(el, actions)
  return el
}

// ── Swipe ───────────────────────────────────────────────────────────────────
//
// The buttons on a row were always-on where a finger is, because a finger
// cannot hover: two glyphs on every line of every list, on the screen where
// there is least room for them. So on a touch screen they step off the edge
// and a leftward drag brings them back, which is the gesture a phone already
// teaches — and it means one row's actions at a time rather than forty.
//
// Only where there is no pointer. A mouse has hover, and hover is better.

/** The one row showing its actions, if any. */
let openRow: HTMLElement | null = null
/** When the last swipe ended, so the click it produces does not open a track. */
let swipedAt = 0
/** How far a drag must go sideways before it stops being a scroll. */
const SLOP = 8

export function closeSwipe(): void {
  if (!openRow) return
  openRow.classList.remove('open')
  openRow.style.removeProperty('--swipe')
  openRow = null
}

let watchingDocument = false
function closeOnTouchElsewhere(): void {
  if (watchingDocument) return
  watchingDocument = true
  document.addEventListener(
    'touchstart',
    (ev) => {
      if (!openRow || ev.composedPath().includes(openRow)) return
      closeSwipe()
    },
    { passive: true, capture: true },
  )
}

/** Whether a click on a row is the tail of a swipe and should be ignored. */
function swipeAte(row: HTMLElement): boolean {
  if (row.classList.contains('open')) {
    closeSwipe()
    return true
  }
  return Date.now() - swipedAt < 400
}

function swipeable(row: HTMLElement, actions: HTMLElement): void {
  if (!matchMedia('(hover: none)').matches) return
  closeOnTouchElsewhere()
  let x0 = 0
  let y0 = 0
  let dx = 0
  let width = 0
  let tracking = false
  let sliding = false

  row.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length !== 1) return
      if (openRow && openRow !== row) closeSwipe()
      const touch = ev.touches[0]!
      width = actions.offsetWidth
      if (width < 8) return
      x0 = touch.clientX
      y0 = touch.clientY
      dx = openRow === row ? -width : 0
      tracking = true
      sliding = false
    },
    { passive: true },
  )

  row.addEventListener(
    'touchmove',
    (ev) => {
      if (!tracking) return
      const touch = ev.touches[0]!
      const mx = touch.clientX - x0
      const my = touch.clientY - y0
      if (!sliding) {
        // A scroll is a scroll: the finger has to be going mostly sideways,
        // and far enough that a tap with a shaky hand is not a swipe.
        if (Math.abs(my) > Math.abs(mx)) {
          tracking = false
          return
        }
        if (Math.abs(mx) < SLOP) return
        sliding = true
        row.classList.add('swiping')
      }
      const from = openRow === row ? -width : 0
      dx = Math.max(-width, Math.min(0, from + mx))
      row.style.setProperty('--swipe', `${dx}px`)
    },
    { passive: true },
  )

  const settle = (): void => {
    if (!tracking) return
    tracking = false
    row.classList.remove('swiping')
    if (!sliding) return
    swipedAt = Date.now()
    // Past halfway it opens, short of it it goes back. The transition does the
    // rest, which is why the inline property is removed rather than set to 0.
    if (dx < -width / 2) {
      row.classList.add('open')
      row.style.setProperty('--swipe', `${-width}px`)
      openRow = row
    } else {
      row.classList.remove('open')
      row.style.removeProperty('--swipe')
      if (openRow === row) openRow = null
    }
  }
  row.addEventListener('touchend', settle, { passive: true })
  row.addEventListener('touchcancel', settle, { passive: true })
}

/** Replaces the queue with a mix built around one track. */
export async function startRadio(ctx: Ctx, track: Track): Promise<void> {
  try {
    ctx.say(t('라디오를 만드는 중…'))
    const page = await api.mix(ctx.cfg, track.videoId)
    if (page.tracks.length === 0) return ctx.say(t('이 곡으로는 라디오를 만들 수 없습니다.'), true)
    ctx.engine.play(page.tracks, 0)
    ctx.go({ kind: 'queue' })
    ctx.say(`${page.tracks.length}곡으로 라디오를 시작합니다.`)
  } catch (err) {
    ctx.say(explain(err), true)
  }
}

/**
 * Hands the track's YouTube link to the system share sheet where there is
 * one, the clipboard everywhere else. `youtu.be` is the short form YouTube's
 * own share button gives out. Shared by the row's and the card's ⋯ menus.
 */
export async function shareTrack(ctx: Ctx, track: Track): Promise<void> {
  const url = `https://youtu.be/${track.videoId}`
  try {
    if (navigator.share) {
      await navigator.share({ title: track.title || track.videoId, url })
      return
    }
    await navigator.clipboard.writeText(url)
    ctx.say(t('링크를 복사했습니다.'))
  } catch (err) {
    // A dismissed share sheet is not a failure; only a share or copy that
    // could not run is.
    if ((err as DOMException)?.name === 'AbortError') return
    ctx.say(t('공유하지 못했습니다.'), true)
  }
}

/**
 * Takes a row off the screen without redrawing the screen.
 *
 * The row is pinned to the height it currently has, then collapsed to nothing,
 * so the rows below it slide up instead of jumping. Written as inline style
 * rather than a class because the animation belongs to this one action and to
 * nothing else on the page.
 *
 * Removal happens on the transition's end rather than on a timer, so the two
 * can never disagree — with a fallback timer for the browsers and settings
 * where a transition never runs and therefore never ends. Hence the guard: the
 * row must not be removed twice.
 */
function collapse(row: HTMLElement, done: () => void): void {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    row.remove()
    done()
  }
  row.addEventListener('transitionend', finish, { once: true })

  const height = row.getBoundingClientRect().height
  row.style.height = `${height}px`
  row.style.overflow = 'hidden'
  row.style.transition = 'height .18s ease, opacity .18s ease, padding .18s ease'
  // Read once so the browser has a height to animate away from; setting both
  // in the same frame would be one style change and no transition at all.
  void row.offsetHeight
  row.style.height = '0'
  row.style.opacity = '0'
  row.style.paddingTop = '0'
  row.style.paddingBottom = '0'
  setTimeout(finish, 400)
}

/**
 * Takes the track out and takes the row with it. No question asked.
 *
 * One press is the whole point — a dialog would make it two — and putting the
 * track back is one press as well, which is what makes that safe.
 *
 * Only ever offered on a playlist of one's own. YouTube refuses an edit to
 * someone else's list, and offering the button anyway earns the reader a red
 * toast for pressing what we drew; the caller decides, and does.
 */
export async function removeFromPlaylistNow(
  ctx: Ctx,
  playlistId: string,
  track: Track,
  row: HTMLElement,
  onRemoved: () => void,
): Promise<void> {
  try {
    await api.removeFromPlaylist(ctx.cfg, playlistId, track)
    ctx.say(t('재생목록에서 뺐습니다.'))
    collapse(row, onRemoved)
  } catch (err) {
    ctx.say(explain(err), true)
  }
}

export { clock }
