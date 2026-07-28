import { test } from 'node:test';
import assert from 'node:assert/strict';
import { html } from './helpers/dom.js';
import {
  collapseEmptySections,
  COLLAPSED_SECTION_CLASS,
} from '../src/dom/empty-sections.js';

function setup(count = 1) {
  const markup = Array.from(
    { length: count },
    (_, index) => `<ytd-rich-section-renderer id="section-${index}"></ytd-rich-section-renderer>`
  ).join('');
  const doc = html(markup);
  return {
    doc,
    root: doc.body,
    sections: Array.from(doc.querySelectorAll('ytd-rich-section-renderer')),
  };
}

function rectWithHeight(height) {
  return { height };
}

test('zero-height section receives ytt-section-collapsed class', () => {
  const { doc, root, sections: [section] } = setup();

  collapseEmptySections({ root, doc });

  assert.ok(section.classList.contains(COLLAPSED_SECTION_CLASS));
});

test('non-zero height section is not affected', () => {
  const { doc, root, sections: [section] } = setup();
  section.getBoundingClientRect = () => rectWithHeight(80);

  collapseEmptySections({ root, doc });

  assert.ok(!section.classList.contains(COLLAPSED_SECTION_CLASS));
});

test('previously collapsed section that gains height is un-collapsed', () => {
  const { doc, root, sections: [section] } = setup();
  let height = 0;
  section.getBoundingClientRect = () => rectWithHeight(height);

  collapseEmptySections({ root, doc });
  assert.ok(section.classList.contains(COLLAPSED_SECTION_CLASS));

  height = 120;
  collapseEmptySections({ root, doc });

  assert.ok(!section.classList.contains(COLLAPSED_SECTION_CLASS));
});

test('section that stays empty remains collapsed across repeated scans', () => {
  const { doc, root, sections: [section] } = setup();

  collapseEmptySections({ root, doc });
  collapseEmptySections({ root, doc });
  collapseEmptySections({ root, doc });

  assert.ok(section.classList.contains(COLLAPSED_SECTION_CLASS));
});

test('measurement exception does not escape and leaves all sections visible', () => {
  const { doc, root, sections: [first, broken] } = setup(2);
  first.classList.add(COLLAPSED_SECTION_CLASS);
  first.getBoundingClientRect = () => rectWithHeight(0);
  broken.classList.add(COLLAPSED_SECTION_CLASS);
  broken.getBoundingClientRect = () => {
    throw new Error('layout unavailable');
  };

  assert.doesNotThrow(() => collapseEmptySections({ root, doc }));
  assert.ok(!first.classList.contains(COLLAPSED_SECTION_CLASS));
  assert.ok(!broken.classList.contains(COLLAPSED_SECTION_CLASS));
});
