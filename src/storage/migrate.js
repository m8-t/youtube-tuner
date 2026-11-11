// One-time storage layout changes. Every step is idempotent, so running it
// again (service worker restart, options page opened first) is harmless.
const MOVED_FROM_SYNC = ['config', 'channelOverrides'];

// Up to 1.7.x the settings and channel rules lived in storage.sync.
export async function migrateStorageLayout({
  storage = chrome.storage,
} = {}) {
  let moved = false;
  const synced = await storage.sync.get(MOVED_FROM_SYNC);
  const present = MOVED_FROM_SYNC.filter((key) => synced[key] !== undefined);
  if (present.length > 0) {
    const local = await storage.local.get(present);
    const writes = {};
    for (const key of present) {
      if (local[key] === undefined) writes[key] = synced[key];
    }
    if (Object.keys(writes).length > 0) await storage.local.set(writes);
    await storage.sync.remove(present);
    moved = true;
  }
  return moved;
}

let ready = null;

// Shared by the background worker, the options page and the popup: whichever
// opens first after an update performs the move before it reads anything.
export function ensureStorageLayout(options) {
  ready ??= migrateStorageLayout(options).catch((error) => {
    try {
      console.warn('[youtube-tuner] storage migration failed', error);
    } catch {}
    return false;
  });
  return ready;
}
