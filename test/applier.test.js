import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import { createApplier, HIDDEN_CLASS } from '../src/dom/applier.js';
import { COLLAPSED_SECTION_CLASS } from '../src/dom/empty-sections.js';
import { readTile, isOutermostTile, TILE_SELECTOR } from '../src/dom/tile-adapter.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

function tileHtml(id, videoId) {
  return `<ytd-rich-item-renderer id="${id}">
    <a id="video-title-link" href="/watch?v=${videoId}"></a>
  </ytd-rich-item-renderer>`;
}

function setup(markup, decide, onCounts = () => {}) {
  const doc = html(markup);
  const applier = createApplier({
    root: doc.body,
    decide,
    readTile,
    isOutermostTile,
    tileSelector: TILE_SELECTOR,
    getConfig: () => DEFAULT_CONFIG,
    getState: () => ({
      subs: new Set(), blocklist: new Set(), watched: new Set(), locale: 'en',
    }),
    onCounts,
  });
  return { doc, applier };
}

const hideIf = (ids) => (tile) =>
  ids.includes(tile.videoId)
    ? { hide: true, reason: 'age' }
    : { hide: false, reason: 'shown' };

test('hides tiles the engine rejects and leaves the rest alone', () => {
  const { doc, applier } = setup(
    tileHtml('a', 'video1') + tileHtml('b', 'video2'),
    hideIf(['video1'])
  );
  applier.scan();
  assert.ok(doc.querySelector('#a').classList.contains(HIDDEN_CLASS));
  assert.ok(!doc.querySelector('#b').classList.contains(HIDDEN_CLASS));
});

test('counts hidden and visible tiles', () => {
  const { applier } = setup(
    tileHtml('a', 'video1') + tileHtml('b', 'video2') + tileHtml('c', 'video3'),
    hideIf(['video1', 'video3'])
  );
  applier.scan();
  assert.deepEqual(applier.getCounts(), { hidden: 2, visible: 1 });
});

test('reports matched tiles and null channel names for each scan', () => {
  const reports = [];
  const { applier } = setup(
    tileHtml('a', 'video1') + tileHtml('b', 'video2'),
    hideIf([]),
    (counts) => reports.push(counts),
  );

  applier.scan();

  assert.equal(reports.length, 1);
  const { tiles, changed, ...numbers } = reports[0];
  assert.deepEqual(numbers, {
    hidden: 0,
    visible: 2,
    totalMatchedTiles: 2,
    nullChannelNameTiles: 2,
  });
  // The scan hands its reads on, so nothing downstream reads a tile twice.
  assert.deepEqual(tiles.map(({ tile }) => tile.videoId), ['video1', 'video2']);
  assert.equal(changed, true);
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 160));

test('SCAN COST: a mutation outside every tile triggers no scan', async () => {
  const reports = [];
  let reads = 0;
  const doc = html(`<div id="player"><span id="time">0:01</span></div>${
    tileHtml('a', 'video1')}`);
  const applier = createApplier({
    root: doc.body,
    decide: hideIf([]),
    readTile: (element) => {
      reads += 1;
      return readTile(element);
    },
    isOutermostTile,
    tileSelector: TILE_SELECTOR,
    getConfig: () => DEFAULT_CONFIG,
    getState: () => ({}),
    onCounts: (counts) => reports.push(counts),
  });
  applier.start();
  assert.equal(reports.length, 1);
  assert.equal(reads, 1);

  doc.querySelector('#time').firstChild.data = '0:02';
  doc.querySelector('#player').appendChild(doc.createElement('p'));
  await settle();

  assert.equal(reports.length, 1);
  assert.equal(reads, 1);
  applier.stop();
});

