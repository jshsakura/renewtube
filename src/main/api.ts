// What the player asks YouTube for, as questions rather than endpoints.
//
// Every function here is one or a few InnerTube calls plus a parser. The
// endpoints are the ones youtube.com itself uses for the same screens, so the
// request shapes are copied from the page rather than invented.

import { call, hasSession, InnertubeError, type Client } from './innertube.ts'
import type { Json } from './parse.ts'
import {
  channels as parseChannels,
  collect,
  continuationToken,
  isObject,
  playlists as parsePlaylists,
  sectionContinuation,
  shelves as parseShelves,
  tracks as parseTracks,
  dedupe,
  type Channel,
  type ChannelHit,
  type Playlist,
  type Shelf,
  type Track,
} from './parse.ts'
import type { YtCfg } from './ytcfg.ts'

export interface Page {
  tracks: Track[]
  /**
   * The response's titled rows, when it had any. A screen with shelves is laid
   * out like a television's; one without falls back to the flat list above.
   */
  shelves: Shelf[]
  /** Pass back to `more()` for the next page; undefined at the end. */
  continuation?: string
  /** Which endpoint the continuation belongs to. */
  endpoint: 'search' | 'browse' | 'next'
  /** Which client answered, so the continuation is asked of the same one. */
  client?: Client
}

// Search filter "type: video", protobuf-encoded the way the page sends it.
// Without it a query returns channels and playlists mixed in with the songs.
const VIDEOS_ONLY = 'EgIQAQ%3D%3D'

export async function search(cfg: YtCfg, query: string): Promise<Page> {
  // As the desktop client where the page is not one, the way the feeds and
  // playlists already are. The mobile client answers a search in shapes this
  // parser does not read, so on a phone every query came back as "no
  // results" (2026-09-04, 마인크래프트). The page's own client is the fallback.
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  let res: Json
  let client: Client = as
  try {
    res = await call(cfg, 'search', { query, params: VIDEOS_ONLY }, as)
  } catch (err) {
    if (as === 'page') throw err
    client = 'page'
    res = await call(cfg, 'search', { query, params: VIDEOS_ONLY })
  }
  return { tracks: parseTracks(res), shelves: [], continuation: continuationToken(res), endpoint: 'search', client }
}

/** A mix seeded from one video: the page's own "radio" for it. */
export async function mix(cfg: YtCfg, videoId: string): Promise<Page> {
  const res = await call(cfg, 'next', { videoId, playlistId: `RD${videoId}` })
  return { tracks: parseTracks(res), shelves: [], continuation: continuationToken(res), endpoint: 'next' }
}

/** One line of the song, and when it is sung. */
export interface Line {
  /** Seconds from the start, or -1 when the words came without timings. */
  at: number
  text: string
}

/**
 * Strips what a music upload's title collects on its way to YouTube.
 *
 * `[MV]`, `(Official Video)`, `[4K]`, `(ENG SUB)` and their friends are the
 * uploader's furniture, not part of the song's name, and a lyrics database has
 * never heard of any of them.
 */
function cleanTitle(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/【[^】]*】/g, ' ')
    .replace(/\((?:official[^)]*|lyrics?[^)]*|audio|video|mv|m\/v|hd|hq|4k|8k|eng(?:lish)?[^)]*|자막[^)]*)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The ways one name might be written.
 *
 * Korean uploads routinely carry both scripts at once — `IU(아이유)`,
 * `밤편지(Through the Night)` — and a database holds one of them. Both are
 * offered, the part outside the brackets first, because that is the one that is
 * usually the canonical title.
 */
function variants(part: string): string[] {
  const outside = part.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
  const inside = [...part.matchAll(/\(([^)]*)\)/g)].map((m) => m[1]!.trim())
  return [...new Set([outside, ...inside, part.trim()].filter(Boolean))]
}

/**
 * Guesses the artist and the song out of a video's title and channel.
 *
 * `1theK` did not write 밤편지 — the channel that uploaded a music video is
 * almost never the artist, so the title is split on the separator these uploads
 * use (`아티스트 _ 곡명`, `Artist - Title`) and the channel is only the
 * fallback for a title that has no separator in it at all.
 */
