// YTM Lyrics+ — player bridge (MAIN world, document_end).
// Talks to YouTube Music's internal movie_player API instead of scraping the
// DOM: publishes playback snapshots as `ytml-player-snapshot` CustomEvents and
// executes seek/transport commands arriving as `ytml-cmd` events. The API
// surface (getVideoData/getPlayerResponse/seekTo) is stable across DOM changes.
(() => {
  'use strict';
  if (window.__ytmlBridge) return;
  window.__ytmlBridge = true;

  const SNAP_EVENT = 'ytml-player-snapshot';
  const CMD_EVENT = 'ytml-cmd';
  const VIDEO_EVENTS = [
    'loadedmetadata', 'durationchange', 'play', 'playing', 'pause',
    'waiting', 'seeking', 'seeked', 'ratechange', 'ended', 'emptied',
  ];

  let player = null;
  let video = null;

  function emit() {
    const p = player;
    if (!p || !p.isConnected) return;
    try {
      const d = p.getVideoData ? p.getVideoData() : null;
      const resp = p.getPlayerResponse ? p.getPlayerResponse() : null;
      const prog = p.getProgressState ? p.getProgressState() : null;
      const st = p.getPlayerStateObject ? p.getPlayerStateObject() : null;

      let duration = p.getDuration ? p.getDuration() : 0;
      if (prog && isFinite(prog.duration) && prog.duration > 0) duration = prog.duration;
      const metaLen = Number(resp && resp.videoDetails && resp.videoDetails.lengthSeconds);
      if (isFinite(metaLen) && metaLen > 0) duration = metaLen;

      const videoId = d && d.video_id;
      const title = d && d.title;
      if (!videoId || !title || !isFinite(duration) || duration <= 0) return;

      document.dispatchEvent(new CustomEvent(SNAP_EVENT, {
        detail: {
          videoId,
          title,
          artist: (d && d.author) || '',
          duration,
          currentTime: p.getCurrentTime ? p.getCurrentTime() : 0,
          playing: !!(st && st.isPlaying && !st.isBuffering && !st.isSeeking && !st.isUiSeeking),
          rate: video ? video.playbackRate : 1,
          t: Date.now(),
        },
      }));
    } catch {
      /* player mid-rebuild */
    }
  }

  function attachVideo() {
    const v = player && player.querySelector('video');
    if (v === video) return;
    if (video) for (const ev of VIDEO_EVENTS) video.removeEventListener(ev, emit);
    video = v;
    if (video) for (const ev of VIDEO_EVENTS) video.addEventListener(ev, emit);
  }

  function scan() {
    const p = document.getElementById('movie_player');
    if (p !== player) {
      if (player && typeof player.removeEventListener === 'function') {
        try { player.removeEventListener('onStateChange', emit); } catch { /* noop */ }
      }
      player = p;
      if (player && typeof player.addEventListener === 'function') {
        try { player.addEventListener('onStateChange', emit); } catch { /* noop */ }
      }
      attachVideo();
    }
    emit();
  }

  document.addEventListener(CMD_EVENT, e => {
    const p = player || document.getElementById('movie_player');
    if (!p) return;
    const d = (e && e.detail) || {};
    try {
      if (d.op === 'seek' && isFinite(d.t)) {
        if (p.seekTo) p.seekTo(d.t, true);
        if (p.playVideo) p.playVideo();
      } else if (d.op === 'previous' && p.previousVideo) {
        p.previousVideo();
      } else if (d.op === 'next' && p.nextVideo) {
        p.nextVideo();
      } else if (d.op === 'play-pause') {
        const st = p.getPlayerStateObject ? p.getPlayerStateObject() : null;
        if (st && st.isPlaying) {
          if (p.pauseVideo) p.pauseVideo();
          else if (video) video.pause();
        } else if (p.playVideo) p.playVideo();
        else if (video) video.play();
      }
    } catch {
      /* noop */
    }
  });

  scan();
  setInterval(scan, 1000);
})();
