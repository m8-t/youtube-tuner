// The budget and the log for feedback that YouTube stores in the Google
// account ("Not interested", "Don't recommend channel"). Many such signals
// narrowed a real feed to a few channels (issue #1), so every one goes
// through here: counted against a weekly limit and written down.
const LEDGER_KEY = 'feedbackLedger';
const QUEUE_KEY = 'feedbackQueue';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LEDGER_CAP = 200;

export const MAX_WEEKLY_LIMIT = 20;
export const FEEDBACK_ACTIONS = Object.freeze([
  'notInterested',
  'dontRecommendChannel',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeLedger(value) {
  if (!Array.isArray(value)) return [];
  const ledger = [];
  for (const entry of value) {
    if (
      !isObject(entry)
      || typeof entry.id !== 'string'
      || !Number.isSafeInteger(entry.at)
      || !FEEDBACK_ACTIONS.includes(entry.action)
    ) {
      continue;
    }
    ledger.push({
      id: entry.id,
      at: entry.at,
      action: entry.action,
      videoId: typeof entry.videoId === 'string' ? entry.videoId : '',
      channelName: typeof entry.channelName === 'string'
        ? entry.channelName
        : '',
    });
  }
  return ledger.slice(-LEDGER_CAP);
}

export function effectiveWeeklyLimit(limit) {
  if (!Number.isFinite(limit)) return 0;
  return Math.max(0, Math.min(MAX_WEEKLY_LIMIT, Math.floor(limit)));
}

export function usedThisWeek(ledger, now = Date.now()) {
  return ledger.filter((entry) => entry.at > now - WEEK_MS && entry.at <= now)
    .length;
}

export async function loadLedger() {
  try {
    const got = await chrome.storage.local.get(LEDGER_KEY);
    return normalizeLedger(got[LEDGER_KEY]);
  } catch {
    return [];
  }
}

export async function feedbackBudget({ limit, now = Date.now() } = {}) {
  const used = usedThisWeek(await loadLedger(), now);
  const cap = effectiveWeeklyLimit(limit);
  return { used, limit: cap, remaining: Math.max(0, cap - used) };
}

// Books one signal before it is sent. The caller releases it again if
// YouTube's menu did not take the action.
export async function reserveFeedback({
  action,
  videoId = '',
  channelName = '',
  limit,
  now = Date.now(),
  createId = () => globalThis.crypto.randomUUID(),
} = {}) {
  const cap = effectiveWeeklyLimit(limit);
  if (!FEEDBACK_ACTIONS.includes(action)) {
    return { ok: false, reason: 'unknown-action', used: 0, limit: cap };
  }
  const ledger = await loadLedger();
  const used = usedThisWeek(ledger, now);
  if (used >= cap) return { ok: false, reason: 'budget', used, limit: cap };

  const id = createId();
  ledger.push({ id, at: now, action, videoId, channelName });
  await chrome.storage.local.set({
    [LEDGER_KEY]: ledger.slice(-LEDGER_CAP),
  });
  return { ok: true, id, used: used + 1, limit: cap };
}

export async function releaseFeedback(id) {
  const ledger = await loadLedger();
  const next = ledger.filter((entry) => entry.id !== id);
  if (next.length === ledger.length) return false;
  await chrome.storage.local.set({ [LEDGER_KEY]: next });
  return true;
}

// Channels the user marked in the options: "tell YouTube the next time one of
// its videos shows up".
export async function loadFeedbackQueue() {
  try {
    const got = await chrome.storage.local.get(QUEUE_KEY);
    return Array.isArray(got[QUEUE_KEY])
      ? [...new Set(got[QUEUE_KEY].filter((name) => typeof name === 'string'))]
      : [];
  } catch {
    return [];
  }
}

export async function setFeedbackQueued(channelName, queued) {
  const queue = (await loadFeedbackQueue())
    .filter((name) => name !== channelName);
  if (queued) queue.push(channelName);
  await chrome.storage.local.set({ [QUEUE_KEY]: queue });
}
