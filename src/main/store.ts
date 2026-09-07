// What the player remembers between page loads.
//
// Kept in the page's own localStorage rather than chrome.storage: it is read
// synchronously at boot, before the bridge to the other world is up, and it
// belongs to this origin anyway.

import type { Lang } from '../shared/i18n.ts'
import type { Track } from './parse.ts'
import { narrowNow } from './ui/device.ts'

export type Repeat = 'off' | 'all' | 'one'
/** Where YouTube's own player sits on screen. */
export type VideoLayout = 'hidden' | 'corner' | 'stage' | 'watch'
/**
 * Which of the two shapes the UI takes. Music is a list with the picture
 * tucked into a corner; video puts the picture first. They share every screen
 * underneath — the same search, the same queue, the same playlists — because
 * on YouTube a song and a video are the same object.
 */
export type Mode = 'music' | 'video'

/** Which side the UI takes. 'auto' is whatever YouTube is set to. */
export type Theme = 'auto' | 'dark' | 'light'

export interface Persisted {
  mode: Mode
  /** Remembered so a reload comes back the way it was left. */
  theme: Theme
  /** null follows YouTube's interface language. */
  lang: Lang | null
  queue: Track[]
  index: number
  repeat: Repeat
  shuffle: boolean
  volume: number
  /** Playback speed, 1 being ordinary. Kept, because a podcast listener means it. */
  rate: number
  video: VideoLayout
  /**
   * The desktop picture layout a person chose and keeps: 영화관(stage) or
   * 시청(watch). Distinct from `video`, which is the live layout and drops to
   * 'hidden' whenever nothing is playing — that drop must not erase the
   * choice, or 시청 would revert to 영화관 on the next load.
   */
  videoPref: 'stage' | 'watch'
  /** Where the UI was; restored so a reload lands in the same place. */
  view: string
}

const KEY = 'oc-easy-mode:state'
const THEME_KEY = 'oc-easy-mode:theme'

export function getStoredTheme(): 'light' | 'dark' | null {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {}
  return null
}

export function setStoredTheme(theme: 'light' | 'dark'): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {}
}

/**
 * Forgets the explicit choice, so the side follows YouTube again.
 *
 * This key is what makes a choice stick, so 자동 cannot be expressed by
 * writing something here. It has to be the absence of a value, which is also
 * the state a browser that has never seen the settings sheet is already in.
 */
export function clearStoredTheme(): void {
  try {
    localStorage.removeItem(THEME_KEY)
  } catch {}
}

/**
 * Whether the sidebar's playlists are folded away.
 *
 * Its own key rather than a field of the state above, because it is a fact
 * about this browser's sidebar and not about what is playing — and because the
 * state blob is written on every tick of the queue, which is a lot of writing
 * for a triangle. Open is the default: a reader who has never touched it should
 * see their lists.
 */
const PLAYLISTS_KEY = 'oc-easy-mode:side-playlists'

/**
 * Whether 관심 없음 also takes the track out of the playlist it came from.
 *
 * Asked once, on the first dislike that has a playlist behind it, and
 * remembered — the point of the button is one press, and a dialog every time
 * would be three. null means it has not been asked yet.
 */
const DISLIKE_KEY = 'oc-easy-mode:dislike-removes'

export function dislikeRemoves(): boolean | null {
  try {
    const v = localStorage.getItem(DISLIKE_KEY)
    if (v === 'yes') return true
    if (v === 'no') return false
  } catch {}
  return null
}

export function setDislikeRemoves(yes: boolean): void {
  try {
    localStorage.setItem(DISLIKE_KEY, yes ? 'yes' : 'no')
  } catch {}
}

/**
 * Which menu lines the reader has turned on or off.
 *
 * Only the choices actually made are written down, as key to boolean. An
 * entry nobody has touched is absent, and falls back to the default in
 * menu.ts — so a line added to the menu later arrives at *its* default
 * rather than at whatever a stale saved list happened to hold.
 */
