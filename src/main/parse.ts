// Reading InnerTube responses.
//
// **Searched, not addressed.** The path to a row differs between search, a
// playlist, a mix and the library, and changes without notice. A recursive
// search for the renderer by name survives all of that, because the renderer
// names are the part YouTube keeps stable: they are what its own client
// dispatches on. Every collector is narrow about what it accepts in return.

export type Json = Record<string, unknown>

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Every value stored under `key`, anywhere in the tree, in document order. */
export function collect(root: unknown, key: string): unknown[] {
  const out: unknown[] = []
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i])
    } else if (isObject(node)) {
      const entries = Object.entries(node)
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!
        if (entry[0] === key) out.push(entry[1])
        else stack.push(entry[1])
      }
      const hit = node[key]
      if (hit !== undefined) stack.push(hit)
    }
  }
  return out
}

export function findFirst(root: unknown, key: string): unknown {
  return collect(root, key)[0]
}

/** Flattens one of YouTube's text objects: `{runs}`, `{simpleText}` or `{content}`. */
export function text(node: unknown): string {
  if (typeof node === 'string') return node
  if (!isObject(node)) return ''
  if (typeof node.simpleText === 'string') return node.simpleText
  if (typeof node.content === 'string') return node.content
  const runs = node.runs
  if (Array.isArray(runs)) {
    return runs.map((r) => (isObject(r) && typeof r.text === 'string' ? r.text : '')).join('')
  }
  return ''
}

/** One track, as far as a player cares about it. */
export interface Track {
  videoId: string
  title: string
  /** Channel or artist, as the row itself renders it. */
  byline: string
  /** `m:ss` as rendered, or empty when the row did not say. */
  duration: string
  /** Identifies this track's slot in a playlist; needed to remove it. */
  setVideoId?: string
  /**
   * The channel that published it, as a `UC…` id, when the row says.
   *
   * The byline is a name and names are not identity: two channels may share
   * one, and a channel may rename itself between two screens. Anything that
   * has to remember a channel remembers this instead.
   */
  channelId?: string
  /**
   * Which playlist this row was taken from, stamped by the screen that drew it.
   *
   * The queue is a flat list of tracks and knows nothing about where each one
   * came from, so a track that leaves the queue cannot be taken out of the list
   * it belongs to as well — there is nothing to name. This is that name. Only
   * the playlist screen sets it, because only there is the answer certain.
   */
  fromPlaylist?: string
  /** Greyed out: taken down, private or region-locked. Skipped on play. */
  unavailable: boolean
}

export interface Playlist {
  id: string
  title: string
  /** Free text under the title, usually the count. */
  subtitle: string
  /** A ready-to-use image URL, when the row offered one. */
  cover?: string
}

/**
 * One titled row of a feed — what a television's home screen is made of.
 *
 * A shelf holds videos or playlists but rarely both, so both are carried and
 * whichever is empty is simply not drawn.
 */
export interface Shelf {
  title: string
  tracks: Track[]
  playlists: Playlist[]
  /**
   * The token for the rest of this row, when YouTube kept some back.
   *
   * The television's shelves arrive five cards at a time with a token each
   * (measured 2026-09-06 on FEtopics_sports: four rows of five, every one
   * with a continuation that answers five more). A row drawn from the first
   * answer alone was five cards and a hard edge, which read as "why so few".
   * The token is bound to the session that received it: asked from another
   * visitor it answers nothing at all.
   */
  continuation?: string
}

/**
 * A middling thumbnail out of one of YouTube's image lists.
 *
 * Biggest that is still under 700px: the covers are drawn at ~200px and the
 * 1200px variant is a megabyte nobody sees.
 */
function pickThumb(node: unknown): string | undefined {
  let best: { url: string; width: number } | undefined
  for (const list of collect(node, 'thumbnails')) {
    if (!Array.isArray(list)) continue
    for (const t of list) {
      if (!isObject(t) || typeof t.url !== 'string') continue
      const width = typeof t.width === 'number' ? t.width : 0
      if (width > 700) continue
      if (!best || width > best.width) best = { url: t.url, width }
    }
  }
  return best?.url
}

