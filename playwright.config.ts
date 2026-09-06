import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // The WebKit suite has its own config; see playwright.webkit.config.ts.
  testIgnore: '**/webkit/**',
  // An extension loads only in a persistent context, and a shared profile makes
  // parallel runs fight over it.
  fullyParallel: false,
  workers: 1,
  // These talk to the real YouTube; one retry absorbs a bad minute.
  retries: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
})
