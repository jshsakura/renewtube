// A page that behaves like YouTube's, badly, on purpose.
//
// The playback failures that matter cannot be reproduced against the real site:
// they happen on a signed-in account, and every harness here runs signed out,
// where the player always plays. So the player is built here instead — the same
// API surface the engine drives, with the ways it is known to fail written down
// as behaviours that can be switched on by name.
//
// Nothing about the engine is faked. This is the real `Engine`, attached to a
// real `<video>` element, on a real page with a real address bar: a rescue that
// navigates really navigates, and the page it lands on is this one again with
// whatever behaviour the run asked for. What the tests assert is therefore the
// product's own recovery, not a model of it.

import { Engine } from '../../src/main/engine.ts'
import type { Track } from '../../src/main/parse.ts'
import type { YtPlayer } from '../../src/main/player.ts'

/** The ways a player is known to refuse a track. */
export type Fault =
  /** Takes the track and plays it, like a page in good health. */
  | 'healthy'
  /** Takes `loadVideoById` and does nothing at all: the signed-in home player. */
  | 'dormant'
  /** Loads the track, then sits on it: `play()` returns and nothing happens. */
  | 'loaded-paused'
  /** Refuses to start without a gesture, the way WebKit does. */
  | 'play-rejects'
  /** Plays the track while reporting Unstarted and ignoring the rate. */
  | 'stuck-unstarted'
  /** Wears the advert clothes for ever, with nothing playing underneath. */
  | 'ad-phantom'
  /** A real advert, then the track: the case that must not be rescued. */
  | 'ad-real'
  /** The element gives up on the source. */
  | 'error'
  /** Every call into the player throws. */
  | 'throws'
  /** Slow, but arriving: four seconds of waiting and then sound. */
  | 'slow'
  /** Waiting that never ends. */
  | 'stall'
  /** The page rebuilds its player a second after the track is handed over. */
  | 'swap'
  /** No player in the page at all: the case that has to navigate to find one. */
  | 'no-player'

export interface LabConfig {
  fault?: Fault
  /** Replaces `fault` once the address is a watch page. */
  watch?: Fault
  /** Replaces both on the second and later visits to the same address. */
  reload?: Fault
  /** When given, only these videos misbehave and everything else is healthy. */
  dead?: string[]
}

const CONFIG_KEY = 'lab:config'
const VISITS_KEY = 'lab:visits'

function readConfig(): LabConfig {
  const fromUrl = new URLSearchParams(location.search).get('lab')
  if (fromUrl) {
    try {
      sessionStorage.setItem(CONFIG_KEY, fromUrl)
    } catch {}
    return JSON.parse(fromUrl) as LabConfig
  }
  try {
    const raw = sessionStorage.getItem(CONFIG_KEY)
    if (raw) return JSON.parse(raw) as LabConfig
  } catch {}
  return {}
}

/** How many times this address has been opened in this tab, counting now. */
function countVisit(): number {
  let visits: Record<string, number> = {}
  try {
    visits = JSON.parse(sessionStorage.getItem(VISITS_KEY) ?? '{}') as Record<string, number>
  } catch {}
  const here = location.pathname + location.search.replace(/[?&]lab=[^&]*/, '')
  const n = (visits[here] ?? 0) + 1
  visits[here] = n
  try {
    sessionStorage.setItem(VISITS_KEY, JSON.stringify(visits))
  } catch {}
  return n
}

/**
 * Whether a press has happened in this page.
 *
 * WebKit refuses `play()` under script until a gesture has started media once,
 * and the refusal is not a broken track: it is a loaded one waiting for a
 * press. The `play-rejects` behaviour is that rule, so the press has to be able
 * to lift it or the test could only ever watch it fail.
 */
let gestureGiven = false

const config = readConfig()
const visit = countVisit()
const onWatch = /^\/watch/.test(location.pathname)

/** The behaviour this page runs with, before the per-video exemption. */
const pageFault: Fault =
  (visit > 1 ? config.reload : undefined) ?? (onWatch ? config.watch : undefined) ?? config.fault ?? 'healthy'

/** What `id` gets: the page's fault, unless the run named the ones that fail. */
function faultFor(id: string): Fault {
  if (config.dead && !config.dead.includes(id)) return 'healthy'
  return pageFault
}

// ── The log ────────────────────────────────────────────────────────────────
//
// Every call the engine makes into the player, in order, so a test can say
// "it pushed the track in a second time" rather than only "it eventually
// played". Kept across pages, because a rescue spends its rungs on both sides
// of a navigation.

