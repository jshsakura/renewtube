// Entry. Decides whether the mode is on, and if it is, puts it up.
//
// The order matters and is the safety story in miniature:
//
//   1. Read the flag. Off is the default and the fast path — the script stops
//      here on a page nobody asked to change.
//   2. Mount the shell (one stylesheet, one host). YouTube is now hidden.
//   3. From here on, every failure exits rather than reports. A stuck loading
//      screen over a hidden page is worse than no extension at all.

import { pickLang, setLang, t } from '../shared/i18n.ts'
import * as api from './api.ts'
import { Engine } from './engine.ts'
import { bindMediaSession } from './session.ts'
import { keepAwake } from './awake.ts'
import { InnertubeError } from './innertube.ts'
import type { Playlist, Track } from './parse.ts'
import { videoIdInUrl, waitForPlayer } from './player.ts'
import { alreadyMounted, mount, type Shell } from './shell.ts'
import { save, setQuickOn } from './store.ts'
import { DEFAULT_CONFIG, NS, isOurs, type Config, type ToIsolated, type ToMain } from '../shared/messages.ts'
import { diagnose } from './ui/diagnose.ts'
import { version } from '../shared/version.ts'
import { mountApp } from './ui/app.ts'
import { explain, type Ctx } from './ui/ctx.ts'
import { pick, toast } from './ui/overlay.ts'
import { isYouTubeSettings } from './ytsettings.ts'
import { waitForYtCfg } from './ytcfg.ts'

// ── Which world is this? ───────────────────────────────────────────────────
//
// `world: "MAIN"` is a Chrome manifest key. Browsers that do not implement it
// do not fail — they load this same file into the ISOLATED world, where
// `window.ytcfg` and `#movie_player`'s methods are invisible and the whole
// product is a blank screen. Orion, which is where this extension actually
// lives, is one of them.
//
// `chrome.runtime.id` is the exact test: it is the extension's id in an
// isolated content script, and undefined on a page. So the copy that landed in
// the wrong world stops here, says nothing, and lets the isolated side inject
// a copy into the right one.
const inPageWorld = (globalThis as { chrome?: { runtime?: { id?: string } } }).chrome?.runtime?.id === undefined

// And once there, exactly one copy runs. Two scripts in the same world share
// globals, so the manifest's copy and an injected one cannot both proceed.
const CLAIM = '__ocEasyModeRunning'

/**
 * Announces which world we are in, asks for the setting, and starts if the
 * fast flag already says to.
 *
 * Called from the very bottom of this file rather than here, because it reads
 * module state that is declared below: a `let` is not merely undefined before
 * its line, it throws.
 */
function boot(): void {
  window.postMessage({ ns: NS, type: 'main-ready' } satisfies ToIsolated, location.origin)
  ask({ ns: NS, type: 'get-config' })
  if (config.musicMode) void start()
}

// ── The switch ─────────────────────────────────────────────────────────────
//
// Two sources say whether the mode is on, and they answer at different times.
// `localStorage` answers now, which is what a page load needs; `chrome.storage`
// answers in a few hundred milliseconds and is what the toolbar writes to.
// The fast one is a cache of the slow one, written whenever the slow one speaks.

let config: Config = { ...DEFAULT_CONFIG, musicMode: quickFlag() }
let running: Runtime | null = null

function quickFlag(): boolean {
  try {
    return localStorage.getItem('oc-easy-mode:on') === '1'
  } catch {
    return false
  }
}

function ask(msg: ToIsolated): void {
  window.postMessage(msg, location.origin)
}

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !isOurs(ev.data)) return
  const msg = ev.data as ToMain
  if (msg.type === 'restart') {
    // Down and up again, with the mode left on: the queue is written down on
    // the way out and read back on the way in, so the music keeps playing and
    // the screen is built from nothing. For a screen that has gone wrong in a
    // way we have not reproduced, this is the way out that does not cost the
    // reader their place.
    leave(false)
    setQuickOn(true)
    void start()
    return
  }
  if (msg.type === 'diagnose') {
    // The toolbar popup is asking. It asks because the screen may be the thing
    // that is broken, and the in-page report cannot be reached through a
    // half-drawn sheet — which is exactly the state this is wanted in. Answered
    // even when nothing is running, because "nothing is running" is an answer.
    let text: string
    try {
      text = running
        ? diagnose(running.engine, version())
        : `RenewTube ${version()} · ${new Date().toISOString()}\n${location.host}${location.pathname}\n모드가 꺼져 있거나 아직 뜨지 않았습니다.`
    } catch (e) {
      text = `RenewTube ${version()}\n진단을 만들지 못했습니다: ${String(e).slice(0, 200)}`
    }
    const out: ToIsolated = { ns: NS, type: 'diagnosis', text }
    window.postMessage(out, location.origin)
    return
  }
  if (msg.type !== 'config') return
  const was = config.musicMode
  config = msg.config
  setQuickOn(config.musicMode)
  if (config.musicMode && !was) void start()
  if (!config.musicMode && was) leave(false)
})

