# Chrome Web Store listing — YTM Lyrics+

## Listing fields

- **Name:** YTM Lyrics+
- **Short description:** Synchronized lyrics in YouTube Music, with click-to-seek playback.
- **Category:** Entertainment
- **Language:** English
- **Screenshot:** Add the screenshot you prepare at 1280 × 800 px (or 640 × 400 px).
- **Privacy policy URL:** Not live yet. The policy is ready at `store/privacy-policy.html`; the reserved Sites URL is `https://ytm-lyrics-plus-privacy.selimtalhaaksoy.chatgpt.site`, but the page has not been deployed.

## Detailed description

Follow along with lyrics while you listen on YouTube Music — karaoke-style.

YTM Lyrics+ adds a focused, zero-configuration lyrics view to the YouTube Music player. Lyrics open automatically for songs that have them — no setup required. Want the Apple Music-style karaoke fill that sweeps the active line word by word? Turn it on in the extension popup; off by default.

**Features**

- Word-by-word karaoke highlighting for supported songs (optional — enable in the popup).
- Line-level synced lyrics; optional progressive fill on the active line.
- Click a lyric line to seek to its timestamp.
- Right-click a line to re-sync lyrics that are slightly off — the offset is remembered per song.
- Fullscreen lyrics mode with an auto-hiding cursor.
- Offline-capable: fetched lyrics are cached locally, so replayed songs load instantly.
- Plain lyrics when timed lyrics are unavailable.
- Falls back to lyrics text already available in YouTube Music when no provider has a match.
- Provider attribution shown under the lyrics.

Open a track in YouTube Music — lyrics appear on their own. YTM Lyrics+ works only on `music.youtube.com` and does not require a separate account.

**Privacy:** To find lyrics, the extension sends the current track title and artist to LRCLIB and lrc.cx. It also sends the album name and duration when available. Playback position stays in your browser. Lyrics, sync offsets, and popup preferences are stored locally on your device. The extension does not sell this information, use it for ads, or store it on its own server. Read the full privacy policy at the URL provided in the Store listing.

## Store privacy disclosure notes

- Declare that the extension handles current-page website content: current track title and artist, and optionally album name and duration.
- Explain that these details are transmitted to LRCLIB and lrc.cx over HTTPS solely to retrieve lyrics.
- Do not describe the data as never shared: LRCLIB and lrc.cx receive the lookup request.
- Playback position is used locally for line synchronization and is not transmitted.
- Declare local storage usage: fetched lyrics and per-song sync offsets are cached in `chrome.storage.local` on the user's device; nothing is sent to a developer-operated server.
- Confirm the developer contact displayed in the Store listing matches the Contact section of the privacy policy.

## Permission justifications for review

### `host_permissions`: `https://lrclib.net/*` and `https://api.lrc.cx/*`

The background service worker makes HTTPS requests to LRCLIB’s `/api/get` endpoint and, if there is no exact match, `/api/search`. If LRCLIB has no match, it queries lrc.cx’s `/jsonapi` endpoint, which can return word-timed lyrics. Both requests send the current track title and artist, with album name and duration when available, solely to retrieve lyrics. The extension does not contact other API hosts.

### `permissions`: `storage`

Fetched lyrics are cached in `chrome.storage.local` so replayed songs load instantly and work offline, and per-song sync offsets set by the user are remembered. All data stays on the user’s device; nothing is transmitted to a developer-operated server.

### Content script match: `https://music.youtube.com/*`

The content script runs only on YouTube Music. It reads the current player’s track metadata, duration, and playback position; detects the Lyrics view; displays and synchronizes lyrics; lets the user click a timed line to seek or right-click a line to set a timing offset; and offers an optional fullscreen lyrics view. The playback position remains local to the page. The script does not run on other websites.

## Listing image checklist

- One screenshot prepared by the developer: 1280 × 800 px preferred, or 640 × 400 px.
- Keep the screenshot current with the submitted extension version.
- Store icon files are in `icons/` and are registered in `manifest.json`.