/**
 * The channel a row belongs to.
 *
 * **Asked of the byline first, and only then of the row at large.** Measured
 * 2026-09-04 over a live search and a live channel browse: every one of 24
 * `videoRenderer` rows carries exactly one `UC…` id and it is the owner, but
 * of 86 `lockupViewModel` rows, 70 carry none and one carries three. A blind
 * search for the first id in the row would be right most of the time and
 * quietly wrong on the rest, which for a filter means hiding somebody else's
 * videos.
 *
 * So the byline, where the owner's name is, is asked first; then the avatar,
 * which is where the 2025 row keeps it; and only then the row itself, and
 * there only when the row names exactly one channel. Ambiguity returns
 * nothing, because a filter that cannot say whose video this is should say so
 * rather than guess.
 */
function channelIdOf(item: Json): string | undefined {
  const fromBrowse = (node: unknown): string[] =>
    collect(node, 'browseEndpoint')
      .map((e) => (isObject(e) && typeof e.browseId === 'string' ? e.browseId : ''))
      .filter((id) => id.startsWith('UC'))

  for (const key of ['ownerText', 'shortBylineText', 'longBylineText']) {
    const hit = fromBrowse(item[key])[0]
    if (hit) return hit
  }
  const avatar = findFirst(item, 'decoratedAvatarViewModel')
  const fromAvatar = fromBrowse(avatar)[0]
  if (fromAvatar) return fromAvatar

  const all = [...new Set(fromBrowse(item))]
  return all.length === 1 ? all[0] : undefined
}

/** The medium thumbnail for any video, without asking the API for it. */
export function thumbnail(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
}

/**
 * Whether a row is a Short.
 *
 * Shorts are excluded everywhere, on purpose: this is meant to feel like
 * YouTube on a television, and a vertical clip that autoplays into the next
 * one is the opposite of that.
 *
 * Mostly they never arrive — search is asked for videos only, and the renderer
 * Shorts come in (`shortsLockupViewModel`) is not one this file collects. This
 * is the guarantee behind that accident, for the feeds where the same row can
 * be either. Two tells, because YouTube uses both: a reel endpoint, and a
 * `/shorts/` link.
 */
function isShort(item: unknown): boolean {
  if (collect(item, 'reelWatchEndpoint').length > 0) return true
  for (const meta of collect(item, 'webCommandMetadata')) {
    if (isObject(meta) && typeof meta.url === 'string' && meta.url.startsWith('/shorts/')) return true
  }
  return false
}

function watchVideoId(node: unknown): string | undefined {
  for (const endpoint of collect(node, 'watchEndpoint')) {
    if (isObject(endpoint) && typeof endpoint.videoId === 'string') return endpoint.videoId
  }
  return undefined
}

/** `setVideoId` from the row's own remove-from-playlist action, if it has one. */
function setVideoIdOf(node: unknown): string | undefined {
  for (const endpoint of collect(node, 'playlistEditEndpoint')) {
    if (!isObject(endpoint) || !Array.isArray(endpoint.actions)) continue
    for (const action of endpoint.actions) {
      if (isObject(action) && action.action === 'ACTION_REMOVE_VIDEO' && typeof action.setVideoId === 'string') {
        return action.setVideoId
      }
    }
  }
  return undefined
}

/**
 * A members-only or paid video: playable only by a member or a buyer, so from
 * this browser it will not play at all ("프리미엄만 재생가능한 회원제영상은
 * 치워주고"). YouTube marks it with a badge — the style on the classic
 * renderers, the label text on the newer ones. Treated as unavailable so the
 * feed sieve (keep() in views.ts) drops it and a queue row shows it dead.
 */
function membersOnly(item: Json): boolean {
  for (const badge of collect(item, 'metadataBadgeRenderer')) {
    if (!isObject(badge)) continue
    const style = typeof badge.style === 'string' ? badge.style : ''
    if (style === 'BADGE_STYLE_TYPE_MEMBERS_ONLY' || style === 'BADGE_STYLE_TYPE_YPC') return true
    if (/회원 전용|멤버십|members? only/i.test(text(badge.label))) return true
  }
  for (const badge of collect(item, 'thumbnailBadgeViewModel')) {
    if (isObject(badge) && /회원 전용|멤버십|members? only/i.test(text(badge.text))) return true
  }
  return false
}

