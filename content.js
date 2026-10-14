(() => {
  'use strict';

  document.documentElement.dataset.ytmlPlus = 'loaded';
  const ROOT_ID = 'ytml-plus-root';
  const HOST_CLASS = 'ytml-plus-host';
  const POLL_MS = 800;
  const IS_YTM = location.hostname === 'music.youtube.com';
  const IS_YT = location.hostname === 'www.youtube.com';

  const STORE_LYRICS = 'ytmlCacheV3'; // {key: {data, ts}} — bumped: pre-v1.2 titles kept noise like "prod. X"
  const STORE_OFFSETS = 'ytmlOffsets'; // {key: seconds}
  const STORE_NOSYNC = 'ytmlNosync'; // {key: true} — per-song "show lyrics statically"
  const STORE_PREFS = 'ytmlPrefs'; // {fill, autoOpen, yt}
  const STORE_CAP = 250;
  const TTL_LYRICS = 30 * 24 * 3600e3;
  const TTL_NONE = 3 * 24 * 3600e3;
  const MAX_FETCH_RETRIES = 4;
  const AUTOOPEN_ONCE = true;

  const LYRICS_LABELS = [
    'lyrics', 'şarkı sözleri', 'sarki sozleri', 'sözler', 'letras', 'letra',
    'paroles', 'testo', 'liedtext', 'текст', '歌詞', '가사', 'lirik',
    'songtekst', 'lời bài hát', 'dalszöveg', 'teksti', 'stihovi',
  ];

  const SEL = {
    page: ['ytmusic-player-page'],
    title: ['ytmusic-player-bar .title', 'ytmusic-player-bar yt-formatted-string.title'],
    byline: ['ytmusic-player-bar .byline', 'ytmusic-player-bar .subtitle'],
    timeInfo: ['ytmusic-player-bar .time-info', 'ytmusic-player-bar span.time-info'],
    tabs: 'tp-yt-paper-tabs',
    tab: 'tp-yt-paper-tab, [role="tab"]',
    shelf: 'ytmusic-description-shelf-renderer',
    panel: 'ytmusic-tab-renderer',
  };

  let panel = null;
  let root = null;
  let trackKey = null;
  let appliedKey = null;
  let dead = false;
  let scheduled = false; // hoisted — sniffed/schedule run during init (replay)
  let lyrics = null;
  let lineEls = [];
  let activeIdx = -1;
  let suppressUntil = 0;
  let jumpBtn = null;
  let fsBtn = null;
  let syncChip = null;
  let toastEl = null;
  let fsWrap = null;
  let fsStage = null;
  let fsBarEl = null;
  let fsArtEl = null;
  let fsTitleEl = null;
  let fsArtistEl = null;
  let fsAlbumEl = null;
  let fsPlayEl = null;
  let fsFillEl = null;
  let fsCurEl = null;
  let fsDurEl = null;
  let fsPaused = null;
  let ytPanelEl = null; // youtube.com: floating card on document.body
  let ytCtrlBtn = null; // youtube.com: .ytp-right-controls toggle button
  let ytCardHidden = false; // session toggle from the in-player button
  const ytDismissed = new Set(); // videoId keys hidden via the card's × button
  const ytForced = new Set(); // videoId keys force-opened on non-music videos
  let ytProbeKey = null; // last track.key we asked the sniffer to probe for segMap
  let wantLineAnim = false; // arm the line-stagger animation only per track
  let animTimer = null;
  let barEl = null; // header row hosting find/pip/fullscreen (+ YT close)
  let ytCloseBtn = null; // youtube.com card's × button
  let searchBtn = null; // manual lyrics search toggle
  let findEl = null; // search overlay
  let findTitle = null;
  let findArtist = null;
  let findList = null;
  let pipBtn = null;
  let nsyncBtn = null; // per-song sync on/off toggle
  let pipWin = null; // Document-PiP window while lyrics float
  let pipOpening = false; // re-entrancy guard for togglePip's await path
  let pipPh = null; // placeholder shown in the panel while PiP is open
  let pipCss = null; // cached styles.css text for the PiP document
  let curTitle = '';
  let curArtist = '';
  let curDur = 0;
  let toastTimer = null;
  let jumpRaf = false;
  let fullscreen = false;
  let cursorTimer = null;
  let currentOffset = 0;
  let trackChangedAt = 0; // last track-key transition, for stale-time detection
  let lastVideoTime = -1; // last observed video.currentTime
  let lastTimeChange = 0; // when currentTime last advanced
  const cache = new Map(); // key -> lyrics obj | 'none' | 'pending'
  const fetchRetries = new Map(); // key -> count
  const retryAfter = new Map(); // key -> timestamp
  const offsets = new Map(); // key -> seconds
  const nosync = new Set(); // track.key set — synced lyrics rendered as static text
  const prefs = { fill: false, autoOpen: true, yt: true };
  let playerSnap = null; // latest MAIN-world player snapshot (videoId/title/artist/duration)
  let currentMeta = null; // sniffed Innertube metadata for the playing videoId
  let lastResult = null; // last applied lyrics result (pre-segmap transform)
  let segMapApplied = false;
  const sniffedMeta = new Map(); // videoId -> meta (title/artist/album/isVideo/segMap/counterpartId/art)
  const sniffedLyrics = new Map(); // videoId -> {text, source}
  const autoOpened = new Set();
  const userNavigated = new Set();
  let storageMiss = new Set(); // keys known absent in storage

  // Debug flag must be reachable from the ISOLATED world — window.* set in the
  // DevTools console lives in the MAIN world and never crosses the boundary.
  // localStorage is shared, so `localStorage.ytmlDebug='1'` is the switch.
  const dbg = (...a) => {
    try {
      if (window.__ytmlDebug || localStorage.getItem('ytmlDebug') === '1') console.log('[ytml+]', ...a);
    } catch { /* noop */ }
  };
  const dbgSeen = new Set();
  const dbgOnce = (tag, ...a) => {
    if (dbgSeen.has(tag)) return;
    dbgSeen.add(tag);
    dbg(...a);
  };

  // ---- MAIN-world bridges (player-bridge.js + sniffer.js) ----
  // CustomEvents on `document` cross the MAIN/ISOLATED boundary. Everything
  // they provide is additive: without them the extension keeps working off
  // DOM/mediaSession fallbacks.

  document.addEventListener('ytml-player-snapshot', e => {
    const d = e && e.detail;
    if (d && d.videoId) {
      // Detect the track change on the first bridge frame, not the next poll.
      if (playerSnap && playerSnap.videoId !== d.videoId) {
        // update() is debounced — clear the previous song's lines right now
        // rather than letting them sit under the new song's clock.
        trackChangedAt = performance.now(); // earliest, most accurate marker
        if (appliedKey && appliedKey !== `v:${d.videoId}`) {
          appliedKey = null;
          lyrics = null;
          lineEls = [];
          renderStatus('Loading lyrics…');
        }
        schedule();
      }
      playerSnap = d;
    }
  });

  document.addEventListener('ytml-sniffed', e => {
    const d = e && e.detail;
    if (!d) return;
    try {
    if (d.type === 'meta' && d.meta && d.meta.id) {
      sniffedMeta.set(d.meta.id, d.meta);
      if (playerSnap && playerSnap.videoId === d.meta.id) {
        currentMeta = d.meta;
        // segMap may arrive after lyrics rendered — re-apply with corrected
        // times, but only if the applied result AND the live track key both
        // belong to this video (trackKey lags the snap across transitions).
        if (trackKey === `v:${d.meta.id}` && appliedKey === trackKey && !segMapApplied && lastResult && lastResult.synced && d.meta.isVideo && d.meta.segMap && d.meta.segMap.length) {
          applyResult(lastResult);
        }
      }
      schedule();
    } else if (d.type === 'lyrics' && d.videoId) {
      sniffedLyrics.set(d.videoId, { text: d.text, source: d.source });
      // Native lyrics can land while providers are still fetching (or after
      // they missed) — show them now; a provider result upgrades on arrival.
      // Key by the video they were sniffed FOR, not trackKey: right after
      // auto-advance trackKey still holds the previous song until update()
      // runs, and storing under it would poison that song's cache (and its
      // persisted storage entry) with the next song's lyrics.
      if (d.text && playerSnap && playerSnap.videoId === d.videoId && trackKey) {
        const lyrKey = `v:${d.videoId}`;
        const cur = cache.get(lyrKey);
        if (cur === 'none' || cur === 'pending' || cur === undefined) {
          const ytm = ytmLyricsResult(d.text, d.source);
          if (ytm) {
            cache.set(lyrKey, ytm);
            persistLyrics(lyrKey, ytm);
            if (lyrKey === trackKey) appliedKey = null;
          }
        }
      }
      schedule();
    } else if (d.type === 'probe') {
      dbg('yt: probe', d);
    }
    } catch (err) {
      dbg('sniffed handler error', err);
    }
  });
  // Sniffer runs at document_start, before us — ask it to replay its captures.
  try {
    document.dispatchEvent(new Event('ytml-sniff-replay'));
  } catch { /* noop */ }

  function bridgeCmd(op, t) {
    try {
      document.dispatchEvent(new CustomEvent('ytml-cmd', { detail: { op, t } }));
      return true;
    } catch {
      return false;
    }
  }

  function seekTo(t) {
    if (playerSnap) bridgeCmd('seek', t);
    else {
      const v = getVideo();
      if (v) v.currentTime = t;
    }
  }

  // segmentMap maps the counterpart (song) timeline onto the playing video's
  // timeline: intro/outro/cut differences between a music video and its audio
  // track. Outside mapped regions we extrapolate the nearest segment's offset.
  function songToVideo(t, segs) {
    let best = null;
    let bestGap = Infinity;
    for (const s of segs) {
      if (t >= s.c && t < s.c + s.d) return s.p + (t - s.c);
      const gap = t < s.c ? s.c - t : t - (s.c + s.d);
      if (gap < bestGap) {
        bestGap = gap;
        best = s;
      }
    }
    return best ? t + (best.p - best.c) : t;
  }

  function applySegMap(res, segs) {
    const mapT = t => (typeof t === 'number' ? songToVideo(t, segs) : t);
    return Object.assign({}, res, {
      lines: res.lines.map(l => ({
        ...l,
        time: mapT(l.time),
        end: l.end == null ? l.end : mapT(l.end),
        words: l.words ? l.words.map(w => ({ ...w, time: mapT(w.time), end: w.end == null ? w.end : mapT(w.end) })) : l.words,
      })),
    });
  }

  function ytmLyricsResult(text, source) {
    if (!text) return null;
    const lines = text.split('\n').map(s => ({ text: s.trim() })).filter(l => l.text);
    if (lines.length < 2) return null;
    return { synced: false, lines, source: 'ytm', attribution: source || 'Source: YouTube Music' };
  }

  function firstSel(list, within = document) {
    for (const s of list) {
      const el = within.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function getVideo() {
    const vids = [...document.querySelectorAll('video')];
    // During a gapless swap more than one media element can exist; the one
    // whose clock tracks the bridge's logical position is the live one. A
    // frozen ended element keeps winning `duration > 0` checks otherwise.
    if (vids.length > 1 && playerSnap && isFinite(playerSnap.currentTime) && isFinite(playerSnap.t)) {
      const expected = playerSnap.currentTime + (playerSnap.playing ? (Date.now() - playerSnap.t) / 1000 : 0);
      vids.sort((a, b) => Math.abs((a.currentTime || 0) - expected) - Math.abs((b.currentTime || 0) - expected));
      return vids[0];
    }
    const preferred =
      document.querySelector('video.html5-main-video') ||
      document.querySelector('ytmusic-player video') ||
      document.querySelector('#movie_player video');
    if (preferred && preferred.duration > 0) return preferred;
    for (const v of vids) if (v.duration > 0) return v;
    return preferred || vids[0] || null;
  }

  function parseTime(s) {
    const p = s.split(':').map(Number);
    return p.some(isNaN) ? 0 : p.reduce((a, b) => a * 60 + b, 0);
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }

  function artworkUrl() {
    // Sniffed counterpart art is the square album cover — for a playing video
    // it's preferable to the video's own 16:9 frame.
    let url = '';
    if (currentMeta) {
      const cp = currentMeta.isVideo && currentMeta.counterpartId ? sniffedMeta.get(currentMeta.counterpartId) : null;
      url = (cp && cp.art) || currentMeta.art || '';
    }
    if (!url) {
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      url = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    }
    if (!url) {
      const thumb = document.querySelector('ytmusic-player-bar img');
      url = thumb ? thumb.src : '';
    }
    if (!url && IS_YT && playerSnap && playerSnap.videoId) {
      url = `https://i.ytimg.com/vi/${playerSnap.videoId}/hqdefault.jpg`;
    }
    return url.replace(/=w\d+-h\d+/, '=w600-h600');
  }

  function clickYtmButton(candidates) {
    for (const s of candidates) {
      const b = document.querySelector(s);
      if (b) {
        b.click();
        return true;
      }
    }
    return false;
  }

  // youtube.com: "Artist - Title (Official Video)" patterns + "- Topic"
  // channels. Music-section rows from the sniffer win when present.
  function parseYtTitle(vt, author) {
    const isTopic = /-\s*Topic$/i.test(author || '');
    const chanArtist = (author || '').replace(/\s+-\s+Topic$/i, '').replace(/VEVO$/i, '').trim();
    const s = (vt || '')
      .replace(/[([][^\])]*(official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|8k|remaster(?:ed)?|explicit|clean|mono|stereo|m\/?v|prod\.?|feat\.?|ft\.?|featuring)[^\])]*[\])]/gi, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    // bare "prod. X" / "feat. X" tails also pollute YouTube titles
    const clean = t => (t || '')
      .replace(/\s+(prod\.?|produced by|prod by)\b.*$/i, '')
      .replace(/\s+(feat\.?|ft\.?|featuring)\b.*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    const parts = s.split(/\s+[-–—]\s+/).filter(Boolean);
    // "- Topic" channels are authoritative for the artist; the title may put
    // the artist on either side of the dash, so drop that part wherever it is.
    if (isTopic && chanArtist) {
      const rest = parts.filter(p => p.toLowerCase() !== chanArtist.toLowerCase());
      return { title: clean(rest.join(' - ')) || s || (vt || ''), artist: chanArtist };
    }
    if (parts.length >= 2 && parts[0] && parts.slice(1).join('').trim()) {
      return { title: clean(parts.slice(1).join(' - ')) || parts.slice(1).join(' - ').trim(), artist: parts[0].trim() };
    }
    return { title: clean(s) || (vt || ''), artist: chanArtist };
  }

  function getTrack() {
    if (IS_YT) {
      const snap = playerSnap;
      if (!snap || !snap.videoId) return null;
      const meta = sniffedMeta.get(snap.videoId);
      const music = meta && meta.music;
      const parsed = parseYtTitle(snap.title, snap.artist);
      const title = (music && music.song) || parsed.title;
      const artist = (music && music.artist) || parsed.artist;
      if (!title) return null;
      const isMusic =
        !!(music && (music.song || music.artist)) ||
        snap.category === 'Music' ||
        (meta && meta.ytCategory === 'Music') ||
        String(snap.mvType || (meta && meta.mvType) || '').includes('MUSIC') ||
        /-\s*Topic$/i.test(snap.artist || '');
      const dur = Math.round(snap.duration || (meta && meta.durationMs / 1000) || 0);
      if (!dur) return null;
      return {
        title,
        artist,
        album: (music && music.album) || '',
        duration: dur,
        key: `v:${snap.videoId}`,
        videoId: snap.videoId,
        meta,
        isMusic,
      };
    }

    const titleEl = firstSel(SEL.title);
    const domTitle = titleEl ? titleEl.textContent.trim() : '';
    const byline = firstSel(SEL.byline);
    const domArtist = byline ? byline.textContent.split('•')[0].trim() : '';
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const snap = playerSnap;
    const meta = snap && snap.videoId ? sniffedMeta.get(snap.videoId) : null;

    // On auto-advance the DOM player-bar title lags behind snap.videoId,
    // while snap is atomic — its title arrives with the videoId. Prefer
    // videoId-exact sources so a mid-transition update never fetches the
    // previous song's lyrics under the new key.
    const title = (meta && meta.title) || (snap && snap.title) || domTitle || (md && md.title) || '';
    if (!title) return null;

    const artist = (meta && meta.artist) || (snap && snap.artist) || domArtist || (md && md.artist) || '';
    const album = (meta && meta.album) || (md && md.title === title ? md.album || '' : '');
    const videoId = snap && snap.videoId ? snap.videoId : null;

    // Duration: meta/snap travel atomically with the videoId, while the DOM
    // time display lags on auto-advance — a stale duration feeds the provider
    // query and can persist a bad match under the new key.
    let dur = (meta && meta.durationMs && Math.round(meta.durationMs / 1000)) || 0;
    if (!dur && snap && snap.duration) dur = Math.round(snap.duration);
    if (!dur) {
      const timeInfo = firstSel(SEL.timeInfo);
      const spans = timeInfo
        ? [...timeInfo.textContent.matchAll(/(?:\d+:)?\d{1,2}:\d{2}/g)].map(x => parseTime(x[0]))
        : [];
      dur = spans.length ? spans[spans.length - 1] : 0;
    }
    if (!dur) {
      const v = getVideo();
      dur = v && isFinite(v.duration) ? Math.round(v.duration) : 0;
    }
    if (!dur) return null;

    // videoId keys are stabler than title/artist/duration strings — and correct:
    // a song's offset/cache lives with the exact version that played.
    const key = videoId ? `v:${videoId}` : `${title}::${artist}::${dur}`;
    return { title, artist, album, duration: dur, key, videoId, meta };
  }

  // Full per-song state wipe on track change — anything that can hold a
  // stale scroll/highlight/overlay from the previous song resets here so the
  // new track always starts from a clean slate.
  function resetTrackState() {
    suppressUntil = 0;
    jumpRaf = false;
    fsPaused = null;
    activeIdx = -1;
    clearTimeout(animTimer);
    clearTimeout(toastTimer);
    if (root) {
      root.classList.remove('ytml-anim');
      root.scrollTop = 0;
    }
    if (toastEl) toastEl.classList.remove('ytml-visible');
    if (findEl) findEl.classList.remove('ytml-visible');
    if (jumpBtn) jumpBtn.classList.remove('ytml-visible');
  }

  function getPage() {
    return firstSel(SEL.page);
  }

  function isHeaderSelected(h) {
    return h.getAttribute('aria-selected') === 'true' ||
      h.classList.contains('iron-selected') ||
      h.classList.contains('selected') ||
      h.hasAttribute('selected') ||
      h.selected === true;
  }

  function isLyricsLabel(el) {
    const t = (el.textContent || '').toLocaleLowerCase('tr');
    return LYRICS_LABELS.some(l => t.includes(l));
  }

  function findLyricsHeader() {
    const page = getPage();
    if (!page) return null;
    return [...page.querySelectorAll(SEL.tab)].find(isLyricsLabel) || null;
  }

  function forceEnableLyricsTab() {
    const h = findLyricsHeader();
    if (!h) return false;
    const disabled =
      h.disabled === true ||
      h.hasAttribute('disabled') ||
      h.getAttribute('aria-disabled') === 'true' ||
      h.style.pointerEvents === 'none';
    if (!disabled) return false;
    try { h.disabled = false; } catch { /* polymer prop */ }
    h.removeAttribute('disabled');
    h.removeAttribute('aria-disabled');
    if (h.style.pointerEvents === 'none') h.style.pointerEvents = '';
    h.dataset.ytmlForced = '1';
    return true;
  }

  function forcedLyricsSelected() {
    const h = findLyricsHeader();
    return !!(h && h.dataset.ytmlForced === '1' && isHeaderSelected(h));
  }

  function manualSelectLyrics(h) {
    const tabs = h.closest(SEL.tabs);
    const all = tabs ? [...tabs.querySelectorAll(SEL.tab)] : [h];
    for (const o of all) {
      if (o === h) continue;
      o.removeAttribute('aria-selected');
      o.removeAttribute('iron-selected');
      o.classList.remove('iron-selected', 'selected');
    }
    h.setAttribute('aria-selected', 'true');
    h.setAttribute('iron-selected', '');
    h.classList.add('iron-selected', 'selected');
    schedule();
  }

  // youtube.com: the card lives INSIDE #movie_player — the video element is
  // letterboxed into the left ~80% via `object-fit: contain` and the panel
  // takes the right slice. A left-edge grip adjusts the split, persisted as a
  // fraction. Nothing outside the player is touched.
  const YT_SPLIT_KEY = 'ytmlYtSplit'; // lyrics width as a fraction of the player
  function ytSplitFrac() {
    const f = Number(localStorage.getItem(YT_SPLIT_KEY));
    return f >= 0.14 && f <= 0.45 ? f : 0.2;
  }
  function getYtPanel() {
    if (location.pathname !== '/watch') return null;
    const mp = document.getElementById('movie_player') ||
      document.querySelector('.html5-video-player');
    if (!mp) {
      dbg('yt: movie_player not found');
      return null;
    }
    if (!ytPanelEl) {
      ytPanelEl = document.createElement('div');
      ytPanelEl.id = 'ytml-ytpanel';

      const grip = document.createElement('div');
      grip.id = 'ytml-ytgrip';
      grip.title = 'Drag to resize';
      grip.setAttribute('role', 'separator');
      grip.setAttribute('aria-orientation', 'vertical');
      grip.addEventListener('pointerdown', e => {
        e.preventDefault();
        const host = ytPanelEl && ytPanelEl.parentNode;
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const move = ev => {
          const frac = Math.min(0.45, Math.max(0.14, (rect.right - ev.clientX) / rect.width));
          host.style.setProperty('--ytml-lyrics-f', frac.toFixed(3));
          try { localStorage.setItem(YT_SPLIT_KEY, frac.toFixed(3)); } catch { /* noop */ }
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          document.body.classList.remove('ytml-colresize');
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        document.body.classList.add('ytml-colresize');
      });
      ytPanelEl.appendChild(grip);

      ytCloseBtn = document.createElement('button');
      ytCloseBtn.id = 'ytml-ytclose';
      ytCloseBtn.type = 'button';
      ytCloseBtn.innerHTML = ICON_CLOSE;
      ytCloseBtn.title = 'Hide lyrics for this video';
      ytCloseBtn.setAttribute('aria-label', 'Hide lyrics for this video');
      ytCloseBtn.classList.add('ytml-visible');
      ytCloseBtn.addEventListener('click', () => {
        if (trackKey) {
          ytDismissed.add(trackKey);
          ytForced.delete(trackKey);
        }
        teardown();
      });
      ytPanelEl.appendChild(ytCloseBtn);
    }
    if (ytPanelEl.parentNode !== mp) {
      mp.appendChild(ytPanelEl);
      dbg('yt: card injected into player');
    }
    mp.classList.add('ytml-split');
    mp.style.setProperty('--ytml-lyrics-f', ytSplitFrac().toFixed(3));
    return ytPanelEl;
  }

  // YouTube's own right-hand control cluster (settings/cc/fullscreen row).
  // The player bar re-renders itself, so the button is re-pinned each poll.
  function ensureYtCtrlBtn() {
    const host = document.querySelector('.ytp-right-controls');
    if (!host) return;
    if (!ytCtrlBtn) {
      ytCtrlBtn = document.createElement('button');
      ytCtrlBtn.className = 'ytp-button ytml-yt-ctrl';
      ytCtrlBtn.type = 'button';
      ytCtrlBtn.title = 'Lyrics';
      ytCtrlBtn.setAttribute('aria-label', 'Toggle lyrics panel');
      ytCtrlBtn.setAttribute('aria-pressed', 'true');
      ytCtrlBtn.innerHTML =
        '<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block">' +
        '<path fill="currentColor" d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
      ytCtrlBtn.addEventListener('click', () => {
        const t = getTrack();
        if (t && !t.isMusic) {
          if (ytForced.has(t.key)) { ytForced.delete(t.key); teardown(); }
          else { ytForced.add(t.key); ytCardHidden = false; update(); }
        } else {
          ytCardHidden = !ytCardHidden;
          if (ytCardHidden) teardown();
          else update();
        }
        refreshYtCtrlBtn(t);
      });
    }
    if (ytCtrlBtn.parentNode !== host) host.prepend(ytCtrlBtn);
  }

  // non-music video: the button force-opens the panel for that video only —
  // detection misses happen, and "No lyrics found" is better than nothing.
  function refreshYtCtrlBtn(t) {
    if (!ytCtrlBtn) return;
    const active = t && !t.isMusic ? ytForced.has(t.key) : !ytCardHidden;
    ytCtrlBtn.classList.toggle('ytml-off', !active);
    ytCtrlBtn.setAttribute('aria-pressed', String(active));
  }

  function findPanel() {
    if (IS_YT) return getYtPanel();

    const page = getPage();
    if (!page) return null;

    const tabs = page.querySelector(SEL.tabs);
    const headers = tabs ? [...tabs.querySelectorAll(SEL.tab)] : [];
    const sel = headers.find(isHeaderSelected);

    if (sel && !isLyricsLabel(sel)) return null;
    if (!sel && !page.querySelector(SEL.shelf)) return null;

    const p = page.querySelector(SEL.panel);
    return p && p.getClientRects().length ? p : null;
  }

  function exitFullscreen() {
    if (!fullscreen) return;
    fullscreen = false;
    document.body.classList.remove('ytml-fs', 'ytml-idlecur');
    clearTimeout(cursorTimer);
    fsPaused = null;
    if (panel && panel.isConnected && root) {
      root.classList.remove('ytml-anim');
      (pipWin && pipWin.document ? pipWin.document.body : panel).appendChild(root);
      placeControls();
      if (fsWrap) fsWrap.remove();
      if (dispSynced() && activeIdx >= 0) {
        requestAnimationFrame(() => scrollToActive(activeIdx, 'auto'));
      }
    } else {
      if (fsWrap) fsWrap.remove();
      if (root && root.isConnected) root.remove();
      placeControls();
    }
  }

  function teardown() {
    exitFullscreen();
    if (pipWin) {
      try { pipWin.close(); } catch { /* noop */ }
      pipWin = null;
    }
    hidePipPlaceholder();
    if (root && root.isConnected) root.remove();
    if (barEl && barEl.isConnected) barEl.remove();
    if (jumpBtn && jumpBtn.isConnected) jumpBtn.remove();
    if (fsBtn && fsBtn.isConnected) fsBtn.remove();
    if (searchBtn && searchBtn.isConnected) searchBtn.remove();
    if (pipBtn && pipBtn.isConnected) pipBtn.remove();
    if (nsyncBtn && nsyncBtn.isConnected) nsyncBtn.remove();
    if (findEl) {
      findEl.classList.remove('ytml-visible');
      if (findEl.isConnected) findEl.remove();
    }
    if (syncChip && syncChip.isConnected) syncChip.remove();
    if (toastEl && toastEl.isConnected) toastEl.remove();
    if (ytPanelEl && ytPanelEl.isConnected) ytPanelEl.remove();
    ytPanelEl = null;
    // The card's × lives inside barEl once attached — it is recreated per
    // ytPanelEl, so drop it here or stale copies pile up in the bar.
    if (ytCloseBtn) {
      ytCloseBtn.remove();
      ytCloseBtn = null;
    }
    for (const el of document.querySelectorAll('.ytml-split')) {
      el.classList.remove('ytml-split');
      el.style.removeProperty('--ytml-lyrics-f');
    }
    if (panel) panel.classList.remove(HOST_CLASS);
    panel = null;
    lyrics = null;
    lineEls = [];
    activeIdx = -1;
  }

  function controlsParent() {
    return fullscreen ? document.body : panel;
  }

  function attachRoot(measuredHeight) {
    root = document.getElementById(ROOT_ID) || document.createElement('div');
    root.id = ROOT_ID;
    if (!root.dataset.bound) {
      root.addEventListener('wheel', onUserScroll, { passive: true });
      root.addEventListener('touchmove', onUserScroll, { passive: true });
      root.addEventListener('mousedown', onUserScroll, { passive: true });
      root.addEventListener('keydown', onRootKey);
      root.addEventListener('scroll', onScroll, { passive: true });
      root.dataset.bound = '1';
    }
    root.tabIndex = 0;
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Lyrics');
    ensureBar();
    if (pipWin && pipWin.document) {
      // lyrics float in PiP — keep them there across re-attach cycles
      pipWin.document.body.appendChild(root);
      showPipPlaceholder();
    } else {
      panel.appendChild(root);
    }
    ensureControls();
    const vh = window.innerHeight;
    const h = panel === ytPanelEl
      ? Math.min(560, Math.max(300, Math.round(vh * 0.52)))
      : measuredHeight > 160 && measuredHeight < vh * 1.5
        ? measuredHeight
        : Math.max(280, vh - 240);
    root.style.height = h + 'px';
    appliedKey = null;
  }

  function ensureControls() {
    const parent = controlsParent();
    if (!parent) return;
    ensureBar();
    ensureJumpButton();
    ensureFsButton();
    ensureFindButton();
    ensurePipButton();
    ensureNsyncButton();
    ensureSyncChip();
    ensureToast();
  }

  // Header row inside the panel: action buttons live in normal flow — no
  // overlay hit-testing games, and lyrics never sit under them. In
  // fullscreen they move to document.body and take the fixed-position rules.
  function ensureBar() {
    if (!barEl) {
      barEl = document.createElement('div');
      barEl.id = 'ytml-bar';
      barEl.setAttribute('role', 'toolbar');
      barEl.setAttribute('aria-label', 'Lyrics actions');
    }
    if (panel && barEl.parentNode !== panel) panel.insertBefore(barEl, panel.firstChild);
    if (ytCloseBtn && barEl.parentNode === ytPanelEl && ytCloseBtn.parentNode !== barEl) {
      barEl.appendChild(ytCloseBtn);
    }
  }

  function barParent() {
    return fullscreen ? document.body : barEl || controlsParent();
  }

  function placeControls() {
    const parent = controlsParent();
    if (!parent) return;
    const bar = barParent();
    for (const el of [fsBtn, searchBtn, pipBtn, nsyncBtn]) {
      if (el && bar && el.parentNode !== bar) bar.appendChild(el);
    }
    for (const el of [jumpBtn, syncChip, toastEl, findEl]) {
      if (el && el.parentNode !== parent) parent.appendChild(el);
    }
  }

  function ensureUI() {
    const p = findPanel();
    if (!p) return null;
    if (p !== panel) {
      if (IS_YT) {
        // teardown() removes ytPanelEl itself — on YT the panel IS ours, so
        // just swap hosts; everything inside the card already belongs to us.
        exitFullscreen();
        if (panel) panel.classList.remove(HOST_CLASS);
      } else {
        teardown();
      }
      panel = p;
      const ph = panel.clientHeight;
      panel.classList.add(HOST_CLASS);
      attachRoot(ph);
    } else if (!root || !root.isConnected) {
      attachRoot(panel.clientHeight);
    }
    return root;
  }

  const onUserScroll = () => {
    suppressUntil = Infinity;
  };

  function onRootKey(e) {
    if (e.target !== root) return;
    if ([' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) {
      suppressUntil = Infinity;
    }
  }

  function onScroll() {
    if (jumpRaf) return;
    jumpRaf = true;
    requestAnimationFrame(() => {
      jumpRaf = false;
      updateJumpButton();
    });
  }

  function ensureJumpButton() {
    if (!jumpBtn) {
      jumpBtn = document.createElement('button');
      jumpBtn.id = 'ytml-plus-jump';
      jumpBtn.type = 'button';
      jumpBtn.textContent = 'Back to lyric';
      jumpBtn.setAttribute('aria-label', 'Scroll back to the current lyric line');
      jumpBtn.addEventListener('click', () => {
        suppressUntil = 0;
        if (lyrics && dispSynced() && activeIdx >= 0) scrollToActive(activeIdx);
      });
    }
    controlsParent().appendChild(jumpBtn);
    updateJumpButton();
  }

  function updateJumpButton() {
    if (!jumpBtn) return;
    // Root lives in the PiP document while it floats — the pill would pop up
    // in the main panel over the placeholder, useless and confusing.
    if (pipWin) {
      jumpBtn.classList.remove('ytml-visible');
      return;
    }
    const el = root && root.isConnected && lyrics && dispSynced() && activeIdx >= 0
      ? lineEls[activeIdx]
      : null;
    if (!el) {
      jumpBtn.classList.remove('ytml-visible');
      return;
    }
    const above = el.offsetTop + el.clientHeight < root.scrollTop + 48;
    const below = el.offsetTop > root.scrollTop + root.clientHeight - 48;
    if (!above && !below) {
      suppressUntil = 0;
      jumpBtn.classList.remove('ytml-visible');
      return;
    }
    jumpBtn.textContent = above ? '↑ Back to lyric' : '↓ Back to lyric';
    jumpBtn.classList.add('ytml-visible');
  }

  function ensureFsButton() {
    if (!fsBtn) {
      fsBtn = document.createElement('button');
      fsBtn.id = 'ytml-plus-fs';
      fsBtn.type = 'button';
      fsBtn.innerHTML = ICON_FS;
      fsBtn.setAttribute('aria-label', 'Toggle fullscreen lyrics');
      fsBtn.title = 'Fullscreen lyrics';
      fsBtn.addEventListener('click', () => (fullscreen ? exitFullscreen() : enterFullscreen()));
    }
    const bar = barParent();
    if (bar) bar.appendChild(fsBtn);
  }

  // ---- Manual lyrics search (override) ----
  // Always visible while a panel is up: it is the fix path for "No lyrics
  // found" and wrong matches, so it must not be gated on lyrics existing.
  function ensureFindButton() {
    if (!searchBtn) {
      searchBtn = document.createElement('button');
      searchBtn.id = 'ytml-plus-find';
      searchBtn.type = 'button';
      searchBtn.innerHTML = ICON_SEARCH;
      searchBtn.title = 'Search lyrics manually';
      searchBtn.setAttribute('aria-label', 'Search lyrics manually');
      searchBtn.classList.add('ytml-visible');
      searchBtn.addEventListener('click', toggleFind);
    }
    const bar = barParent();
    if (bar) bar.appendChild(searchBtn);
  }

  function toggleFind() {
    if (!findEl) buildFind();
    if (findEl.classList.contains('ytml-visible')) {
      closeFind();
      return;
    }
    findTitle.value = curTitle;
    findArtist.value = curArtist;
    findList.innerHTML = '';
    placeControls();
    findEl.classList.add('ytml-visible');
    findTitle.focus();
    findTitle.select();
  }

  function closeFind() {
    if (findEl) findEl.classList.remove('ytml-visible');
  }

  function buildFind() {
    findEl = document.createElement('div');
    findEl.id = 'ytml-find';
    findEl.setAttribute('role', 'dialog');
    findEl.setAttribute('aria-label', 'Search lyrics');
    const row = document.createElement('div');
    row.className = 'ytml-find-row';
    findTitle = document.createElement('input');
    findTitle.placeholder = 'Song title';
    findTitle.setAttribute('aria-label', 'Song title');
    findArtist = document.createElement('input');
    findArtist.placeholder = 'Artist';
    findArtist.setAttribute('aria-label', 'Artist');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'ytml-find-go';
    go.textContent = 'Search';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'ytml-find-x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close search');
    row.append(findTitle, findArtist, go, x);
    findList = document.createElement('div');
    findList.className = 'ytml-find-list';
    findEl.append(row, findList);
    go.addEventListener('click', runFind);
    x.addEventListener('click', closeFind);
    for (const inp of [findTitle, findArtist]) {
      inp.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          runFind();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeFind();
        }
      });
    }
    controlsParent().appendChild(findEl);
  }

  async function runFind() {
    const title = findTitle.value.trim();
    const artist = findArtist.value.trim();
    if (!title && !artist) return;
    findList.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'ytml-find-empty';
    loading.textContent = 'Searching…';
    findList.appendChild(loading);
    let res = null;
    try {
      res = await chrome.runtime.sendMessage({
        type: 'searchLyrics',
        track: { title, artist, duration: curDur },
      });
    } catch { /* noop */ }
    const items = (res && res.items) || [];
    findList.innerHTML = '';
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'ytml-find-empty';
      d.textContent = 'No matches — try different words';
      findList.appendChild(d);
      return;
    }
    for (const it of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ytml-find-item';
      const t = document.createElement('span');
      t.className = 'ytml-find-item-title';
      t.textContent = `${it.title || '?'} — ${it.artist || '?'}`;
      const meta = document.createElement('span');
      meta.className = 'ytml-find-item-meta';
      const bits = [];
      if (it.album) bits.push(it.album);
      if (it.duration) bits.push(fmtTime(it.duration));
      bits.push(it.kind === 'karaoke' ? 'karaoke' : it.kind === 'synced' ? 'synced' : 'plain');
      bits.push(it.source);
      meta.textContent = bits.join(' · ');
      b.append(t, meta);
      b.addEventListener('click', () => pickFind(it));
      findList.appendChild(b);
    }
  }

  function pickFind(it) {
    closeFind();
    const key = (playerSnap && playerSnap.videoId) ? `v:${playerSnap.videoId}` : trackKey;
    if (!it.res || !key) return;
    // A manual pick is an authoritative override: cache it like a provider
    // hit so it survives reloads until the normal cache TTL lapses.
    cache.set(key, it.res);
    persistLyrics(key, it.res);
    appliedKey = key;
    applyResult(it.res);
    toast(`Lyrics: ${it.title} — ${it.artist}`);
  }

  // ---- Bar icons (Material-style SVGs — unicode glyphs were illegible) ----
  const ICON_FS = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>';
  const ICON_SEARCH = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 1 0-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/></svg>';
  const ICON_PIP = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M19 11h-8v6h8v-6zm-6 4h4v-2h-4v2zm8-12H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V5h18v14z"/></svg>';
  const ICON_SYNC = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 4V1L8 5l4 4V6a6 6 0 0 1 6 6 6 6 0 0 1-.59 2.66l1.46 1.46A8 8 0 0 0 20 12a8 8 0 0 0-8-8zm0 14a6 6 0 0 1-6-6 6 6 0 0 1 .59-2.66l-1.46-1.46A8 8 0 0 0 4 12a8 8 0 0 0 8 8v3l4-4-4-4v3z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';

  // ---- Document Picture-in-Picture ----
  const PIP_CSS =
    'html,body{height:100%}' +
    'body.ytml-pip{margin:0;background:#0a0a0d;overflow:hidden}' +
    'body.ytml-pip #ytml-plus-root{height:100vh!important;max-height:none!important;width:auto!important;padding-top:40px;padding-left:24px;padding-right:24px}' +
    'body.ytml-pip #ytml-plus-root .ytml-line{font-size:19px}';

  function ensurePipButton() {
    if (!('documentPictureInPicture' in window)) return;
    if (!pipBtn) {
      pipBtn = document.createElement('button');
      pipBtn.id = 'ytml-plus-pip';
      pipBtn.type = 'button';
      pipBtn.innerHTML = ICON_PIP;
      pipBtn.title = 'Floating lyrics window';
      pipBtn.setAttribute('aria-label', 'Open lyrics in a floating window');
      pipBtn.addEventListener('click', togglePip);
      // Warm the stylesheet cache early: requestWindow() needs transient user
      // activation, so the click path should not sit behind a message first.
      if (!pipCss && contextAlive()) {
        try {
          chrome.runtime.sendMessage({ type: 'pipCss' })
            .then(res => { if (res && res.ok) pipCss = res.css; })
            .catch(() => { /* noop */ });
        } catch { /* context invalidated between check and call */ }
      }
    }
    const bar = barParent();
    if (bar) bar.appendChild(pipBtn);
  }

  // Per-song "don't follow timings" switch: manually-picked lyrics that don't
  // match the video are more readable as static text than as a wrong karaoke.
  function ensureNsyncButton() {
    if (!nsyncBtn) {
      nsyncBtn = document.createElement('button');
      nsyncBtn.id = 'ytml-plus-nsync';
      nsyncBtn.type = 'button';
      nsyncBtn.innerHTML = ICON_SYNC;
      nsyncBtn.title = 'Toggle lyric line sync for this song';
      nsyncBtn.setAttribute('aria-label', 'Toggle lyric line sync for this song');
      nsyncBtn.addEventListener('click', toggleNsync);
    }
    const bar = barParent();
    if (bar) bar.appendChild(nsyncBtn);
    updateNsyncBtn();
  }

  function updateNsyncBtn() {
    if (!nsyncBtn) return;
    nsyncBtn.classList.toggle('ytml-visible', !!(lyrics && lyrics.synced));
    nsyncBtn.classList.toggle('ytml-off', !!(trackKey && nosync.has(trackKey)));
  }

  function toggleNsync() {
    if (!trackKey || !lyrics || !lyrics.synced) return;
    const off = !nosync.has(trackKey);
    if (off) nosync.add(trackKey);
    else nosync.delete(trackKey);
    persistNosync();
    const st = root ? root.scrollTop : 0;
    renderLines();
    if (root) root.scrollTop = st;
    updateJumpButton();
    updateFsVisibility();
    updateSyncChip();
    toast(off ? 'Lyrics shown without sync' : 'Line sync back on');
  }

  async function togglePip() {
    if (pipWin) {
      try { pipWin.close(); } catch { /* noop */ }
      return;
    }
    if (pipOpening || !root || !('documentPictureInPicture' in window)) return;
    if (fullscreen) exitFullscreen();
    pipOpening = true;
    try {
      if (!pipCss) {
        const res = await chrome.runtime.sendMessage({ type: 'pipCss' });
        if (!res || !res.ok) throw new Error('css fetch failed');
        pipCss = res.css;
      }
      const w = await documentPictureInPicture.requestWindow({ width: 360, height: 460 });
      pipWin = w;
      const style = w.document.createElement('style');
      style.textContent = pipCss + '\n' + PIP_CSS;
      w.document.head.appendChild(style);
      w.document.body.className = 'ytml-pip';
      w.document.documentElement.classList.toggle('ytml-nofill', !prefs.fill);
      w.document.body.appendChild(root);
      showPipPlaceholder();
      if (pipBtn) pipBtn.classList.add('ytml-on');
      // Only the tracked window may trigger the restore — a superseded
      // window's pagehide must not steal root back from a live one.
      w.addEventListener('pagehide', () => { if (pipWin === w) onPipClosed(); });
    } catch (e) {
      if (pipWin) {
        try { pipWin.close(); } catch { /* noop */ }
        pipWin = null;
      }
      if (pipBtn) pipBtn.classList.remove('ytml-on');
      dbg('pip failed', e && e.message);
    } finally {
      pipOpening = false;
    }
    updateFsVisibility();
  }

  function onPipClosed() {
    pipWin = null;
    hidePipPlaceholder();
    if (pipBtn) pipBtn.classList.remove('ytml-on');
    if (root && panel && panel.isConnected && !fullscreen) {
      panel.appendChild(root);
      placeControls();
      if (dispSynced() && activeIdx >= 0) {
        requestAnimationFrame(() => scrollToActive(activeIdx, 'auto'));
      }
    }
    updateFsVisibility();
  }

  function showPipPlaceholder() {
    if (!panel) return;
    hidePipPlaceholder();
    pipPh = document.createElement('div');
    pipPh.className = 'ytml-status';
    pipPh.textContent = 'Lyrics in Picture-in-Picture — close the floating window to bring them back';
    panel.appendChild(pipPh);
  }

  function hidePipPlaceholder() {
    if (pipPh && pipPh.isConnected) pipPh.remove();
    pipPh = null;
  }

  function ensureSyncChip() {
    if (!syncChip) {
      syncChip = document.createElement('button');
      syncChip.id = 'ytml-plus-sync';
      syncChip.type = 'button';
      syncChip.title = 'Right-click a lyric line to re-sync it to this moment · click to reset the offset';
      syncChip.setAttribute('aria-label', 'Lyrics timing offset; activate to reset');
      syncChip.addEventListener('click', () => setOffset(0, true));
    }
    controlsParent().appendChild(syncChip);
    updateSyncChip();
  }

  function ensureToast() {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.id = 'ytml-plus-toast';
      toastEl.setAttribute('role', 'status');
    }
    controlsParent().appendChild(toastEl);
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add('ytml-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('ytml-visible'), 2200);
  }

  function offsetFor(key) {
    return offsets.get(key) || 0;
  }

  // Display-effective sync: the provider may say "synced" while the user
  // disabled line tracking for this song (manually-picked lyrics that don't
  // line up are better shown as plain readable text).
  function dispSynced() {
    return !!(lyrics && lyrics.synced && !(trackKey && nosync.has(trackKey)));
  }

  function updateSyncChip() {
    if (!syncChip) return;
    const o = currentOffset;
    if (Math.abs(o) < 0.05 || (trackKey && nosync.has(trackKey))) {
      syncChip.classList.remove('ytml-visible');
      return;
    }
    syncChip.textContent = `↺ sync ${o > 0 ? '+' : ''}${o.toFixed(1)}s`;
    syncChip.classList.add('ytml-visible');
  }

  function setOffset(o, announce) {
    currentOffset = o;
    if (trackKey) {
      if (Math.abs(o) < 0.05) offsets.delete(trackKey);
      else offsets.set(trackKey, Math.round(o * 100) / 100);
      persistOffsets();
    }
    updateSyncChip();
    if (announce) toast(Math.abs(o) < 0.05 ? 'Sync offset reset' : `Lyrics shifted ${o > 0 ? '+' : ''}${o.toFixed(1)}s`);
  }

  let offsetsLoaded = false;
  async function loadOffsets() {
    if (offsetsLoaded) return;
    offsetsLoaded = true;
    try {
      await chrome.storage.local.remove(['ytmlCache', 'ytmlCacheV2']); // stale caches: unverified matches / noisy titles
    } catch { /* storage unavailable */ }
    try {
      const obj = (await chrome.storage.local.get(STORE_OFFSETS))[STORE_OFFSETS];
      if (obj && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
          if (typeof v === 'number') offsets.set(k, v);
        }
      }
      const ns = (await chrome.storage.local.get(STORE_NOSYNC))[STORE_NOSYNC];
      if (ns && typeof ns === 'object') {
        for (const k of Object.keys(ns)) if (ns[k]) nosync.add(k);
      }
    } catch { /* storage unavailable */ }
    if (trackKey) {
      currentOffset = offsetFor(trackKey);
      updateSyncChip();
    }
  }

  let offsetsWriteTimer = null;
  function persistOffsets() {
    clearTimeout(offsetsWriteTimer);
    offsetsWriteTimer = setTimeout(async () => {
      try {
        const obj = Object.fromEntries(offsets);
        const keys = Object.keys(obj);
        if (keys.length > 500) {
          for (const k of keys.slice(0, keys.length - 500)) delete obj[k];
        }
        await chrome.storage.local.set({ [STORE_OFFSETS]: obj });
      } catch { /* storage unavailable */ }
    }, 400);
  }

  let nosyncWriteTimer = null;
  function persistNosync() {
    clearTimeout(nosyncWriteTimer);
    nosyncWriteTimer = setTimeout(async () => {
      try {
        const obj = {};
        for (const k of nosync) obj[k] = true;
        const keys = Object.keys(obj);
        if (keys.length > 500) {
          for (const k of keys.slice(0, keys.length - 500)) delete obj[k];
        }
        await chrome.storage.local.set({ [STORE_NOSYNC]: obj });
      } catch { /* storage unavailable */ }
    }, 400);
  }

  let prefsLoaded = false;
  async function loadPrefs() {
    if (prefsLoaded) return;
    prefsLoaded = true;
    try {
      const obj = (await chrome.storage.local.get(STORE_PREFS))[STORE_PREFS];
      if (obj && typeof obj === 'object') Object.assign(prefs, obj);
    } catch { /* storage unavailable */ }
    applyPrefFill();
  }

  function applyPrefFill() {
    document.documentElement.classList.toggle('ytml-nofill', !prefs.fill);
    if (pipWin && pipWin.document) {
      pipWin.document.documentElement.classList.toggle('ytml-nofill', !prefs.fill);
    }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORE_PREFS]) {
        Object.assign(prefs, changes[STORE_PREFS].newValue || {});
        applyPrefFill();
      }
    });
  } catch { /* api unavailable */ }

  async function storedLyrics(key) {
    if (storageMiss.has(key)) return undefined;
    try {
      const all = (await chrome.storage.local.get(STORE_LYRICS))[STORE_LYRICS] || {};
      const entry = all[key];
      if (!entry) {
        storageMiss.add(key);
        return undefined;
      }
      const ttl = entry.data ? TTL_LYRICS : TTL_NONE;
      if (Date.now() - (entry.ts || 0) > ttl) return undefined;
      return entry.data || 'none';
    } catch {
      return undefined;
    }
  }

  let storeWriteTimer = null;
  const pendingStoreWrites = new Map();
  function persistLyrics(key, data) {
    pendingStoreWrites.set(key, { data, ts: Date.now() });
    storageMiss.delete(key);
    clearTimeout(storeWriteTimer);
    storeWriteTimer = setTimeout(async () => {
      try {
        const all = (await chrome.storage.local.get(STORE_LYRICS))[STORE_LYRICS] || {};
        for (const [k, v] of pendingStoreWrites) all[k] = v;
        pendingStoreWrites.clear();
        const keys = Object.keys(all);
        if (keys.length > STORE_CAP) {
          keys
            .sort((a, b) => (all[a].ts || 0) - (all[b].ts || 0))
            .slice(0, keys.length - STORE_CAP)
            .forEach(k => delete all[k]);
        }
        await chrome.storage.local.set({ [STORE_LYRICS]: all });
      } catch { /* storage unavailable */ }
    }, 400);
  }

  function renderStatus(text) {
    if (!root) return;
    root.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'ytml-status';
    el.textContent = text;
    root.appendChild(el);
    lyrics = null;
    lineEls = [];
    activeIdx = -1;
    updateJumpButton();
    updateFsVisibility();
  }

  function wordSpan(text, time, end) {
    const ws = document.createElement('span');
    ws.className = 'ytml-w';
    ws.textContent = text;
    ws.dataset.t = time;
    ws.dataset.e = end == null ? '' : end;
    return ws;
  }

  function renderLines() {
    root.innerHTML = '';
    root.scrollTop = 0; // innerHTML rebuild keeps the previous song's scroll
    lineEls = [];
    activeIdx = -1;
    const sync = dispSynced();
    lyrics.lines.forEach((line, i) => {
      const el = document.createElement('div');
      if (!line.text && !sync) {
        el.className = 'ytml-gap';
      } else {
        el.className = 'ytml-line ' + (sync ? 'ytml-d3' : 'ytml-static');
        if (line.bg) el.classList.add('ytml-bg');
        el.style.setProperty('--i', Math.min(i, 30));
        if (sync && line.text) {
          if (line.words && line.words.length) {
            for (const w of line.words) {
              el.appendChild(wordSpan(w.text, w.time, w.end));
              el.appendChild(document.createTextNode(' '));
            }
          } else {
            // No word timings — spread the line's window across its words
            // proportionally to length, so the fill sweeps word by word.
            const next = lyrics.lines[i + 1];
            const end = line.end == null ? (next ? next.time : line.time + 4) : line.end;
            const span = Math.max(end - line.time, 0.4);
            const tokens = line.text.split(/(\s+)/);
            const totalChars = tokens.reduce((a, t) => a + (t.trim() ? t.length : 0), 0) || 1;
            let t = line.time;
            for (const tok of tokens) {
              if (!tok.trim()) {
                el.appendChild(document.createTextNode(tok));
                continue;
              }
              const dur = (tok.length / totalChars) * span;
              el.appendChild(wordSpan(tok, t, t + dur));
              t += dur;
            }
          }
          el.dataset.words = '1';
        } else {
          el.textContent = line.text || '♪';
        }
        if (sync) {
          el.setAttribute('role', 'button');
          el.tabIndex = 0;
          el.title = 'Seek to this line · right-click to re-sync';
          el.addEventListener('click', () => {
            seekTo(line.time + currentOffset + 0.02);
            suppressUntil = 0;
          });
          el.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              el.click();
            }
          });
          el.addEventListener('contextmenu', e => {
            e.preventDefault();
            const v = getVideo();
            if (!v) return;
            setOffset(v.currentTime - line.time, true);
          });
        }
      }
      lineEls.push(el);
      root.appendChild(el);
    });
    const credit = document.createElement('div');
    credit.className = 'ytml-credit';
    if (lyrics.source === 'lrclib') {
      credit.innerHTML =
        'Lyrics: <a href="https://lrclib.net" target="_blank" rel="noopener noreferrer">LRCLIB</a>' +
        (lyrics.synced ? ' · synced' : ' · not synced');
    } else if (lyrics.source === 'lrccx') {
      credit.innerHTML =
        'Lyrics: <a href="https://lrc.cx" target="_blank" rel="noopener noreferrer">lrc.cx</a>' +
        (lyrics.wordSync ? ' · karaoke' : ' · synced');
    } else {
      credit.textContent = lyrics.attribution || 'Source: YouTube Music';
    }
    if (lyrics.synced && !sync) credit.appendChild(document.createTextNode(' · sync off'));
    if (sync) {
      credit.appendChild(document.createTextNode(' · right-click a line to re-sync'));
    }
    root.appendChild(credit);
  }

  function maybeAutoOpen(key) {
    if (!prefs.autoOpen || !AUTOOPEN_ONCE || autoOpened.has(key) || userNavigated.has(key)) return;
    const h = findLyricsHeader();
    if (!h || isHeaderSelected(h)) return;
    autoOpened.add(key);
    dbg('auto-opening lyrics tab');
    try {
      h.click();
    } catch { /* fall through to manual select */ }
    setTimeout(() => {
      if (!dead && !isHeaderSelected(h) && !userNavigated.has(key)) manualSelectLyrics(h);
    }, 300);
  }

  function applyResult(res) {
    if (!res || res === 'none') {
      teardown();
      return;
    }
    if (res.instrumental) {
      lyrics = null;
      renderStatus('♪ Instrumental');
      return;
    }
    lastResult = res;
    lyrics = res;
    dbg('apply:', trackKey, res.lines.length, 'lines,', res.synced ? 'synced' : 'plain', '· src:', res.source);
    // Provider lyrics are timed to the song version; when a music video is
    // playing, its segmentMap corrects for intro/outro/cut differences.
    if (res.synced && currentMeta && currentMeta.isVideo && currentMeta.segMap && currentMeta.segMap.length) {
      lyrics = applySegMap(res, currentMeta.segMap);
      segMapApplied = true;
      dbg('segMap applied:', currentMeta.segMap.length, 'segments');
    }
    renderLines();
    if (wantLineAnim && root) {
      wantLineAnim = false;
      root.classList.add('ytml-anim');
      clearTimeout(animTimer);
      // enough for the longest staggered line to finish, then disarm — the
      // class must not survive into a reparent or lines re-animate there.
      animTimer = setTimeout(() => {
        if (root) root.classList.remove('ytml-anim');
      }, lyrics.lines.length * 28 + 700);
    }
    if (dispSynced()) {
      const v = getVideo();
      if (v) {
        const lt = liveTime(v);
        const t = lt < 0 ? -1 : lt - currentOffset;
        setActive(binarySearch(lyrics.lines, t));
        scrollToActive(activeIdx, 'auto');
      }
      maybeAutoOpen(trackKey);
    }
    updateJumpButton();
    updateSyncChip();
    updateFsVisibility();
    applyTint();
  }

  function updateFsVisibility() {
    const has = !!(lyrics && lyrics.lines && lyrics.lines.length);
    if (fsBtn) fsBtn.classList.toggle('ytml-visible', has);
    if (pipBtn) pipBtn.classList.toggle('ytml-visible', has || !!pipWin);
    updateNsyncBtn();
  }

  function nativeFallback() {
    // Prefer lyrics sniffed from YouTube Music's own /browse response.
    const vid = playerSnap && playerSnap.videoId;
    const sniffed = vid ? sniffedLyrics.get(vid) : null;
    if (sniffed && sniffed.text) return ytmLyricsResult(sniffed.text, sniffed.source);

    const page = getPage();
    const shelf = page && page.querySelector(SEL.shelf);
    if (!shelf) return null;
    const desc = shelf.querySelector('.description') || shelf.querySelector('#description') || shelf;
    const text = (desc.innerText || '').trim();
    if (!text || text.split('\n').filter(l => l.trim()).length < 2) return null;
    const attr = shelf.querySelector('.footer') || shelf.querySelector('.attribution');
    return {
      synced: false,
      lines: text.split('\n').map(t => ({ text: t.trim() })),
      source: 'ytm',
      attribution: attr ? attr.innerText.trim() : 'Source: YouTube Music',
    };
  }

  function applyTint() {
    if (!root) return;
    const url = artworkUrl().replace(/=w600-h600/, '=w64-h64');
    if (!url) {
      root.style.removeProperty('--ytml-tint');
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 6;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 6, 6);
        const d = ctx.getImageData(0, 0, 6, 6).data;
        let r = 0, g = 0, b = 0;
        const n = d.length / 4;
        for (let i = 0; i < d.length; i += 4) {
          r += d[i];
          g += d[i + 1];
          b += d[i + 2];
        }
        const rgb = `${(r / n) | 0}, ${(g / n) | 0}, ${(b / n) | 0}`;
        if (root && root.isConnected) root.style.setProperty('--ytml-tint', `rgba(${rgb}, 0.22)`);
        if (fsWrap) fsWrap.style.setProperty('--ytml-tint', `rgba(${rgb}, 0.5)`);
      } catch { /* canvas tainted by CORS; default tint stays */ }
    };
    img.src = url;
  }

  async function fetchTrack(track) {
    cache.set(track.key, 'pending');
    try {
      const stored = await storedLyrics(track.key);
      if (stored !== undefined) {
        cache.set(track.key, stored);
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: 'fetchLyrics', track });
      if (res && res.ok) {
        // nativeFallback reads the CURRENT player's sniffed lyrics — if the
        // song advanced while the fetch was in flight it would return the
        // new song's text for this track's key. Only valid while this track
        // is still the one playing.
        const stillCurrent = track.key === trackKey;
        const data = res.data || (stillCurrent ? nativeFallback() : null) || null;
        const val = data || 'none';
        cache.set(track.key, val);
        persistLyrics(track.key, data);
        // A real result upgrades whatever interim/native lyrics are showing.
        if (data && appliedKey === track.key) appliedKey = null;
      } else {
        cache.delete(track.key);
        const tries = (fetchRetries.get(track.key) || 0) + 1;
        fetchRetries.set(track.key, tries);
        if (tries >= MAX_FETCH_RETRIES) {
          cache.set(track.key, 'none');
          dbg('gave up fetching', track.key);
        } else {
          retryAfter.set(track.key, Date.now() + Math.min(3000 * 2 ** (tries - 1), 30000));
        }
      }
    } catch {
      cache.delete(track.key);
      retryAfter.set(track.key, Date.now() + 8000);
    }
  }

  async function update() {
    if (dead) return;
    if (!contextAlive()) {
      die();
      return;
    }
    if (IS_YT) {
      // Stay invisible outside watch pages and when disabled; freeze during ads
      // (ad-showing swaps player data — keep the panel, just stop updating).
      if (!prefs.yt || location.pathname !== '/watch') {
        dbgOnce('inact:' + location.pathname + ':' + prefs.yt, 'yt: inactive', { yt: prefs.yt, path: location.pathname });
        teardown();
        return;
      }
      if (playerSnap && playerSnap.ad) {
        dbgOnce('adfreeze', 'yt: ad freeze');
        return;
      }
      ensureYtCtrlBtn();
    }
    const track = getTrack();
    if (!track) {
      // Snap already moved to a new videoId but the track isn't resolvable
      // yet (no duration) — the old song's lines must not linger meanwhile.
      // trackKey deliberately stays put: when the track resolves, the normal
      // track-change branch still has to run its full reset for this key.
      if (playerSnap && playerSnap.videoId && trackKey && trackKey !== `v:${playerSnap.videoId}`) {
        resetTrackState();
        appliedKey = null;
        lyrics = null;
        lineEls = [];
        if (root) renderStatus('Loading lyrics…');
      }
      if (IS_YT) dbgOnce('nt:' + (playerSnap && playerSnap.videoId), 'yt: no track', { snap: !!playerSnap });
      return;
    }
    if (IS_YT) refreshYtCtrlBtn(track);
    if (IS_YT && !track.isMusic && !ytForced.has(track.key)) {
      dbgOnce('nm:' + track.key, 'yt: not music —', { cat: playerSnap && playerSnap.category, mvt: playerSnap && playerSnap.mvType, author: playerSnap && playerSnap.artist, music: track.meta && track.meta.music });
      teardown();
      return;
    }
    if (IS_YT && (ytCardHidden || ytDismissed.has(track.key))) {
      teardown();
      return;
    }
    // Ask the MAIN-world sniffer for a WEB_REMIX /next — the counterpart
    // segmentMap corrects song-timed lyrics onto a music video's timeline.
    // On YTM this matters on auto-advance: the queue prefetches the next
    // track without a /next request, so meta (and segMap) never gets sniffed.
    const needProbe = track.videoId && ytProbeKey !== track.key &&
      (IS_YT || !track.meta || (track.meta.isVideo && !(track.meta.segMap && track.meta.segMap.length)));
    if (needProbe) {
      ytProbeKey = track.key;
      try {
        document.dispatchEvent(new CustomEvent('ytml-probe', { detail: { videoId: track.videoId } }));
      } catch { /* noop */ }
    }
    forceEnableLyricsTab();

    // Track change wipes ALL per-song state before ANY cached-lyrics branch —
    // an early return below must never run against the previous song's key:
    // async sniffed/meta handlers, manual search and cache writes all hang
    // off trackKey, so it has to move first or results land under the old key.
    if (track.key !== trackKey) {
      dbg('track:', trackKey, '→', track.key, '|', track.title, '·', track.artist, `(${track.duration}s)`);
      trackKey = track.key;
      resetTrackState();
      appliedKey = null;
      currentMeta = track.meta || null;
      lastResult = null;
      segMapApplied = false;
      wantLineAnim = true;
      lyrics = null;
      lineEls = [];
      curTitle = track.title || '';
      curArtist = track.artist || '';
      curDur = track.duration || 0;
      currentOffset = offsetFor(track.key);
      trackChangedAt = performance.now();
      updateSyncChip();
      if (fullscreen) updateFsMeta();
    }

    const cached = cache.get(track.key);
    if (cached === 'none') {
      if ((IS_YT || forcedLyricsSelected()) && ensureUI()) renderStatus('No lyrics found for this song');
      else teardown();
      return;
    }
    if (!ensureUI()) {
      teardown();
      return;
    }
    if (cached === undefined || cached === 'pending') {
      if (cached === undefined) {
        const readyAt = retryAfter.get(track.key) || 0;
        if (Date.now() >= readyAt) fetchTrack(track).then(() => !dead && update());
      }
      // While a fetch is in flight the previous song's lyrics must not stay
      // on screen syncing to the new song's clock.
      if (appliedKey !== track.key) renderStatus('Loading lyrics…');
      return;
    }
    if (appliedKey !== track.key) {
      appliedKey = track.key;
      applyResult(cached);
    }
  }

  function binarySearch(lines, t) {
    let lo = 0, hi = lines.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].time <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function setActive(idx) {
    if (idx === activeIdx) return;
    if (activeIdx >= 0 && lineEls[activeIdx]) lineEls[activeIdx].style.removeProperty('--p');
    activeIdx = idx;
    lineEls.forEach((el, i) => {
      el.classList.remove('ytml-active', 'ytml-d1', 'ytml-d2', 'ytml-d3');
      el.classList.add(i === idx ? 'ytml-active' : `ytml-d${Math.min(Math.abs(i - idx), 3)}`);
      if (i !== idx) el.style.removeProperty('--p');
    });
  }

  function paintProgress(el, p) {
    const q = Math.round(p * 200) / 200;
    if (el._p !== q) {
      el._p = q;
      el.style.setProperty('--p', q);
    }
  }

  function paintWords(el, t) {
    const kids = el.children;
    for (const ws of kids) {
      if (!ws.dataset || ws.dataset.t === undefined) continue;
      const start = Number(ws.dataset.t);
      const end = ws.dataset.e === '' ? start + 0.4 : Number(ws.dataset.e);
      paintProgress(ws, Math.min(1, Math.max(0, (t - start) / Math.max(end - start, 0.08))));
    }
  }

  // Best-known playback position in seconds, or -1 for "before the first
  // line". During auto-advance the media element's clock/duration still
  // belong to the previous song for a while — occasionally they never
  // recover — while the bridge's logical position flips atomically with
  // videoId. The element wins when it agrees with the bridge (it seeks
  // instantly); otherwise the bridge position keeps sync alive.
  function liveTime(v) {
    const now = performance.now();
    let expected = null;
    if (playerSnap && !playerSnap.ad && isFinite(playerSnap.currentTime) &&
        isFinite(playerSnap.t) && Date.now() - playerSnap.t < 3000 &&
        trackKey === `v:${playerSnap.videoId}`) {
      expected = playerSnap.currentTime + (playerSnap.playing ? (Date.now() - playerSnap.t) / 1000 : 0);
    }
    if (v && isFinite(v.currentTime)) {
      if (v.currentTime !== lastVideoTime) {
        lastVideoTime = v.currentTime;
        lastTimeChange = now;
      }
      // currentTime can only exceed the loaded media's duration while the
      // element still carries the previous track's tail across a transition.
      const pastEnd = isFinite(v.duration) && v.duration > 0 && v.currentTime > v.duration + 0.5;
      // A position frozen right after a track change is the old tail too —
      // a live position keeps moving. (Window-bounded so a paused song is
      // never mistaken for it.)
      const frozenTail = v.currentTime > 0 && trackChangedAt && now - trackChangedAt < 4000 && now - lastTimeChange > 700;
      // Element far from the bridge position = not the live media (old
      // tail, or a fresh element stuck at 0 while the song plays). Seek
      // events re-emit the snap immediately, so live seeks never diverge.
      const offSnap = expected != null && !v.seeking && Math.abs(v.currentTime - expected) > 4;
      if (!pastEnd && !frozenTail && !offSnap) return v.currentTime;
      dbgOnce('stale:' + trackKey, 'stale element time', v.currentTime.toFixed(1), 'vs logical', expected == null ? 'n/a' : expected.toFixed(1));
    }
    return expected != null ? expected : -1;
  }

  function scrollToActive(idx, behavior = 'smooth') {
    if (!root) return;
    // idx=-1 = intro before the first line: a stale scroll position (e.g. an
    // apply that ran while currentTime still reported the previous song's
    // tail) must scroll back to the top instead of staying put.
    if (idx < 0) {
      root.scrollTo({ top: 0, behavior });
      return;
    }
    const el = lineEls[idx];
    if (!el) return;
    const top = el.offsetTop - root.clientHeight / 2 + el.clientHeight / 2;
    root.scrollTo({ top: Math.max(0, top), behavior });
  }

  function tick() {
    try {
      const v = getVideo();
      if (fullscreen && v && fsFillEl) {
        const lt = liveTime(v);
        const dur = curDur || (isFinite(v.duration) ? v.duration : 0);
        fsFillEl.style.transform = `scaleX(${dur ? Math.max(0, lt) / dur : 0})`;
        fsCurEl.textContent = fmtTime(Math.max(0, lt));
        fsDurEl.textContent = fmtTime(dur);
        if (v.paused !== fsPaused) {
          fsPaused = v.paused;
          fsPlayEl.innerHTML = v.paused ? SVG_PLAY : SVG_PAUSE;
        }
      }
      // appliedKey lags the snap across a track change — while it still
      // points at the previous song, don't let its lines highlight/scroll
      // against the new song's clock (update() re-renders within ~250ms).
      const liveKey = playerSnap && playerSnap.videoId ? `v:${playerSnap.videoId}` : trackKey;
      if (root && root.isConnected && lyrics && dispSynced() && appliedKey === liveKey && !document.hidden && v && !(playerSnap && playerSnap.ad)) {
        const lt = liveTime(v);
        const t = lt < 0 ? -1 : lt - currentOffset;
        const idx = binarySearch(lyrics.lines, t);
        if (idx !== activeIdx) {
          setActive(idx);
          if (Date.now() >= suppressUntil) scrollToActive(idx);
          updateJumpButton();
        }
        const el = idx >= 0 ? lineEls[idx] : null;
        if (el && prefs.fill) {
          if (el.dataset.words) {
            paintWords(el, t);
          } else {
            const cur = lyrics.lines[idx];
            const nxt = lyrics.lines[idx + 1];
            const end = nxt ? nxt.time : cur.time + 4;
            paintProgress(el, Math.min(1, Math.max(0, (t - cur.time) / Math.max(end - cur.time, 0.5))));
          }
        }
      }
    } finally {
      if (!dead) requestAnimationFrame(tick);
    }
  }

  const SVG_PLAY = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  const SVG_PAUSE = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  const SVG_PREV = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 6h2v12H6zM18 6l-8.5 6L18 18z"/></svg>';
  const SVG_NEXT = '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M16 6h-2v12h2zM6 6l8.5 6L6 18z"/></svg>';
  const PREV_SELS = ['ytmusic-player-bar .previous-button', '.previous-button'];
  const NEXT_SELS = ['ytmusic-player-bar .next-button', '.next-button'];

  function buildFsUI() {
    if (fsWrap) return;
    fsWrap = document.createElement('div');
    fsWrap.id = 'ytml-fswrap';

    const side = document.createElement('div');
    side.id = 'ytml-fs-side';
    fsArtEl = document.createElement('img');
    fsArtEl.id = 'ytml-fs-art';
    fsArtEl.alt = '';
    fsArtEl.draggable = false;
    fsTitleEl = document.createElement('div');
    fsTitleEl.id = 'ytml-fs-title';
    fsArtistEl = document.createElement('div');
    fsArtistEl.id = 'ytml-fs-artist';
    fsAlbumEl = document.createElement('div');
    fsAlbumEl.id = 'ytml-fs-album';
    side.append(fsArtEl, fsTitleEl, fsArtistEl, fsAlbumEl);

    fsStage = document.createElement('div');
    fsStage.id = 'ytml-fs-stage';

    fsBarEl = document.createElement('div');
    fsBarEl.id = 'ytml-fs-bar';

    const mkBtn = (label, svg, cb) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ytml-fs-cbtn';
      b.innerHTML = svg;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', cb);
      return b;
    };
    const prev = mkBtn('Previous track', SVG_PREV, () => {
      if (!(playerSnap && bridgeCmd('previous'))) clickYtmButton(PREV_SELS);
    });
    fsPlayEl = mkBtn('Play / pause', SVG_PAUSE, () => {
      if (playerSnap) bridgeCmd('play-pause');
      else {
        const v = getVideo();
        if (v) v.paused ? v.play() : v.pause();
      }
    });
    fsPlayEl.id = 'ytml-fs-play';
    const next = mkBtn('Next track', SVG_NEXT, () => {
      if (!(playerSnap && bridgeCmd('next'))) clickYtmButton(NEXT_SELS);
    });

    fsCurEl = document.createElement('span');
    fsCurEl.className = 'ytml-fs-time';
    fsCurEl.textContent = '0:00';
    fsDurEl = document.createElement('span');
    fsDurEl.className = 'ytml-fs-time';
    fsDurEl.textContent = '0:00';

    const trackBox = document.createElement('div');
    trackBox.className = 'ytml-fs-trackbox';
    trackBox.setAttribute('role', 'slider');
    trackBox.setAttribute('aria-label', 'Seek');
    const rail = document.createElement('div');
    rail.className = 'ytml-fs-rail';
    fsFillEl = document.createElement('div');
    fsFillEl.id = 'ytml-fs-fill';
    rail.appendChild(fsFillEl);
    trackBox.appendChild(rail);

    const seekFromEvent = e => {
      const v = getVideo();
      if (!v || !isFinite(v.duration) || !v.duration) return;
      const r = rail.getBoundingClientRect();
      const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (playerSnap) bridgeCmd('seek', frac * v.duration);
      else v.currentTime = frac * v.duration;
    };
    trackBox.addEventListener('pointerdown', e => {
      e.preventDefault();
      trackBox.setPointerCapture(e.pointerId);
      seekFromEvent(e);
      const move = ev => seekFromEvent(ev);
      trackBox.addEventListener('pointermove', move);
      trackBox.addEventListener('pointerup', () => trackBox.removeEventListener('pointermove', move), { once: true });
      trackBox.addEventListener('pointercancel', () => trackBox.removeEventListener('pointermove', move), { once: true });
    });

    fsBarEl.append(prev, fsPlayEl, next, fsCurEl, trackBox, fsDurEl);
    fsStage.appendChild(fsBarEl);
    fsWrap.append(side, fsStage);
  }

  function updateFsMeta() {
    if (!fsWrap) return;
    const t = getTrack();
    if (!t) return;
    fsTitleEl.textContent = t.title;
    fsArtistEl.textContent = t.artist;
    const byline = firstSel(SEL.byline);
    const parts = byline ? byline.textContent.split('•').map(s => s.trim()).filter(Boolean) : [];
    const alb = t.album || (currentMeta && currentMeta.album) || '';
    const rest = parts.slice(1).filter(p => !alb || p !== alb);
    fsAlbumEl.textContent = [alb, ...rest].filter(Boolean).join(' · ') || parts.slice(1).join(' · ');
    const url = artworkUrl();
    if (url && fsArtEl.getAttribute('src') !== url) fsArtEl.src = url;
    applyTint();
  }

  function enterFullscreen() {
    if (!root || !lyrics || !lyrics.lines || !lyrics.lines.length) return;
    if (pipWin) {
      try { pipWin.close(); } catch { /* noop */ }
    }
    fullscreen = true;
    buildFsUI();
    root.classList.remove('ytml-anim');
    fsStage.insertBefore(root, fsBarEl);
    document.body.appendChild(fsWrap);
    document.body.classList.add('ytml-fs');
    updateFsMeta();
    placeControls();
    wakeCursor();
    if (dispSynced() && activeIdx >= 0) {
      requestAnimationFrame(() => scrollToActive(activeIdx, 'auto'));
    }
  }

  function wakeCursor() {
    document.body.classList.remove('ytml-idlecur');
    clearTimeout(cursorTimer);
    if (fullscreen) {
      cursorTimer = setTimeout(() => document.body.classList.add('ytml-idlecur'), 2600);
    }
  }

  let poll = null;
  let observer = null;

  function contextAlive() {
    try {
      return !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  function die() {
    dead = true;
    teardown();
    if (observer) observer.disconnect();
    if (poll) clearInterval(poll);
  }

  function schedule() {
    if (scheduled || dead) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      update();
    }, 250);
  }

  observer = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const t = m.target;
        if (IS_YTM && t && t.closest && t.closest('ytmusic-player-page')) return schedule();
        continue;
      }
      if (root && !root.isConnected && !fullscreen) return schedule();
      // On youtube.com the 800ms poll covers #secondary appearing; skip the
      // ancestor walk — YouTube's DOM churn makes it wasteful.
      if (!IS_YTM) continue;
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || n === root || n === jumpBtn || n === fsBtn || n === syncChip || n === toastEl) continue;
        if (n.closest && n.closest('ytmusic-player-page')) return schedule();
      }
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden', 'selected', 'iron-selected', 'aria-selected', 'class'],
  });

  document.addEventListener('click', e => {
    if (dead) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (!t.closest('ytmusic-player-page tp-yt-paper-tabs')) return;
    const header = t.closest('tp-yt-paper-tab, [role="tab"]');
    if (header && !isLyricsLabel(header)) {
      if (trackKey) userNavigated.add(trackKey);
      teardown();
      return;
    }
    if (header && header.dataset.ytmlForced === '1' && !isHeaderSelected(header)) {
      setTimeout(() => {
        if (!dead && !isHeaderSelected(header)) manualSelectLyrics(header);
      }, 300);
    }
    schedule();
  }, true);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && fullscreen) exitFullscreen();
  });

  document.addEventListener('mousemove', () => {
    if (fullscreen) wakeCursor();
  }, { passive: true });

  window.addEventListener('resize', () => {
    if (!root || !panel || fullscreen) return;
    const ph = panel.clientHeight;
    const vh = window.innerHeight;
    root.style.height = (panel === ytPanelEl
      ? Math.min(560, Math.max(300, Math.round(vh * 0.52)))
      : ph > 160 && ph < vh * 1.5 ? ph : Math.max(280, vh - 240)) + 'px';
  });

  loadOffsets();
  loadPrefs();
  poll = setInterval(update, POLL_MS);
  requestAnimationFrame(tick);
  update();
})();
