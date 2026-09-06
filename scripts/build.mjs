// Bundles the three scripts with esbuild and copies `public/` over the result.
//
// `main` runs in the page's own world and is the whole product: the UI, the
// InnerTube calls and the hand on YouTube's player all live there, because
// that is the only world that can see `ytcfg` and `#movie_player`'s API.
// `isolated` is the thin bridge to `chrome.storage`, which the page world
// cannot reach. `popup` is the toolbar switch.
//
// All three are self-contained IIFEs: a content script is not loaded as a
// module, and the popup gains nothing from being one.

import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as esbuild from 'esbuild'

const watch = process.argv.includes('--watch')
const root = dirname(import.meta.dirname)
const outDir = join(root, 'dist')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

function copyStatic() {
  cpSync(join(root, 'public'), outDir, { recursive: true })
  cpSync(join(root, 'popup.html'), join(outDir, 'popup.html'))
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    main: join(root, 'src/main/index.ts'),
    isolated: join(root, 'src/isolated/index.ts'),
    popup: join(root, 'src/popup/index.ts'),
  },
  outdir: outDir,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: !watch,
  // Korean UI strings, kept readable in the shipped bundle.
  charset: 'utf8',
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
  // The version, for the diagnosis screen; see src/shared/version.ts.
  define: { __RENEWTUBE_VERSION__: JSON.stringify(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version) },
  plugins: [{ name: 'oc-static', setup(build) { build.onEnd(copyStatic) } }],
}

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[build] watching… → dist/')
} else {
  await esbuild.build(options)
}
