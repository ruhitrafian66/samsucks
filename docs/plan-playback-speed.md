# Plan: playback speed (1× / 1.1× / 1.2×)

Status: planned, not started. Target TV: Samsung QE65Q70A (2021, Tizen 6.0, Chromium 76).

## The constraint

AVPlay, the player the app uses today, can't play at 1.1× or 1.2×:

- `webapis.avplay.setSpeed(long)` takes an integer: ±1, 2, 4, 8 or 16.
- Over HTTP it's trick play, done by repeated seeks. It isn't smooth playback, and audio isn't guaranteed.
- AVPlayExtension has no speed API either.

The browser `<video>` element does support fractional speeds, through `playbackRate`. The app already has a `<video>` backend with the same interface (`videoBackend` in `js/platform/player.js`), but today it's only used in desktop Chrome.

**Approach:** play at 1× on AVPlay as now. When the speed isn't 1×, reopen the stream at the current position in the `<video>` backend with `playbackRate` set. Return to AVPlay when the speed goes back to 1×.

## Phase 0: on-TV spike (the go/no-go)

This needs the TV on. Run it through the remote inspector (`sdb shell 0 debug SamSucks01.samsucks`, then CDP), with no UI work yet.

1. **Direct-play file in `<video>`.** Point a `<video>` at a direct-play URL for a typical library file (HEVC 10-bit 4K MKV with AAC or EAC3 audio). Check:
   - Does it play at all?
   - Is it 4K? Is HDR kept, or does it look washed out?
   - What's the CPU load and the frame pacing?
2. **Speed in `<video>`.** Set `playbackRate` to 1.1, then 1.2. Check:
   - Does the audio keep playing? Jellyfin reports Tizen dropping audio at ≥1.25×.
   - Is the pitch preserved?
   - Is A/V sync still right after 5 minutes?
3. **HLS in `<video>`.** Point a `<video>` at the Plex HLS URL (`start.m3u8`, HEVC copy + AC3). This is the path for DTS files such as *The Odyssey*.
4. **Embedded subtitles in `<video>`.** For a direct-play MKV with embedded SRT, does `video.textTracks` expose the track?
5. **AVPlay sanity check.** Does `avplay.setSpeed(1.1)` throw, or round down to 1? This settles that AVPlay is out.

**Go/no-go:**
- If step 2 has audio at 1.1/1.2 and step 1 plays the library's HEVC: go.
- If audio drops: stop. There's no other client-side route. Plex can't change speed server-side, and this server can't re-encode video anyway.
- If HDR is lost or 4K is downscaled in `<video>`: still go, but show "Speed > 1× plays in SDR" in the UI.

## Phase 1: player plumbing (`js/platform/player.js`)

- Add `setRate(rate)` to both backends.
  - AVPlay: accept only 1 and return false for anything else.
  - `<video>`: set `v.playbackRate = rate` and `v.preservesPitch = true` (on Chromium 76 this is `webkitPreservesPitch`).
- Add `canRate(rate)` so the player screen knows when it must switch backends.
- Allow both backends to exist side by side.
  - `createPlayer(container, listener, { prefer: 'avplay' | 'video' })`.
  - Only one is open at a time: close AVPlay before opening `<video>`, because they share the hardware decoder.

## Phase 2: player screen (`js/screens/player.js`)

- **State:** `let speed = store.get('playbackSpeed', 1)`, a global default that's also adjustable in the player.
- **`open(atMs)`:** if `speed !== 1`, create or open the `<video>` backend, then call `setRate(speed)` after `prepare()`.
- **Changing speed mid-play:**
  - Same backend: just call `setRate`.
  - Backend switch: `const at = position; close; open(at)`. This reuses the existing reopen path that subtitle/audio changes use.
- **Track panel:** add a third column, "Speed", with rows 1×, 1.1× and 1.2×.
  - `renderPanel()` iterates `['Audio', 'Subtitles']`; make that `['Audio', 'Subtitles', 'Speed']`.
  - Extend `panelLists`, `panelCol` bounds and `choose(col, opt)`. Left/right currently snap to column 0 or 1, so make them step through the columns.
- **OSD:** show a small "1.1×" badge next to the clock when the speed isn't 1×.
- **Things that already work, because they use media time rather than wall time:**
  - Progress, seeking, Plex timeline reports, and resume offset all use `player.time()`.
  - Sidecar subtitle cues use `base + player.time()`.
  - `cueTimer` at 120 ms is still fine at 1.2×.
- **Things that need handling on the `<video>` backend:**
  - Audio track switching: `tracks()` returns nothing there. Either fall back to 1× when the user picks a different audio track, or disable the Audio column at speeds above 1×.
  - Embedded subtitles: use `video.textTracks` if Phase 0 step 4 works. Otherwise prefer a sidecar twin (the `sidecarTwin()` helper added for the DTS fix), else show "subtitles unavailable at this speed".
  - 4K: AVPlay's `SET_MODE_4K` has no `<video>` equivalent. Accept whatever step 1 shows.

## Phase 3: settings (`js/screens/settings.js`)

- Add a row: `{ label: 'Default playback speed', value: '1×', run: cycle }`, cycling 1 → 1.1 → 1.2 → 1.
- Save it with `store.set('playbackSpeed', v)`.
- Same pattern as the existing "Performance overlay" toggle.

## Phase 4: verify on the TV

Test each of these at 1×, 1.1× and 1.2×:

- **Files:** a direct-play HEVC file, an H.264 file, and *The Odyssey* (DTS → HLS + AC3, with external subtitles).
- **Checks:** audio present, pitch preserved, A/V sync after 10 minutes, seeking, pause/resume, and resume position reported to Plex.
- **Speed changes:** change speed mid-play in both directions, then exit and relaunch to confirm the default is kept.

## Risks

1. **Audio at non-1× in Tizen 6.0's `<video>`.** This is the go/no-go; see Phase 0.
2. **HDR and 4K in `<video>`** may be worse than AVPlay.
3. **Reopen glitch.** Switching backends costs a short black screen and rebuffer (about 1–3 s). That's acceptable for a deliberate setting.