function namesOf(title: string, author: string): Array<{ artist: string; track: string }> {
  const clean = cleanTitle(title)
  const split = clean.match(/^(.+?)\s*[_\-–—|]\s*(.+)$/)
  const artists = split ? variants(split[1]!) : variants(cleanTitle(author))
  const tracks = variants(split ? split[2]! : clean)
  const out: Array<{ artist: string; track: string }> = []
  for (const track of tracks) for (const artist of artists) out.push({ artist, track })
  // Four is enough to cover both scripts on both halves, and is the point at
  // which asking again stops being worth another round trip.
  return out.slice(0, 4)
}

interface LrcRecord {
  syncedLyrics?: string | null
  plainLyrics?: string | null
}

/**
 * Parses an LRC body into lines.
 *
 * A line may carry several timestamps — that is how a repeated chorus is
 * written — so each one becomes its own line, and the result is put back in
 * order at the end.
 */
function fromLrc(body: string): Line[] {
  const out: Line[] = []
  for (const raw of body.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const stamp of stamps) {
      const fraction = stamp[3] ? Number(`0.${stamp[3]}`) : 0
      out.push({ at: Number(stamp[1]) * 60 + Number(stamp[2]) + fraction, text })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Untimed words, one line each. Marked with -1 so nothing tries to follow them. */
function fromPlain(body: string): Line[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ at: -1, text }))
}

/**
 * LRCLIB, asked for one song.
 *
 * A public, key-less lyrics database that allows cross-origin reads, which is
 * what makes it usable from inside the page at all — measured reachable from
 * www.youtube.com on 2026-09-03, CSP and CORS both permitting. It answers 404
 * for a song it does not have and 503 when it is busy, and neither is worth
 * telling anyone about: a missing lyric is a normal outcome.
 */
async function lrclib(path: string): Promise<LrcRecord[]> {
  try {
    const res = await fetch(`https://lrclib.net/api/${path}`)
    if (!res.ok) return []
    const body = (await res.json()) as LrcRecord | LrcRecord[]
    return Array.isArray(body) ? body : [body]
  } catch {
    return []
  }
}

/** The video's own captions, which for a music video are usually its words. */
function fromCaptions(res: Json): Promise<Line[]> {
  const list = (res as {
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: Array<{ baseUrl?: string; kind?: string }> } }
  }).captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
  // A track someone wrote beats one a machine guessed.
  const chosen = list.filter((track) => track.kind !== 'asr')[0] ?? list[0]
  if (!chosen?.baseUrl) return Promise.resolve([])
  return fetch(`${chosen.baseUrl}&fmt=json3`, { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : { events: [] }))
    .then((body: { events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }> }) => {
      const out: Line[] = []
      for (const event of body.events ?? []) {
        const text = (event.segs ?? []).map((seg) => seg.utf8 ?? '').join('').replace(/\n/g, ' ').trim()
        if (text) out.push({ at: (event.tStartMs ?? 0) / 1000, text })
      }
      return out
    })
    .catch(() => [])
}

/**
 * The words, in the best form anything will give them up.
 *
 * Three sources, in the order of how well they read on a screen that is
 * following along:
 *
 * 1. **LRCLIB's synced lyrics** — real per-line timings, which is what a lyrics
 *    pane is for.
 * 2. **The video's own captions** — the same words with timings, when the
 *    uploader wrote them. Roughly half of music videos have none, which is what
 *    this whole pipeline exists to fix.
 * 3. **LRCLIB's plain lyrics** — the words with no timings. Marked `at: -1`, so
 *    the pane shows them and stops trying to scroll.
 *
 * Nothing found is a normal answer, not an error.
 */
export async function lyrics(cfg: YtCfg, videoId: string): Promise<Line[]> {
  // Asked as the web client on purpose: the mobile one answers this without a
  // caption list. It is also where the real title and channel come from, which
  // is what the lyrics database needs to be asked with.
  const res = await call(cfg, 'player', { videoId }, 'web')
  const details = (res.videoDetails ?? {}) as { title?: string; author?: string }

  let plain: Line[] = []
  for (const { artist, track } of namesOf(details.title ?? '', details.author ?? '')) {
    const query = `get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`
    for (const record of await lrclib(query)) {
      if (record.syncedLyrics) return fromLrc(record.syncedLyrics)
      if (record.plainLyrics && plain.length === 0) plain = fromPlain(record.plainLyrics)
    }
  }

  const captions = await fromCaptions(res)
  if (captions.length > 0) return captions
  if (plain.length > 0) return plain

  // Last resort: the database's own search, for a title the split above read
  // wrongly. One request, and it is allowed to fail.
  const clean = cleanTitle(details.title ?? '')
  for (const record of await lrclib(`search?q=${encodeURIComponent(clean)}`)) {
    if (record.syncedLyrics) return fromLrc(record.syncedLyrics)
    if (record.plainLyrics) return fromPlain(record.plainLyrics)
  }
  return []
}

