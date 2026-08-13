export const MENU_STRINGS = {
  notInterested: ['Kein Interesse', 'Not interested'],
  dontRecommendChannel: [
    'Keine Videos von diesem Kanal empfehlen',
    "Don't recommend channel",
  ],
};

const MENU_TRIGGER_SELECTOR =
  '.ytLockupMetadataViewModelMenuButton button';
const MENU_ITEM_SELECTOR =
  'yt-list-item-view-model.ytListItemViewModelHost[role="menuitem"], yt-list-item-view-model [role="menuitem"]';
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_POLL_INTERVAL_MS = 25;

let inFlight = false;

export function isVisibleInBrowser(element) {
  const view = element?.ownerDocument?.defaultView;
  if (!view || typeof element.getBoundingClientRect !== 'function') return false;

  const style = view.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') return false;

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function sendEscape(doc) {
  try {
    const KeyboardEvent = doc.defaultView?.KeyboardEvent;
    const target = doc.activeElement ?? doc.body;
    if (!KeyboardEvent || !target) return;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape',
        code: 'Escape',
        bubbles: true,
        cancelable: true,
      }));
    }
  } catch {
    // Closing is best-effort; never compensate by clicking a menu item.
  }
}

function visibleMenuItems(doc, isVisible) {
  const items = [...doc.querySelectorAll(MENU_ITEM_SELECTOR)];
  return items
    .filter((item) => !items.some((other) => (
      other !== item && item.contains(other)
    )))
    .filter(isVisible);
}

function normalizeMenuText(text) {
  return String(text ?? '')
    .replace(/[\u00a0\p{Zs}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function waitForVisibleMenuItems({
  doc,
  isVisible,
  timeoutMs,
  pollIntervalMs,
}) {
  const startedAt = Date.now();

  return new Promise((resolve) => {
    function poll() {
      const items = visibleMenuItems(doc, isVisible);
      if (items.length > 0) {
        resolve(items);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve([]);
        return;
      }
      setTimeout(poll, pollIntervalMs);
    }

    poll();
  });
}

export async function runNativeMenuAction({
  tile,
  action,
  doc = tile?.ownerDocument,
  isVisible = isVisibleInBrowser,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}) {
  if (inFlight) return false;
  inFlight = true;

  try {
    const expectedStrings = MENU_STRINGS[action];
    if (!doc || !tile || !Array.isArray(expectedStrings)) {
      sendEscape(doc);
      return false;
    }

    if (visibleMenuItems(doc, isVisible).length !== 0) {
      sendEscape(doc);
      return false;
    }

    const trigger = tile.querySelector(MENU_TRIGGER_SELECTOR);
    if (!trigger) {
      sendEscape(doc);
      return false;
    }
    trigger.click();

    const items = await waitForVisibleMenuItems({
      doc,
      isVisible,
      timeoutMs,
      pollIntervalMs,
    });
    if (items.length === 0) {
      sendEscape(doc);
      return false;
    }

    const targets = items.filter((item) => {
      const text = normalizeMenuText(item.textContent);
      return expectedStrings.some((expected) => (
        text === normalizeMenuText(expected)
      ));
    });
    if (targets.length !== 1) {
      sendEscape(doc);
      return false;
    }

    targets[0].click();
    return true;
  } catch {
    sendEscape(doc);
    return false;
  } finally {
    inFlight = false;
  }
}
