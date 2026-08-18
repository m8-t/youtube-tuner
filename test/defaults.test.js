import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/rules/defaults.js';

test('default minimum view count is 5000', () => {
  assert.equal(DEFAULT_CONFIG.viewRule.minViews, 5000);
  assert.equal(DEFAULT_CONFIG.ageRule.maxAgeDays, 1095);
  assert.deepEqual(DEFAULT_CONFIG.titleRule, { enabled: true, patterns: [] });
  assert.equal(DEFAULT_CONFIG.updateCheck.enabled, true);
});