/** The next page of any of the above. */
export async function more(cfg: YtCfg, page: Page): Promise<Page> {
  if (!page.continuation) return { tracks: [], shelves: [], endpoint: page.endpoint }
  const res = await call(cfg, page.endpoint, { continuation: page.continuation }, page.client ?? 'page')
  return { tracks: parseTracks(res), shelves: [], continuation: continuationToken(res), endpoint: page.endpoint, client: page.client }
}

/** The signed-in user's playlists. Throws an `auth` error when signed out. */
export async function myPlaylists(cfg: YtCfg): Promise<Playlist[]> {
  const res = await call(cfg, 'browse', { browseId: 'FEplaylist_aggregation' })
  let list = parsePlaylists(res)
  if (list.length === 0 && !hasSession()) throw new InnertubeError('signed out', 'auth', 401)
  let token = continuationToken(res)
  for (let i = 0; token && i < 10; i++) {
    const next = await call(cfg, 'browse', { continuation: token })
    list = list.concat(parsePlaylists(next))
    token = continuationToken(next)
  }
  return list
}

/**
 * Every track of one playlist, following continuations.
 *
 * Asked as the desktop client wherever the page is not one. The mobile client
 * answers this particular question with twenty tracks and no way to ask for
 * more, so a 99-track playlist would silently become a 20-track queue — which
 * is exactly what it did. If the borrowed client is refused, the page's own is
 * used instead: fewer tracks beats an error.
 */
export async function playlistTracks(cfg: YtCfg, playlistId: string, limit = 1000): Promise<Track[]> {
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  const browse = async (body: Record<string, unknown>) => {
    try {
      return await call(cfg, 'browse', body, as)
    } catch (err) {
      if (as === 'page') throw err
      return call(cfg, 'browse', body)
    }
  }

  const res = await browse({ browseId: `VL${playlistId}` })
  let list = parseTracks(res)
  let token = continuationToken(res)
  while (token && list.length < limit) {
    const next = await browse({ continuation: token })
    const before = list.length
    list = dedupe(list.concat(parseTracks(next)))
    // A page that adds nothing new ends the walk, whether it was empty or a
    // repeat of what we already have.
    if (list.length === before) break
    token = continuationToken(next)
  }
  return list
}

export async function createPlaylist(cfg: YtCfg, title: string, videoIds: string[] = []): Promise<string> {
  const res = await call(cfg, 'playlist/create', { title, videoIds, privacyStatus: 'PRIVATE' })
  const id = res.playlistId
  if (typeof id !== 'string') throw new InnertubeError('playlist/create returned no id', 'shape')
  return id
}

export async function deletePlaylist(cfg: YtCfg, playlistId: string): Promise<void> {
  await call(cfg, 'playlist/delete', { playlistId })
}

export async function addToPlaylist(cfg: YtCfg, playlistId: string, videoIds: string[]): Promise<void> {
  await call(cfg, 'browse/edit_playlist', {
    playlistId,
    actions: videoIds.map((addedVideoId) => ({ action: 'ACTION_ADD_VIDEO', addedVideoId })),
  })
}

/**
 * Moves one track within a playlist.
 *
 * YouTube has no "move to position": a row is placed *after* another one, so a
 * move is named by the row it should follow. `after` is that row's
 * `setVideoId`, and leaving it out means the top of the list.
 *
 * Both ids are `setVideoId`, not `videoId`, because they name slots rather
 * than videos: a playlist may hold the same video twice, and moving one copy
 * must not move the other.
 *
 * **Unverified against a signed-in account.** This browser has no session, and
 * the endpoint refuses without one, so what is checked is the request this
 * sends and what the screen does when the answer is a failure. Whether YouTube
 * accepts the body needs a real account.
 */
