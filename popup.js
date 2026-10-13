'use strict';

const DEFAULTS = { fill: false, autoOpen: true };
const KEY = 'ytmlPrefs';

const fillEl = document.getElementById('fill');
const autoOpenEl = document.getElementById('autoOpen');
const verEl = document.getElementById('ver');

verEl.textContent = 'v' + chrome.runtime.getManifest().version;

chrome.storage.local.get(KEY).then(res => {
  const prefs = Object.assign({}, DEFAULTS, res[KEY]);
  fillEl.checked = !!prefs.fill;
  autoOpenEl.checked = !!prefs.autoOpen;
});

function save() {
  chrome.storage.local.set({
    [KEY]: { fill: fillEl.checked, autoOpen: autoOpenEl.checked },
  });
}

fillEl.addEventListener('change', save);
autoOpenEl.addEventListener('change', save);
