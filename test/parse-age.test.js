import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAge } from '../src/locale/parse-age.js';

const DAY = 86400000;
const HOUR = 3600000;

test('english relative ages', () => {
  assert.equal(parseAge('3 years ago', 'en'), Math.round(3 * 365.25 * DAY));
  assert.equal(parseAge('1 year ago', 'en'), Math.round(365.25 * DAY));
  assert.equal(parseAge('2 months ago', 'en'), Math.round(2 * 30.4375 * DAY));
  assert.equal(parseAge('5 days ago', 'en'), 5 * DAY);
  assert.equal(parseAge('1 day ago', 'en'), DAY);
  assert.equal(parseAge('12 hours ago', 'en'), 12 * HOUR);
  assert.equal(parseAge('3 weeks ago', 'en'), 21 * DAY);
  assert.equal(parseAge('45 minutes ago', 'en'), 45 * 60000);
  assert.equal(parseAge('30 seconds ago', 'en'), 30000);
});

test('english prefixed forms', () => {
  assert.equal(parseAge('Streamed 3 years ago', 'en'), Math.round(3 * 365.25 * DAY));
  assert.equal(parseAge('Premiered 2 days ago', 'en'), 2 * DAY);
});

test('german relative ages', () => {
  assert.equal(parseAge('vor 3 Jahren', 'de'), Math.round(3 * 365.25 * DAY));
  assert.equal(parseAge('vor 1 Jahr', 'de'), Math.round(365.25 * DAY));
  assert.equal(parseAge('vor 2 Monaten', 'de'), Math.round(2 * 30.4375 * DAY));
  assert.equal(parseAge('vor 1 Monat', 'de'), Math.round(30.4375 * DAY));
  assert.equal(parseAge('vor 5 Tagen', 'de'), 5 * DAY);
  assert.equal(parseAge('vor 1 Tag', 'de'), DAY);
  assert.equal(parseAge('vor 3 Wochen', 'de'), 21 * DAY);
  assert.equal(parseAge('vor 12 Stunden', 'de'), 12 * HOUR);
  assert.equal(parseAge('vor 45 Minuten', 'de'), 45 * 60000);
  assert.equal(parseAge('vor 30 Sekunden', 'de'), 30000);
});

test('german prefixed forms', () => {
  assert.equal(parseAge('Live gestreamt vor 3 Jahren', 'de'), Math.round(3 * 365.25 * DAY));
});

test('english compact forms from lockup visible text', () => {
  assert.equal(parseAge('3mo ago', 'en'), Math.round(3 * 30.4375 * DAY));
  assert.equal(parseAge('6y ago', 'en'), Math.round(6 * 365.25 * DAY));
  assert.equal(parseAge('5d ago', 'en'), 5 * DAY);
  assert.equal(parseAge('3w ago', 'en'), 21 * DAY);
  assert.equal(parseAge('12h ago', 'en'), 12 * HOUR);
  assert.equal(parseAge('45min ago', 'en'), 45 * 60000);
});

test('compact month is not compact minute', () => {
  assert.notEqual(parseAge('3mo ago', 'en'), 3 * 60000);
});

test('german non-breaking space is handled', () => {
  assert.equal(parseAge('vor 10 Monaten', 'de'), Math.round(10 * 30.4375 * DAY));
  assert.equal(parseAge('vor 3 Wochen', 'de'), 21 * DAY);
});

test('unparseable input returns null (fail-open)', () => {
  assert.equal(parseAge('', 'en'), null);
  assert.equal(parseAge(null, 'en'), null);
  assert.equal(parseAge(undefined, 'de'), null);
  assert.equal(parseAge('LIVE', 'en'), null);
  assert.equal(parseAge('Premiere am 5. Aug.', 'de'), null);
  assert.equal(parseAge('3 years ago', 'de'), null);
  assert.equal(parseAge('vor 3 Jahren', 'en'), null);
});
