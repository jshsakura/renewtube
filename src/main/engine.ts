// The queue and the hand that plays it.
//
// One object owns the persisted state, the reference to YouTube's player and
// the rules of what plays after what. The UI reads from it and calls into it;
// it never touches the player itself.

import { State, disableAutonav, videoIdInUrl, type YtPlayer } from './player.ts'
import type { Track } from './parse.ts'
import type { Lang } from '../shared/i18n.ts'
import { clearRescue, load, markArrival, remember, rescueRecord, save, saveRescue, setQuickOn, takeArrival, type Mode, type Persisted, type Repeat, type Rescue, type Theme, type VideoLayout } from './store.ts'
import { narrowNow } from './ui/device.ts'

/**
 * How long after an advert the end-of-track check stays quiet.
 *
 * Long enough to cover the gap between YouTube dropping the advert and having
 * the real video underway; short enough that a track which genuinely ends
 * straight after a mid-roll still advances within a tick or two.
 */
const AD_SETTLE_MS = 1500

/**
 * How long a load may sit unstarted, with the element already playing it,
 * before we hand the player the same video again.
 *
 * Long enough that an ordinary slow load is never interrupted; short enough
 * that the stuck state is not something anyone sits through. Measured: the
 * stuck state never clears on its own, so the only cost of the wait is how
 * long the speed control stays dead.
 */
const STUCK_UNSTARTED_MS = 2000

/**
 * How long a desktop press may sit with the in-page player refusing the video
 * before the fallback navigates to the watch page.
 *
 * A working load has the player naming the video well inside this (measured
 * ~1s signed out); only a dormant player — the signed-in home player, which
 * takes loadVideoById and never fetches, leaving getVideoData empty and the
 * element at NETWORK_EMPTY (measured 2026-09-06, the owner's diagnostics) —
 * stays empty past it.
 */
const DORMANT_MS = 2200

/**
 * How long one rung of the recovery ladder is given before the next is tried.
 *
 * Each rung is a real attempt — a second push into the player, a rebuilt page —
 * and each needs room to work before it is called a failure. Long enough for a
 * load to land, short enough that the whole ladder is spent inside ten seconds
 * rather than leaving someone looking at a dead transport.
 */
const RESCUE_STEP_MS = 2500

/**
 * An unbroken wait this long is not a load any more.
 *
 * A buffering element is left alone, because that is what an ordinary slow
 * start looks like from outside. But a wait with no end is the same silence as
 * a player that never took the track, and it deserves the same ladder. Well
 * past `STALL_AFTER_MS`, where the transport already stops claiming to load.
 */
const STALL_HARD_MS = 15_000

/**
 * How long an element that *has* a source may sit paused before the ladder
 * treats it as a failure.
 *
 * Two different silences wear the same face. An element with nothing in it —
 * no source, `NETWORK_EMPTY` — is the dormant player, and no amount of waiting
 * changes it. An element that has a source and has not started is usually a
 * phone on a slow line, and handing that to the watch page throws away a load
 * that was arriving. Measured 2026-09-07 in WebKit: a healthy press took longer
 * than the dormancy grace and was navigated away from, which is the product
 * choosing its own address for no reason at all.
 */
const LOADED_SILENT_MS = 8000

/**
 * How long a claimed advert may sit with nothing playing before it is not
 * believed.
 *
 * `ad-showing` and a child in `.video-ads` are both present, with no advert
 * anywhere, for the whole of the stuck-unstarted state — measured. An advert
 * that is showing is by definition playing, so one whose element is paused for
 * this long is a phantom, and a phantom must not be able to hold the rescue off
 * for ever. Longer than the gap between two adverts in a break.
 */
const AD_PAUSED_MS = 6000

/**
 * How long the player may name a different video during an ordinary load.
 *
 * `loadVideoById` changes the API's answer asynchronously, so the outgoing id
 * is expected for a beat. Past this grace it is not a transition: YouTube's
 * autonav or inline player has taken the element back from our queue.
 */
const FOREIGN_VIDEO_MS = 2000

export type Listener = () => void

/**
 * Where an index lands when the row at `from` is moved to `to`.
 *
 * Lift out, then drop in, and the index follows each step: a row taken from
 * before it pulls it back one, and a row dropped at or before it pushes it on
 * one. The row that *is* the index simply arrives where it was dropped.
 *
 * Separate from the engine because it is the whole of the thinking here and it
 * is worth checking on its own. A queue may hold the same video twice, so this
 * cannot be recovered afterwards by looking for the track.
 */
export function movedIndex(current: number, from: number, to: number): number {
  if (current < 0) return current
  if (from === current) return to
  let at = current
  if (from < at) at -= 1
  if (to <= at) at += 1
  return at
}

/** How long one continuous wait may last before the transport calls it a stall. */
const STALL_AFTER_MS = 6000

export interface Position {
  current: number
  duration: number
  playing: boolean
  buffering: boolean
  /** A wait that has outlasted STALL_AFTER_MS: the transport's stop state. */
  stalled: boolean
}

export class Engine {
  state: Persisted = load()
  player: YtPlayer | null = null
  private listeners = new Set<Listener>()
  private tickListeners = new Set<Listener>()
  private tickTimer: number | undefined
  position: Position = { current: 0, duration: 0, playing: false, buffering: false, stalled: false }
  /** The load that has not landed yet: set when we ask, cleared in tick() once
   *  the player is underway on that very id. Guards against a stale ENDED,
   *  and doubles as "show a wait" for the transport in the meantime. */
  private loading: string | undefined
  /** Counts loads, so "once per load" survives loading the same id twice. */
  private loadSeq = 0
  /** When the current load was asked for, for the stuck-unstarted check. */
  private loadAskedAt = 0
  /**
   * What we have already re-pushed for: the load, paired with the speed that
   * was wanted at the time. One re-push per load, and one more if a speed is
   * chosen afterwards that the stuck player refuses — which is the only
   * moment the cost of a re-push buys anything.
   */
  private repushedFor = ''
  /** The id of the last load we asked for. Outlives `loading`, which the
   *  advert shortcut below clears early and, as measured, wrongly. */
  private loadedId: string | undefined

  /**
   * We asked to hear the current track and it has not begun.
   *
   * Set when a track is pressed, cleared the moment the element is actually
   * playing, on a deliberate pause, or on a playback error. While it is set,
   * `tryStart` is armed on the element's own readiness events and re-checked
   * each tick — so a track that loaded paused (a signed-in desktop home
   * player did exactly this) is played the instant it can be, not on a guess.
   */
  private wantsPlaying = false

  /**
   * This track is meant to be playing, whether or not it has begun.
   *
   * Not the same thing as `wantsPlaying`, which is the nudge and stops the
   * moment sound arrives. This one outlives the start and is the gate the
   * recovery ladder reads: a track that played for a minute and then went
   * silent is as much a failure as one that never started, and only something
   * deliberate — a pause, the sleep timer, the end of the queue — clears it.
   */
  private wantsSound = false

  /** When the element's clock last moved, which is the only proof of progress. */
  private progressAt = 0
  /** Where the clock was at that moment. */
  private progressTime = -1
  /** When YouTube first named a video other than the one our bar names. */
  private foreignSince: number | undefined
  /** One cheap reclaim per load before the recovery ladder spends a rung. */
  private foreignPushFor = -1
  /**
   * This load has been heard at least once.
   *
   * It decides what a paused element means. A track that never started and is
   * paused is the failure this whole ladder exists for; a track that played and
   * is now paused is somebody having pressed pause — from the
   * Picture-in-Picture window, the lock screen, a headset button — and pulling
   * it out from under them would be the worst bug in the set. Nothing here can
   * ask who paused it, so this is what tells the two apart.
   */
  private everPlayed = false

  /** What the ladder has already spent on the current track, across pages. */
  private rescue: Rescue = { id: '' }
  /** When the last rung was taken, so one is tried at a time. */
  private rescueAt = 0
  /** The track the ladder has run out of rungs for; never rescued again. */
  private gaveUpOn: string | undefined
  /**
   * The browser refused to play without a gesture.
   *
   * WebKit answers `play()` with NotAllowedError when the activation is spent,
   * which is a loaded track waiting for a press — not a broken one. The ladder
   * stops there: navigating or reloading would only lose the load that
   * succeeded, and the next press starts it.
   */
  private needsGesture = false
  /** When the current phantom advert began; undefined while none is claimed. */
  private adPausedSince: number | undefined
  /** Whether sound was coming out at the last look, for a player swapped under us. */
  private wasSounding = false
  /**
   * Whether the listener pressed mute.
   *
   * Not the player's mute and not a volume of zero: the page arrives with a
   * mute of its own, and reading that back as ours is what silenced people
   * who had never asked for silence.
   */
  private userMuted = false
  /** When the current continuous wait began; undefined while not waiting. */
  private bufferingSince: number | undefined
  /** YouTube's own volume and mute, as they were before we wrote ours over them. */
  private pageVolume: number | undefined
  private pageMuted: boolean | undefined
  /** Whether the page was running its player inline, so it can go back to it. */
  private pageInline: boolean | undefined
  /**
   * Whether this device lets script set the volume at all.
   *
   * iOS does not: WebKit makes `volume` read-only on a media element there,
   * on the grounds that the hardware buttons are the volume control, and it
   * fails **silently** — the assignment is accepted and the value does not
   * move. A slider that cannot do anything is worse than no slider, so this
   * is measured rather than assumed, once, and the bar hides the control
   * where the answer is no. `undefined` means not measured yet.
   */
  volumeSettable: boolean | undefined

