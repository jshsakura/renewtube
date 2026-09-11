// The screens. Each one renders into a container it is given and owns its own
// loading, so a slow request never blocks the player bar or the sidebar.

import { t, tn } from '../../shared/i18n.ts'
import * as api from '../api.ts'
import { thumbnail, type Playlist, type Shelf, type Track } from '../parse.ts'
import { forgetHistory, hideChannel, history, isChannelHidden, setSubsFilter, subsFilter } from '../store.ts'
import { KIDS, LEARNING_FEED, MENU, topicTitle } from '../menu.ts'
import { art, h, icon, replace } from './dom.ts'
import { makeDraggable, shelfArrows } from './drag.ts'
import { explain, isSignedOut, type Ctx, type View } from './ctx.ts'
import { confirm, showMenu, toast } from './overlay.ts'
import { removeFromPlaylistNow, row, shareTrack, startRadio } from './rows.ts'
import { applyFilter, channelsOf, chooseChannels } from './channels.ts'
import { makeSortable } from './sortable.ts'

/**
 * Which render is the one on screen.
 *
 * Every screen here draws a skeleton, waits for YouTube, and then writes the
 * answer into `main`. Nothing stopped a *slow* screen from writing its answer
 * after the reader had already moved on: open 둘러보기, press 대기열 before it
 * lands, and the queue is drawn — and then the explore fetch finishes and puts
 * itself, or its error, on top of it. The reader sees a screen they left, or
 * "가져오지 못했습니다" over a queue that arrived perfectly well.
 *
 * A number rather than a comparison of views, because `reload()` re-renders
 * the same view on purpose and the older of two renders of one screen still
 * has to lose.
 */
let generation = 0

/** The tracks the current screen is showing, for a search of this screen. */
let shown: Track[] = []
export function screenTracks(): Track[] {
  return shown
}

/** Whether the render holding this token is still the one being awaited. */
function current(token: number): boolean {
  return token === generation
}

/** Draws `view` into `main`. Returns once the first paint is done. */
export async function render(ctx: Ctx, main: HTMLElement): Promise<void> {
  generation += 1
  shown = []
  const view = ctx.view
  switch (view.kind) {
    case 'explore':
      return explore(ctx, main)
    case 'home':
      return listFeed(ctx, main, t('홈'), 'FEwhat_to_watch')
    case 'subs':
      return listFeed(ctx, main, t('구독'), 'FEsubscriptions')
    case 'history':
      return watched(ctx, main)
    case 'playlists':
      return playlists(ctx, main)
    case 'playlist':
      return playlist(ctx, main, view.id, view.title)
    case 'queue':
      return queue(ctx, main)
    case 'topic':
      return topic(ctx, main, view.id)
    case 'channels':
      return channelList(ctx, main)
    case 'channel':
      return channelVideos(ctx, main, view.id, view.title)
    case 'myvideos':
      return listFeed(ctx, main, t('내 동영상'), 'FEmy_videos')
  }
}

/**
 * An empty screen, with a mark above the sentence.
 *
 * A line of grey text in the middle of a blank panel reads as something that
 * failed to load. A glyph says the screen arrived and there is nothing in it.
 */
export function nothing(text: string, glyph: Parameters<typeof icon>[0] = 'note'): HTMLElement {
  return h('div', { class: 'empty' }, icon(glyph, 34), h('div', null, text))
}

/**
 * Several lists as one, one row per video, the earlier list winning.
 *
 * The lists handed here are each already newest first, so keeping the first
 * copy of a video keeps the whole thing newest first as well.
 */
function mergeById(...lists: Track[][]): Track[] {
  const seen = new Set<string>()
  const out: Track[] = []
  for (const track of lists.flat()) {
    if (seen.has(track.videoId)) continue
    seen.add(track.videoId)
    out.push(track)
  }
  return out
}

/**
 * A list that can ask YouTube for more of itself.
 *
 * The whole list, not just the visible page, is what a row plays from — asking
 * for more mid-listen should extend the queue you would have got, not start a
 * different one — so the array is held here and the play handler closes over it.
 */
function listOf(ctx: Ctx, first: api.Page, shape: Shape = feedShape(ctx), lead: Track[] = []): HTMLElement {
  const rows = h('div', { class: 'rows' })
  let page = first
  let all = keep(mergeById(lead, first.tracks))

  const more = h('button', { class: 'btn ghost', 'data-nav': '', style: 'margin: 16px auto 0; display: flex' }, t('더 보기'))
  more.addEventListener('click', async () => {
    // The next page arrives as more of the same, so it is awaited as more of
    // the same: the button steps aside and the rows it is about to fetch stand
    // there in outline. A button relabelled "가져오는 중…" says a wait is
    // happening somewhere; this says where, and how much.
    const waiting = shape === 'grid'
      ? Array.from({ length: 6 }, () => skTile())
      : Array.from({ length: 4 }, () => skRow())
    more.remove()
    rows.append(...waiting)
    try {
      const next = await api.more(ctx.cfg, page)
      // Through the same sieve as the first page: a video already standing
      // above, because this browser played it, must not arrive again below.
      all = keep(mergeById(all, next.tracks))
      page = next
      // draw() replaces the whole container, skeletons included.
      draw()
    } catch (err) {
      ctx.say(explain(err), true)
      for (const el of waiting) el.remove()
      rows.appendChild(more)
    }
  })

  function draw(): void {
    layout(ctx, rows, all, (track) => ({ quick: addQuick(ctx, track) }), shape)
    if (page.continuation) rows.appendChild(more)
  }

  draw()
  return rows
}

/**
 * Draws a list of tracks the way the current mode wants it: a track list in
 * music mode, a wall of thumbnails in video mode.
 */
/**
 * Cards or rows, decided in one place.
 *
 * **홈 is cards whatever the mode.** It is YouTube's own recommendation feed
 * and it is video-shaped by definition: podcasts, uploads, whatever the
 * account attracts. Drawn as a numbered list with running times beside a 전체
 * 재생 button, it read as an album, and a forty-minute video sat in it looking
 * like track four. The other feeds keep following the mode, because 구독 and
 * 시청 기록 are whatever the person put in them and the mode is the person
 * saying which of the two they are here for. 둘러보기 is music by decision and is
 * drawn elsewhere.
 *
 * Not guessed from the tracks. There is no honest signal in a row for whether
 * it is music, and a heuristic on duration or channel would be wrong often and
 * silently. Which screen this is, is known.
 */
export type Shape = 'grid' | 'rows'

function feedShape(ctx: Ctx, id?: api.FeedId): Shape {
  if (id === 'FEwhat_to_watch') return 'grid'
  return ctx.engine.state.mode === 'video' ? 'grid' : 'rows'
}

function layout(
  ctx: Ctx,
  into: HTMLElement,
  list: Track[],
  extraFor: (t: Track) => Pick<Parameters<typeof row>[2], 'extra' | 'quick'>,
  shape: Shape = feedShape(ctx),
): void {
  const asGrid = shape === 'grid'
  into.className = asGrid ? 'grid' : 'rows'
  shown = list
  followNowPlaying(ctx, into)
  replace(
    into,
    asGrid
      ? list.map((_, i) => trackTile(ctx, list, i))
      : list.map((track, i) =>
          row(ctx, track, {
            index: i + 1,
            // Where the track *is* when pressed, not where it was when drawn:
            // a list that has had a row taken out of it has moved on.
            onPlay: () => {
              const at = list.indexOf(track)
              ctx.engine.play(list, at < 0 ? i : at)
            },
            ...extraFor(track),
          }),
        ),
  )
}

