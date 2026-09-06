// The settings sheet: the way out to YouTube's own pages, and the handful of
// choices this player actually keeps.
//
// Two groups and nothing invented. 유튜브 is two links, because taking the
// page over is what took the account and the preferences away with it, and
// asked for twice. RenewTube is only what already has somewhere to be
// written down: the theme, the mode the player opens in, and the keys, which
// are a fixed list and so are printed rather than offered.
//
// Built the way the equalizer is built, in the overlay root, holding a place
// in the dialog count and giving it back on the way out. There is one dialog
// system here and this is not a second one.

import { t } from '../../shared/i18n.ts'
import type { Mode, Theme } from '../store.ts'
import { hiddenChannels, unhideChannel } from '../store.ts'
import { SHORTCUTS } from './keys.ts'
import { MENU, menuOn, type MenuLine } from '../menu.ts'
import { YOUTUBE_PAGES, youtubeUrl, type YouTubePage } from '../ytsettings.ts'
import { h, icon } from './dom.ts'
import { diagnose } from './diagnose.ts'
import { version } from '../../shared/version.ts'
import type { Ctx } from './ctx.ts'
import { holdModal, modalClass, modalHead } from './overlay.ts'

/** The parts of the app the sheet can change but does not own. */
export interface SettingsActions {
  theme(): Theme
  setTheme(theme: Theme): void
  mode(): Mode
  setMode(mode: Mode): void
  /** Turns one line of the menu on or off, and redraws the column. */
  setMenuLine(line: MenuLine, on: boolean): void
}

/** The one sheet that can be open, and the way to close it. */
let closeOpen: (() => void) | null = null

/** Closes the sheet if it is open. Called on the app's way out, so its hold on the dialog count cannot outlive the mode. */
export function closeSettings(): void {
  closeOpen?.()
}

/**
 * Leaves for one of YouTube's own pages.
 *
 * `assign` rather than anything quieter: what is wanted here is YouTube's
 * page, built by YouTube's own load, and the mode declining to cover it. A
 * pushState would leave this document standing with our UI still up over a
 * screen that had never been fetched.
 *
 * Nothing is torn down first and the switch is left alone. The document is
 * about to go; whatever we removed would go with it, and turning the mode off
 * would mean turning it back on by hand on the way home.
 */
function leaveFor(page: YouTubePage): void {
  location.assign(youtubeUrl(page))
}

/** A row of two or three mutually exclusive answers, the chosen one filled. */
function segment<T extends string>(value: T, options: ReadonlyArray<{ id: T; label: string }>, choose: (id: T) => void): HTMLElement {
  return h(
    'div',
    { class: 'seg', role: 'group' },
    options.map((o) =>
      h(
        'button',
        {
          class: o.id === value ? 'segOn' : '',
          'data-nav': '',
          'aria-pressed': String(o.id === value),
          onclick: () => choose(o.id),
        },
        o.label,
      ),
    ),
  )
}

/** One on/off line: the name, and a switch that says which it is. */
function toggleRow(label: string, on: boolean, fixed: boolean, flip: () => void): HTMLElement {
  return h(
    'button',
    {
      class: on ? 'setToggle on' : 'setToggle',
      'data-nav': '',
      role: 'switch',
      'aria-checked': String(on),
      disabled: fixed || undefined,
      onclick: fixed ? undefined : flip,
    },
    h('span', { class: 'lbl' }, label),
    h('span', { class: 'switch', 'aria-hidden': 'true' }, h('span', { class: 'knob' })),
  )
}

