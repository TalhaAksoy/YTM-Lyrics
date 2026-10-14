// YTM Lyrics+ — request sniffer (MAIN world, document_start).
// Wraps window.fetch to read YouTube Music's own Innertube /next and /browse
// responses, then re-dispatches digested song metadata and native lyrics to the
// content script as CustomEvents on `document`. Read-only: requests pass
// through untouched and failures degrade silently to DOM fallbacks.
(() => {
  'use strict';
  if (window.__ytmlSniffer) return;
  window.__ytmlSniffer = true;

  const EV_OUT = 'ytml-sniffed';
  const EV_REPLAY = 'ytml-sniff-replay';

  const metaByVideo = new Map(); // videoId -> meta object
  const lyricsByVideo = new Map(); // videoId -> {text, source}
  const browseToVideo = new Map(); // lyrics browseId -> videoId
  let lastNextVideoId = null;

  const capMap = (m, max) => {
    while (m.size > max) m.delete(m.keys().next().value);
  };

  const textOf = node => (((node && node.runs) || []).map(r => r.text).join('')).trim();

  // Playlist-panel bylines link the artist(s) and mark the album run with a
  // MUSIC_PAGE_TYPE_ALBUM browse endpoint. Unlinked rows (Topic uploads) fall
  // back to "everything before the first bullet".
  function bylineInfo(longByline) {
    const rs = (longByline && longByline.runs) || [];
    const artists = [];
    let album = '';
    for (const r of rs) {
      const b = r.navigationEndpoint && r.navigationEndpoint.browseEndpoint;
      const pt =
        b &&
        b.browseEndpointContextSupportedConfigs &&
        b.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig &&
        b.browseEndpointContextSupportedConfigs.browseEndpointContextMusicConfig.pageType;
      if (pt === 'MUSIC_PAGE_TYPE_ALBUM') album = r.text;
      else if (b) artists.push(r.text);
    }
    if (!artists.length) {
      const cut = rs.findIndex(r => (r.text || '').trim() === '•');
      return [(cut === -1 ? rs : rs.slice(0, cut)).map(r => r.text).join('').trim(), album];
    }
    return [artists.join(', '), album];
  }

  function durationMs(lengthText) {
    const s = textOf(lengthText);
    if (!s) return 0;
    const p = s.split(':').map(Number);
    return p.some(isNaN) ? 0 : p.reduce((a, b) => a * 60 + b, 0) * 1000;
  }

  function emit(type, payload) {
    try {
      document.dispatchEvent(new CustomEvent(EV_OUT, { detail: Object.assign({ type }, payload) }));
    } catch {
      /* detail must stay JSON-serializable */
    }
  }

  function metaFromRenderer(r) {
    const [artist, album] = bylineInfo(r.longBylineText);
    const thumbs = (r.thumbnail && r.thumbnail.thumbnails) || [];
    const big = thumbs[thumbs.length - 1] || null;
    return {
      id: r.videoId,
      title: textOf(r.title),
      artist,
      album,
      // square artwork = song upload; 16:9 = music video
      isVideo: !!(big && big.width && big.height && big.width !== big.height),
      durationMs: durationMs(r.lengthText),
      art: big ? big.url : '',
      counterpartId: null,
      segMap: null,
    };
  }

  function putMeta(m) {
    if (!m || !m.id) return;
    // Partial updates (e.g. an album-only payload) must not clobber earlier
    // fields with empty strings.
    const clean = {};
    for (const k of Object.keys(m)) if (m[k] !== '' && m[k] !== undefined) clean[k] = m[k];
    const merged = Object.assign({}, metaByVideo.get(m.id), clean);
    metaByVideo.set(m.id, merged);
    capMap(metaByVideo, 400);
    emit('meta', { meta: merged });
  }

  function handleNext(reqJson, resJson) {
    const tabs =
      resJson &&
      resJson.contents &&
      resJson.contents.singleColumnMusicWatchNextResultsRenderer &&
      resJson.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer &&
      resJson.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer &&
      resJson.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs;

    const videoId =
      (reqJson && reqJson.videoId) ||
      (resJson && resJson.currentVideoEndpoint && resJson.currentVideoEndpoint.watchEndpoint && resJson.currentVideoEndpoint.watchEndpoint.videoId) ||
      null;
    if (videoId) lastNextVideoId = videoId;

    // The Lyrics tab carries a browseEndpoint whose response holds the lyrics
    // text; "unselectable" means YouTube Music has none for this song.
    let lyrTab = tabs && tabs[1] && tabs[1].tabRenderer;
    const titled = tr => tr && tr.title && /lyrics|sözler|sözleri|letras|paroles/i.test(textOf(tr.title));
    if (!(lyrTab && lyrTab.endpoint && lyrTab.endpoint.browseEndpoint)) {
      const cand = ((tabs || []).map(t => t && t.tabRenderer)).find(
        tr => tr && titled(tr) && tr.endpoint && tr.endpoint.browseEndpoint
      );
      if (cand) lyrTab = cand;
    }
    if (lyrTab && videoId) {
      const bid = lyrTab.endpoint && lyrTab.endpoint.browseEndpoint && lyrTab.endpoint.browseEndpoint.browseId;
      if (bid) {
        browseToVideo.set(bid, videoId);
        capMap(browseToVideo, 64);
      }
      if (lyrTab.unselectable) {
        lyricsByVideo.set(videoId, { text: null, source: null });
        emit('lyrics', { videoId, text: null, source: null });
      }
    }

    // Album for the now-playing song also rides in the player overlay.
    const albumRun =
      resJson &&
      resJson.playerOverlays &&
      resJson.playerOverlays.playerOverlayRenderer &&
      resJson.playerOverlays.playerOverlayRenderer.browserMediaSession &&
      resJson.playerOverlays.playerOverlayRenderer.browserMediaSession.browserMediaSessionRenderer &&
      resJson.playerOverlays.playerOverlayRenderer.browserMediaSession.browserMediaSessionRenderer.album;
    if (videoId && albumRun) {
      putMeta({ id: videoId, album: textOf(albumRun) });
    }

    // Queue panel: authoritative per-video title/artist/album/duration plus
    // song<->video counterparts and their segment maps (intro/outro timing).
    const contents =
      (tabs &&
        tabs[0] &&
        tabs[0].tabRenderer &&
        tabs[0].tabRenderer.content &&
        tabs[0].tabRenderer.content.musicQueueRenderer &&
        tabs[0].tabRenderer.content.musicQueueRenderer.content &&
        tabs[0].tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer &&
        tabs[0].tabRenderer.content.musicQueueRenderer.content.playlistPanelRenderer.contents) ||
      (resJson && resJson.continuationContents && resJson.continuationContents.playlistPanelContinuation &&
        resJson.continuationContents.playlistPanelContinuation.contents) ||
      (resJson && resJson.onResponseReceivedEndpoints && resJson.onResponseReceivedEndpoints[0] &&
        resJson.onResponseReceivedEndpoints[0].queueUpdateCommand &&
        resJson.onResponseReceivedEndpoints[0].queueUpdateCommand.inlineContents &&
        resJson.onResponseReceivedEndpoints[0].queueUpdateCommand.inlineContents.playlistPanelRenderer &&
        resJson.onResponseReceivedEndpoints[0].queueUpdateCommand.inlineContents.playlistPanelRenderer.contents) ||
      findPanelContents(resJson, 0) ||
      [];

    for (const c of contents) {
      try {
        const wrap = c.playlistPanelVideoWrapperRenderer;
        const prim =
          c.playlistPanelVideoRenderer ||
          (wrap && wrap.primaryRenderer && wrap.primaryRenderer.playlistPanelVideoRenderer);
        if (!prim || !prim.videoId) continue;
        const counter = wrap && wrap.counterpart && wrap.counterpart[0];
        const cprim = counter && counter.counterpartRenderer && counter.counterpartRenderer.playlistPanelVideoRenderer;
        const meta = metaFromRenderer(prim);
        const cmeta = cprim ? metaFromRenderer(cprim) : null;
        const segs = counter && counter.segmentMap && counter.segmentMap.segment;
        if (segs && segs.length) {
          // segmentMap maps counterpart-time -> primary-time for this video.
          meta.segMap = segs
            .map(s => ({
              p: Number(s.primaryVideoStartTimeMilliseconds) / 1000,
              c: Number(s.counterpartVideoStartTimeMilliseconds) / 1000,
              d: Number(s.durationMilliseconds) / 1000,
            }))
            .filter(s => isFinite(s.p) && isFinite(s.c) && isFinite(s.d) && s.d > 0);
          if (cmeta) {
            meta.counterpartId = cmeta.id;
            cmeta.counterpartId = meta.id;
            // reversed: primary-time -> counterpart-time
            cmeta.segMap = meta.segMap.map(s => ({ p: s.c, c: s.p, d: s.d }));
          }
        }
        putMeta(meta);
        if (cmeta) putMeta(cmeta);
      } catch {
        /* malformed panel entry */
      }
    }
  }

  // youtube.com /next for WEB_REMIX and music/get_queue responses place the
  // queue panel at different paths — locate it by shape instead of position.
  function findPanelContents(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 12) return null;
    if (obj.playlistPanelRenderer && Array.isArray(obj.playlistPanelRenderer.contents)) {
      return obj.playlistPanelRenderer.contents;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        const found = findPanelContents(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  // ---- youtube.com: YTM-queue probe for the counterpart segmentMap ----
  // youtube.com's own /next never carries playlistPanel counterparts — those
  // only exist in YTM (WEB_REMIX) responses. A same-origin fetch from page JS
  // needs no extra permissions; cookies ride along. Fed through handleNext,
  // the same parser path as intercepted responses.
  // videoId -> { tries, at } — a failed probe used to be dropped forever, so
  // one transient error meant no segMap for the whole session. Retry a few
  // times, spaced out, then stop.
  const probed = new Map();
  async function probeQueue(videoId) {
    if (!videoId) return;
    const prev = probed.get(videoId);
    if (prev && (prev.tries >= 3 || Date.now() - prev.at < 15000)) return;
    probed.set(videoId, { tries: (prev ? prev.tries : 0) + 1, at: Date.now() });
    if (probed.size > 64) probed.delete(probed.keys().next().value);
    let ctxClient = null;
    try {
      const ctx = window.ytcfg && window.ytcfg.get && window.ytcfg.get('INNERTUBE_CONTEXT');
      ctxClient = ctx && ctx.client;
    } catch {
      /* ytcfg missing — bare client still works */
    }
    const client = Object.assign({}, ctxClient, {
      clientName: 'WEB_REMIX',
      clientVersion: '1.20251008.01.00',
    });
    const post = async (path, body) => {
      try {
        const r = await origFetch(path, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Innertube routes on these headers more than on context.client
            'X-YouTube-Client-Name': '67', // WEB_REMIX
            'X-YouTube-Client-Version': client.clientVersion,
          },
          credentials: 'include',
          body: JSON.stringify(Object.assign({ context: { client } }, body)),
        });
        if (!r.ok) {
          emit('probe', { videoId, path, status: r.status });
          return null;
        }
        return await r.json();
      } catch (e) {
        emit('probe', { videoId, path, err: String((e && e.message) || e) });
        return null;
      }
    };

    const next = await post('/youtubei/v1/next?prettyPrint=false', {
      videoId,
      isAudioOnly: false,
      // Mirrors what YTM actually sends on a music-video watch — the
      // persistent-panel flags are what make the backend wrap queue
      // entries with song<->video counterparts and their segmentMap.
      enablePersistentPlaylistPanel: true,
      tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
      watchEndpointMusicSupportedConfigs: {
        watchEndpointMusicConfig: {
          hasPersistentPlaylistPanel: true,
          musicVideoType: 'MUSIC_VIDEO_TYPE_OMV',
        },
      },
    });
    if (next) handleNext({ videoId }, next);
    const got = metaByVideo.get(videoId);
    emit('probe', { videoId, path: 'next', status: next ? 200 : 0, segMap: got && got.segMap ? got.segMap.length : 0 });
    // Note: youtube.com /next strips counterpart segmentMaps regardless of
    // request params — queue metadata above is still useful for lookups.
  }

  document.addEventListener('ytml-probe', e => {
    const id = e && e.detail && e.detail.videoId;
    if (id) probeQueue(id);
  });

  // ---- youtube.com: "Music in this video" structured rows ----
  // Engagement panels carry Song/Artist/Album rows for official music uploads.
  // We walk the response for infoRowRenderer objects and match known labels.
  const MUSIC_LABELS = {
    // ASCII-folded labels (NFD + strip marks, lowercase) so locale variants
    // like "ŞARKI"→"sarki" and "SANATÇI"→"sanatci" all match.
    song: new Set(['song', 'sarki', 'cancion', 'chanson', 'lied', 'musica', 'cancao', '曲', '곡']),
    artist: new Set(['artist', 'sanatci', 'artista', 'artiste', 'kunstler', 'cantante', 'アーティスト', '아티스트']),
    album: new Set(['album', 'アルバム', '앨범']),
  };
  const fold = s => (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

  function collectInfoRows(obj, out) {
    if (!obj || typeof obj !== 'object' || out.length > 24) return;
    if (obj.infoRowRenderer && obj.infoRowRenderer.title) out.push(obj.infoRowRenderer);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        if (Array.isArray(v)) for (const it of v) collectInfoRows(it, out);
        else collectInfoRows(v, out);
      }
    }
  }

  function handleWatchNext(reqJson, resJson) {
    const videoId =
      (reqJson && reqJson.videoId) ||
      (resJson && resJson.currentVideoEndpoint && resJson.currentVideoEndpoint.watchEndpoint && resJson.currentVideoEndpoint.watchEndpoint.videoId) ||
      null;
    if (!videoId) return;
    lastNextVideoId = videoId;

    const rows = [];
    collectInfoRows(resJson, rows);
    const music = {};
    for (const row of rows) {
      const label = fold(textOf(row.title));
      const value = textOf(row.defaultMetadata) || textOf(row.expandedMetadata) || '';
      if (!value) continue;
      if (MUSIC_LABELS.song.has(label) && !music.song) music.song = value;
      else if (MUSIC_LABELS.artist.has(label) && !music.artist) music.artist = value;
      else if (MUSIC_LABELS.album.has(label) && !music.album) music.album = value;
    }
    const mvt = resJson && resJson.playerResponse && resJson.playerResponse.videoDetails && resJson.playerResponse.videoDetails.musicVideoType;
    if (music.song || music.artist || music.album || mvt) {
      const payload = { id: videoId };
      if (music.song || music.artist || music.album) payload.music = music;
      if (mvt) payload.mvType = mvt;
      putMeta(payload);
    }
  }

  // Fresh page loads on youtube.com embed everything in ytInitialData /
  // ytInitialPlayerResponse — /next is only fetched on SPA navigations.
  // Poll briefly for the globals, then run the same info-row scan.
  function watchInitial() {
    if (location.hostname !== 'www.youtube.com') return;
    let tries = 0;
    const t = setInterval(() => {
      const ipr = window.ytInitialPlayerResponse;
      const idata = window.ytInitialData;
      tries++;
      // Music rows live in ytInitialData; wait for it, but accept the player
      // response alone after ~6s (ytCategory still helps classification).
      if (!idata && !(ipr && tries > 15)) {
        if (tries > 50) clearInterval(t);
        return;
      }
      clearInterval(t);
      try {
        const videoId =
          (ipr && ipr.videoDetails && ipr.videoDetails.videoId) ||
          new URLSearchParams(location.search).get('v');
        if (!videoId) return;
        lastNextVideoId = videoId;
        const micro = ipr && ipr.microformat && ipr.microformat.playerMicroformatRenderer;
        const music = {};
        const rows = [];
        if (idata) collectInfoRows(idata, rows);
        for (const row of rows) {
          const label = fold(textOf(row.title));
          const value = textOf(row.defaultMetadata) || textOf(row.expandedMetadata) || '';
          if (!value) continue;
          if (MUSIC_LABELS.song.has(label) && !music.song) music.song = value;
          else if (MUSIC_LABELS.artist.has(label) && !music.artist) music.artist = value;
          else if (MUSIC_LABELS.album.has(label) && !music.album) music.album = value;
        }
        const payload = { id: videoId };
        if (music.song || music.artist || music.album) payload.music = music;
        if (micro && micro.category) payload.ytCategory = micro.category;
        const mvt = ipr && ipr.videoDetails && ipr.videoDetails.musicVideoType;
        if (mvt) payload.mvType = mvt;
        if (payload.music || payload.ytCategory || payload.mvType) putMeta(payload);
      } catch {
        /* initial data shape changed */
      }
    }, 400);
  }
  watchInitial();

  function handleBrowse(reqJson, resJson) {
    const bid = reqJson && reqJson.browseId;
    // Usually the /next response mapped browseId -> videoId already. If we
    // missed it (page loaded before injection), attribute to the last /next
    // video — the only browse response we parse is the lyrics shelf anyway.
    const videoId = (bid && browseToVideo.get(bid)) || lastNextVideoId;
    if (!videoId) return;
    const shelf =
      resJson &&
      resJson.contents &&
      resJson.contents.sectionListRenderer &&
      resJson.contents.sectionListRenderer.contents &&
      resJson.contents.sectionListRenderer.contents[0] &&
      resJson.contents.sectionListRenderer.contents[0].musicDescriptionShelfRenderer;
    if (!shelf) return;
    const info = { text: textOf(shelf.description) || null, source: textOf(shelf.footer) || null };
    if (info.text) {
      lyricsByVideo.set(videoId, info);
      emit('lyrics', { videoId, text: info.text, source: info.source });
    }
  }

  const origFetch = window.fetch;
  const ORIGINS = new Set(['music.youtube.com', 'www.youtube.com']);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    let path = '';
    try {
      const u = new URL(url);
      if (!ORIGINS.has(u.host)) return origFetch.call(this, input, init);
      path = u.pathname;
    } catch {
      return origFetch.call(this, input, init);
    }
    const isNext = path.startsWith('/youtubei/v1/next');
    const isBrowse = path.startsWith('/youtubei/v1/browse');
    if (!isNext && !isBrowse) return origFetch.call(this, input, init);

    const res = await origFetch.call(this, input, init);
    try {
      const resClone = res.clone();
      const reqJsonP = (async () => {
        try {
          const body = typeof input === 'string' ? (init && init.body) : await input.clone().text();
          return typeof body === 'string' ? JSON.parse(body) : {};
        } catch {
          return {};
        }
      })();
      Promise.all([reqJsonP, resClone.text()])
        .then(([reqJson, text]) => {
          let resJson;
          try {
            resJson = JSON.parse(text);
          } catch {
            return;
          }
          try {
            if (isNext) {
              handleNext(reqJson, resJson); // YTM queue/lyrics-tab data
              handleWatchNext(reqJson, resJson); // youtube.com music metadata
            } else handleBrowse(reqJson, resJson);
          } catch {
            /* response shape changed — stay silent */
          }
        })
        .catch(() => {});
    } catch {
      /* never break the page's request */
    }
    return res;
  };

  // The isolated content script injects later (document_idle) and asks for a
  // replay of everything captured before its listeners were attached.
  document.addEventListener(EV_REPLAY, () => {
    for (const meta of metaByVideo.values()) emit('meta', { meta });
    for (const [videoId, info] of lyricsByVideo) emit('lyrics', { videoId, text: info.text, source: info.source });
  });
})();
