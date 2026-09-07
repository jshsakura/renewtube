// The harness refuses to test yesterday's build.
//
// `npx playwright test` does not build. So a run started after an edit tests
// whatever is in `dist/` — which is the last thing that *was* built — and comes
// back green about code nobody is running. That is the worst failure a test
// suite has, because it is indistinguishable from success, and it has already
// cost this project a session's worth of confusion.
//
// Every fixture asks this before it opens a page. It costs one walk of the
// source tree and it answers a question no assertion in the suite can.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The newest modification time at `dir`, or anywhere under it, or 0 if it is not there. */
function newestUnder(dir: string): number {
  let newest = 0
  let entries
  try {
    const here = statSync(dir)
    // A single file is a source too; naming one keeps a guard from firing over
    // a sibling that has nothing to do with the build.
    if (!here.isDirectory()) return here.mtimeMs
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    // Anything generated, and anything nobody's edit lands in.
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestUnder(path))
      continue
    }
    try {
      newest = Math.max(newest, statSync(path).mtimeMs)
    } catch {
      // A file that vanished between the listing and the stat is not news.
    }
  }
  return newest
}

const checked = new Set<string>()

/**
 * Throws unless `artefact` is newer than everything in `sources`.
 *
 * Once per artefact per process: the answer cannot change mid-run, and a
 * fixture that opens forty pages should not walk the tree forty times.
 */
export function assertFresh(artefact: string, sources: string[], how: string): void {
  if (checked.has(artefact)) return
  checked.add(artefact)
  const built = statSync(artefact, { throwIfNoEntry: false })?.mtimeMs
  if (built === undefined) {
    throw new Error(`${artefact} is not there. Build it first: ${how}`)
  }
  const edited = Math.max(...sources.map(newestUnder))
  if (edited > built) {
    const age = Math.round((edited - built) / 1000)
    throw new Error(
      `${artefact} is ${age}s older than the source it was built from, so this run would test the previous build. Build it first: ${how}`,
    )
  }
}