// ── Boot ───────────────────────────────────────────────────────────────────

interface Runtime {
  shell: Shell
  engine: Engine
  destroy(): void
}

let starting = false

// ── Standing aside for YouTube's own settings ──────────────────────────────
//
// **The mode declines to mount on /account and /view_all_settings; it does not
// switch itself off for them.**
//
// The two are not the same thing and the difference is the whole point. Those
// pages are YouTube's own, and there is no version of them for this UI to
// draw: mounting there hid the page and put up an app with nothing in it, a
// white screen that the watchdog then had to rescue. So we do not mount. But
// leaving is a separate act with a separate cost. `leave(true)` writes the
// switch off, so a reader who pressed 계정 would come home to plain YouTube
// and have to turn the mode on again by hand. That is not what pressing 계정
// asked for.
//
// So the switch is left exactly as it was, and the only thing that changes is
// whether this particular document mounts. Coming back is then not a
// restoration of anything: it is an ordinary page load that reads the flag,
// finds it still on, and starts. Nothing has to be remembered and nothing can
// be forgotten.
//
// The one case that needs more than that is YouTube navigating away from a
// settings page without a reload, which it does from its own header. The
// document that declined to mount is still the document, so `heldBack` marks
// that this is why nothing is up, and the navigation handler below starts the
// mode the moment the address is somewhere we belong. It is set only here, so
// a watchdog rescue or a panic exit can never be undone by it.
let heldBack = false

async function start(): Promise<void> {
  if (running || starting || alreadyMounted()) return
  if (isYouTubeSettings(location.pathname)) {
    heldBack = true
    return
  }
  starting = true
  let shell: Shell | undefined
  let wake: (() => void) | undefined
  try {
    // Before the first await, and before YouTube gets another turn to attach
    // player lifecycle listeners. A document-level listener installed after
    // the player cannot protect background audio on WebKit: the player's own
    // listener has already paused it by the time ours runs.
    wake = keepAwake()
    shell = mount((reason) => {
      // The panic key and the watchdog both mean the same thing: get out now.
      leave(reason === 'panic')
      if (reason === 'watchdog') {
        console.warn('[RenewTube] 화면을 띄우지 못해 원래 유튜브로 돌아갑니다.')
      }
    })

    const cfg = await waitForYtCfg()
    if (!cfg) throw new InnertubeError('ytcfg never appeared', 'shape')

    const engine = new Engine()
    // YouTube's own interface language decides ours unless the reader has
    // said otherwise. Reading one language on the page and another over it is
    // worse than either.
    setLang(pickLang(engine.state.lang, cfg.hl))
    const player = await waitForPlayer()
    if (player) engine.attach(player)

    let playlists: Playlist[] = []
    const base: Omit<Ctx, 'view' | 'go' | 'reload' | 'say' | 'search' | 'overlay'> = {
      engine,
      cfg,
      get playlists() {
        return playlists
      },
      async refreshPlaylists() {
        // Throws on purpose. The screen that asked wants to say why it is
        // empty; the sidebar, which asks in the background, catches and moves on.
        playlists = []
        playlists = await api.myPlaylists(cfg)
      },
      async addToPlaylist(tracks: Track[]) {
        const chosen = await pick(
          shell!.overlay,
          tracks.length > 0 ? `${tracks.length}개를 어디에 넣을까요?` : t('새 재생목록 만들기'),
          playlists.map((p) => ({ id: p.id, label: p.title, sub: p.subtitle })),
          t('새 재생목록 이름'),
        )
        if (chosen === null) return
        try {
          if (typeof chosen === 'object') {
            const id = await api.createPlaylist(cfg, chosen.create, tracks.map((t) => t.videoId))
            await base.refreshPlaylists()
            toast(shell!.overlay, `'${chosen.create}'을(를) 만들었습니다.`)
          } else {
            if (tracks.length === 0) return
            await api.addToPlaylist(cfg, chosen, tracks.map((t) => t.videoId))
            toast(shell!.overlay, `${tracks.length}개를 넣었습니다.`)
          }
        } catch (err) {
          toast(shell!.overlay, explain(err), true)
        }
      },
    }

    const app = mountApp({
      shell,
      engine,
      exit: () => leave(true),
      ctx: base,
    })

    // The lock screen and the headphone buttons, pointed at our queue rather
    // than at YouTube's autoplay.
    const unbindSession = bindMediaSession(engine)
    running = {
      shell,
      engine,
      destroy() {
        app.destroy()
        unbindSession()
        wake?.()
        engine.detach()
      },
    }

    if (!player) {
      toast(shell.overlay, t('유튜브 플레이어를 찾지 못했습니다. 항목을 고르면 열립니다.'))
    }
  } catch (err) {
    console.warn('[RenewTube] 시작하지 못했습니다:', err)
    wake?.()
    shell?.teardown()
    running = null
    leave(false)
  } finally {
    starting = false
  }
}

