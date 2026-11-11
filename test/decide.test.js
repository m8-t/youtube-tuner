import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/rules/decide.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

const tile = (over = {}) => ({
  videoId: 'abc123',
  title: 'An ordinary video title',
  channelName: 'Some Channel',
  ageText: '2 days ago',
  viewText: '50,000 views',
  hasResumeBar: false,
  element: null,
  ...over,
});

const state = (over = {}) => ({
  subs: new Set(),
  blocklist: new Set(),
  watched: new Set(),
  locale: 'en',
  ...over,
});

test('a recent popular video from an unknown channel is shown', () => {
  assert.deepEqual(decide(tile(), DEFAULT_CONFIG, state()), {
    hide: false, reason: 'shown',
  });
});

test('master switch off shows everything', () => {
  const config = { ...DEFAULT_CONFIG, enabled: false };
  const t = tile({ ageText: '9 years ago', hasResumeBar: true });
  assert.deepEqual(decide(t, config, state()), { hide: false, reason: 'disabled' });
});

test('blocked channel wins over everything', () => {
  const s = state({ blocklist: new Set(['Some Channel']), subs: new Set(['Some Channel']) });
  assert.deepEqual(decide(tile(), DEFAULT_CONFIG, s), { hide: true, reason: 'blocked' });
});

test('a blocked title is hidden with the title reason', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['An ordinary video title'] },
  };
  assert.deepEqual(decide(tile(), config, state()), {
    hide: true, reason: 'title',
  });
});

test('title matching is case-insensitive', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['ORDINARY VIDEO'] },
  };
  assert.deepEqual(decide(tile(), config, state()), {
    hide: true, reason: 'title',
  });
});

test('a blocked phrase matches in the middle of a title', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['video'] },
  };
  assert.deepEqual(decide(tile(), config, state()), {
    hide: true, reason: 'title',
  });
});

test('title blocking checks both visible and attribute title variants', () => {
  const attributeTitle =
    "American Watches Football's Most Humiliating Night";
  const visibleTitle =
    'American Reacts to Brazil 1-7 Germany | World Cup Shock';
  const capturedTile = tile({
    title: visibleTitle,
    titles: [visibleTitle, attributeTitle],
  });
  const withPattern = (pattern) => ({
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: [pattern] },
  });

  assert.deepEqual(
    decide(capturedTile, withPattern('Most Humiliating Night'), state()),
    { hide: true, reason: 'title' },
  );
  assert.deepEqual(
    decide(capturedTile, withPattern('Brazil 1-7 Germany'), state()),
    { hide: true, reason: 'title' },
  );
  assert.deepEqual(
    decide(capturedTile, withPattern('Argentina wins'), state()),
    { hide: false, reason: 'shown' },
  );
});

test('title blocking applies to subscribed channels', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['ordinary'] },
  };
  const s = state({ subs: new Set(['Some Channel']) });
  assert.deepEqual(decide(tile(), config, s), {
    hide: true, reason: 'title',
  });
});

test('the blocklist remains ahead of title blocking', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['ordinary'] },
  };
  const s = state({ blocklist: new Set(['Some Channel']) });
  assert.deepEqual(decide(tile(), config, s), {
    hide: true, reason: 'blocked',
  });
});

test('title blocking runs before the watched rule', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['ordinary'] },
  };
  assert.deepEqual(decide(tile({ hasResumeBar: true }), config, state()), {
    hide: true, reason: 'title',
  });
});

test('a disabled title rule does not hide matching titles', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: false, patterns: ['ordinary'] },
  };
  assert.deepEqual(decide(tile(), config, state()), {
    hide: false, reason: 'shown',
  });
});

test('garbage title patterns fail open', () => {
  const nonArrayConfig = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: 'ordinary' },
  };
  assert.deepEqual(decide(tile(), nonArrayConfig, state()), {
    hide: false, reason: 'shown',
  });

  const garbageEntriesConfig = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: [42, '', '   '] },
  };
  assert.deepEqual(decide(tile(), garbageEntriesConfig, state()), {
    hide: false, reason: 'shown',
  });
});

test('a tile without a title fails open', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['ordinary'] },
  };
  assert.deepEqual(decide(tile({ title: null }), config, state()), {
    hide: false, reason: 'shown',
  });
});

test('resume bar marks a video watched', () => {
  const t = tile({ hasResumeBar: true });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state()), { hide: true, reason: 'watched' });
});

test('local watched-set marks a video watched', () => {
  const s = state({ watched: new Set(['abc123']) });
  assert.deepEqual(decide(tile(), DEFAULT_CONFIG, s), { hide: true, reason: 'watched' });
});

test('watched rule applies to subscribed channels too', () => {
  const s = state({ subs: new Set(['Some Channel']), watched: new Set(['abc123']) });
  assert.deepEqual(decide(tile(), DEFAULT_CONFIG, s), { hide: true, reason: 'watched' });
});

