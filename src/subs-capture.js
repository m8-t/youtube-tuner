import { normalizeChannelName } from './channel-name.js';

export const SUBSCRIBE_BUTTON_SELECTOR =
  'ytd-subscribe-button-renderer, yt-subscribe-button-view-model'; // UNVERIFIED
// Verified live 2026-07-28 ancestor chain:
// ytd-subscribe-button-renderer -> div#subscribe-button -> div#owner ->
// div#top-row -> div#above-the-fold -> ytd-watch-metadata.
export const OWNER_SELECTOR = '#owner';
export const SUBSCRIBE_LABELS = new Set(['Abonnieren', 'Subscribe']);
export const SUBSCRIBED_LABELS = new Set(['Abonniert', 'Subscribed']);
export const UNSUB_PENDING_TTL_MS = 15_000;
export const CHANNEL_LINK_SELECTOR = 'a[href^="/@"], a[href^="/channel/"]';
const UNSUB_VERIFY_DELAY_MS = 500;

export function createSubscribeCapture({
  documentObject,
  getPathname,
  getEnabled,
  addNames,
  removeNames,
  setTimeoutFn = setTimeout,
  now = () => Date.now(),
  log = (...args) => console.log(...args),
}) {
  let started = false;
  let pending = null;

  function readOwnerState(owner, button) {
    const lines = (button.textContent ?? '')
      .split(/\r\n?|\n/)
      .map((line) => line.trim());
    const channelName = [...owner.querySelectorAll(CHANNEL_LINK_SELECTOR)]
      .map((anchor) => normalizeChannelName(anchor.textContent))
      .find(Boolean);
    return { channelName, lines };
  }

  function readCurrentOwnerState() {
    try {
      const owner = documentObject.querySelector(OWNER_SELECTOR);
      const button = owner?.querySelector(SUBSCRIBE_BUTTON_SELECTOR);
      return owner && button ? readOwnerState(owner, button) : null;
    } catch {
      return null;
    }
  }

  function pendingIsCurrent(armed) {
    if (pending !== armed) return false;
    if (
      getPathname() !== armed.pathname ||
      now() - armed.at > UNSUB_PENDING_TTL_MS
    ) {
      pending = null;
      return false;
    }
    return true;
  }

  function scheduleUnsubscribeRead(armed) {
    setTimeoutFn(async () => {
      if (!pendingIsCurrent(armed)) return;

      const firstRead = readCurrentOwnerState();
      if (
        firstRead?.channelName !== armed.name ||
        !firstRead.lines.some((line) => SUBSCRIBE_LABELS.has(line))
      ) return;

      setTimeoutFn(async () => {
        if (!pendingIsCurrent(armed)) return;

        const confirmRead = readCurrentOwnerState();
        if (
          confirmRead?.channelName !== armed.name ||
          !confirmRead.lines.some((line) => SUBSCRIBE_LABELS.has(line))
        ) return;

        pending = null;
        try {
          if (await removeNames([armed.name])) {
            log(`[youtube-tuner] subs-capture: removed "${armed.name}"`);
          } else {
            log('[youtube-tuner] subs-capture: remove-noop');
          }
        } catch (error) {
          log('[youtube-tuner] subs-capture: remove-failed', error);
        }
      }, UNSUB_VERIFY_DELAY_MS);
    }, UNSUB_VERIFY_DELAY_MS);
  }

  async function handleClick(event) {
    const pathname = getPathname();
    if (
      pending &&
      (pathname !== pending.pathname ||
        now() - pending.at > UNSUB_PENDING_TTL_MS)
    ) {
      pending = null;
    }
    if (!getEnabled() || pathname !== '/watch') return;

    const path = typeof event?.composedPath === 'function'
      ? event.composedPath()
      : null;
    const target = path?.[0] ?? event?.target;
    const button = typeof target?.closest === 'function'
      ? target.closest(SUBSCRIBE_BUTTON_SELECTOR)
      : null;
    const owner = button?.closest(OWNER_SELECTOR);
    const ownerState = owner ? readOwnerState(owner, button) : null;

    if (
      ownerState?.lines.some((line) => SUBSCRIBED_LABELS.has(line)) &&
      ownerState.channelName
    ) {
      pending = {
        name: ownerState.channelName,
        pathname,
        at: now(),
      };
      log(
        `[youtube-tuner] subs-capture: unsub-armed "${ownerState.channelName}"`,
      );
      return;
    }

    if (pending) scheduleUnsubscribeRead(pending);

    if (!button) return;
    if (!owner) {
      log('[youtube-tuner] subs-capture: outside-owner');
      return;
    }
    if (
      !ownerState.lines.some((line) => SUBSCRIBE_LABELS.has(line)) &&
      !ownerState.lines.some((line) => SUBSCRIBED_LABELS.has(line))
    ) {
      log('[youtube-tuner] subs-capture: label-mismatch');
      return;
    }
    if (!ownerState.channelName) {
      log('[youtube-tuner] subs-capture: no-channel-name');
      return;
    }
    if (!ownerState.lines.some((line) => SUBSCRIBE_LABELS.has(line))) return;

    try {
      if (await addNames([ownerState.channelName])) {
        log(`[youtube-tuner] subs-capture: added "${ownerState.channelName}"`);
      } else {
        log('[youtube-tuner] subs-capture: no-cache');
      }
    } catch (error) {
      log('[youtube-tuner] subs-capture: add-failed', error);
    }
  }

  function start() {
    if (started) return;
    started = true;
    documentObject.addEventListener('click', handleClick, true);
  }

  function stop() {
    if (!started) return;
    started = false;
    documentObject.removeEventListener('click', handleClick, true);
  }

  return { start, stop, handleClick };
}
