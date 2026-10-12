(() => {
  'use strict';

  document.documentElement.dataset.ytmlPlus = 'loaded';
  const ROOT_ID = 'ytml-plus-root';
  const HOST_CLASS = 'ytml-plus-host';
  const POLL_MS = 800;

  const LYRICS_LABELS = [
    'lyrics', 'şarkı sözleri', 'sarki sozleri', 'sözler', 'letras', 'letra',
    'paroles', 'testo', 'liedtext', 'текст', '歌詞', '가사', 'lirik',
    'songtekst', 'lời bài hát', 'dalszöveg', 'teksti', 'stihovi',
  ];

  let panel = null;
  let root = null;
  let trackKey = null;
  let appliedKey = null;
  let lyrics = null;
  let lineEls = [];
  let activeIdx = -1;
  let suppressUntil = 0;
  let jumpBtn = null;
  let jumpRaf = false;
  const cache = new Map();

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
    const titleEl = document.querySelector('ytmusic-player-bar .title');
    const domTitle = titleEl ? titleEl.textContent.trim() : '';
    const byline = document.querySelector('ytmusic-player-bar .byline');
    const domArtist = byline ? byline.textContent.split('•')[0].trim() : '';
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const title = domTitle || (md && md.title) || '';
    if (!title) return null;

    // During ads mediaSession carries ad metadata; the DOM player bar wins.
    const artist = domArtist || (md && md.artist) || '';
    const album = md && md.title === title ? md.album || '' : '';

    const timeInfo = document.querySelector('ytmusic-player-bar .time-info');
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
    const page = document.querySelector('ytmusic-player-page');
    if (!page) return null;
    return [...page.querySelectorAll('tp-yt-paper-tab, [role="tab"]')].find(isLyricsLabel) || null;
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
    const all = [...h.closest('tp-yt-paper-tabs').querySelectorAll('tp-yt-paper-tab, [role="tab"]')];
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
    const page = document.querySelector('ytmusic-player-page');
    if (!page) return null;

    const tabs = page.querySelector('tp-yt-paper-tabs');
    const headers = tabs
      ? [...tabs.querySelectorAll('tp-yt-paper-tab, [role="tab"]')]
      : [];
    const sel = headers.find(isHeaderSelected);

    if (sel && !isLyricsLabel(sel)) return null;
    if (!sel && !page.querySelector('ytmusic-description-shelf-renderer')) return null;

    const panel = page.querySelector('ytmusic-tab-renderer');
    return panel && panel.getClientRects().length ? panel : null;
  }

  function teardown() {
    if (root && root.isConnected) root.remove();
    if (jumpBtn && jumpBtn.isConnected) jumpBtn.remove();
    if (panel) panel.classList.remove(HOST_CLASS);
    panel = null;
    lyrics = null;
    lineEls = [];
    activeIdx = -1;
  }

  function attachRoot(measuredHeight) {
    root = document.getElementById(ROOT_ID) || document.createElement('div');
    root.id = ROOT_ID;
    if (!root.dataset.bound) {
      root.addEventListener('wheel', onUserScroll, { passive: true });
      root.addEventListener('touchmove', onUserScroll, { passive: true });
      root.addEventListener('mousedown', onUserScroll, { passive: true });
      root.addEventListener('scroll', onScroll, { passive: true });
      root.dataset.bound = '1';
    }
    panel.appendChild(root);
    ensureJumpButton();
    const vh = window.innerHeight;
    const h = measuredHeight > 160 && measuredHeight < vh * 1.5
      ? measuredHeight
      : Math.max(280, vh - 240);
    root.style.height = h + 'px';
    appliedKey = null;
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
      jumpBtn.addEventListener('click', () => {
        suppressUntil = 0;
        if (lyrics && lyrics.synced && activeIdx >= 0) scrollToActive(activeIdx);
      });
    }
    panel.appendChild(jumpBtn);
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
        el.style.setProperty('--i', Math.min(i, 30));
        el.textContent = line.text || '♪';
        if (lyrics.synced) {
          el.addEventListener('click', () => {
            const v = getVideo();
            if (v) v.currentTime = line.time + 0.02;
            suppressUntil = 0;
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
    } else {
      credit.textContent = lyrics.attribution || 'Source: YouTube Music';
    }
    root.appendChild(credit);
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
        setActive(binarySearch(res.lines, v.currentTime));
        scrollToActive(activeIdx, 'auto');
      }
    }
    updateJumpButton();
    applyTint();
  }

  function nativeFallback() {
    const page = document.querySelector('ytmusic-player-page');
    const shelf = page && page.querySelector('ytmusic-description-shelf-renderer');
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
      if (cached === undefined) renderStatus('Loading lyrics…');
    }

    if (cached === undefined) {
      cache.set(track.key, 'pending');
      let result = null;
      try {
        result = await chrome.runtime.sendMessage({ type: 'fetchLyrics', track });
      } catch {
        result = null;
      }
      const final = result || nativeFallback();
      cache.set(track.key, final || 'none');
      if (cache.size > 200) cache.clear();
      update();
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
    activeIdx = idx;
    lineEls.forEach((el, i) => {
      el.classList.remove('ytml-active', 'ytml-d1', 'ytml-d2', 'ytml-d3');
      el.classList.add(i === idx ? 'ytml-active' : `ytml-d${Math.min(Math.abs(i - idx), 3)}`);
    });
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
      if (root && root.isConnected && lyrics && lyrics.synced) {
        const v = getVideo();
        if (v) {
          const idx = binarySearch(lyrics.lines, v.currentTime);
          if (idx !== activeIdx) {
            setActive(idx);
            if (Date.now() >= suppressUntil) scrollToActive(idx);
            updateJumpButton();
          }
        }
      }
    } finally {
      if (!dead) requestAnimationFrame(tick);
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
      if (root && !root.isConnected) return schedule();
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1 || n === root || n === jumpBtn) continue;
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

  window.addEventListener('resize', () => {
    if (!root || !panel) return;
    const ph = panel.clientHeight;
    const vh = window.innerHeight;
    root.style.height = (ph > 160 && ph < vh * 1.5 ? ph : Math.max(280, vh - 240)) + 'px';
  });

  poll = setInterval(update, POLL_MS);
  requestAnimationFrame(tick);
  update();
})();