const LOG_KEY = 'lab:log'
export interface LogLine {
  at: number
  what: string
  detail?: string
  where: string
}

function log(what: string, detail?: string): void {
  try {
    const lines = JSON.parse(sessionStorage.getItem(LOG_KEY) ?? '[]') as LogLine[]
    lines.push({ at: Date.now(), what, detail, where: location.pathname + location.search })
    sessionStorage.setItem(LOG_KEY, JSON.stringify(lines))
  } catch {}
}

// ── The element ────────────────────────────────────────────────────────────
//
// A real `<video>` node with the four properties that decide everything taken
// over: whether it is paused, whether it ended, whether it failed, and where it
// is. Real events, real listeners, real `isConnected` — so the engine's own
// bindings and its cache of the element work exactly as they do on YouTube.

interface FakeVideo extends HTMLVideoElement {
  labState: {
    paused: boolean
    ended: boolean
    error: MediaError | null
    currentTime: number
    readyState: number
    networkState: number
    /** Started, but with nothing arriving: what a buffering element looks like. */
    waiting: boolean
  }
}

const DURATION = 30

function makeVideo(): FakeVideo {
  const el = document.createElement('video') as FakeVideo
  el.labState = { paused: true, ended: false, error: null, currentTime: 0, readyState: 0, networkState: 0, waiting: false }
  const s = el.labState
  for (const [name, get] of [
    ['paused', () => s.paused],
    ['ended', () => s.ended],
    ['error', () => s.error],
    ['readyState', () => s.readyState],
    ['networkState', () => s.networkState],
  ] as const) {
    Object.defineProperty(el, name, { get, configurable: true })
  }
  Object.defineProperty(el, 'currentTime', {
    get: () => s.currentTime,
    set: (v: number) => {
      s.currentTime = v
    },
    configurable: true,
  })
  Object.defineProperty(el, 'duration', { get: () => (s.readyState > 0 ? DURATION : NaN), configurable: true })
  return el
}

// ── The player ─────────────────────────────────────────────────────────────

interface Fake {
  player: YtPlayer
  video: FakeVideo
}

