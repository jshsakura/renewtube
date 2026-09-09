# Phone release check

Run this 60-second check on a real iPhone in Safari or Orion before a release.
Start a track from the RenewTube home screen, then keep it playing throughout.

- [ ] **Sound only → picture (10 seconds).** Press **소리만 듣기**, then **화면 보기**.
  **Fail if:** the list goes blank, the picture remains over the list, or the picture does not return above the app.
- [ ] **Picture + full-height drawer (10 seconds).** In picture mode, open and close the drawer.
  **Fail if:** the drawer stops or turns black at the picture's bottom edge instead of reaching the bottom of the screen.
- [ ] **Open and close the player sheet (10 seconds).** Tap the playing track in the bottom bar, then close the sheet.
  **Fail if:** any part of the sheet is blank, controls cannot be pressed, or the picture is left in the wrong place.
- [ ] **Scroll with the picture showing (15 seconds).** Return to picture mode and scroll the track list up and down.
  **Fail if:** the picture snags, flashes, covers the header, or separates from its black slot.
- [ ] **Dark and light (15 seconds).** Switch once to dark and once to light while the track keeps playing.
  **Fail if:** a pane disappears, stays black, shows the old theme, or playback/picture placement changes.

Any failure blocks the release. Record the device, iOS version, browser, theme,
and the exact transition that produced it.
