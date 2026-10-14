'use strict';

const LRCLIB = 'https://lrclib.net/api';
const LRCCX = 'https://api.lrc.cx/jsonapi';
const FETCH_TIMEOUT_MS = 9000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'fetchLyrics') {
    fetchLyrics(msg.track)
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }
  if (msg.type === 'searchLyrics') {
    searchLyrics(msg.track || {})
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, items: [] }));
    return true;
  }
  // Content scripts cannot fetch chrome-extension:// URLs (styles.css is not
  // web-accessible) — the PiP window gets its stylesheet through us instead.
  if (msg.type === 'pipCss') {
    fetch(chrome.runtime.getURL('styles.css'))
      .then(r => {
        if (!r.ok) throw new Error('styles.css ' + r.status);
        return r.text();
      })
      .then(css => sendResponse({ ok: true, css }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

// Returns { ok: true, data } on a completed lookup (data may be null =
// genuinely not found) or { ok: false, error } on a transient failure that
// should not be cached as "no lyrics".
async function fetchLyrics(track) {
  // Providers race; LRCLIB wins on any hit — resolve the moment it lands
  // instead of waiting out lrc.cx's leg. lrc.cx still runs (it is the only
  // fallback when LRCLIB misses), but a hit never waits for it.
  const xp = fromLRCCX(track).then(v => ({ v }), e => ({ e }));
  const l = await fromLRCLIB(track).then(v => ({ v }), e => ({ e }));
  if (l.v) return { ok: true, data: l.v };
  const x = await xp;
  if (x.v) return { ok: true, data: x.v };
  const sawError = !!l.e || !!x.e;
  return sawError ? { ok: false, error: 'fetch-failed' } : { ok: true, data: null };
}

async function fromLRCLIB(track) {
  // LRCLIB 400s on empty param values — only send what we actually have,
  // and never let a failed /get skip the broader /search.
  const getParams = new URLSearchParams();
  if (track.title) getParams.set('track_name', track.title);
  if (track.artist) getParams.set('artist_name', track.artist);
  if (track.album) getParams.set('album_name', track.album);
  if (track.duration) getParams.set('duration', String(Math.round(track.duration)));

  let getErr = null;
  const exact = getParams.has('track_name')
    ? await fetchJson(`${LRCLIB}/get?${getParams}`).catch(e => { getErr = e; return null; })
    : null;
  const parsed = exact && exact.notfound !== true ? lrclibToLyrics(exact) : null;
  if (parsed) return parsed;

  const searchParams = new URLSearchParams();
  if (track.title) searchParams.set('track_name', track.title);
  if (track.artist) searchParams.set('artist_name', track.artist);
  if (!searchParams.has('track_name')) return null;
  const list = await fetchJson(`${LRCLIB}/search?${searchParams}`);
  if (Array.isArray(list) && list.length) {
    return lrclibToLyrics(pickBestLrclib(list, track));
  }
  // /search came back empty but /get failed transiently — surface the error
  // so the caller retries instead of caching a false "not found".
  if (getErr) throw getErr;
  return null;
}

// A wrong-song match is worse than no lyrics: candidates must verify against
// the requested title and artist before duration/sync quality is even scored.
function pickBestLrclib(list, track) {
  const wantTitle = norm(track.title);
  const wantArtist = norm(track.artist);
  let best = null;
  let bestScore = Infinity;
  for (const item of list) {
    if (!item || (!item.syncedLyrics && !item.plainLyrics)) continue;
    if (!titleOk(wantTitle, norm(item.trackName))) continue;
    if (!artistOk(wantArtist, norm(item.artistName))) continue;
    let score = item.syncedLyrics ? 0 : 1000;
    if (typeof item.duration === 'number' && track.duration) {
      score += Math.abs(item.duration - track.duration);
    }
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function lrclibToLyrics(data) {
  if (!data) return null;
  if (data.instrumental) return { instrumental: true, synced: false, lines: [], source: 'lrclib' };
  if (data.syncedLyrics) {
    const lines = parseLrc(data.syncedLyrics);
    if (lines.length) return { synced: true, lines, source: 'lrclib' };
  }
  if (data.plainLyrics) {
    const lines = data.plainLyrics.split('\n').map(t => ({ text: t.trim() }));
    if (lines.some(l => l.text)) return { synced: false, lines, source: 'lrclib' };
  }
  return null;
}

// lrc.cx aggregates Apple Music catalogue data: entries can carry `lrc_ttml`
// (word-timed TTML) in addition to line-level `lrc`.
async function fromLRCCX(track) {
  const params = new URLSearchParams({ title: track.title || '' });
  if (track.artist) params.set('artist', track.artist);
  if (track.album) params.set('album', track.album);

  const list = await fetchJson(`${LRCCX}?${params}`);
  if (!Array.isArray(list) || !list.length) return null;
  return lrccxToLyrics(pickBestLrccx(list, track));
}

function lrccxToLyrics(item) {
  if (!item) return null;
  if (item.lrc_ttml) {
    const lines = parseTtml(item.lrc_ttml);
    if (lines.length) {
      return { synced: true, wordSync: lines.some(l => l.words), lines, source: 'lrccx' };
    }
  }
  if (item.lrc) {
    const lines = parseLrc(item.lrc);
    if (lines.length) return { synced: true, lines, source: 'lrccx' };
  }
  return null;
}

// Manual override search — user-pickable candidates, each carrying a
// ready-to-apply lyrics result. Fixes missed/wrong matches without settings.
async function searchLyrics(track) {
  const items = [];
  const rank = { karaoke: 0, synced: 1, plain: 2 };
  try {
    const q = track.title
      ? new URLSearchParams({ track_name: track.title, artist_name: track.artist || '' })
      : new URLSearchParams({ q: track.artist || '' });
    const list = await fetchJson(`${LRCLIB}/search?${q}`);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item || (!item.syncedLyrics && !item.plainLyrics)) continue;
        const res = lrclibToLyrics(item);
        if (!res) continue;
        items.push({
          title: item.trackName || '',
          artist: item.artistName || '',
          album: item.albumName || '',
          duration: typeof item.duration === 'number' ? item.duration : 0,
          kind: item.syncedLyrics ? 'synced' : 'plain',
          source: 'LRCLIB',
          res,
        });
      }
    }
  } catch { /* provider down */ }
  try {
    const q = new URLSearchParams({ title: track.title || '' });
    if (track.artist) q.set('artist', track.artist);
    const list = await fetchJson(`${LRCCX}?${q}`);
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item || (!item.lrc_ttml && !item.lrc)) continue;
        const res = lrccxToLyrics(item);
        if (!res) continue;
        items.push({
          title: item.title || '',
          artist: item.artist || '',
          album: item.album || '',
          duration: typeof item.duration === 'number' ? item.duration : 0,
          kind: res.wordSync ? 'karaoke' : 'synced',
          source: 'lrc.cx',
          res,
        });
      }
    }
  } catch { /* provider down */ }
  items.sort((a, b) => (rank[a.kind] || 3) - (rank[b.kind] || 3));
  return { ok: true, items: items.slice(0, 8) };
}

