// The version, from the build.
//
// The MAIN-world script has no chrome.runtime to ask, so the build writes the
// package version in (scripts/build.mjs, `define`). A test runner has no
// build and gets the placeholder.

declare const __RENEWTUBE_VERSION__: string

/** `0.15.10`, or `dev` outside a build. */
export function version(): string {
  return typeof __RENEWTUBE_VERSION__ === 'string' ? __RENEWTUBE_VERSION__ : 'dev'
}
