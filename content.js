(() => {
  'use strict';

  document.documentElement.dataset.ytmlPlus = 'loaded';
  const ROOT_ID = 'ytml-plus-root';
  const HOST_CLASS = 'ytml-plus-host';
  const POLL_MS = 800;

  const STORE_LYRICS = 'ytmlCache'; // {key: {data, ts}}
  const STORE_OFFSETS = 'ytmlOffsets'; // {key: seconds}
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
  let lyrics = null;
  let lineEls = [];
  let activeIdx = -1;
  let suppressUntil = 0;
  let jumpBtn = null;
  let fsBtn = null;
  let syncChip = null;
  let toastEl = null;
  let toastTimer = null;
  let jumpRaf = false;
  let fullscreen = false;
  let cursorTimer = null;
  let currentOffset = 0;
  const cache = new Map(); // key -> lyrics obj | 'none' | 'pending'
  const fetchRetries = new Map(); // key -> count
  const retryAfter = new Map(); // key -> timestamp
  const offsets = new Map(); // key -> seconds
  const autoOpened = new Set();
  const userNavigated = new Set();
  let storageMiss = new Set(); // keys known absent in storage

  const dbg = (...a) => {
    try {
      if (window.__ytmlDebug) console.debug('[ytml+]', ...a);
    } catch { /* noop */ }
  };

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

  function getTrack() {
    const titleEl = firstSel(SEL.title);
    const domTitle = titleEl ? titleEl.textContent.trim() : '';
    const byline = firstSel(SEL.byline);
    const domArtist = byline ? byline.textContent.split('•')[0].trim() : '';
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const title = domTitle || (md && md.title) || '';
    if (!title) return null;

    // During ads mediaSession carries ad metadata; the DOM player bar wins.
    const artist = domArtist || (md && md.artist) || '';
    const album = md && md.title === title ? md.album || '' : '';

    const timeInfo = firstSel(SEL.timeInfo);
    const spans = timeInfo
      ? [...timeInfo.textContent.matchAll(/(?:\d+:)?\d{1,2}:\d{2}/g)].map(x => parseTime(x[0]))
      : [];
    let dur = spans.length ? spans[spans.length - 1] : 0;
    if (!dur) {
      const v = getVideo();
      dur = v && isFinite(v.duration) ? Math.round(v.duration) : 0;
    }
    if (!dur) return null;

    return { title, artist, album, duration: dur, key: `${title}::${artist}::${dur}` };
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

  function findPanel() {
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
    if (panel && panel.isConnected && root) {
      panel.appendChild(root);
      placeControls();
      if (lyrics && lyrics.synced && activeIdx >= 0) {
        requestAnimationFrame(() => scrollToActive(activeIdx, 'auto'));
      }
    } else if (root && root.isConnected) {
      root.remove();
    }
  }

  function teardown() {
    exitFullscreen();
    if (root && root.isConnected) root.remove();
    if (jumpBtn && jumpBtn.isConnected) jumpBtn.remove();
    if (fsBtn && fsBtn.isConnected) fsBtn.remove();
    if (syncChip && syncChip.isConnected) syncChip.remove();
    if (toastEl && toastEl.isConnected) toastEl.remove();
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
    const h = measuredHeight > 160 && measuredHeight < vh * 1.5
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
      teardown();
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
            const v = getVideo();
            if (v) v.currentTime = line.time + currentOffset + 0.02;
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
    if (!AUTOOPEN_ONCE || autoOpened.has(key) || userNavigated.has(key)) return;
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
    lyrics = res;
    renderLines();
    if (res.synced) {
      const v = getVideo();
      if (v) {
        setActive(binarySearch(res.lines, v.currentTime - currentOffset));
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
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    const thumb = document.querySelector('ytmusic-player-bar img');
    const url = art || (thumb ? thumb.src : '');
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
        if (root && root.isConnected) {
          root.style.setProperty(
            '--ytml-tint',
            `rgba(${(r / n) | 0}, ${(g / n) | 0}, ${(b / n) | 0}, 0.22)`
          );
        }
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
    const track = getTrack();
    if (!track) return;
    forceEnableLyricsTab();
    const cached = cache.get(track.key);
    if (cached === 'none') {
      if (forcedLyricsSelected() && ensureUI()) renderStatus('No lyrics found for this song');
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
      currentOffset = offsetFor(track.key);
      updateSyncChip();
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
      if (root && root.isConnected && lyrics && lyrics.synced && !document.hidden) {
        const v = getVideo();
        if (v) {
          const t = v.currentTime - currentOffset;
          const idx = binarySearch(lyrics.lines, t);
          if (idx !== activeIdx) {
            setActive(idx);
            if (Date.now() >= suppressUntil) scrollToActive(idx);
            updateJumpButton();
          }
          const el = idx >= 0 ? lineEls[idx] : null;
          if (el) {
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
      }
    } finally {
      if (!dead) requestAnimationFrame(tick);
    }
  }

  function enterFullscreen() {
    if (!root || !lyrics || !lyrics.lines || !lyrics.lines.length) return;
    fullscreen = true;
    document.body.classList.add('ytml-fs');
    document.body.appendChild(root);
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

  let dead = false;
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

  let scheduled = false;
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
        if (t && t.closest && t.closest('ytmusic-player-page')) return schedule();
        continue;
      }
      if (root && !root.isConnected && !fullscreen) return schedule();
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
    root.style.height = (ph > 160 && ph < vh * 1.5 ? ph : Math.max(280, vh - 240)) + 'px';
  });

  loadOffsets();
  poll = setInterval(update, POLL_MS);
  requestAnimationFrame(tick);
  update();
})();