export async function movePlaylistTrack(
  cfg: YtCfg,
  playlistId: string,
  setVideoId: string,
  after: string | undefined,
): Promise<void> {
  await call(cfg, 'browse/edit_playlist', {
    playlistId,
    actions: [
      {
        action: 'ACTION_MOVE_VIDEO_AFTER',
        setVideoId,
        ...(after ? { movedSetVideoIdPredecessor: after } : {}),
      },
    ],
  })
}

/** Removes one slot when the row said which, otherwise every copy of the video. */
export async function removeFromPlaylist(cfg: YtCfg, playlistId: string, track: Track): Promise<void> {
  const action = track.setVideoId
    ? { action: 'ACTION_REMOVE_VIDEO', setVideoId: track.setVideoId }
    : { action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: track.videoId }
  await call(cfg, 'browse/edit_playlist', { playlistId, actions: [action] })
}

/** Where the heart stands for one video. */
export type LikeStatus = 'like' | 'dislike' | 'none'

/** YouTube's three words for it, in every shape below. `INDIFFERENT` is "not rated". */
const LIKE_STATUS: Record<string, LikeStatus> = { LIKE: 'like', DISLIKE: 'dislike', INDIFFERENT: 'none' }

/**
 * Whether a like entity belongs to the video we asked about.
 *
 * The entity key is base64url over a small protobuf that carries the video id
 * in the clear (`EgtCelluTmRKaFpRdyA-KAE%3D` → `\x12\x0bBzYnNdJhZQw >(\x01`), so
 * the id can be read back out without knowing the schema.
 *
 * Today a `next` for one video carries exactly one video's entities, so this
 * changes nothing — it is here so that the day a response starts carrying the
 * autoplay video's heart as well, the wrong one is not read. Undecodable is
 * "not mine", and the caller falls back to document order.
 */
function entityIsFor(key: unknown, videoId: string): boolean {
  if (typeof key !== 'string') return false
  try {
    return atob(decodeURIComponent(key).replace(/-/g, '+').replace(/_/g, '/')).includes(videoId)
  } catch {
    return false
  }
}

/**
 * Finds the like state in a `next` response.
 *
 * Searched by renderer name rather than by path, per parse.ts: the button sits
 * six levels inside `videoPrimaryInfoRenderer.videoActions` on the desktop
 * client and somewhere else entirely on the mobile one, and both of those move.
 *
 * **Measured 2026-09-04** against live www.youtube.com (client 1) and
 * m.youtube.com (client 2), signed out. `likeStatusEntity` is what is actually
 * there, three times per response and always in agreement: on the button, on
 * the fullscreen quick-actions bar, and as a `frameworkUpdates` mutation.
 *
 * `likeButtonRenderer` is the older shape and was in neither response. It is
 * still read as a fallback because it is unambiguous — it spells the status out
 * in the same three words — and because the walk only happens when the entity
 * search found nothing.
 *
 * The view models' `isToggled` flag is deliberately **not** read. The only ones
 * in either response belong to `slimMetadataToggleButtonRenderer`, the mobile
 * fullscreen bar, where like and dislike are two indistinguishable buttons in a
 * list; a bare boolean there cannot tell a dislike from an untouched video, and
 * guessing would light the wrong heart.
 */
function readLikeStatus(res: Json, videoId: string): LikeStatus {
  const entities = collect(res, 'likeStatusEntity').filter(isObject)
  const mine = entities.filter((entity) => entityIsFor(entity.key, videoId))
  for (const entity of mine.length > 0 ? mine : entities) {
    const status = LIKE_STATUS[String(entity.likeStatus)]
    if (status) return status
  }

  for (const button of collect(res, 'likeButtonRenderer').filter(isObject)) {
    const status = LIKE_STATUS[String(button.likeStatus)]
    if (status) return status
  }

  return 'none'
}

/**
 * Whether this account has liked a video.
 *
 * The session is asked about only **after** the call fails, the same way
 * `feed()` does it and for the same reason: a browser that will not hand
 * `document.cookie` to script still has a perfectly good session, and checking
 * first would draw an empty heart for someone who has liked the song. Signed
 * out the call itself succeeds and answers `INDIFFERENT`, so that path never
 * reaches the catch at all.
 *
 * Anything that is not a missing session is a real breakage and is thrown, so
 * that a shape change shows up rather than turning every heart grey.
 */