/** Search results and the classic list rows: `videoRenderer`, `playlistVideoRenderer`. */
function tracksFromVideoRenderers(root: unknown, key: string): Track[] {
  const out: Track[] = []
  for (const item of collect(root, key)) {
    if (!isObject(item) || typeof item.videoId !== 'string') continue
    if (isShort(item)) continue
    out.push({
      videoId: item.videoId,
      title: text(item.title),
      byline: text(item.ownerText) || text(item.shortBylineText) || text(item.longBylineText),
      duration: text(item.lengthText),
      setVideoId: typeof item.setVideoId === 'string' ? item.setVideoId : setVideoIdOf(item),
      channelId: channelIdOf(item),
      unavailable: item.isPlayable === false || membersOnly(item),
    })
  }
  return out
}

/**
 * The television's row: `tileRenderer`.
 *
 * The TV client is the only one that answers the genre feeds at all — the same
 * `FEtopics_*` browse ids are 400 from a WEB context, measured 2026-09-05 —
 * and it sends a shape none of the others use. Everything is somewhere else:
 * the id is `contentId` rather than `videoId`, the title and the channel are
 * under `tileMetadataRenderer` (the channel being the first of `lines`), and
 * the duration is the overlay badge on the thumbnail.
 *
 * `contentType` is checked because the same renderer carries channels and
 * playlists on those screens, and only the videos belong in a track list.
 */
function tracksFromTiles(root: unknown): Track[] {
  const out: Track[] = []
  for (const item of collect(root, 'tileRenderer')) {
    if (!isObject(item)) continue
    if (item.contentType !== 'TILE_CONTENT_TYPE_VIDEO') continue
    const videoId = typeof item.contentId === 'string' ? item.contentId : watchVideoId(item)
    if (!videoId || isShort(item)) continue
    const meta = findFirst(item.metadata, 'tileMetadataRenderer')
    const lines = isObject(meta) && Array.isArray(meta.lines) ? meta.lines : []
    out.push({
      videoId,
      title: text(isObject(meta) ? meta.title : undefined),
      // The first line is the channel; the second is views and age, which is
      // not a byline and would read as one if both were taken.
      byline: text(findFirst(lines[0], 'text')),
      duration: text(findFirst(item.header, 'thumbnailOverlayTimeStatusRenderer') && findFirst(findFirst(item.header, 'thumbnailOverlayTimeStatusRenderer'), 'text')),
      unavailable: membersOnly(item),
    })
  }
  return out
}

/** The queue panel of a `next` response, which is what a mix is. */
function tracksFromQueue(root: unknown): Track[] {
  const out: Track[] = []
  for (const item of collect(root, 'playlistPanelVideoRenderer')) {
    if (!isObject(item)) continue
    const videoId = typeof item.videoId === 'string' ? item.videoId : watchVideoId(item)
    if (!videoId || isShort(item)) continue
    out.push({
      videoId,
      title: text(item.title),
      byline: text(item.shortBylineText) || text(item.longBylineText),
      duration: text(item.lengthText),
      setVideoId: typeof item.playlistSetVideoId === 'string' ? item.playlistSetVideoId : undefined,
      unavailable: item.unplayableText !== undefined || membersOnly(item),
    })
  }
  return out
}

/**
 * The 2025 row: `lockupViewModel`. One component for videos and playlists,
 * told apart by `contentType`. Title and byline live under `metadata`, the
 * duration is the badge on the thumbnail.
 */
function lockups(root: unknown, contentType: string): Json[] {
  const out: Json[] = []
  for (const item of collect(root, 'lockupViewModel')) {
    if (isObject(item) && item.contentType === contentType) out.push(item)
  }
  return out
}

function lockupTitle(item: Json): string {
  return text(findFirst(item.metadata, 'title'))
}

function lockupRows(item: Json): string[] {
  const rows: string[] = []
  const meta = findFirst(item.metadata, 'contentMetadataViewModel')
  if (!isObject(meta) || !Array.isArray(meta.metadataRows)) return rows
  for (const row of meta.metadataRows) {
    if (!isObject(row) || !Array.isArray(row.metadataParts)) continue
    const parts = row.metadataParts
      .map((p) => (isObject(p) ? text(p.text) : ''))
      .filter(Boolean)
    if (parts.length) rows.push(parts.join(' · '))
  }
  return rows
}

