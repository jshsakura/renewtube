// The page-level surgery, and the promise that it can always be undone.
//
// **The invariant this whole file exists to keep: the extension owns exactly
// two nodes in the page and mutates nothing else.**
//
//   <style id="oc-easy-mode">   one stylesheet, hiding YouTube's own chrome
//   <oc-easy-mode>              one shadow host, holding all of our UI
//                               (plus its twin for menus, above the video)
//   <meta name="viewport">      only on a phone served the desktop page, which
//                               has none — see the note further down
//
// Nothing of YouTube's is moved, removed, reparented or rewritten — not one
// attribute, not one class, not one inline style. Where the player goes is a
// set of custom properties, and even those are written into a `:root` rule
// inside our own stylesheet rather than onto the page's root element, so that
// the sentence above stays literally true and a test can hold us to it. That is why leaving is not a restore: there is no saved state to
// put back, and no way for a half-finished teardown to leave the page broken.
// Removing those two nodes *is* the exit, and it cannot fail partway.
//
// YouTube's player is not moved either. It is placed by CSS alone: `visibility`
// is turned off on the app and back on for the player, and the player is put
// where our stage is with a fixed position. Both are properties on our own
// stylesheet, so both die with it.
//
// Three ways out, in case the first one is the thing that broke:
//
//   1. the button in the sidebar, and the toolbar switch
//   2. Escape twice within a second, from anywhere on the page
//   3. the watchdog, which lets go on its own if the UI never came up
//
// The mode is also off by default on every new page, and only turns itself on
// again because the previous page wrote a flag. Uninstalling, disabling, or
// simply not running is indistinguishable from plain YouTube.

import { youtubeIsDark } from './store.ts'
import { overlayIsOpen } from './ui/overlay.ts'

const STYLE_ID = 'oc-easy-mode'
const VIEWPORT_ID = 'oc-easy-mode-viewport'
const HOST_TAG = 'oc-easy-mode'
const OVERLAY_TAG = 'oc-easy-mode-overlay'

/** Everything the shell hands back to the app, and takes away on exit. */
export interface Shell {
  /** Where the app draws. */
  root: ShadowRoot
  /** Where menus, modals and toasts draw, above the video. */
  overlay: ShadowRoot
  /** Puts YouTube's player over this element, or nowhere if null. */
  place(target: HTMLElement | null): void
  /**
   * Keeps the picture underneath the app while something of ours has to be on
   * top of it — the drawer, which slides out over the whole left edge.
   *
   * The player is drawn above the app on purpose (see the lift below), so
   * anything of ours that overlaps it is unreachable: with the drawer open in
   * 영상 mode, the video covered its first two rows. Menus and dialogs do not
   * need this, because they are drawn in the overlay host, which is above the
   * player already.
   */
  cover(on: boolean): void
  /**
   * Lifts the boot splash. The splash covers the page from mount() until the
   * app's first view has painted — the player is visible and parked at the
   * page's geometry during that window, which reads as a black rectangle
   * unless something clean is over it.
   */
  hideSplash(): void
  /** Removes both nodes. Safe to call twice. */
  teardown(): void
}