/** Containers already watching the queue, so a redraw does not stack listeners. */
const following = new WeakSet<HTMLElement>()

/**
 * Keeps the playing mark on the row that is actually playing.
 *
 * It used to be decided once, while the list was being built, and never again:
 * press a second track and the bar changed while the list went on pointing at
 * the first. On a search for one artist — where every row is a plausible
 * answer — that is the screen telling you it is playing something it is not.
 *
 * Repainted rather than redrawn, because a list is a place someone is reading
 * and scrolling; rebuilding it under them to move three bars would be a
 * heavier answer than the question deserves.
 */
function followNowPlaying(ctx: Ctx, into: HTMLElement): void {
  if (following.has(into)) return
  following.add(into)
  let marked: string | undefined | null = null
  const paint = (): void => {
    const id = ctx.engine.current?.videoId
    if (id === marked) return
    marked = id
    let n = 0
    for (const el of Array.from(into.children)) {
      if (!el.classList.contains('row')) continue
      n += 1
      const rowEl = el as HTMLElement
      const playing = rowEl.dataset.id !== undefined && rowEl.dataset.id === id
      rowEl.classList.toggle('now', playing)
      const idx = rowEl.querySelector<HTMLElement>('.idx')
      // The number gives way to the bars, and comes back when it is over.
      if (idx) replace(idx, playing ? h('span', { class: 'eq' }, h('i'), h('i'), h('i')) : String(n))
    }
  }
  paint()
  const off = ctx.engine.subscribe(() => {
    if (!into.isConnected) return off()
    paint()
  })
}

/**
 * Redraws when the mode changes, from the data already in hand.
 *
 * Switching between a list and a grid is a layout change, and asking YouTube
 * for the same rows again to perform one is both slow and rude. The
 * subscription unhooks itself the first time it fires after its element has
 * left the document, so a screen that has been navigated away from stops
 * listening without anyone having to remember to say so.
 */
/**
 * One card. The same component for a video and for a playlist, except for the
 * shape of the artwork: a playlist or an album is square, the way every music
 * app draws a cover, and a video keeps the 16:9 of its thumbnail.
 */
/**
 * Loading, drawn as the shape of what is coming. A skeleton borrows the real
 * layout classes and puts grey blocks inside them, so when the data lands the
 * screen does not change shape — it fills in.
 */
/**
 * The outline of one row, in the shape a row actually has.
 *
 * **It has to carry .rowInner.** A row became two columns when the swipe went
 * in, the content in one and the actions in the other, and this outline kept
 * emitting the old flat children straight into that grid. They landed in the
 * wrong tracks and stacked: measured 2026-09-04, an outlined row stood 84px
 * against a real one's 60px, so every feed dropped 24px per row, six rows at a
 * time, the instant its data arrived. An outline whose whole job is to hold
 * the shape was the thing changing it.
 */
export function skRow(): HTMLElement {
  return h(
    'div',
    { class: 'row', 'aria-hidden': 'true' },
    h(
      'div',
      { class: 'rowInner' },
      h('div', { class: 'idx sk', style: 'width: 14px; height: 8px; justify-self: end' }),
      h('div', { class: 'thumb sk' }),
      h('div', { class: 'meta' },
        h('div', { class: 'sk', style: 'height: 10px; width: 62%; margin-bottom: 6px' }),
        h('div', { class: 'sk', style: 'height: 8px; width: 38%' })),
      h('div', { class: 'dur sk', style: 'width: 34px; height: 8px' }),
    ),
    // The strip the quick button and the menu sit in. Empty, but it holds the
    // width they will take, so the title does not shorten when they arrive.
    h('div', { class: 'rowActions' },
      h('div', { class: 'sk', style: 'width: 18px; height: 18px; border-radius: 6px' }),
      h('div', { class: 'sk', style: 'width: 18px; height: 18px; border-radius: 6px' })),
  )
}

/**
 * The outline of one card, in the box a card actually occupies.
 *
 * The title and subtitle wear the card's own classes rather than free-floating
 * bars, because .tile .t keeps two lines of room whether the title needs them
 * or not, and an outline that did not reserve them stood 259px against a real
 * card's 295px: measured 2026-09-04, every card in 영상 mode grew 36px the
 * moment its data landed.
 */
function skTile(): HTMLElement {
  return h(
    'div',
    { class: 'tile', style: 'background: none', 'aria-hidden': 'true' },
    h('div', { class: 'cover sk' }),
    // Inline, so the line box comes from the font the real text will use.
    // As blocks the bars *were* the height, and .s came out 11px short of the
    // 13px line it stands in.
    h('div', { class: 't' }, h('span', { class: 'sk skLine', style: 'height: 10px; width: 80%' })),
    h('div', { class: 's' }, h('span', { class: 'sk skLine', style: 'height: 8px; width: 55%' })),
  )
}

export function skShelf(): HTMLElement {
  return h(
    'section',
    { class: 'shelf', 'aria-hidden': 'true' },
    h('div', { class: 'sk', style: 'height: 12px; width: 180px; margin: 0 0 14px' }),
    h('div', { class: 'shelfRow' }, Array.from({ length: 6 }, () => skTile())),
  )
}

export function skHead(): HTMLElement {
  return h(
    'div',
    { class: 'head', 'aria-hidden': 'true' },
    h('div', { class: 'cover sk' }),
    h('div', { style: 'min-width: 0' },
      h('div', { class: 'sk', style: 'height: 8px; width: 60px; margin-bottom: 10px' }),
      h('div', { class: 'sk', style: 'height: 34px; width: 46%; margin-bottom: 12px' }),
      h('div', { class: 'sk', style: 'height: 8px; width: 90px' })),
  )
}

export function skRows(n: number): HTMLElement {
  return h('div', { class: 'rows' }, Array.from({ length: n }, () => skRow()))
}

/**
 * The buttons a screen is about to draw, as outlines the same size.
 *
 * **Sized by the words themselves, not by a number.** These used to be two
 * fixed widths, and a button is as wide as its label: 104px and 124px against
 * the 114px and 140px the Korean ones actually take, and no relation at all to
 * the fourteen other languages this ships in. So the real label goes in,
 * hidden, and the button box is what gets painted. It costs nothing and it
 * cannot drift.
 */
function skToolbar(...labels: string[]): HTMLElement {
  return h(
    'div',
    { class: 'toolbar', 'aria-hidden': 'true' },
    // The glyph's room as well as the word's: .btn lays out icon, gap, label,
    // and an outline with only the label came out 24px short of the button
    // that replaced it.
    labels.map((label) =>
      h('div', { class: 'btn skBtn' }, h('span', { class: 'skBtnIcon' }), h('span', null, label)),
    ),
  )
}

