import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseViews } from '../src/locale/parse-views.js';

test('english view counts', () => {
  assert.equal(parseViews('42 views', 'en'), 42);
  assert.equal(parseViews('1 view', 'en'), 1);
  assert.equal(parseViews('1,234 views', 'en'), 1234);
  assert.equal(parseViews('1.2K views', 'en'), 1200);
  assert.equal(parseViews('12K views', 'en'), 12000);
  assert.equal(parseViews('3.4M views', 'en'), 3400000);
  assert.equal(parseViews('1.1B views', 'en'), 1100000000);
  assert.equal(parseViews('No views', 'en'), 0);
});

test('german view counts', () => {
  assert.equal(parseViews('42 Aufrufe', 'de'), 42);
  assert.equal(parseViews('1 Aufruf', 'de'), 1);
  assert.equal(parseViews('1.234 Aufrufe', 'de'), 1234);
  assert.equal(parseViews('1,2 Tsd. Aufrufe', 'de'), 1200);
  assert.equal(parseViews('12 Tsd. Aufrufe', 'de'), 12000);
  assert.equal(parseViews('3,4 Mio. Aufrufe', 'de'), 3400000);
  assert.equal(parseViews('1,1 Mrd. Aufrufe', 'de'), 1100000000);
  assert.equal(parseViews('Keine Aufrufe', 'de'), 0);
});

test('english spelled-out multipliers from aria-label', () => {
  assert.equal(parseViews('3.4 million views', 'en'), 3400000);
  assert.equal(parseViews('23 million views', 'en'), 23000000);
  assert.equal(parseViews('1.1 billion views', 'en'), 1100000000);
  assert.equal(parseViews('45 thousand views', 'en'), 45000);
  assert.equal(parseViews('3,412,556 views', 'en'), 3412556);
});

test('german spelled-out multipliers from aria-label', () => {
  assert.equal(parseViews('1,1 Millionen Aufrufe', 'de'), 1100000);
  assert.equal(parseViews('1 Million Aufrufe', 'de'), 1000000);
  assert.equal(parseViews('758.038 Aufrufe', 'de'), 758038);
  assert.equal(parseViews('2,3 Milliarden Aufrufe', 'de'), 2300000000);
});

test('bare counts from lockup visible text', () => {
  assert.equal(parseViews('3.4M', 'en'), 3400000);
  assert.equal(parseViews('23M', 'en'), 23000000);
  assert.equal(parseViews('758.038', 'de'), 758038);
  assert.equal(parseViews('1,1 Mio.', 'de'), 1100000);
});

test('unparseable input returns null (fail-open)', () => {
  assert.equal(parseViews('', 'en'), null);
  assert.equal(parseViews(null, 'en'), null);
  assert.equal(parseViews('3 years ago', 'en'), null);
  assert.equal(parseViews('vor 3 Jahren', 'de'), null);
  assert.equal(parseViews('1.234 Zuschauer', 'de'), null);
});

test('bare-count parsing does not misread other metadata', () => {
  assert.equal(parseViews('14:17', 'en'), null);
  assert.equal(parseViews('13:45', 'de'), null);
  assert.equal(parseViews('3mo ago', 'en'), null);
  assert.equal(parseViews('vor 10 Monaten', 'de'), null);
});

test('live watcher counts are not view counts', () => {
  assert.equal(parseViews('1,234 watching', 'en'), null);
});
