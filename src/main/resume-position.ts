// Where a listening place lives, and who may be told to come back to it.
//
// A place belongs to one tab: it is kept in `sessionStorage`, which a reload
// or a same-tab redirect carries with it, and which a second tab, a closed
// session and another origin never see. The record is read back as `unknown`
// and narrowed field by field, because storage holds what some earlier page
// wrote there, not what this one knows.
//
// The second key is an intent, not a fact: a one-time target marked by a
// continuation (a reload redirect, a rescue) and consumed only by the arrival
// that names the same track. Taking it always removes it, so a stale mark can
// never authorize a later page.

/** Where the current tab's place is kept. */
const POS_KEY = 'oc-easy-mode:resume-position'
/** Where the one-time resume intent for the next arrival is kept. */
const ARRIVAL_KEY = 'oc-easy-mode:resume-arrival'
/** Where 0.24.28 kept the place. Removed on sight, never read or migrated. */
const LEGACY_KEY = 'oc-easy-mode:left-at'

/** A place that matched the track it was asked about. */
export interface ResumePlace {
  readonly videoId: string
  readonly seconds: number
}

/** One beat of where a track is, offered to be written down. */
export interface ResumeSample {
  readonly videoId: string
  readonly seconds: number
  readonly duration: number
}

/**
 * Whether a failure only costs the place: storage refusing (DOMException) or
 * a record that is not JSON (SyntaxError). Anything else is a bug, and is
 * let through rather than dressed up as an empty store.
 */
function unavailable(e: unknown): boolean {
  return e instanceof DOMException || e instanceof SyntaxError
}

/**
 * The record's own rules: a real track, a place worth coming back to, and a
 * track long enough to have one. A place under three seconds is a start, not
 * a place; within ten of the end, resuming it is playing out its last breath.
 */
function persistable(videoId: string, seconds: number, duration: number): boolean {
  return (
    videoId !== '' &&
    Number.isFinite(seconds) &&
    Number.isFinite(duration) &&
    duration > 0 &&
    seconds >= 3 &&
    seconds <= duration - 10
  )
}

/** Parses one stored record, kept only when it is `videoId`'s own place. */
function parse(raw: string, videoId: string): ResumePlace | null {
  const got: unknown = JSON.parse(raw)
  if (typeof got !== 'object' || got === null) return null
  const rec = got as { videoId?: unknown; seconds?: unknown; duration?: unknown }
  if (typeof rec.videoId !== 'string' || typeof rec.seconds !== 'number' || typeof rec.duration !== 'number') {
    return null
  }
  if (!persistable(rec.videoId, rec.seconds, rec.duration)) return null
  return rec.videoId === videoId ? { videoId: rec.videoId, seconds: rec.seconds } : null
}

/** Reads this tab's place for `videoId`, or null for none, no match, or junk. */
export function readPosition(storage: Storage, videoId: string): ResumePlace | null {
  // The predecessor's key is this origin's, not this tab's: whatever any tab
  // wrote there is not this tab's to resume, so the key goes unused and, on
  // the first read of the new one, away.
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch (e) {
    if (!unavailable(e)) throw e
  }
  try {
    const raw = storage.getItem(POS_KEY)
    return raw ? parse(raw, videoId) : null
  } catch (e) {
    if (!unavailable(e)) throw e
    return null
  }
}

/**
 * Writes `sample` down, or clears the place when the sample is not worth
 * keeping: at the edges of a track, the honest record is no record.
 *
 * Says whether the store took the instruction: a saved sample and a
 * deliberate clear both count, and only a store that refused (the expected
 * failure) does not, so the caller's next beat is not pushed away from a
 * write that never happened.
 */
export function writePosition(storage: Storage, sample: ResumeSample): boolean {
  try {
    if (persistable(sample.videoId, sample.seconds, sample.duration)) {
      storage.setItem(POS_KEY, JSON.stringify(sample))
    } else {
      storage.removeItem(POS_KEY)
    }
    return true
  } catch (e) {
    if (!unavailable(e)) throw e
    return false
  }
}

/** Clears this tab's place, whatever track it names. */
export function clearPosition(storage: Storage): void {
  try {
    storage.removeItem(POS_KEY)
  } catch (e) {
    if (!unavailable(e)) throw e
  }
}

/** Marks the next arrival in this tab as a continuation coming back to `videoId`. */
export function markResumeArrival(storage: Storage, videoId: string): void {
  if (videoId === '') return
  try {
    storage.setItem(ARRIVAL_KEY, videoId)
  } catch (e) {
    if (!unavailable(e)) throw e
  }
}

/**
 * Spends the continuation mark, and says whether it named exactly `videoId`.
 *
 * The mark is removed whether it matched, mismatched, or was malformed, so no
 * stale intent survives to authorize a page it was never meant for.
 */
export function takeResumeArrival(storage: Storage, videoId: string): boolean {
  try {
    const marked = storage.getItem(ARRIVAL_KEY)
    storage.removeItem(ARRIVAL_KEY)
    return typeof marked === 'string' && marked !== '' && marked === videoId
  } catch (e) {
    if (!unavailable(e)) throw e
    return false
  }
}
