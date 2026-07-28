import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStarvationNudge } from '../src/dom/starvation.js';

function setup(options = {}) {
  const scrolls = [];
  const nudge = createStarvationNudge({
    scrollBy: () => scrolls.push(1),
    ...options,
  });
  return { nudge, scrolls };
}

test('does not nudge when enough tiles are visible', () => {
  const { nudge, scrolls } = setup();
  nudge.onCounts({ hidden: 2, visible: 20 });
  assert.equal(scrolls.length, 0);
});

test('nudges when too few tiles are visible', () => {
  const { nudge, scrolls } = setup();
  nudge.onCounts({ hidden: 30, visible: 2 });
  assert.equal(scrolls.length, 1);
});

// Regression guard. An absolute "fewer than 8 visible" floor would pass
// 30 >= 8 and never nudge, which is exactly the deep-feed case this covers.
test('nudges deep in the feed when the ratio is low but the count is high', () => {
  const { nudge, scrolls } = setup();
  nudge.onCounts({ hidden: 400, visible: 30 });
  assert.equal(scrolls.length, 1);
});

test('stops after maxConsecutive nudges', () => {
  const { nudge, scrolls } = setup({ maxConsecutive: 3 });
  for (let i = 0; i < 10; i += 1) {
    nudge.onCounts({ hidden: 30, visible: 2 });
  }
  assert.equal(scrolls.length, 3);
});

test('a healthy scan resets the consecutive counter', () => {
  const { nudge, scrolls } = setup({ maxConsecutive: 2 });
  nudge.onCounts({ hidden: 30, visible: 2 });
  nudge.onCounts({ hidden: 30, visible: 2 });
  nudge.onCounts({ hidden: 30, visible: 2 });
  assert.equal(scrolls.length, 2);

  nudge.onCounts({ hidden: 1, visible: 20 });
  nudge.onCounts({ hidden: 30, visible: 2 });
  assert.equal(scrolls.length, 3);
});

test('does nothing when nothing was hidden', () => {
  const { nudge, scrolls } = setup();
  nudge.onCounts({ hidden: 0, visible: 1 });
  assert.equal(scrolls.length, 0);
});

test('reset() clears the counter', () => {
  const { nudge, scrolls } = setup({ maxConsecutive: 1 });
  nudge.onCounts({ hidden: 30, visible: 2 });
  nudge.onCounts({ hidden: 30, visible: 2 });
  assert.equal(scrolls.length, 1);

  nudge.reset();
  nudge.onCounts({ hidden: 30, visible: 2 });
  assert.equal(scrolls.length, 2);
});

test('more total tiles reset failures and allow nudges past maxConsecutive', () => {
  const { nudge, scrolls } = setup({ maxConsecutive: 2 });

  for (let total = 32; total < 42; total += 1) {
    nudge.onCounts({ hidden: total - 2, visible: 2 });
    // An unchanged scan records one failed nudge before content arrives.
    nudge.onCounts({ hidden: total - 2, visible: 2 });
  }

  assert.equal(scrolls.length, 20);
  assert.ok(scrolls.length > 2);
});

test('nudges with no new tiles stop at maxConsecutive failures', () => {
  const { nudge, scrolls } = setup({ maxConsecutive: 3 });

  for (let i = 0; i < 20; i += 1) {
    nudge.onCounts({ hidden: 30, visible: 2 });
  }

  assert.equal(scrolls.length, 3);
});

test('a filtered deep feed keeps nudging while new content arrives', () => {
  const { nudge, scrolls } = setup({ maxConsecutive: 5 });

  for (let page = 0; page < 12; page += 1) {
    nudge.onCounts({ hidden: 400 + (page * 20), visible: 30 });
  }

  assert.equal(scrolls.length, 12);
});
