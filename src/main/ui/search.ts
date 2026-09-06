// Search, as a question asked over the screen rather than a screen of its own.
//
// It used to be a destination: the sidebar took you to a page, you typed,
// pressed Enter, and the answer replaced whatever you had been looking at.
// Now 검색 in the header or the sidebar opens a panel over the current
// screen. The field and its answers appear there, choosing one plays it and
// puts the panel away, and the screen underneath is exactly as it was. That
// is how a television's search works: it interrupts, it does not relocate.
//
// The answers are always rows, whatever the mode. This is a picker, and a
// picker is read down a list; a wall of thumbnails in a 640px panel would be
// two tiles wide and forty tiles tall.
//
// A field on its own is a wall, which is what "휑하다" meant. So there is
// something under it at every moment: what this browser searched for before
// while it is empty, what YouTube would suggest while it is being typed into,
// and three kinds of answer once it has been asked.

import { t, tn } from '../../shared/i18n.ts'
import * as api from '../api.ts'
import type { ChannelHit, Playlist, Track } from '../parse.ts'
import { clearSearches, forgetSearch, recentSearches, rememberSearch } from '../store.ts'
import { narrowNow } from './device.ts'
import { art, h, icon, replace } from './dom.ts'
import { explain, type Ctx } from './ctx.ts'
import { holdModal } from './overlay.ts'
import { row } from './rows.ts'
import { addQuick, keep, nothing, screenTracks, skRow, skRows } from './views.ts'

/** How long the field waits after the last keystroke before asking YouTube. */
const SETTLE_MS = 350

/**
 * How long it waits before asking for suggestions.
 *
 * Shorter than the search, and deliberately: a suggestion is meant to arrive
 * while the word is still being typed, and the request behind it is a few
 * hundred bytes rather than half a megabyte.
 */
const SUGGEST_MS = 150

/**
 * How many playlists, and how many channels, the section under the field holds.
 *
 * A channels-only search answers with twenty and a playlists-only search with
 * nineteen, and drawn in full they buried the videos: measured on a 390px
 * phone, the section alone was longer than the whole panel and 전체 재생 was
 * three screens down. This is meant to be the answer to "there is also a
 * playlist for this", not a list to read.
 *
 * Two apiece on a phone rather than four, for the same reason at a smaller
 * size: eight rows is the whole of a 390px panel, and someone searching for a
 * song would have to scroll past every one of them to reach a song.
 */
function kindMax(): number {
  return narrowNow() ? 2 : 4
}

/** The one panel that can be open, and the way to close it. */
let closeOpen: (() => void) | null = null

/** Closes the panel if it is open. */
export function closeSearch(): void {
  closeOpen?.()
}

/**
 * Opens the panel, with `query` already in the field and being looked up.
 *
 * Opening it twice is one panel: the second press puts the caret back in the
 * field instead of stacking a second dialog over the first.
 */
