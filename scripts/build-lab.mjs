// Bundles the playback laboratory: the real engine on a player built to fail.
//
// Separate from `build.mjs` and into a directory of its own, because none of
// this ships. It exists so the failures that only happen on somebody's
// signed-in account can be produced here, deliberately, on demand.

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'

const root = dirname(import.meta.dirname)
const outDir = join(root, 'dist-lab')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

await esbuild.build({
  entryPoints: { lab: join(root, 'e2e/lab/entry.ts') },
  outdir: outDir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  charset: 'utf8',
  sourcemap: 'inline',
  logLevel: 'warning',
  define: { __RENEWTUBE_VERSION__: '"lab"' },
})
