'use strict';

const LRCLIB = 'https://lrclib.net/api';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'fetchLyrics') return false;
  fetchLyrics(msg.track)
    .then(sendResponse)
    .catch(() => sendResponse(null));
  return true;
});

async function fetchLyrics(track) {
  const getParams = new URLSearchParams({
    track_name: track.title || '',
    artist_name: track.artist || '',
  });
  if (track.album) getParams.set('album_name', track.album);
  if (track.duration) getParams.set('duration', String(track.duration));

  const exact = await fetchJson(`${LRCLIB}/get?${getParams}`);
  const parsed = toLyrics(exact);
  if (parsed) return parsed;

  const searchParams = new URLSearchParams({
    track_name: track.title || '',
    artist_name: track.artist || '',
  });
  const list = await fetchJson(`${LRCLIB}/search?${searchParams}`);
  if (Array.isArray(list) && list.length) {
    return toLyrics(pickBest(list, track.duration));
  }
  return null;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function pickBest(list, duration) {
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

function toLyrics(data) {
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
