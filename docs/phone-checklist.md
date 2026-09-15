# Phone release check

Run this 60-second check on a real iPhone in Safari or Orion before a release.
Start a track from the RenewTube home screen, then keep it playing throughout.

- [ ] **Sound only → picture → PiP (12 seconds).** Press **소리만 듣기**, **화면 보기**, then the small-window button and close PiP again.
  **Fail if:** the list goes blank, the picture does not return above the app, PiP does not open, or OC Ad Bye Pass leaves no PiP entry in RenewTube.
- [ ] **Background and return (10 seconds).** While the track is playing, switch to another app, wait two seconds, then return.
  **Fail if:** audio stops, the lock-screen session disappears, or returning leaves the video paused without a deliberate pause.
- [ ] **Picture + full-height drawer (10 seconds).** In picture mode, open and close the drawer.
  **Fail if:** the drawer stops or turns black at the picture's bottom edge instead of reaching the bottom of the screen.
- [ ] **Open and close the player sheet (8 seconds).** Tap the playing track in the bottom bar, then close the sheet.
  **Fail if:** any part of the sheet is blank, controls cannot be pressed, or the picture is left in the wrong place.
- [ ] **Scroll with the picture showing (10 seconds).** Return to picture mode and scroll the track list up and down.
  **Fail if:** the picture snags, flashes, covers the header, or separates from its black slot.
- [ ] **Dark and light (10 seconds).** Switch once to dark and once to light while the track keeps playing.
  **Fail if:** a pane disappears, stays black, shows the old theme, or playback/picture placement changes.
- [ ] **Handed-over autoplay keeps going (Orion, 20 seconds).** Let one track finish on its own and
  watch the queue move to the next one, twice in a row, without touching the screen. If the next
  track starts silent, tap anywhere once: the sound must come back within a beat.
  **Fail if:** playback stops after one track, the bar and the picture name different videos, or
  the sound never returns after a tap (2026-09-15, "오리온 브라우저에 맡긴 자동 재생등이
  반드시 하나만 나오고 끝나는").

Any failure blocks the release. Record the device, iOS version, browser, theme,
and the exact transition that produced it.