/** The outline of a playlist row, which is not the shape a track row is. */
function skPlaylistRow(): HTMLElement {
  return h(
    'div',
    { class: 'playlistCard', 'aria-hidden': 'true' },
    h('div', { class: 'playlistCover sk' }),
    h('div', { class: 'meta' },
      h('div', { class: 'sk', style: 'height: 10px; width: 54%; margin-bottom: 6px' }),
      h('div', { class: 'sk', style: 'height: 8px; width: 26%' })),
    h('div', { class: 'sk', style: 'width: 12px; height: 12px; justify-self: end' }),
  )
}

function skPlaylistRows(n: number): HTMLElement {
  return h('div', { class: 'playlistGrid' }, Array.from({ length: n }, () => skPlaylistRow()))
}

/**
 * A feed's outline, in the shape that feed is about to take.
 *
 * It asks feedShape, the same function the screen asks. The two used to decide
 * separately and that is exactly how they drift: measured 2026-09-04, outlined
 * rows stood 84px against real ones at 60px and outlined cards 259px against
 * 295px, so every feed changed height the moment its data landed.
 */
function skFeed(ctx: Ctx, id: api.FeedId): HTMLElement {
  return feedShape(ctx, id) === 'grid'
    ? h('div', { class: 'grid' }, Array.from({ length: 6 }, () => skTile()))
    : skRows(6)
}

/** The overlay the tile menus anchor into, set whenever a track tile is built. */
let rootOverlay: ShadowRoot

/**
 * What a feed should actually draw: not from a hidden channel, and not
 * unplayable.
 *
 * The owner's two asks in one sieve — 채널 추천 안 함 blocks a channel, and a
 * track YouTube already says cannot play (region-locked, private, removed,
 * members-only: `unavailable` from the parser) is not worth a card you can
 * only bounce off ("내가 재생 못하는건 목록으로 그릴 필요가 없지"). Applied to
 * every browse feed and shelf; the queue and a saved playlist keep their own
 * rows, since a dead item there is the reader's to see and the playing one
 * must never vanish under them.
 */
export function keep(tracks: Track[]): Track[] {
  return tracks.some((tr) => tr.unavailable || isChannelHidden(tr.channelId))
    ? tracks.filter((tr) => !tr.unavailable && !isChannelHidden(tr.channelId))
    : tracks
}

function tile(opts: {
  cover?: string
  title: string
  sub: string
  /** Drawn on the artwork: a running time, a track count. */
  badge?: string
  square?: boolean
  /** The one-press action, drawn on the artwork. Cards had none. */
  quick?: { icon: Parameters<typeof icon>[0]; title: string; run(): void }
  /** The options behind a ⋯ on the artwork, opposite the quick action. */
  menu?: () => Array<Parameters<typeof showMenu>[2][number]>
  onOpen(): void
}): HTMLElement {
  const card = h(
    'div',
    {
      class: opts.square ? 'tile square' : 'tile',
      'data-nav': '',
      role: 'button',
      tabindex: '0',
      onclick: opts.onOpen,
    },
    art(
      'cover',
      opts.cover,
      !opts.cover && icon('note', 26),
      opts.badge && h('span', { class: 'badge' }, opts.badge),
      h('span', { class: 'play' }, icon('play', 20)),
      // A single action dock. The old pair lived in opposite corners as two
      // unrelated 30px spots; on a 148px phone cover they were both cramped
      // and visually ambiguous. Keeping them together gives each action a
      // proper touch target without scattering controls over the poster.
      (opts.quick || opts.menu) && h(
        'span',
        { class: 'tileActions', role: 'group', 'aria-label': t('빠른 작업') },
        // On the artwork, because a card has no spare row and this is the thing
        // the product is for. Without it, filing a track was possible from a
        // list and impossible from a card — which is every shelf on 둘러보기 and
        // every screen in 영상 mode.
        opts.quick &&
          (() => {
            const b = h(
              'button',
              // data-nav, or the arrow keys never reach it. This is a real
              // button rather than an interactive span inside a button-shaped
              // card: iOS WebKit occasionally retargeted that invalid nested
              // interaction to the card and loaded the video instead of the
              // action (2026-09-11, "더보기 누르면 로드를 못하거나").
              { class: 'tileAdd', 'data-nav': '', title: opts.quick!.title, 'aria-label': opts.quick!.title },
              icon(opts.quick!.icon, 17),
            )
            const go = (ev: Event) => {
              ev.stopPropagation()
              ev.preventDefault()
              opts.quick!.run()
            }
            b.addEventListener('click', go)
            return b
          })(),
        // The menu carries play-next, radio and curation actions that cannot
        // all fit on a card. It shares the dock, but keeps its own focus and
        // hit target so the two commands never become one vague button.
        opts.menu &&
          (() => {
            const b = h(
              'button',
              { class: 'tileMenu', 'data-nav': '', title: t('옵션'), 'aria-label': t('옵션') },
              icon('more', 17),
            )
            const openIt = (ev: Event) => {
              ev.stopPropagation()
              ev.preventDefault()
              showMenu(rootOverlay, b, opts.menu!(), opts.title)
            }
            b.addEventListener('click', openIt)
            return b
          })(),
      ),
    ),
    h('div', { class: 't', title: opts.title }, opts.title),
    h('div', { class: 's' }, opts.sub),
  )
  return card
}

function trackTile(ctx: Ctx, list: Track[], i: number): HTMLElement {
  const track = list[i]!
  rootOverlay = ctx.overlay
  return tile({
    cover: thumbnail(track.videoId),
    title: track.title,
    sub: track.byline,
    badge: track.duration,
    quick: { icon: 'plus', title: t('재생목록에 넣기'), run: () => void ctx.addToPlaylist([track]) },
    menu: () => tileMenu(ctx, track),
    onOpen: () => ctx.engine.play(list, i),
  })
}

/** The card's ⋯ menu: the row's actions, plus the two curation choices. */
function tileMenu(ctx: Ctx, track: Track): Array<Parameters<typeof showMenu>[2][number]> {
  return [
    { label: t('지금 재생'), icon: 'play', onSelect: () => ctx.engine.playNow([track]) },
    { label: t('다음에 재생'), icon: 'queue', onSelect: () => { ctx.engine.playNext([track]); ctx.say(t('다음에 재생합니다.')) } },
    { label: t('대기열에 추가'), icon: 'plus', onSelect: () => { ctx.engine.enqueue([track]); ctx.say(t('대기열에 넣었습니다.')) } },
    '-',
    { label: t('이 곡으로 라디오'), icon: 'radio', onSelect: () => void startRadio(ctx, track) },
    { label: t('재생목록에 추가'), icon: 'library', onSelect: () => void ctx.addToPlaylist([track]) },
    '-',
    // Feeds YouTube's own recommendations; the same call the bar's 관심 없음 makes.
    { label: t('관심 없음'), icon: 'thumbDown', onSelect: () => { void api.dislike(ctx.cfg, track.videoId).catch(() => {}); ctx.say(t('관심 없음으로 표시했습니다.')) } },
    // A local block within RenewTube, reversible from 설정.
    ...(track.channelId
      ? [{ label: t('채널 추천 안 함'), icon: 'close' as const, onSelect: () => hideChannelAndRefresh(ctx, track) }]
      : []),
    '-',
    { label: t('공유'), icon: 'share', onSelect: () => void shareTrack(ctx, track) },
    { label: t('유튜브에서 열기'), icon: 'external', onSelect: () => window.open(`https://www.youtube.com/watch?v=${track.videoId}`, '_blank') },
  ]
}