  constructor() {
    // A stored queue is useful after a reload; a stored *playing index* is not
    // proof that anything is still playing. On a non-watch page there is no
    // URL naming the old track, so drawing it in the bar until some unrelated
    // inline video wakes up is how localStorage and the picture end up telling
    // two different stories. Keep the queue, clear only its stale cursor. An
    // attached player with a real id is adopted below, and our own recovery
    // arrival has that id in the watch URL as well.
    if (this.current !== undefined && videoIdInUrl() === undefined) {
      this.state.index = -1
      this.state.video = 'hidden'
      save(this.state)
    }
  }

  /** Subscribe to queue and settings changes. Returns the unsubscribe. */
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Subscribe to the twice-a-second position tick. */
  onTick(fn: Listener): () => void {
    this.tickListeners.add(fn)
    return () => this.tickListeners.delete(fn)
  }

  private changed(): void {
    save(this.state)
    for (const fn of this.listeners) fn()
  }

  get current(): Track | undefined {
    return this.state.queue[this.state.index]
  }

  // ── The player ────────────────────────────────────────────────────────────

  attach(player: YtPlayer): void {
    if (this.player === player) return
    // YouTube swaps the player as it navigates itself, and `reattach` hands us
    // the new one. Everything hung on the old one goes first: a listener left
    // behind talks about a player nobody is driving, and a second interval
    // means every check in `tick` runs twice as often as it was written for.
    const swapped = this.player !== null
    if (this.player) {
      try {
        this.player.removeEventListener('onStateChange', this.onStateChange)
      } catch {
        // A player already torn down has nothing to unsubscribe from.
      }
    }
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
    this.player = player
    // What the page was set to before we touched it. We are about to write our
    // own volume into YouTube's player, and it is YouTube's player: leaving
    // without putting this back means the page carries our number afterwards,
    // which is heard as the sound jumping the moment the app goes away.
    try {
      this.pageVolume = player.getVolume()
      // A mute is only worth remembering if it was somebody's choice. YouTube
      // mutes for reasons of its own — an inline feed preview, an autoplay it
      // is only allowed to start silent — and the player will say so when
      // asked. Recording one of those as "how the reader left it" is what
      // made leaving the app turn the sound off.
      const notOurs = player.isMutedByMutedAutoplay?.() === true || player.isInline?.() === true
      this.pageMuted = notOurs ? false : player.isMuted()
    } catch {
      this.pageVolume = undefined
      this.pageMuted = undefined
    }
    // Out of preview and into a real player. A player running as the feed's
    // inline preview carries YouTube's own constraints with it, and the app is
    // about to hand it the whole screen. Both calls are optional: measured on
    // the live player they exist, but a build without them is not a failure.
    try {
      this.pageInline = player.isInline?.()
      player.setInlinePreview?.(false)
      player.setInline?.(false)
    } catch {
      // A build that will not leave preview still plays; nothing here depends
      // on the promotion having worked.
    }
    player.addEventListener('onStateChange', this.onStateChange)
    disableAutonav()
    setTimeout(disableAutonav, 2000)
    this.applyVolume()
    this.applyRate()
    this.applyQuality()
    this.holdArrival()
    this.adoptPlaying()
    // A player swapped out from under a playing track takes the sound with it.
    // The new one knows nothing about what was playing, so it is told — the
    // alternative is music that stops when the page rearranges itself, with
    // nothing in the transport to say why.
    if (swapped && this.loadedId !== undefined && this.wasSounding && !this.wantPaused && this.gaveUpOn !== this.loadedId) {
      const named = this.namedVideo()
      // A new player that already has our track is not a player to push a
      // track into: that would start the song again from nothing. Asking to
      // hear it is enough, and the start is deterministic from there.
      if (named === this.loadedId) {
        this.wantsPlaying = true
        this.wantsSound = true
      } else {
        this.repush(this.loadedId)
      }
    }
    this.tickTimer = window.setInterval(this.tick, 500)
    this.tick()
    this.changed()
  }

