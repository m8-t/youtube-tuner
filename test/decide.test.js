import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/rules/decide.js';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

const tile = (over = {}) => ({
  videoId: 'abc123',
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