/** Blocks the track's channel and redraws so its cards leave at once. */
function hideChannelAndRefresh(ctx: Ctx, track: Track): void {
  if (!track.channelId) return
  hideChannel(track.channelId)
  toast(ctx.overlay, `${track.byline} · ${t('채널을 숨겼습니다.')}`)
  ctx.reload()
}

function playlistTile(ctx: Ctx, p: Playlist): HTMLElement {
  return tile({
    cover: p.cover,
    title: p.title,
    sub: p.subtitle,
    square: true,
    onOpen: () => ctx.go({ kind: 'playlist', id: p.id, title: p.title }),
  })
}

/** How close to the row's end, in cards, before the rest is asked for. */
const SHELF_AHEAD_TILES = 3

/**
 * A titled row that scrolls sideways, and fetches the rest of itself.
 *
 * The television hands a row over five cards at a time (see Shelf.continuation
 * in parse.ts), so a row is drawn from what came and then kept fed: at once
 * while it does not yet overflow its pane, and again whenever the scroll
 * comes within a few cards of the end. The tracks are held in one growing
 * array and every card plays from it, so a card pressed early still queues the
 * cards that arrived after it. Nothing is asked for a row that came whole.
 */
function shelfRow(ctx: Ctx, shelf: Shelf, client: api.Page['client'] = 'page'): HTMLElement {
  const tracks = keep(shelf.tracks)
  let token = shelf.continuation
  const row = h(
    'div',
    // Exposes the server's answer, not a visual state. The browser harness can
    // then distinguish a row that failed to fetch from one YouTube genuinely
    // ended after six or nine cards; both occur in the same live TV feed.
    { class: 'shelfRow', 'data-more': token ? 'true' : 'false' },
    shelf.playlists.map((p) => playlistTile(ctx, p)),
    tracks.map((_, i) => trackTile(ctx, tracks, i)),
  )
  // A mouse can pull the row sideways or turn the wheel on it; a finger always
  // could. The arrows are what say so.
  makeDraggable(row)
  const section = h('section', { class: 'shelf' }, shelf.title && h('h3', null, shelf.title), row, ...shelfArrows(row))

  let busy = false
  const nearEnd = () => {
    const tile = row.querySelector<HTMLElement>('.tile')
    const ahead = (tile?.offsetWidth ?? 176) * SHELF_AHEAD_TILES
    return row.scrollLeft + row.clientWidth > row.scrollWidth - ahead
  }
  const feed = async (): Promise<void> => {
    if (!token || busy || !row.isConnected) return
    busy = true
    const waiting = Array.from({ length: 3 }, () => skTile())
    row.append(...waiting)
    let fillAgain = false
    try {
      const next = await api.moreShelf(ctx.cfg, token, client)
      token = next.continuation
      row.dataset.more = token ? 'true' : 'false'
      const from = tracks.length
      const fresh = keep(next.tracks)
      tracks.push(...fresh)
      for (const el of waiting) el.remove()
      row.append(...next.playlists.map((p) => playlistTile(ctx, p)), ...fresh.map((_, i) => trackTile(ctx, tracks, from + i)))
      // Five more may still not reach the edge of a wide pane. Record this
      // while the geometry is current, then ask only after `busy` is cleared;
      // calling feed() here used to return immediately on its own guard and a
      // fresh wide screen stopped after exactly one continuation.
      fillAgain = !!token && row.isConnected && nearEnd()
    } catch {
      // The row keeps what it has; the next scroll asks again.
      for (const el of waiting) el.remove()
    } finally {
      busy = false
      if (fillAgain) void feed()
    }
  }
  if (token) {
    row.addEventListener('scroll', () => nearEnd() && void feed(), { passive: true })
    // Once the row has a size: a section built off-screen measures 0 wide.
    requestAnimationFrame(() => nearEnd() && void feed())
  }
  return section
}

/**
 * The button every ordinary row carries: put this track somewhere.
 *
 * It files into the last playlist chosen, and only asks when there is no last
 * one — which makes the first add two presses and every one after it a single
 * press. The title names the destination, so a button that files silently
 * still says where.
 */
export function addQuick(ctx: Ctx, track: Track): Parameters<typeof row>[2]['quick'] {
  return {
    icon: 'plus',
    title: t('재생목록에 넣기'),
    // Opens the picker rather than filing silently.
    //
    // It used to drop the track into whichever list was used last, which is
    // one press and the wrong one: on somebody else's playlist — where most
    // collecting actually happens — the whole point is choosing *which* of
    // your lists this belongs in, or making a new one for it. The picker is
    // also the only place a playlist can be created, so hiding it behind the
    // last choice made "start a new list from this song" unreachable from the
    // song.
    run: () => void ctx.addToPlaylist([track]),
  }
}

// ── Explore ────────────────────────────────────────────────────────────────

async function explore(ctx: Ctx, main: HTMLElement): Promise<void> {
  return shelfScreen(ctx, main, t('음악'), () => api.explore(ctx.cfg), 'radio')
}

/**
 * A screen made of shelves: 음악, and the television's genres.
 *
 * One drawing for all of them, because the shape is one shape. The title is
 * up first with two outlines under it, the answer replaces them, and a feed
 * that came back as a flat list rather than as rows is laid out as a grid.
 */
async function shelfScreen(ctx: Ctx, main: HTMLElement, title: string, load: () => Promise<api.Page>, glyph: Parameters<typeof icon>[0]): Promise<void> {
  const token = generation
  replace(main, h('h2', null, title), skShelf(), skShelf())
  try {
    const page = await load()
    if (!current(token)) return
    if (page.shelves.length === 0 && page.tracks.length === 0) {
      return replace(main, h('h2', null, title), nothing(t('보여줄 것이 없습니다.'), glyph))
    }
    const shelvesBox = h('div', { class: 'shelves' }, page.shelves.map((shelf) => shelfRow(ctx, shelf, page.client)))
    replace(
      main,
      h('h2', null, title),
      shelvesBox,
      page.shelves.length === 0 && (() => { const g = keep(page.tracks); return h('div', { class: 'grid' }, g.map((_, i) => trackTile(ctx, g, i))) })(),
      // The rows below the fold, a page at a time. The television's list
      // carries a token for more shelves, and a screen that stopped at the
      // first four read as a short one.
      page.continuation && moreShelvesButton(ctx, page, shelvesBox, token),
    )
  } catch (err) {
    if (!current(token)) return
    replace(main, h('h2', null, title), h('div', { class: 'err' }, explain(err)))
  }
}