test('SCAN COST: an incremental scan reads only the tile that changed', async () => {
  const readIds = [];
  const reports = [];
  const doc = html(tileHtml('a', 'video1') + tileHtml('b', 'video2'));
  const applier = createApplier({
    root: doc.body,
    decide: hideIf(['video9']),
    readTile: (element) => {
      readIds.push(element.id);
      return readTile(element);
    },
    isOutermostTile,
    tileSelector: TILE_SELECTOR,
    getConfig: () => DEFAULT_CONFIG,
    getState: () => ({}),
    onCounts: (counts) => reports.push(counts),
  });
  applier.start();
  assert.deepEqual(readIds, ['a', 'b']);

  // YouTube recycles node b for another video.
  doc.querySelector('#b a').setAttribute('href', '/watch?v=video9');
  await settle();

  assert.deepEqual(readIds, ['a', 'b', 'b']);
  assert.ok(doc.querySelector('#b').classList.contains(HIDDEN_CLASS));
  assert.deepEqual(applier.getCounts(), { hidden: 1, visible: 1 });
  assert.equal(reports.at(-1).changed, true);
  applier.stop();
});

test('SCAN COST: a text change inside a tile makes it read again', async () => {
  const readIds = [];
  const doc = html(`<ytd-rich-item-renderer id="a">
    <a href="/watch?v=video1"></a><span id="meta">1 view</span>
  </ytd-rich-item-renderer>`);
  const applier = createApplier({
    root: doc.body,
    decide: hideIf([]),
    readTile: (element) => {
      readIds.push(element.id);
      return readTile(element);
    },
    isOutermostTile,
    tileSelector: TILE_SELECTOR,
    getConfig: () => DEFAULT_CONFIG,
    getState: () => ({}),
    onCounts: () => {},
  });
  applier.start();

  doc.querySelector('#meta').firstChild.data = '2 views';
  await settle();

  assert.deepEqual(readIds, ['a', 'a']);
  applier.stop();
});

test('SCAN COST: a newly added tile is read and a full scan reads all', async () => {
  const readIds = [];
  const doc = html(`<div id="grid">${tileHtml('a', 'video1')}</div>`);
  const applier = createApplier({
    root: doc.body,
    decide: hideIf([]),
    readTile: (element) => {
      readIds.push(element.id);
      return readTile(element);
    },
    isOutermostTile,
    tileSelector: TILE_SELECTOR,
    getConfig: () => DEFAULT_CONFIG,
    getState: () => ({}),
    onCounts: () => {},
  });
  applier.start();

  doc.querySelector('#grid').insertAdjacentElement(
    'beforeend',
    html(tileHtml('b', 'video2')).querySelector('#b'),
  );
  await settle();
  assert.deepEqual(readIds, ['a', 'b']);

  applier.scan();
  assert.deepEqual(readIds, ['a', 'b', 'a', 'b']);
  applier.stop();
});

// Regression guard. readTile returns null for a nested tile, and scan()
// treats null as "unreadable, therefore visible". Without an explicit skip
// the inner lockup would add 1 to visible, doubling every grid video.
test('NESTING: a wrapped grid tile counts once, not twice', () => {
  const { applier } = setup(
    `<ytd-rich-item-renderer id="a">
       <yt-lockup-view-model>
         <a href="/watch?v=video1"></a>
       </yt-lockup-view-model>
     </ytd-rich-item-renderer>`,
    () => ({ hide: false, reason: 'shown' })
  );
  applier.scan();
  assert.deepEqual(applier.getCounts(), { hidden: 0, visible: 1 });
});

test('NESTING: hiding a wrapped grid tile hides the outer element', () => {
  const { doc, applier } = setup(
    `<ytd-rich-item-renderer id="a">
       <yt-lockup-view-model id="inner">
         <a href="/watch?v=video1"></a>
       </yt-lockup-view-model>
     </ytd-rich-item-renderer>`,
    hideIf(['video1'])
  );
  applier.scan();
  assert.ok(doc.querySelector('#a').classList.contains(HIDDEN_CLASS));
  assert.ok(!doc.querySelector('#inner').classList.contains(HIDDEN_CLASS));
  assert.deepEqual(applier.getCounts(), { hidden: 1, visible: 0 });
});

