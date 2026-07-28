import { saveSubs } from './storage/subs.js';
import { extractSubscriptionNames } from './subs-scrape.js';

export const SUBS_REFRESH_ATTEMPTED_KEY = 'subsRefreshAttemptedAt';
export const SUBS_REFRESH_RETRY_MS = 60 * 60 * 1000;
export const SUBS_SCRAPE_BUDGET_MS = 90 * 1000;
export const SUBS_SCRAPE_INTERVAL_MS = 1000;
export const SUBS_STABLE_ATTEMPTS = 3;
export const SUBS_CONTINUATION_SELECTOR =
  'ytd-continuation-item-renderer';

const EMPTY_DIAGNOSTICS = {
  finalNameCount: 0,
  initialNameCount: 0,
  bottomReached: false,
  elapsedMs: 0,
  scrollAttempts: 0,
  continuationPresent: null,
};

function warnFailure(reason, error) {
  if (error === undefined) {
    console.warn(`[youtube-tuner] ${reason}`);
  } else {
    console.warn(`[youtube-tuner] ${reason}`, error);
  }
}

function scrollHeight(documentObject) {
  return Math.max(
    documentObject?.documentElement?.scrollHeight || 0,
    documentObject?.body?.scrollHeight || 0,
  );
}

function atBottom(windowObject, height) {
  return (
    Number.isFinite(windowObject?.scrollY) &&
    Number.isFinite(windowObject?.innerHeight) &&
    Math.ceil(windowObject.scrollY + windowObject.innerHeight) >= height
  );
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findContinuationElement(documentObject) {
  return documentObject.querySelector(SUBS_CONTINUATION_SELECTOR);
}

function continuationState(documentObject, getContinuationElement) {
  try {
    const element = getContinuationElement(documentObject);
    return {
      element,
      present: element !== null && element !== undefined,
      error: undefined,
    };
  } catch (error) {
    return { element: null, present: null, error };
  }
}

function scrapeResult({
  names,
  complete,
  reason,
  initialNameCount,
  bottomReached,
  startedAt,
  now,
  scrollAttempts,
  continuationPresent,
}) {
  const result = {
    names,
    complete,
    diagnostics: {
      finalNameCount: names.length,
      initialNameCount,
      bottomReached,
      elapsedMs: Math.max(0, now() - startedAt),
      scrollAttempts,
      continuationPresent,
    },
  };
  if (reason !== undefined) result.reason = reason;
  return result;
}

function incomplete(reason, context, error) {
  warnFailure(reason, error);
  return scrapeResult({
    ...context,
    complete: false,
    reason,
  });
}

function incompleteAtBudget(
  documentObject,
  context,
  getContinuationElement,
  reasonWithoutContinuation = 'count-unstable',
) {
  const continuation = continuationState(
    documentObject,
    getContinuationElement,
  );
  if (continuation.present === null) {
    return incomplete(
      'doc-inaccessible',
      { ...context, continuationPresent: null },
      continuation.error,
    );
  }
  return incomplete(
    continuation.present ? 'budget-expired' : reasonWithoutContinuation,
    { ...context, continuationPresent: continuation.present },
  );
}

export async function collectSubscriptions({
  documentObject = globalThis.document,
  windowObject = globalThis.window,
  extractNames = extractSubscriptionNames,
  now = Date.now,
  pause = wait,
  startedAt = now(),
  budgetMs = SUBS_SCRAPE_BUDGET_MS,
  intervalMs = SUBS_SCRAPE_INTERVAL_MS,
  stableAttemptsRequired = SUBS_STABLE_ATTEMPTS,
  getContinuationElement = findContinuationElement,
} = {}) {
  let names = [];
  let initialNameCount = 0;
  let bottomReached = false;
  let scrollAttempts = 0;
  const resultContext = (continuationPresent = null) => ({
    names,
    initialNameCount,
    bottomReached,
    startedAt,
    now,
    scrollAttempts,
    continuationPresent,
  });

  if (!windowObject || !documentObject) {
    return incomplete('doc-inaccessible', resultContext());
  }

  try {
    names = extractNames(documentObject);
    initialNameCount = names.length;
    let initialHeight = scrollHeight(documentObject);
    let initialStableAttempts = 0;

    while (initialStableAttempts < stableAttemptsRequired) {
      const remaining = budgetMs - (now() - startedAt);
      if (remaining <= 0) {
        return incompleteAtBudget(
          documentObject,
          resultContext(),
          getContinuationElement,
        );
      }
      await pause(Math.min(intervalMs, remaining));
      if (now() - startedAt >= budgetMs) {
        names = extractNames(documentObject);
        return incompleteAtBudget(
          documentObject,
          resultContext(),
          getContinuationElement,
        );
      }

      const nextNames = extractNames(documentObject);
      const nextHeight = scrollHeight(documentObject);
      if (
        nextNames.length > 0 &&
        nextNames.length === names.length &&
        nextHeight === initialHeight
      ) {
        initialStableAttempts += 1;
      } else {
        initialStableAttempts = 0;
      }
      names = nextNames;
      initialHeight = nextHeight;
    }

    let previousCount = names.length;
    let previousHeight = initialHeight;
    let stableAttempts = 0;

    while (now() - startedAt < budgetMs) {
      scrollAttempts += 1;
      const continuation = continuationState(
        documentObject,
        getContinuationElement,
      );
      if (continuation.present === null) {
        return incomplete(
          'doc-inaccessible',
          resultContext(),
          continuation.error,
        );
      }
      if (continuation.present) {
        continuation.element.scrollIntoView();
      } else {
        windowObject.scrollTo(0, previousHeight);
      }

      const remaining = budgetMs - (now() - startedAt);
      if (remaining <= 0) break;
      await pause(Math.min(intervalMs, remaining));
      if (now() - startedAt >= budgetMs) {
        names = extractNames(documentObject);
        break;
      }

      names = extractNames(documentObject);
      const height = scrollHeight(documentObject);
      const reachedThisAttempt = atBottom(windowObject, height);
      bottomReached ||= reachedThisAttempt;

      if (
        names.length === previousCount &&
        height === previousHeight &&
        reachedThisAttempt
      ) {
        stableAttempts += 1;
      } else {
        stableAttempts = 0;
      }

      previousCount = names.length;
      previousHeight = height;

      if (stableAttempts >= stableAttemptsRequired) {
        const finalContinuation = continuationState(
          documentObject,
          getContinuationElement,
        );
        if (finalContinuation.present === null) {
          return incomplete(
            'doc-inaccessible',
            resultContext(),
            finalContinuation.error,
          );
        }
        if (finalContinuation.present) {
          return incomplete('continuation-present', resultContext(true));
        }
        if (names.length === 0) {
          return incomplete('empty-names', resultContext(false));
        }
        if (!bottomReached) {
          return incomplete('bottom-not-reached', resultContext(false));
        }
        if (now() - startedAt >= budgetMs) {
          return incompleteAtBudget(
            documentObject,
            resultContext(),
            getContinuationElement,
          );
        }

        return scrapeResult({
          ...resultContext(false),
          complete: true,
        });
      }
    }

    return incompleteAtBudget(
      documentObject,
      resultContext(),
      getContinuationElement,
      bottomReached ? 'count-unstable' : 'bottom-not-reached',
    );
  } catch (error) {
    const continuation = continuationState(
      documentObject,
      getContinuationElement,
    );
    return incomplete(
      'scrape-exception',
      resultContext(continuation.present),
      error,
    );
  }
}

export async function saveCompleteSubscriptionResult(
  result,
  save = saveSubs,
) {
  if (
    result?.complete !== true ||
    !Array.isArray(result.names) ||
    result.names.length === 0
  ) {
    return false;
  }
  await save(result.names);
  return true;
}

async function claimCollectionAttempt({
  storage,
  now,
  force,
}) {
  if (!force) {
    const stored = await storage.get(SUBS_REFRESH_ATTEMPTED_KEY);
    const attemptedAt = stored[SUBS_REFRESH_ATTEMPTED_KEY];
    if (
      Number.isFinite(attemptedAt) &&
      now - attemptedAt < SUBS_REFRESH_RETRY_MS
    ) {
      return false;
    }
  }
  await storage.set({ [SUBS_REFRESH_ATTEMPTED_KEY]: now });
  return true;
}

export async function requestSubscriptionCollection({
  storage = chrome.storage.local,
  now = Date.now(),
  force = false,
  collect = collectSubscriptions,
  save = saveSubs,
} = {}) {
  if (!(await claimCollectionAttempt({ storage, now, force }))) {
    return {
      names: [],
      complete: false,
      reason: 'refresh-throttled',
      diagnostics: { ...EMPTY_DIAGNOSTICS },
    };
  }

  const result = await collect();
  await saveCompleteSubscriptionResult(result, save);
  return result;
}

export function observeSubscriptionList({
  documentObject = globalThis.document,
  extractNames = extractSubscriptionNames,
  getContinuationElement = findContinuationElement,
  now = Date.now,
  startedAt = now(),
  budgetMs = SUBS_SCRAPE_BUDGET_MS,
  intervalMs = SUBS_SCRAPE_INTERVAL_MS,
  stableAttemptsRequired = SUBS_STABLE_ATTEMPTS,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
  MutationObserverObject =
    documentObject?.defaultView?.MutationObserver ??
    globalThis.MutationObserver,
  save = saveSubs,
  onComplete = () => {},
  onError = (error) => warnFailure('passive-collection-failed', error),
} = {}) {
  let active = true;
  let observer = null;
  let timer = null;
  let budgetTimer = null;
  let names = [];
  let initialNameCount = 0;
  let previousCount = null;
  let previousHeight = null;
  let previousContinuationPresent = null;
  let stableAttempts = 0;

  function stop() {
    if (!active) return;
    active = false;
    observer?.disconnect();
    observer = null;
    if (timer !== null) cancelTimeout(timer);
    if (budgetTimer !== null) cancelTimeout(budgetTimer);
    timer = null;
    budgetTimer = null;
  }

  function scheduleCheck() {
    if (!active || timer !== null) return;
    timer = scheduleTimeout(() => {
      timer = null;
      check();
    }, intervalMs);
  }

  function check() {
    if (!active) return;
    if (now() - startedAt >= budgetMs) {
      stop();
      return;
    }

    try {
      names = extractNames(documentObject);
      if (previousCount === null) initialNameCount = names.length;
      const height = scrollHeight(documentObject);
      const continuation = continuationState(
        documentObject,
        getContinuationElement,
      );
      if (continuation.present === null) {
        throw continuation.error;
      }

      if (
        !continuation.present &&
        previousContinuationPresent === false &&
        names.length > 0 &&
        names.length === previousCount &&
        height === previousHeight
      ) {
        stableAttempts += 1;
      } else {
        stableAttempts = 0;
      }
      previousCount = names.length;
      previousHeight = height;
      previousContinuationPresent = continuation.present;

      if (stableAttempts >= stableAttemptsRequired) {
        const result = scrapeResult({
          names,
          complete: true,
          initialNameCount,
          bottomReached: true,
          startedAt,
          now,
          scrollAttempts: 0,
          continuationPresent: false,
        });
        stop();
        void saveCompleteSubscriptionResult(result, save)
          .then(() => onComplete(result))
          .catch(onError);
        return;
      }
      scheduleCheck();
    } catch (error) {
      stop();
      onError(error);
    }
  }

  if (!documentObject?.documentElement || !MutationObserverObject) {
    onError(new Error('Subscription document is unavailable'));
    return { stop, check, isActive: () => false };
  }

  observer = new MutationObserverObject(scheduleCheck);
  observer.observe(documentObject.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  budgetTimer = scheduleTimeout(stop, budgetMs);
  check();

  return { stop, check, isActive: () => active };
}

export async function requestPassiveSubscriptionCollection({
  storage = chrome.storage.local,
  now = Date.now(),
  observe = observeSubscriptionList,
  ...observeOptions
} = {}) {
  if (!(await claimCollectionAttempt({ storage, now, force: false }))) {
    return null;
  }
  return observe(observeOptions);
}