  detach(): void {
    if (this.player) this.player.removeEventListener('onStateChange', this.onStateChange)
    // Handed back as it was found, with one deliberate exception below.
    // Wrapped because a player being torn down is allowed to have stopped
    // answering, and a throw here would take the rest of the exit with it.
    try {
      if (this.pageVolume !== undefined) this.player?.setVolume(this.pageVolume)
      // The mute goes back only if it was there when we arrived *and* the
      // reader is leaving muted. Anything else would be imposing a silence
      // nobody asked for: someone who spent the session listening and then
      // closed the app used to land back on YouTube with the sound off,
      // because the page had happened to be muted when we found it.
      if (this.pageMuted === true && this.muted) this.player?.mute()
      else this.player?.unMute()
    } catch {
      // The page keeps whatever it has; nothing else here depends on this.
    }
    // And back into preview if that is how the page was running, for the same
    // reason the volume goes back: the feed's player is the feed's, and one
    // left promoted is one the feed no longer sizes the way it means to.
    try {
      if (this.pageInline === true) this.player?.setInline?.(true)
    } catch {
      // Nothing after this depends on the demotion having worked.
    }
    this.pageVolume = undefined
    this.pageMuted = undefined
    this.pageInline = undefined
    this.boundVideo?.removeEventListener('ended', this.onElementEnded)
    for (const ev of ['canplay', 'loadeddata', 'playing'] as const) this.boundVideo?.removeEventListener(ev, this.onElementReady)
    this.boundVideo = null
    this.wantsPlaying = false
    this.wantsSound = false
    this.player = null
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  /**
   * Makes the queue agree with what the page is playing.
   *
   * After our own navigation the URL is the current track and nothing happens.
   * Anything else (the mode switched on mid-video, a back button, YouTube's own
   * navigation) means the page is playing something the queue did not choose,
   * and the person chose it, so the queue adopts it rather than overriding it.
   */
  adoptPlaying(): void {
    const p = this.player
    if (!p) return
    // Never while an advert is on. The page would be naming the advert, and
    // adopting it puts an advert in the queue as though someone had chosen it.
    if (this.adShowing()) return
    const playing = videoIdInUrl() ?? p.getVideoData()?.video_id
    if (!playing) return
    // From this point the player, not persisted state, is the identity of the
    // current media. Future autoplay is compared with this value even when no
    // load of ours is in flight.
    this.loadedId = playing
    if (this.current?.videoId === playing) return
    const at = this.state.queue.findIndex((t) => t.videoId === playing)
    if (at >= 0) {
      this.state.index = at
      return
    }
    const data = p.getVideoData()
    const track: Track = {
      videoId: playing,
      title: data?.title || playing,
      byline: data?.author || '',
      duration: '',
      unavailable: false,
    }
    this.state.queue.splice(this.state.index + 1, 0, track)
    this.state.index += 1
  }

  /**
   * Nothing plays until it is pressed.
   *
   * YouTube's watch page starts its video by itself, so a page opened with the
   * mode on was sounding before anyone had touched a thing: "재생을 안 눌렀는데
   * 혼자 재생" (2026-09-04). The one page that may play on arrival is the one
   * we navigated to ourselves, for a track that was pressed — load() leaves a
   * mark behind that says so. Only the first attach of a page's life counts as
   * an arrival; the mode switched on over a video that is already playing is
   * the reader's own doing and is left alone.
   */
  private static arrivalSeen = false
  /**
   * While set, the page's own attempts to start are put back down. One pause
   * is not enough: the player attaches before the video is ready and starts
   * it again when it is, measured as "paused, then playing three seconds
   * later". Cleared by the first press on the transport, which is the press
   * this whole hold is waiting for.
   */
  private holding = false
  private holdArrival(): void {
    if (Engine.arrivalSeen) return
    Engine.arrivalSeen = true
    const ours = takeArrival()
    const here = videoIdInUrl()
    const named = this.namedVideo()
    const remembered = here !== undefined
      && this.current?.videoId === here
      && (named === undefined || named === '' || named === here)
    // Our own arrival is a track someone pressed, still waiting to be heard.
    // Saying so here is what puts the watch page under the same ladder as
    // everywhere else: without it the engine has no intent on this page at all
    // — it only adopts whatever plays — so an arrival that never starts is a
    // silence nothing is watching. YouTube usually starts it within the grace
    // period and the intent is dropped unused.
    // A reload of the track the queue was already on is not YouTube choosing
    // a video for us. The URL and saved cursor name the same thing and the
    // player either agrees or has not named anything yet, so carry the
    // listening intent across the new document. This
    // exact state was held as an unsolicited arrival on 2026-09-09: the bar
    // and player both named T6GNG4A8U0c, while diagnostics said "요청 없음"
    // and "도착 보류 중" over a paused Buffering player. `adoptPlaying()` is
    // deliberately called after this check: adopting the URL first would make
    // every unrelated watch page look remembered.
    if (here && (ours === here || remembered)) {
      this.loadedId = here
      this.loadAskedAt = Date.now()
      this.progressAt = Date.now()
      this.rescue = rescueRecord(here)
      this.wantsPlaying = true
      this.wantsSound = true
    }
    if (!here || ours === here || remembered) return
    // Late is not an arrival. A page that has been open for a while and then
    // gets the mode switched on was playing by the reader's choice.
    if (performance.now() > 15_000) return
    this.holding = true
    this.putDown()
  }

  /** Pauses whatever the page has started, while the hold is on. */
  private putDown(): void {
    if (!this.holding) return
    try {
      this.player?.pauseVideo()
    } catch {}
    const el = this.videoEl()
    if (el && !el.paused) el.pause()
  }

  /** The reader has pressed something: the hold is over. */
  private releaseHold(): void {
    this.holding = false
  }

  /** Whether the page's own start is still being held down. */
  get arrivalHeld(): boolean {
    return this.holding
  }

  private onStateChange = (raw: unknown): void => {
    // A new video usually means a new element, and this arrives before the
    // next tick would.
    this.watchElement()
    const s = typeof raw === 'number' ? raw : Number((raw as { data?: unknown })?.data ?? raw)
    if (s === State.Ended) {
      // A stale ENDED from the previous video can arrive right after loadVideoById.
      if (this.loading && this.player?.getVideoData()?.video_id !== this.loading) return
      this.ended()
    }
    this.tick()
  }

  /**
   * Whether sound is actually coming out, asked of the element.
   *
   * `getPlayerState()` is not reliable enough to decide on: it reports -1
   * while the video is plainly playing, with `paused` false and `currentTime`
   * climbing. Measured — and it is the reason pressing pause in the first
   * couple of seconds of a track did nothing at all. `toggle()` read the state,
   * concluded nothing was playing, and called playVideo() on a video that was
   * already playing.
   *
   * The element cannot be wrong about this, so it is the answer, and the
   * player's own state is only the fallback for when there is no element yet.
   */
  /**
   * The page's video element, remembered between ticks.
   *
   * Looked up again only when the one we hold has left the document, which is
   * what happens when YouTube rebuilds its player. A tag lookup twice a second
   * is not expensive, but it is also not free, and this runs for as long as the
   * mode is on.
   */
  private cachedVideo: HTMLVideoElement | null = null
  private videoEl(): HTMLVideoElement | null {
    if (this.cachedVideo?.isConnected) return this.cachedVideo
    this.cachedVideo = document.querySelector('video')
    return this.cachedVideo
  }

  /**
   * The element tells us the track ended; we do not wait to notice.
   *
   * The end of a track was found by polling — twice a second, which is
   * instant while anyone is looking. In a tab nobody is looking at it is not:
   * a browser throttles timers in a hidden tab, and once the audio stops there
   * is nothing left to exempt this one, so the queue could sit for a long
   * moment on a finished track before moving to the next. That is the
   * "background 다음 재생을 헤맨다" of it. The element's own `ended` event is
   * not throttled, and running the same guarded check from it costs nothing:
   * `endedFor` already makes a second look harmless.
   *
   * Rebound whenever YouTube swaps the element under us, which it does.
   */
  private boundVideo: HTMLVideoElement | null = null
  private onElementEnded = (): void => {
    this.tick()
  }
  /**
   * Start the current track the instant its element can play.
   *
   * The player's own `canplay`/`loadeddata`/`playing` are the deterministic
   * signal that the media is ready; a track that loaded paused is started
   * exactly then, once per readiness rather than on a timed retry. Kept in
   * step with `wantsPlaying`, so it disarms itself.
   */
  private onElementReady = (): void => {
    if (this.wantsPlaying) this.tryStart()
  }
  /**
   * Ask the paused, loaded track to play, both ways.
   *
   * Not while an advert holds the element (an advert plays it, so it is not
   * paused anyway) and not once it has begun. `playVideo` for the player and
   * `play()` for the element, because on the home player the former was
   * ignored and only the element obeyed. An element that errored is left
   * alone — the intent clears so nothing loops on an unplayable track.
   */
  private tryStart(): void {
    const el = this.videoEl()
    if (!el) return
    if (el.error) {
      // Nothing to start; the ladder below reads the same error and acts.
      this.wantsPlaying = false
      return
    }
    if (!el.paused) {
      // Sound, but not necessarily ours: until the load has landed this is the
      // track that was playing before, and taking it as an answer is what left
      // a failed press with nothing watching it.
      if (this.loading === undefined) this.wantsPlaying = false
      return
    }
    if (this.adBlocking()) return
    try {
      this.player?.playVideo()
    } catch {
      // The element below is what actually carries the sound.
    }
    void Promise.resolve(el.play()).then(
      () => {
        this.needsGesture = false
      },
      (e: unknown) => {
        // A refusal for want of a gesture is not a broken track: it is a
        // loaded one, a press away. Anything else is left to the ladder.
        if ((e as { name?: string } | null)?.name === 'NotAllowedError') this.needsGesture = true
      },
    )
  }
  /**
   * Whether the track we are on is failing, as opposed to merely starting.
   *
   * Asked of the element, which cannot be wrong about whether sound is coming
   * out of it. Four things count as failing, and everything else is left alone:
   * an element that is not there, one that is paused while we asked to hear it,
   * one that has given up on its source, and one whose wait has stopped ending.
   *
   * The three exemptions are the ones a rescue would ruin: a track waiting for
   * a press it will get, the page's own start being held down on arrival, and a
   * genuine advert, which is playing and will finish.
   */
  private needsRescue(): boolean {
    const id = this.loadedId
    if (id === undefined || id === this.gaveUpOn) return false
    // Nothing is meant to be playing: paused, asleep, or the queue has run out.
    if (!this.wantsSound) return false
    // A track loaded and waiting for a press is not a track in trouble — but
    // only a loaded one. A refusal over an element with nothing in it is not a
    // press away from anything, and taking it for one would leave a dead
    // player sitting there with the ladder switched off.
    if (this.needsGesture && this.elementLoaded()) return false
    // Held on purpose: the page's own start, put down until someone presses.
    if (this.holding) return false
    if (this.adBlocking()) return false
    const el = this.videoEl()
    if (!el) return true
    // The end of a track is the queue's business, not the ladder's.
    if (el.ended) return false
    // The element gave up on this source: no push, no wait and no press will
    // make it play.
    if (el.error) return true
    // Asked to play and not playing. Only for a track that was never heard:
    // one that played and stopped was paused by somebody, and a pause is not
    // something to recover from. A track that dies mid-way stalls rather than
    // pausing, and the clock below is what catches that.
    if (el.paused) {
      // A deliberate pause is State.Paused. The real iPhone instead reported
      // State.Buffering while its loaded element was paused at zero for 21.4s
      // (2026-09-09). That combination is the player trying and failing, not a
      // lock-screen or headset pause, so hearing the track once cannot exempt
      // it from recovery for ever.
      const pausedBuffering = this.player?.getPlayerState() === State.Buffering
        && this.bufferingSince !== undefined
        && Date.now() - this.bufferingSince > STALL_HARD_MS
      if (this.everPlayed && !pausedBuffering) return false
      if (pausedBuffering) return true
      // Nothing in it at all is the dormant player, and that is what the
      // dormancy grace is for. Something in it that has not started is a slow
      // start until it has had a fair go.
      const empty = el.networkState === 0 && el.currentSrc === '' && el.readyState === 0
      return empty || Date.now() - this.loadAskedAt > LOADED_SILENT_MS
    }
    // Something is playing, and it is fine only if it is ours and moving. The
    // player's id cannot prove playback on its own — it answers Unstarted over
    // a playing track and empty over a dormant one — but a *different* nonempty
    // id proves the moving clock belongs to somebody else. This used to count
    // only while `loading` was set. Once that flag cleared, an automatic video
    // could run for ever while the bar named the next queue item (2026-09-09,
    // "화면에보이는 영상하고 하단 재생기의 영상이 다른시점").
    const named = this.namedVideo()
    const somebodyElse = !!named && named !== id
    if (somebodyElse) return Date.now() - (this.foreignSince ?? this.loadAskedAt) > FOREIGN_VIDEO_MS
    const moving = Date.now() - this.progressAt < STALL_HARD_MS
    if (moving) return false
    return Date.now() - this.loadAskedAt > STALL_HARD_MS
  }

  /**
   * Everything there is to do about a track that will not play, in order.
   *
   * One rung at a time, each with room to work, each remembered across the
   * page it may rebuild:
   *
   * 1. **Hand it to the watch page.** The signed-in home player takes
   *    `loadVideoById` and does nothing — `getVideoData` empty, the element at
   *    NETWORK_EMPTY, no error (measured 2026-09-06 from the owner's
   *    diagnostics; the same player plays signed out). Driving it harder does
   *    not wake it, and the watch page builds a live player of its own. On a
   *    phone the arrival lands paused, but that player's play button works,
   *    unlike the stuck one.
   * 2. **Push it in once more.** Where a navigation is not available — already
   *    on the watch page, or one that was refused — a second `loadVideoById` is
   *    what clears a player that swallowed the first, and it is free.
   * 3. **Rebuild the page around it.** A watch page whose own player is dead
   *    has one thing left: a reload, which builds the player again from
   *    nothing, with the arrival mark saying the track may start.
   * 4. **Give the track up and move on.** A track nothing will play is not
   *    worth a fourth attempt; the queue is what the reader asked for, and it
   *    carries on without this one rather than stopping on it.
   *
   * A rung is only ever taken once per track, and the record survives the
   * navigation — otherwise the arriving page would start the same ladder from
   * the top and the two would bounce a track between them for ever.
   */
  private recover(): void {
    const id = this.loadedId
    if (id === undefined) return
    if (Date.now() - this.loadAskedAt < DORMANT_MS) return
    if (Date.now() - this.rescueAt < RESCUE_STEP_MS) return
    if (this.rescue.id !== id) this.rescue = rescueRecord(id)
    this.rescueAt = Date.now()
    const onWatch = /^\/watch/.test(location.pathname)
    if (!onWatch && !this.rescue.nav) {
      this.rescue.nav = true
      saveRescue(this.rescue)
      setQuickOn(true)
      markArrival(id)
      save(this.state)
      location.assign(`/watch?v=${id}`)
      return
    }
    if (!this.rescue.push) {
      this.rescue.push = true
      saveRescue(this.rescue)
      this.repush(id)
      return
    }
    if (onWatch && !this.rescue.reload) {
      this.rescue.reload = true
      saveRescue(this.rescue)
      setQuickOn(true)
      markArrival(id)
      save(this.state)
      location.reload()
      return
    }
    this.giveUp(id)
  }

  /** What the player says it is on, and nothing if it will not say. */
  private namedVideo(): string | undefined {
    try {
      return this.player?.getVideoData()?.video_id
    } catch {
      // A player mid-teardown answers by throwing, which is not an answer.
      return undefined
    }
  }

  /**
   * Whether the element has media in it, as opposed to being empty.
   *
   * `HAVE_CURRENT_DATA` is the point at which a press could actually start
   * something. A dormant player leaves the element at nothing loaded, no
   * source, `NETWORK_EMPTY` — measured — and no press reaches that.
   */
  private elementLoaded(): boolean {
    const el = this.videoEl()
    if (!el) return false
    return el.readyState >= 2 || el.currentSrc !== ''
  }

  /** Hands the player the track again without counting it as a new load. */
  private repush(id: string, startSeconds?: number): void {
    const p = this.player
    if (!p) return
    this.loading = id
    this.loadAskedAt = Date.now()
    this.progressAt = Date.now()
    this.progressTime = -1
    this.everPlayed = false
    this.wantPaused = false
    this.wantsPlaying = true
    this.wantsSound = true
    try {
      p.loadVideoById(startSeconds !== undefined && startSeconds > 0 ? { videoId: id, startSeconds } : id)
      p.playVideo()
    } catch {
      // A player that throws is one the next rung navigates away from.
    }
  }

  /**
   * Marks the track unplayable and carries on down the queue.
   *
   * Every rung has been spent on it. Sitting on a dead track is the failure the
   * reader actually feels — the music simply stopped — so the queue moves, and
   * the row is marked so `next` will not walk back into it. Nothing is ever
   * rescued for this id again, which is what stops the ladder looping on a
   * queue with nothing playable left in it.
   */
  private giveUp(id: string): void {
    this.gaveUpOn = id
    this.wantsPlaying = false
    this.wantsSound = false
    this.loading = undefined
    clearRescue()
    const track = this.state.queue.find((t) => t.videoId === id)
    if (track) track.unavailable = true
    this.trouble = id
    save(this.state)
    this.changed()
    // Only if it is still the track we are sitting on; the queue may have been
    // moved on by hand while the ladder was working.
    if (this.current?.videoId === id) this.next()
  }

  /**
   * The last track the ladder ran out of rungs for, for the screen to say so.
   *
   * Cleared as soon as anything plays, so it only ever describes now.
   */
  trouble: string | undefined

  /**
   * Where the recovery stands, for the diagnosis screen.
   *
   * The one thing a report of "it will not play" could never say: whether
   * anything was asking it to, what has already been tried for it, and how long
   * it has been since the clock last moved. Read-only, and a snapshot.
   */
  get recovery(): {
    wants: boolean
    spent: Rescue
    gaveUp: string | undefined
    gesture: boolean
    loaded: boolean
    heard: boolean
    sinceAsk: number
    sinceProgress: number
    advert: boolean
    failing: boolean
  } {
    return {
      wants: this.wantsSound,
      spent: { ...this.rescue },
      gaveUp: this.gaveUpOn,
      gesture: this.needsGesture,
      loaded: this.elementLoaded(),
      heard: this.everPlayed,
      sinceAsk: this.loadAskedAt === 0 ? -1 : Date.now() - this.loadAskedAt,
      sinceProgress: this.progressAt === 0 ? -1 : Date.now() - this.progressAt,
      advert: this.adBlocking(),
      failing: this.needsRescue(),
    }
  }

  /**
   * Whether an advert is holding the element, believed only while it plays.
   *
   * `ad-showing` and a child in `.video-ads` are both there for the whole of
   * the stuck-unstarted state with no advert anywhere — measured — and an
   * advert is the one thing that stops both `tryStart` and the ladder. Left
   * unchecked, a phantom one is silence nothing can recover from. An advert
   * that is showing is playing; one whose element stays paused is not real.
   */
  private adBlocking(): boolean {
    if (!this.adShowing()) {
      this.adPausedSince = undefined
      return false
    }
    const el = this.videoEl()
    if (el && !el.paused && !el.ended) {
      this.adPausedSince = undefined
      return true
    }
    this.adPausedSince ??= Date.now()
    return Date.now() - this.adPausedSince < AD_PAUSED_MS
  }
  private watchElement(): void {
    const el = this.videoEl()
    if (el === this.boundVideo) return
    for (const ev of ['ended'] as const) this.boundVideo?.removeEventListener(ev, this.onElementEnded)
    for (const ev of ['canplay', 'loadeddata', 'playing'] as const) this.boundVideo?.removeEventListener(ev, this.onElementReady)
    this.boundVideo = el
    if (!el) return
    el.addEventListener('ended', this.onElementEnded)
    for (const ev of ['canplay', 'loadeddata', 'playing'] as const) el.addEventListener(ev, this.onElementReady)
    // The element may already be ready by the time we bind it, in which case
    // no event will fire; check once now.
    this.onElementReady()
  }

  /**
   * Whether YouTube is playing an advert in front of the track.
   *
   * It matters twice, and both times because an advert shares the one video
   * element with the track it interrupts — same element, source swapped, so
   * from the outside an advert simply looks like the wrong video playing.
   *
   * **`.video-ads` on its own is not the question to ask.** That container is
   * in the page whether or not an advert is running — measured, present with
   * no advert anywhere — so testing for it would answer "advert" forever, and
   * the queue would never advance again. Its *children* are the tell. The
   * mobile site has no `ad-showing` class to offer, and answers with a renderer
   * element that exists only while an advert does.
   */
  private adShowing(): boolean {
    const p = this.player
    if (p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'))) return true
    if (document.querySelector('ytm-video-ad-renderer, .ytp-ad-player-overlay') !== null) return true
    const slot = document.querySelector('.video-ads')
    return slot !== null && slot.childElementCount > 0
  }

  private sounding(): boolean {
    const el = this.videoEl()
    if (el) return !el.paused && !el.ended
    const s = this.player?.getPlayerState()
    return s === State.Playing || s === State.Buffering
  }

  private tick = (): void => {
    const p = this.player
    if (!p) return
    // YouTube rebuilds and re-enables this control as videos change. Turning it
    // off only at attach left its automatic next free to race our queue after
    // the first track, so keep the page's queue out on every existing tick.
    disableAutonav()
    this.watchElement()
    this.probeVolume()
    if (this.holding && this.sounding()) this.putDown()
    if (this.sounding()) this.syncMute()
    const s = p.getPlayerState()
    // A load is pending until the player is actually underway on the track we
    // asked for; `loading` is dropped the moment it is, so it means "this load
    // has not landed yet" and never "some load once happened". Until then the
    // state reads Unstarted or Cued and the transport would flash a play glyph
    // into the gap between pressing next and the video existing.
    //
    // An advert counts as landed. It asks for the track's id and gets the
    // advert's, so the load stayed "pending" for the whole advert: the
    // transport sat spinning, pause did nothing but queue an intention, and
    // there was no way to stop what was audibly playing. Whatever is coming
    // out of the speakers, the load we asked for has happened.
    const ad = this.adShowing()
    if (ad) this.adSeenAt = Date.now()
    const settledAfterAd = Date.now() - this.adSeenAt > AD_SETTLE_MS
    const named = this.namedVideo()
    const expected = this.loadedId ?? this.current?.videoId
    const unsolicited = !!named && expected === undefined && !this.wantsSound && this.sounding()
    const foreign = !ad && settledAfterAd && (unsolicited || (!!named && !!expected && named !== expected))
    if (foreign) this.foreignSince ??= Date.now()
    else {
      this.foreignSince = undefined
      // A later takeover is a new episode and earns its own cheap correction.
      this.foreignPushFor = -1
    }
    if (
      this.loading !== undefined &&
      (ad || ((s === State.Playing || s === State.Buffering) && named === this.loading))
    ) {
      this.loading = undefined
      // Whoever pressed pause while this was loading meant it.
      if (this.wantPaused) {
        this.wantPaused = false
        this.wantsPlaying = false
        this.wantsSound = false
        p.pauseVideo()
      }
      // The rate is re-applied *here*, where the load has actually landed.
      // Setting it next to loadVideoById is too early: the player resets its
      // rate as the new video becomes ready, so the speed chosen a moment
      // before would be quietly thrown away — both on the next track and on a
      // rate chosen while the current one was still loading.
      this.applyRate()
      // And the quality, for the same reason and one more: the new video has
      // its own list of levels, so the smallest one has to be read again.
      this.applyQuality()
    }
    // A load that never starts, on a player that says nothing is wrong.
    //
    // Measured 2026-09-04 against live YouTube: after loadVideoById the player
    // can sit at Unstarted indefinitely while its element plays the requested
    // video underneath it — paused=false, currentTime climbing 0.4s to 4.9s,
    // getVideoData().video_id matching what we asked for. Nine seconds never
    // shook it loose. In that state setPlaybackRate does not move
    // getPlaybackRate off 1, and seekTo, playVideo and pause-then-play all do
    // nothing; writing element.playbackRate survived twice in five tries.
    // Handing the player the same id again cleared it every time.
    //
    // The condition is keyed on the id and nothing else, because the two
    // obvious gates both lie here. `adShowing()` is **true** for the whole of
    // this state — the player wears `ad-showing` and `.video-ads` holds a
    // child — while no advert plays at all: no ad renderer, and the real
    // video's clock running underneath. That false advert also trips the
    // shortcut above, so `loading` is already cleared by the time we look.
    // Hence `loadedId`, which outlives it.
    //
    // A genuine advert is excluded by the same id test rather than by asking
    // whether one is showing: during a real advert the player answers with
    // the advert's id, not the track's, which is the very thing the shortcut
    // above exists to cope with.
    //
    // Once per load, and only once the element has been playing the right
    // video for a moment, so an ordinary slow load is left alone.
    if (
      this.loadedId !== undefined &&
      s === State.Unstarted &&
      this.repushedFor !== `${this.loadSeq}:${this.state.rate}` &&
      Date.now() - this.loadAskedAt > STUCK_UNSTARTED_MS &&
      this.sounding() &&
      named === this.loadedId
    ) {
      this.repushedFor = `${this.loadSeq}:${this.state.rate}`
      // Put the pending flag back, so the landing path above does the rest:
      // it is what applies the rate and re-reads the quality levels, and the
      // whole point of getting unstuck is that those calls start working.
      this.loading = this.loadedId
      p.loadVideoById({ videoId: this.loadedId, startSeconds: this.videoEl()?.currentTime ?? 0 })
      p.playVideo()
    }
    // A track we asked for that has not begun. Cleared here the moment it is
    // actually playing, so the intent below stops nudging on its own — no
    // counting, no guessing when to give up. tryStart is also armed on the
    // element's readiness events (watchElement), which is what makes the
    // start deterministic rather than a tick lottery; this line is the
    // fallback for the element that was already ready when we bound it.
    // The clock, watched here and nowhere else. Every judgement about whether a
    // track is playing comes back to whether this number moves.
    const clock = this.videoEl()?.currentTime ?? -1
    if (!foreign && clock !== this.progressTime) {
      if (this.progressTime >= 0 && clock > 0 && this.loading === undefined) this.everPlayed = true
      this.progressTime = clock
      this.progressAt = Date.now()
    }
    const ownSound = this.sounding() && !foreign
    // Landed sound only: while a load is still pending, whatever is coming out
    // of the element belongs to the track before it.
    if (this.wantsPlaying && this.loading === undefined && ownSound) this.wantsPlaying = false
    if (this.wantsPlaying) this.tryStart()

    // Reject YouTube's queue before calling the current track a failure. A
    // short mismatch is loadVideoById changing hands; a persistent one is an
    // automatic/inline video using the same element. Near the real end, let
    // our queue advance. Anywhere else, put our id back at the last position
    // it had. If that cheap correction is swallowed, needsRescue() spends the
    // ordinary bounded ladder next.
    if (foreign && this.foreignSince !== undefined && Date.now() - this.foreignSince > FOREIGN_VIDEO_MS) {
      if (!this.wantsSound) {
        // No current playback was requested, so there is nothing sensible to
        // recover. Stop YouTube's automatic video and discard only the stale
        // cursor; the queue itself remains available for the next deliberate
        // press. Clear our expectation before pauseVideo emits synchronously.
        this.loading = undefined
        this.loadedId = undefined
        this.wantsPlaying = false
        this.wantPaused = false
        this.foreignSince = undefined
        this.state.index = -1
        this.state.video = 'hidden'
        if (this.sounding()) p.pauseVideo()
        this.changed()
        return
      } else if (
        this.loading === undefined &&
        this.position.duration > 0 &&
        this.position.current >= this.position.duration - 1.5 &&
        this.current?.videoId === expected
      ) {
        this.endedFor = expected
        this.ended()
        return
      } else if (this.foreignPushFor !== this.loadSeq) {
        this.foreignPushFor = this.loadSeq
        this.repush(expected!, this.loading === undefined ? this.position.current : undefined)
        return
      }
    }
    // Sound is the only proof, and it wipes the slate: the ladder starts from
    // the top for whatever goes wrong next, rather than carrying yesterday's
    // spent rungs into it.
    if (ownSound && this.loading === undefined && !ad) {
      this.wasSounding = true
      if (this.rescue.nav || this.rescue.push || this.rescue.reload) {
        this.rescue = { id: this.loadedId ?? '' }
        clearRescue()
      }
      if (this.trouble !== undefined) this.trouble = undefined
      this.needsGesture = false
    } else if (!ownSound) {
      this.wasSounding = false
    }
    if (this.needsRescue()) this.recover()
    // The rate is re-asserted, not set. YouTube's player drops it back to 1 at
    // moments of its own choosing — a new video becoming ready, a quality
    // change — and applying it once at any single point loses that race
    // sooner or later. Measured: set beside loadVideoById it never survived,
    // and set when the load landed it still went missing intermittently.
    // Only asked while a speed is actually chosen, so a player left at 1 is
    // never touched.
    if (this.state.rate !== 1) {
      try {
        if (p.getPlaybackRate() !== this.state.rate) this.applyRate()
      } catch {
        // A player build without the getter keeps whatever rate it has.
      }
      // The element is asked separately: where the player's getter lies, this
      // is the one that says whether the sound is actually at that speed.
      const rel = this.videoEl()
      if (rel && rel.playbackRate !== this.state.rate) this.applyRate()
    }
    // The pin is re-asserted the same way, and **only in music mode**. Video
    // mode is the absence of a pin: re-stating a ceiling twice a second would
    // stop the adaptive logic ever settling, which is the one thing video mode
    // is supposed to let it do.
    if (this.state.mode === 'music') {
      try {
        const now = p.getPlaybackQuality()
        // `unknown` is what a player answers between videos. It is not a
        // disagreement, and re-pinning on it fights the load that is landing.
        if (now && now !== 'unknown' && now !== this.wantedQuality()) this.applyQuality()
      } catch {
        // No getter, no way to tell it drifted; the load-landed call stands.
      }
    }
    const pending = (this.loading !== undefined && s !== State.Playing && s !== State.Paused) || foreign
    // Checked here rather than on a timer of its own: this already runs twice a
    // second, and a sleep timer is not a thing that needs to be punctual to the
    // millisecond.
    if (this.sleep && 'at' in this.sleep && Date.now() >= this.sleep.at) this.fallAsleep()

    // The end of a track, asked of the element.
    //
    // The queue used to advance only on the player's own ENDED notification,
    // and that notification is not dependable — measured: a track seeked to
    // two seconds from its end never produced one, and the queue sat on the
    // same song indefinitely. "Automatic advance is slow" was this: not slow,
    // not happening. The element's `ended` cannot be wrong, and once per track
    // is enough, which is what endedFor remembers.
    const el = this.videoEl()
    const playingId = this.current?.videoId
    // Not while an advert is playing, and not in the moment after one.
    //
    // The advert ends on this same element, so `ended` goes true for it too.
    // Worse than that, the two facts change at different times: YouTube drops
    // the advert class first and swaps the source a beat later, and in that gap
    // "no advert" and "ended" are both true at once — which would read as the
    // song finishing before the song had begun, and skip it. So an advert is
    // not merely a veto while it runs; it silences this check for a moment
    // afterwards as well.
    //
    // And the player must agree it is still our track. When it names a video
    // at all, and that name is not the one we think is playing, the element's
    // `ended` belongs to something else.
    const settled = settledAfterAd
    const ours = !named || named === playingId
    if (
      !ad &&
      settled &&
      ours &&
      el?.ended === true &&
      this.loading === undefined &&
      playingId !== undefined &&
      this.endedFor !== playingId
    ) {
      this.endedFor = playingId
      this.ended()
    }
    // The stall clock: a short wait is a load, and the bar says so with a pause
    // glyph the way YouTube's own does. Past STALL_AFTER_MS of one unbroken
    // wait the story changes — nothing is coming — and the transport switches
    // to stop. Any break in the wait resets the clock.
    // A held arrival is not a wait: the transport shows play, which is the
    // press it is waiting for, not a spinner for a load that is not coming.
    const buffering = (s === State.Buffering || pending) && !this.holding
    this.bufferingSince = buffering ? this.bufferingSince ?? Date.now() : undefined
    const stalled = this.bufferingSince !== undefined && Date.now() - this.bufferingSince > STALL_AFTER_MS
    // An advert does not move the song's progress. Whatever the player reports
    // while one is running belongs to the advert, so the elapsed time and the
    // length are held where the track left them and the bar stops lying about
    // a song it is not playing.
    const current = ad || foreign ? this.position.current : p.getCurrentTime() || 0
    const duration = ad || foreign ? this.position.duration : p.getDuration() || 0
    this.position = {
      current,
      duration,
      playing: ownSound,
      buffering,
      stalled,
    }
    for (const fn of this.tickListeners) fn()
  }

  /**
   * Asks the element, because only the element knows.
   *
   * Done on a real element and put straight back, which is inaudible at this
   * length; there is no capability flag to read instead. Skipped while
   * something is genuinely muted or mid-fade would be over-thinking it — the
   * value is restored either way.
   */
  private probeVolume(): void {
    if (this.volumeSettable !== undefined) return
    const el = this.videoEl()
    if (!el) return
    const was = el.volume
    const target = was > 0.5 ? 0.25 : 0.75
    try {
      el.volume = target
      this.volumeSettable = Math.abs(el.volume - target) < 0.01
      el.volume = was
    } catch {
      // A throw is an answer too.
      this.volumeSettable = false
    }
  }

  /**
   * Whether sound is off because we turned it off.
   *
   * This used to ask the player, so that a device which refuses volumes still
   * drew the right glyph. The trouble is that the player's mute is not always
   * ours: with "피드에서 재생" on, YouTube is already running a muted preview
   * before we attach, and an iPhone's autoplay is only allowed muted at all.
   * Reading either back as our own state put a muted speaker in front of
   * someone who had pressed nothing, and left them no way out of it.
   *
   * So the flag comes first and the stored volume second, and the page's own
   * mute is not consulted. `syncMute` is what makes the player agree.
   */
  get muted(): boolean {
    return this.userMuted || this.state.volume === 0
  }

  private applyVolume(): void {
    const p = this.player
    if (!p) return
    p.setVolume(this.state.volume)
    this.syncMute()
  }

  /**
   * The player and its element are made to agree with us, both ways.
   *
   * On an iPhone the page's own autoplay is allowed only muted, and it mutes
   * the *element* while the player's API goes on answering "not muted". So
   * the bar said playing, the mute glyph said sound, and nothing came out
   * (2026-09-04, "재생중이라고 나오는데 소리가 안 나는").
   *
   * The other half of the same report is the feed's inline preview. With
   * "피드에서 재생" switched on, YouTube already has a muted player running
   * when we arrive, and the mute survived attaching, so pressing our mute
   * button could not undo a mute nobody here had set. Taking the player's
   * mute as an input is what made that unreachable: on a build whose mute()
   * is a no-op the answer never changed, so we read back "not muted" and
   * dutifully unmuted the element the listener had just silenced.
   *
   * Now it is one-way. `userMuted` and a volume of zero are the only things
   * that mute, and anything the page muted for a preview or an autoplay is
   * undone. Called on every press that starts sound and on every tick, since
   * a press is where the platform lets script change it and a tick is where a
   * later mute would be noticed.
   */
  private syncMute(): void {
    const el = this.videoEl()
    if (this.muted) {
      try {
        if (this.player?.isMuted() !== true) this.player?.mute()
      } catch {
        // No mute on this build; the element below is the control that counts.
      }
      if (el && !el.muted) el.muted = true
      return
    }
    try {
      if (this.player?.isMuted() === true) this.player.unMute()
    } catch {
      // Same: the element is what actually carries the sound.
    }
    if (el?.muted) el.muted = false
  }

  // ── Speed ─────────────────────────────────────────────────────────────────

  /**
   * Applied on every load as well as on the way in.
   *
   * The player resets its rate when it is handed a new video, so a speed chosen
   * once would quietly return to 1 at the end of the first track.
   */
  private applyRate(): void {
    try {
      this.player?.setPlaybackRate(this.state.rate)
    } catch {
      // A player build that does not take the rate keeps the one it has.
    }
    // And straight at the element, because the player is not always listening.
    //
    // Measured 2026-09-04: in the stuck state described in tick(), the player
    // ignores setPlaybackRate and getPlaybackRate goes on answering 1 — but
    // the element takes the rate and *means* it. Re-asserted twice a second
    // from tick(), the clock advanced 1.49 seconds per wall second against a
    // chosen 1.5, over fourteen checks. So the sound really is at the speed
    // that was asked for, whatever the player says about it. Writing it once
    // is not enough on its own: YouTube puts it back to 1 within a second,
    // which the re-assertion undoes on the next tick.
    const el = this.videoEl()
    if (el && el.playbackRate !== this.state.rate) el.playbackRate = this.state.rate
  }

  // ── Quality ───────────────────────────────────────────────────────────────
  //
  // **음악 모드에서는 화면이 필요 없으니 가장 작은 스트림만 받습니다.**
  // Music mode hides the picture, and a hidden picture is still downloaded and
  // still decoded. Asking for the smallest stream there is costs nothing that
  // anyone can see and saves the battery and the data that the other 99% of
  // the pixels were spending. Video mode puts it back.
  //
  // There is no switch for this and there should not be: the mode the person
  // already chose says which of the two they want.
  //
  // **Measured 2026-09-04, live, and none of it is guessable.**
  //
  //   setPlaybackQuality('tiny')          does nothing at all. 360p stayed 360p
  //   setPlaybackQualityRange('tiny','tiny')   144p within a few seconds
  //   setPlaybackQualityRange('tiny','hd1080') from a pinned 144p: still 144p
  //                                            after 20s. A wide range permits,
  //                                            it does not push
  //   setPlaybackQualityRange('auto')     releases the pin, but crawls: 144p to
  //                                       360p over 36 seconds and no further
  //   auto, then the ceiling              1080p within 20s, and stays
  //
  // So restoring takes both calls in that order, and each alone fails in its
  // own quiet way: the ceiling alone never leaves 144p, and auto alone leaves
  // video mode sitting at 360p.

  /**
   * The ceiling for video mode **on a phone**. Above this is a lot of battery
   * and a lot of data for a screen that cannot show the difference. A desktop
   * has no such reason, so it is not capped there (see applyQuality): a PC
   * stage that could show 1440p or 4K was being held to 1080p, which is the
   * "PC 자동 화질이 작살났다" report.
   */
  private static readonly PHONE_CEILING = 'hd1080'

  /**
   * The smallest stream this video actually offers.
   *
   * Read rather than assumed: the list is highest-first with `auto` last, and
   * `tiny` is not on every video. Falls back to the name YouTube uses for 144p.
   */
  private lowestLevel(): string {
    try {
      const levels = this.player?.getAvailableQualityLevels?.() ?? []
      const real = levels.filter((l) => l !== 'auto')
      return real[real.length - 1] ?? 'tiny'
    } catch {
      return 'tiny'
    }
  }

  /** The best this video offers: the list is highest-first with `auto` last. */
  private highestLevel(): string {
    try {
      const levels = this.player?.getAvailableQualityLevels?.() ?? []
      const real = levels.filter((l) => l !== 'auto')
      return real[0] ?? Engine.PHONE_CEILING
    } catch {
      return Engine.PHONE_CEILING
    }
  }

  /** The top of the range video mode allows: the phone's battery cap, or the video's best on a desktop. */
  private videoCeiling(): string {
    return narrowNow() ? Engine.PHONE_CEILING : this.highestLevel()
  }

  /**
   * What the current mode wants the player to be showing.
   *
   * Only the music-mode branch is used (the tick re-pins quality in music mode
   * alone), so this is the low pin; video mode's ceiling is a range, applied
   * in applyQuality.
   */
  private wantedQuality(): string {
    return this.state.mode === 'music' ? this.lowestLevel() : this.videoCeiling()
  }

  private applyQuality(): void {
    const p = this.player
    if (!p || typeof p.setPlaybackQualityRange !== 'function') return
    try {
      if (this.state.mode === 'music') {
        const low = this.lowestLevel()
        p.setPlaybackQualityRange(low, low)
      } else {
        // Both, in this order. See the measurements above. The ceiling is the
        // phone's battery cap on a narrow screen and the video's own best on a
        // desktop, so a PC stage is free to reach 1440p or 4K.
        p.setPlaybackQualityRange('auto')
        p.setPlaybackQualityRange(this.lowestLevel(), this.videoCeiling())
      }
    } catch {
      // A player build without the range form keeps whatever it was showing,
      // which is the behaviour this feature replaced anyway.
    }
  }

  setRate(rate: number): void {
    this.state.rate = rate
    this.applyRate()
    this.changed()
  }

  // ── Sleep ─────────────────────────────────────────────────────────────────

  /**
   * When to stop by itself: a wall-clock time, the end of this track, or never.
   *
   * Deliberately not persisted. A timer is set for tonight, and finding it
   * still armed tomorrow — or, worse, firing in the middle of the afternoon
   * because a tab was reopened — is the kind of surprise this feature exists to
   * avoid.
   */
  sleep: { at: number } | { atTrackEnd: true } | undefined

  sleepIn(minutes: number): void {
    this.sleep = { at: Date.now() + minutes * 60_000 }
    this.changed()
  }

  sleepAfterTrack(): void {
    this.sleep = { atTrackEnd: true }
    this.changed()
  }

  cancelSleep(): void {
    this.sleep = undefined
    this.changed()
  }

  /** Minutes left, rounded up, or undefined when nothing is set by the clock. */
  sleepLeft(): number | undefined {
    if (!this.sleep || !('at' in this.sleep)) return undefined
    return Math.max(0, Math.ceil((this.sleep.at - Date.now()) / 60_000))
  }

  /** Stops where it stands, rather than at the start of the next track. */
  private fallAsleep(): void {
    this.sleep = undefined
    this.wantsPlaying = false
    this.wantsSound = false
    if (this.position.playing) this.player?.pauseVideo()
    this.changed()
  }

  /**
   * Lets WebKit play under script, once, from inside a gesture.
   *
   * On iOS a media element may only be started by script after a user gesture
   * has started it at least once. `loadVideoById` does its work asynchronously,
   * so the `playVideo()` that follows it runs a beat later with the activation
   * already spent — and the video sits there, loaded and paused, which is
   * exactly the report from the phone. Playing the element that is *already*
   * loaded is synchronous, happens inside the gesture that asked for a track,
   * and is what grants the element the permission for the rest of the session.
   *
   * Costs a few milliseconds of the outgoing video on the first press and
   * nothing at all after that. Chromium and Gecko never needed it.
   */
  private unlocked = false
  private unlockPlayback(): void {
    if (this.unlocked) return
    const el = document.querySelector('video')
    if (!el) return
    this.unlocked = true
    void Promise.resolve(el.play()).catch(() => {
      this.unlocked = false
    })
  }

  /** Points the player at the current track, navigating if there is no player yet. */
  private load(): void {
    this.releaseHold()
    const track = this.current
    if (!track) return
    this.loading = track.videoId
    this.loadedId = track.videoId
    this.loadSeq += 1
    this.loadAskedAt = Date.now()
    this.wantPaused = false
    this.endedFor = undefined
    // A new track is a clean sheet: its own ladder, nothing held over, and no
    // memory of the last one having been given up on.
    this.rescue = rescueRecord(track.videoId)
    this.rescueAt = 0
    this.gaveUpOn = undefined
    this.needsGesture = false
    this.adPausedSince = undefined
    this.trouble = undefined
    remember(track)
    this.progressAt = Date.now()
    this.progressTime = -1
    this.foreignSince = undefined
    this.foreignPushFor = -1
    this.everPlayed = false
    this.wantsSound = true
    if (this.player) {
      this.wantsPlaying = true
      this.unlockPlayback()
      // A player that throws at being handed a track has still been asked for
      // one, and the ladder above is what answers for it. Letting the throw out
      // of here would take the press's own handler down with it, and with it
      // the rate, the mute and the redraw below.
      try {
        this.player.loadVideoById(track.videoId)
        this.player.playVideo()
      } catch {
        // Nothing here depends on the player having accepted it.
      }
      this.applyRate()
      // Pressing a track is asking to hear it. If the page handed us a player
      // it had muted for its own preview, that mute goes now.
      this.syncMute()
    } else {
      setQuickOn(true)
      markArrival(track.videoId)
      save(this.state)
      location.assign(`/watch?v=${track.videoId}`)
    }
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  /**
   * Reassert a track iOS paused while handing the page to background audio.
   *
   * This is not general recovery and must never turn an external pause back
   * on. It is called only from an honest hidden/pagehide transition, and only
   * if this same track is still wanted. The player's synchronous pause event
   * clears `wasSounding` before WebKit announces hidden, so that observation
   * cannot gate the hand-off. Measured on iPhone Orion, 2026-09-10: on return the element was
   * still loaded at 649s and immediately playing again, proving the page was
   * suspended rather than the queue or player being lost.
   */
  resumeForBackground(): void {
    if (!this.wantsSound || this.wantPaused || !this.current) return
    const el = this.videoEl()
    if (!el || !el.paused || el.ended) return
    this.wantsPlaying = true
    this.tryStart()
  }

  /**
   * Treats the PiP button as the play gesture it plainly is.
   *
   * On a first visit we hold YouTube's autoplay down until the reader asks to
   * hear something. PiP used to call play() only on the element, without
   * releasing that hold or recording sound intent. The system window opened,
   * then the next engine tick paused its video again: an endless spinner or a
   * still PiP window (measured on iPhone Safari/Orion, 2026-09-10).
   *
   * This must run synchronously in the PiP button's handler. It spends the
   * same user activation on the player and element, then enterPip spends it on
   * the presentation change; no timer may sit between them.
   */
  resumeForPip(): void {
    this.releaseHold()
    const p = this.player
    if (!p) {
      this.load()
      return
    }
    const named = this.namedVideo()
    const expected = this.current?.videoId
    // Never give a PiP window the automatic video that the bar already
    // rejected. Hand the player its displayed track first.
    if (named && expected && named !== expected) {
      this.load()
      return
    }
    this.wantPaused = false
    this.wantsPlaying = true
    this.wantsSound = true
    this.needsGesture = false
    this.unlockPlayback()
    try {
      p.playVideo()
    } catch {
      // The element route in tryStart is the second owner of this gesture.
    }
    this.syncMute()
    this.tryStart()
  }

  toggle(): void {
    this.releaseHold()
    const p = this.player
    if (!p) {
      this.load()
      return
    }
    if (this.sounding()) {
      p.pauseVideo()
      // A pause during a load has to outlive the load. `load()` asked the
      // player to play, and the player obeys that when the video becomes
      // ready — so without this the track starts anyway a second later and the
      // press looks ignored, which is exactly how it looked.
      this.wantPaused = true
      this.wantsPlaying = false
      this.wantsSound = false
    } else {
      const named = this.namedVideo()
      const expected = this.current?.videoId
      // A play press over a foreign paused frame must load the bar's track;
      // playVideo() alone would resume the automatic video we just rejected.
      if (named && expected && named !== expected) {
        this.load()
        return
      }
      this.wantPaused = false
      this.wantsPlaying = true
      this.wantsSound = true
      // The press is the gesture the browser was holding out for, so the
      // exemption it bought goes with it: if this one does not play either,
      // the ladder is free to work again.
      this.needsGesture = false
      this.unlockPlayback()
      p.playVideo()
      this.syncMute()
    }
  }

  /** Set when someone pauses a track that has not finished loading. */
  private wantPaused = false

  /** The track we have already acted on the end of, so it only counts once. */
  private endedFor: string | undefined

  /** When an advert was last seen, so the end of one cannot be read as the end of a track. */
  private adSeenAt = 0

  seek(seconds: number): void {
    this.player?.seekTo(seconds, true)
    this.tick()
  }

  setVolume(v: number): void {
    this.state.volume = Math.max(0, Math.min(100, Math.round(v)))
    this.applyVolume()
    this.changed()
  }

  /**
   * Silences without forgetting the level.
   *
   * Volume zero is how this player mutes — there is one slider and it is the
   * truth — so unmuting has to remember what it was before, or every mute is
   * followed by hunting for the level again.
   */
  private beforeMute = 0
  /**
   * Muting is a flag, not a volume of zero.
   *
   * It *was* a volume of zero, which works on a desktop and does exactly
   * nothing on an iPhone: that device refuses a volume from script and
   * refuses it silently, so the button was pressed, the state said 0, and the
   * sound carried on. The muted flag is a different permission and iOS does
   * honour it. So the flag is what mutes, and the volume follows only where
   * the volume means anything — a device that ignores it must keep its stored
   * value, or unmuting would have nothing to go back to.
   */
  toggleMute(): void {
    if (this.muted) {
      this.userMuted = false
      if (this.state.volume === 0) this.state.volume = this.beforeMute || 100
      this.applyVolume()
    } else {
      this.userMuted = true
      if (this.state.volume > 0) this.beforeMute = this.state.volume
      // The volume follows only where the volume means anything. A device
      // that ignores it must keep its stored value, or unmuting would have
      // nothing to go back to; the flag is what silences it there.
      if (this.volumeSettable !== false) this.state.volume = 0
      this.syncMute()
    }
    this.changed()
  }

  private ended(): void {
    // Whatever happens next sets its own intent: the next track's load, the
    // repeat below, or nothing at all when the queue has run out.
    this.wantsSound = false
    if (this.sleep && 'atTrackEnd' in this.sleep) {
      this.sleep = undefined
      this.changed()
      return
    }
    if (this.state.repeat === 'one') {
      this.wantsSound = true
      this.wantsPlaying = true
      this.loadAskedAt = Date.now()
      this.progressAt = Date.now()
      this.player?.seekTo(0, true)
      this.player?.playVideo()
      return
    }
    this.next()
  }

  next(): void {
    const q = this.state.queue
    if (q.length === 0) return
    let i = this.state.index + 1
    // Skip rows the source marked unplayable rather than stalling on them.
    while (i < q.length && q[i]!.unavailable) i++
    if (i >= q.length) {
      if (this.state.repeat !== 'all') return
      i = 0
    }
    this.state.index = i
    this.load()
    this.changed()
  }

  prev(): void {
    // Standard behaviour: early in a track, go back; otherwise restart it.
    if (this.position.current > 3 || this.state.index <= 0) {
      this.seek(0)
      return
    }
    this.state.index -= 1
    this.load()
    this.changed()
  }

  jumpTo(index: number): void {
    if (index < 0 || index >= this.state.queue.length) return
    this.state.index = index
    this.load()
    this.changed()
  }

  // ── The queue ─────────────────────────────────────────────────────────────

  /** Replaces the queue and starts at `index`. */
  play(tracks: Track[], index = 0): void {
    if (tracks.length === 0) return
    this.state.queue = this.state.shuffle ? shuffled(tracks, index) : tracks.slice()
    this.state.index = this.state.shuffle ? 0 : index
    this.load()
    this.changed()
  }

  /** Puts the tracks right after the current one, and plays the first. */
  playNow(tracks: Track[]): void {
    this.playNext(tracks)
    this.state.index += 1
    this.load()
    this.changed()
  }

  playNext(tracks: Track[]): void {
    if (tracks.length === 0) return
    this.state.queue.splice(this.state.index + 1, 0, ...tracks)
    if (this.state.index < 0) this.state.index = -1
    this.changed()
  }

  enqueue(tracks: Track[]): void {
    if (tracks.length === 0) return
    this.state.queue.push(...tracks)
    this.changed()
  }

  /**
   * Moves one row, and says where the playing track ended up.
   *
   * Reordering a list must never interrupt what is coming out of the
   * speakers, so nothing here touches the player: the array is rearranged and
   * the index is corrected to point at the same track it pointed at before.
   * Working it out afterwards by searching for the track would be simpler and
   * wrong, because a queue is allowed to hold the same video twice.
   *
   * `to` is the index in the list *after* the row has been lifted out, which
   * is what a splice-out-splice-in does and what a drop between two rows
   * means.
   */
  moveTrack(from: number, to: number): void {
    const q = this.state.queue
    if (from === to) return
    if (from < 0 || from >= q.length || to < 0 || to >= q.length) return
    const [track] = q.splice(from, 1)
    if (!track) return
    q.splice(to, 0, track)
    this.state.index = movedIndex(this.state.index, from, to)
    this.changed()
  }

  /**
   * Takes one row out.
   *
   * Removing the row that is playing moves on to whatever slid into its place,
   * because the alternative is a player whose track is not in the list — which
   * reads as a bug every time. Removing anything else leaves the music alone.
   */
  removeAt(index: number): void {
    const q = this.state.queue
    if (index < 0 || index >= q.length) return
    const wasCurrent = index === this.state.index
    q.splice(index, 1)
    if (index < this.state.index) this.state.index -= 1
    if (wasCurrent) {
      if (q.length === 0) this.state.index = -1
      else {
        this.state.index = Math.min(index, q.length - 1)
        this.load()
      }
    }
    this.changed()
  }

  clear(): void {
    const cur = this.current
    this.state.queue = cur ? [cur] : []
    this.state.index = cur ? 0 : -1
    this.changed()
  }

  setRepeat(mode: Repeat): void {
    this.state.repeat = mode
    this.changed()
  }

  cycleRepeat(): void {
    const order: Repeat[] = ['off', 'all', 'one']
    this.setRepeat(order[(order.indexOf(this.state.repeat) + 1) % order.length]!)
  }

  /** Shuffles what is still to come; what has played keeps its order. */
  setShuffle(on: boolean): void {
    this.state.shuffle = on
    if (on && this.state.queue.length > this.state.index + 1) {
      const head = this.state.queue.slice(0, this.state.index + 1)
      const tail = this.state.queue.slice(this.state.index + 1)
      this.state.queue = head.concat(shuffled(tail, -1))
    }
    this.changed()
  }

  setTheme(theme: Theme): void {
    this.state.theme = theme
    save(this.state)
  }

  setLang(lang: Lang): void {
    this.state.lang = lang
    save(this.state)
  }


  setMode(mode: Mode): void {
    this.state.mode = mode
    // The mode is the switch. Nobody has to find a setting for this.
    this.applyQuality()
    // Music mode is chosen in order to listen. A page that was running a
    // muted feed preview before we arrived would otherwise carry that mute
    // into it, so unless the listener muted it themselves, it comes off.
    if (mode === 'music') this.syncMute()
    this.changed()
  }

  setVideo(layout: VideoLayout): void {
    this.state.video = layout
    // A chosen picture layout is remembered so the live drop to 'hidden' when
    // nothing plays cannot erase 영화관/시청.
    if (layout === 'stage' || layout === 'watch') this.state.videoPref = layout
    this.changed()
  }

  /**
   * Remembers where the UI was. Written down but not announced: the navigation
   * that caused it is already drawing the new screen, and telling the
   * subscribers would make it draw twice.
   */
  setView(view: string): void {
    this.state.view = view
    save(this.state)
  }
}

/** Fisher–Yates over a copy; `keepFirst` (if valid) is moved to the front unshuffled. */
function shuffled(tracks: readonly Track[], keepFirst: number): Track[] {
  const out = tracks.slice()
  let first: Track | undefined
  if (keepFirst >= 0 && keepFirst < out.length) first = out.splice(keepFirst, 1)[0]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return first ? [first, ...out] : out
}