export async function likeStatus(cfg: YtCfg, videoId: string): Promise<LikeStatus> {
  try {
    return readLikeStatus(await call(cfg, 'next', { videoId }), videoId)
  } catch (err) {
    if (!hasSession()) return 'none'
    throw err
  }
}

/**
 * The two writes behind the heart.
 *
 * `target` is the shape the page's own button sends — read back out of the
 * `likeEndpoint` in a live `next` response, which carries
 * `{status, target: {videoId}, likeParams}`. The `likeParams` blob is not
 * repeated here: it is a signed echo of the button the user pressed, and the
 * endpoint has never required it from a caller that names the target. Signed
 * out both endpoints answer **401** to this body rather than 400 (measured
 * 2026-09-04, both clients), so it is the session that is missing and not the
 * shape — which is as far as a signed-out browser can verify a write.
 *
 * Failures are thrown, never swallowed. This changes something on the account,
 * and a heart that silently did nothing is worse than an error.
 */
async function rate(cfg: YtCfg, endpoint: 'like/like' | 'like/dislike' | 'like/removelike', videoId: string): Promise<void> {
  try {
    await call(cfg, endpoint, { target: { videoId } })
  } catch (err) {
    // Same order as above: only once the write has actually been refused is it
    // worth asking whether there was ever an account to write to.
    if (!hasSession()) throw new InnertubeError('signed out', 'auth', 401)
    throw err
  }
}

export async function like(cfg: YtCfg, videoId: string): Promise<void> {
  await rate(cfg, 'like/like', videoId)
}

export async function unlike(cfg: YtCfg, videoId: string): Promise<void> {
  await rate(cfg, 'like/removelike', videoId)
}

/**
 * Thumbs down.
 *
 * Not a way of complaining: on a player that spends its time in mixes and
 * radio, this is how a listener says "do not play me this again", and it is
 * what shapes what YouTube offers next. `removelike` clears it, the same call
 * that clears a like — YouTube keeps one rating per video, not two.
 */
export async function dislike(cfg: YtCfg, videoId: string): Promise<void> {
  await rate(cfg, 'like/dislike', videoId)
}

/** The feeds the page itself shows: home, subscriptions, history. Signed-in only for the last two. */
export type FeedId = 'FEwhat_to_watch' | 'FEsubscriptions' | 'FEhistory' | 'FEmy_videos'

export async function feed(cfg: YtCfg, browseId: FeedId): Promise<Page> {
  // As the desktop client where the page is not one. The mobile client answers
  // a playlist browse with twenty items and no continuation; there is no reason
  // to trust it with subscriptions or history either, and the desktop shapes
  // are the ones this parser knows best. Falls back if the borrowed client is
  // refused, because a worse answer beats an error.
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  let res: Json
  try {
    res = await call(cfg, 'browse', { browseId }, as)
  } catch (err) {
    if (as === 'page') throw err
    res = await call(cfg, 'browse', { browseId })
  }
  // Personal feeds come back empty rather than as an error when there is no
  // session, and "you watch nothing" is the wrong thing to tell someone. But
  // the cookie is only asked about **after** the call comes back empty: a
  // browser that will not hand `document.cookie` to script — and some do —
  // still has a perfectly good session, and refusing to even try would tell a
  // signed-in person they are signed out.
  if (browseId !== 'FEwhat_to_watch' && parseTracks(res).length === 0 && !hasSession()) {
    throw new InnertubeError('signed out', 'auth', 401)
  }
  return {
    tracks: parseTracks(res),
    shelves: parseShelves(res),
    continuation: continuationToken(res),
    endpoint: 'browse',
  }
}

/**
 * The screen that is never empty.
 *
 * YouTube's own home needs a watch history to say anything — signed out, and
 * signed in on a fresh account, it answers with "start by searching" and no
 * feed at all (measured 2026-09-03). That is a poor front door for something
 * meant to feel like a television.
 *
 * This is YouTube's Music channel, which anyone can browse and which comes
 * back as nine titled shelves of playlists and albums. It is a browse of an
 * ordinary channel, so nothing about it is private or personal — which is
 * exactly why it always works.
 */
const MUSIC_CHANNEL = 'UC-9-kyTW8ZkZNDHQJ6FgpwQ'

