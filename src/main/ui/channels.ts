// Choosing which channels 구독 is allowed to show.
//
// 구독 is every channel at once, and forty channels is not a feed anyone
// reads: the two they came for are somewhere in it. This is the list they get
// to narrow it with.
//
// **The list is built from the feed, not fetched.** The obvious source is
// FEchannels, the subscription list, and it could not be measured: signed out
// it comes back with nothing in it (measured 2026-09-04, along with
// FEsubscriptions and FEwhat_to_watch, all empty). Building it from the rows
// already on screen needs no request at all, and the channels it offers are
// exactly the ones there is something to hide.
//
// It draws its own dialog rather than calling `pick`, which resolves with one
// choice and closes; this one is a checklist that stays open. The chrome is
// the same: the same classes, a card on a desktop and a sheet along the bottom
// of a phone.

import { t } from '../../shared/i18n.ts'
import type { Track } from '../parse.ts'
import { h, icon, replace } from './dom.ts'
import { holdModal, modalClass, modalHead } from './overlay.ts'

/** One channel, and how much of the feed is its doing. */
export interface Channel {
  id: string
  name: string
  count: number
}

/**
 * The channels in a feed, most prolific first.
 *
 * Rows the parser could not attribute are left out rather than gathered into
 * an "unknown" bucket: a bucket cannot be filtered by, and offering one would
 * be offering a choice that does nothing.
 */
export function channelsOf(tracks: Track[]): Channel[] {
  const seen = new Map<string, Channel>()
  for (const track of tracks) {
    if (!track.channelId) continue
    const found = seen.get(track.channelId)
    if (found) {
      found.count += 1
      continue
    }
    seen.set(track.channelId, { id: track.channelId, name: track.byline || track.channelId, count: 1 })
  }
  return [...seen.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** The feed, narrowed. An empty filter is no filter, never an empty screen. */
export function applyFilter(tracks: Track[], filter: string[]): Track[] {
  if (filter.length === 0) return tracks
  const keep = new Set(filter)
  // A row whose channel could not be read is dropped while a filter is on.
  // The filter says "only these", and a row that cannot say whose it is
  // cannot be one of them.
  return tracks.filter((track) => track.channelId !== undefined && keep.has(track.channelId))
}

/** Channels whose names contain the query, without case or surrounding-space surprises. */
export function searchChannels<T extends { name: string }>(channels: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return channels
  return channels.filter((channel) => channel.name.toLocaleLowerCase().includes(needle))
}

/**
 * Opens the checklist. Resolves with the chosen ids, or null if dismissed.
 *
 * `holdModal` is what tells the rest of the app that something is up: the
 * shortcuts, the remote and the twice-to-leave all ask overlay.ts whether a
 * dialog is open, and a checklist drawn out here would otherwise let a space
 * pause the music behind it.
 */
/** The one checklist that can be open, and the way to close it. */
let closeOpen: (() => void) | null = null

/**
 * Closes it if it is open.
 *
 * Called when the mode is left. The hold on the dialog count and the Escape
 * listener are module state, and a checklist still open when the app came down
 * kept both: on the way back in every shortcut was dead and Escape twice no
 * longer left, with nothing on screen to explain why.
 */
export function closeChannels(): void {
  closeOpen?.()
}

export function chooseChannels(
  root: ShadowRoot,
  channels: Channel[],
  selected: string[],
): Promise<string[] | null> {
  return new Promise((resolve) => {
    const chosen = new Set(selected)
    const release = holdModal()
    let closed = false

    const done = (v: string[] | null) => {
      if (closed) return
      closed = true
      closeOpen = null
      release()
      document.removeEventListener('keydown', onEscape, true)
      scrim.remove()
      resolve(v)
    }

    /**
     * Escape closes this, but only when this is the thing on top.
     *
     * A menu opened over the checklist is its own layer, and the Escape that
     * dismisses it must not take the list down with it. The topmost layer is
     * the last one in the overlay root, which is where they are appended.
     */
    const onEscape = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      const layers = root.querySelectorAll('.menu, .scrim')
      if (layers[layers.length - 1] !== scrim) return
      ev.stopPropagation()
      ev.preventDefault()
      done(null)
    }

    const list = h('div', { class: 'list channelList' })
    const search = h('input', {
      type: 'search',
      'data-nav': '',
      placeholder: t('채널 검색'),
      'aria-label': t('채널 검색'),
      autocomplete: 'off',
    }) as HTMLInputElement
    const draw = (): void => {
      const visible = searchChannels(channels, search.value)
      replace(
        list,
        visible.length === 0
          ? h('div', { class: 'empty', style: 'padding: 16px' }, t('채널을 찾지 못했습니다.'))
          : visible.map((channel) => {
              const on = chosen.has(channel.id)
              return h(
                'button',
                {
                  class: on ? 'channelRow on' : 'channelRow',
                  'data-nav': '',
                  role: 'checkbox',
                  'aria-checked': on ? 'true' : 'false',
                  onclick: () => {
                    if (chosen.has(channel.id)) chosen.delete(channel.id)
                    else chosen.add(channel.id)
                    draw()
                  },
                },
                h('span', { class: 'channelTick' }, icon('check', 14)),
                h('span', { class: 'channelName' }, channel.name),
                h('span', { class: 'sub' }, String(channel.count)),
              )
            }),
      )
    }
    search.addEventListener('input', draw)
    draw()

    const scrim = h(
      'div',
      // data-remote: the arrows walk the list, as they walk the search panel.
      { class: 'scrim', 'data-remote': '', onclick: (ev: Event) => ev.target === scrim && done(null) },
      h(
        'div',
        { class: modalClass(), role: 'dialog' },
        modalHead(t('볼 채널 고르기'), () => done(null)),
        h('label', { class: 'searchbox channelSearch' }, icon('search', 17), search),
        list,
        h(
          'div',
          { class: 'channelActions' },
          h(
            'button',
            {
              class: 'btn ghost',
              'data-nav': '',
              onclick: () => {
                // Nothing chosen is the same as everything chosen, and the
                // shorter sentence for it is "no filter".
                chosen.clear()
                done([])
              },
            },
            t('필터 해제'),
          ),
          h(
            'button',
            {
              class: 'btn',
              'data-nav': '',
              onclick: () => {
                for (const channel of channels) chosen.add(channel.id)
                draw()
              },
            },
            t('전체 선택'),
          ),
          h(
            'button',
            { class: 'btn primary', 'data-nav': '', onclick: () => done([...chosen]) },
            t('적용'),
          ),
        ),
      ),
    )

    root.appendChild(scrim)
    document.addEventListener('keydown', onEscape, true)
    // Dismissed, not chosen: the caller is waiting on a promise and the mode
    // going down is not an answer.
    closeOpen = () => done(null)
  })
}
