import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const runner = fileURLToPath(
  new URL('./helpers/content-e2e-runner.mjs', import.meta.url),
);

test('END TO END: the content script filters, blocks and undoes through the background only', async () => {
  const { stdout } = await run(process.execPath, [runner], { timeout: 20_000 });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));

  // The block is pinned to @blocked: a channel that only shares the name
  // stays visible.
  assert.deepEqual(result.afterStart, {
    blocked: true,
    namesake: false,
    other: false,
  });
  assert.deepEqual(result.controls, {
    otherHasBlockButton: true,
    styleInjected: true,
  });

  assert.equal(result.afterBlock.other, true);
  assert.deepEqual(result.afterBlock.stored, ['Blocked Channel', 'Other Channel']);
  assert.match(result.afterBlock.toast, /Blocked Other Channel/);

  assert.equal(result.afterUndo.other, false);
  assert.deepEqual(result.afterUndo.stored, ['Blocked Channel']);

  assert.deepEqual(result.afterHide, {
    other: true,
    stored: ['video000002'],
    feedbackControls: 0,
  });

  assert.deepEqual(result.afterDisable, { blocked: false, anyControl: false });

  assert.equal(result.contentStorageCalls, 0);
  for (const type of result.sentTypes) {
    assert.ok(
      [
        'state-get',
        'counts',
        'block-add',
        'block-remove',
        'hide-add',
        'watched-add',
      ].includes(type),
      `unexpected message type ${type}`,
    );
  }
  assert.ok(result.sentTypes.includes('state-get'));
  // Nothing in a default session may ask for YouTube feedback.
  assert.equal(result.sentTypes.includes('feedback-reserve'), false);
});