/**
 * Whether YouTube Music has already refused this session.
 *
 * It refuses with a 200 and a "Premium only in your area" panel rather than an
 * error, and it will keep refusing for as long as the page is open, so there is
 * no sense paying a round trip for it every time 탐색 is opened. Reset by a
 * page load, which is also the only thing that could change the answer.
 */
let musicRefused = false

/**
 * YouTube Music's own home, when this account is allowed to have it.
 *
 * **Measured 2026-09-03, from a Korean line, signed out: it is not.** The call
 * is well-formed and answers 200, and the body is a single panel reading
 * "현재 위치한 지역에서는 YouTube Music이 Premium 회원에게만 제공됩니다." Forcing
 * `gl` to another country changes only the language of the refusal, because the
 * region is decided by the address the request comes from. So this path is
 * written to be *free when it fails*: one attempt per page load, and the moment
 * it yields no shelves and no tracks the ordinary screen below is used instead.
 *
 * Which means the parsers this reaches for are unverified — there was no
 * response here to verify them against. That is the reason for the emptiness
 * check rather than a trusting one: an unrecognised shape and a refusal look
 * the same from here, and both should end up on the screen that works.
 */
async function musicHome(cfg: YtCfg): Promise<Page | undefined> {
  if (musicRefused) return undefined
  try {
    const res = await call(cfg, 'browse', { browseId: 'FEmusic_home' }, 'music')
    const shelves = parseShelves(res)
    const tracks = parseTracks(res)
    if (shelves.length > 0 || tracks.length > 0) return { tracks, shelves, endpoint: 'browse' }
  } catch {
    /* falls through to the ordinary screen, same as an empty answer */
  }
  musicRefused = true
  return undefined
}

export async function explore(cfg: YtCfg): Promise<Page> {
  const music = await musicHome(cfg)
  if (music) return music
  const res = await call(cfg, 'browse', { browseId: MUSIC_CHANNEL })
  return { tracks: parseTracks(res), shelves: parseShelves(res), endpoint: 'browse' }
}

// ── The television's menu ─────────────────────────────────────────────────

/**
 * One of the television's genre feeds: 스포츠, 생방송, 게임, 뉴스.
 *
 * Asked as the TV client, which is the only one that answers these ids at
 * all (a WEB context gets 400; measured 2026-09-05, signed out). The answer is
 * shelves of `tileRenderer`, which parse.ts reads. No fallback client: there
 * is none that has this screen.
 */
export async function topic(cfg: YtCfg, browseId: string): Promise<Page> {
  let res: Json
  try {
    res = await call(cfg, 'browse', { browseId }, 'tv')
  } catch (err) {
    // The news feed answered 503 once in four asks and 200 on every retry
    // (measured 2026-09-05). One more ask is cheaper than an empty screen.
    if (!(err instanceof InnertubeError) || err.kind !== 'request') throw err
    res = await call(cfg, 'browse', { browseId }, 'tv')
  }
  return { tracks: parseTracks(res), shelves: parseShelves(res), continuation: sectionContinuation(res), endpoint: 'browse', client: 'tv' }
}

/**
 * The rest of one shelf, as the client that gave it.
 *
 * A television row answers five cards and a token for five more, and the
 * token holds for the row alone; the response is a `horizontalListContinuation`
 * with items and, unless the row is finished, a token of its own.
 */
export async function moreShelf(cfg: YtCfg, token: string, as: Client): Promise<Shelf> {
  const res = await call(cfg, 'browse', { continuation: token }, as)
  const next = continuationToken(res)
  return { title: '', tracks: parseTracks(res), playlists: parsePlaylists(res), ...(next ? { continuation: next } : {}) }
}

/**
 * More rows of a television page: the section list's own continuation. The
 * shelves come back whole, each with its token, so they fill like the first.
 */
export async function moreShelves(cfg: YtCfg, page: Page): Promise<Page> {
  if (!page.continuation) return { tracks: [], shelves: [], endpoint: page.endpoint, client: page.client }
  const res = await call(cfg, page.endpoint, { continuation: page.continuation }, page.client ?? 'page')
  return { tracks: [], shelves: parseShelves(res), continuation: sectionContinuation(res), endpoint: page.endpoint, client: page.client }
}

