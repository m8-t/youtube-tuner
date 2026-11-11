// The "Blocked channels", "Hidden videos" and "YouTube feedback" sections.
import {
  addBlocked,
  loadBlockMeta,
  loadBlocklist,
  removeBlocked,
  snoozeBlocked,
} from '../storage/blocklist.js';
import {
  isPersistent,
  isUnseen,
  loadBlockStats,
} from '../storage/block-stats.js';
import {
  feedbackBudget,
  loadFeedbackQueue,
  loadLedger,
  setFeedbackQueued,
} from '../storage/feedback.js';
import { clearHidden, loadHidden } from '../storage/hidden.js';
import { loadConfig } from '../storage/config.js';
import { el } from './dom.js';

const ACTION_LABELS = {
  notInterested: 'Not interested',
  dontRecommendChannel: "Don't recommend channel",
};

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function actionButton(label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await onClick();
    } finally {
      await renderBlocklist();
    }
  });
  return button;
}

function seenText(entry) {
  if (!entry) return 'not seen since it was blocked';
  const dayLabel = entry.days === 1 ? 'day' : 'days';
  const videoLabel = entry.hits === 1 ? 'video' : 'videos';
  return `${entry.hits} ${videoLabel} hidden on ${entry.days} ${dayLabel}, ` +
    `last on ${formatDate(entry.lastSeen)}`;
}

export async function renderBlocklist({ now = Date.now() } = {}) {
  const [blocklist, meta, stats, queue, config] = await Promise.all([
    loadBlocklist(),
    loadBlockMeta(),
    loadBlockStats(),
    loadFeedbackQueue(),
    loadConfig(),
  ]);
  const names = [...blocklist].sort((a, b) => a.localeCompare(b));
  const feedbackOn = config.feedback?.enabled === true;
  const rows = el('block-rows');
  rows.textContent = '';
  el('blocklist-empty').hidden = names.length > 0;
  el('block-table').hidden = names.length === 0;

  const persistent = [];
  const unseen = [];
  for (const name of names) {
    const entry = meta.get(name);
    const seen = stats[name];
    const snoozed = Number.isFinite(entry?.until);
    const isQueued = queue.includes(name);
    if (isPersistent(seen, now)) persistent.push(name);
    if (isUnseen(seen, entry?.addedAt, now)) unseen.push(name);

    const row = document.createElement('tr');
    row.append(
      cell(name),
      cell(entry?.handles?.length > 0 ? entry.handles.join(', ') : 'by name'),
      cell(snoozed ? `until ${formatDate(entry.until)}` : 'permanent'),
      cell(seenText(seen) + (isPersistent(seen, now) ? ' - keeps coming back' : '')),
    );

    const actions = document.createElement('td');
    actions.append(actionButton('Unblock', async () => {
      await removeBlocked(name);
      await setFeedbackQueued(name, false);
    }));
    // The click decides the time, not the moment the table was drawn.
    actions.append(snoozed
      ? actionButton('Make permanent', () => addBlocked(name))
      : actionButton('30 days only', () => snoozeBlocked(name)));
    if (feedbackOn) {
      actions.append(actionButton(
        isQueued ? 'Do not tell YouTube' : 'Tell YouTube next time',
        () => setFeedbackQueued(name, !isQueued),
      ));
    }
    row.append(actions);
    rows.append(row);
  }

  const persistentNote = el('block-persistent');
  persistentNote.hidden = persistent.length === 0;
  persistentNote.textContent = persistent.length === 0
    ? ''
    : `YouTube keeps recommending ${persistent.length === 1 ? 'this blocked channel' : 'these blocked channels'}: ` +
      `${persistent.join(', ')}. Hiding them costs feed slots every day.` +
      (feedbackOn
        ? ' "Tell YouTube next time" sends one "Not interested" for the channel, inside your weekly limit.'
        : ' If you want YouTube to know, turn on YouTube feedback below.');

  const unseenNote = el('block-unseen');
  unseenNote.hidden = unseen.length === 0;
  el('block-prune').hidden = unseen.length === 0;
  unseenNote.textContent = unseen.length === 0
    ? ''
    : `${unseen.length} blocked ${unseen.length === 1 ? 'channel has' : 'channels have'} not shown up for 180 days: ${unseen.join(', ')}.`;
  return { names, persistent, unseen };
}

export async function pruneUnseenBlocks({ now = Date.now() } = {}) {
  const { unseen } = await renderBlocklist({ now });
  for (const name of unseen) {
    await removeBlocked(name);
    await setFeedbackQueued(name, false);
  }
  await renderBlocklist({ now });
  return unseen;
}

export async function renderHidden() {
  const hidden = await loadHidden();
  el('hidden-count').textContent =
    `${hidden.size} ${hidden.size === 1 ? 'video' : 'videos'} hidden by hand. `;
  return hidden.size;
}

export async function renderFeedback({ now = Date.now() } = {}) {
  const config = await loadConfig();
  const [budget, ledger] = await Promise.all([
    feedbackBudget({ limit: config.feedback?.weeklyLimit, now }),
    loadLedger(),
  ]);
  el('feedback-status').textContent = config.feedback?.enabled === true
    ? `Used this week: ${budget.used} of ${budget.limit}.`
    : 'Off. Nothing is sent to YouTube.';

  const list = el('feedback-ledger');
  list.textContent = '';
  el('feedback-ledger-empty').hidden = ledger.length > 0;
  for (const entry of [...ledger].reverse()) {
    const item = document.createElement('li');
    item.textContent = [
      new Date(entry.at).toLocaleString(),
      ACTION_LABELS[entry.action] ?? entry.action,
      entry.channelName || 'unknown channel',
      entry.videoId ? `video ${entry.videoId}` : '',
    ].filter(Boolean).join(' - ');
    list.append(item);
  }
  return { budget, entries: ledger.length };
}

export function setupBlocksUi({ now = () => Date.now() } = {}) {
  el('block-prune').addEventListener('click', async () => {
    await pruneUnseenBlocks({ now: now() });
  });
  el('hidden-clear').addEventListener('click', async () => {
    await clearHidden();
    await renderHidden();
  });
}