export function openSettings(ctx: Ctx, actions: SettingsActions): void {
  if (closeOpen) return
  let closed = false
  const release = holdModal()
  const done = () => {
    if (closed) return
    closed = true
    closeOpen = null
    release()
    document.removeEventListener('keydown', onEscape, true)
    scrim.remove()
  }
  closeOpen = done
  const onEscape = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    // Only the topmost floating thing answers, so a menu opened over this
    // sheet closes itself before the sheet does.
    const floating = ctx.overlay.querySelectorAll('.menu, .scrim')
    if (floating[floating.length - 1] !== scrim) return
    ev.stopPropagation()
    ev.preventDefault()
    done()
  }

  const body = h('div', { class: 'setBody' })

  /** The report stays across redraws once it has been asked for. */
  let report: string | undefined
  function diagRow(): HTMLElement {
    const pre = h('pre', { class: 'diag', hidden: report === undefined || undefined }, report ?? '')
    const run = () => {
      report = diagnose(ctx.engine, version())
      pre.textContent = report
      pre.hidden = false
    }
    const copy = async () => {
      if (report === undefined) run()
      try {
        await navigator.clipboard.writeText(report!)
        ctx.say(t('복사했습니다'))
      } catch {
        // No clipboard here; the text is on screen to select.
        pre.hidden = false
      }
    }
    return h(
      'div',
      { class: 'diagBox' },
      h(
        'div',
        { class: 'diagActs' },
        h('button', { class: 'setLink', 'data-nav': '', onclick: run }, h('span', null, t('화면 진단')), icon('search', 16)),
        h('button', { class: 'setLink', 'data-nav': '', onclick: () => void copy() }, h('span', null, t('복사')), icon('check', 16)),
      ),
      pre,
    )
  }

  /**
   * Redraws the body, and puts the focus back where it was: the whole body is
   * rebuilt on every choice, and a remote that had the theme under its thumb
   * has to find it there again rather than at the top of the sheet.
   */
  function draw(focus?: string): void {
    const theme = actions.theme()
    const mode = actions.mode()
    body.textContent = ''
    body.append(
      h('h4', { class: 'setGroup' }, t('유튜브')),
      // Said before it is pressed, because pressing it takes the screen away.
      h('p', { class: 'setNote' }, t('유튜브 페이지를 여는 동안 RenewTube는 잠시 물러납니다. 유튜브로 돌아오면 다시 켜집니다.')),
      ...YOUTUBE_PAGES.map((page) =>
        h(
          'button',
          { class: 'setLink', 'data-nav': '', onclick: () => leaveFor(page) },
          h('span', null, t(page.label)),
          icon('external', 16),
        ),
      ),
      h('h4', { class: 'setGroup' }, 'RenewTube'),
      h(
        'div',
        { class: 'setRow' },
        h('span', { class: 'lbl' }, t('테마')),
        segment<Theme>(
          theme,
          [
            { id: 'auto', label: t('자동') },
            { id: 'light', label: t('밝게') },
            { id: 'dark', label: t('어둡게') },
          ],
          (next) => {
            actions.setTheme(next)
            draw('.setRow .seg button')
          },
        ),
      ),
      h(
        'div',
        { class: 'setRow' },
        h('span', { class: 'lbl' }, t('기본 모드')),
        segment<Mode>(
          mode,
          [
            { id: 'music', label: t('음악') },
            { id: 'video', label: t('영상') },
          ],
          (next) => {
            actions.setMode(next)
            draw('.setRow .seg button')
          },
        ),
      ),
      // The menu, one switch per line, in the order the column shows them.
      // 음악 is drawn and cannot be turned off: a menu with nothing fixed can be
      // emptied, and an empty column is a screen with no way anywhere.
      h('h4', { class: 'setGroup' }, t('메뉴')),
      h('p', { class: 'setNote' }, t('켜 둔 것만 메뉴에 나옵니다. 음악은 항상 있습니다.')),
      h(
        'div',
        { class: 'setToggles' },
        MENU.map((line) =>
          toggleRow(t(line.label), menuOn(line), line.fixed === true, () => {
            actions.setMenuLine(line, !menuOn(line))
            draw(`.setToggle[data-key="${line.key}"]`)
          }),
        ).map((el, i) => {
          el.dataset.key = MENU[i]!.key
          return el
        }),
      ),
      // Printed, not offered. The keys are fixed, and a list that looked like
      // a form would be promising a rebind that is not there.
      h('h4', { class: 'setGroup' }, t('단축키')),
      h(
        'dl',
        { class: 'keyList' },
        SHORTCUTS.map((s) => [h('dt', null, t(s.label)), h('dd', null, h('kbd', null, s.keys))]),
      ),
      // The screen in words, for a report from a phone. Pressed, it prints
      // what is on top, where the player is and what its element is doing,
      // and the text can be copied. See diagnose.ts.
      // Reverses 채널 추천 안 함. Shown only when something is hidden; one press
      // clears the block and redraws.
      ...(hiddenChannels().length > 0
        ? [
            h('h4', { class: 'setGroup' }, t('숨긴 채널')),
            h(
              'button',
              {
                class: 'setLink',
                'data-nav': '',
                onclick: () => {
                  for (const id of hiddenChannels()) unhideChannel(id)
                  ctx.reload()
                  draw()
                },
              },
              h('span', null, `${t('모두 다시 보이기')} (${hiddenChannels().length})`),
              icon('check', 16),
            ),
          ]
        : []),
      h('h4', { class: 'setGroup' }, t('진단')),
      diagRow(),
    )
    ;(body.querySelector<HTMLElement>(focus ?? '.setLink') ?? body.querySelector<HTMLElement>('[data-nav]'))?.focus()
  }

  const scrim = h(
    'div',
    { class: 'scrim', 'data-remote': '', onclick: (ev) => ev.target === scrim && done() },
    h('div', { class: `${modalClass()} settings`, role: 'dialog' }, modalHead(t('설정'), done), body),
  )
  ctx.overlay.appendChild(scrim)
  document.addEventListener('keydown', onEscape, true)
  draw()
}
