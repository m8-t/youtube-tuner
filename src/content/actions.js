// What the tile controls do. Everything here is local-first: a click changes
// the extension's own data, and YouTube is told only where the user opted in
// and the weekly budget allows it.
import { runNativeMenuAction } from '../dom/native-menu.js';
import { nativeUndoRegistry } from '../dom/block-button.js';
import { showToast } from '../dom/block-toast.js';
import { blockedAs, shouldPinBlock } from '../rules/identity.js';

export const STATS_FLUSH_DELAY_MS = 30_000;
const COUNTED_VIDEOS_CAP = 5_000;
const SNOOZE_LABEL = '30 days only';

export function createTileActions({
  doc,
  client,
  getConfig,
  getState,
  rescan,
  hold = () => {},
  release = () => {},
  runNative = runNativeMenuAction,
  registry = nativeUndoRegistry,
  notify = showToast,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let nativeBusy = false;
  let pendingHits = {};
  let flushTimer = null;
  const countedVideos = new Set();
  const pinRequested = new Set();
  const queueAttempted = new Set();

  function toast(text, actions = []) {
    try {
      notify({ doc, text, actions });
    } catch {
      // The toast is a convenience and must not affect the action.
    }
  }

  function feedbackAllowed() {
    return getConfig().feedback?.enabled === true;
  }

  // Sends one signal to YouTube through its own menu, inside the budget.
  // Returns whether it was sent and a sentence for the toast.
  async function sendFeedback({ element, action, tile }) {
    if (nativeBusy) return { sent: false, note: '' };
    nativeBusy = true;
    try {
      let reservation;
      try {
        reservation = await client.reserveFeedback({
          action,
          videoId: tile.videoId,
          channelName: tile.channelName ?? '',
        });
      } catch {
        return { sent: false, note: '' };
      }
      if (reservation?.ok !== true) {
        return {
          sent: false,
          note: reservation?.reason === 'budget'
            ? ` YouTube was not told: the weekly limit of ${reservation.limit} is used up.`
            : '',
        };
      }

      let done = false;
      try {
        done = (await runNative({ tile: element, action, doc })) === true;
      } catch {
        done = false;
      }
      if (!done) {
        try {
          await client.releaseFeedback(reservation.id);
        } catch {}
        return {
          sent: false,
          note: " YouTube's menu did not offer that action, so nothing was sent.",
        };
      }
      return {
        sent: true,
        note: ` Sent to YouTube (${reservation.used} of ${reservation.limit} this week).`,
      };
    } finally {
      nativeBusy = false;
    }
  }

  async function hideLocally(tile, note = '') {
    await client.hideVideo(tile.videoId);
    getState().hidden?.add(tile.videoId);
    rescan();
    toast(`Video hidden.${note}`, [{
      label: 'Undo',
      onClick: async () => {
        await client.unhideVideo(tile.videoId);
        getState().hidden?.delete(tile.videoId);
        rescan();
      },
    }]);
  }

  function hideVideo(tile) {
    return hideLocally(tile);
  }

  // The opt-in control: YouTube's "Not interested", then the same local hide.
  async function tellYouTube(tile, element) {
    const result = feedbackAllowed()
      ? await sendFeedback({ element, action: 'notInterested', tile })
      : { sent: false, note: '' };
    await hideLocally(tile, result.note);
  }

  function rememberBlock(channelName, handle, until = null) {
    const state = getState();
    state.blocklist?.add(channelName);
    const previous = state.blockMeta?.get(channelName);
    const handles = previous ? [...previous.handles] : [];
    if (handle && !handles.includes(handle)) handles.push(handle);
    state.blockMeta?.set(channelName, { handles, until });
    if (handle) state.blockedHandles?.set(handle, channelName);
  }

  function forgetBlock(channelName) {
    const state = getState();
    state.blocklist?.delete(channelName);
    for (const handle of state.blockMeta?.get(channelName)?.handles ?? []) {
      state.blockedHandles?.delete(handle);
    }
    state.blockMeta?.delete(channelName);
  }

  async function undoBlock(channelName) {
    await client.unblock(channelName);
    forgetBlock(channelName);
    rescan();
  }

  async function blockChannel(channelName, tile, element) {
    if (!channelName) return;
    const handle = tile?.channelHandle ?? null;
    const config = getConfig();

    let note = '';
    if (
      feedbackAllowed()
      && config.blocklistRule?.sendNativeFeedback === true
      && element
    ) {
      // While the tile is still visible: YouTube's menu opens against it.
      const result = await sendFeedback({
        element,
        action: 'dontRecommendChannel',
        tile: tile ?? { channelName },
      });
      note = result.note;
      if (result.sent) {
        try {
          registry.arm(element, channelName);
        } catch {}
      }
    }

    try {
      await client.block(channelName, handle);
    } catch (error) {
      try {
        console.warn(
          `[youtube-tuner] block failed for "${channelName}"; if this tab predates an extension update, reload it`,
        );
      } catch {}
      throw error;
    }
    rememberBlock(channelName, handle);
    rescan();

    toast(`Blocked ${channelName}.${note}`, [
      { label: 'Undo', onClick: () => undoBlock(channelName) },
      {
        label: SNOOZE_LABEL,
        onClick: async () => {
          await client.snoozeBlock(channelName);
          toast(`Blocked ${channelName} for 30 days.`, [
            { label: 'Undo', onClick: () => undoBlock(channelName) },
          ]);
        },
      },
    ]);
  }

  function scheduleFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeoutFn(() => {
      flushTimer = null;
      flushStats();
    }, STATS_FLUSH_DELAY_MS);
  }

  function flushStats() {
    if (flushTimer !== null) {
      clearTimeoutFn(flushTimer);
      flushTimer = null;
    }
    const hits = pendingHits;
    pendingHits = {};
    if (Object.keys(hits).length === 0) return;
    try {
      Promise.resolve(client.reportBlockStats(hits)).catch(() => {});
    } catch {
      // Statistics are best-effort.
    }
  }

  // Called after every scan with the tiles it read.
  function noteBlockedTiles(tiles) {
    if (!Array.isArray(tiles)) return;
    const state = getState();
    for (const { tile, verdict } of tiles) {
      if (verdict?.reason !== 'blocked') continue;
      const name = blockedAs(tile, state);
      if (name === null) continue;

      // Each recommended video counts once per page, however often it is
      // scanned.
      if (!countedVideos.has(tile.videoId)) {
        if (countedVideos.size >= COUNTED_VIDEOS_CAP) countedVideos.clear();
        countedVideos.add(tile.videoId);
        pendingHits[name] = (pendingHits[name] ?? 0) + 1;
        scheduleFlush();
      }

      if (shouldPinBlock(tile, state) && !pinRequested.has(name)) {
        pinRequested.add(name);
        try {
          Promise.resolve(client.pinBlock(name, tile.channelHandle))
            .catch(() => {});
        } catch {}
      }
    }
  }

  // A blocked channel the user marked "tell YouTube next time it appears".
  // One attempt per channel per page, one at a time, inside the budget.
  async function processQueue(tiles) {
    if (!Array.isArray(tiles) || nativeBusy || !feedbackAllowed()) return false;
    const state = getState();
    const queue = state.feedbackQueue;
    if (!queue || queue.size === 0) return false;

    for (const { element, tile, verdict } of tiles) {
      if (verdict?.reason !== 'blocked') continue;
      const name = blockedAs(tile, state);
      if (name === null || !queue.has(name) || queueAttempted.has(name)) {
        continue;
      }
      queueAttempted.add(name);

      hold(element);
      let result;
      try {
        result = await sendFeedback({ element, action: 'notInterested', tile });
      } finally {
        release(element);
      }
      if (result.sent) {
        queue.delete(name);
        try {
          await client.dequeueFeedback(name);
        } catch {}
        toast(`Told YouTube you are not interested in ${name}.${result.note}`);
      }
      return result.sent;
    }
    return false;
  }

  function stop() {
    flushStats();
  }

  return {
    blockChannel,
    flushStats,
    hideVideo,
    noteBlockedTiles,
    processQueue,
    stop,
    tellYouTube,
  };
}
