// ISOLATED world: the bridge to chrome.storage, and nothing else.
//
// Answers the page world's request for the config, forwards every change, and
// writes back the patches the page world sends (the in-page "back to YouTube"
// button is the only writer there).

import { DEFAULT_CONFIG, NS, isOurs, type Config, type ToIsolated, type ToMain } from '../shared/messages.ts'

// ── Getting into the page's world on browsers that will not do it for us ───
//
// `world: "MAIN"` is honoured by Chrome and ignored by Safari and Orion, which
// is where this extension is actually used. Ignored does not mean skipped: the
// same file is loaded here in the isolated world instead, where it can see
// neither `ytcfg` nor the player's API. It detects that and stays quiet, so
// what arrives here is silence, and silence is the signal to inject.
//
// This route is later than the manifest's, and that is fine for this
// extension: nothing here has to beat YouTube's own scripts to a value. It
// waits for `ytcfg` and for `#movie_player` either way.
//
// **`async` must stay true.** A script-inserted element with `async = false`
// joins the document's execute-in-order list, and every script inserted after
// it — YouTube builds its player that way — waits for ours. A request that
// neither loads nor fails then stalls the player outright. That cost a day on
// 2026-08-12 in the sibling extension; it is not being paid twice.
let mainReported = false

function injectMainWorld(): void {
  if (mainReported) return
  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('main.js')
  script.async = true
  const done = () => script.remove()
  script.addEventListener('load', done)
  script.addEventListener('error', () => {
    console.warn('[RenewTube] 페이지 세계에 스크립트를 넣지 못했습니다.')
    done()
  })
  const parent = document.head ?? document.documentElement
  parent.insertBefore(script, parent.firstChild)
}

// Half a second is far longer than a same-tick postMessage needs, and short
// enough that nobody watches a blank sidebar waiting for it.
setTimeout(injectMainWorld, 500)

async function readConfig(): Promise<Config> {
  const got = await chrome.storage.local.get('config')
  return { ...DEFAULT_CONFIG, ...((got.config as Partial<Config> | undefined) ?? {}) }
}

function send(config: Config): void {
  const msg: ToMain = { ns: NS, type: 'config', config }
  window.postMessage(msg, location.origin)
}

/**
 * Whoever is waiting for the page's account of itself.
 *
 * One at a time is enough: the popup asks once per press, and a second press
 * replaces the first. Cleared when the answer arrives or the wait runs out, so
 * a page world that never answers cannot leave the popup waiting for ever.
 */
let waitingForDiagnosis: ((text: string) => void) | null = null

// The popup cannot talk to the page's world; it talks to this one, which can.
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, respond) => {
  if (msg?.type !== 'diagnose') return undefined
  const timer = setTimeout(() => {
    if (!waitingForDiagnosis) return
    waitingForDiagnosis = null
    respond({ text: '' })
  }, 3000)
  waitingForDiagnosis = (text: string) => {
    clearTimeout(timer)
    respond({ text })
  }
  const out: ToMain = { ns: NS, type: 'diagnose' }
  window.postMessage(out, location.origin)
  // The answer comes back on a later turn.
  return true
})

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !isOurs(ev.data)) return
  const msg = ev.data as ToIsolated
  if (msg.type === 'main-ready') {
    mainReported = true
  } else if (msg.type === 'diagnosis') {
    const waiting = waitingForDiagnosis
    waitingForDiagnosis = null
    waiting?.(msg.text)
  } else if (msg.type === 'get-config') {
    void readConfig().then(send)
  } else if (msg.type === 'set-config') {
    void readConfig().then((cur) => chrome.storage.local.set({ config: { ...cur, ...msg.patch } }))
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return
  send({ ...DEFAULT_CONFIG, ...((changes.config.newValue as Partial<Config> | undefined) ?? {}) })
})

// The page world may have booted first and asked into the void; answer once
// unprompted so nobody has to poll.
void readConfig().then(send)
