import { channelKeyFromHref, normalizeChannelName } from './channel-name.js';
import {
  CHANNEL_LINK_SELECTOR,
  SUBS_CHANNEL_NAME_SELECTOR as CHANNEL_NAME_SELECTOR,
} from './dom/selectors.js';

const LEGACY_RENDERERS = 'ytd-channel-renderer, ytd-grid-channel-renderer';

function nameOf(element) {
  return [
    element.textContent,
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
  ]
    .map(normalizeChannelName)
    .find(Boolean);
}

// name -> "@handle" for every listed channel whose link is on the page. The
// handle is what tells the subscribed channel from a namesake.
export function extractSubscriptionHandles(documentObject) {
  const handles = {};
  if (typeof documentObject?.querySelectorAll !== 'function') return handles;

  for (const element of documentObject.querySelectorAll(CHANNEL_NAME_SELECTOR)) {
    try {
      const name = nameOf(element);
      if (!name) continue;
      const link = element.closest?.(CHANNEL_LINK_SELECTOR)
        ?? element.closest?.(LEGACY_RENDERERS)
          ?.querySelector(CHANNEL_LINK_SELECTOR);
      const key = channelKeyFromHref(link?.getAttribute('href'));
      if (key) handles[name] = key;
    } catch {
      // A missing handle only means name matching for that channel.
    }
  }
  return handles;
}

export function extractSubscriptionNames(documentObject) {
  if (typeof documentObject?.querySelectorAll !== 'function') return [];

  const names = new Set();
  for (const element of documentObject.querySelectorAll(CHANNEL_NAME_SELECTOR)) {
    const name = nameOf(element);
    if (name) names.add(name);
  }
  return [...names];
}
