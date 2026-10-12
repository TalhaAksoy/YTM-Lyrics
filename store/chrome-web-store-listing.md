# Chrome Web Store listing — YTM Lyrics+

## Listing fields

- **Name:** YTM Lyrics+
- **Short description:** Synchronized lyrics in YouTube Music, with click-to-seek playback.
- **Category:** Entertainment
- **Language:** English
- **Screenshot:** Add the screenshot you prepare at 1280 × 800 px (or 640 × 400 px).
- **Privacy policy URL:** Not live yet. The policy is ready at `store/privacy-policy.html`; the reserved Sites URL is `https://ytm-lyrics-plus-privacy.selimtalhaaksoy.chatgpt.site`, but the page has not been deployed.

## Detailed description

Follow along with lyrics while you listen on YouTube Music.

YTM Lyrics+ adds a focused lyrics view to the YouTube Music player. Timed lyrics stay in sync with playback, and the current line is highlighted as the song plays. Click a timed line to jump to that point in the track. When synchronized lyrics are unavailable, the extension can show plain lyrics instead.

**Features**

- View lyrics in the YouTube Music player page.
- Follow the current line as synchronized lyrics progress.
- Click a lyric line to seek to its timestamp.
- Show plain lyrics when timed lyrics are unavailable.
- Fall back to lyrics text already available in YouTube Music when LRCLIB has no match.
- See LRCLIB attribution and whether the lyrics are synchronized.

Open a track in YouTube Music and select the Lyrics tab. YTM Lyrics+ works only on `music.youtube.com` and does not require a separate account.

**Privacy:** To find lyrics, the extension sends the current track title and artist to LRCLIB. It also sends the album name and duration when available. Playback position stays in your browser. The extension does not sell this information, use it for ads, or store it on its own server. Read the full privacy policy at the URL provided in the Store listing.

## Store privacy disclosure notes

- Declare that the extension handles current-page website content: current track title and artist, and optionally album name and duration.
- Explain that these details are transmitted to LRCLIB over HTTPS solely to retrieve lyrics.
- Do not describe the data as never shared: LRCLIB receives the lookup request.
- Playback position is used locally for line synchronization and is not transmitted.
- Confirm the developer contact displayed in the Store listing matches the Contact section of the privacy policy.

## Permission justifications for review

### `host_permissions`: `https://lrclib.net/*`

The background service worker makes HTTPS requests to LRCLIB’s `/api/get` endpoint and, if there is no exact match, `/api/search`. It sends the current track title and artist, with album name and duration when available, to retrieve lyrics. The extension does not contact other API hosts.

### Content script match: `https://music.youtube.com/*`

The content script runs only on YouTube Music. It reads the current player’s track metadata, duration, and playback position; detects the Lyrics view; displays and synchronizes lyrics; and lets the user click a timed line to seek. The playback position remains local to the page. The script does not run on other websites.

No additional Chrome API permissions are requested.

## Listing image checklist

- One screenshot prepared by the developer: 1280 × 800 px preferred, or 640 × 400 px.
- Keep the screenshot current with the submitted extension version.
- Store icon files are in `icons/` and are registered in `manifest.json`.
