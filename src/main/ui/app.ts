// The shell around the views: sidebar, player bar, and the slot YouTube's own
// player is placed into.
//
// The slot is one element that is never re-rendered, only re-classed. That is
// deliberate: the player is positioned over it by the page-level stylesheet,
// and a slot that came and went would make the video jump every time a list
// redrew.

import { t, tn } from '../../shared/i18n.ts'
import * as api from '../api.ts'
import { thumbnail, type Track } from '../parse.ts'
import type { Engine } from '../engine.ts'
import type { Shell } from '../shell.ts'
import type { VideoLayout } from '../store.ts'
import { clearStoredTheme, dislikeRemoves, foldPlaylists, playlistsFolded, setDislikeRemoves, setStoredTheme, youtubeIsDark, type Mode, type Theme, type VideoLayout as Placement } from '../store.ts'
import { narrowNow } from './device.ts'
import { h, icon, mark, replace } from './dom.ts'
import { STYLES } from './styles.ts'
import { clock, explain, type Ctx, type View } from './ctx.ts'
import { confirm, showMenu, toast, type MenuItem } from './overlay.ts'
import { installRemote } from './remote.ts'
import { installKeys } from './keys.ts'
import { closeChannels } from './channels.ts'
import { render } from './views.ts'
import { closeSearch, openSearch } from './search.ts'
import { closeSettings, openSettings, type SettingsActions } from './settings.ts'
import { MENU, menuLines, setMenuOn, topicTitle } from '../menu.ts'

export interface AppOptions {
  shell: Shell
  engine: Engine
  /** Leaves the mode: the one thing this UI promises always works. */
  exit(): void
  /** Everything a view needs that the app does not own. */
  ctx: Omit<Ctx, 'view' | 'go' | 'reload' | 'say' | 'search' | 'overlay'>
}