function lockupBadge(item: Json): string {
  const badge = findFirst(item.contentImage, 'thumbnailBadgeViewModel')
  return isObject(badge) ? text(badge.text) : ''
}

function tracksFromLockups(root: unknown): Track[] {
  const out: Track[] = []
  for (const item of lockups(root, 'LOCKUP_CONTENT_TYPE_VIDEO')) {
    const videoId = (typeof item.contentId === 'string' && item.contentId) || watchVideoId(item)
    if (!videoId || isShort(item)) continue
    out.push({
      videoId,
      title: lockupTitle(item),
      byline: lockupRows(item)[0] ?? '',
      duration: lockupBadge(item),
      setVideoId: setVideoIdOf(item),
      channelId: channelIdOf(item),
      unavailable: membersOnly(item),
    })
  }
  return out
}

/**
 * YouTube Music's rows, which share no renderer name with any of the above.
 *
 * Reached only when the music client answers at all — which, from a region
 * where YouTube Music is Premium-only, it does not. See `musicHome` in api.ts:
 * this is written from the renderer names, not from a captured response, and
 * the caller checks that something came out rather than trusting that it did.
 *
 * A `musicTwoRowItemRenderer` is a card and can be either a track or a
 * playlist; the ones without a video behind them are left to `playlists`.
 */
function tracksFromMusic(root: unknown): Track[] {
  const out: Track[] = []
  for (const item of collect(root, 'musicResponsiveListItemRenderer')) {
    if (!isObject(item)) continue
    const data = findFirst(item, 'playlistItemData')
    const videoId =
      (isObject(data) && typeof data.videoId === 'string' ? data.videoId : undefined) ?? watchVideoId(item)
    if (!videoId || isShort(item)) continue
    // The columns are the row as rendered: title first, then artist, album,
    // and whatever else that particular list chose to show.
    const columns = collect(item, 'musicResponsiveListItemFlexColumnRenderer')
      .map((column) => (isObject(column) ? text(column.text) : ''))
      .filter(Boolean)
    out.push({
      videoId,
      title: columns[0] ?? '',
      byline: columns.slice(1).join(' · '),
      duration: '',
      setVideoId: setVideoIdOf(item),
      unavailable: false,
    })
  }
  for (const item of collect(root, 'musicTwoRowItemRenderer')) {
    if (!isObject(item)) continue
    const videoId = watchVideoId(item)
    if (!videoId || isShort(item)) continue
    out.push({
      videoId,
      title: text(item.title),
      byline: text(item.subtitle),
      duration: '',
      unavailable: false,
    })
  }
  return out
}

/** Tracks from any response shape this player reads, in document order. */
export function tracks(root: unknown): Track[] {
  return dedupe([
    ...tracksFromVideoRenderers(root, 'videoRenderer'),
    ...tracksFromVideoRenderers(root, 'playlistVideoRenderer'),
    // What m.youtube.com sends instead. Same fields, different name.
    ...tracksFromVideoRenderers(root, 'compactVideoRenderer'),
    ...tracksFromQueue(root),
    ...tracksFromLockups(root),
    ...tracksFromMusic(root),
    ...tracksFromTiles(root),
  ])
}

/**
 * Playlists from a library, a search, or a shelf.
 *
 * Albums count. YouTube gives them their own content type, but the id is an
 * ordinary playlist id and opening one does exactly what opening a playlist
 * does, so the distinction would only cost the reader a dead end.
 */