// ── Leaving ────────────────────────────────────────────────────────────────

/**
 * Puts the page back.
 *
 * `persist` is false when the switch was flipped elsewhere (the toolbar, or
 * another tab) — writing it back would fight whoever flipped it.
 *
 * The one thing that is not just "remove our two nodes": the address bar. We
 * play by telling the player what to load, which leaves the URL on whatever
 * was open when the mode started. Handing back a page whose URL and video
 * disagree is a confusing gift, so if they have drifted apart we navigate to
 * the track that is actually playing. Same video, real YouTube page.
 */
function leave(persist: boolean): void {
  const state = running
  running = null
  if (persist) {
    config = { ...config, musicMode: false }
    ask({ ns: NS, type: 'set-config', patch: { musicMode: false } })
  }
  setQuickOn(false)
  if (!state) return

  const playing = state.engine.current?.videoId
  // Asked before the engine is taken apart, because afterwards there is
  // nothing left to ask.
  //
  // The video element rather than the player's own state, because the two
  // disagree: `getPlayerState()` reports -1 while the element is plainly
  // playing — measured, with `paused` false and `currentTime` climbing. The
  // element cannot be wrong about whether sound is coming out of it.
  const el = document.querySelector('video')
  const sounding = state.engine.position.playing || (el !== null && !el.paused && !el.ended)
  save(state.engine.state)
  state.destroy()
  state.shell.teardown()

  // The URL is corrected only when correcting it is free.
  //
  // Navigating here reloaded the page, and a reload stops the music — you
  // leave the mode and the song you were listening to dies with it, which is
  // the one thing leaving must not do. replaceState looked like the way to
  // make the address agree without touching the player, and it is not:
  // **YouTube watches its own URL.** Pointing it at a different video makes
  // the page tear the player down and build it again — measured as pause,
  // emptied, loadstart, and the track starting over from zero. Quieter than a
  // reload, the same wound.
  //
  // So the address is only put right when nothing is playing. A stale address
  // beside a playing song is the smaller lie, and the next navigation clears
  // it anyway.
  if (playing && !sounding && playing !== videoIdInUrl()) {
    try {
      history.replaceState(history.state, '', `/watch?v=${playing}`)
    } catch {
      /* a browser that will not have it keeps the old address */
    }
  }
}

// ── Same-page navigation ───────────────────────────────────────────────────
//
// YouTube is a single-page app: it swaps the whole page under us without a
// reload, and takes the player with it. When that happens our reference is
// stale, so pick the new one up. `yt-navigate-finish` is the page's own signal
// and has been stable for years; the interval is the belt to its braces.

window.addEventListener('yt-navigate-finish', () => settle())
setInterval(() => settle(), 4000)

/** Picks the new player up, and comes back if we were only standing aside. */
function settle(): void {
  void reattach()
  if (!heldBack || !config.musicMode || isYouTubeSettings(location.pathname)) return
  heldBack = false
  void start()
}

async function reattach(): Promise<void> {
  if (!running) return
  const player = await waitForPlayer(3000)
  if (player) running.engine.attach(player)
}

// Everything is declared; now decide whether any of it should happen.
//
// A reload lands here with a queue already written down, so the fast flag is
// enough to start on: waiting for chrome.storage would show plain YouTube for
// a moment first, and then swap it away under the reader.
const claimed = (globalThis as Record<string, unknown>)[CLAIM] === true
if (inPageWorld && !claimed) {
  ;(globalThis as Record<string, unknown>)[CLAIM] = true
  boot()
}
