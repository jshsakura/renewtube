// The one channel between the two worlds.
//
// The page world owns the product but cannot see `chrome.storage`; the
// isolated world can, and does nothing else. They talk over `window.postMessage`
// on the same window, tagged with a namespace so neither mistakes YouTube's
// own messages for ours.

export const NS = 'oc-easy-mode'

/** What survives across page loads, owned by chrome.storage.local. */
export interface Config {
  /** The switch. Off means the extension does nothing at all on the page. */
  musicMode: boolean
}

export const DEFAULT_CONFIG: Config = { musicMode: false }

export type ToMain =
  | { ns: typeof NS; type: 'config'; config: Config }
  /**
   * "Tell me what the screen looks like."
   *
   * Asked by the toolbar popup, through the isolated side. The in-page
   * settings screen has the same report, and that is exactly the one that
   * cannot be reached when the screen is the thing that is broken: the sheet
   * came up half-drawn over a page that would not paint ("화면이 막혀있는데
   * 설정창은 반절만 나오고", 2026-09-07). The popup is browser furniture and
   * owes the page nothing, so it always opens.
   */
  | { ns: typeof NS; type: 'diagnose' }
  /**
   * "Build the screen again."
   *
   * The escape hatch for a screen that has gone wrong in a way nobody has
   * reproduced yet: tear the app down and put it back, keeping the mode on and
   * the queue where it was. Pressed from the popup, because the moment it is
   * wanted is the moment the screen cannot be pressed.
   */
  | { ns: typeof NS; type: 'restart' }

export type ToIsolated =
  | { ns: typeof NS; type: 'get-config' }
  | { ns: typeof NS; type: 'set-config'; patch: Partial<Config> }
  /**
   * "I am running in the page's own world." Sent by main.js the moment it
   * loads, and the only evidence the isolated side accepts that the manifest's
   * `world: "MAIN"` was honoured. Silence means it was not, and the isolated
   * side injects the script itself.
   */
  | { ns: typeof NS; type: 'main-ready' }
  /** The answer to `diagnose`, on its way back to the popup. */
  | { ns: typeof NS; type: 'diagnosis'; text: string }

export function isOurs(data: unknown): data is { ns: typeof NS; type: string } {
  return (
    typeof data === 'object' && data !== null && (data as { ns?: unknown }).ns === NS
  )
}