/** 더 보기 under a television page: appends the next rows and steps aside when there are none. */
function moreShelvesButton(ctx: Ctx, first: api.Page, box: HTMLElement, token: number): HTMLElement {
  let page = first
  const more = h('button', { class: 'btn ghost', 'data-nav': '', style: 'margin: 16px auto 0; display: flex' }, t('더 보기'))
  more.addEventListener('click', async () => {
    const waiting = [skShelf(), skShelf()]
    more.remove()
    box.append(...waiting)
    try {
      const next = await api.moreShelves(ctx.cfg, page)
      if (!current(token)) return
      page = next
      for (const el of waiting) el.remove()
      box.append(...next.shelves.map((shelf) => shelfRow(ctx, shelf, next.client)))
      // A continuation is the server saying there is another page. Keep the
      // control even when this particular response contains no recognised
      // shelf; otherwise one sparse/changed response permanently strands the
      // rest of the screen with no way to ask again.
      if (next.continuation) box.after(more)
    } catch (err) {
      if (!current(token)) return
      ctx.say(explain(err), true)
      for (const el of waiting) el.remove()
      box.after(more)
    }
  })
  return more
}

// ── The television's menu ─────────────────────────────────────────────────

/**
 * 아동, 스포츠, 생방송, 게임, 뉴스, 학습: one screen each, by the feed named in
 * menu.ts. The kids screen is curated in api.ts because YouTube has no feed
 * for it; the others are the television's own, asked as the television.
 */
async function topic(ctx: Ctx, main: HTMLElement, id: string): Promise<void> {
  const title = t(topicTitle(id))
  const line = MENU.find((l) => l.view.kind === 'topic' && l.view.id === id)
  const glyph = (line?.icon ?? 'radio') as Parameters<typeof icon>[0]
  if (id === KIDS) return shelfScreen(ctx, main, title, () => api.kids(ctx.cfg), glyph)
  if (id === LEARNING_FEED) return shelfScreen(ctx, main, title, () => api.learning(ctx.cfg, id), glyph)
  return shelfScreen(ctx, main, title, () => api.topic(ctx.cfg, id), glyph)
}

/** 채널: the channels this account subscribes to, one card each. */
async function channelList(ctx: Ctx, main: HTMLElement): Promise<void> {
  const token = generation
  const title = t('채널')
  replace(main, h('h2', null, title), skShelf())
  try {
    const list = await api.subscribedChannels(ctx.cfg)
    if (!current(token)) return
    if (list.length === 0) return replace(main, h('h2', null, title), nothing(t('구독한 채널이 없습니다.'), 'channels'))
    replace(
      main,
      h('h2', null, title),
      h(
        'div',
        { class: 'grid' },
        list.map((ch) =>
          tile({
            cover: ch.avatar,
            title: ch.title,
            sub: ch.subtitle,
            square: true,
            onOpen: () => ctx.go({ kind: 'channel', id: ch.id, title: ch.title }),
          }),
        ),
      ),
    )
  } catch (err) {
    if (!current(token)) return
    replace(main, h('h2', null, title), h('div', { class: 'err' }, explain(err)))
  }
}

/** One channel's videos, newest first, with the two things done to all of them above. */
async function channelVideos(ctx: Ctx, main: HTMLElement, id: string, title: string): Promise<void> {
  const token = generation
  replace(main, h('h2', null, title), skToolbar(t('전체 재생'), t('대기열에 추가')), skShelf())
  try {
    const page = await api.channelVideos(ctx.cfg, id)
    if (!current(token)) return
    if (page.tracks.length === 0) return replace(main, h('h2', null, title), nothing(t('보여줄 것이 없습니다.'), 'channels'))
    const all = keep(page.tracks)
    replace(
      main,
      h('h2', null, title),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn primary', 'data-nav': '', onclick: () => ctx.engine.play(all, 0) }, icon('play', 16), t('전체 재생')),
        h('button', { class: 'btn', 'data-nav': '', onclick: () => { ctx.engine.enqueue(all); ctx.say(`${tn('개', all.length)} · ${t('대기열에 넣었습니다.')}`) } }, icon('plus', 16), t('대기열에 추가')),
      ),
      h('div', { class: 'grid' }, all.map((_, i) => trackTile(ctx, all, i))),
    )
  } catch (err) {
    if (!current(token)) return
    replace(main, h('h2', null, title), h('div', { class: 'err' }, explain(err)))
  }
}

// ── Feeds ──────────────────────────────────────────────────────────────────

async function listFeed(ctx: Ctx, main: HTMLElement, title: string, id: api.FeedId): Promise<void> {
  const token = generation
  // The shape this screen actually lands in, which is not the shape it used to.
  //
  // A feed leads with its own items now — the flat grid that is your
  // subscriptions — and keeps YouTube's injected shelves underneath. The
  // skeleton was still promising two horizontal shelves, so the screen changed
  // shape when the data arrived instead of filling in, which is the one thing
  // these outlines exist to prevent. The toolbar is drawn too: it is what
  // pushes everything below it down.
  // The same buttons this screen is about to have, 구독 included: its channel
  // filter is a third one, and an outline that promised two put it in later.
  replace(
    main,
    h('h2', null, title),
    id === 'FEsubscriptions'
      ? skToolbar(t('전체 재생'), t('대기열에 추가'), t('채널'))
      : skToolbar(t('전체 재생'), t('대기열에 추가')),
    skFeed(ctx, id),
  )
  try {
    const page = await api.feed(ctx.cfg, id)
    if (!current(token)) return
    if (page.tracks.length === 0) {
      // A dead end otherwise, and 영상 mode lands here on purpose: YouTube's
      // home is empty until it knows you, so a session with no watch history
      // gets this screen and nothing to press. 둘러보기 always has something.
      return replace(
        main,
        h('h2', null, title),
        nothing(t('보여줄 것이 없습니다.'), 'home'),
        h(
          'div',
          { class: 'toolbar', style: 'justify-content: center' },
          h('button', { class: 'btn primary', 'data-nav': '', onclick: () => ctx.go({ kind: 'explore' }) }, icon('radio', 16), t('음악')),
          h('button', { class: 'btn', 'data-nav': '', onclick: () => ctx.search() }, icon('search', 16), t('검색')),
        ),
      )
    }
    // The feed *and* its shelves, in that order — never the shelves instead of
    // the feed.
    //
    // YouTube injects rows of its own into a personal feed: a recommendation
    // shelf sits in the middle of your subscriptions, and the subscriptions
    // themselves are the loose grid around it. This screen used to draw the
    // shelves the moment one existed and drop the grid entirely, so 구독 came
    // out as a single sideways row of videos from channels nobody had
    // subscribed to — the feed was parsed, then thrown away. Measured
    // 2026-09-04: signed in, the response is a richGridRenderer of the
    // subscriptions with one richShelfRenderer injected beside it.
    //
    // The shelf keeps its place under the feed, because a feed that came with
    // titled rows does carry editorial structure and flattening it would lose
    // that. What it must not do is speak for the whole screen.
    //
    // Minus the tracks the shelves already hold: parseTracks collects those
    // too, and a video should not be on one screen twice.
    const shelved = new Set(page.shelves.flatMap((s) => s.tracks.map((tr) => tr.videoId)))
    const loose = keep(page.tracks.filter((tr) => !shelved.has(tr.videoId)))
    const all = loose.length > 0 ? loose : keep(page.tracks)

    // **구독 only.** 홈 and 시청 기록 are not lists of channels you chose, and
    // narrowing them by channel would be answering a question nobody asked.
    // The channels come from the rows themselves rather than from a second
    // request; see channels.ts.
    const filterable = id === 'FEsubscriptions'
    const channels = filterable ? channelsOf(all) : []
    const chosen = filterable ? subsFilter().filter((cid) => channels.some((c) => c.id === cid)) : []
    const feed = filterable ? applyFilter(all, chosen) : all

    const openChannels = async (): Promise<void> => {
      const picked = await chooseChannels(ctx.overlay, channels, chosen)
      if (picked === null) return
      setSubsFilter(picked)
      ctx.reload()
    }
    const clear = (): void => {
      setSubsFilter([])
      ctx.reload()
    }

    const toolbar = h(
      'div',
      { class: 'toolbar' },
      h('button', { class: 'btn primary', 'data-nav': '', onclick: () => ctx.engine.play(feed, 0) }, icon('play', 16), t('전체 재생')),
      h('button', { class: 'btn', 'data-nav': '', onclick: () => { ctx.engine.enqueue(feed); ctx.say(`${tn('개', feed.length)} · ${t('대기열에 넣었습니다.')}`) } }, icon('plus', 16), t('대기열에 추가')),
      // The count is on the button because a filter you cannot see is a bug
      // report: the screen is simply missing things and nothing says why.
      filterable && channels.length > 0 && h(
        'button',
        { class: chosen.length > 0 ? 'btn chanFilter on' : 'btn chanFilter', 'data-nav': '', onclick: () => void openChannels() },
        icon('subs', 16),
        t('채널'),
        chosen.length > 0 && h('span', { class: 'chanCount' }, String(chosen.length)),
      ),
    )

    // A filter that hides everything still has to leave a way back out.
    if (feed.length === 0) {
      return replace(
        main,
        h('h2', null, title),
        toolbar,
        nothing(t('고른 채널의 영상이 없습니다.'), 'subs'),
        h(
          'div',
          { class: 'toolbar', style: 'justify-content: center' },
          h('button', { class: 'btn primary', 'data-nav': '', onclick: clear }, t('필터 해제')),
        ),
      )
    }

    replace(
      main,
      h('h2', null, title),
      toolbar,
      feed.length > 0 && listOf(ctx, { ...page, tracks: feed }, feedShape(ctx, id)),
      // The shelves are YouTube's own injections and carry no channel of ours
      // to filter by, so they stand aside while a filter is on rather than
      // sitting under a narrowed feed pretending to belong to it.
      chosen.length === 0 && page.shelves.map((shelf) => shelfRow(ctx, shelf)),
    )
  } catch (err) {
    if (!current(token)) return
    replace(main, h('h2', null, title), h('div', { class: 'err' }, explain(err)))
  }
}