/**
 * Channels the reader chose not to see recommended ("채널 추천 안함").
 *
 * A local block, by `UC…` id: RenewTube filters these out of every feed and
 * shelf it draws. It does not touch YouTube's own recommendations — a true
 * feedback token is not carried on most of the rows this runs on — but within
 * this player it is exactly what the words say, and it is reversible from
 * 설정. Stored as a plain list of ids.
 */
const HIDDEN_CHANNELS_KEY = 'oc-easy-mode:hidden-channels'

function readHiddenChannels(): string[] {
  try {
    const raw = localStorage.getItem(HIDDEN_CHANNELS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

let hiddenChannelSet: Set<string> | undefined
function hiddenSet(): Set<string> {
  if (!hiddenChannelSet) hiddenChannelSet = new Set(readHiddenChannels())
  return hiddenChannelSet
}

export function hiddenChannels(): string[] {
  return [...hiddenSet()]
}

export function isChannelHidden(id: string | undefined): boolean {
  return id !== undefined && hiddenSet().has(id)
}

export function hideChannel(id: string): void {
  const set = hiddenSet()
  set.add(id)
  try {
    localStorage.setItem(HIDDEN_CHANNELS_KEY, JSON.stringify([...set]))
  } catch {}
}

export function unhideChannel(id: string): void {
  const set = hiddenSet()
  set.delete(id)
  try {
    localStorage.setItem(HIDDEN_CHANNELS_KEY, JSON.stringify([...set]))
  } catch {}
}

const MENU_KEY = 'oc-easy-mode:menu'

export function menuChoices(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(MENU_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export function setMenuChoice(key: string, on: boolean): void {
  try {
    localStorage.setItem(MENU_KEY, JSON.stringify({ ...menuChoices(), [key]: on }))
  } catch {}
}

export function playlistsFolded(): boolean {
  try {
    return localStorage.getItem(PLAYLISTS_KEY) === 'folded'
  } catch {
    return false
  }
}

export function foldPlaylists(folded: boolean): void {
  try {
    localStorage.setItem(PLAYLISTS_KEY, folded ? 'folded' : 'open')
  } catch {}
}

/**
 * Whether the mode should be in dark theme.
 * Explicit user selection in RenewTube wins and survives reloads.
 * Fallbacks follow YouTube's root attribute and system preference.
 */
export function youtubeIsDark(): boolean {
  const stored = getStoredTheme()
  if (stored) return stored === 'dark'
  if (document.documentElement.hasAttribute('dark')) return true
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  } catch {
    return true
  }
}

/** A synchronous "is the mode on" flag, so the hide style can go in at document_start. */
const KEY_ON = 'oc-easy-mode:on'

export const DEFAULTS: Persisted = {
  mode: 'music',
  theme: 'auto',
  lang: null,
  queue: [],
  index: -1,
  repeat: 'off',
  shuffle: false,
  volume: 100,
  rate: 1,
  video: 'hidden',
  videoPref: 'stage',
  // Not 'home', which YouTube leaves empty until it knows you.
  view: 'explore',
}

/**
 * Where the picture goes when a mode is switched on.
 *
 * Music mode shows no picture at all, on every screen. It used to float a
 * corner window on a desktop, and the owner met it as "that PiP thing in the
 * bottom right" (2026-09-06): a window over a list nobody asked to watch,
 * with YouTube's own controls on it. The intent here is YouTube Music, where
 * the artwork in the bar is picture enough; 영상 is the mode for the picture.
 */
export function layoutFor(mode: Mode, _narrow: boolean = narrowNow()): VideoLayout {
  return mode === 'video' ? 'stage' : 'hidden'
}

export function load(): Persisted {
  // The first run's picture placement depends on the device; everything else
  // is the same everywhere.
  const fresh = { ...DEFAULTS, video: layoutFor(DEFAULTS.mode) }
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return fresh
    const got = JSON.parse(raw) as Partial<Persisted>
    const merged = { ...fresh, ...got, queue: Array.isArray(got.queue) ? got.queue : [] }
    // The corner window is gone; a state saved with it lands on sound only.
    if (merged.video === 'corner') merged.video = 'hidden'
    return merged
  } catch {
    return fresh
  }
}

export function save(state: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // Quota or private mode: the queue is lost on reload, nothing worse.
  }
}

// ── Recently played ────────────────────────────────────────────────────────
//
// YouTube's own 시청 기록 needs a session, and signed out there is nothing to
// show — which is the one screen a signed-out listener most wants back. This is
// the same idea kept here instead: the last fifty things this browser played,
// in this origin's own storage, never sent anywhere.

const HISTORY_KEY = 'oc-easy-mode:history'

/** Fifty is a few evenings of listening and a few kilobytes of storage. */
const HISTORY_MAX = 50

export function history(): Track[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const got = JSON.parse(raw) as unknown
    return Array.isArray(got) ? (got as Track[]).filter((t) => t && typeof t.videoId === 'string') : []
  } catch {
    return []
  }
}

/**
 * Puts a track at the front, and only there once.
 *
 * A song played twice in an evening should be one row at the top rather than
 * two rows apart, which is what makes a list like this readable at all.
 */
export function remember(track: Track): void {
  try {
    const next = [track, ...history().filter((t) => t.videoId !== track.videoId)].slice(0, HISTORY_MAX)
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
  } catch {
    // See save(). A lost history is not worth a broken player.
  }
}

export function forgetHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY)
  } catch {}
}

