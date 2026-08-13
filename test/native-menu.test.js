import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  MENU_CLOAK_CLASS,
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
  return labels.map((label) => `
    <yt-list-item-view-model class="ytListItemViewModelHost"><button class="ytButtonOrAnchorHost ytButtonOrAnchorButton ytListItemViewModelButtonOrAnchor ytListItemViewModelTextWrapper" role="menuitem">${label}</button></yt-list-item-view-model>
  `).join('');
}

function legacyPopupMarkup(labels = MENU_LABELS) {
  return labels.map((label) => `
    <yt-list-item-view-model class="ytListItemViewModelHost" role="menuitem">${label}</yt-list-item-view-model>
  `).join('');
}

function nestedPopupMarkup(labels = MENU_LABELS) {
  return labels.map((label) => `
    <yt-list-item-view-model class="ytListItemViewModelHost" role="menuitem"><button class="ytButtonOrAnchorHost ytButtonOrAnchorButton ytListItemViewModelButtonOrAnchor ytListItemViewModelTextWrapper" role="menuitem">${label}</button></yt-list-item-view-model>
  `).join('');
}

function appendPopup(doc, labels = MENU_LABELS, markup = popupMarkup) {
  const popup = doc.createElement('div');
  popup.innerHTML = markup(labels);
  doc.body.appendChild(popup);
  return [...popup.querySelectorAll('yt-list-item-view-model')].map((host) => (
    host.querySelector('[role="menuitem"]') ?? host
  ));
}

function trackRowClicks(rows) {
  const clicked = [];
  for (const [index, row] of rows.entries()) {
    row.addEventListener('click', () => clicked.push(index + 1));
  }
  return clicked;
}

function setupPopupOnTrigger(labels = MENU_LABELS, markup = popupMarkup) {
  const doc = html(tileMarkup());
  let rows = [];
  let clicked = [];
  doc.querySelector('#trigger').addEventListener('click', () => {
    rows = appendPopup(doc, labels, markup);
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

test('native menu cloak is present when the matching row is clicked', async () => {
  const { doc, tile, getRows } = setupPopupOnTrigger();
  let wasCloakedWhenClicked = false;
  doc.querySelector('#trigger').addEventListener('click', () => {
    getRows()[5].addEventListener('click', () => {
      wasCloakedWhenClicked = doc.documentElement.classList.contains(
        MENU_CLOAK_CLASS,
      );
    });
  });

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.equal(wasCloakedWhenClicked, true);
});

test('native menu cloak is removed after a successful action', async () => {
  const { doc, tile } = setupPopupOnTrigger();

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.equal(doc.documentElement.classList.contains(MENU_CLOAK_CLASS), false);
});

test('native menu cloak is removed after a failed action', async () => {
  const labels = [...MENU_LABELS];
  labels[5] = 'Kein Interesse!';
  const { doc, tile } = setupPopupOnTrigger(labels);

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, false);
  assert.equal(doc.documentElement.classList.contains(MENU_CLOAK_CLASS), false);
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

test('native menu clicks exact watch-later match on row 2', async () => {
  const { doc, tile, getClicked } = setupPopupOnTrigger();

  const acted = await runNativeMenuAction({
    tile,
    action: 'watchLater',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.deepEqual(getClicked(), [2]);
});

test('native menu still clicks a legacy host-role menu item', async () => {
  const { doc, tile, getClicked } = setupPopupOnTrigger(
    MENU_LABELS,
    legacyPopupMarkup,
  );

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.deepEqual(getClicked(), [6]);
});

test('native menu normalizes NBSP in a menu label', async () => {
  const labels = [...MENU_LABELS];
  labels[5] = 'Kein\u00a0Interesse';
  const { doc, tile, getClicked } = setupPopupOnTrigger(labels);

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.deepEqual(getClicked(), [6]);
});

test('native menu nested double match clicks exactly one item', async () => {
  const { doc, tile, getClicked } = setupPopupOnTrigger(
    MENU_LABELS,
    nestedPopupMarkup,
  );

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, true);
  assert.deepEqual(getClicked(), [6]);
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

  const rows = getRows();
  const reportRow = rows.find((row) => row.textContent.trim() === 'Melden');
  const reportRowNumber = rows.indexOf(reportRow) + 1;
  assert.equal(acted, false);
  assert.deepEqual(getClicked(), []);
  assert.ok(reportRow);
  assert.ok(!getClicked().includes(reportRowNumber));
  assert.deepEqual(MENU_STRINGS.notInterested, [
    'Kein Interesse',
    'Not interested',
  ]);
});

test('native menu timeout sends Escape from the active element and clicks no rows', async () => {
  const doc = html(tileMarkup());
  const tile = doc.querySelector('#tile');
  const trigger = doc.querySelector('#trigger');
  const escapeEvents = [];
  trigger.focus();
  for (const type of ['keydown', 'keyup']) {
    doc.addEventListener(type, (event) => {
      if (event.key === 'Escape') {
        escapeEvents.push({ type: event.type, target: event.target });
      }
    });
  }

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
    timeoutMs: 20,
    pollIntervalMs: 5,
  });

  assert.equal(acted, false);
  assert.deepEqual(escapeEvents.map(({ type }) => type), ['keydown', 'keyup']);
  assert.ok(escapeEvents.every(({ target }) => target === trigger));
  assert.equal(doc.querySelectorAll('[role="menuitem"]').length, 0);
});

test('native menu refuses to act when a menu is already open', async () => {
  const doc = html(tileMarkup());
  const tile = doc.querySelector('#tile');
  const clicked = trackRowClicks(appendPopup(doc));
  let triggerClicks = 0;
  doc.querySelector('#trigger').addEventListener('click', () => {
    triggerClicks += 1;
  });

  const acted = await runNativeMenuAction({
    tile,
    action: 'notInterested',
    doc,
    isVisible: () => true,
  });

  assert.equal(acted, false);
  assert.equal(triggerClicks, 0);
  assert.deepEqual(clicked, []);
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