function build(): Fake {
  const host = document.getElementById('stage')!
  host.textContent = ''
  const video = makeVideo()
  const player = document.createElement('div') as unknown as YtPlayer & { labApi: true }
  ;(player as unknown as HTMLElement).id = 'movie_player'
  const ads = document.createElement('div')
  ads.className = 'video-ads'
  host.append(player as unknown as HTMLElement, ads)
  ;(player as unknown as HTMLElement).append(video)

  const s = video.labState
  let loaded: string | undefined
  let state = -1
  let rate = 1
  let volume = 100
  let muted = false
  let quality = 'auto'
  let clock: number | undefined
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()

  const emit = (name: string): void => {
    for (const fn of listeners.get(name) ?? []) fn(state)
  }
  const fire = (name: string): void => {
    video.dispatchEvent(new Event(name))
  }

  /** Sound, and a clock that runs while there is. */
  const start = (): void => {
    s.paused = false
    s.ended = false
    s.waiting = false
    s.readyState = 4
    s.networkState = 2
    state = 1
    fire('playing')
    emit('onStateChange')
    if (clock !== undefined) return
    clock = window.setInterval(() => {
      if (s.paused || s.waiting) return
      s.currentTime = Math.min(DURATION, s.currentTime + 0.1)
      fire('timeupdate')
      if (s.currentTime >= DURATION && !s.ended) {
        s.ended = true
        s.paused = true
        state = 0
        fire('ended')
        emit('onStateChange')
      }
    }, 100)
  }

  /** Waiting: started, nothing arriving. Not paused, which is the whole point. */
  const wait = (): void => {
    s.paused = false
    s.waiting = true
    s.readyState = 0
    s.networkState = 2
    state = 3
    emit('onStateChange')
  }

  /** Loaded and sitting there, which is a paused element with data behind it. */
  const settle = (): void => {
    s.paused = true
    s.waiting = false
    s.readyState = 4
    s.networkState = 2
    state = 5
    emit('onStateChange')
  }

  let adUntil = 0
  const showAd = (forHowLong: number): void => {
    adUntil = Date.now() + forHowLong
    ;(player as unknown as HTMLElement).classList.add('ad-showing')
    ads.append(document.createElement('div'))
  }
  const dropAd = (): void => {
    ;(player as unknown as HTMLElement).classList.remove('ad-showing')
    ads.textContent = ''
  }

  video.play = (): Promise<void> => {
    log('video.play', loaded)
    // Nothing loaded, nothing to play — the state an element is in before the
    // player has handed it a source, and the one the unlocking press finds.
    if (!loaded) return Promise.resolve()
    const fault = faultFor(loaded)
    if (s.error) return Promise.reject(new DOMException('failed', 'NotSupportedError'))
    if (fault === 'play-rejects' && !gestureGiven) return Promise.reject(new DOMException('gesture', 'NotAllowedError'))
    if (fault === 'dormant' || fault === 'loaded-paused' || fault === 'ad-phantom') return Promise.resolve()
    if (fault === 'stall') {
      wait()
      return Promise.resolve()
    }
    if (s.readyState === 0 && fault !== 'healthy' && fault !== 'stuck-unstarted') return Promise.resolve()
    start()
    return Promise.resolve()
  }
  video.pause = (): void => {
    s.paused = true
    s.waiting = false
    if (state === 1) state = 2
    fire('pause')
    emit('onStateChange')
  }

  const api = {
    loadVideoById(arg: string | { videoId: string; startSeconds?: number }) {
      const id = typeof arg === 'string' ? arg : arg.videoId
      const fault = faultFor(id)
      log('loadVideoById', id)
      if (fault === 'throws') throw new Error('lab: the player refuses')
      loaded = id
      s.error = null
      s.ended = false
      s.currentTime = 0
      dropAd()
      if (fault === 'dormant') {
        // Takes the track and forgets it: nothing loaded, nothing named.
        loaded = id
        s.paused = true
        s.readyState = 0
        s.networkState = 0
        state = -1
        return
      }
      if (fault === 'error') {
        settle()
        window.setTimeout(() => {
          s.error = { code: 3, message: 'lab' } as MediaError
          s.paused = true
          fire('error')
        }, 200)
        return
      }
      if (fault === 'loaded-paused' || fault === 'play-rejects') {
        settle()
        return
      }
      if (fault === 'ad-phantom') {
        showAd(60_000)
        settle()
        return
      }
      if (fault === 'ad-real') {
        showAd(1500)
        start()
        window.setTimeout(() => {
          dropAd()
          s.currentTime = 0
          start()
        }, 1500)
        return
      }
      if (fault === 'slow') {
        wait()
        window.setTimeout(start, 4000)
        return
      }
      if (fault === 'stall') {
        wait()
        return
      }
      if (fault === 'swap') {
        window.setTimeout(() => {
          // The page throws its player away and builds another, the way
          // YouTube does when it navigates itself.
          log('swap')
          build()
        }, 1000)
        settle()
        return
      }
      settle()
    },
    playVideo() {
      log('playVideo', loaded)
      // Asked of a player that refuses everything, this refuses too, whether or
      // not it ever accepted a track.
      const fault = faultFor(loaded ?? '')
      if (fault === 'throws') throw new Error('lab: the player refuses')
      // Nothing loaded is nothing to play.
      if (!loaded) return
      if (fault === 'dormant' || fault === 'loaded-paused' || fault === 'ad-phantom') return
      if (fault === 'play-rejects' && !gestureGiven) return
      if (fault === 'error' || fault === 'slow' || fault === 'stall') return
      if (s.error) return
      start()
    },
    pauseVideo() {
      log('pauseVideo')
      video.pause()
    },
    seekTo(seconds: number) {
      s.currentTime = seconds
    },
    getCurrentTime: () => s.currentTime,
    getDuration: () => (s.readyState > 0 ? DURATION : 0),
    getPlayerState: () => {
      if (loaded && faultFor(loaded) === 'stuck-unstarted') return -1
      if (Date.now() < adUntil) return 1
      return state
    },
    getVideoData: () => ({
      video_id: loaded && faultFor(loaded) === 'dormant' ? '' : loaded ?? '',
      title: loaded ? `track ${loaded}` : '',
      author: 'lab',
    }),
    getVolume: () => volume,
    setVolume: (v: number) => {
      volume = v
      video.volume = Math.max(0, Math.min(1, v / 100))
    },
    setPlaybackRate: (r: number) => {
      // The stuck player takes the call and keeps its own rate, which is the
      // measured behaviour the element-side re-assert exists for.
      if (loaded && faultFor(loaded) === 'stuck-unstarted') return
      rate = r
      video.playbackRate = r
    },
    getPlaybackRate: () => rate,
    setPlaybackQualityRange: (min: string) => {
      quality = min
    },
    getPlaybackQuality: () => quality,
    getAvailableQualityLevels: () => ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny', 'auto'],
    isMuted: () => muted,
    mute: () => {
      muted = true
      video.muted = true
    },
    unMute: () => {
      muted = false
      video.muted = false
    },
    addEventListener(name: string, fn: (...a: unknown[]) => void) {
      const set = listeners.get(name) ?? []
      set.push(fn)
      listeners.set(name, set)
    },
    removeEventListener(name: string, fn: (...a: unknown[]) => void) {
      listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== fn))
    },
  }
  Object.assign(player, api)
  return { player, video }
}

