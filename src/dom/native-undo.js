import { removeBlocked } from '../storage/blocklist.js';
import {
  BLOCK_HOST_CLASS,
  nativeUndoRegistry,
} from './block-button.js';

const NATIVE_UNDO_RENDERER = 'notification-multi-action-renderer';

export function createNativeUndoWatcher({
  doc,
  removeBlockedChannel = removeBlocked,
  registry = nativeUndoRegistry,
} = {}) {
  let started = false;

  function handleClick(event) {
    try {
      const target = event?.target;
      if (typeof target?.closest !== 'function') return;

      const notification = target.closest(NATIVE_UNDO_RENDERER);
      if (!notification) return;

      const button = target.closest('button');
      if (!button || !notification.contains(button)) return;

      const tile = notification.closest(`.${BLOCK_HOST_CLASS}`);
      if (!tile) return;

      const channelName = registry.read(tile);
      if (!channelName) return;

      try {
        Promise.resolve(removeBlockedChannel(channelName)).catch(() => {});
      } catch {
        // Native Undo must continue even if local storage fails synchronously.
      }

      try {
        registry.disarm(tile);
      } catch {
        // A broken registry must never affect YouTube's click handling.
      }
    } catch {
      // No watcher failure may escape into the page.
    }
  }

  function start() {
    if (started) return;
    try {
      doc.addEventListener('click', handleClick, true);
      started = true;
    } catch {
      // A missing or inaccessible document leaves the watcher inactive.
    }
  }

  function stop() {
    if (!started) return;
    started = false;
    try {
      doc.removeEventListener('click', handleClick, true);
    } catch {
      // Teardown is best-effort and must not affect the page.
    }
  }

  return { start, stop };
}