// ── Playlists ──────────────────────────────────────────────────────────────

async function playlists(ctx: Ctx, main: HTMLElement): Promise<void> {
  const token = generation
  replace(main, h('h2', null, t('내 재생목록')), skToolbar(t('새 재생목록')), skPlaylistRows(6))
  try {
    await ctx.refreshPlaylists()
    if (!current(token)) return
    const list = ctx.playlists
    const create = h(
      'button',
      {
        class: 'btn primary',
        onclick: async () => {
          const chosen = await ctx.addToPlaylist([])
          void chosen
        },
      },
      icon('plus', 16),
      t('새 재생목록'),
    )
    if (list.length === 0) {
      replace(
        main,
        h('div', { class: 'playlistHead' },
          h('div', { class: 'playlistHeading' },
            h('span', { class: 'playlistMark' }, icon('library', 24)),
            h('div', null, h('h2', null, t('내 재생목록')), h('div', { class: 'sub' }, tn('개', 0))),
          ),
          create,
        ),
        nothing(t('재생목록이 없습니다.'), 'library'),
      )
      return
    }

    type PlaylistSort = 'recent' | 'name' | 'name-desc'
    const PAGE_SIZE = 12
    let page = 0
    let order: PlaylistSort = 'recent'
    const grid = h('div', { class: 'playlistGrid' })
    const pager = h('nav', { class: 'playlistPager', 'aria-label': t('페이지') })
    const select = h(
      'select',
      { class: 'playlistSortSelect', 'aria-label': t('정렬') },
      h('option', { value: 'recent' }, t('최근순')),
      h('option', { value: 'name' }, t('이름순')),
      h('option', { value: 'name-desc' }, t('이름 역순')),
    )

    const drawPage = (scroll = false): void => {
      const ordered = list.slice()
      if (order !== 'recent') {
        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
        ordered.sort((a, b) => collator.compare(a.title, b.title) * (order === 'name-desc' ? -1 : 1))
      }
      const pages = Math.max(1, Math.ceil(ordered.length / PAGE_SIZE))
      page = Math.max(0, Math.min(page, pages - 1))
      replace(grid, ordered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((p) => card(ctx, p)))
      replace(
        pager,
        h('button', {
          class: 'btn ghost', 'data-nav': '', disabled: page === 0,
          'aria-label': t('이전'),
          onclick: () => { page -= 1; drawPage(true) },
        }, icon('back', 15), t('이전')),
        h('span', { class: 'playlistPage', 'aria-live': 'polite' }, `${page + 1} / ${pages}`),
        h('button', {
          class: 'btn ghost next', 'data-nav': '', disabled: page === pages - 1,
          'aria-label': t('다음'),
          onclick: () => { page += 1; drawPage(true) },
        }, t('다음'), icon('back', 15)),
      )
      pager.hidden = pages === 1
      if (scroll) main.scrollTo({ top: 0, behavior: 'smooth' })
    }
    select.addEventListener('change', () => {
      order = select.value as PlaylistSort
      page = 0
      drawPage(true)
    })

    replace(
      main,
      h('div', { class: 'playlistHead' },
        h('div', { class: 'playlistHeading' },
          h('span', { class: 'playlistMark' }, icon('library', 24)),
          h('div', null, h('h2', null, t('내 재생목록')), h('div', { class: 'sub' }, tn('개', list.length))),
        ),
        create,
      ),
      h('div', { class: 'playlistTools' },
        h('label', { class: 'playlistSort' }, h('span', null, t('정렬')), select),
      ),
      grid,
      pager,
    )
    drawPage()
  } catch (err) {
    if (!current(token)) return
    replace(main, h('h2', null, t('내 재생목록')), h('div', { class: 'err' }, explain(err)))
  }
}

/**
 * One playlist, as a compact library card. It keeps the density of a row, but
 * gives the cover and title a surface of their own so a page of twelve reads
 * as a collection rather than an undifferentiated stack.
 */
function card(ctx: Ctx, p: Playlist): HTMLElement {
  return h(
    'button',
    {
      class: 'playlistCard',
      'data-nav': '',
      title: p.title,
      onclick: () => ctx.go({ kind: 'playlist', id: p.id, title: p.title }),
    },
    art('playlistCover', p.cover),
    h(
      'div',
      { class: 'meta' },
      h('div', { class: 'title' }, p.title),
      h('div', { class: 'by' }, p.subtitle),
    ),
    icon('back', 16),
  )
}

