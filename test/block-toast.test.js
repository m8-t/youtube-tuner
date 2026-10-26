import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  BLOCK_TOAST_CLASS,
  removeBlockToast,
  showBlockToast,
} from '../src/dom/block-toast.js';

const toasts = (doc) => doc.querySelectorAll(`.${BLOCK_TOAST_CLASS}`);

test('renders the channel name as text, never markup', (t) => {
  const doc = html('');
  t.after(() => removeBlockToast(doc));
  showBlockToast({ doc, channelName: '<b>x</b>', onUndo: () => {} });

  const toast = doc.querySelector(`.${BLOCK_TOAST_CLASS}`);
  assert.equal(toast.querySelector('b'), null);
  assert.ok(toast.textContent.includes('Blocked <b>x</b>'));
  assert.equal(toast.querySelector('button').textContent, 'Undo');
});

test('undo calls the handler and removes the toast', (t) => {
  const doc = html('');
  t.after(() => removeBlockToast(doc));
  const undone = [];
  showBlockToast({ doc, channelName: 'A', onUndo: () => undone.push('A') });

  doc.querySelector(`.${BLOCK_TOAST_CLASS} button`).click();

  assert.deepEqual(undone, ['A']);
  assert.equal(toasts(doc).length, 0);
});

test('a new toast replaces the existing one', (t) => {
  const doc = html('');
  t.after(() => removeBlockToast(doc));
  showBlockToast({ doc, channelName: 'First', onUndo: () => {} });
  showBlockToast({ doc, channelName: 'Second', onUndo: () => {} });

  assert.equal(toasts(doc).length, 1);
  assert.match(toasts(doc)[0].textContent, /Second/);
});

test('the toast removes itself after the timeout', async () => {
  const doc = html('');
  showBlockToast({ doc, channelName: 'A', onUndo: () => {}, timeoutMs: 10 });
  assert.equal(toasts(doc).length, 1);

  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(toasts(doc).length, 0);
});

test('a replacing toast restarts the timer', async () => {
  const doc = html('');
  showBlockToast({ doc, channelName: 'A', onUndo: () => {}, timeoutMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  showBlockToast({ doc, channelName: 'B', onUndo: () => {}, timeoutMs: 30 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(toasts(doc).length, 1);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(toasts(doc).length, 0);
});

test('a throwing undo handler does not escape', (t) => {
  const doc = html('');
  t.after(() => removeBlockToast(doc));
  showBlockToast({
    doc,
    channelName: 'A',
    onUndo: () => { throw new Error('boom'); },
  });

  assert.doesNotThrow(() => {
    doc.querySelector(`.${BLOCK_TOAST_CLASS} button`).click();
  });
});
