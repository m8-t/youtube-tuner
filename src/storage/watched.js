const KEY = 'watched';
export const WATCHED_CAP = 5000;

async function read() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return Array.isArray(got[KEY]) ? got[KEY] : [];
  } catch {
    return [];
  }
}

export async function loadWatched() {
  return new Set(await read());
}

// Stored oldest-first; the tail is the most recently watched.
export async function addWatched(videoId) {
  if (!videoId) return;
  const list = (await read()).filter((id) => id !== videoId);
  list.push(videoId);
  while (list.length > WATCHED_CAP) list.shift();
  await chrome.storage.local.set({ [KEY]: list });
}

export async function clearWatched() {
  await chrome.storage.local.set({ [KEY]: [] });
}