async function playlist(ctx: Ctx, main: HTMLElement, id: string, title: string): Promise<void> {
  const token = generation
  replace(
    main,
    skHead(),
    h('div', { class: 'toolbar' },
      h('div', { class: 'sk', style: 'height: 30px; width: 88px' }),
      h('div', { class: 'sk', style: 'height: 30px; width: 88px' })),
    skRows(8),
  )
  try {
    const tracks = await api.playlistTracks(ctx.cfg, id)
    // Stamped here and nowhere else: this is the one screen that knows, for
    // certain, which list a row belongs to. It travels with the track into the
    // queue, so 관심 없음 can offer to take it out of the list as well as out
    // of what is playing.
    for (const track of tracks) track.fromPlaylist = id
    if (!current(token)) return
    const cover = tracks[0]?.videoId
    const body = h('div', { class: 'rows' })
    const menuButton = h('button', { class: 'btn ghost', 'data-nav': '' }, icon('more', 18))
    menuButton.addEventListener('click', () =>
      showMenu(ctx.overlay, menuButton, [
        { label: t('대기열에 추가'), icon: 'plus', onSelect: () => { ctx.engine.enqueue(tracks); ctx.say(`${tn('곡', tracks.length)} · ${t('대기열에 넣었습니다.')}`) } },
        { label: t('유튜브에서 열기'), icon: 'external', onSelect: () => window.open(`https://www.youtube.com/playlist?list=${id}`, '_blank') },
        '-',
        {
          label: t('재생목록 삭제'),
          icon: 'trash',
          danger: true,
          onSelect: async () => {
            if (!(await confirm(ctx.overlay, `재생목록 '${title}'을(를) 삭제할까요?`))) return
            try {
              await api.deletePlaylist(ctx.cfg, id)
              ctx.say(t('삭제했습니다.'))
              await ctx.refreshPlaylists()
              ctx.go({ kind: 'playlists' })
            } catch (err) {
              ctx.say(explain(err), true)
            }
          },
        },
      ]),
    )

    // Held, because taking a track out updates it in place rather than
    // redrawing the header it sits in.
    const count = h('div', { class: 'sub' }, tn('곡', tracks.length))

    replace(
      main,
      h(
        'div',
        { class: 'head' },
        art('cover', cover ? thumbnail(cover) : undefined),
        h(
          'div',
          { style: 'min-width:0' },
          h('div', { class: 'label' }, t('재생목록')),
          h('h2', null, title),
          count,
        ),
      ),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn primary', 'data-nav': '', onclick: () => ctx.engine.play(tracks, 0) }, icon('play', 16), t('재생')),
        h('button', { class: 'btn', 'data-nav': '', onclick: () => { ctx.engine.setShuffle(true); ctx.engine.play(tracks, 0) } }, icon('shuffle', 16), t('셔플 재생')),
        tracks[0] && h('button', { class: 'btn', 'data-nav': '', onclick: () => void startRadio(ctx, tracks[0]!) }, icon('radio', 16), t('라디오')),
        menuButton,
      ),
      tracks.length === 0 ? nothing(t('비어 있는 재생목록입니다.'), 'library') : body,
    )
    // The numbers down the left are positions, so they are wrong the moment a
    // row above them leaves. Rewritten in place rather than by redrawing:
    // the row that is playing shows bars instead of a number and must keep
    // them.
    const renumber = () => {
      let n = 0
      for (const el of Array.from(body.children)) {
        if (!el.classList.contains('row')) continue
        n += 1
        const idx = el.querySelector('.idx')
        if (idx && !idx.querySelector('.eq')) idx.textContent = String(n)
      }
    }

    const mine =
      ctx.playlists.some((p) => p.id === id) || tracks.some((track) => track.setVideoId !== undefined)
    /**
     * Moves a row one place, on the screen first and then at YouTube.
     *
     * The list is reordered before the request goes out, because a row that
     * sits still for a round trip reads as a press that did not land. If the
     * answer is a refusal the order is put back exactly as it was, so a
     * failure leaves the screen telling the truth rather than showing an
     * order the account does not have.
     */
    const moveTo = async (track: Track, to: number): Promise<void> => {
      const from = tracks.indexOf(track)
      if (from < 0 || to < 0 || to >= tracks.length || from === to) return
      // The handle YouTube needs to name this slot. A row without one is not
      // a row of ours to move, and the menu is not offered on those lists.
      const slot = track.setVideoId
      if (!slot) return
      const before = tracks.slice()
      tracks.splice(from, 1)
      tracks.splice(to, 0, track)
      draw()
      // YouTube places a row *after* another one, so a move is named by the
      // row it should follow. Dropping at the top has nothing to follow.
      const after = to > 0 ? tracks[to - 1]?.setVideoId : undefined
      try {
        await api.movePlaylistTrack(ctx.cfg, id, slot, after)
      } catch (err) {
        tracks.splice(0, tracks.length, ...before)
        draw()
        ctx.say(`${t('순서를 바꾸지 못했습니다.')} ${explain(err)}`, true)
      }
    }

    /** The same move, named by position, which is what a drop gives. */
    const moveRowTo = (from: number, to: number): Promise<void> => {
      const track = tracks[from]
      return track ? moveTo(track, to) : Promise.resolve()
    }

    const draw = () => {
      if (tracks.length === 0) {
        body.className = ''
        return replace(body, nothing(t('비어 있는 재생목록입니다.'), 'library'))
      }
      // One function, two ways in: the row's button and the menu's item both
      // put the house in order the same way afterwards.
      const gone = (track: Track) => () => {
        const at = tracks.indexOf(track)
        if (at >= 0) tracks.splice(at, 1)
        count.textContent = tn('곡', tracks.length)
        if (tracks.length === 0) draw()
        else renumber()
      }
      // **Only a playlist of one's own can have things taken out of it.**
      // 둘러보기 opens YouTube's own editorial playlists, and the row button
      // was offered there too — pressing it asked YouTube to edit a list
      // belonging to someone else, which it refuses, and the reader got a red
      // toast for pressing a button we drew. Reported from a phone, on a
      // 99-track list nobody here owns.
      //
      // Where the list is not ours the same slot does what every other list's
      // does: put the track somewhere that *is* ours.
      // Two signals, and the second is YouTube's own. A row that can be
      // removed arrives carrying a `setVideoId` — the handle its own remove
      // action needs — and a row that cannot does not. Measured on two lists
      // nobody here owns: 151 tracks, not one setVideoId between them. That
      // answers the question per row and keeps working when the reader's own
      // playlists have not been fetched, which our first test quietly needs.
      layout(ctx, body, tracks, (track) => ({
        extra: mine
          ? () => {
              const at = tracks.indexOf(track)
              return [
                '-',
                ...(at > 0 ? [{ label: t('위로'), icon: 'up' as const, onSelect: () => void moveTo(track, at - 1) }] : []),
                ...(at < tracks.length - 1
                  ? [{ label: t('아래로'), icon: 'down' as const, onSelect: () => void moveTo(track, at + 1) }]
                  : []),
              ]
            }
          : undefined,
        quick: mine
          ? {
              // A bin, not a cross. A cross is what closes things; taking a
              // track out of a playlist is a deletion and should look like one.
              icon: 'trash',
              title: t('이 재생목록에서 빼기'),
              run: (rowEl) => void removeFromPlaylistNow(ctx, id, track, rowEl, gone(track)),
            }
          : addQuick(ctx, track),
        // No menu entry either way, and for two different reasons: where the
        // list is ours the X beside it already does this, and a sheet carrying
        // a second copy of the button next to it is exactly the length nobody
        // asked for; where it is not ours the action cannot succeed at all.
      }))
    }

    if (tracks.length > 0) {
      draw()
      // Only a list of one's own can be reordered, for the same reason only
      // one of them can have rows taken out.
      if (mine) {
        makeSortable(body, { rowSelector: '.row', onMove: (from, to) => void moveRowTo(from, to) })
      }
    }
  } catch (err) {
    if (!current(token)) return
    replace(main, h('h2', null, title), h('div', { class: 'err' }, explain(err)))
  }
}

