import { DEFAULT_CONFIG } from '../rules/defaults.js';

// Kept in storage.local since 2.0: storage.sync caps one item at 8 KB and
// rate-limits writes, and the browsers this targets have no account sync.
const KEY = 'config';

function merge(defaults, stored) {
  if (!stored || typeof stored !== 'object') return { ...defaults };
  const out = {};
  for (const [key, value] of Object.entries(defaults)) {
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      ? merge(value, stored[key])
      : (stored[key] !== undefined ? stored[key] : value);
  }
  return out;
}

export function mergeConfig(stored) {
  return merge(DEFAULT_CONFIG, stored);
}

export async function loadConfig() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return merge(DEFAULT_CONFIG, got[KEY]);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ [KEY]: config });
}

export function onConfigChange(callback) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      callback(merge(DEFAULT_CONFIG, changes[KEY].newValue));
    }
  });
}
