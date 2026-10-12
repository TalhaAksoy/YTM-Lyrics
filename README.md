# YTM Lyrics+

Spotify-style synchronized lyrics for YouTube Music — a Chrome extension that upgrades the built-in Lyrics tab with timed highlighting, auto-scroll, click-to-seek, and a premium look.

![YTM Lyrics+](store/screenshot.png)

## Features

- **Synced lyrics in the Lyrics tab** — the currently sung line is highlighted and auto-centered while the song plays (powered by [LRCLIB](https://lrclib.net)).
- **Click a line to seek** — any timed line jumps playback to its timestamp.
- **"Back to lyric" button** — when you scroll away, a floating button brings you back to the active line.
- **Works even when YouTube Music has no lyrics** — if the Lyrics tab is disabled for a song, YTM Lyrics+ enables it and pulls lyrics from LRCLIB instead.
- **Smart fallbacks** — LRCLIB synced lyrics → LRCLIB plain lyrics → YouTube Music's own lyrics (restyled) → original UI untouched if nothing is found.
- **Ad-safe metadata** — track info is read from the player bar, so ads can't poison the lyrics lookup.
- **Ambient design** — album-art tinted background, distance-based line fading, smooth transitions.

## Install

### From source (developer mode)

1. Clone this repository.
2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Open a song on [music.youtube.com](https://music.youtube.com) and switch to the **Lyrics** tab.

A Chrome Web Store listing is in progress.

## How it works

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest — content script on `music.youtube.com`, host permission for `lrclib.net` |
| `content.js` | Detects the Lyrics tab, injects the custom UI, tracks playback via `requestAnimationFrame` + binary search, handles tab/track changes |
| `background.js` | Service worker — calls `lrclib.net/api/get` then `/api/search`, parses LRC timestamps |
| `styles.css` | Spotify-style visuals |

Lyrics lookup flow:

1. The content script reads the current track's title, artist, and duration from the YouTube Music player bar (DOM-first, so ads can't corrupt it).
2. The background worker queries LRCLIB for an exact match, falling back to search.
3. Synced LRC lyrics are rendered; `video.currentTime` drives the active-line highlight.
4. If LRCLIB has nothing, YouTube Music's native lyrics text is reused with the same styling.

## Privacy

Only the current track's title, artist, album, and duration are sent to LRCLIB to find lyrics — and only while the lyrics view is open. Playback position never leaves the page. See [store/privacy-policy.html](store/privacy-policy.html) for the full policy.

## Notes

- YouTube Music's DOM is internal and undocumented — selectors are defensive: if a panel can't be identified, the extension silently stays out of the way instead of breaking the page.
- Synced highlighting requires LRCLIB to have a timed (LRC) entry for the song; otherwise static lyrics are shown.

## Credits

- Lyrics data: [LRCLIB](https://lrclib.net)
- Not affiliated with YouTube, YouTube Music, or Google.
