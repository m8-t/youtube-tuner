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

  assert.deepEqual(reports, [{
    hidden: 0,
    visible: 2,
    totalMatchedTiles: 2,
    nullChannelNameTiles: 2,
  }]);
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
