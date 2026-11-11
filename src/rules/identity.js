// Decides whether a tile belongs to a blocked or a subscribed channel.
//
// Display names are not unique on YouTube, so a name alone is a weak key.
// Where a tile exposes the channel handle, the handle decides; the name is
// the fallback for surfaces that render none (the watch-page sidebar).

function entryActive(entry, now) {
  const until = entry?.until;
  return until === null || until === undefined || until > now;
}

// Returns the blocklist name the tile is blocked under, or null.
export function blockedAs(tile, state, now = Date.now()) {
  const blocklist = state?.blocklist;
  if (!blocklist) return null;
  const meta = state.blockMeta;
  const handle = tile.channelHandle ?? null;

  // A renamed channel still carries the handle it was blocked with.
  const byHandle = handle ? state.blockedHandles?.get(handle) : undefined;
  if (
    byHandle !== undefined
    && blocklist.has(byHandle)
    && entryActive(meta?.get(byHandle), now)
  ) {
    return byHandle;
  }

  const name = tile.channelName;
  if (!name || !blocklist.has(name)) return null;
  const entry = meta?.get(name);
  if (!entryActive(entry, now)) return null;
  // Same name, different channel: the block was made for another handle.
  if (handle && entry?.handles?.length > 0 && !entry.handles.includes(handle)) {
    return null;
  }
  return name;
}

// True when a name-only block should now be tied to this tile's handle.
export function shouldPinBlock(tile, state) {
  const name = tile.channelName;
  if (!name || !tile.channelHandle || !state?.blocklist?.has(name)) return false;
  const entry = state.blockMeta?.get(name);
  return !entry || entry.handles.length === 0;
}

export function isSubscribed(tile, state) {
  const subs = state?.subs;
  if (!subs) return false;
  const handle = tile.channelHandle ?? null;
  if (handle && state.subHandleSet?.has(handle)) return true;

  const name = tile.channelName;
  if (!name || !subs.has(name)) return false;
  // A channel that copied a subscribed channel's name has another handle.
  const known = state.subHandles?.get(name);
  if (handle && known && known !== handle) return false;
  return true;
}
