# TODO — Chrome Web Store publish checklist

## Blockers

- [ ] **Deploy privacy policy** — `store/privacy-policy.html` must be live at a public URL before submitting (reserved: `https://ytm-lyrics-plus-privacy.selimtalhaaksoy.chatgpt.site`). GitHub Pages / Netlify / any static host works.
- [ ] **Screenshot** — prepare at 1280×800 px (or 640×400). Also save as `store/screenshot.png` so it shows up in the README.

## Before upload

- [ ] **Zip only the extension files** — do NOT include `store/`, `*.md`, or the `.svg`:
  ```bash
  cd youtube-music-lyrics
  zip -r ../ytm-lyrics-plus.zip manifest.json background.js content.js styles.css icons/ytm-lyrics-16.png icons/ytm-lyrics-48.png icons/ytm-lyrics-128.png
  ```
- [ ] **Reload & smoke-test once more** — `chrome://extensions` → reload → YouTube Music → Lyrics tab (synced song + a song with disabled lyrics tab).

## Store form fields

- [ ] Copy listing text from `store/chrome-web-store-listing.md` (name, short description, detailed description, category: Entertainment, language: English).
- [ ] Paste permission justifications from the same file (`host_permissions` → LRCLIB lookups; `music.youtube.com` content script → player metadata + lyrics UI).
- [ ] Privacy disclosure: mark **user data collected = yes** (website content: track title/artist/album/duration → sent to LRCLIB over HTTPS, lyrics lookup only). Not sold, not used for ads, no storage on own server.
- [ ] Enter the **live** privacy policy URL (see first item).
- [ ] Make sure the developer contact email matches the Contact section of the privacy policy.

## After publish

- [ ] Keep the privacy policy URL alive — taking it down can get the listing removed.
- [ ] Watch for YouTube Music DOM changes — selectors live in `content.js` (`findPanel`, `getTrack`, tab header selectors); breakage is graceful but lyrics features would stop working until updated.