/** 학습, which the desktop client answers as a flat list of lockups. */
export async function learning(cfg: YtCfg, browseId: string): Promise<Page> {
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  const res = await call(cfg, 'browse', { browseId }, as)
  return { tracks: parseTracks(res), shelves: parseShelves(res), continuation: continuationToken(res), endpoint: 'browse', client: as }
}

/**
 * The kids screen, which YouTube does not have.
 *
 * YouTube Kids is a separate service with its own client, and youtube.com has
 * no browse id for it: FEtopics_kids is 400 and /kids redirects to a family
 * settings page. So the screen is curated. One shelf per channel, the channels
 * being the ones a Korean child already knows, each checked signed out on
 * 2026-09-05 to answer a browse with its videos. The names are the channels'
 * own; the ids are theirs and will outlive a rename.
 */
const KIDS_CHANNELS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'UCqXwKu6dKobXEQFhdKtiJLQ', name: '핑크퐁 (인기 동요・동화)' },
  { id: 'UC-9Tn-iH6W_187YwCOf7CGw', name: '핑크퐁! 아기상어 올리' },
  { id: 'UCPUeGC_AL-OnDQORKhRm6iA', name: '뽀로로(Pororo)' },
  { id: 'UCxUZwdsqshu2iLQwdEE6e7Q', name: '꼬마버스 타요' },
  { id: 'UCscjd-azZ1AqHxxrO6YDIQg', name: '베이비버스 인기 동요・동화' },
  { id: 'UCNvn7bFpHvfvULxpRf2Ea-g', name: '코코멜론 인기 동요・키즈송' },
  { id: 'UCDN8_Gba4SnAYw87x0vUXZA', name: '시크릿 쥬쥬' },
  { id: 'UCWagwPGESinCm58hOwmRvIg', name: '캐리TV 스토리' },
  { id: 'UC0SVqB_1E2Kgh3cx3Y8xtfA', name: '헬로카봇' },
  { id: 'UC3sCmmMaM383cjv1jNdiU2w', name: '콩순이' },
  { id: 'UCKBt6VowYGmBpXFf3rVhaQA', name: '브레드이발소' },
]

/** How many of a channel's videos one shelf shows. A row, not the channel. */
const KIDS_SHELF = 12

export async function kids(cfg: YtCfg): Promise<Page> {
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  // All at once, and a channel that fails drops out rather than taking the
  // screen with it: eleven requests will not all succeed every time.
  const results = await Promise.allSettled(KIDS_CHANNELS.map((ch) => call(cfg, 'browse', { browseId: ch.id }, as)))
  const shelves: Shelf[] = []
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return
    const tracks = parseTracks(r.value).slice(0, KIDS_SHELF)
    if (tracks.length > 0) shelves.push({ title: KIDS_CHANNELS[i]!.name, tracks, playlists: [] })
  })
  return { tracks: shelves.flatMap((s) => s.tracks), shelves, endpoint: 'browse' }
}

/**
 * The channels this account subscribes to. Signed in only: signed out the
 * list comes back 200 and empty, the way the other personal feeds do.
 */
export async function subscribedChannels(cfg: YtCfg): Promise<Channel[]> {
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  const res = await call(cfg, 'browse', { browseId: 'FEchannels' }, as)
  const list = parseChannels(res)
  if (list.length === 0 && !hasSession()) throw new InnertubeError('signed out', 'auth', 401)
  return list
}

/** One channel's videos: its Videos tab, newest first, with a continuation. */
export async function channelVideos(cfg: YtCfg, channelId: string): Promise<Page> {
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  // The Videos tab's params, which the page itself sends. Without them the
  // home tab answers, which is shelves of the channel's own choosing.
  const res = await call(cfg, 'browse', { browseId: channelId, params: 'EgZ2aWRlb3PyBgQKAjoA' }, as)
  return { tracks: parseTracks(res), shelves: [], continuation: continuationToken(res), endpoint: 'browse', client: as }
}

// ── Suggestions ────────────────────────────────────────────────────────────