export function openSearch(ctx: Ctx, query = ''): void {
  if (closeOpen) {
    ctx.overlay.querySelector<HTMLInputElement>('.modal.search input')?.focus()
    return
  }

  const input = h('input', {
    type: 'search',
    placeholder: t('노래, 영상, 채널 검색'),
    value: query,
    autocomplete: 'off',
    'data-nav': '',
  })
  const body = h('div', { class: 'searchBody' })
  // Between the field and the answers, and hidden until there is something in
  // it, so an untouched panel has no empty strip across it.
  const suggestions = h('div', { class: 'searchSuggest', role: 'listbox', 'aria-label': t('추천 검색어'), hidden: true })

  const panel = h(
    'div',
    { class: narrowNow() ? 'modal search full' : 'modal search', role: 'dialog', 'aria-label': t('검색') },
    h(
      'div',
      { class: 'searchHead' },
      h('div', { class: 'searchbox' }, icon('search', 20), input),
      h(
        'button',
        { class: 'modalClose', 'data-nav': '', title: t('닫기'), 'aria-label': t('닫기'), onclick: () => close() },
        icon('close', 20),
      ),
    ),
    suggestions,
    body,
  )
  // data-remote: the arrows walk this panel the way they walk the app.
  const scrim = h('div', { class: 'scrim searchScrim', 'data-remote': '', onclick: (ev) => ev.target === scrim && close() }, panel)

  const release = holdModal()
  let settle: ReturnType<typeof setTimeout> | undefined
  let hint: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    closeOpen = null
    release()
    clearTimeout(settle)
    clearTimeout(hint)
    document.removeEventListener('keydown', onEscape, true)
    scrim.remove()
  }
  closeOpen = close

  // Escape closes the panel, and only the panel: it must not travel on to the
  // shell's twice-to-leave. But not while something is open *over* the panel,
  // a row's menu or the playlist picker, because that Escape is theirs.
  const onEscape = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    const floating = ctx.overlay.querySelectorAll('.menu, .scrim')
    if (floating[floating.length - 1] !== scrim) return
    ev.stopPropagation()
    ev.preventDefault()
    close()
  }

  const mark = (label: string, n?: number) =>
    h('div', { class: 'searchMark' }, label, n !== undefined && h('span', { class: 'sub' }, tn('곡', n)))

  // ── Suggestions ──────────────────────────────────────────────────────────

  /** Which suggestion request is the latest; an older answer is dropped. */
  let hinted = 0

  function hideSuggestions(): void {
    hinted += 1
    suggestions.hidden = true
    replace(suggestions)
  }

  /**
   * Asks for suggestions and draws them, on its own short timer.
   *
   * They carry `data-nav` like everything else, so the down arrow walks out of
   * the field and into them, and out of the last of them into the answers
   * below: the remote needs no rule of its own for this list.
   */
  async function askSuggestions(raw: string): Promise<void> {
    const token = ++hinted
    const list = await api.suggest(ctx.cfg, raw)
    if (closed || token !== hinted) return
    if (list.length === 0) return hideSuggestions()
    replace(
      suggestions,
      list.map((text) =>
        h(
          'button',
          { class: 'suggestRow', 'data-nav': '', role: 'option', onclick: () => ask(text) },
          icon('search', 16),
          h('span', null, text),
        ),
      ),
    )
    suggestions.hidden = false
  }

  /**
   * The list belongs to the field: walking off it inside the panel puts it
   * away, and walking down it does not.
   *
   * **Asked a tick later, and only about this panel.** Two things went wrong
   * with the obvious version, both measured 2026-09-05 and both intermittent:
   *
   * - Reading `relatedTarget` off the event deleted the row that was being
   *   pressed. A press moves focus out of the previous row on its way in, and
   *   that first half arrives before the new focus has landed, so the list was
   *   emptied between the press and the release and the press did nothing.
   * - Hiding whenever focus left counted YouTube stealing it. The page under
   *   this panel is still alive and still calls `focus()` on its own things,
   *   and the suggestions vanished for a reason that had nothing to do with
   *   the reader.
   *
   * So: a tick later, when the focus has arrived somewhere, and only when it
   * arrived somewhere else **in this panel**. Focus that has left the panel
   * altogether is not this list's business; a press outside closes the panel.
   */
  panel.addEventListener('focusout', () => {
    setTimeout(() => {
      if (closed) return
      const active = ctx.overlay.activeElement
      if (!active || !panel.contains(active)) return
      if (active === input || suggestions.contains(active)) return
      hideSuggestions()
    })
  })

  // ── Recent searches ──────────────────────────────────────────────────────

  /**
   * The empty panel: what was searched for before, then the prompt.
   *
   * Redrawn rather than patched when a query is dropped, because the heading
   * and the 지우기 beside it both disappear with the last row.
   */
  function drawEmpty(): void {
    const recent = recentSearches()
    replace(
      body,
      recent.length > 0 &&
        h(
          'div',
          { class: 'searchRecent' },
          h(
            'div',
            { class: 'searchMark' },
            t('최근 검색'),
            h(
              'button',
              {
                class: 'searchClear',
                'data-nav': '',
                onclick: () => {
                  clearSearches()
                  drawEmpty()
                },
              },
              t('지우기'),
            ),
          ),
          recent.map((q) =>
            h(
              'div',
              { class: 'recentRow' },
              h('button', { class: 'recentGo', 'data-nav': '', onclick: () => ask(q) }, icon('history', 16), h('span', null, q)),
              h(
                'button',
                {
                  class: 'recentDrop',
                  'data-nav': '',
                  title: t('검색어 삭제'),
                  'aria-label': t('검색어 삭제'),
                  onclick: () => {
                    forgetSearch(q)
                    drawEmpty()
                  },
                },
                icon('close', 14),
              ),
            ),
          ),
        ),
      nothing(t('무엇을 찾을까요?'), 'search'),
    )
  }

  // ── Asking ───────────────────────────────────────────────────────────────

  /**
   * The query the rows on screen answer, so retyping it asks nothing. Cleared
   * when the answer was an error or nothing, so that Enter asks again.
   */
  let shown: string | null = null
  /** Which request is the latest; an older answer arriving late is dropped. */
  let generation = 0

  /**
   * One question, two answers, in one list.
   *
   * What is on the screen that matches comes first, because when you are
   * standing in a playlist that is usually what you meant; YouTube's answer
   * follows under its own heading. Neither has to be chosen, which was the
   * objection to tabs: "화면일지 전체일지 선택하게 할 거 아니면" (2026-09-04).
   */
  function onScreen(q: string): Track[] {
    const fold = (v: string) => v.toLowerCase().replace(/\s+/g, '')
    const needle = fold(q)
    return screenTracks().filter((tr) => fold(`${tr.title} ${tr.byline}`).includes(needle))
  }

  /**
   * Puts a query in the field and asks it at once, as a deliberate search.
   *
   * This is what a suggestion, a remembered query and the Enter key all do,
   * and it is the only path that remembers: the 350ms timer fires on every
   * pause in the typing, and remembering those would fill the list with the
   * halves of one word.
   */
  function ask(q: string): void {
    input.value = q
    clearTimeout(settle)
    clearTimeout(hint)
    hideSuggestions()
    rememberSearch(q)
    void run(q)
    input.focus()
  }

  async function run(raw: string): Promise<void> {
    const q = raw.trim()
    if (q === shown) return
    shown = q
    const token = ++generation
    if (!q) return drawEmpty()
    const hits = onScreen(q)
    const here = hits.length > 0 ? [mark(t('이 화면에서'), hits.length), ...answers({ tracks: hits, shelves: [], endpoint: 'search' }, true)] : []
    // The other kinds sit above the videos, not below them: the video list is
    // the long one, it grows by 더 보기, and anything under it would be a
    // scroll away from the moment it arrived.
    const kinds = h('div', { class: 'searchKinds' }, skRows(2))
    const there = h('div', { class: 'searchThere' }, skRows(4))
    replace(body, here, kinds, mark(t('유튜브 전체')), there)
    void fillKinds(kinds, q, token)
    try {
      const page = await api.search(ctx.cfg, q)
      if (token !== generation) return
      if (page.tracks.length === 0) {
        shown = null
        return replace(there, nothing(t('결과가 없습니다.'), 'search'))
      }
      replace(there, answers(page))
    } catch (err) {
      if (token !== generation) return
      shown = null
      replace(there, h('div', { class: 'err' }, explain(err)))
    }
  }

  /**
   * The playlists and channels, once they arrive.
   *
   * They are a section of their own rather than rows among the videos, so that
   * 전체 재생 still names a list of tracks. A section that found nothing is
   * removed entirely: an empty heading says less than nothing.
   */
  async function fillKinds(into: HTMLElement, q: string, token: number): Promise<void> {
    let found: api.Kinds
    try {
      found = await api.searchKinds(ctx.cfg, q)
    } catch {
      // Failing to find a playlist is not worth an error over an answer that
      // did arrive. The videos above stand on their own.
      found = { playlists: [], channels: [] }
    }
    if (closed || token !== generation) return
    const lists = found.playlists.slice(0, kindMax())
    const chans = found.channels.slice(0, kindMax())
    if (lists.length === 0 && chans.length === 0) return replace(into)
    // The heading names what actually arrived. A search that found no channel
    // must not stand under a heading promising one.
    const label = [lists.length > 0 && t('재생목록'), chans.length > 0 && t('채널')].filter(Boolean).join(' · ')
    replace(into, mark(label), lists.map(playlistRow), chans.map(channelRow))
  }

  /**
   * The subtitle a playlist row can afford.
   *
   * `parse.playlists` joins every metadata line the row carried, which on a
   * search result is the count, the channel, the word Playlist, and then a
   * preview of the first two tracks with their durations. That is a paragraph
   * in a 44px row. The first two parts are the count and whose list it is,
   * which is the whole of what anyone reads here.
   */
  function brief(subtitle: string): string {
    return subtitle.split(' · ').slice(0, 2).join(' · ')
  }

  /** One line for something that is not a track: artwork, two lines, no menu. */
  function kindRow(picture: HTMLElement, title: string, sub: string, open: () => void): HTMLElement {
    return h(
      'button',
      { class: 'kindRow', 'data-nav': '', onclick: open },
      picture,
      h('div', { class: 'meta' }, h('div', { class: 'ttl' }, title), sub && h('div', { class: 'sub' }, sub)),
    )
  }

  function playlistRow(p: Playlist): HTMLElement {
    return kindRow(art('thumb', p.cover), p.title, brief(p.subtitle), () => {
      rememberSearch(input.value)
      ctx.go({ kind: 'playlist', id: p.id, title: p.title })
      close()
    })
  }

  /**
   * A channel opens its own screen: the channel's videos, newest first, which
   * this player can queue and play. The row used to search for the name
   * instead, because there was no such screen; there is one now (views.ts).
   */
  function channelRow(c: ChannelHit): HTMLElement {
    const row = kindRow(art('avatar', c.avatar), c.title, c.subtitle, () => {
      rememberSearch(input.value)
      ctx.go({ kind: 'channel', id: c.id, title: c.title })
    })
    row.title = t('채널 열기')
    return row
  }

  /**
   * The rows, with the two things done to all of them above them.
   *
   * The whole list is what a row plays from, and 더 보기 grows that list in
   * place: asking for more mid-search should extend the queue you would have
   * got, not start a different one.
   *
   * The two actions are full-width lines, not a toolbar. The remote moves to
   * whatever is ahead and least to the side, weighted three to one, and a
   * button at the left of a toolbar under a field that spans the panel is
   * far more to the side than the first row is: the arrows stepped over the
   * toolbar every time, and 전체 재생 could not be reached without a pointer.
   * A line as wide as the field is straight ahead of it.
   */
  function answers(first: api.Page, fromScreen = false): HTMLElement[] {
    let page = first
    let all: Track[] = keep(first.tracks)
    const rows = h('div', { class: 'rows' })
    const more = h('button', { class: 'btn ghost', 'data-nav': '', style: 'margin: 16px auto 0; display: flex' }, t('더 보기'))

    const play = (i: number) => {
      // Playing something is the strongest evidence the query was meant, and
      // the only one a phone gives: nobody presses Enter on a touch keyboard.
      rememberSearch(input.value)
      // A hit on the queue screen is a jump within the queue, not a new one.
      const inQueue = fromScreen ? ctx.engine.state.queue.findIndex((tr) => tr.videoId === all[i]?.videoId) : -1
      if (inQueue >= 0 && ctx.view.kind === 'queue') ctx.engine.play(ctx.engine.state.queue, inQueue)
      else ctx.engine.play(all, i)
      close()
    }
    /** Appends the rows not yet drawn; the ones already there are kept. */
    let drawn = 0
    const draw = () => {
      more.remove()
      for (let i = drawn; i < all.length; i++) {
        const track = all[i]!
        rows.appendChild(row(ctx, track, { onPlay: () => play(i), quick: addQuick(ctx, track) }))
      }
      drawn = all.length
      if (page.continuation) rows.appendChild(more)
    }
    more.addEventListener('click', async () => {
      const waiting = Array.from({ length: 4 }, () => skRow())
      more.remove()
      rows.append(...waiting)
      const hadFocus = ctx.overlay.activeElement === more
      try {
        const next = await api.more(ctx.cfg, page)
        if (closed) return
        for (const el of waiting) el.remove()
        const firstNew = all.length
        all = keep(all.concat(next.tracks))
        page = next
        draw()
        // The button that was pressed is gone from under the focus; the first
        // of what it fetched is where that focus meant to go.
        if (hadFocus) (rows.children[firstNew] as HTMLElement | undefined)?.focus({ preventScroll: true })
      } catch (err) {
        ctx.say(explain(err), true)
        for (const el of waiting) el.remove()
        rows.appendChild(more)
      }
    })
    draw()

    // Hits on the queue screen are already in the queue; offering to add
    // them again would be a line that does nothing.
    const onQueue = fromScreen && ctx.view.kind === 'queue'
    const lines: Array<HTMLElement | null> = [
      h('button', { class: 'searchAct', 'data-nav': '', onclick: () => play(0) }, icon('play', 18), h('span', null, t('전체 재생')), h('span', { class: 'sub' }, tn('곡', all.length))),
      onQueue ? null :
      h(
        'button',
        {
          class: 'searchAct',
          'data-nav': '',
          onclick: () => {
            rememberSearch(input.value)
            ctx.engine.enqueue(all)
            ctx.say(`${tn('곡', all.length)} · ${t('대기열에 넣었습니다.')}`)
          },
        },
        icon('plus', 18),
        h('span', null, t('대기열에 추가')),
      ),
      rows,
    ]
    return lines.filter((el): el is HTMLElement => el !== null)
  }

  // As you type: suggestions on the short timer, the search itself on the long
  // one. Two timers rather than one, because they are two different waits:
  // the suggestion is meant to land mid-word and the search is not.
  input.addEventListener('input', () => {
    clearTimeout(settle)
    clearTimeout(hint)
    const typed = input.value.trim()
    if (!typed) hideSuggestions()
    else hint = setTimeout(() => void askSuggestions(typed), SUGGEST_MS)
    settle = setTimeout(() => void run(input.value), SETTLE_MS)
  })
  input.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return
    ask(input.value)
  })

  ctx.overlay.appendChild(scrim)
  document.addEventListener('keydown', onEscape, true)
  input.focus()
  if (query.trim()) void run(query)
  else drawEmpty()
}