test('subscribed channel is exempt from the age rule', () => {
  const t = tile({ ageText: '9 years ago' });
  const s = state({ subs: new Set(['Some Channel']) });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), { hide: false, reason: 'subscribed' });
});

test('subscribed channel is exempt from the view rule', () => {
  const t = tile({ viewText: '12 views', ageText: '3 years ago' });
  const s = state({ subs: new Set(['Some Channel']) });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), { hide: false, reason: 'subscribed' });
});

test('subs unavailable disables the age and view rules', () => {
  const t = tile({ ageText: '9 years ago', viewText: '3 views' });
  const s = state({ subs: null });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), {
    hide: false, reason: 'subs-unavailable',
  });
});

test('subs unavailable still allows blocklist and watched rules', () => {
  const s = state({ subs: null, watched: new Set(['abc123']) });
  assert.deepEqual(decide(tile(), DEFAULT_CONFIG, s), { hide: true, reason: 'watched' });
});

test('video older than the cutoff is hidden', () => {
  const t = tile({ ageText: '4 years ago' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state()), { hide: true, reason: 'age' });
});

const minAge = (hours) => ({
  ...DEFAULT_CONFIG,
  ageRule: { ...DEFAULT_CONFIG.ageRule, minAgeHours: hours },
});

test('a video younger than minAgeHours is hidden as too-new', () => {
  const t = tile({ ageText: '1 hour ago' });
  assert.deepEqual(decide(t, minAge(24), state()), { hide: true, reason: 'too-new' });
});

test('german too-new age text is hidden', () => {
  const t = tile({ ageText: 'vor 3 Stunden', viewText: '50.000 Aufrufe' });
  assert.deepEqual(decide(t, minAge(24), state({ locale: 'de' })), {
    hide: true, reason: 'too-new',
  });
});

test('a video exactly minAgeHours old is shown', () => {
  const t = tile({ ageText: '24 hours ago' });
  assert.deepEqual(decide(t, minAge(24), state()), { hide: false, reason: 'shown' });
});

test('minAgeHours 0 leaves the grace period in charge', () => {
  const t = tile({ ageText: '1 hour ago', viewText: '1 view' });
  assert.deepEqual(decide(t, minAge(0), state()), { hide: false, reason: 'shown' });
});

test('a subscribed channel is exempt from minAgeHours', () => {
  const t = tile({ ageText: '1 hour ago' });
  const s = state({ subs: new Set(['Some Channel']) });
  assert.deepEqual(decide(t, minAge(24), s), { hide: false, reason: 'subscribed' });
});

test('unparseable age text is shown with minAgeHours set', () => {
  const t = tile({ ageText: 'Streamed live' });
  assert.deepEqual(decide(t, minAge(24), state()), { hide: false, reason: 'shown' });
});

test('max age still hides old videos when minAgeHours is set', () => {
  const t = tile({ ageText: '4 years ago' });
  assert.deepEqual(decide(t, minAge(24), state()), { hide: true, reason: 'age' });
});

test('config without minAgeHours behaves as off', () => {
  const config = { ...DEFAULT_CONFIG, ageRule: { enabled: true, maxAgeDays: 1095 } };
  const t = tile({ ageText: '1 hour ago' });
  assert.deepEqual(decide(t, config, state()), { hide: false, reason: 'shown' });
});

test('video just under the cutoff is shown', () => {
  const t = tile({ ageText: '2 years ago' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state()), { hide: false, reason: 'shown' });
});

test('low-view video past the grace period is hidden', () => {
  const t = tile({ ageText: '5 days ago', viewText: '40 views' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state()), { hide: true, reason: 'views' });
});

test('low-view video inside the grace period is shown', () => {
  const t = tile({ ageText: '12 hours ago', viewText: '40 views' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state()), { hide: false, reason: 'shown' });
});

test('grace boundary: 48h exactly is still inside grace', () => {
  const t = tile({ ageText: '48 hours ago', viewText: '40 views' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state()), { hide: false, reason: 'shown' });
});

test('unparseable age fails open on both age and view rules', () => {
  const t = tile({ ageText: 'LIVE', viewText: '3 views' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state()), { hide: false, reason: 'shown' });
});

test('unparseable views fails open on the view rule but not the age rule', () => {
  const old = tile({ ageText: '9 years ago', viewText: 'nonsense' });
  assert.deepEqual(decide(old, DEFAULT_CONFIG, state()), { hide: true, reason: 'age' });

  const recent = tile({ ageText: '30 days ago', viewText: 'nonsense' });
  assert.deepEqual(decide(recent, DEFAULT_CONFIG, state()), {
    hide: false, reason: 'shown',
  });
});

