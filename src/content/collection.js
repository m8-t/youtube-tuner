// Subscription collection on youtube.com/feed/channels: the active run in
// the tab the extension opens, and the passive one while the user scrolls.
import {
  collectSubscriptions,
  requestPassiveSubscriptionCollection,
  requestSubscriptionCollection,
} from '../subs-refresh.js';

export const SUBS_COLLECT_HASH = '#ytt-collect';
export const SUBS_COLLECTION_RESULT_MESSAGE = 'subs-collection-result';

export function subscriptionCollectionResponse(result) {
  if (
    result?.complete === true &&
    Array.isArray(result.names) &&
    result.names.length > 0
  ) {
    return { count: result.names.length };
  }

  const response = {
    reason:
      typeof result?.reason === 'string'
        ? result.reason
        : 'scrape-incomplete',
  };
  if (result?.diagnostics && typeof result.diagnostics === 'object') {
    response.diagnostics = result.diagnostics;
  }
  return response;
}

export function subscriptionCollectionResultMessage(result) {
  const response = subscriptionCollectionResponse(result);
  return {
    type: SUBS_COLLECTION_RESULT_MESSAGE,
    complete: result?.complete === true,
    count: Array.isArray(result?.names) ? result.names.length : 0,
    ...(response.reason ? { reason: response.reason } : {}),
    ...(result?.diagnostics && typeof result.diagnostics === 'object'
      ? { diagnostics: result.diagnostics }
      : {}),
  };
}

export async function startSubscriptionCollectionMode({
  pathname,
  collectMarker,
  cachedSubs,
  subsStale = false,
  documentObject,
  windowObject,
  requestCollection = requestSubscriptionCollection,
  collect = collectSubscriptions,
  requestPassive = requestPassiveSubscriptionCollection,
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  if (pathname !== '/feed/channels') return null;

  if (collectMarker) {
    if (windowObject?.top !== windowObject) return null;
    const result = await requestCollection({
      force: true,
      collect: () => collect({ documentObject, windowObject }),
    });
    await sendMessage(subscriptionCollectionResultMessage(result));
    return { mode: 'active', result };
  }

  if (cachedSubs !== null && !subsStale) return null;
  const controller = await requestPassive({ documentObject });
  return controller === null ? null : { mode: 'passive', controller };
}

export function stopPassiveCollectionOnNavigation(controller, pathname) {
  if (pathname === '/feed/channels') return controller;
  controller?.stop();
  return null;
}
