// Real WebKit, as an iPhone. The extension cannot be loaded here, so the
// fixture puts the built main.js into the document itself; see
// e2e/webkit/fixture.ts for why that is a faithful stand-in and what it is
// not. Run with `npm run test:webkit`; it is not part of `npm test` because
// each test costs a full page of youtube.com in WebKit.
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e/webkit',
  workers: 1,
  timeout: 180_000,
  retries: 1,
  reporter: [['list']],
  projects: [{ name: 'iphone', use: { ...devices['iPhone 14'], browserName: 'webkit' } }],
})
