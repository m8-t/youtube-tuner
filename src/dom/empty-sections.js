export const COLLAPSED_SECTION_CLASS = 'ytt-section-collapsed';

const RICH_SECTION_SELECTOR = 'ytd-rich-section-renderer';

function showSections(sections) {
  for (const section of sections) {
    section.classList.remove(COLLAPSED_SECTION_CLASS);
  }
}

function showSectionsBestEffort(sections) {
  for (const section of sections) {
    try {
      section.classList.remove(COLLAPSED_SECTION_CLASS);
    } catch {
      // Keep cleaning up the remaining sections after a broken DOM node.
    }
  }
}

export function collapseEmptySections({ root, doc }) {
  let sections = [];

  try {
    sections = Array.from(root.querySelectorAll(RICH_SECTION_SELECTOR));

    // A collapsed section always measures zero. Reveal every section before
    // reading layout so shelves that gained content can recover on this scan.
    showSections(sections);

    // Keep layout reads together; do not write classes until all reads finish.
    const measurements = sections.map((section) => ({
      section,
      height: section.getBoundingClientRect().height,
    }));

    for (const { section, height } of measurements) {
      if (height === 0) {
        section.classList.add(COLLAPSED_SECTION_CLASS);
      }
    }
  } catch {
    // Fail open as a group: one bad measurement or write must show all shelves.
    showSectionsBestEffort(sections);

    // Also clear any previously collapsed section if discovery itself failed.
    try {
      showSectionsBestEffort(doc.querySelectorAll(`.${COLLAPSED_SECTION_CLASS}`));
    } catch {
      // Nothing else can be recovered safely.
    }
  }
}
