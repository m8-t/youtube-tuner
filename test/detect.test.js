import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLocale } from '../src/locale/detect.js';

const doc = (lang) => ({ documentElement: { lang } });

test('detects german from lang attribute', () => {
  assert.equal(detectLocale(doc('de')), 'de');
  assert.equal(detectLocale(doc('de-DE')), 'de');
  assert.equal(detectLocale(doc('de-AT')), 'de');
});

test('everything else falls back to english', () => {
  assert.equal(detectLocale(doc('en')), 'en');
  assert.equal(detectLocale(doc('en-GB')), 'en');
  assert.equal(detectLocale(doc('fr')), 'en');
  assert.equal(detectLocale(doc('')), 'en');
  assert.equal(detectLocale({}), 'en');
  assert.equal(detectLocale(null), 'en');
});