// Hides YouTube without hiding the player.
//
// `visibility` rather than `display`, for one reason: it is the only way to
// blank an ancestor and un-blank a descendant, and the player is a descendant
// of everything we want gone. `display: none` on `ytd-app` would take the
// player with it, and a `<video>` inside a `display: none` subtree is a video
// YouTube starts making decisions about.
//
// The page keeps scrolling underneath, so `html` gets `overflow: hidden` — the
// only rule here that touches anything but visibility and position.
// It needs no on/off guard: the stylesheet exists only while the mode does.
const HIDE_CSS = `
html { overflow: hidden !important; }
body > *:not(${HOST_TAG}):not(${OVERLAY_TAG}) { visibility: hidden !important; }
#movie_player {
  visibility: visible !important;
  position: fixed !important;
  left: var(--oc-x, 0px) !important;
  /* --oc-y is the slot's base top (apply adds back the scroll offset); the
     picture then rides the list's scroll through the same --stage-scroll the
     slot uses, so the two move as one with no JS tracking to lag. */
  top: calc(var(--oc-y, 0px) - var(--stage-scroll, 0px)) !important;
  width: var(--oc-w, 320px) !important;
  height: var(--oc-h, 180px) !important;
  z-index: var(--oc-z, 2147482100) !important;
  /* Taps go through it while something of ours is over it. Whatever the
     stacking works out to, the drawer has to be pressable. */
  pointer-events: var(--oc-pe, auto) !important;
  /* No radius on the video. Rounding the picture itself crops the picture —
     said twice, and rightly. Whatever frame it needs is the slot's business,
     and the slot is behind it. */
  overflow: hidden !important;
  transform: translate(var(--oc-dx, 0px), var(--oc-dy, 0px)) !important;
  transition: none !important;
}
/* YouTube's own touch controls, on the mobile page.
 *
 * m.youtube.com does not put its controls inside #movie_player. That player
 * carries ytp-hide-controls and has no chrome at all — no 자막 button, no
 * settings gear, nothing (measured 2026-09-04). The controls a thumb needs are
 * a *sibling* subtree:
 *
 *   #player-container-id > #player-control-container
 *     > ytm-custom-control > ytm-watch-player-controls > #player-control-overlay
 *
 * which the blanking rule above hides along with the rest of the page. So the
 * picture was ours and its controls were somebody else's, sitting behind it —
 * reported in exactly those words. The subtree is also built lazily, on the
 * first tap of the picture, which is why it is absent until then.
 *
 * Three things are needed and no more: let it be seen, put it where the
 * picture actually is, and let it be touched.
 *
 * **Only the container is made visible.** The visibility property is
 * inherited, so the
 * subtree comes back with it — except the parts YouTube hides itself, which is
 * how these controls fade out a few seconds after a tap. Forcing the whole
 * subtree visible would nail them over the video for ever.
 *
 * The overlay inside is positioned against its nearest positioned ancestor,
 * which was #player-container-id: the page's idea of where the player is, not
 * ours. Fixing this container to the stage's own geometry makes it that
 * ancestor instead, and the controls land on the picture. Geometry copied from
 * #movie_player above rather than recomputed — same variables, same transform
 * correction, so the two can never drift apart. */
#player-control-container {
  visibility: visible !important;
  position: fixed !important;
  left: var(--oc-x, 0px) !important;
  /* --oc-y is the slot's base top (apply adds back the scroll offset); the
     picture then rides the list's scroll through the same --stage-scroll the
     slot uses, so the two move as one with no JS tracking to lag. */
  top: calc(var(--oc-y, 0px) - var(--stage-scroll, 0px)) !important;
  width: var(--oc-w, 320px) !important;
  height: var(--oc-h, 180px) !important;
  /* One above the picture, and it travels with it: cover() lowers --oc-z when
     the drawer comes out, and the controls have to go down with the thing they
     belong to rather than float over the menu. */
  z-index: calc(var(--oc-z, 2147482100) + 1) !important;
  transform: translate(var(--oc-dx, 0px), var(--oc-dy, 0px)) !important;
  /* Deaf on purpose, and this is the whole trick.
     The subtree is built on the first tap of the picture — so a container that
     takes touches itself eats the very tap that would create the controls, and
     nothing is ever built. Measured: with pointer-events auto here, the box sat
     on top of everything and #player-control-overlay stayed absent for ever.
     The container passes touches through to the player underneath; the overlay
     inside it, once YouTube has built it, takes its own. */
  pointer-events: none !important;
}
#player-control-overlay { pointer-events: var(--oc-pe, auto) !important; }
/* The settings sheet, which is not in the player at all.
 *
 * Tapping the gear on m.youtube.com does not open anything inside the
 * controls: YouTube builds the quality, speed and caption menu into
 * <bottom-sheet-container>, a direct child of <ytm-app>. The whitelist above
 * lets the player and its controls through and that container is not on it, so
 * the menu was being built into a subtree this stylesheet had hidden. The gear
 * worked; there was simply nothing to see.
 *
 * **Not scoped to :not([hidden]), on purpose.** A closed sheet is display:none
 * from YouTube's own stylesheet, which visibility cannot and does not
 * override, so the closed case needs no help from us: measured, closed it is
 * 0x0 with no children and takes no touches. Scoping to the attribute would
 * add a dependency on YouTube keeping it, and the failure it invites is the
 * silent one, where the selector stops matching and the menu goes back to
 * being invisible with nothing to say why.
 *
 * The z-index has to clear our own overlay, which sits at 2147483100: while
 * the sheet is up it is the thing being used, and it belongs on top. */
bottom-sheet-container,
bottom-sheet-container * {
  visibility: visible !important;
}
bottom-sheet-container {
  z-index: 2147483500 !important;
  pointer-events: auto !important;
}

/* YouTube's guide drawer, the one thing on the desktop page that undoes the
 * blanking rule by itself. Polymer's app-drawer writes visibility: visible
 * onto its content container whenever the drawer is opened, and inherited
 * hidden loses to a declared visible. So with the guide open the whole guide,
 * subscriptions and all, came back under our panes (reported from a desktop,
 * 2026-09-06, as YouTube's sidebar and a Shorts row showing through). Display
 * is not inherited and not undone by a descendant, and nothing of ours needs
 * the guide, so it is simply not drawn while the mode is on. */
tp-yt-app-drawer#guide { display: none !important; }

/* And the rest of the page's furniture, the same way. Hidden by inherited
 * visibility, a subtree can still be brought back by any rule of YouTube's
 * that declares visibility on it, and a Shorts row was seen floating over our
 * lists on a signed-in desktop (2026-09-06) after the drawer had been dealt
 * with. Nothing here can hold the player: the browse pages (home, playlist,
 * channel) never have one, and on a watch page it lives in #primary. Display
 * is not inherited and cannot be undone below, so these cannot paint at all.
 * Removing our stylesheet puts every one of them back. */
ytd-masthead,
#masthead-container,
ytd-mini-guide-renderer,
ytd-browse,
ytd-search,
ytd-shorts,
ytd-miniplayer,
ytd-watch-flexy #secondary,
ytd-watch-flexy #below,
ytd-watch-flexy #panels,
ytd-watch-flexy #chat-container,
ytd-app > ytd-popup-container {
  display: none !important;
}

/* The player's own hidden ancestors, unhidden.
 *
 * Both sites keep a player alive under the home page for previews and hide it
 * with the hidden attribute on an ancestor: the desktop on <ytd-watch-flexy>,
 * the mobile site on #player (measured 2026-09-06). A player under
 * display: none has no box, so a track pressed on 홈 played as sound with
 * nothing to show in 영상 mode. Going to the watch page instead cost a page
 * load, and on an iPhone the arrival cannot start itself, so it cost the
 * press as well. This puts the ancestor back in the flow: the picture gets a
 * box where it stands, the address never changes, and the press that chose
 * the track is the gesture that starts it. Everything else on the page is
 * still hidden by visibility, so nothing but the player comes back with it. */
body [hidden]:has(#movie_player) { display: block !important; }

/* And then everything else, without naming it.
 *
 * The list above is a guess at YouTube's furniture, and a guess is what let a
 * Shorts row float over the lists on a signed-in desktop after two rounds of
 * guessing (2026-09-06). This rule needs no names: every element in the page
 * that does not contain the player, is not the player or part of it, and is
 * not ours, is not displayed. What survives is exactly the player's own
 * ancestor chain (which inherited visibility still keeps invisible), the
 * player, the mobile page's control subtree and its settings sheet with their
 * own ancestors (the controls are a sibling subtree of the player's, so their
 * chain is not the player's chain), and the sibling blocker's button. A page with no player yet, which is every browse
 * page before a track is chosen, keeps nothing at all.
 *
 * :has() is in every browser this runs in (Chrome 105, WebKit 15.4). Whatever
 * YouTube renames or moves, the rule follows the player, because it is
 * written in terms of the player. Removing our stylesheet puts it all back. */
body *:not(:has(#movie_player, #player-control-container, bottom-sheet-container)):not(#movie_player):not(#movie_player *):not(${HOST_TAG}):not(${OVERLAY_TAG}):not(#player-control-container):not(#player-control-container *):not(bottom-sheet-container):not(bottom-sheet-container *):not(#oc-abp-pip) {
  display: none !important;
}

/* The desktop player hides its own right-hand buttons once it is narrow —
 * .ytp-xsmall-width-mode takes out every .ytp-right-controls .ytp-button — and
 * our stage is narrow often. 자막 and 설정 are not optional furniture; they are
 * the two things the picture is for. Scoped to that mode so a button YouTube
 * hides for a reason of its own (no captions on this video) stays hidden. */
#movie_player.ytp-xsmall-width-mode .ytp-subtitles-button,
#movie_player.ytp-xsmall-width-mode .ytp-settings-button {
  display: inline-block !important;
}

/* The player's own chrome is fine, but its size-follows-the-page logic is not. */
#movie_player .html5-video-container,
#movie_player video {
  width: 100% !important; height: 100% !important; left: 0 !important; top: 0 !important;
}
#movie_player video { object-fit: contain !important; }

/* The sibling ad blocker's picture-in-picture button.
 *
 * It is parented to <html> rather than to <body>, and fixed at the highest
 * z-index there is, so nothing here reaches it: not the rule above that blanks
 * the page, not our own app, not the overlay. It therefore floats over Easy
 * Mode's player bar looking like one of our controls.
 *
 * It is a control for a picture, so it is shown exactly when there is one on
 * screen. --oc-pip is written by place(), which is the one place that knows.
 * The default is grid because that is the display the button sets on itself
 * inline, so putting it back puts back exactly what it had. */
#oc-abp-pip {
  display: var(--oc-pip, grid) !important;
  /* Pinned to the picture's bottom-right corner, because we are the ones who
     know where the picture is. Left alone it works out its own place from the
     video's box and lands in the middle of our stage — measured on the phone,
     switching between 음악 and 영상 parks it somewhere different each time.
     Its own right/bottom are cleared so these win.
     The dx/dy are the correction apply() feeds the player; without them this
     would sit wherever the player would have been rather than where it is. */
  left: calc(var(--oc-x, 0px) + var(--oc-dx, 0px) + var(--oc-w, 320px) - 46px) !important;
  top: calc(var(--oc-y, 0px) + var(--oc-dy, 0px) + var(--oc-h, 180px) - 46px) !important;
  right: auto !important;
  bottom: auto !important;
}

/* Our two nodes, ordered against the page rather than against each other. The
 * app sits below the player so the picture is never covered; the overlay sits
 * above it, because a menu that opens behind the video is a menu nobody can
 * read. Both hosts are inline under all: initial, and an inline box takes no
 * z-index — hence the display. */
${HOST_TAG} { display: block !important; position: relative !important; z-index: 2147482000 !important; }
${OVERLAY_TAG} { display: block !important; position: relative !important; z-index: 2147483100 !important; }
`

