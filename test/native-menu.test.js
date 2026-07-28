import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  MENU_STRINGS,
  runNativeMenuAction,
} from '../src/dom/native-menu.js';

const MENU_LABELS = [
  'In die Wiedergabeliste',
  'Zu „Später ansehen“ hinzufügen',
  'Zu Playlist hinzufügen',
  'Herunterladen',
  'Teilen',
  'Kein Interesse',
  'Keine Videos von diesem Kanal empfehlen',
  'Melden',
];

function tileMarkup() {
  return `
    <yt-lockup-view-model id="tile">
      <div class="ytLockupMetadataViewModelMenuButton">
        <button id="trigger" type="button"></button>
      </div>
    </yt-lockup-view-model>
  `;
}

function popupMarkup(labels = MENU_LABELS) {
  return labels.map((label, index) => `
    <yt-list-item-view-model
      class="ytListItemViewModelHost"
      role="menuitem"
      data-row="${index + 1}"
    >${label}</yt-list-item-view-model>
  `).join('');
}

function appendPopup(doc, labels = MENU_LABELS) {
  const popup = doc.createElement('div');
  popup.innerHTML = popupMarkup(labels);
  doc.body.appendChild(popup);
  return [...popup.querySelectorAll('[role="menuitem"]')];
}

function trackRowClicks(rows) {
  const clicked = [];
  for (const row of rows) {
    row.addEventListener('click', () => clicked.push(Number(row.dataset.row)));
  }
  return clicked;
}

function setupPopupOnTrigger(labels = MENU_LABELS) {
  const doc = html(tileMarkup());
  let rows = [];
  let clicked = [];
  doc.querySelector('#trigger').addEventListener('click', () => {
    rows = appendPopup(doc, labels);
    clicked = trackRowClicks(rows);
  });
  return {
    doc,
    tile: doc.querySelector('#tile'),
    getRows: () => rows,
    getClicked: () => clicked,
  };
}

test('native menu clicks exact "Kein Interesse" match on row 6 only', async () => {
  const { doc, tile, getClicked } = setupPopupOnTrigger();

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.deepEqual(getClicked(), [6]);
});

test('native menu clicks exact channel recommendation match on row 7', async () => {
  const { doc, tile, getClicked } = setupPopupOnTrigger();

  const acted = await runNativeMenuAction({
    tile,
    action: 'dontRecommendChannel',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.deepEqual(getClicked(), [7]);
});

test('native menu no-match clicks no rows and never clicks "Melden"', async () => {
  const labels = [...MENU_LABELS];
  labels[5] = 'Kein Interesse!';
  const { doc, tile, getRows, getClicked } = setupPopupOnTrigger(labels);

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  const reportRow = getRows().find((row) => row.textContent.trim() === 'Melden');
  assert.equal(acted, false);
  assert.deepEqual(getClicked(), []);
  assert.ok(reportRow);
  assert.ok(!getClicked().includes(Number(reportRow.dataset.row)));
  assert.deepEqual(MENU_STRINGS.notInterested, [
    'Kein Interesse',
    'Not interested',
  ]);
});

test('native menu timeout sends Escape and clicks no menu rows', async () => {
  const doc = html(tileMarkup());
  const tile = doc.querySelector('#tile');
  let escapeCount = 0;
  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') escapeCount += 1;
  });

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
    timeoutMs: 20,
    pollIntervalMs: 5,
  });

  assert.equal(acted, false);
  assert.equal(escapeCount, 1);
  assert.equal(doc.querySelectorAll('[role="menuitem"]').length, 0);
});

test('native menu refuses a concurrent action without disrupting the first', async () => {
  const doc = html(tileMarkup());
  const tile = doc.querySelector('#tile');
  let triggerClicks = 0;
  let clicked = [];
  doc.querySelector('#trigger').addEventListener('click', () => {
    triggerClicks += 1;
    setTimeout(() => {
      clicked = trackRowClicks(appendPopup(doc));
    }, 10);
  });

  const first = runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
    timeoutMs: 100,
    pollIntervalMs: 5,
  });
  const second = await runNativeMenuAction({
    tile,
    action: 'dontRecommendChannel',
    doc,
    isVisible: () => true,
    timeoutMs: 100,
    pollIntervalMs: 5,
  });

  assert.equal(second, false);
  assert.equal(await first, true);
  assert.equal(triggerClicks, 1);
  assert.deepEqual(clicked, [6]);
});
