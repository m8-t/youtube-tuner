import { COLLAPSED_SECTION_CLASS } from './empty-sections.js';

export const HIDDEN_CLASS = 'ytt-hidden';

const DEBOUNCE_MS = 100;
const ELEMENT_NODE = 1;

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
  // Element -> { tile, verdict } from the last read. A tile is read again
  // only after a mutation touched it, or on a full scan.
  let cache = new WeakMap();
  let dirty = new WeakSet();
  let counts = { hidden: 0, visible: 0 };
  let observer = null;
  let timer = null;

  function apply(element, shouldHide) {
    const hidden = element.classList.contains(HIDDEN_CLASS);
    if (shouldHide === hidden) return false;
    if (shouldHide) element.classList.add(HIDDEN_CLASS);
    else element.classList.remove(HIDDEN_CLASS);
    return true;
  }

  function evaluate(element) {
    let tile = null;
    try {
      tile = readTile(element);
    } catch {
      tile = null;
    }
    if (!tile) return { tile: null, verdict: null };

    let verdict;
    try {
      verdict = decide(tile, getConfig(), getState());
    } catch {
      verdict = { hide: false, reason: 'error' }; // fail-open
    }
    return { tile, verdict };
  }

  // A full scan reads and decides every tile again. It is what settings,
  // filter data and navigation changes need. An incremental scan reuses the
  // result for every tile no mutation has touched.
  function scan({ full = true } = {}) {
    let hidden = 0;
    let visible = 0;
    let totalMatchedTiles = 0;
    let nullChannelNameTiles = 0;
    let changed = full;
    const tiles = [];

    for (const element of root.querySelectorAll(tileSelector)) {
      // A grid tile wraps a lockup 1:1. Skip the inner one entirely --
      // letting it fall through to the !tile branch would count it as
      // visible and double every grid video.
      if (!isOutermostTile(element)) continue;
      totalMatchedTiles += 1;

      let entry = full || dirty.has(element) ? undefined : cache.get(element);
      if (entry === undefined) {
        entry = evaluate(element);
        cache.set(element, entry);
        changed = true;
      }
      const { tile, verdict } = entry;

      if (!tile) {
        // Unreadable now, but the node may have been hidden for a
        // previous video. Clear it rather than leaving a ghost.
        if (applied.has(element)) {
          if (apply(element, false)) changed = true;
          applied.delete(element);
        }
        visible += 1;
        continue;
      }
      if (tile.channelName === null) nullChannelNameTiles += 1;

      const previous = applied.get(element);
      if (previous !== undefined && previous !== tile.videoId) {
        // Recycled node: wipe the stale decision before deciding again.
        if (apply(element, false)) changed = true;
        applied.delete(element);
      }

      if (apply(element, verdict.hide)) changed = true;
      applied.set(element, tile.videoId);
      tiles.push({ element, tile, verdict });
      if (verdict.hide) hidden += 1;
      else visible += 1;
    }

    dirty = new WeakSet();
    if (hidden !== counts.hidden || visible !== counts.visible) changed = true;
    counts = { hidden, visible };
    try {
      onCounts({
        ...counts,
        totalMatchedTiles,
        nullChannelNameTiles,
        tiles,
        changed,
      });
    } catch { /* a reporting failure must not break filtering */ }
  }

  function outermostTile(element) {
    let tile = element.closest?.(tileSelector) ?? null;
    while (tile) {
      const outer = tile.parentElement?.closest(tileSelector);
      if (!outer) break;
      tile = outer;
    }
    return tile;
  }

  function holdsTile(node) {
    return node.nodeType === ELEMENT_NODE && (
      node.matches?.(tileSelector) === true
      || node.querySelector?.(tileSelector) != null
    );
  }

  // YouTube mutates the DOM constantly (player, comments, live chat). Only a
  // mutation inside a tile, or one that adds or removes tiles, needs a scan.
  function noteMutations(records) {
    let relevant = false;
    for (const record of records) {
      const target = record.target?.nodeType === ELEMENT_NODE
        ? record.target
        : record.target?.parentElement;
      const tile = target ? outermostTile(target) : null;
      if (tile) {
        dirty.add(tile);
        relevant = true;
        continue;
      }
      if (record.type !== 'childList') continue;
      for (const node of record.addedNodes) {
        if (holdsTile(node)) relevant = true;
      }
      for (const node of record.removedNodes) {
        if (holdsTile(node)) relevant = true;
      }
    }
    return relevant;
  }

  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      scan({ full: false });
    }, DEBOUNCE_MS);
  }

  function start() {
    if (observer) return;
    scan();
    const MO = root.ownerDocument?.defaultView?.MutationObserver
      ?? globalThis.MutationObserver;
    observer = new MO((records) => {
      let relevant = true;
      try {
        relevant = noteMutations(records);
      } catch {
        // If the filter itself fails, fall back to scanning everything.
        cache = new WeakMap();
      }
      if (relevant) schedule();
    });
    // attributeFilter MUST stay exactly ['href'].
    // scan() -> onCounts() -> attachBlockButtons() writes data attributes on
    // every tile. That only converges because dataset writes do not match this
    // filter. Broadening it (or dropping it) creates an infinite scan loop.
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['href'],
      characterData: true,
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
      element.classList.remove(HIDDEN_CLASS);
    }
    for (const section of root.querySelectorAll(`.${COLLAPSED_SECTION_CLASS}`)) {
      section.classList.remove(COLLAPSED_SECTION_CLASS);
    }
    cache = new WeakMap();
    dirty = new WeakSet();
    counts = { hidden: 0, visible: 0 };
  }

  return { scan, start, stop, getCounts: () => counts };
}