export function quickOn(): boolean {
  try {
    return localStorage.getItem(KEY_ON) === '1'
  } catch {
    return false
  }
}

export function setQuickOn(on: boolean): void {
  try {
    localStorage.setItem(KEY_ON, on ? '1' : '0')
  } catch {
    // See save().
  }
}

// ── The subscription filter ────────────────────────────────────────────────
//
// 구독 is every channel at once, and a feed of forty channels is not a feed
// anyone reads: the two they came for are somewhere in it. This is which
// channels that screen is allowed to show.
//
// **Channels are kept by id, never by name.** A byline is a display name: two
// channels may share one, and a channel may rename itself between one visit
// and the next. A filter that remembered names would start hiding a stranger.
//
// The list is an allow list, and an empty one means no filter at all rather
// than an empty screen: it is the state everybody starts in, and it has to be
// the harmless one. The prefix and the shape follow the other keys here; the
// identifier stays oc-easy-mode whatever the product is called, because it is
// an address in somebody's browser and not a name.

const SUBS_FILTER_KEY = 'oc-easy-mode:subs-filter'

/** The channels 구독 may show. Empty means all of them. */
export function subsFilter(): string[] {
  try {
    const raw = localStorage.getItem(SUBS_FILTER_KEY)
    if (!raw) return []
    const got = JSON.parse(raw) as unknown
    if (!Array.isArray(got)) return []
    return [...new Set(got.filter((v): v is string => typeof v === 'string' && v.startsWith('UC')))]
  } catch {
    return []
  }
}

export function setSubsFilter(ids: string[]): void {
  try {
    const keep = [...new Set(ids.filter((id) => id.startsWith('UC')))]
    if (keep.length === 0) localStorage.removeItem(SUBS_FILTER_KEY)
    else localStorage.setItem(SUBS_FILTER_KEY, JSON.stringify(keep))
  } catch {
    // A browser that refuses storage keeps the filter for this page only,
    // which is better than refusing to filter.
  }
}

// ── Our own arrival ─────────────────────────────────────────────────────────
//
// A track pressed on a page with no player navigates to that track's page to
// play it. The page that arrives has to know the difference between "we came
// here to play this" and "this is where the reader happened to open the
// mode", because the second must not start playing on its own.

