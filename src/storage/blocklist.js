const KEY = 'blocklist';

async function read() {
  try {
    const got = await chrome.storage.local.get(KEY);
    return Array.isArray(got[KEY]) ? got[KEY] : [];
  } catch {
    return [];
  }
}

export async function loadBlocklist() {
  return new Set(await read());
}

export async function addBlocked(channelName) {
  if (!channelName) return;
  const list = await read();
  if (list.includes(channelName)) return;
  list.push(channelName);
  await chrome.storage.local.set({ [KEY]: list });
}

export async function removeBlocked(channelName) {
  const list = (await read()).filter((id) => id !== channelName);
  await chrome.storage.local.set({ [KEY]: list });
}
