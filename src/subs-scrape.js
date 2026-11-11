import { normalizeChannelName } from './channel-name.js';
import {
  SUBS_CHANNEL_NAME_SELECTOR as CHANNEL_NAME_SELECTOR,
} from './dom/selectors.js';

export function extractSubscriptionNames(documentObject) {
  if (typeof documentObject?.querySelectorAll !== 'function') return [];

  const names = new Set();
  for (const element of documentObject.querySelectorAll(CHANNEL_NAME_SELECTOR)) {
    const name = [
      element.textContent,
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
    ]
      .map(normalizeChannelName)
      .find(Boolean);
    if (name) names.add(name);
  }
  return [...names];
}
