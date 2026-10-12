'use strict';

const LRCLIB = 'https://lrclib.net/api';
const LRCCX = 'https://api.lrc.cx/jsonapi';
const FETCH_TIMEOUT_MS = 9000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'fetchLyrics') return false;
  fetchLyrics(msg.track)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, error: 'internal' }));
  return true;
});

// Returns { ok: true, data } on a completed lookup (data may be null =
// genuinely not found) or { ok: false, error } on a transient failure that
// should not be cached as "no lyrics".
async function fetchLyrics(track) {
  let sawError = false;

  try {
    const fromLrclib = await fromLRCLIB(track);
    if (fromLrclib) return { ok: true, data: fromLrclib };
  } catch {
    sawError = true;
  }

  try {
    const fromLrccx = await fromLRCCX(track);
    if (fromLrccx) return { ok: true, data: fromLrccx };
  } catch {
    sawError = true;
  }

  return sawError ? { ok: false, error: 'fetch-failed' } : { ok: true, data: null };
}

async function fromLRCLIB(track) {
  const getParams = new URLSearchParams({
    track_name: track.title || '',
    artist_name: track.artist || '',
  });
  if (track.album) getParams.set('album_name', track.album);
  if (track.duration) getParams.set('duration', String(track.duration));

  const exact = await fetchJson(`${LRCLIB}/get?${getParams}`);
  const parsed = exact && exact.notfound !== true ? lrclibToLyrics(exact) : null;
  if (parsed) return parsed;

  const searchParams = new URLSearchParams({
    track_name: track.title || '',
    artist_name: track.artist || '',
  });
  const list = await fetchJson(`${LRCLIB}/search?${searchParams}`);
  if (Array.isArray(list) && list.length) {
    return lrclibToLyrics(pickBestLrclib(list, track.duration));
  }
  return null;
}

function pickBestLrclib(list, duration) {
  let best = null;
  let bestScore = Infinity;
  for (const item of list) {
    if (!item || (!item.syncedLyrics && !item.plainLyrics)) continue;
    let score = item.syncedLyrics ? 0 : 1000;
    if (typeof item.duration === 'number' && duration) {
      score += Math.abs(item.duration - duration);
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
  const best = pickBestLrccx(list, track);
  if (!best) return null;

  if (best.lrc_ttml) {
    const lines = parseTtml(best.lrc_ttml);
    if (lines.length) {
      return { synced: true, wordSync: lines.some(l => l.words), lines, source: 'lrccx' };
    }
  }
  if (best.lrc) {
    const lines = parseLrc(best.lrc);
    if (lines.length) return { synced: true, lines, source: 'lrccx' };
  }
  return null;
}

function pickBestLrccx(list, track) {
  const wantTitle = norm(track.title);
  const wantArtist = norm(track.artist);
  let best = null;
  let bestScore = Infinity;
  for (const item of list) {
    if (!item || (!item.lrc_ttml && !item.lrc)) continue;
    let score = item.lrc_ttml ? 0 : 400;
    const title = norm(item.title);
    const artist = norm(item.artist);
    if (wantTitle && title !== wantTitle) score += title.includes(wantTitle) || wantTitle.includes(title) ? 30 : 80;
    if (wantArtist && !(artist.includes(wantArtist) || wantArtist.includes(artist))) score += 50;
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
