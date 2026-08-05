import { runNativeMenuAction } from './native-menu.js';
import { removeBlocked } from '../storage/blocklist.js';

export const BLOCK_BUTTON_CLASS = 'ytt-block';
export const BLOCK_HOST_CLASS = 'ytt-block-host';
export const NOT_INTERESTED_BUTTON_CLASS = 'ytt-not-interested';
export const TOAST_CLASS = 'ytt-toast';
export const TOAST_UNDO_CLASS = 'ytt-toast-undo';

const TOAST_DURATION_MS = 6_000;
const toastState = new WeakMap();

export function dismissBlockToast(doc = document) {
  try {
    const state = toastState.get(doc);
    if (state) {
      try {
        state.clearTimer(state.timer);
      } catch {}
      toastState.delete(doc);
    }
    for (const toast of doc.querySelectorAll(`.${TOAST_CLASS}`)) {
      toast.remove();
    }
  } catch {
    // Toast cleanup must never affect filtering.
  }
}

export function showBlockToast(channelName, {
  doc = document,
  removeBlockedChannel = removeBlocked,
  setTimer = (callback, delay) => setTimeout(callback, delay),
  clearTimer = (timer) => clearTimeout(timer),
} = {}) {
  let toast = null;
  try {
    dismissBlockToast(doc);
    toast = doc.createElement('div');
    toast.className = TOAST_CLASS;
    toast.setAttribute('role', 'status');
    toast.append(`Blocked ${channelName}`);

    const undoButton = doc.createElement('button');
    undoButton.className = TOAST_UNDO_CLASS;
    undoButton.type = 'button';
    undoButton.textContent = 'Undo';
    undoButton.addEventListener('click', () => {
      dismissBlockToast(doc);
      try {
        Promise.resolve(removeBlockedChannel(channelName)).catch(() => {});
      } catch {
        // Undo feedback must never affect filtering.
      }
    });
    toast.appendChild(undoButton);
    doc.body.appendChild(toast);

    const timer = setTimer(() => {
      try {
        if (toastState.get(doc)?.toast === toast) toastState.delete(doc);
        toast.remove();
      } catch {
        // Toast expiry must never affect filtering.
      }
    }, TOAST_DURATION_MS);
    toastState.set(doc, { clearTimer, timer, toast });
    return toast;
  } catch {
    try {
      toast?.remove();
    } catch {}
    return null;
  }
}

export function attachBlockButtons({
  root,
  tileSelector,
  readTile,
  onBlock,
  doc,
  shouldOffer = () => true,
  onNativeAction = runNativeMenuAction,
  removeBlockedChannel = removeBlocked,
  showToast = showBlockToast,
}) {
  for (const element of root.querySelectorAll(tileSelector)) {
    let tile = null;
    try {
      tile = readTile(element);
    } catch {
      continue;
    }
    if (!tile) continue;

    let button = element.querySelector(`.${BLOCK_BUTTON_CLASS}`);
    let notInterestedButton =
      element.querySelector(`.${NOT_INTERESTED_BUTTON_CLASS}`);
    let offered = true;
    if (tile.channelName) {
      try {
        offered = shouldOffer(tile.channelName);
      } catch {
        // Fail open: a broken eligibility check must not disable blocking.
      }
    } else {
      offered = false;
    }

    if (!offered) {
      button?.remove();
      button = null;
    }

    if (!notInterestedButton) {
      notInterestedButton = doc.createElement('button');
      notInterestedButton.className = NOT_INTERESTED_BUTTON_CLASS;
      notInterestedButton.type = 'button';
      notInterestedButton.textContent = '\u{1F44E}';
      notInterestedButton.title = 'Not interested in this video';
      notInterestedButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          Promise.resolve(onNativeAction({
            tile: element,
            action: 'notInterested',
            doc,
          })).catch(() => {});
        } catch {
          // Native actions fail closed and must not affect local state.
        }
      });
      element.appendChild(notInterestedButton);
    }

    if (offered && !button) {
      button = doc.createElement('button');
      button.className = BLOCK_BUTTON_CLASS;
      button.type = 'button';
      button.textContent = '\u{1F6AB}';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const channelName = button.dataset.channelName;
        if (!channelName) return;
        try {
          Promise.resolve(onNativeAction({
            tile: element,
            action: 'dontRecommendChannel',
            doc,
          })).catch(() => {});
        } catch {
          // The local block below is intentionally independent of this call.
        }
        try {
          Promise.resolve(onBlock(channelName))
            .then(() => {
              try {
                const feedback = showToast(
                  channelName,
                  { doc, removeBlockedChannel },
                );
                void Promise.resolve(feedback).catch(() => {});
              } catch {
                // Toast feedback must never affect filtering.
              }
            })
            .catch(() => {});
        } catch {
          // A synchronous storage failure must not escape the click handler.
        }
      });
      element.appendChild(button);
    }

    // Give the absolutely positioned controls a stable positioning context.
    element.classList.add(BLOCK_HOST_CLASS);

    // YouTube may have recycled this tile for a different channel.
    notInterestedButton.dataset.videoId = tile.videoId;
    if (button) {
      button.dataset.channelName = tile.channelName;
      button.title = `Block ${tile.channelName}`;
    }
  }
}