/**
 * Google's suggestion service, on the host that answers from inside the page.
 *
 * **Measured 2026-09-05 from the MAIN world, signed out, on both
 * www.youtube.com and m.youtube.com.** Three ways in were tried, and only one
 * of them works on both:
 *
 * 1. **`<script>` JSONP**, which is how the page itself asks. Refused:
 *    youtube.com enforces Trusted Types, so `script.src = …` throws
 *    `TypeError: Failed to set the 'src' property on 'HTMLScriptElement': This
 *    document requires 'TrustedScriptURL' assignment`, and
 *    `setAttribute('src', …)` throws the same. That door is shut to anything
 *    running on this page.
 * 2. **The page's own origin**, `https://www.youtube.com/complete/search`.
 *    200 on www, and **404 on m.youtube.com**, so it cannot be the one path.
 * 3. **`fetch` to suggestqueries-clients6.youtube.com.** 200 on both hosts,
 *    CORS permitting, cross-origin and unauthenticated. This.
 *
 * `client=firefox` rather than the page's `client=youtube`, because the
 * YouTube one answers with a `window.google.ac.h([…])` callback wrapper that
 * would have to be unwrapped by hand, and the Firefox one answers the same
 * suggestions as plain JSON: `[query, [suggestion, …], [], {…}]`.
 */
const SUGGEST = 'https://suggestqueries-clients6.youtube.com/complete/search'

/**
 * What YouTube would offer under its own field, for a half-typed query.
 *
 * Nothing found is a normal answer and so is a request that failed: the field
 * works perfectly well with no suggestions under it, and an error message
 * about an autocomplete is noise. Both come back as an empty list.
 */
export async function suggest(cfg: YtCfg, query: string, limit = 8): Promise<string[]> {
  const q = query.trim()
  if (!q) return []
  const hl = encodeURIComponent(cfg.hl ?? 'ko')
  try {
    const res = await fetch(`${SUGGEST}?client=firefox&ds=yt&hl=${hl}&q=${encodeURIComponent(q)}`)
    if (!res.ok) return []
    const body = (await res.json()) as unknown
    if (!Array.isArray(body) || !Array.isArray(body[1])) return []
    const seen = new Set<string>()
    return (body[1] as unknown[])
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .filter((v) => !seen.has(v) && seen.add(v))
      .slice(0, limit)
  } catch {
    return []
  }
}

// ── The other kinds of result ──────────────────────────────────────────────

// The same protobuf-encoded filters as VIDEOS_ONLY above, for the other two
// things a search can find.
const PLAYLISTS_ONLY = 'EgIQAw%3D%3D'
const CHANNELS_ONLY = 'EgIQAg%3D%3D'

/** What a query finds besides videos. */
export interface Kinds {
  playlists: Playlist[]
  channels: ChannelHit[]
}

/**
 * The playlists and the channels for one query.
 *
 * **Two filtered searches rather than one unfiltered one.** The obvious saving
 * is to drop the videos-only filter and read all three kinds out of a single
 * response, and it is not a saving. Measured 2026-09-05 on live search for
 * 아이유, desktop client:
 *
 * | request | size | what is in it |
 * |---|---|---|
 * | unfiltered | 1,215 KB | 18 videos, 1 playlist, **0 channels**, 65 Shorts |
 * | videos only | 542 KB | 18 videos |
 * | playlists only | 360 KB | 19 playlists |
 * | channels only | 275 KB | 20 channels |
 *
 * The unfiltered response costs the same as all three filtered ones together,
 * spends most of itself on Shorts this app does not show, and carried no
 * channel at all for two of the three queries tried. So the three run side by
 * side instead, and the wait is the slowest of them rather than their sum.
 *
 * One kind failing does not take the other with it. A search that found
 * channels and could not reach the playlists should show the channels.
 */
export async function searchKinds(cfg: YtCfg, query: string): Promise<Kinds> {
  // Same client choice, and same fallback, as `search` above.
  const as: Client = cfg.clientName !== '1' ? 'web' : 'page'
  const ask = async (params: string): Promise<Json> => {
    try {
      return await call(cfg, 'search', { query, params }, as)
    } catch (err) {
      if (as === 'page') throw err
      return call(cfg, 'search', { query, params })
    }
  }

  const [lists, chans] = await Promise.allSettled([ask(PLAYLISTS_ONLY), ask(CHANNELS_ONLY)])
  return {
    playlists: lists.status === 'fulfilled' ? parsePlaylists(lists.value) : [],
    channels: chans.status === 'fulfilled' ? parseChannels(chans.value) : [],
  }
}