/**
 * Puts the two nodes in and returns the handle that takes them out.
 *
 * `onExit` is what the panic key and the watchdog call; the caller decides what
 * leaving means (it also has a queue to write down and a URL to settle).
 */
export function mount(onExit: (reason: 'panic' | 'watchdog') => void): Shell {
  const style = document.createElement('style')
  style.id = STYLE_ID
  // The empty `:root` rule comes first and is where the player's position is
  // written. Keeping it in the sheet, rather than on the element, is what lets
  // the page's own root element go untouched.
  style.textContent = `:root {}\n${HIDE_CSS}`
  ;(document.head ?? document.documentElement).appendChild(style)

  const vars =
    (style.sheet?.cssRules[0] as CSSStyleRule | undefined)?.style ??
    // A sheet that did not parse would be a browser we do not know; falling
    // back to the root element keeps the product working and only costs the
    // one guarantee, which the tests will notice.
    document.documentElement.style

  const host = document.createElement(HOST_TAG)
  const root = host.attachShadow({ mode: 'open' })
  const overlayHost = document.createElement(OVERLAY_TAG)
  const overlay = overlayHost.attachShadow({ mode: 'open' })

  // ── Keys typed in here stay in here ──────────────────────────────────────
  //
  // YouTube's own shortcuts listen on the document, and a key pressed inside a
  // shadow root reaches it retargeted to the host element — which is not a
  // text field as far as the page can tell. So every letter typed into our
  // search box was also a shortcut: k and space paused what was playing, l
  // jumped ten seconds, m muted. Stopped at the host in the bubble phase, so
  // everything inside the app still sees the press (the search box's Enter,
  // the remote control's arrows) and our own shortcuts still work — those
  // listen on the document in the *capture* phase, which runs before this.
  for (const el of [host, overlayHost]) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.addEventListener(type, (ev) => ev.stopPropagation())
    }
  }

  // ── The splash ────────────────────────────────────────────────────────────
  //
  // The player is visible from the instant the hide style lands — parked at
  // whatever geometry the page left it — and stays that way through the ytcfg
  // wait and the player wait, reading as a black rectangle in the middle of an
  // otherwise blank page. The only node that outranks the picture is the
  // overlay host, so the splash lives there, covering the half-built app.
  //
  // It is the shape of the app rather than a logo and a turning ring: a
  // sidebar, a screen of rows, a player bar. A skeleton says what is arriving
  // and roughly when; a spinner only says "wait". The same pulse the views
  // use, so the splash lifting into the real skeletons is one continuous
  // motion instead of two different waits.
  //
  // The colours are written out rather than tokened because the app's own
  // stylesheet has not been injected into this root yet — the splash has to
  // stand alone, and does.
  const dark = youtubeIsDark()
  const ink = dark ? '#26221d' : '#e6e2db'
  const splashStyle = document.createElement('style')
  splashStyle.textContent = `
    .splash { position: fixed; inset: 0; z-index: 1; display: grid;
      grid-template-columns: 244px 1fr; grid-template-rows: 1fr 72px;
      gap: 8px; padding: 8px; box-sizing: border-box;
      background: ${dark ? '#141210' : '#faf8f4'};
      transition: opacity .3s ease; }
    .splash.gone { opacity: 0; pointer-events: none; }
    .splash > div { background: ${dark ? '#1b1815' : '#ffffff'}; border-radius: 0;
      padding: 20px; box-sizing: border-box; overflow: hidden; }
    /* The same shape the app settles into: a column that runs the whole
       height, and a bar that starts where it ends. */
    .splash .sideCol { grid-row: 1 / -1; grid-column: 1; display: flex; flex-direction: column; gap: 14px; }
    .splash .body { grid-column: 2; display: flex; flex-direction: column; gap: 16px; }
    .splash .barRow { grid-column: 2; display: flex; align-items: center; gap: 14px; }
    .splash i { display: block; background: ${ink}; border-radius: 0;
      animation: splash-pulse 1.2s ease-in-out infinite; }
    @keyframes splash-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
    @media (prefers-reduced-motion: reduce) {
      .splash i { animation: none; opacity: .6; }
    }
    /* One column on a phone, the way the app itself collapses. */
    @media (max-width: 899px) {
      .splash { grid-template-columns: 1fr; }
      .splash .sideCol { display: none; }
      .splash .body { grid-column: 1; }
      .splash .barRow { grid-column: 1; }
    }
  `
  // Built node by node. **Never innerHTML**: YouTube enforces Trusted Types,
  // the setter throws under it, and the throw happens during mount — which is
  // a blank page rather than a missing splash. This has cost a mount before.
  const bar = (w: string, height = '12px', extra?: Partial<CSSStyleDeclaration>) => {
    const el = document.createElement('i')
    el.style.width = w
    el.style.height = height
    if (extra) Object.assign(el.style, extra)
    return el
  }
  const column = (cls: string, kids: HTMLElement[]) => {
    const el = document.createElement('div')
    el.className = cls
    el.append(...kids)
    return el
  }
  const splash = document.createElement('div')
  splash.className = 'splash'
  splash.append(
    column('sideCol', [
      bar('60%', '16px', { marginBottom: '8px' }),
      ...Array.from({ length: 6 }, () => bar('80%')),
    ]),
    column('body', [
      bar('180px', '22px', { marginBottom: '6px' }),
      ...Array.from({ length: 7 }, () => bar('100%', '44px')),
    ]),
    column('barRow', [bar('44px', '44px'), bar('180px'), bar('90px', '10px', { marginLeft: 'auto' })]),
  )
  overlay.append(splashStyle, splash)

  const hideSplash = (): void => {
    splash.classList.add('gone')
    // A timeout rather than transitionend: a background tab stops painting,
    // the event would never arrive, and the splash would never leave.
    setTimeout(() => splash.remove(), 350)
  }

  // ── One more node, when the document declares no viewport ────────────────
  //
  // Orion on iPhone reports a desktop user agent, so YouTube hands it the
  // desktop page — which carries no viewport meta, because a desktop page has
  // no need of one. The phone then falls back to a ~980px layout viewport and
  // renders the whole thing at about a quarter scale. Our UI is laid out in
  // that fictional 980, so it comes out shrunken however carefully it is
  // styled.
  //
  // **No device check guards this.** The first attempt only added the meta when
  // `screen.width` looked like a phone's, and on the device that failed too:
  // a browser claiming to be a desktop can report a desktop screen to match.
  // The honest rule is simpler and needs to know nothing — a document with no
  // viewport declaration gets one. A desktop browser ignores the tag entirely,
  // so there is nothing to be wrong about.
  //
  // It is ours, it is tagged, and it goes out with everything else on exit, at
  // which point YouTube reflows back to what it had. A page that already
  // declares one is left alone; that page knows its own mind.
  const viewport = document.querySelector('meta[name="viewport"]')
    ? null
    : Object.assign(document.createElement('meta'), {
        id: VIEWPORT_ID,
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      })

  const attach = () => {
    // `document_start` can beat `<body>` into existence by a frame or two.
    if (!document.body) return requestAnimationFrame(attach)
    document.body.appendChild(host)
    document.body.appendChild(overlayHost)
    if (viewport) (document.head ?? document.documentElement).appendChild(viewport)
  }
  attach()

  // ── The panic key ────────────────────────────────────────────────────────
  //
  // Escape twice inside a second. Registered on the document in the capture
  // phase, so it fires before YouTube's own shortcut handling and before any
  // of our UI. One Escape is left alone because it closes menus and blurs
  // fields, and taking it would be its own kind of trap.
  let lastEscape = 0
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    // An Escape aimed at a menu or a dialog is not one of the two. Without
    // this, closing a "delete this?" dialog and then pressing Escape again for
    // any reason took the whole mode down with it.
    if (overlayIsOpen()) {
      lastEscape = 0
      return
    }
    const now = Date.now()
    if (now - lastEscape < 1000) {
      lastEscape = 0
      onExit('panic')
    } else {
      lastEscape = now
    }
  }
  document.addEventListener('keydown', onKey, true)

  // ── Showing the player's chrome on a touch screen ────────────────────────
  //
  // **Orion on iPhone is served the desktop page**, so the player in front of
  // the viewer is the desktop player: a click plays or pauses, and the
  // scrubber and its buttons appear on *mousemove*. A finger produces no
  // mousemove, so tapping the picture only ever played and paused it and the
  // controls could not be reached at all.
  //
  // One synthetic mousemove on the player is what it is waiting for. It shows
  // the chrome and starts YouTube's own hide timer, exactly as a mouse would.
  const wake = (ev: Event) => {
    const player = document.getElementById('movie_player')
    if (!player) return
    const target = ev.composedPath()[0] as Node | undefined
    if (!target || !player.contains(target)) return
    // **The coordinates matter.** A mousemove at 0,0 is a mouse that left the
    // player, and YouTube hides the chrome for exactly that — which is why the
    // first attempt at this changed nothing. Sent at the middle of the picture
    // it reads as a mouse arriving, and the chrome comes up.
    const box = player.getBoundingClientRect()
    const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true }
    const nudge = () => {
      player.dispatchEvent(new MouseEvent('mouseover', at))
      player.dispatchEvent(new MouseEvent('mousemove', at))
    }
    nudge()
    // Again a moment later: the player settles its own state after a tap, and
    // one nudge in the middle of that can be thrown away.
    window.setTimeout(nudge, 140)
  }
  document.addEventListener('touchend', wake, { passive: true, capture: true })

  // ── The watchdog ─────────────────────────────────────────────────────────
  //
  // If the app never reports that it drew something, the page is blank and the
  // person is stuck looking at nothing. Rather than leave them there, let go.
  // `alive()` is called by the app on its first paint and on every render.
  let alive = false
  const watchdog = window.setTimeout(() => {
    if (!alive) onExit('watchdog')
  }, 8000)

  // ── Placing the player ───────────────────────────────────────────────────
  //
  // The rect is written as custom properties on the root element, so moving the
  // player is one style write and no DOM access at all.
  //
  // The correction: `position: fixed` is relative to the viewport *unless* an
  // ancestor has a transform, filter or containment, any of which makes that
  // ancestor the containing block instead. YouTube has been known to have one.
  // Rather than guess, the player is placed, measured, and the difference is
  // fed back as a translate. It settles in one frame and is re-checked whenever
  // the target moves.
  let target: HTMLElement | null = null
  let raf = 0

  // ── Making the player the thing you actually see ─────────────────────────
  //
  // Positioning the player over the stage is not enough on the desktop page.
  // **The app painted over the video whatever z-index either side was given**
  // — measured 2026-09-03: the player at 2147483000 still lost to the app at
  // 1, and the stage came out a black rectangle. That black rectangle is what
  // "영상 모드에서 재생이 안 된다" looks like from the outside; the video was
  // playing the whole time, underneath. On m.youtube.com the same code is
  // fine, which is why it went unnoticed.
  //
  // What does move it is giving every element between <body> and the player a
  // position and a z-index of its own. The chain is blanked by the rule above,
  // so lifting it shows nothing except the player itself.
  //
  // The selectors are :nth-child paths, so the page still gets no attribute,
  // no class and no inline style written onto it, and the rule lives in our
  // stylesheet, so it leaves when the sheet does.
  const LIFT = 2147482050
  const PLAYER_Z = '2147482100'
  let liftText = ''
  let liftIndex = -1

  /**
   * Raises the player's ancestors so the picture can paint above the app, and
   * lowers them again without letting go.
   *
   * `z` is the whole difference between the two. **The rule must not simply be
   * deleted to get the player out of the way**: it also carries
   * `position: relative`, and that is what keeps YouTube's own
   * absolutely-positioned furniture — its guide drawer, its overlays —
   * resolving against `ytd-app` instead of the page. Delete it and they escape
   * to the initial containing block; on a phone the desktop layout is wider
   * than the screen, the document grows with them, and the browser shrinks the
   * whole page to fit. Measured: opening our drawer took the layout viewport
   * from 390 to 425 and everything with it.
   */
  const lift = (z: number | string = LIFT): void => {
    const player = document.getElementById('movie_player')
    const sheet = style.sheet
    if (!player || !sheet) return
    const steps: string[] = []
    for (let el = player.parentElement; el && el !== document.body; el = el.parentElement) {
      const parent = el.parentElement
      if (!parent) break
      const i = Array.prototype.indexOf.call(parent.children, el) + 1
      steps.unshift(`${el.tagName.toLowerCase()}:nth-child(${i})`)
    }
    if (steps.length === 0) return
    const selectors = steps.map((_, i) => `body > ${steps.slice(0, i + 1).join(' > ')}`)
    const text = `${selectors.join(', ')} { position: relative !important; z-index: ${z} !important; }`
    // A page that navigated may have a different chain; anything else is the
    // same string every second, and rewriting that would be churn.
    if (text === liftText) return
    try {
      if (liftIndex >= 0) sheet.deleteRule(liftIndex)
      liftIndex = sheet.insertRule(text, sheet.cssRules.length)
      liftText = text
    } catch {
      // A selector we cannot express is a player we cannot lift; the UI still
      // works, it is the picture that suffers, and that is not worth throwing.
    }
  }

  /**
   * Puts the chain back down.
   *
   * Required whenever the picture has nowhere to be: parking the player relies
   * on the app being above it, and a lifted chain is exactly what stops that.
   * Without this, 소리만 듣기 leaves a small video in the top-left corner.
   */
  const unlift = (): void => {
    if (liftIndex < 0 || !style.sheet) return
    try {
      style.sheet.deleteRule(liftIndex)
    } catch {
      /* the sheet is going away anyway */
    }
    liftIndex = -1
    liftText = ''
  }

  const apply = () => {
    raf = 0
    if (!target) return
    if (!covered) lift()
    const want = target.getBoundingClientRect()
    if (want.width < 2 || want.height < 2) return
    // The slot's top already carries the list's scroll (via --stage-scroll on a
    // desktop stage/watch), and the picture carries it too in its own CSS. So
    // --oc-y is stored as the *base* top with the scroll added back, leaving it
    // constant while scrolling; the movement is pure CSS and cannot lag.
    // The scroll offset lives on the document root (set by the app); read the
    // computed value, since `vars` is our own stylesheet rule, not the root.
    const stageScroll = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--stage-scroll')) || 0
    vars.setProperty('--oc-x', `${Math.round(want.left)}px`)
    vars.setProperty('--oc-y', `${Math.round(want.top + stageScroll)}px`)
    vars.setProperty('--oc-w', `${Math.round(want.width)}px`)
    vars.setProperty('--oc-h', `${Math.round(want.height)}px`)
    const player = document.getElementById('movie_player')
    if (!player) return
    // A desktop stage/watch slot scrolls with the list, and the sub-pixel
    // dx/dy correction below oscillates against a scroll it can only see a
    // frame late — it re-pushed the picture back to the top on every scroll
    // (measured 2026-09-06 in the watch layout). There the slot's own
    // coordinates are exact, so track them straight and hold the transform at
    // zero. The correction stays for the mobile in-sheet picture it was for.
    if (target.classList.contains('stage') || target.classList.contains('watch')) {
      if (vars.getPropertyValue('--oc-dx') !== '0px') vars.setProperty('--oc-dx', '0px')
      if (vars.getPropertyValue('--oc-dy') !== '0px') vars.setProperty('--oc-dy', '0px')
      return
    }
    const got = player.getBoundingClientRect()
    const dx = Number.parseFloat(vars.getPropertyValue('--oc-dx') || '0')
    const dy = Number.parseFloat(vars.getPropertyValue('--oc-dy') || '0')
    const offX = want.left - got.left + dx
    const offY = want.top - got.top + dy
    if (Math.abs(offX - dx) > 0.5) vars.setProperty('--oc-dx', `${offX}px`)
    if (Math.abs(offY - dy) > 0.5) vars.setProperty('--oc-dy', `${offY}px`)
  }

  const schedule = () => {
    if (!raf) raf = requestAnimationFrame(apply)
  }

  const observer = new ResizeObserver(schedule)
  window.addEventListener('resize', schedule, true)
  // The player's own resize logic runs on a timer of its own; re-check with it.
  const settle = window.setInterval(schedule, 1000)

  const place = (next: HTMLElement | null) => {
    alive = true
    observer.disconnect()
    target = next
    // A button for a picture nobody can see is a button for nothing.
    vars.setProperty('--oc-pip', next ? 'grid' : 'none')
    if (!next) {
      // Nowhere to be: park it behind the app, still playing, never seen.
      unlift()
      vars.setProperty('--oc-z', '1')
      vars.setProperty('--oc-pe', 'none')
      vars.setProperty('--oc-x', '0px')
      vars.setProperty('--oc-y', '0px')
      vars.setProperty('--oc-w', '320px')
      vars.setProperty('--oc-h', '180px')
      return
    }
    if (!covered) {
      vars.setProperty('--oc-z', PLAYER_Z)
      // ...and pointer events with it. Only cover() used to set this back, so
      // a drawer opened while the picture was away left the player deaf: it
      // returned to the screen and no tap on it did anything at all.
      vars.setProperty('--oc-pe', 'auto')
    }
    observer.observe(next)
    schedule()
  }

  // While this is true the chain stays down and the app is the top of the page.
  let covered = false
  const cover = (on: boolean): void => {
    if (covered === on) return
    covered = on
    if (on) {
      // Both, and on purpose. Lowering the chain is what lets the app be on
      // top; dropping --oc-z as well is a direct style write that does not
      // depend on the rule bookkeeping having stayed in step, and the drawer
      // has to be reachable even if it has not.
      //
      // Lowered rather than removed — see lift(). Removing it is what made the
      // menu button shrink the page.
      lift(0)
      vars.setProperty('--oc-z', '1')
      vars.setProperty('--oc-pe', 'none')
      // The picture is behind the app now, so its button has nothing to be
      // the button of — and being drawn above everything, it would be the one
      // thing of the player still on screen.
      vars.setProperty('--oc-pip', 'none')
    } else if (target) {
      vars.setProperty('--oc-z', PLAYER_Z)
      vars.setProperty('--oc-pe', 'auto')
      vars.setProperty('--oc-pip', 'grid')
      schedule()
    }
    // ...and nothing at all when there is nowhere for the picture to be.
    //
    // Putting the player's z-index back because a drawer closed is how a
    // parked player returned as a 320x180 window in the top-left corner of a
    // phone and stayed there: the slot said hidden, the picture was on screen,
    // and closing the drawer was the only thing that had happened. Measured.
  }

  let gone = false
  const teardown = () => {
    if (gone) return
    gone = true
    clearTimeout(watchdog)
    clearInterval(settle)
    cancelAnimationFrame(raf)
    observer.disconnect()
    window.removeEventListener('resize', schedule, true)
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('touchend', wake, true)
    // Removing the sheet takes the custom properties with it; there is nothing
    // to unset, which is the point.
    style.remove()
    host.remove()
    overlayHost.remove()
    viewport?.remove()
    // YouTube sizes its <video> from the player's box, and re-measures only
    // on a resize. The box was ours for the whole session — the corner window,
    // the stage — and the sheet that made it so is gone, but the picture still
    // wears the size of the last box it was given. Measured on a phone: the
    // video sat shrunk in the corner of a full-width player after leaving. So
    // the page is told its size changed: now, once the removal has painted,
    // and once more after the viewport meta's departure has reflowed it.
    const nudge = () => window.dispatchEvent(new Event('resize'))
    nudge()
    requestAnimationFrame(nudge)
    setTimeout(nudge, 300)
  }

  return { root, overlay, place, cover, hideSplash, teardown }
}

/** True when a previous run left its nodes behind, which should not happen. */
export function alreadyMounted(): boolean {
  return document.getElementById(STYLE_ID) !== null
}