const ARRIVAL_KEY = 'oc-easy-mode:arriving'

/** Marks that the next page load is ours, for `videoId`. */
export function markArrival(videoId: string): void {
  try {
    localStorage.setItem(ARRIVAL_KEY, videoId)
  } catch {}
}

/** Reads and clears the mark. */
export function takeArrival(): string | null {
  try {
    const v = localStorage.getItem(ARRIVAL_KEY)
    localStorage.removeItem(ARRIVAL_KEY)
    return v
  } catch {
    return null
  }
}

// ── What has already been tried to make a track play ────────────────────────
//
// The recovery ladder spends one rung at a time, and one of those rungs is a
// navigation — so the record of what has been tried has to outlive the page
// that tried it, or the arriving page starts the same ladder from the top and
// the two bounce off each other for ever. Keyed by the video, so a different
// track always begins with a clean sheet.

const RESCUE_KEY = 'oc-easy-mode:rescue'

export interface Rescue {
  id: string
  /** We have handed this track to the watch page. */
  nav?: boolean
  /** We have pushed it into the player a second time. */
  push?: boolean
  /** We have rebuilt the page around it. */
  reload?: boolean
}

/** What has been tried for `id`, which is nothing at all if the mark is another track's. */
export function rescueRecord(id: string): Rescue {
  try {
    const raw = localStorage.getItem(RESCUE_KEY)
    if (raw) {
      const r = JSON.parse(raw) as Rescue
      if (r && r.id === id) return r
    }
  } catch {
    // A browser without storage simply starts every page with a clean sheet.
  }
  return { id }
}

export function saveRescue(r: Rescue): void {
  try {
    localStorage.setItem(RESCUE_KEY, JSON.stringify(r))
  } catch {}
}

/** Forgotten the moment sound comes out, so the next trouble starts from the top. */
export function clearRescue(): void {
  try {
    localStorage.removeItem(RESCUE_KEY)
  } catch {}
}

// ── What was searched for ──────────────────────────────────────────────────
//
// The panel opens on an empty field, and an empty field over an empty panel is
// a wall. What this browser looked for before is the one thing worth offering
// there, and offering it costs no request at all.
//
// Kept here and only here. A query is a personal thing, and this one never
// leaves the origin it was typed on. Same prefix as every other key in this
// file, because it is an address in somebody's browser rather than a name.

const SEARCHES_KEY = 'oc-easy-mode:searches'

/** A dozen fills the empty panel without turning it into a list to read. */
const SEARCHES_MAX = 12

/** The queries this browser searched for, newest first. */
export function recentSearches(): string[] {
  try {
    const raw = localStorage.getItem(SEARCHES_KEY)
    if (!raw) return []
    const got = JSON.parse(raw) as unknown
    if (!Array.isArray(got)) return []
    return got.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, SEARCHES_MAX)
  } catch {
    return []
  }
}

/**
 * Puts a query at the front, and only there once.
 *
 * An empty query is never stored: a blank row in this list is a row that
 * searches for nothing, which is not something anyone can have meant.
 */
export function rememberSearch(query: string): void {
  const q = query.trim()
  if (!q) return
  try {
    const next = [q, ...recentSearches().filter((v) => v !== q)].slice(0, SEARCHES_MAX)
    localStorage.setItem(SEARCHES_KEY, JSON.stringify(next))
  } catch {
    // See save(). A forgotten query is not worth a broken panel.
  }
}

/** Takes one query off the list. */
export function forgetSearch(query: string): void {
  try {
    const next = recentSearches().filter((v) => v !== query)
    if (next.length === 0) localStorage.removeItem(SEARCHES_KEY)
    else localStorage.setItem(SEARCHES_KEY, JSON.stringify(next))
  } catch {}
}

export function clearSearches(): void {
  try {
    localStorage.removeItem(SEARCHES_KEY)
  } catch {}
}