test('RECYCLING: a hidden node reused for a new video is unhidden', () => {
  const { doc, applier } = setup(tileHtml('a', 'video1'), hideIf(['video1']));
  applier.scan();
  const node = doc.querySelector('#a');
  assert.ok(node.classList.contains(HIDDEN_CLASS));

  // YouTube recycles the node for a different video during infinite scroll.
  node.querySelector('a').setAttribute('href', '/watch?v=video2');
  applier.scan();

  assert.ok(!node.classList.contains(HIDDEN_CLASS), 'recycled node stayed hidden');
});

test('RECYCLING: a visible node reused for a rejected video gets hidden', () => {
  const { doc, applier } = setup(tileHtml('a', 'video2'), hideIf(['video1']));
  applier.scan();
  const node = doc.querySelector('#a');
  assert.ok(!node.classList.contains(HIDDEN_CLASS));

  node.querySelector('a').setAttribute('href', '/watch?v=video1');
  applier.scan();

  assert.ok(node.classList.contains(HIDDEN_CLASS));
});

test('re-scanning an unchanged tile is stable', () => {
  const { doc, applier } = setup(tileHtml('a', 'video1'), hideIf(['video1']));
  applier.scan();
  applier.scan();
  applier.scan();
  assert.ok(doc.querySelector('#a').classList.contains(HIDDEN_CLASS));
  assert.deepEqual(applier.getCounts(), { hidden: 1, visible: 0 });
});

test('an unreadable tile is shown, not hidden', () => {
  const { doc, applier } = setup(
    '<ytd-rich-item-renderer id="ad"><span>ad</span></ytd-rich-item-renderer>',
    () => { throw new Error('should not be called'); }
  );
  applier.scan();
  assert.ok(!doc.querySelector('#ad').classList.contains(HIDDEN_CLASS));
});

test('FAIL-OPEN: a throwing rule engine shows the tile', () => {
  const { doc, applier } = setup(tileHtml('a', 'video1'), () => {
    throw new Error('engine exploded');
  });
  applier.scan();
  assert.ok(!doc.querySelector('#a').classList.contains(HIDDEN_CLASS));
});

test('FAIL-OPEN: a throwing engine on one tile does not stop the others', () => {
  const { doc, applier } = setup(tileHtml('a', 'video1') + tileHtml('b', 'video2'), (t) => {
    if (t.videoId === 'video1') throw new Error('boom');
    return { hide: true, reason: 'age' };
  });
  applier.scan();
  assert.ok(!doc.querySelector('#a').classList.contains(HIDDEN_CLASS));
  assert.ok(doc.querySelector('#b').classList.contains(HIDDEN_CLASS));
});

test('stop() unhides every attached node through a DOM query', () => {
  const { doc, applier } = setup(tileHtml('a', 'video1'), hideIf([]));
  const attached = doc.querySelector('#a');
  attached.classList.add(HIDDEN_CLASS);

  applier.stop();

  assert.ok(!attached.classList.contains(HIDDEN_CLASS));
});

test('a node detached before stop is not retained or filtered after teardown', async () => {
  const { doc, applier } = setup(tileHtml('a', 'video1'), hideIf(['video1']));
  applier.start();
  const detached = doc.querySelector('#a');
  detached.remove();

  assert.doesNotThrow(() => applier.stop());
  doc.body.insertAdjacentHTML('beforeend', tileHtml('b', 'video1'));
  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.deepEqual(applier.getCounts(), { hidden: 0, visible: 0 });
  assert.ok(!doc.querySelector('#b').classList.contains(HIDDEN_CLASS));
});

test('stop() restores collapsed rich sections', () => {
  const { doc, applier } = setup(
    `${tileHtml('a', 'video1')}<ytd-rich-section-renderer id="section"></ytd-rich-section-renderer>`,
    hideIf([])
  );
  const section = doc.querySelector('#section');
  section.classList.add(COLLAPSED_SECTION_CLASS);

  applier.stop();

  assert.ok(!section.classList.contains(COLLAPSED_SECTION_CLASS));
});