// ── 시청 기록 ──────────────────────────────────────────────────────────────

/** No feed at all, in the shape a feed has. */
const NO_FEED: api.Page = { tracks: [], shelves: [], endpoint: 'browse' }

/**
 * One history: YouTube's, and this browser's own.
 *
 * These were two lines in the column, 최근 감상 and 시청 기록, saying nearly
 * the same word. YouTube's one needs a session and answers a signed-out
 * browser with 200 and an empty body, so for half the readers it was a dead
 * end standing next to a live screen. They are one screen now.
 *
 * The local half leads. What this browser played last is the most recent thing
 * there is to show, it is the half that works with no session at all, and it
 * never leaves this origin's storage. YouTube's rows follow, minus the videos
 * already standing above them.
 *
 * 기록 지우기 clears the local half only. The rest of the list belongs to the
 * account, and a button here that quietly reached into it would be doing more
 * than it says.
 */
async function watched(ctx: Ctx, main: HTMLElement): Promise<void> {
  const token = generation
  const title = t('시청 기록')
  const mine = history()

  const draw = (page: api.Page): void => {
    const list = mergeById(mine, page.tracks)
    if (list.length === 0) {
      return replace(main, h('h2', null, title), nothing(t('아직 들은 것이 없습니다.'), 'history'))
    }
    replace(
      main,
      h('h2', null, title),
      h(
        'div',
        { class: 'toolbar' },
        h('button', { class: 'btn primary', 'data-nav': '', onclick: () => ctx.engine.play(list, 0) }, icon('play', 16), t('전체 재생')),
        h('button', { class: 'btn', 'data-nav': '', onclick: () => { ctx.engine.enqueue(list); ctx.say(`${tn('개', list.length)} · ${t('대기열에 넣었습니다.')}`) } }, icon('plus', 16), t('대기열에 추가')),
        // Only when there is a local half to clear, so the button never asks a
        // question it cannot act on.
        mine.length > 0 && h(
          'button',
          {
            class: 'btn ghost',
            'data-nav': '',
            onclick: async () => {
              if (!(await confirm(ctx.overlay, t('최근 감상 기록을 지울까요?')))) return
              forgetHistory()
              ctx.reload()
            },
          },
          icon('trash', 16),
          t('기록 지우기'),
        ),
      ),
      listOf(ctx, page, feedShape(ctx, 'FEhistory'), mine),
      page.shelves.map((shelf) => shelfRow(ctx, shelf)),
    )
  }

  // The local half is already in hand, so it goes up now rather than behind an
  // outline of rows nobody is waiting for. Only an empty one waits.
  if (mine.length > 0) draw(NO_FEED)
  else replace(main, h('h2', null, title), skToolbar(t('전체 재생'), t('대기열에 추가')), skFeed(ctx, 'FEhistory'))

  try {
    const page = await api.feed(ctx.cfg, 'FEhistory')
    if (!current(token)) return
    draw(page)
  } catch (err) {
    if (!current(token)) return
    // What is on screen is already a true answer, so nothing is said over it.
    if (mine.length > 0) return
    // Signed out this feed comes back empty and api.feed calls that an auth
    // error. With nothing local either the screen is simply empty, which is
    // what it is, rather than broken.
    if (isSignedOut(err)) return draw(NO_FEED)
    replace(main, h('h2', null, title), h('div', { class: 'err' }, explain(err)))
  }
}

// ── Queue ──────────────────────────────────────────────────────────────────

function queue(ctx: Ctx, main: HTMLElement): void {
  shown = ctx.engine.state.queue
  const q = ctx.engine.state.queue
  let queueRows: HTMLElement | undefined
  replace(
    main,
    h('h2', null, t('대기열')),
    h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'sub' }, tn('개', q.length)),
      q.length > 0 && h('button', { class: 'btn', 'data-nav': '', onclick: () => void ctx.addToPlaylist(q) }, icon('library', 16), t('재생목록으로 저장')),
      // Asks first. One press was throwing away a queue that could be forty
      // tracks long with nothing to put it back.
      q.length > 0 && h(
        'button',
        {
          class: 'btn ghost',
          'data-nav': '',
          onclick: async () => {
            if (!(await confirm(ctx.overlay, t('대기열을 비울까요?'), t('비우기')))) return
            ctx.engine.clear()
            ctx.reload()
          },
        },
        icon('trash', 16),
        t('비우기'),
      ),
    ),
    q.length === 0
      ? nothing(t('대기열이 비어 있습니다.'), 'queue')
      : (queueRows = h(
          'div',
          { class: 'rows' },
          // Headed, because a queue's whole job is to answer two questions —
          // what is playing and what comes after it — and a flat list of forty
          // rows with one of them tinted answers neither at a glance.
          q.map((track, i) => [
            i === ctx.engine.state.index && h('h3', { class: 'queueMark' }, t('지금 재생 중')),
            i === ctx.engine.state.index + 1 && h('h3', { class: 'queueMark' }, t('다음 재생')),
            row(ctx, track, {
              index: i + 1,
              onPlay: () => ctx.engine.jumpTo(i),
              // Same idea as a playlist: what a queue row is for is leaving.
              // A bin, not a cross — a cross closes things, and this deletes
              // one. The two used to disagree between this screen and a
              // playlist, which taught the glyph to mean nothing.
              quick: {
                icon: 'trash',
                title: t('대기열에서 빼기'),
                run: () => {
                  ctx.engine.removeAt(i)
                  ctx.reload()
                },
              },
              // Reordering has to be reachable without a drag. A remote has
              // no pointer to hold down, and a rule of this UI is that
              // nothing is drag-only or hover-only.
              extra: () => [
                '-',
                ...(i > 0
                  ? [{ label: t('위로'), icon: 'up' as const, onSelect: () => { ctx.engine.moveTrack(i, i - 1); ctx.reload() } }]
                  : []),
                ...(i < q.length - 1
                  ? [{ label: t('아래로'), icon: 'down' as const, onSelect: () => { ctx.engine.moveTrack(i, i + 1); ctx.reload() } }]
                  : []),
                '-',
                {
                  label: t('대기열에서 빼기'),
                  icon: 'close',
                  onSelect: () => {
                    ctx.engine.removeAt(i)
                    ctx.reload()
                  },
                },
              ],
            }),
          ]),
        )),
  )
  // Dragging, on the list rather than in the row: only two screens can be
  // reordered and the rows are shared by half a dozen. The menu above does the
  // same thing for anyone without a pointer to hold down.
  if (queueRows) {
    makeSortable(queueRows, {
      rowSelector: '.row',
      onMove: (from, to) => {
        ctx.engine.moveTrack(from, to)
        ctx.reload()
      },
    })
  }
}

export type { View }
