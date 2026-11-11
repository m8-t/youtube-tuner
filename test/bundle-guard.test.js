// Guards on what the shipped bundles may contain. They build in memory, so
// they hold for the real output and not only for the source files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const ENTRY_POINTS = {
  content: 'src/content.js',
  background: 'src/background.js',
  options: 'src/options.js',
  popup: 'src/popup.js',
};

const bundles = {};
for (const [name, entry] of Object.entries(ENTRY_POINTS)) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  bundles[name] = result.outputFiles[0].text;
}

const FORBIDDEN_SINKS = [
  /\.innerHTML\b/,
  /\.outerHTML\b/,
  /insertAdjacentHTML/,
  /document\.write\b/,
  /\beval\s*\(/,
  /new Function\b/,
  /setTimeout\(\s*['"`]/,
];

test('no bundle contains an HTML or code injection sink', () => {
  for (const [name, text] of Object.entries(bundles)) {
    for (const pattern of FORBIDDEN_SINKS) {
      assert.equal(pattern.test(text), false, `${name} matches ${pattern}`);
    }
  }
});

test('the content script bundle has no storage, network or credential code', () => {
  for (const pattern of [
    /chrome\.storage/,
    /indexedDB/,
    /\bfetch\s*\(/,
    /XMLHttpRequest/,
    /Authorization/,
    /syncSettings/,
  ]) {
    assert.equal(
      pattern.test(bundles.content),
      false,
      `content bundle matches ${pattern}`,
    );
  }
});

test('only the background bundle talks to the sync server', () => {
  assert.match(bundles.background, /Authorization/);
  for (const name of ['content', 'options', 'popup']) {
    assert.equal(/Authorization/.test(bundles[name]), false, name);
  }
});
