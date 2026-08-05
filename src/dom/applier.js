import { COLLAPSED_SECTION_CLASS } from './empty-sections.js';

export const HIDDEN_CLASS = 'ytt-hidden';

const DEBOUNCE_MS = 100;

export function createApplier({
  root,
  decide,
  readTile,
  isOutermostTile,
  tileSelector,
  getConfig,
  getState,
  onCounts,
}) {
  // Element -> videoId of the decision currently applied to that element.
  // YouTube recycles tile nodes, so a node's identity means nothing;
  // only the videoId currently rendered in it does.
  const applied = new WeakMap();
  let counts = { hidden: 0, visible: 0 };
  let observer = null;
  let timer = null;

  function apply(element, shouldHide) {
    if (shouldHide) element.classList.add(HIDDEN_CLASS);
    else element.classList.remove(HIDDEN_CLASS);
  }

  function scan() {
    let hidden = 0;
    let visible = 0;
    let totalMatchedTiles = 0;
    let nullChannelNameTiles = 0;

    for (const element of root.querySelectorAll(tileSelector)) {
      // A grid tile wraps a lockup 1:1. Skip the inner one entirely --
      // letting it fall through to the !tile branch would count it as
      // visible and double every grid video.
      if (!isOutermostTile(element)) continue;
      totalMatchedTiles += 1;

      let tile = null;
      try {
        tile = readTile(element);
      } catch {
        tile = null;
      }

      if (!tile) {
        // Unreadable now, but the node may have been hidden for a
        // previous video. Clear it rather than leaving a ghost.
        if (applied.has(element)) {
          apply(element, false);
          applied.delete(element);
        }
        visible += 1;
        continue;
      }
      if (tile.channelName === null) nullChannelNameTiles += 1;

      const previous = applied.get(element);
      if (previous !== undefined && previous !== tile.videoId) {
        // Recycled node: wipe the stale decision before deciding again.
        apply(element, false);
        applied.delete(element);
      }

      let verdict;
      try {
        verdict = decide(tile, getConfig(), getState());
      } catch {
        verdict = { hide: false, reason: 'error' }; // fail-open
      }

      apply(element, verdict.hide);
      applied.set(element, tile.videoId);
      if (verdict.hide) hidden += 1;
      else visible += 1;
    }

    counts = { hidden, visible };
    try {
      onCounts({
        ...counts,
        totalMatchedTiles,
        nullChannelNameTiles,
      });
    } catch { /* a reporting failure must not break filtering */ }
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, DEBOUNCE_MS);
  }

  function start() {
    if (observer) return;
    scan();
    const MO = root.ownerDocument?.defaultView?.MutationObserver
      ?? globalThis.MutationObserver;
    observer = new MO(schedule);
    // attributeFilter MUST stay exactly ['href'].
    // scan() -> onCounts() -> attachBlockButtons() writes data-channel-name on
    // every tile. That only converges because dataset writes do not match this
    // filter. Broadening it (or dropping it) creates an infinite scan loop.
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
    });
  }

  function stop() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    for (const element of root.querySelectorAll(`.${HIDDEN_CLASS}`)) {
      apply(element, false);
    }
    for (const section of root.querySelectorAll(`.${COLLAPSED_SECTION_CLASS}`)) {
      section.classList.remove(COLLAPSED_SECTION_CLASS);
    }
    counts = { hidden: 0, visible: 0 };
  }

  return { scan, start, stop, getCounts: () => counts };
}
