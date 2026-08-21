import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadFixture, html } from './helpers/dom.js';
import { readTile, isOutermostTile, TILE_SELECTOR } from '../src/dom/tile-adapter.js';
import { parseAge } from '../src/locale/parse-age.js';
import { parseViews } from '../src/locale/parse-views.js';
import { decide } from '../src/rules/decide.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

function tilesFrom(doc) {
  return [...doc.querySelectorAll(TILE_SELECTOR)].map(readTile).filter(Boolean);
}

test('every english fixture tile parses completely', () => {
  const tiles = tilesFrom(loadFixture('sidebar-en.html', 'en'));
  assert.equal(tiles.length, 6);
  for (const t of tiles) {
    assert.ok(t.videoId, 'videoId');
    assert.ok(t.title, `title for ${t.videoId}`);
    assert.ok(t.channelName, `channelName for ${t.videoId}`);
    assert.ok(t.ageText, `ageText for ${t.videoId}`);
    assert.ok(t.viewText, `viewText for ${t.videoId}`);
  }
});

test('every german fixture tile parses completely', () => {
  const tiles = tilesFrom(loadFixture('sidebar-de.html', 'de'));
  assert.equal(tiles.length, 6);
  for (const t of tiles) {
    assert.ok(
      t.videoId && t.title && t.channelName && t.ageText && t.viewText,
      t.videoId,
    );
  }
});

test('reads known values from the english fixture', () => {
  const tiles = tilesFrom(loadFixture('sidebar-en.html', 'en'));
  const tile = tiles.find((t) => t.videoId === 'MXwFU7n9HhM');
  assert.equal(tile.channelName, 'AlmondTheArtist');
  assert.equal(tile.ageText, '3 months ago');
  assert.equal(tile.viewText, '3.4 million views');
});

test('reads known values from the german fixture', () => {
  const tiles = tilesFrom(loadFixture('sidebar-de.html', 'de'));
  const tile = tiles.find((t) => t.videoId === '7JV7yHNQjm4');
  assert.equal(tile.title, 'Ein Tag im ärmsten Dorf Deutschlands');
  assert.equal(tile.channelName, 'Wissenswert');
  assert.equal(tile.ageText, 'vor 10 Monaten');
  assert.equal(tile.viewText, '758.038 Aufrufe');
});

test('home fixture wrapped lockup yields exactly one tile', () => {
  const tiles = tilesFrom(loadFixture('home-de.html', 'de'));
  assert.equal(tiles.length, 1);
});

test('reads the video ID from the german home fixture', () => {
  const [tile] = tilesFrom(loadFixture('home-de.html', 'de'));
  assert.equal(tile.videoId, 'pHLiSo7f5V0');
});

test('reads the real title from the german home fixture heading', () => {
  const doc = loadFixture('home-de.html', 'de');
  const [tile] = tilesFrom(doc);
  const fixtureTitle = doc
    .querySelector('.ytLockupMetadataViewModelHeadingReset')
    .getAttribute('title');
  assert.ok(fixtureTitle);
  assert.equal(tile.title, fixtureTitle);
});

test('reads the channel name from the german home fixture aria-label', () => {
  const [tile] = tilesFrom(loadFixture('home-de.html', 'de'));
  assert.equal(tile.channelName, 'Digging The Greats');
});

test('parses the age from the german home fixture', () => {
  const [tile] = tilesFrom(loadFixture('home-de.html', 'de'));
  const threeYears = Math.round(3 * 365.25 * 24 * 60 * 60 * 1000);
  assert.equal(parseAge(tile.ageText, 'de'), threeYears);
});

test('parses the view count from visible german home metadata', () => {
  const [tile] = tilesFrom(loadFixture('home-de.html', 'de'));
  assert.equal(parseViews(tile.viewText, 'de'), 430502);
});

test('reads watched state and metadata from the watched german home fixture', () => {
  const tiles = tilesFrom(loadFixture('home-de-watched.html', 'de'));
  assert.equal(tiles.length, 1);

  const [tile] = tiles;
  assert.equal(tile.videoId, 'y2IxMpAZum8');
  assert.equal(tile.channelName, 'Bibliothek der Sachgeschichten');
  assert.equal(tile.hasResumeBar, true);
  assert.equal(parseViews(tile.viewText, 'de'), 307812);

  const sixYears = Math.round(6 * 365.25 * 24 * 60 * 60 * 1000);
  const parsedAge = parseAge(tile.ageText, 'de');
  assert.ok(Math.abs(parsedAge - sixYears) < 24 * 60 * 60 * 1000);
});

test('non-watched german home fixture has no resume bar', () => {
  const [tile] = tilesFrom(loadFixture('home-de.html', 'de'));
  assert.equal(tile.hasResumeBar, false);
});

test('real watched tile is hidden as watched before the age rule', () => {
  const [tile] = tilesFrom(loadFixture('home-de-watched.html', 'de'));
  const state = {
    subs: new Set(),
    blocklist: new Set(),
    watched: new Set(),
    locale: 'de',
  };

  assert.deepEqual(decide(tile, DEFAULT_CONFIG, state), {
    hide: true,
    reason: 'watched',
  });
});

