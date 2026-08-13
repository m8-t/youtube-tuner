import { runNativeMenuAction } from './native-menu.js';

export const BLOCK_BUTTON_CLASS = 'ytt-block';
export const BLOCK_HOST_CLASS = 'ytt-block-host';
export const NO_BLOCK_CLASS = 'ytt-no-block';
export const NOT_INTERESTED_BUTTON_CLASS = 'ytt-not-interested';
export const WATCH_LATER_BUTTON_CLASS = 'ytt-watch-later';

const nativeUndoArms = new WeakMap();

function warnBlockFailure(channelName) {
  try {
    console.warn(
      `[youtube-tuner] block failed for "${channelName}" — storage write rejected; if this tab predates an extension update, reload it`,
    );
  } catch {
    // Logging failures must not escape into YouTube's click handler.
  }
}

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

export function attachBlockButtons({
  root,
  tileSelector,
  readTile,
  onBlock,
  doc,
  shouldOffer = () => true,
  offerWatchLater = false,
  onNativeAction = runNativeMenuAction,
  registry = nativeUndoRegistry,
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
    let watchLaterButton =
      element.querySelector(`.${WATCH_LATER_BUTTON_CLASS}`);
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

    if (!offerWatchLater) {
      watchLaterButton?.remove();
      watchLaterButton = null;
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
          Promise.resolve(onBlock(channelName)).catch(() => {
            warnBlockFailure(channelName);
          });
        } catch {
          // A synchronous storage failure must not escape the click handler.
          warnBlockFailure(channelName);
        }
        try {
          registry.arm(element, channelName);
        } catch {
          // Undo tracking must never affect the block action.
        }
      });
      element.appendChild(button);
    }

    if (offerWatchLater && !watchLaterButton) {
      watchLaterButton = doc.createElement('button');
      watchLaterButton.className = WATCH_LATER_BUTTON_CLASS;
      watchLaterButton.type = 'button';
      watchLaterButton.textContent = '\u{1F552}';
      watchLaterButton.title = 'Save to Watch later';
      watchLaterButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          Promise.resolve(onNativeAction({
            tile: element,
            action: 'watchLater',
            doc,
          })).catch(() => {});
        } catch {
          // Native actions fail closed and must not affect local state.
        }
      });
      element.appendChild(watchLaterButton);
    }

    // Give the absolutely positioned controls a stable positioning context.
    element.classList.add(BLOCK_HOST_CLASS);
    element.classList.toggle(NO_BLOCK_CLASS, !button);

    // YouTube may have recycled this tile for a different channel.
    notInterestedButton.dataset.videoId = tile.videoId;
    if (watchLaterButton) {
      watchLaterButton.dataset.videoId = tile.videoId;
    }
    if (button) {
      button.dataset.channelName = tile.channelName;
      button.title = `Block ${tile.channelName}`;
    }
  }
}
