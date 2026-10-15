'use strict';

// Cross-browser API surface: Firefox exposes `browser` (always Promise),
// Chrome MV3 exposes `chrome` with Promise support — pick whichever exists.
const browserAPI = globalThis.browser || globalThis.chrome;

const DEFAULTS = { fill: false, autoOpen: true, yt: true };
const KEY = 'ytmlPrefs';

const fillEl = document.getElementById('fill');
const autoOpenEl = document.getElementById('autoOpen');
const ytEl = document.getElementById('yt');
const verEl = document.getElementById('ver');

verEl.textContent = 'v' + browserAPI.runtime.getManifest().version;

browserAPI.storage.local.get(KEY).then(res => {
  const prefs = Object.assign({}, DEFAULTS, res[KEY]);
  fillEl.checked = !!prefs.fill;
  autoOpenEl.checked = !!prefs.autoOpen;
  ytEl.checked = !!prefs.yt;
});

function save() {
  browserAPI.storage.local.set({
    [KEY]: { fill: fillEl.checked, autoOpen: autoOpenEl.checked, yt: ytEl.checked },
  });
}

fillEl.addEventListener('change', save);
autoOpenEl.addEventListener('change', save);
ytEl.addEventListener('change', save);