// Collaboration videos carry aria-label="Collaboration channels" instead of
// "Go to channel X", so the name comes from the first metadata row.
test('collaboration videos still yield a channel name', () => {
  const tiles = tilesFrom(loadFixture('sidebar-en.html', 'en'));
  const tile = tiles.find((t) => t.videoId === 'kGVgXHv_KWo');
  assert.equal(tile.channelName, 'KSI and Erling Haaland');
});

// A grid tile is ytd-rich-item-renderer wrapping yt-lockup-view-model 1:1.
// Counting both would double every grid video and skew the hidden/visible
// ratio that the starvation nudge and the badge depend on.
test('NESTING: a wrapped lockup yields exactly one tile', () => {
  const doc = html(`
    <ytd-rich-item-renderer>
      <yt-lockup-view-model>
        <a href="/watch?v=abc12345678"></a>
        <span aria-label="3 months ago"></span>
        <span aria-label="1.2 million views"></span>
        <a aria-label="Go to channel Test Channel"></a>
      </yt-lockup-view-model>
    </ytd-rich-item-renderer>`);
  assert.equal(doc.querySelectorAll(TILE_SELECTOR).length, 2, 'both should match');
  assert.equal(tilesFrom(doc).length, 1, 'but only one should be read');
});

test('isOutermostTile rejects a nested tile', () => {
  const doc = html(
    '<ytd-rich-item-renderer><yt-lockup-view-model></yt-lockup-view-model></ytd-rich-item-renderer>'
  );
  assert.equal(isOutermostTile(doc.querySelector('ytd-rich-item-renderer')), true);
  assert.equal(isOutermostTile(doc.querySelector('yt-lockup-view-model')), false);
});

test('a tile with no video link returns null', () => {
  const doc = html('<yt-lockup-view-model><span>an ad</span></yt-lockup-view-model>');
  assert.equal(readTile(doc.querySelector('yt-lockup-view-model')), null);
});

test('missing metadata yields nulls, not a throw', () => {
  const doc = html(
    '<yt-lockup-view-model><a href="/watch?v=eeeeeeeeeee"></a></yt-lockup-view-model>'
  );
  const tile = readTile(doc.querySelector('yt-lockup-view-model'));
  assert.equal(tile.videoId, 'eeeeeeeeeee');
  assert.equal(tile.title, null);
  assert.deepEqual(tile.titles, []);
  assert.equal(tile.channelName, null);
  assert.equal(tile.ageText, null);
  assert.equal(tile.viewText, null);
});

test('visible title wins while every distinct title candidate is retained', () => {
  const visibleTitle =
    'American Reacts to Brazil 1-7 Germany | World Cup Shock';
  const attributeTitle =
    "American Watches Football's Most Humiliating Night";
  const doc = html(`
    <yt-lockup-view-model>
      <a href="/watch?v=splitttitle"></a>
      <h3 class="ytLockupMetadataViewModelHeadingReset"
          title="${attributeTitle}">
        <a class="ytLockupMetadataViewModelTitle"
           title="  ${visibleTitle}  ">${visibleTitle}</a>
      </h3>
    </yt-lockup-view-model>
  `);

  const tile = readTile(doc.querySelector('yt-lockup-view-model'));
  assert.equal(tile.title, visibleTitle);
  assert.deepEqual(tile.titles, [visibleTitle, attributeTitle]);
});

test('legacy renderers prefer visible title text over a title attribute', () => {
  const doc = html(`
    <ytd-video-renderer>
      <a href="/watch?v=legacytitle"></a>
      <a id="video-title" title="  Complete legacy title  ">Short title</a>
    </ytd-video-renderer>
  `);
  assert.equal(
    readTile(doc.querySelector('ytd-video-renderer')).title,
    'Short title',
  );
});

test('legacy renderers fall back to trimmed visible title text', () => {
  const doc = html(`
    <ytd-video-renderer>
      <a href="/watch?v=legacytext1"></a>
      <a id="video-title">  Visible legacy title  </a>
    </ytd-video-renderer>
  `);
  assert.equal(
    readTile(doc.querySelector('ytd-video-renderer')).title,
    'Visible legacy title',
  );
});

test('attribute-only and text-only tiles each expose a one-element title array', () => {
  const doc = html(`
    <yt-lockup-view-model id="attribute-only">
      <a href="/watch?v=attronly001"></a>
      <a class="ytLockupMetadataViewModelTitle" title="  Attribute title  "></a>
    </yt-lockup-view-model>
    <yt-lockup-view-model id="text-only">
      <a href="/watch?v=textonly001"></a>
      <a class="ytLockupMetadataViewModelTitle">  Visible title  </a>
    </yt-lockup-view-model>
  `);

  const attributeTile = readTile(doc.getElementById('attribute-only'));
  assert.equal(attributeTile.title, 'Attribute title');
  assert.deepEqual(attributeTile.titles, ['Attribute title']);

  const textTile = readTile(doc.getElementById('text-only'));
  assert.equal(textTile.title, 'Visible title');
  assert.deepEqual(textTile.titles, ['Visible title']);
});

test('garbage input returns null instead of throwing', () => {
  assert.equal(readTile(null), null);
  assert.equal(readTile(undefined), null);
  assert.equal(readTile({}), null);
});
