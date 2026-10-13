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
  let toastTimer = null;
  let jumpRaf = false;
  let fullscreen = false;
  let cursorTimer = null;
  let currentOffset = 0;
  const cache = new Map(); // key -> lyrics obj | 'none' | 'pending'
  const fetchRetries = new Map(); // key -> count
  const retryAfter = new Map(); // key -> timestamp
  const offsets = new Map(); // key -> seconds
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
    if (d && d.videoId) playerSnap = d;
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
        // times, but only if the applied result belongs to the current track.
        if (appliedKey === trackKey && !segMapApplied && lastResult && lastResult.synced && d.meta.isVideo && d.meta.segMap && d.meta.segMap.length) {
          applyResult(lastResult);
        }
      }
      schedule();
    } else if (d.type === 'lyrics' && d.videoId) {
      sniffedLyrics.set(d.videoId, { text: d.text, source: d.source });
      // Native lyrics can land after providers already missed — upgrade the entry.
      if (d.text && playerSnap && playerSnap.videoId === d.videoId && trackKey && cache.get(trackKey) === 'none') {
        const ytm = ytmLyricsResult(d.text, d.source);
        if (ytm) {
          cache.set(trackKey, ytm);
          persistLyrics(trackKey, ytm);
          appliedKey = null;
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
    const preferred =
      document.querySelector('video.html5-main-video') ||
      document.querySelector('ytmusic-player video') ||
      document.querySelector('#movie_player video');
    if (preferred && preferred.duration > 0) return preferred;
    const vids = document.querySelectorAll('video');
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

    // Priority: player bar (ad-safe) > sniffed Innertube meta > mediaSession > player API.
    const title = domTitle || (meta && meta.title) || (md && md.title) || (snap && snap.title) || '';
    if (!title) return null;

    const artist = domArtist || (meta && meta.artist) || (md && md.artist) || (snap && snap.artist) || '';
    const album = (meta && meta.album) || (md && md.title === title ? md.album || '' : '');
    const videoId = snap && snap.videoId ? snap.videoId : null;

    const timeInfo = firstSel(SEL.timeInfo);
    const spans = timeInfo
      ? [...timeInfo.textContent.matchAll(/(?:\d+:)?\d{1,2}:\d{2}/g)].map(x => parseTime(x[0]))
      : [];
    let dur = spans.length ? spans[spans.length - 1] : 0;
    if (!dur) {
      const v = getVideo();
      dur = v && isFinite(v.duration) ? Math.round(v.duration) : 0;
    }
    if (!dur && meta && meta.durationMs) dur = Math.round(meta.durationMs / 1000);
    if (!dur && snap && snap.duration) dur = Math.round(snap.duration);
    if (!dur) return null;

    // videoId keys are stabler than title/artist/duration strings — and correct:
    // a song's offset/cache lives with the exact version that played.
    const key = videoId ? `v:${videoId}` : `${title}::${artist}::${dur}`;
    return { title, artist, album, duration: dur, key, videoId, meta };
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

      const close = document.createElement('button');
      close.id = 'ytml-ytclose';
      close.type = 'button';
      close.textContent = '×';
      close.title = 'Hide lyrics for this video';
      close.setAttribute('aria-label', 'Hide lyrics for this video');
      close.addEventListener('click', () => {
        if (trackKey) {
          ytDismissed.add(trackKey);
          ytForced.delete(trackKey);
        }
        teardown();
      });
      ytPanelEl.appendChild(close);
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
      panel.appendChild(root);
      placeControls();
      if (fsWrap) fsWrap.remove();
      if (lyrics && lyrics.synced && activeIdx >= 0) {
        requestAnimationFrame(() => scrollToActive(activeIdx, 'auto'));
      }
    } else {
      if (fsWrap) fsWrap.remove();
      if (root && root.isConnected) root.remove();
    }
  }

  function teardown() {
    exitFullscreen();
    if (root && root.isConnected) root.remove();
    if (jumpBtn && jumpBtn.isConnected) jumpBtn.remove();
    if (fsBtn && fsBtn.isConnected) fsBtn.remove();
    if (syncChip && syncChip.isConnected) syncChip.remove();
    if (toastEl && toastEl.isConnected) toastEl.remove();
    if (ytPanelEl && ytPanelEl.isConnected) ytPanelEl.remove();
    ytPanelEl = null;
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
    panel.appendChild(root);
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
    ensureJumpButton();
    ensureFsButton();
    ensureSyncChip();
    ensureToast();
  }

  function placeControls() {
    const parent = controlsParent();
    if (!parent) return;
    for (const el of [jumpBtn, fsBtn, syncChip, toastEl]) {
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
        if (lyrics && lyrics.synced && activeIdx >= 0) scrollToActive(activeIdx);
      });
    }
    controlsParent().appendChild(jumpBtn);
    updateJumpButton();
  }

  function updateJumpButton() {
    if (!jumpBtn) return;
    const el = root && root.isConnected && lyrics && lyrics.synced && activeIdx >= 0
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
      fsBtn.textContent = '⤢';
      fsBtn.setAttribute('aria-label', 'Toggle fullscreen lyrics');
      fsBtn.title = 'Fullscreen lyrics';
      fsBtn.addEventListener('click', () => (fullscreen ? exitFullscreen() : enterFullscreen()));
    }
    controlsParent().appendChild(fsBtn);
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

  function updateSyncChip() {
    if (!syncChip) return;
    const o = currentOffset;
    if (Math.abs(o) < 0.05) {
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
    lineEls = [];
    activeIdx = -1;
    lyrics.lines.forEach((line, i) => {
      const el = document.createElement('div');
      if (!line.text && !lyrics.synced) {
        el.className = 'ytml-gap';
      } else {
        el.className = 'ytml-line ' + (lyrics.synced ? 'ytml-d3' : 'ytml-static');
        if (line.bg) el.classList.add('ytml-bg');
        el.style.setProperty('--i', Math.min(i, 30));
        if (lyrics.synced && line.text) {
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
        if (lyrics.synced) {
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
    if (lyrics.synced) {
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
    if (res.synced) {
      const v = getVideo();
      if (v) {
        setActive(binarySearch(lyrics.lines, v.currentTime - currentOffset));
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
    if (!fsBtn) return;
    fsBtn.classList.toggle('ytml-visible', !!(lyrics && lyrics.lines && lyrics.lines.length));
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
        const data = res.data || nativeFallback() || null;
        const val = data || 'none';
        cache.set(track.key, val);
        persistLyrics(track.key, data);
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
    if (IS_YT && ytProbeKey !== track.key) {
      ytProbeKey = track.key;
      // Ask the MAIN-world sniffer for YTM's queue data — the counterpart
      // segmentMap corrects song-timed lyrics onto the music video's timeline.
      try {
        document.dispatchEvent(new CustomEvent('ytml-probe', { detail: { videoId: track.videoId } }));
      } catch { /* noop */ }
    }
    forceEnableLyricsTab();
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

    if (track.key !== trackKey) {
      trackKey = track.key;
      appliedKey = null;
      currentMeta = track.meta || null;
      lastResult = null;
      segMapApplied = false;
      wantLineAnim = true;
      currentOffset = offsetFor(track.key);
      updateSyncChip();
      if (fullscreen) updateFsMeta();
      if (cached === undefined) renderStatus('Loading lyrics…');
    }

    if (cached === undefined) {
      const readyAt = retryAfter.get(track.key) || 0;
      if (Date.now() >= readyAt) fetchTrack(track).then(() => !dead && update());
      return;
    }
    if (cached === 'pending') return;
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

  function scrollToActive(idx, behavior = 'smooth') {
    if (!root || idx < 0) return;
    const el = lineEls[idx];
    if (!el) return;
    const top = el.offsetTop - root.clientHeight / 2 + el.clientHeight / 2;
    root.scrollTo({ top: Math.max(0, top), behavior });
  }

  function tick() {
    try {
      const v = getVideo();
      if (fullscreen && v && fsFillEl) {
        fsFillEl.style.transform = `scaleX(${v.duration ? v.currentTime / v.duration : 0})`;
        fsCurEl.textContent = fmtTime(v.currentTime);
        fsDurEl.textContent = fmtTime(v.duration);
        if (v.paused !== fsPaused) {
          fsPaused = v.paused;
          fsPlayEl.innerHTML = v.paused ? SVG_PLAY : SVG_PAUSE;
        }
      }
      if (root && root.isConnected && lyrics && lyrics.synced && !document.hidden && v && !(IS_YT && playerSnap && playerSnap.ad)) {
        const t = v.currentTime - currentOffset;
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
    fullscreen = true;
    buildFsUI();
    root.classList.remove('ytml-anim');
    fsStage.insertBefore(root, fsBarEl);
    document.body.appendChild(fsWrap);
    document.body.classList.add('ytml-fs');
    updateFsMeta();
    placeControls();
    wakeCursor();
    if (lyrics.synced && activeIdx >= 0) {
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