test('a tile with no channel name is never blocked or exempted', () => {
  const t = tile({ channelName: null, ageText: '9 years ago' });
  const s = state({ blocklist: new Set(['Some Channel']), subs: new Set(['Some Channel']) });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), { hide: true, reason: 'age' });
});

test('german locale strings are parsed', () => {
  const t = tile({ ageText: 'vor 9 Jahren', viewText: '3 Aufrufe' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, state({ locale: 'de' })), {
    hide: true, reason: 'age',
  });
});

test('individually disabled rules do not fire', () => {
  const config = {
    ...DEFAULT_CONFIG,
    ageRule: { ...DEFAULT_CONFIG.ageRule, enabled: false },
  };
  const t = tile({ ageText: '9 years ago' });
  assert.deepEqual(decide(t, config, state()), { hide: false, reason: 'shown' });
});

test('a channel override can skip the watched rule', () => {
  const s = state({
    watched: new Set(['abc123']),
    overrides: new Map([
      ['Some Channel', { watched: { enabled: false } }],
    ]),
  });
  assert.deepEqual(decide(tile(), DEFAULT_CONFIG, s), {
    hide: false, reason: 'shown',
  });
});

test('a subscribed channel can be hidden by a forced age rule', () => {
  const s = state({
    subs: new Set(['Some Channel']),
    overrides: new Map([
      ['Some Channel', { age: { enabled: true, maxAgeDays: 30 } }],
    ]),
  });
  const t = tile({ ageText: '2 years ago' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), {
    hide: true, reason: 'age-override',
  });
});

test('an explicitly enabled view rule runs when subscriptions are unavailable', () => {
  const s = state({
    subs: null,
    overrides: new Map([
      ['Some Channel', { view: { enabled: true, minViews: 1000 } }],
    ]),
  });
  const t = tile({ ageText: '5 days ago', viewText: '40 views' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), {
    hide: true, reason: 'views-override',
  });
});

test('a per-channel age threshold replaces the global threshold', () => {
  const config = {
    ...DEFAULT_CONFIG,
    ageRule: { enabled: true, maxAgeDays: 1 },
  };
  const s = state({
    overrides: {
      'Some Channel': { age: { maxAgeDays: 365 } },
    },
  });
  assert.deepEqual(decide(tile(), config, s), {
    hide: false, reason: 'shown',
  });
});

test('an explicitly disabled age rule skips a globally enabled rule', () => {
  const s = state({
    overrides: new Map([
      ['Some Channel', { age: { enabled: false } }],
    ]),
  });
  const t = tile({ ageText: '9 years ago' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), {
    hide: false, reason: 'shown',
  });
});

test('an explicitly disabled view rule skips a globally enabled rule', () => {
  const s = state({
    overrides: new Map([
      ['Some Channel', { view: { enabled: false } }],
    ]),
  });
  const t = tile({ ageText: '5 days ago', viewText: '40 views' });
  assert.deepEqual(decide(t, DEFAULT_CONFIG, s), {
    hide: false, reason: 'shown',
  });
});

test('a forced age rule runs when the global age rule is disabled', () => {
  const config = {
    ...DEFAULT_CONFIG,
    ageRule: { ...DEFAULT_CONFIG.ageRule, enabled: false },
  };
  const s = state({
    overrides: new Map([
      ['Some Channel', { age: { enabled: true, maxAgeDays: 30 } }],
    ]),
  });
  const t = tile({ ageText: '2 years ago' });
  assert.deepEqual(decide(t, config, s), {
    hide: true, reason: 'age-override',
  });
});