export function playlists(root: unknown): Playlist[] {
  const out: Playlist[] = []
  const AS_PLAYLIST = new Set(['LOCKUP_CONTENT_TYPE_PLAYLIST', 'LOCKUP_CONTENT_TYPE_ALBUM'])
  for (const item of collect(root, 'lockupViewModel')) {
    if (!isObject(item) || !AS_PLAYLIST.has(String(item.contentType))) continue
    const id = typeof item.contentId === 'string' ? item.contentId : undefined
    if (!id) continue
    const cover = findFirst(item.contentImage, 'url')
    out.push({
      id,
      title: lockupTitle(item),
      subtitle: [lockupBadge(item), ...lockupRows(item)].filter(Boolean).join(' · '),
      cover: typeof cover === 'string' ? cover : undefined,
    })
  }
  // m.youtube.com's shelves are made of these, and they carry the playlist id
  // only inside their browse target, prefixed with the VL that `browse` wants
  // and a caller here does not.
  for (const item of collect(root, 'compactStationRenderer')) {
    if (!isObject(item)) continue
    const browseId = findFirst(item.navigationEndpoint, 'browseId')
    const id = typeof browseId === 'string' && browseId.startsWith('VL') ? browseId.slice(2) : undefined
    if (!id) continue
    out.push({
      id,
      title: text(item.title),
      subtitle: text(item.videoCountText),
      cover: pickThumb(item.thumbnail),
    })
  }
  for (const key of ['gridPlaylistRenderer', 'playlistRenderer', 'compactPlaylistRenderer']) {
    for (const item of collect(root, key)) {
      if (!isObject(item) || typeof item.playlistId !== 'string') continue
      // The row's own artwork first. `compactPlaylistRenderer` — which is what
      // one shelf of the mobile music channel is made of — carries a real
      // thumbnail and no watch endpoint, so deriving the cover from a video id
      // left that shelf grey while every other shelf had covers.
      const seed = watchVideoId(item)
      out.push({
        id: item.playlistId,
        title: text(item.title),
        subtitle: text(item.videoCountText) || text(item.videoCountShortText),
        cover: pickThumb(item) ?? (seed ? thumbnail(seed) : undefined),
      })
    }
  }
  // YouTube Music's cards. The id arrives either as a playlist to start
  // playing or as a browse target with the VL prefix `browse` wants and a
  // caller here does not.
  for (const item of collect(root, 'musicTwoRowItemRenderer')) {
    if (!isObject(item)) continue
    const watch = findFirst(item.navigationEndpoint, 'watchPlaylistEndpoint')
    let id = isObject(watch) && typeof watch.playlistId === 'string' ? watch.playlistId : undefined
    if (!id) {
      const browseId = findFirst(item.navigationEndpoint, 'browseId')
      if (typeof browseId === 'string' && browseId.startsWith('VL')) id = browseId.slice(2)
    }
    if (!id) continue
    out.push({
      id,
      title: text(item.title),
      subtitle: text(item.subtitle),
      cover: pickThumb(item.thumbnailRenderer),
    })
  }
  const seen = new Set<string>()
  return out.filter((p) => !seen.has(p.id) && seen.add(p.id))
}

/**
 * The titled rows of a feed, in the order they are meant to be read.
 *
 * A response that has none is not an error — most screens are one flat list —
 * so the caller falls back to `tracks` rather than showing nothing.
 */
export function shelves(root: unknown): Shelf[] {
  const out: Shelf[] = []
  // YouTube Music's shelf. Its title hangs off a header rather than sitting on
  // the shelf itself, which is the only thing that stops it joining the loop
  // below.
  for (const shelf of collect(root, 'musicCarouselShelfRenderer')) {
    if (!isObject(shelf)) continue
    const inside = tracks(shelf.contents)
    const lists = playlists(shelf.contents)
    if (inside.length === 0 && lists.length === 0) continue
    out.push({ title: text(findFirst(shelf.header, 'title')), tracks: inside, playlists: lists })
  }
  for (const key of ['richShelfRenderer', 'shelfRenderer']) {
    for (const shelf of collect(root, key)) {
      if (!isObject(shelf)) continue
      // `contents` on the modern renderer, `content` on the older one, which
      // wraps its items in a horizontal list.
      const items = shelf.contents ?? shelf.content
      const inside = tracks(items)
      const lists = playlists(items)
      if (inside.length === 0 && lists.length === 0) continue
      // The television's shelf carries no `title` of its own: the name sits in
      // a `headerRenderer` beside the content (measured on FEtopics_sports,
      // where the four rows are Highlights, Live, Trending and Top Stories).
      // Falling back rather than replacing, so every other shelf is untouched.
      const title = text(shelf.title) || text(findFirst(shelf.headerRenderer, 'title'))
      const continuation = nextToken(items)
      out.push(continuation ? { title, tracks: inside, playlists: lists, continuation } : { title, tracks: inside, playlists: lists })
    }
  }
  return out
}

