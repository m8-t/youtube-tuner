import { normalizeChannelName } from './channel-name.js';

const CHANNEL_NAME_SELECTOR = [
  'ytd-channel-renderer #channel-title',
  'ytd-grid-channel-renderer #channel-title',
  'yt-lockup-view-model a[href^="/@"] .yt-core-attributed-string',
  'yt-lockup-view-model a[href^="/channel/"] .yt-core-attributed-string',
].join(',');

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
