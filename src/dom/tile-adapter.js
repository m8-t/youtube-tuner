// Reads one video tile into plain data. Selectors are in selectors.js.
import { parseAge } from '../locale/parse-age.js';
import { parseViews } from '../locale/parse-views.js';
import { detectLocale } from '../locale/detect.js';
import { normalizeChannelName } from '../channel-name.js';
import {
  LEGACY_TITLE_SELECTOR,
  METADATA_ROW_SELECTOR,
  RESUME_SELECTOR,
  TILE_SELECTOR,
  TITLE_HEADING_SELECTOR,
  TITLE_SELECTOR,
} from './selectors.js';

export { TILE_SELECTOR };

// aria-label forms observed live: "Go to channel AlmondTheArtist",
// "Zu Kanal „Wissenswert“".
const CHANNEL_PATTERNS = [
  /^Go to channel\s+(.+)$/i,
  /^Zu Kanal\s+[„"'«]?(.+?)[“"'»]?$/i,
];

function videoIdFromHref(href) {
  if (typeof href !== 'string') return null;
  const match = /[?&]v=([\w-]{5,})/.exec(href);
  return match ? match[1] : null;
}

// A grid tile is ytd-rich-item-renderer wrapping yt-lockup-view-model 1:1.
// Counting both would double every grid video and skew the hidden/visible
// ratio the starvation nudge and the badge depend on.
export function isOutermostTile(element) {
  return !element.parentElement?.closest(TILE_SELECTOR);
}

export function readTile(element) {
  try {
    if (!element || typeof element.querySelector !== 'function') return null;
    if (!isOutermostTile(element)) return null;

    let videoId = null;
    for (const link of element.querySelectorAll('a[href]')) {
      videoId = videoIdFromHref(link.getAttribute('href'));
      if (videoId) break;
    }
    if (!videoId) return null;

    const titleElement = element.querySelector(TITLE_SELECTOR);
    const titleHeading = titleElement?.closest(TITLE_HEADING_SELECTOR);
    const legacyTitleElement = element.querySelector(LEGACY_TITLE_SELECTOR);
    // A 2026-08-21 de-DE capture showed YoutubeAntiTranslate changing visible
    // text but not the heading title attribute, so the two titles can disagree.
    const titles = [...new Set([
      titleElement?.textContent,
      legacyTitleElement?.textContent,
      titleElement?.getAttribute('title'),
      titleHeading?.getAttribute('title'),
      legacyTitleElement?.getAttribute('title'),
    ].map((candidate) => candidate?.trim()).filter(Boolean))];
    const title = titles[0] ?? null;

    const locale = detectLocale(element.ownerDocument);

    // Aria labels carry the unabbreviated metadata on most lockups. Scan them
    // all and keep the first that parses, rather than trusting a selector path
    // that YouTube reshuffles.
    let ageText = null;
    let viewText = null;
    let channelName = null;

    for (const node of element.querySelectorAll('[aria-label]')) {
      const label = node.getAttribute('aria-label')?.trim();
      if (!label) continue;

      if (ageText === null && parseAge(label, locale) !== null) ageText = label;
      if (viewText === null && parseViews(label, locale) !== null) viewText = label;

      if (channelName === null) {
        for (const pattern of CHANNEL_PATTERNS) {
          const match = pattern.exec(label);
          if (match) {
            channelName = normalizeChannelName(match[1]) || null;
            break;
          }
        }
      }
    }

    // Home-feed view counts can be visible text without an aria-label. Preserve
    // any aria-label result above, and use complete metadata-row text only for
    // missing fields so combined strings such as
    // "430.502 Aufrufe • vor 3 Jahren" remain parseable by both parsers.
    if (ageText === null || viewText === null) {
      const rows = [...element.querySelectorAll(METADATA_ROW_SELECTOR)];
      const textSources = rows.length > 0 ? rows : [element];

      for (const node of textSources) {
        const text = node.textContent?.trim();
        if (!text) continue;

        if (ageText === null && parseAge(text, locale) !== null) ageText = text;
        if (viewText === null && parseViews(text, locale) !== null) viewText = text;
        if (ageText !== null && viewText !== null) break;
      }
    }

    // Collaboration videos carry aria-label="Collaboration channels" instead
    // of "Go to channel X". The name is then only in visible text, where the
    // first metadata row is always the channel.
    if (channelName === null) {
      // Normalized like every stored name, so a multi-line row still matches
      // the blocklist and the subscription list.
      const text = normalizeChannelName(
        element.querySelector(METADATA_ROW_SELECTOR)?.textContent,
      );
      if (text) channelName = text;
    }

    return {
      videoId,
      title,
      titles,
      channelName,
      ageText,
      viewText,
      hasResumeBar: Boolean(element.querySelector(RESUME_SELECTOR)),
      element,
    };
  } catch {
    return null; // fail-open: an unreadable tile is a shown tile
  }
}
