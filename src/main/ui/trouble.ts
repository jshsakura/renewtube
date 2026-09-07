// What went wrong, kept where the report can find it.
//
// A screen is drawn in pieces — the header, the sidebar, the pane, the player
// bar — and each of them is a function called from an event. An exception in
// any one of them stops that call and nothing else: the pieces that had already
// been drawn stay, the pieces after it never appear, and the browser writes a
// line to a console nobody on a phone can open. What the reader gets is a
// half-built screen and no reason, which is exactly the day this was written on
// (2026-09-07: three screenshots of a header over black, and the player bar
// missing from all three).
//
// So every drawing step runs inside `guard`, and what it catches lands here for
// 화면 진단 to print. Nothing is swallowed: the whole point is that it is
// written down.

export interface Trouble {
  where: string
  what: string
  when: number
  /** How many times this same step has failed, so a loop is visible as one. */
  count: number
}

const seen = new Map<string, Trouble>()
let latest: Trouble | undefined

/** Runs `fn`, and remembers rather than loses anything it throws. */
export function guard<T>(where: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (err) {
    record(where, err)
    return undefined
  }
}

export function record(where: string, err: unknown): void {
  const what = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const had = seen.get(where + what)
  const trouble: Trouble = { where, what, when: Date.now(), count: (had?.count ?? 0) + 1 }
  seen.set(where + what, trouble)
  latest = trouble
  // Still said out loud, for anyone who can see a console. The report is for
  // the phone; this is for the desk.
  console.warn(`[RenewTube] ${where}: ${what}`)
}

/** Everything that has failed, newest first. */
export function troubles(): Trouble[] {
  return [...seen.values()].sort((a, b) => b.when - a.when)
}

export function lastTrouble(): Trouble | undefined {
  return latest
}