function pickBestLrccx(list, track) {
  const wantTitle = norm(track.title);
  const wantArtist = norm(track.artist);
  let best = null;
  let bestScore = Infinity;
  for (const item of list) {
    if (!item || (!item.lrc_ttml && !item.lrc)) continue;
    const title = norm(item.title);
    const artist = norm(item.artist);
    if (!titleOk(wantTitle, title)) continue;
    if (!artistOk(wantArtist, artist)) continue;
    let score = item.lrc_ttml ? 0 : 400;
    if (wantTitle && title !== wantTitle) score += 30;
    if (wantArtist && artist !== wantArtist) score += 20;
    if (typeof item.duration === 'number' && track.duration) {
      score += Math.min(Math.abs(item.duration - track.duration) * 4, 120);
    }
    if (typeof item.score === 'number') score -= Math.min(item.score, 100) * 0.1;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

function contained(shorter, longer, minLen) {
  return shorter.length >= minLen && longer.includes(shorter);
}

function titleOk(want, got) {
  if (!want) return true;
  if (!got) return false;
  if (want === got) return true;
  const [s, l] = want.length <= got.length ? [want, got] : [got, want];
  return contained(s, l, 6);
}

function artistOk(want, got) {
  if (!want) return true;
  if (!got) return false;
  if (want === got) return true;
  const [s, l] = want.length <= got.length ? [want, got] : [got, want];
  if (contained(s, l, 5)) return true;
  const stop = new Set(['the', 'feat', 'ft', 'and', 'with', 'x']);
  const gb = new Set(got.split(' '));
  return want.split(' ').some(t => t.length >= 3 && !stop.has(t) && gb.has(t));
}

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseLrc(lrc) {
  const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const wordRe = /<\d{1,2}:\d{1,2}[.:]\d{1,3}>/g;
  const out = [];
  for (const raw of lrc.split('\n')) {
    const matches = [...raw.matchAll(tagRe)];
    if (!matches.length) continue;
    const text = raw.replace(tagRe, '').replace(wordRe, '').trim();
    for (const m of matches) {
      const frac = m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0;
      out.push({ time: Number(m[1]) * 60 + Number(m[2]) + frac, text });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// Apple Music TTML: <p begin end> lines containing leaf <span begin end>word</span>
// tokens. Background-vocal lines carry ttm:agent="v2" on the <p>. No DOMParser
// in service workers, so this walks the markup with regexes; the format is
// machine-generated and regular enough for that.
function parseTtml(ttml) {
  const lines = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  const leafSpanRe = /<span\b([^>]*)>([^<]*)<\/span>/g;
  const attr = (s, name) => {
    const m = s.match(new RegExp(`${name}="([^"]*)"`));
    return m ? m[1] : '';
  };
  const unescape = s =>
    s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&amp;/g, '&');

  for (const pm of ttml.matchAll(pRe)) {
    const attrs = pm[1];
    const inner = pm[2];
    const lineBegin = ttmlTime(attr(attrs, 'begin'));
    const lineEnd = ttmlTime(attr(attrs, 'end'));
    if (lineBegin == null) continue;

    const words = [];
    let text = '';
    let last = 0;
    for (const sm of inner.matchAll(leafSpanRe)) {
      const wBegin = ttmlTime(attr(sm[1], 'begin'));
      const wEnd = ttmlTime(attr(sm[1], 'end'));
      const between = unescape(inner.slice(last, sm.index)).replace(/<[^>]*>/g, '');
      text += between;
      const wText = unescape(sm[2]);
      text += wText;
      last = sm.index + sm[0].length;
      if (wBegin != null && wText.trim()) {
        words.push({ time: wBegin, end: wEnd, text: wText });
      }
    }
    text += unescape(inner.slice(last)).replace(/<[^>]*>/g, '');
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;

    const line = { time: lineBegin, end: lineEnd, text };
    if (words.length > 1) line.words = words;
    if (attr(attrs, 'ttm:agent') === 'v2') line.bg = true;
    lines.push(line);
  }

  lines.sort((a, b) => a.time - b.time);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].end == null) lines[i].end = i + 1 < lines.length ? lines[i + 1].time : lines[i].time + 4;
  }
  return lines;
}

function ttmlTime(s) {
  if (!s) return null;
  const parts = s.split(':');
  const sec = parseFloat(parts[parts.length - 1]);
  if (!isFinite(sec)) return null;
  let t = sec;
  if (parts.length > 1) t += Number(parts[parts.length - 2]) * 60;
  if (parts.length > 2) t += Number(parts[parts.length - 3]) * 3600;
  return t;
}