/** The older form of token, `{nextContinuationData: {continuation}}`, first found under `root`. */
function nextToken(root: unknown): string | undefined {
  for (const data of collect(root, 'nextContinuationData')) {
    if (isObject(data) && typeof data.continuation === 'string' && data.continuation) return data.continuation
  }
  return undefined
}

/**
 * The token for more *rows*, as distinct from more of one row.
 *
 * A television page is a section list of shelves, and both carry tokens: each
 * shelf for the rest of itself, the list for the shelves below. In document
 * order the shelves come first, so `continuationToken` would hand back the
 * first shelf's. This reads the list's own `continuations`, on the page and
 * on a continuation of it.
 */
export function sectionContinuation(root: unknown): string | undefined {
  for (const key of ['sectionListRenderer', 'sectionListContinuation']) {
    for (const list of collect(root, key)) {
      if (!isObject(list)) continue
      const token = nextToken(list.continuations)
      if (token) return token
    }
  }
  return undefined
}

/** The token that asks for the next page, in either of the forms YouTube emits. */
export function continuationToken(root: unknown): string | undefined {
  for (const item of collect(root, 'continuationItemRenderer')) {
    const token = findFirst(item, 'token')
    if (typeof token === 'string' && token) return token
  }
  for (const key of ['nextContinuationData', 'nextRadioContinuationData']) {
    for (const data of collect(root, key)) {
      if (isObject(data) && typeof data.continuation === 'string' && data.continuation) {
        return data.continuation
      }
    }
  }
  return undefined
}

/** Drops repeats while keeping the first occurrence, which is list order. */
export function dedupe(list: readonly Track[]): Track[] {
  const seen = new Set<string>()
  return list.filter((t) => !seen.has(t.videoId) && seen.add(t.videoId))
}

/**
 * One channel, as a list offers it: a search, the subscriptions screen.
 *
 * The id is what anything that remembers a channel remembers: a byline is a
 * display name and names are not identity.
 */
export interface Channel {
  id: string
  title: string
  /** The handle and the subscriber count, as the row rendered them. */
  subtitle: string
  /** The avatar, ready to use. */
  avatar?: string
}

/** The search panel's name for the same thing. */
export type ChannelHit = Channel

/**
 * Channels, from every shape a list of them takes.
 *
 * `channelRenderer` is the desktop client's search row, which is the one this
 * app normally gets; `compactChannelRenderer` is m.youtube.com's own, which
 * names the title `displayName`; `gridChannelRenderer` is the classic
 * subscriptions grid; and the lockup with a channel `contentType` is the 2025
 * row. The subscriptions list could not be measured signed in from here, so
 * all of them are read and whichever the page sends is the one that lands.
 *
 * **The two count fields are swapped, and that is YouTube's doing.** Measured
 * 2026-09-05 against a live channels-only search on both clients:
 * `videoCountText` holds "1.78K subscribers" and `subscriberCountText` holds
 * the handle, "@Author_dlwlrma". Reading them by their names would print the
 * handle where a count belongs, so they are joined in the order the row
 * renders them and neither is labelled.
 */
export function channels(root: unknown): Channel[] {
  const out: Channel[] = []
  const seen = new Set<string>()
  const push = (id: unknown, title: string, subtitle: string, avatar: string | undefined) => {
    if (typeof id !== 'string' || !id.startsWith('UC') || !title || seen.has(id)) return
    seen.add(id)
    // The mobile client hands these out protocol-relative.
    out.push({ id, title, subtitle, avatar: avatar?.startsWith('//') ? `https:${avatar}` : avatar })
  }
  for (const key of ['channelRenderer', 'compactChannelRenderer', 'gridChannelRenderer']) {
    for (const item of collect(root, key)) {
      if (!isObject(item)) continue
      push(
        item.channelId,
        text(item.title) || text(item.displayName),
        [text(item.subscriberCountText), text(item.videoCountText)].filter(Boolean).join(' · '),
        pickThumb(item.thumbnail),
      )
    }
  }
  for (const item of lockups(root, 'LOCKUP_CONTENT_TYPE_CHANNEL')) {
    push(item.contentId, lockupTitle(item), lockupRows(item)[0] ?? '', pickThumb(findFirst(item, 'thumbnail')))
  }
  return out
}
