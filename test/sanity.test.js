import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ready } from '../src/sanity.js';

test('harness runs', () => {
  assert.equal(ready(), true);
});
