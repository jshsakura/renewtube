# RenewTube

**YouTube, tidied up.**

RenewTube is a browser extension that replaces the YouTube page with a simple,
TV-like player. YouTube's own player keeps playing and your own account keeps
working; only the screen changes. Turn it off and plain YouTube is back.

It started from one wish: to open YouTube and see a menu, a list and a play
button, not a wall. Music and video in one place, nothing pulling at your
attention, and a way back at any time.

**Website and download:** https://jshsakura.github.io/renewtube/
**Privacy policy:** https://jshsakura.github.io/renewtube/privacy.html

## Install

- **Chrome Web Store:** submission in progress. Until it lands, use the zip below.
- **Chrome / Edge:** download the zip from the website, unzip it, open
  `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and
  pick the unzipped folder.
- **Orion (macOS and iPhone):** Settings → Extensions → **+** → pick the zip.
  The same file works on the phone.

Press the toolbar icon to switch RenewTube on or off. Inside, **Esc twice**
within a second always leaves, even if something has gone wrong, and if the
screen has not appeared within eight seconds the extension steps aside on its own.

## What it does

**Two modes.** Music mode keeps the picture out of the way (in a corner, or
hidden on a phone) and shows lists as tracks. Video mode puts the picture on
stage and shows the same lists as large thumbnails.

**A menu you choose.** The column follows a YouTube TV's menu, with Music first:
Music, Home, Kids, Sports, Live, Gaming, News, Learning, Channels,
Subscriptions, History, Queue, Playlists, Your videos. Every line except Music
has a switch in Settings, and the TV genres start off. Only what you switch on
appears.

**Search that helps.** Suggestions as you type, recent searches remembered,
and results that include playlists and channels alongside videos. Search opens
over whatever screen you are on.

**A queue and playlists.** Add a track, a whole search result or a playlist to
the queue; play next; drag to reorder; save the queue as a playlist. Create,
fill, reorder and delete your YouTube playlists. Start a radio (YouTube's mix)
from any track.

**The rest of a player.** Playback speed, sleep timer, repeat and shuffle,
lyrics, a channel screen for any channel, a history screen that merges what
you played here with YouTube's history, theme (auto, light, dark), and links to
YouTube's own account and settings pages.

**Keyboard and remote.** Arrow keys move focus the way a TV remote does on
every screen. Shortcuts: Space or K play/pause, J and L skip ten seconds,
S shuffle, R repeat, V show the picture, M mute, `/` search, Esc Esc leave.

**Phones too.** The same screens on m.youtube.com and on Orion for iPhone: a
drawer instead of a sidebar, a two-line bar, sheets along the bottom.

## What it does not do

- **No Shorts.** They do not appear on any screen, and there is no feed for
  them to come from.
- **No ad blocking.** RenewTube changes the screen, not the traffic. It runs
  alongside an ad blocker without getting in its way.
- **No data collection.** There is no server, no analytics and no account.
  Settings live in your browser's own storage. See the privacy policy.
- **Not on music.youtube.com.** YouTube Music is already what this is for
  regular YouTube.

## How it works, in one paragraph

Two scripts run on youtube.com. One draws RenewTube's screens inside a shadow
root; the other, in the page's own world, drives YouTube's player and asks the
page's own API (`youtubei/v1`) for lists, using the page's own session. The
TV genres are asked for as YouTube's TV client, because those feeds answer no
one else. YouTube's DOM is never edited: the page is hidden with CSS and the
player is placed over RenewTube's stage, so leaving is a deletion, not a
restore. The details are in [docs/architecture.md](docs/architecture.md).

A pressed track has three possible endings and no fourth: it plays, or the page
moves to the video's own address and it plays there, or it is given up and the
queue carries on and says so. What that guarantee rests on, and the laboratory
of players built to fail that holds it in place, is in
[docs/playback.md](docs/playback.md).

## Development

Before a release, run the [60-second real-phone check](docs/phone-checklist.md).

```bash
npm install
npm run build     # → dist/
npm test          # builds, then runs the e2e suite against live youtube.com
npm run test:lab  # the playback fault matrix; no network, ~2.5 minutes
npm run check     # types only
npm run zip       # renewtube.zip from dist/
npm run site      # assembles the website the way GitHub Pages does
```

Releases are tags: `release.yml` checks that the tag, `package.json` and the
manifest agree, builds, verifies the package and attaches
`renewtube-vX_Y_Z.zip` to a GitHub release. The website is built from `main`.
The store upload is `store.yml`, run by hand with a tag. The listing copy of
record is [docs/store-listing.md](docs/store-listing.md).

| Path | What is there |
|---|---|
| `src/main/` | the player engine, the API and parser, the screens |
| `src/popup/` | the toolbar switch |
| `public/` | manifest, icons, locales |
| `e2e/` | Playwright tests, run against live YouTube with the extension loaded |
| `site/` | the website and its images |
| `docs/` | architecture, safety notes, store listing |

RenewTube is an independent project, not affiliated with YouTube or Google.
YouTube is a trademark of Google LLC.

## License

GPL-3.0-or-later.
