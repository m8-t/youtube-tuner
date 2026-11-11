// The controls the extension adds to each video tile. This module only
// renders them and reports clicks; what a click does (local data, budget,
// YouTube's menu) is decided by the caller.
import { runNativeMenuAction } from './native-menu.js';

export const HIDE_VIDEO_BUTTON_CLASS = 'ytt-hide-video';
export const BLOCK_BUTTON_CLASS = 'ytt-block';
export const BLOCK_HOST_CLASS = 'ytt-block-host';
export const NO_BLOCK_CLASS = 'ytt-no-block';
export const NOT_INTERESTED_BUTTON_CLASS = 'ytt-not-interested';
export const WATCH_LATER_BUTTON_CLASS = 'ytt-watch-later';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Stroke icons on a 24x24 grid. Emoji were font-dependent and unlabeled.
const ICON_PATHS = {
  hide: 'M3 3l18 18M10.6 6.1A9.9 9.9 0 0 1 12 6c5 0 9 4.4 10 6a15 15 0 0 1-3.4 3.7M6.5 6.6A15 15 0 0 0 2 12c1 1.6 5 6 10 6a9.6 9.6 0 0 0 3.9-.8M9.9 9.9a3 3 0 0 0 4.2 4.2',
  block: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  later: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM12 7v5l3 2',
  feedback: 'M7 14V4h10l3 7v2a1 1 0 0 1-1 1h-6l1 4.3a1.6 1.6 0 0 1-3 1L7 14zM3 4h1.5v10H3z',
};

const nativeUndoArms = new WeakMap();
const handlers = new WeakMap();

export function armNativeUndo(tile, channelName) {
  try {
    if (!tile || !channelName) return false;
    nativeUndoArms.set(tile, channelName);
    return true;
  } catch {
    return false;
  }
}

export function readNativeUndo(tile) {
  try {
    return nativeUndoArms.get(tile);
  } catch {
    return undefined;
  }
}

export function disarmNativeUndo(tile) {
  try {
    return nativeUndoArms.delete(tile);
  } catch {
    return false;
  }
}

export const nativeUndoRegistry = Object.freeze({
  arm: armNativeUndo,
  read: readNativeUndo,
  disarm: disarmNativeUndo,
});

function createIcon(doc, name) {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.appendChild(path);
  return svg;
}

// A handler failure must never escape into YouTube's own click handling.
function runSafely(handler, ...args) {
  try {
    Promise.resolve(handler?.(...args)).catch(() => {});
  } catch {
    // Reported by the handler itself where it matters.
  }
}

function createControl(doc, element, className, icon) {
  const button = doc.createElement('button');
  button.className = className;
  button.type = 'button';
  button.appendChild(createIcon(doc, icon));
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    // Read at click time: YouTube may have recycled the tile since.
    const current = handlers.get(button);
    if (current) runSafely(current.onClick, current.tile, element);
  });
  element.appendChild(button);
  return button;
}

function label(button, text) {
  button.title = text;
  button.setAttribute('aria-label', text);
}

function readTiles({ root, tileSelector, readTile }) {
  const entries = [];
  for (const element of root.querySelectorAll(tileSelector)) {
    try {
      const tile = readTile(element);
      if (tile) entries.push({ element, tile });
    } catch {
      // An unreadable tile gets no controls.
    }
  }
  return entries;
}

export function attachBlockButtons({
  root,
  tileSelector,
  readTile,
  doc,
  // Tiles the scan already read. Without them the tiles are read here.
  tiles = null,
  shouldOffer = () => true,
  offerWatchLater = false,
  offerNativeFeedback = false,
  onHideVideo = () => {},
  onBlock = () => {},
  onNativeFeedback = () => {},
  onNativeAction = runNativeMenuAction,
}) {
  const entries = Array.isArray(tiles) ? tiles : readTiles({
    root,
    tileSelector,
    readTile,
  });
  for (const { element, tile } of entries) {
    let hideButton = element.querySelector(`.${HIDE_VIDEO_BUTTON_CLASS}`);
    let blockButton = element.querySelector(`.${BLOCK_BUTTON_CLASS}`);
    let feedbackButton =
      element.querySelector(`.${NOT_INTERESTED_BUTTON_CLASS}`);
    let watchLaterButton =
      element.querySelector(`.${WATCH_LATER_BUTTON_CLASS}`);

    let offered = Boolean(tile.channelName);
    if (offered) {
      try {
        offered = shouldOffer(tile.channelName, tile) !== false;
      } catch {
        // Fail open: a broken eligibility check must not disable blocking.
        offered = true;
      }
    }

    if (!offered) {
      blockButton?.remove();
      blockButton = null;
    }
    if (!offerWatchLater) {
      watchLaterButton?.remove();
      watchLaterButton = null;
    }
    if (!offerNativeFeedback) {
      feedbackButton?.remove();
      feedbackButton = null;
    }

    hideButton ??= createControl(doc, element, HIDE_VIDEO_BUTTON_CLASS, 'hide');
    if (offered) {
      blockButton ??= createControl(doc, element, BLOCK_BUTTON_CLASS, 'block');
    }
    if (offerNativeFeedback) {
      feedbackButton ??= createControl(
        doc,
        element,
        NOT_INTERESTED_BUTTON_CLASS,
        'feedback',
      );
    }
    if (offerWatchLater) {
      watchLaterButton ??= createControl(
        doc,
        element,
        WATCH_LATER_BUTTON_CLASS,
        'later',
      );
    }

    // Give the absolutely positioned controls a stable positioning context.
    element.classList.add(BLOCK_HOST_CLASS);
    element.classList.toggle(NO_BLOCK_CLASS, !blockButton);

    // Re-stamped on every pass: the node may now show another video.
    handlers.set(hideButton, { tile, onClick: onHideVideo });
    hideButton.dataset.videoId = tile.videoId;
    label(hideButton, 'Hide this video (stays on this device)');

    if (blockButton) {
      handlers.set(blockButton, {
        tile,
        onClick: (current, host) => onBlock(current.channelName, current, host),
      });
      blockButton.dataset.channelName = tile.channelName;
      label(blockButton, `Block ${tile.channelName}`);
    }
    if (feedbackButton) {
      handlers.set(feedbackButton, { tile, onClick: onNativeFeedback });
      feedbackButton.dataset.videoId = tile.videoId;
      label(
        feedbackButton,
        'Not interested: tells YouTube, saved in your Google account',
      );
    }
    if (watchLaterButton) {
      handlers.set(watchLaterButton, {
        tile,
        onClick: (_current, host) => onNativeAction({
          tile: host,
          action: 'watchLater',
          doc,
        }),
      });
      watchLaterButton.dataset.videoId = tile.videoId;
      label(watchLaterButton, 'Save to Watch later');
    }
  }
}