export function mountApp(opts: AppOptions): { ctx: Ctx; destroy(): void } {
  const { shell, engine } = opts

  const main = h('div', { class: 'main' })
  const slot = h('div', { class: 'slot' })
  // The watch layout's right-hand column: the queue beside the picture.
  const upnext = h('div', { class: 'upnext', 'aria-label': t('다음 재생') })
  const side = h('div', { class: 'side' })
  const bar = h('div', { class: 'bar' })
  // A strip of its own across the top, on a narrow screen only.
  //
  // **It exists because the video used to eat the chrome.** The drawer button
  // and the mode switch were fixed to the top corners and the stage was fixed
  // to the top of the screen, and the player is drawn above the whole app —
  // it has to be, or our panels would cover the picture. So in 영상 mode the
  // video landed squarely on top of both, and there was no way to open the
  // menu or get back to 음악 without knowing about Escape. Given a row of its
  // own, the header is above the stage rather than under it, and cannot be
  // covered by anything.
  const top = h('div', { class: 'top' })
  const app = h('div', { class: narrowNow() ? 'app narrow' : 'app' }, top, side, main, slot, upnext, bar)

  // Light or dark follows YouTube, and nothing else. There is no switch: the
  // page underneath already has one, and two switches for one question is a
  // way to end up looking at a light panel over a dark page.
  //
  // YouTube says which it is with an attribute on the root element, and can
  // change it while we are up, so it is watched rather than read once.
  function applyTheme(): void {
    const light = !youtubeIsDark()
    app.classList.toggle('light', light)
    // The overlay is a second shadow root with its own :host, and the palette
    // has to reach it or menus come out dark over a light page.
    ;(shell.overlay.host as HTMLElement).classList.toggle('light', light)
  }

  /**
   * Presses **YouTube's** own light/dark switch, rather than only remembering
   * an answer over here.
   *
   * The user's call, and the right one: two switches for one question is how
   * you end up with a light panel over a dark page. So a choice made here is
   * made on the page as well, the observer above notices the attribute change
   * and repaints us with it, and the choice outlives the mode. That is the
   * point of pressing it.
   *
   * Not called for 자동, which is the absence of a choice: there is nothing to
   * press YouTube into, and whatever it is already set to is the answer.
   *
   * The attribute is what YouTube reads right now; f6's 0x400 bit in the PREF
   * cookie is what it reads on the next page. Both, or the page snaps back.
   */
  function setYouTubeDark(on: boolean): void {
    const root = document.documentElement
    if (on) root.setAttribute('dark', '')
    else root.removeAttribute('dark')
    try {
      const raw = document.cookie.split('; ').find((c) => c.startsWith('PREF='))?.slice(5) ?? ''
      const pref = new URLSearchParams(raw)
      const f6 = Number.parseInt(pref.get('f6') ?? '0', 16) || 0
      pref.set('f6', ((on ? f6 | 0x400 : f6 & ~0x400) >>> 0).toString(16))
      document.cookie = `PREF=${pref.toString()}; domain=.youtube.com; path=/; max-age=63072000`
    } catch {
      // A browser that will not take the cookie still gets the attribute, and
      // the choice lasts as long as the page does.
    }
  }

  /**
   * The theme, as the three answers the state has room for.
   *
   * `auto` is the absence of a choice rather than a choice of its own, so it
   * is the stored key going away: `youtubeIsDark()` reads that key first and
   * falls through to YouTube's own attribute only when nothing is there.
   *
   * Both places are written, because both are read. `engine.state.theme` is
   * what is put back before the first paint of the next page load, and the
   * key is what every later `youtubeIsDark()` asks. The glyph in the header
   * used to write only the second, so the sheet showed 자동 next to a page
   * that was plainly holding a choice.
   */
  function chooseTheme(theme: Theme): void {
    engine.setTheme(theme)
    if (theme === 'auto') {
      clearStoredTheme()
    } else {
      setStoredTheme(theme)
      setYouTubeDark(theme === 'dark')
    }
    applyTheme()
    drawTop()
    drawSide()
  }

  function themeButton(compact: boolean): HTMLElement {
    const dark = youtubeIsDark()
    const press = () => chooseTheme(youtubeIsDark() ? 'light' : 'dark')
    if (compact) {
      return h(
        'button',
        { class: 'themeButton', 'data-nav': '', title: t('테마'), 'aria-label': t('테마'), onclick: press },
        icon(dark ? 'sun' : 'moon', 18),
      )
    }
    return h(
      'button',
      { class: 'nav', 'data-nav': '', onclick: press },
      icon(dark ? 'sun' : 'moon', 18),
      h('span', null, dark ? t('밝게') : t('어둡게')),
    )
  }
  const themeWatch = new MutationObserver(applyTheme)
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] })
  applyTheme()

  // The drawer has to be above the picture while it is out, and the picture is
  // drawn above the app — so the shell puts it back down for as long as the
  // drawer is open. Without this the video covered the top of the drawer in
  // 영상 mode and the first two rows could not be pressed.
  const setDrawer = (open: boolean) => {
    // One full-screen thing at a time. The drawer and the opened player are
    // both the whole screen on a phone, and with both out they fought: the
    // player sits above the drawer, and above the stage it starts below, so
    // the drawer showed as a strip at the top with its own list cut off in the
    // middle of a word. Neither was wrong on its own; having both was.
    if (open) setSheet(false)
    app.classList.toggle('drawer-open', open)
    shell.cover(open)
  }
  const closeDrawer = () => setDrawer(false)
  const scrim = h('div', { class: 'drawerScrim', onclick: closeDrawer })
  app.appendChild(scrim)

  const style = document.createElement('style')
  style.textContent = STYLES
  shell.root.append(style, app)

  const overlayStyle = document.createElement('style')
  overlayStyle.textContent = STYLES
  shell.overlay.append(overlayStyle)

  // ── Context ──────────────────────────────────────────────────────────────

  // Delegating rather than spreading, because `playlists` is filled in after
  // mount: a spread would freeze today's empty array into the sidebar forever.
  // Where you have been, so a swipe has somewhere to go. Capped, because this
  // is a back gesture and not a session log.
  const trail: View[] = []

  const ctx: Ctx = {
    engine: opts.ctx.engine,
    cfg: opts.ctx.cfg,
    get playlists() {
      return opts.ctx.playlists
    },
    // Both redraw the column afterwards. Making a playlist wrote it to
    // YouTube and left the sidebar showing the list as it was before — the
    // new one appeared only on the next reload, which reads as the creation
    // having failed. The screen that asked is redrawn too when it is the one
    // the playlists are on.
    async refreshPlaylists() {
      await opts.ctx.refreshPlaylists()
      drawSide()
    },
    async addToPlaylist(tracks) {
      await opts.ctx.addToPlaylist(tracks)
      drawSide()
      if (ctx.view.kind === 'playlists') ctx.reload()
    },
    overlay: shell.overlay,
    view: viewFromName(engine.state.view),
    go(view) {
      // A screen change puts the panel away: 이 곡으로 라디오 from a result
      // opens the queue, and a queue drawn behind a search is not opened.
      closeSearch()
      if (nameOf(view) !== nameOf(ctx.view)) {
        trail.push(ctx.view)
        if (trail.length > 20) trail.shift()
      }
      ctx.view = view
      engine.setView(nameOf(view))
      setLayout(pictureNow())
      app.classList.remove('sheet-open')
      drawTop()
      drawSide()
      void render(ctx, main)
      main.scrollTop = 0
    },
    reload() {
      void render(ctx, main)
    },
    search(query) {
      openSearch(ctx, query)
    },
    say(message, bad) {
      toast(shell.overlay, message, bad)
    },
  }

  // ── Sidebar ──────────────────────────────────────────────────────────────

  // Two groups, because seven destinations in one column is a list to read
  // rather than a menu to glance at. The first four are YouTube's own screens;
  // the last three are the listener's, and a heading says which is which.
  //
  // 검색 is in the column but is not a screen: it opens the panel over
  // whatever screen is up, so it never reads as the current one.
  type NavItem = { label: string; icon: Parameters<typeof icon>[0]; section?: string } & (
    | { view: View; open?: undefined }
    | { view?: undefined; open: () => void }
  )
  // The column is the menu (menu.ts), with the search line after 음악: it is
  // not a screen but it is the thing done from every screen, and it belongs
  // where a hand goes first.
  function navItems(): NavItem[] {
    const lines = menuLines()
    const out: NavItem[] = []
    for (const line of lines) {
      out.push({ view: line.view, label: t(line.label), icon: line.icon as NavItem['icon'], section: line.section && t(line.section) })
      if (line.key === 'music') out.push({ open: () => ctx.search(), label: t('검색'), icon: 'search' })
    }
    return out
  }

  // The header carries the way into the drawer and the name of the screen.
  //
  // It said "RenewTube" before, which the drawer says too — the same words
  // twice on one screen — while the screen's own name was set in 22px type
  // below it, taking a band of a phone's height to say one word. The header
  // had the room and the content did not.
  function drawTop(): void {
    // No glyph beside the name. The header is a strip with one button and one
    // word on it; a second mark in that space reads as clutter, not as help.
    // Search sits at the far end with the theme, the same 34px square: it is
    // the one thing done from every screen, and the drawer is a press away
    // from being too far for it.
    replace(
      top,
      menuButton,
      h('div', { class: 'name' }, titleOf(ctx.view)),
      h(
        'button',
        { class: 'headAction searchOpen', 'data-nav': '', title: t('검색'), 'aria-label': t('검색'), onclick: () => ctx.search() },
        icon('search', 18),
      ),
      themeButton(true),
    )
  }

  /** One destination in the column, or the one line that opens a panel instead. */
  function navButton(item: NavItem): HTMLElement {
    const on = item.view !== undefined && nameOf(item.view) === nameOf(ctx.view)
    return h(
      'button',
      {
        class: on ? 'nav on' : 'nav',
        'data-nav': '',
        onclick: () => {
          closeDrawer()
          if (item.open) item.open()
          else ctx.go(item.view)
        },
      },
      icon(item.icon, 18),
      h('span', null, item.label),
    )
  }

  /**
   * 내 재생목록, and the lists inside it.
   *
   * Opening it asks YouTube for the lists again rather than showing whatever
   * was fetched at mount: making a playlist elsewhere, or deleting one, should
   * be visible the moment the branch is opened rather than after a reload.
   * The refresh redraws this column when it lands, so the fold does not wait
   * on the network to open.
   */
  function playlistBranch(item: NavItem & { view: View }): Array<HTMLElement | false> {
    // An empty branch is not a branch. Signed out, or on an account with no
    // lists of its own, folding a nothing open to show one line that says
    // 전체 보기 reads as a stray heading — measured on the phone, and it is
    // what the drawer looked like. With nothing to hold, the line goes back to
    // being a destination: it opens the screen, which is where a list gets
    // made.
    const empty = ctx.playlists.length === 0
    const folded = empty || playlistsFolded()
    const head = h(
      'button',
      {
        class: nameOf(item.view) === nameOf(ctx.view) ? 'nav branch on' : 'nav branch',
        'data-nav': '',
        'aria-expanded': empty ? undefined : String(!folded),
        onclick: () => {
          if (empty) {
            closeDrawer()
            ctx.go(item.view)
            void ctx.refreshPlaylists().catch(() => {})
            return
          }
          foldPlaylists(!folded)
          drawSide()
          if (folded) void ctx.refreshPlaylists().catch(() => {})
        },
      },
      icon(item.icon, 18),
      h('span', null, item.label),
      !empty && h('span', { class: folded ? 'chev' : 'chev open' }, icon('down', 16)),
    )
    if (folded) return [head]
    return [
      head,
      ...ctx.playlists.slice(0, 30).map((p) =>
        h(
          'button',
          {
            class: 'nav pl',
            'data-nav': '',
            title: p.title,
            onclick: () => {
              closeDrawer()
              ctx.go({ kind: 'playlist', id: p.id, title: p.title })
            },
          },
          p.title,
        ),
      ),
      h(
        'button',
        {
          class: 'nav pl all',
          'data-nav': '',
          onclick: () => {
            closeDrawer()
            ctx.go(item.view)
          },
        },
        t('전체 보기'),
        icon('back', 14),
      ),
    ]
  }

  /**
   * What the settings sheet may change. Read through functions rather than
   * handed as values, because the sheet redraws itself after every choice and
   * has to see what the engine now says rather than what it said when it
   * opened.
   */
  const settingsActions: SettingsActions = {
    theme: () => engine.state.theme,
    setTheme: chooseTheme,
    // A line switched off while its screen is up sends the reader to 음악,
    // which cannot be switched off. A column pointing nowhere is worse than a
    // screen change nobody pressed for.
    setMenuLine: (line, on) => {
      setMenuOn(line, on)
      drawSide()
      if (!on && nameOf(line.view) === nameOf(ctx.view)) ctx.go({ kind: 'explore' })
    },
    mode: () => engine.state.mode,
    setMode: (mode: Mode) => {
      engine.setMode(mode)
      // The mode decides where the picture goes, so the slot has to be told.
      // Setting the mode alone left 영상 chosen with nothing on the stage.
      setLayout(pictureNow())
      drawBar()
    },
  }

  function drawSide(): void {
    replace(
      side,
      h(
        'div',
        { class: 'sideHead' },
        h(
          'div',
          { class: 'brand' },
          mark(20),
          h('span', null, 'RenewTube'),
          h('div', { class: 'spacer' }),
          // The way into the settings sheet, and out to YouTube's own pages.
          //
          // Here rather than in the header strip because it belongs to the
          // product and not to the screen, and because this row is the one
          // place a phone and a desktop both have: the strip is drawn only on
          // a narrow screen, and the drawer this sits in is a press away
          // there. One button, one place, both layouts.
          h(
            'button',
            {
              class: 'headAction gear',
              'data-nav': '',
              title: t('설정'),
              'aria-label': t('설정'),
              onclick: () => {
                // The drawer goes away first. The sheet is drawn over the
                // whole app, and a drawer left standing behind it is a second
                // full-screen thing nobody asked for.
                closeDrawer()
                openSettings(ctx, settingsActions)
              },
            },
            icon('gear', 18),
          ),
          // The way out, as a glyph beside the way closed.
          //
          // It was a full labelled line under the name, and on a phone that
          // spent a whole row of a short column on the one thing nobody opens
          // the drawer to do. Both of these are the same size and sit in the
          // same corner, so the row reads as the pane's own controls rather
          // than as the first of the destinations below it.
          h(
            'button',
            { class: 'headAction exit', 'data-nav': '', title: t('RenewTube 종료'), 'aria-label': t('RenewTube 종료'), onclick: opts.exit },
            icon('leave', 18),
          ),
          // Only ever visible in the drawer. Reaching the scrim means reaching
          // across the screen, and a drawer with no close button reads as stuck.
          h(
            'button',
            { class: 'headAction drawerClose', 'data-nav': '', title: t('닫기'), 'aria-label': t('닫기'), onclick: closeDrawer },
            icon('close', 18),
          ),
        ),
      ),
      h(
        'div',
        { class: 'sideScroll' },
        // On a phone the header already carries 검색, and the drawer saying it
        // again read as two ways in to one thing (asked about on 2026-09-04).
        navItems().filter((item) => !(narrowNow() && item.open)).map((item) => [
          item.section && h('h4', null, item.section),
          // 내 재생목록 is a section, not a destination. It used to be both: a
          // line that opened a screen, and under it the same lists again as a
          // flat run of entries with a heading of their own — the same thing
          // said twice, and unbounded, which on an account with many lists is
          // most of the column. It folds now, it remembers, and the way to the
          // screen is the last line inside it.
          item.view !== undefined && item.view.kind === 'playlists' ? playlistBranch(item) : navButton(item),
        ]),
        h('div', { class: 'spacer' }),
        // The theme lives in the header on a phone; here it is one more line.
        !narrowNow() && themeButton(false),
      ),
    )
  }

  // ── The player slot ──────────────────────────────────────────────────────

  function setLayout(layout: VideoLayout): void {
    // The right-hand queue needs room a phone does not have; there, watch
    // collapses to the cinema stage.
    if (narrowNow() && layout === 'watch') layout = 'stage'
    engine.setVideo(layout)
    slot.className = `slot ${layout}`
    app.classList.toggle('has-stage', layout === 'stage')
    app.classList.toggle('has-watch', layout === 'watch')
    app.classList.toggle('has-corner', layout === 'corner')
    if (layout === 'watch') drawUpnext()
    // A new stage starts un-scrolled; the list's own scrollTop resets with the view.
    document.documentElement.style.setProperty('--stage-scroll', '0px')
    seatSlot()
    // Re-measure after the slot has taken its new size, so the scroll handler
    // never has to touch layout itself.
    requestAnimationFrame(measureStage)
    drawBar()
  }

  /**
   * The queue as a column beside the picture, in the watch layout.
   *
   * The whole queue, the playing one marked, each a press that jumps to it —
   * the up-next list of a watch page, drawn from the same queue the bar plays.
   * Redrawn when the queue or the playing index moves (the subscription
   * below), and only while the watch layout is up.
   */
  function drawUpnext(): void {
    const q = engine.state.queue
    const idx = engine.state.index
    replace(
      upnext,
      h('div', { class: 'upnextHead' }, t('다음 재생')),
      q.length === 0
        ? h('div', { class: 'upnextEmpty' }, t('대기열이 비어 있습니다.'))
        : h(
            'div',
            { class: 'upnextList' },
            q.map((track, i) =>
              h(
                'button',
                { class: i === idx ? 'upRow on' : 'upRow', 'data-nav': '', title: track.title, onclick: () => engine.jumpTo(i) },
                h(
                  'div',
                  { class: 'upThumb' },
                  h('img', { src: thumbnail(track.videoId), loading: 'lazy', alt: '' }),
                  i === idx && h('span', { class: 'upPlaying', 'aria-hidden': 'true' }, icon('play', 12)),
                ),
                h(
                  'div',
                  { class: 'upMeta' },
                  h('div', { class: 'upT' }, track.title),
                  h('div', { class: 'upB' }, track.byline),
                ),
              ),
            ),
          ),
    )
  }

  /**
   * Where the picture's slot lives: in the app's grid, or inside the opened
   * player where the artwork would be.
   *
   * A phone's opened player with the picture on used to push itself down
   * under a stage across the top of the screen, and the picture there was
   * squashed and cut. The reader wanted it back where the artwork is, which
   * is where a picture of the thing playing belongs (2026-09-04). The slot is
   * moved, not rebuilt, and the shell measures it wherever it stands.
   */
  function seatSlot(): void {
    const inSheet = app.classList.contains('narrow') && app.classList.contains('sheet-open') && engine.state.video === 'stage'
    if (inSheet) {
      if (slot.parentElement !== now) now.insertBefore(slot, nowThumb)
    } else if (slot.parentElement !== app) {
      app.insertBefore(slot, bar)
    }
    app.classList.toggle('slot-in-sheet', inSheet)
    shell.place(engine.state.video === 'hidden' ? null : slot)
  }

  // ── Player bar ───────────────────────────────────────────────────────────

  const seek = h('input', { type: 'range', min: '0', max: '1000', value: '0' })
  /** Paints how much of a slider is behind the thumb. */
  const fill = (el: HTMLInputElement, ratio: number) => {
    el.style.setProperty('--p', `${Math.max(0, Math.min(1, ratio)) * 100}%`)
  }
  const elapsed = h('span', null, '0:00')
  const total = h('span', null, '0:00')
  let scrubbing = false
  seek.addEventListener('pointerdown', () => (scrubbing = true))
  const commit = () => {
    const d = engine.position.duration
    if (d > 0) engine.seek((Number(seek.value) / 1000) * d)
    scrubbing = false
  }
  seek.addEventListener('pointerup', commit)
  seek.addEventListener('change', commit)
  seek.addEventListener('input', () => {
    const d = engine.position.duration
    fill(seek, Number(seek.value) / 1000)
    if (d > 0) elapsed.textContent = clock((Number(seek.value) / 1000) * d)
  })

  const menuButton = h('button', {
    class: 'drawerToggle',
    'data-nav': '',
    title: t('메뉴'),
    'aria-label': t('메뉴'),
    onclick: () => setDrawer(!app.classList.contains('drawer-open')),
  }, icon('menu', 20))

  const nowThumb = h('div', { class: 'thumb' })
  const nowTitle = h('div', { class: 't' }, t('재생 중인 항목 없음'))
  const nowBy = h('div', { class: 'b' })
  const playButton = h('button', { class: 'big', 'data-nav': '', title: t('재생 / 일시정지') }, icon('play', 20))
  playButton.addEventListener('click', () => engine.toggle())

  const prevButton = h('button', { class: 'pv', 'data-nav': '', title: t('이전') }, icon('prev', 20))
  prevButton.addEventListener('click', () => engine.prev())
  const nextButton = h('button', { class: 'nx', 'data-nav': '', title: t('다음') }, icon('next', 20))
  nextButton.addEventListener('click', () => engine.next())
  const shuffleButton = h('button', { class: 'sh', 'data-nav': '', title: t('셔플') }, icon('shuffle', 18))
  shuffleButton.addEventListener('click', () => {
    const on = !engine.state.shuffle
    engine.setShuffle(on)
    drawBar()
    // Said out loud, because on a phone the button is 40 pixels of glyph and
    // the only other answer to the press is a change of colour inside it.
    toast(shell.overlay, on ? t('셔플을 켰습니다.') : t('셔플을 껐습니다.'))
  })
  const repeatButton = h('button', { class: 'rp', 'data-nav': '', title: t('반복') }, icon('repeat', 18))
  repeatButton.addEventListener('click', () => {
    engine.cycleRepeat()
    drawBar()
    toast(
      shell.overlay,
      { off: t('반복을 껐습니다.'), all: t('전체 반복입니다.'), one: t('한 곡 반복입니다.') }[engine.state.repeat],
    )
  })

  const volume = h('input', { type: 'range', class: 'vol', min: '0', max: '100', value: String(engine.state.volume) })
  volume.addEventListener('input', () => {
    fill(volume, Number(volume.value) / 100)
    engine.setVolume(Number(volume.value))
  })
  const muteButton = h('button', { 'data-nav': '', title: t('음소거') }, icon('volume', 18))
  muteButton.addEventListener('click', () => {
    // The engine's own mute, so it comes back to the level it was at rather
    // than to a number picked here — and so the m key and this button are the
    // same action rather than two that disagree.
    engine.toggleMute()
    volume.value = String(engine.state.volume)
    fill(volume, engine.state.volume / 100)
    drawBar()
  })

  /**
   * Speed and the sleep timer, behind one button.
   *
   * Two more controls in the bar is two more things in a row that is already
   * tight on a phone, and neither is reached often enough to earn a permanent
   * place. Two shallow menus rather than one long one: a bottom sheet with
   * eleven items in it is a list to scroll, which is the opposite of the point.
   */
  const RATES = [0.75, 1, 1.25, 1.5, 2]
  const rateLabel = (rate: number) => (rate === 1 ? t('보통') : `${rate}x`)

  const moreButton = h('button', { class: 'mr', 'data-nav': '', title: t('더보기') }, icon('more', 18))

  const showSpeedMenu = () =>
    showMenu(
      shell.overlay,
      moreButton,
      RATES.map((rate) => ({
        label: rateLabel(rate),
        icon: engine.state.rate === rate ? ('check' as const) : undefined,
        onSelect: () => {
          engine.setRate(rate)
          drawBar()
        },
      })),
    )

  const showSleepMenu = () => {
    const items: Array<MenuItem | '-'> = [15, 30, 60].map((minutes) => ({
      label: `${minutes}분 뒤 정지`,
      icon: 'moon' as const,
      onSelect: () => {
        engine.sleepIn(minutes)
        toast(shell.overlay, `${minutes}분 뒤에 멈춥니다.`)
        drawBar()
      },
    }))
    items.push({
      label: t('이 곡 끝나고 정지'),
      icon: 'moon',
      onSelect: () => {
        engine.sleepAfterTrack()
        toast(shell.overlay, t('이 곡이 끝나면 멈춥니다.'))
        drawBar()
      },
    })
    if (engine.sleep) {
      items.push('-', {
        label: t('수면 예약 끄기'),
        icon: 'close',
        onSelect: () => {
          engine.cancelSleep()
          toast(shell.overlay, t('수면 예약을 껐습니다.'))
          drawBar()
        },
      })
    }
    showMenu(shell.overlay, moreButton, items)
  }

  moreButton.addEventListener('click', () => {
    const left = engine.sleepLeft()
    const sleepSub = engine.sleep
      ? left !== undefined
        ? ` (${left}분 남음)`
        : ` (${t('이 곡까지')})`
      : ''
    showMenu(shell.overlay, moreButton, [
      { label: `${t('재생 속도')} · ${rateLabel(engine.state.rate)}`, icon: 'next', onSelect: showSpeedMenu },
      { label: `${t('수면 예약')}${sleepSub}`, icon: 'moon', onSelect: showSleepMenu },
      '-',
      {
        label: rating === 'dislike' ? t('관심 없음 취소') : t('관심 없음'),
        icon: 'thumbDown',
        onSelect: () => setRating(new Event('menu'), 'dislike'),
      },
    ])
  })


  /**
   * The two things the overflow menu was hiding, as buttons of their own.
   *
   * Only on a phone, and only in the opened player — where the volume slider
   * used to be, and it went because the device it was drawn on refuses to be
   * set from script. The room it leaves is better spent on the controls that
   * were two presses away behind ⋯, which is where the menu goes on that
   * screen: with both of its items promoted it has nothing left to show.
   *
   * Speed wears its own value rather than a glyph. There is no icon in this
   * set that reads as speed, and `next` — the one the menu uses — is the skip
   * button sitting two places along in the same row.
   */
  const speedButton = h('button', { class: 'sp', 'data-nav': '', title: t('재생 속도') }, '1x')
  speedButton.addEventListener('click', showSpeedMenu)
  const sleepButton = h('button', { class: 'sl', 'data-nav': '', title: t('수면 예약') }, icon('moon', 18))
  sleepButton.addEventListener('click', showSleepMenu)

  /**
   * The picture, turned on and off where you are watching.
   *
   * It was a switch in the sidebar, which is the wrong place for it: the
   * moment you want the picture is the moment a music video starts, and by
   * then you are looking at the player, not the menu. One button in the bar,
   * pressed as often as you like.
   *
   * A phone has two states, because there is nowhere for a corner window to
   * float on 390 pixels. A desktop has three, so the picture can sit in the
   * corner while you read a list — the placement menu used to offer that and
   * this is where it went.
   *
   * The list's shape follows the big one: watching is 영상, and 영상 draws
   * thumbnails.
   */
  // One picture layout, 꽉 채움(영화관). The right-hand watch column was a
  // second layout to tell apart, and the owner asked to drop it and keep the
  // fill only (2026-09-07, "안되면 꽉채움만"). So the button is a plain toggle.
  const videoOrder = (): Placement[] => ['hidden', 'stage']
  const videoButton = h('button', { class: 'vid', 'data-nav': '', title: t('화면 보기') }, icon('video', 18))
  videoButton.addEventListener('click', () => {
    const order = videoOrder()
    const next = order[(order.indexOf(engine.state.video) + 1) % order.length]!
    engine.setMode(next === 'hidden' ? 'music' : 'video')
    setLayout(next)
  })

  const queueButton = h('button', { 'data-nav': '', title: t('대기열') }, icon('queue', 18))
  queueButton.addEventListener('click', () => ctx.go({ kind: 'queue' }))

  // ── The words ────────────────────────────────────────────────────────────
  //
  // youtube.com has no lyrics; it has captions, and for a song those are the
  // same words with timings on them. So the pane is the transcript, followed
  // along as it plays. A video without captions says so rather than spinning.
  const lyricsPane = h('div', { class: 'lyrics' })
  let lyricLines: api.Line[] = []
  let lyricsOf = ''
  let lyricAt = -1

  function drawLyrics(): void {
    replace(
      lyricsPane,
      lyricLines.length === 0
        ? h('div', { class: 'lyricsEmpty' }, t('가사를 찾지 못했습니다.'))
        : lyricLines.map((line, i) =>
            h(
              'button',
              {
                class: 'lyricLine',
                'data-nav': '',
                onclick: () => engine.seek(line.at),
              },
              line.text,
            ),
          ),
    )
    lyricAt = -1
  }

  async function loadLyrics(): Promise<void> {
    const track = engine.current
    if (!track || lyricsOf === track.videoId) return
    lyricsOf = track.videoId
    // The words arrive as lines, so they are awaited as lines: grey bars of
    // varying width standing where the verses will land.
    replace(
      lyricsPane,
      ...Array.from({ length: 5 }, (_, i) =>
        // 14px between the bars, not zero: the real lines are set at
        // line-height 1.7 and a stack of bars with no air between them reads
        // as one grey block rather than as words on their way.
        h('div', { class: 'lyricLine sk', style: `width: ${46 + ((i * 17) % 3) * 14}%; margin: 14px auto; height: 18px` }),
      ),
    )
    try {
      lyricLines = await api.lyrics(ctx.cfg, track.videoId)
    } catch {
      lyricLines = []
    }
    if (lyricsOf === engine.current?.videoId) drawLyrics()
  }

  const lyricsButton = h('button', { 'data-nav': '', title: t('가사') }, icon('note', 18))
  lyricsButton.addEventListener('click', () => {
    const open = !app.classList.contains('lyrics-open')
    app.classList.toggle('lyrics-open', open)
    lyricsButton.classList.toggle('on', open)
    if (open) void loadLyrics()
  })

  /** Moves the highlight, and keeps it in the middle of the pane. */
  function followLyrics(seconds: number): void {
    if (!app.classList.contains('lyrics-open') || lyricLines.length === 0) return
    // Words that arrived without timings. They are worth reading and there is
    // nothing to follow, so the pane holds still rather than lighting a line
    // at random.
    if (lyricLines[0]!.at < 0) return
    let i = lyricLines.length - 1
    while (i > 0 && lyricLines[i]!.at > seconds) i--
    if (i === lyricAt) return
    lyricAt = i
    const kids = lyricsPane.children
    for (let k = 0; k < kids.length; k++) kids[k]!.classList.toggle('on', k === i)
    const line = kids[i] as HTMLElement | undefined
    if (line) {
      lyricsPane.scrollTo({ top: line.offsetTop - lyricsPane.clientHeight / 2 + line.clientHeight / 2, behavior: 'smooth' })
    }
  }

  // ── The bar, and the full player it becomes on a phone ───────────────────
  //
  // **One set of controls, two layouts.** A phone has no room for a track, a
  // transport, a seek bar and four buttons on one line, and every attempt to
  // fit them made the bar a row of stamps. So on a narrow screen the bar shows
  // the track and two buttons, with the progress drawn as a hairline along its
  // top edge, and tapping it opens the same element full-screen with
  // everything on it. Rearranged entirely in CSS, so there is no second player
  // to keep in step and nothing extra to wire.
  const sheetClose = h(
    'button',
    { class: 'sheetClose', 'data-nav': '', title: t('내리기'), 'aria-label': t('내리기'), onclick: () => setSheet(false) },
    icon('down', 22),
  )
  /**
   * The heart, which is YouTube's own Like.
   *
   * Not a favourite of ours: a mark that lives only in this extension would be
   * a second, private opinion about a song that the account already has a word
   * for, and it would not be there tomorrow on the phone. Pressing this is the
   * same as pressing Like on the page.
   *
   * Beside the track rather than in the row of controls on the right: it is
   * about *this song*, not about playback, and that row is already full on a
   * phone.
   */
  // One heart, by the user's word (2026-09-04): "좋아요는 하트 한 칸으로".
  // The pair of thumbs is gone from the bar; 관심 없음 lives in the ⋯ menu,
  // where a decision about the track that also skips it belongs.
  const upButton = h('button', { class: 'rate up', 'data-nav': '', title: t('좋아요') }, icon('heart', 18))
  const rateBox = h('div', { class: 'rate-box' }, upButton)
  /** The track the heart describes, and what YouTube said about it. */
  let ratedOf = ''
  let rating: api.LikeStatus = 'none'

  function drawRating(): void {
    const liked = rating === 'like'
    upButton.classList.toggle('on', liked)
    replace(upButton, icon(liked ? 'heartFill' : 'heart', 18))
    upButton.title = liked ? t('좋아요 취소') : t('좋아요')
    upButton.disabled = !engine.current
  }

  /**
   * Asks YouTube what this listener already thinks of the track, once per track.
   *
   * A failure leaves both buttons unlit and says nothing. Signed out the answer
   * is a truthful "no opinion" rather than an error, and someone who is only
   * listening should not be told about it.
   */
  function loadRating(): void {
    const track = engine.current
    if (!track) {
      ratedOf = ''
      rating = 'none'
      return drawRating()
    }
    if (ratedOf === track.videoId) return
    ratedOf = track.videoId
    rating = 'none'
    drawRating()
    void api
      .likeStatus(ctx.cfg, track.videoId)
      .then((status) => {
        // The track may have moved on while we were asking.
        if (ratedOf !== engine.current?.videoId) return
        rating = status
        drawRating()
      })
      .catch(() => {
        /* no opinion is the honest default */
      })
  }

  /**
   * One rating per video, which is YouTube's own rule: liking something that
   * was disliked clears the dislike, and there is one call to clear either.
   * Pressing the lit one is how you take it back.
   */
  const setRating = (ev: Event, wanted: api.LikeStatus): void => {
    // The bar's track is a button of its own on a phone — it opens the player.
    ev.stopPropagation()
    const track = engine.current
    if (!track) return
    const was = rating
    const next = rating === wanted ? 'none' : wanted
    // Lit before YouTube answers, because a button that waits for the network
    // reads as a button that did not take the press. Put back if refused.
    rating = next
    drawRating()
    const done =
      next === 'like'
        ? api.like(ctx.cfg, track.videoId)
        : next === 'dislike'
          ? api.dislike(ctx.cfg, track.videoId)
          : api.unlike(ctx.cfg, track.videoId)
    // 관심 없음 is a decision about what to listen to, not a note for later.
    // Pressing it takes the track out of the queue and moves on, which is what
    // the word means when it is said about something that is playing: the
    // engine loads whatever now stands at that index, so the next song starts
    // by itself. Only on the way in — pressing a lit thumb clears the rating
    // and must not skip anything.
    if (next === 'dislike') {
      const at = engine.state.index
      if (at >= 0 && engine.state.queue[at]?.videoId === track.videoId) {
        engine.removeAt(at)
        toast(shell.overlay, t('관심 없음으로 표시하고 건너뜁니다.'))
      }
      void alsoDropFromPlaylist(track)
    }
    void done.catch((err: unknown) => {
      if (ratedOf === track.videoId) {
        rating = was
        drawRating()
      }
      // explain()'s auth line is written for a screen you cannot see. This is
      // a thing you cannot *do*, which wants different words.
      const kind = (err as { kind?: string } | null)?.kind
      toast(shell.overlay, kind === 'auth' ? t('평가는 유튜브에 로그인해야 누를 수 있습니다.') : explain(err), true)
    })
  }

  /**
   * And out of the list it came from, if that is what the reader wants.
   *
   * Asked once and remembered. The button's whole point is one press, so a
   * dialog on every dislike would be three — but this is a real edit to a real
   * playlist, and doing it silently the first time would be a deletion nobody
   * agreed to. Only for a track that carries both a list to remove it from and
   * the handle YouTube needs to do it, which together mean it is one of the
   * reader's own lists.
   */
  async function alsoDropFromPlaylist(track: Track): Promise<void> {
    const list = track.fromPlaylist
    if (!list || !track.setVideoId) return
    let wanted = dislikeRemoves()
    if (wanted === null) {
      const named = ctx.playlists.find((p) => p.id === list)?.title
      wanted = await confirm(
        shell.overlay,
        named ? `'${named}'에서도 뺄까요? 이 선택을 기억합니다.` : t('재생목록에서도 뺄까요? 이 선택을 기억합니다.'),
        t('빼기'),
      )
      setDislikeRemoves(wanted)
    }
    if (!wanted) return
    try {
      await api.removeFromPlaylist(ctx.cfg, list, track)
      toast(shell.overlay, t('재생목록에서도 뺐습니다.'))
    } catch (err) {
      toast(shell.overlay, explain(err), true)
    }
  }

  upButton.addEventListener('click', (ev) => setRating(ev, 'like'))

  const ctl = h('div', { class: 'ctl' }, shuffleButton, prevButton, playButton, nextButton, repeatButton)
  // 대기열 first and the picture last, on every screen alike: the user's
  // word on 2026-09-04, "재생목록이 가장 왼쪽, 영상 모드는 항상 우측 끝".
  // The heart leads the right-hand row on every screen. Beside the title it
  // took the title's room in a column that has little: "하트 위치가 제목
  // 짜르고 있네" (2026-09-04). The title's column is the title's.
  const rightRow = h('div', { class: 'right' }, rateBox, queueButton, lyricsButton, speedButton, sleepButton, moreButton, muteButton, volume, videoButton)
  const now = h('div', { class: 'now' }, nowThumb, h('div', { class: 'nowText' }, nowTitle, nowBy))
  // The track itself is the handle: a phone opens the player by tapping what
  // is playing, which is what every music app has taught. It is a button on a
  // narrow screen only — on a desktop the bar is already showing everything,
  // and a click that did nothing visible would only puzzle.
  now.addEventListener('click', () => {
    if (app.classList.contains('narrow') && !app.classList.contains('sheet-open')) setSheet(true)
  })

  bar.append(
    sheetClose,
    now,
    h(
      'div',
      { class: 'center' },
      ctl,
      h('div', { class: 'seek' }, elapsed, seek, total),
    ),
    lyricsPane,
    rightRow,
  )

  function setSheet(open: boolean): void {
    // The other half of the rule above.
    if (open) {
      app.classList.remove('drawer-open')
      shell.cover(false)
    }
    app.classList.toggle('sheet-open', open)
    seatSlot()
    if (!open) {
      app.classList.remove('lyrics-open')
      lyricsButton.classList.remove('on')
    }
    if (open) sheetClose.focus()
  }

  function drawBar(): void {
    const track = engine.current
    nowTitle.textContent = track ? track.title : t('재생 중인 항목 없음')
    nowBy.textContent = track ? track.byline : ''
    nowThumb.style.backgroundImage = track ? `url(${thumbnail(track.videoId)})` : ''
    app.style.setProperty('--art', track ? `url(${thumbnail(track.videoId)})` : 'none')
    shuffleButton.classList.toggle('on', engine.state.shuffle)
    repeatButton.classList.toggle('on', engine.state.repeat !== 'off')
    replace(repeatButton, icon(engine.state.repeat === 'one' ? 'repeatOne' : 'repeat', 18))
    repeatButton.title = { off: t('반복 안 함'), all: t('전체 반복'), one: t('한 곡 반복') }[engine.state.repeat]
    replace(muteButton, icon(engine.muted ? 'mute' : 'volume', 18))
    speedButton.textContent = engine.state.rate === 1 ? '1x' : `${engine.state.rate}x`
    speedButton.classList.toggle('on', engine.state.rate !== 1)
    sleepButton.classList.toggle('on', engine.sleep !== undefined)
    // The thumb as well as the track. Only the fill was being set, so muting
    // with the m key left the slider sitting at 100 with the sound off — the
    // one place a person looks to find out how loud it is.
    volume.value = String(engine.state.volume)
    fill(volume, engine.state.volume / 100)
    // The glyph is the *next* state, not the current one: a button showing a
    // crossed-out camera while the picture is already off says nothing about
    // what it does. Pressed, it shows the picture — so it shows a camera.
    // The cycle is 소리만 → 영화관 → 시청(대기열 곁) on a desktop, 소리만 →
    // 영화관 on a phone. The glyph and title name what the next press does.
    // Two states: 소리만(hidden) and 영상(stage, 꽉 채움). The glyph names the
    // next press — a camera to show the picture, a crossed camera to hide it.
    const where = engine.state.video
    replace(videoButton, icon(where === 'hidden' ? 'video' : 'videoOff', 18))
    videoButton.className = where === 'hidden' ? 'vid' : 'vid on'
    videoButton.title = where === 'hidden' ? t('화면 보기') : t('소리만 듣기')
    prevButton.disabled = engine.state.queue.length === 0
    nextButton.disabled = engine.state.queue.length === 0
    loadRating()
    // Lit while either of the things behind it is doing something, because a
    // player running at 1.5x with a timer armed should say so somewhere.
    const armed = engine.state.rate !== 1 || engine.sleep !== undefined
    moreButton.classList.toggle('on', armed)
    moreButton.title = armed
      ? [engine.state.rate !== 1 ? `${engine.state.rate}x` : '', engine.sleep ? t('수면 예약') : '']
          .filter(Boolean)
          .join(' · ')
      : t('더보기')
  }

  /** What the volume control was last told to do, so the bar is not restyled twice a second. */
  let volumeShown: boolean | undefined
  /** Which of the three faces the play button is wearing, for the same reason. */
  let playGlyph: 'wait' | 'pause' | 'play' | undefined

  function drawTick(): void {
    const p = engine.position
    // A device that ignores the volume gets no volume slider. On iOS the
    // hardware buttons are the only control there has ever been, and drawing
    // a slider that cannot move is the product telling a lie about itself.
    // Mute stays: that one the platform does honour.
    const canVolume = engine.volumeSettable !== false
    if (canVolume !== volumeShown) {
      volumeShown = canVolume
      volume.style.display = canVolume ? '' : 'none'
    }
    // Nothing loaded yet: the slot is a skeleton rather than a black hole.
    slot.classList.toggle('warming', p.duration <= 0)
    // YouTube-core: a load is playing-in-waiting and wears the pause glyph,
    // exactly as YouTube's own bar does — a fetch must never read as stopped.
    // Only a wait that has outlasted its welcome turns the glyph to stop:
    // playback is genuinely stuck, and pressing it halts the track (a
    // buffering player pauses; the next tick shows play again).
    // A wait is drawn as a wait. The stop square said "this is stopped" about
    // a track that was in fact loading — and often playing a second later, so
    // the one glyph meant two opposite things. A ring turning inside the
    // button says the only true thing: it is coming. Pressing it still halts.
    //
    // **Redrawn only when it changes.** This function runs twice a second, and
    // it used to replace the button's contents every time — which is nothing
    // to a static glyph and fatal to a turning one: the ring was rebuilt every
    // 500ms and its rotation started again from zero, so it turned in visible
    // jerks rather than smoothly. Reported as 부드럽지 않게 빙빙 돈다.
    app.classList.toggle('paused', !p.playing)
    // A wait that has gone on past the stall clock is not a wait any more:
    // on an iPhone a load the page was not allowed to start sits there for
    // ever, and a spinner that never stops is a transport with no button on
    // it. Past the clock it shows play, and the press is what starts it.
    const want = p.stalled ? 'play' : p.buffering ? 'wait' : p.playing ? 'pause' : 'play'
    if (want !== playGlyph) {
      playGlyph = want
      replace(playButton, want === 'wait' ? h('span', { class: 'spin' }) : icon(want, 20))
      playButton.title = want === 'wait' ? t('불러오는 중…') : t('재생 / 일시정지')
    }
    total.textContent = clock(p.duration)
    if (!scrubbing) {
      elapsed.textContent = clock(p.current)
      followLyrics(p.current)
      const ratio = p.duration > 0 ? p.current / p.duration : 0
      seek.value = String(Math.round(ratio * 1000))
      fill(seek, ratio)
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────

  // Rotating a phone, or dragging a window, changes the answer.
  const onResize = () => {
    const narrow = narrowNow()
    if (narrow === app.classList.contains('narrow')) return
    app.classList.toggle('narrow', narrow)
    // A remote should not be able to land on the track block where tapping it
    // does nothing, and must be able to where it opens the player.
    if (narrow) now.setAttribute('data-nav', '')
    else now.removeAttribute('data-nav')
    if (!narrow) {
      setDrawer(false)
      app.classList.remove('sheet-open')
    }
  }
  window.addEventListener('resize', onResize)

  // Escape closes the player, then the drawer. The second Escape within a
  // second still leaves the mode — that is shell.ts, on the document in the
  // capture phase, and nothing here consumes the key.
  const onEscape = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    if (app.classList.contains('sheet-open')) app.classList.remove('sheet-open')
    else if (app.classList.contains('drawer-open')) closeDrawer()
  }

  document.addEventListener('keydown', onEscape)
  // Adding a viewport meta reflows the page; on some engines that lands
  // without a resize event, so the first two frames are checked directly.
  requestAnimationFrame(onResize)
  setTimeout(onResize, 300)

  // ── Swipe back ───────────────────────────────────────────────────────────
  //
  // A phone expects the edge swipe to go back, and here it could not: the app
  // never changes the URL — that is the promise that leaving is a deletion —
  // so the browser's own gesture has no history of ours to walk and would take
  // the whole page off YouTube instead.
  //
  // **It only starts within 24px of the left edge.** A swipe that could start
  // anywhere would fight the shelves, which are horizontal scrollers, and the
  // seek bar. That is also where a phone teaches people to start it.
  let swipeX = 0
  let swipeY = 0
  let swiping = false
  const onTouchStart = (ev: TouchEvent) => {
    const t = ev.touches[0]
    if (!t || !app.classList.contains('narrow')) return
    swiping = t.clientX <= 24
    swipeX = t.clientX
    swipeY = t.clientY
  }
  const onTouchMove = (ev: TouchEvent) => {
    if (!swiping) return
    const t = ev.touches[0]
    if (!t) return
    if (Math.abs(t.clientY - swipeY) > 44) {
      swiping = false
      return
    }
    if (t.clientX - swipeX < 70) return
    swiping = false
    goBack()
  }
  const onTouchEnd = () => {
    swiping = false
  }

  /** Closes what is on top, else steps back through the screens. */
  function goBack(): void {
    if (app.classList.contains('sheet-open')) return setSheet(false)
    if (app.classList.contains('drawer-open')) return closeDrawer()
    const previous = trail.pop()
    if (!previous) return
    // Not ctx.go: that would push the screen we are leaving onto the trail and
    // the gesture would walk between two screens forever.
    ctx.view = previous
    engine.setView(nameOf(previous))
    drawTop()
    drawSide()
    void render(ctx, main)
    main.scrollTop = 0
  }

  app.addEventListener('touchstart', onTouchStart, { passive: true })
  app.addEventListener('touchmove', onTouchMove, { passive: true })
  app.addEventListener('touchend', onTouchEnd, { passive: true })

  // ── Typing ───────────────────────────────────────────────────────────────
  //
  // **YouTube eats letters out of our search box.** Its shortcuts live on the
  // document — c for captions, k for play/pause, m for mute, f, j, l, i, t, o,
  // and the digits for seeking — and it decides whether to swallow a key by
  // looking at the event's target. Our input is in a shadow root, so by the
  // time the event reaches the document it has been retargeted to the host
  // element: not a text field as far as YouTube can tell, so it takes the key
  // and calls preventDefault. Typing 'c' did nothing at all.
  //
  // Stopped here, at the app, on the way up — before the document ever sees
  // it. shell.ts's panic key and the remote both listen in the capture phase,
  // which runs first, so neither loses anything.
  // **The first tap is what makes playback possible on iOS.**
  //
  // WebKit lets script drive a media element only after a gesture has started
  // that element at least once, and loadVideoById is asynchronous — by the
  // time it has a source, the activation that asked for it is spent, so the
  // track sits there loaded and paused. Playing and immediately pausing the
  // element that is already there costs nothing visible and hands over the
  // permission for the rest of the session. Once.
  let unlocked = false
  const unlockOnFirstTouch = () => {
    if (unlocked) return
    // Not while the arrival is being held: the element is paused on purpose,
    // this would start it, and the press that follows a beat later would read
    // it as playing and pause it again, so the press did nothing. Measured.
    // The press itself unlocks through the engine, which does the same
    // dance inside toggle() and load().
    if (engine.arrivalHeld) return
    unlocked = true
    const el = document.querySelector('video')
    if (!el || !el.paused) return
    void Promise.resolve(el.play())
      .then(() => el.pause())
      .catch(() => {
        unlocked = false
      })
  }
  app.addEventListener('pointerdown', unlockOnFirstTouch, { capture: true })

  const onKeyInField = (ev: KeyboardEvent) => {
    const el = ev.composedPath()[0] as HTMLElement | undefined
    if (!el) return
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) ev.stopPropagation()
  }
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    app.addEventListener(type, onKeyInField)
  }

  const offRemote = installRemote(shell.root, shell.overlay)
  // The keyboard, so the whole thing can be driven from a sofa. `v` reuses the
  // bar's own button rather than repeating what it decides.
  const offKeys = installKeys(engine, { toggleVideo: () => videoButton.click(), openSearch: () => ctx.search() })

  // The picture is up while something is playing and gone when nothing is —
  // asked for in those words ("재생할때는 위쪽에 플레이어 보여주고"), and it
  // answers the question the lists cannot: whether what you are hearing is a
  // video or a song. Choosing 구석에 두기 or 소리만 듣기 from the bar still
  // wins until the next track.
  /**
   * Where the picture goes when something is playing.
   *
   * A phone gets the stage: there is nowhere to float on 390 pixels, and a
   * window over the list is a window over the thing you are reading. A desktop
   * gets the stage on the screens that are about pictures and the corner
   * window on a track list, which is what the room is for.
   */
  function pictureNow(): VideoLayout {
    if (!engine.current) return 'hidden'
    if (engine.state.mode === 'video') return 'stage'
    // Music: nothing at all. The corner window a desktop used to get here was
    // a window over the list being read, with YouTube's controls on it, and
    // was taken for a stray PiP (2026-09-06). Leaving the stage up with the
    // switch off was the earlier bug, so pressing it still changes something.
    return 'hidden'
  }

  // The stage scrolls with the list on a desktop: as the browse list scrolls
  // up, the picture (and the watch column) ride up with it and out of the way,
  // rather than staying pinned to the top — the owner's main ask
  // ("재생위치 고정이 제일 문제야 스크롤이 가능해야한다구야"). The slot moves by
  // CSS (--stage-scroll) and the player follows it through the shell's scroll
  // tracking. A phone is left alone; its stage was fine pinned. Clamped to the
  // slot's own height so it parks off the top and the list then has the screen.
  //
  // The stage height is measured once and cached, not read on every scroll:
  // getBoundingClientRect in the scroll handler forces a synchronous layout
  // each frame, which is the other half of the picture snagging on the way up
  // (2026-09-07). It is refreshed when the layout is (re)applied and on resize,
  // which is when the height can actually change.
  let stageHeight = 0
  function measureStage(): void {
    stageHeight = app.classList.contains('has-stage') || app.classList.contains('has-watch') ? slot.getBoundingClientRect().height : 0
  }
  function onMainScroll(): void {
    if (app.classList.contains('narrow') || stageHeight <= 0) return
    const y = Math.min(main.scrollTop, stageHeight)
    document.documentElement.style.setProperty('--stage-scroll', `${y}px`)
  }
  main.addEventListener('scroll', onMainScroll, { passive: true })
  window.addEventListener('resize', measureStage, { passive: true })

  let showing = engine.current?.videoId
  const offChange = engine.subscribe(() => {
    const id = engine.current?.videoId
    if (id !== showing) {
      showing = id
      setLayout(pictureNow())
      if (app.classList.contains('lyrics-open')) void loadLyrics()
    }
    if (app.classList.contains('has-watch')) drawUpnext()
    drawBar()
    if (ctx.view.kind === 'queue') ctx.reload()
  })
  const offTick = engine.onTick(drawTick)

  // Put the remembered choice back before the first paint, so neither the page
  // nor the app flashes the wrong side.
  if (engine.state.theme !== 'auto') setYouTubeDark(engine.state.theme === 'dark')
  applyTheme()
  if (narrowNow()) now.setAttribute('data-nav', '')
  drawTop()
  drawSide()
  drawBar()
  drawTick()
  setLayout(pictureNow())
  // The splash comes down once the first view has painted — on failure too,
  // because an error screen is still a screen — but never before, or the
  // half-built app would show through the hole it leaves.
  render(ctx, main).catch(() => {}).then(() => shell.hideSplash())

  // The sidebar's playlist list arrives late and is not worth blocking on.
  void ctx.refreshPlaylists().then(drawSide).catch(() => {})

  return {
    ctx,
    destroy() {
      // Or the panel outlives the mode: its hold on the dialog count and its
      // Escape listener are module state, and left open across a re-entry it
      // kept every shortcut and the twice-to-leave dead.
      closeSearch()
      closeChannels()
      closeSettings()
      themeWatch.disconnect()
      window.removeEventListener('resize', onResize)
      document.removeEventListener('keydown', onEscape)
      offRemote()
      offKeys()
      offChange()
      offTick()
    },
  }
}