// ── Boot ───────────────────────────────────────────────────────────────────
//
// The same order `src/main/index.ts` boots in: build the player, make the
// engine, attach, and keep picking the player up in case the page swaps it.
// The interval here is shorter than the product's four seconds only so a test
// that swaps a player does not spend four of its own waiting for the answer.

const engine = new Engine()
if (pageFault !== 'no-player') build()
const found = document.getElementById('movie_player') as YtPlayer | null
// A watch page loads the video its address names before anyone asks it to.
// Loaded, not started: what happens after that is the engine's business and
// the arrival rules', which is exactly the thing worth testing.
const named = new URLSearchParams(location.search).get('v')
if (found && named) {
  try {
    found.loadVideoById(named)
  } catch {
    // A player that throws at its own page's video is one of the behaviours.
  }
}
if (found) engine.attach(found)
window.setInterval(() => {
  const p = document.getElementById('movie_player') as YtPlayer | null
  if (p && typeof (p as { loadVideoById?: unknown }).loadVideoById === 'function') engine.attach(p)
}, 500)

export interface LabView {
  /** The address, without the query the run was started with. */
  path: string
  /** The video the address names, when it names one. */
  videoId: string | undefined
  /** Sound is coming out of the element. The only proof that counts. */
  sounding: boolean
  currentTime: number
  playingTitle: string
  index: number
  queue: Array<{ id: string; unavailable: boolean }>
  trouble: string | undefined
  visit: number
  fault: Fault
}

const lab = {
  /** Puts a queue in and presses the first track, the way a list does. */
  play(tracks: Track[], index = 0) {
    engine.play(tracks, index)
  },
  /** A press, which is also the gesture a browser may have been holding out for. */
  toggle() {
    gestureGiven = true
    engine.toggle()
  },
  /** Runs the track to its last moment, so the end of one can be tested in a second. */
  skipToEnd() {
    const v = document.querySelector('video')
    if (v) v.currentTime = 29.8
  },
  next() {
    engine.next()
  },
  /** Presses a different row while the last press is still in the air. */
  jumpTo(index: number) {
    engine.jumpTo(index)
  },
  setRepeat(mode: 'off' | 'one' | 'all') {
    engine.setRepeat(mode)
  },
  /**
   * Is the clock actually moving?
   *
   * "Not paused" is not the question — a waiting element answers that the same
   * way a playing one does, and a track that dies mid-way keeps answering it
   * long after the sound has gone. Two readings, a beat apart, and only a
   * bigger second one counts as playing.
   */
  async moving(): Promise<boolean> {
    const v = document.querySelector('video')
    if (!v || v.paused || v.ended) return false
    const was = v.currentTime
    await new Promise((r) => setTimeout(r, 400))
    const now = document.querySelector('video')
    return !!now && !now.paused && !now.ended && now.currentTime > was + 0.05
  },
  view(): LabView {
    const v = document.querySelector('video')
    return {
      path: location.pathname,
      videoId: new URLSearchParams(location.search).get('v') ?? undefined,
      // Not merely "not paused": a waiting element is not paused either, and
      // taking that for sound is how a stall reads as success.
      sounding: !!v && !v.paused && !v.ended && v.currentTime > 0.15,
      currentTime: v?.currentTime ?? 0,
      playingTitle: engine.current?.title ?? '',
      index: engine.state.index,
      queue: engine.state.queue.map((t) => ({ id: t.videoId, unavailable: t.unavailable === true })),
      trouble: engine.trouble,
      visit,
      fault: pageFault,
    }
  },
  log(): LogLine[] {
    try {
      return JSON.parse(sessionStorage.getItem(LOG_KEY) ?? '[]') as LogLine[]
    } catch {
      return []
    }
  },
  clearLog() {
    try {
      sessionStorage.removeItem(LOG_KEY)
    } catch {}
  },
  engine,
}

;(window as unknown as { LAB: typeof lab }).LAB = lab
log('boot', pageFault)