test('blocklist remains ahead of every channel override', () => {
  const s = state({
    blocklist: new Set(['Some Channel']),
    overrides: new Map([
      ['Some Channel', {
        watched: { enabled: false },
        age: { enabled: false },
        view: { enabled: false },
      }],
    ]),
  });
  assert.deepEqual(decide(tile(), DEFAULT_CONFIG, s), {
    hide: true, reason: 'blocked',
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function identityState(overrides = {}) {
  return {
    subs: new Set(),
    blocklist: new Set(),
    watched: new Set(),
    locale: 'en',
    ...overrides,
  };
}

const identityTile = (overrides = {}) => ({
  videoId: 'video000001',
  title: 'A title',
  channelName: 'News',
  channelHandle: null,
  ageText: '1 day ago',
  viewText: '1M views',
  hasResumeBar: false,
  ...overrides,
});

test('IDENTITY: a block pinned to a handle does not hide a namesake', () => {
  const state = identityState({
    blocklist: new Set(['News']),
    blockMeta: new Map([['News', { handles: ['@bad-news'], until: null }]]),
    blockedHandles: new Map([['@bad-news', 'News']]),
  });

  assert.equal(
    decide(identityTile({ channelHandle: '@bad-news' }), DEFAULT_CONFIG, state).reason,
    'blocked',
  );
  assert.equal(
    decide(identityTile({ channelHandle: '@good-news' }), DEFAULT_CONFIG, state).hide,
    false,
  );
});

test('IDENTITY: without a handle on the tile, the name still blocks', () => {
  const state = identityState({
    blocklist: new Set(['News']),
    blockMeta: new Map([['News', { handles: ['@bad-news'], until: null }]]),
    blockedHandles: new Map([['@bad-news', 'News']]),
  });

  assert.equal(decide(identityTile(), DEFAULT_CONFIG, state).reason, 'blocked');
});

test('IDENTITY: a renamed channel stays blocked through its handle', () => {
  const state = identityState({
    blocklist: new Set(['Old Name']),
    blockMeta: new Map([['Old Name', { handles: ['@same'], until: null }]]),
    blockedHandles: new Map([['@same', 'Old Name']]),
  });

  assert.equal(decide(
    identityTile({ channelName: 'New Name', channelHandle: '@same' }),
    DEFAULT_CONFIG,
    state,
  ).reason, 'blocked');
});

test('IDENTITY: a legacy name-only block hides every tile with that name', () => {
  const state = identityState({ blocklist: new Set(['News']) });

  assert.equal(
    decide(identityTile({ channelHandle: '@any' }), DEFAULT_CONFIG, state).reason,
    'blocked',
  );
});

test('SNOOZE: a snoozed block hides until it ends, then shows', () => {
  const state = (now) => identityState({
    now,
    blocklist: new Set(['News']),
    blockMeta: new Map([['News', { handles: [], until: 10 * DAY_MS }]]),
  });

  assert.equal(decide(identityTile(), DEFAULT_CONFIG, state(9 * DAY_MS)).reason, 'blocked');
  assert.equal(decide(identityTile(), DEFAULT_CONFIG, state(10 * DAY_MS)).hide, false);
});

test('IDENTITY: an impersonator of a subscribed channel gets no exemption', () => {
  const state = identityState({
    subs: new Set(['Trusted']),
    subHandles: new Map([['Trusted', '@trusted']]),
    subHandleSet: new Set(['@trusted']),
  });
  const oldVideo = { channelName: 'Trusted', ageText: '10 years ago' };

  assert.equal(decide(
    identityTile({ ...oldVideo, channelHandle: '@trusted' }),
    DEFAULT_CONFIG,
    state,
  ).reason, 'subscribed');
  assert.equal(decide(
    identityTile({ ...oldVideo, channelHandle: '@impostor' }),
    DEFAULT_CONFIG,
    state,
  ).reason, 'age');
  // No handle on the tile (sidebar): the name is all there is.
  assert.equal(
    decide(identityTile(oldVideo), DEFAULT_CONFIG, state).reason,
    'subscribed',
  );
});

test('IDENTITY: a renamed subscribed channel keeps its exemption', () => {
  const state = identityState({
    subs: new Set(['Old Name']),
    subHandles: new Map([['Old Name', '@same']]),
    subHandleSet: new Set(['@same']),
  });

  assert.equal(decide(
    identityTile({
      channelName: 'New Name',
      channelHandle: '@same',
      ageText: '10 years ago',
    }),
    DEFAULT_CONFIG,
    state,
  ).reason, 'subscribed');
});

test('HIDDEN: a hand-hidden video is hidden even from a subscribed channel', () => {
  const state = identityState({
    subs: new Set(['News']),
    hidden: new Set(['video000001']),
  });

  assert.deepEqual(decide(identityTile(), DEFAULT_CONFIG, state), {
    hide: true,
    reason: 'hidden-video',
  });
  assert.equal(decide(
    identityTile(),
    { ...DEFAULT_CONFIG, enabled: false },
    state,
  ).hide, false);
});

test('SEARCH: only explicit blocks apply to search results', () => {
  const config = {
    ...DEFAULT_CONFIG,
    titleRule: { enabled: true, patterns: ['spoiler'] },
  };
  const state = (extra = {}) => identityState({
    surface: 'search',
    watched: new Set(['video000001']),
    ...extra,
  });
  const ancient = { ageText: '12 years ago', viewText: '3 views' };

  // Watched, too old and too few views: all ignored on a search page.
  assert.deepEqual(decide(identityTile(ancient), config, state()), {
    hide: false,
    reason: 'search',
  });
  assert.equal(decide(
    identityTile(ancient),
    config,
    state({ blocklist: new Set(['News']) }),
  ).reason, 'blocked');
  assert.equal(decide(
    identityTile(ancient),
    config,
    state({ hidden: new Set(['video000001']) }),
  ).reason, 'hidden-video');
  assert.equal(decide(
    identityTile({ ...ancient, title: 'Big SPOILER inside' }),
    config,
    state(),
  ).reason, 'title');
});
