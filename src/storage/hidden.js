// Videos the user hid one by one. Local only: nothing is sent to YouTube.
const KEY = 'hiddenVideos';
export const HIDDEN_CAP = 5000;

async function read() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return Array.isArray(got[KEY]) ? got[KEY] : [];
  } catch {
    return [];
  }
}

export async function loadHidden() {
  return new Set(await read());
}

// Stored oldest-first; the cap drops the oldest.
export async function addHidden(videoId) {
  if (!videoId) return;
  const list = (await read()).filter((id) => id !== videoId);
  list.push(videoId);
  while (list.length > HIDDEN_CAP) list.shift();
  await chrome.storage.local.set({ [KEY]: list });
}

export async function removeHidden(videoId) {
  const list = await read();
  const next = list.filter((id) => id !== videoId);
  if (next.length === list.length) return;
  await chrome.storage.local.set({ [KEY]: next });
}

export async function clearHidden() {
  await chrome.storage.local.set({ [KEY]: [] });
}