/** What the header calls the screen. The same words the sidebar uses. */
function titleOf(view: View): string {
  switch (view.kind) {
    case 'explore':
      return t('음악')
    case 'home':
      return t('홈')
    case 'subs':
      return t('구독')
    case 'history':
      return t('시청 기록')
    case 'playlists':
      return t('재생목록')
    case 'queue':
      return t('대기열')
    case 'channels':
      return t('채널')
    case 'myvideos':
      return t('내 동영상')
    case 'topic':
      return t(topicTitle(view.id))
    case 'playlist':
    case 'channel':
      return view.title
  }
}

/** The view name that survives a reload, and its way back. */
function nameOf(view: View): string {
  if (view.kind === 'playlist') return `playlist:${view.id}:${view.title}`
  if (view.kind === 'channel') return `channel:${view.id}:${view.title}`
  if (view.kind === 'topic') return `topic:${view.id}`
  return view.kind
}

/** `prefix:id:title` back into its parts, or undefined when it is not one. */
function splitName(name: string, prefix: string): { id: string; title: string } | undefined {
  if (!name.startsWith(`${prefix}:`)) return undefined
  const rest = name.slice(prefix.length + 1)
  const cut = rest.indexOf(':')
  if (cut <= 0) return undefined
  return { id: rest.slice(0, cut), title: rest.slice(cut + 1) }
}

function viewFromName(name: string): View {
  const playlist = splitName(name, 'playlist')
  if (playlist) return { kind: 'playlist', ...playlist }
  const channel = splitName(name, 'channel')
  if (channel) return { kind: 'channel', ...channel }
  if (name.startsWith('topic:')) {
    // Only a topic the menu still has. A saved screen for a feed that has
    // since gone would otherwise be asked for on every load.
    const id = name.slice('topic:'.length)
    const line = MENU.find((l) => l.view.kind === 'topic' && l.view.id === id)
    if (line) return line.view
  }
  switch (name) {
    case 'explore':
    case 'home':
    case 'subs':
    case 'history':
    case 'playlists':
    case 'queue':
    case 'channels':
    case 'myvideos':
      return { kind: name }
    // 최근 감상 was its own screen until 시청 기록 absorbed it. A browser that
    // was last left there has this name written down, and dropping it would
    // land that reload on 둘러보기 instead of the screen it means.
    case 'recent':
      return { kind: 'history' }
    default:
      return { kind: 'explore' }
  }
}
