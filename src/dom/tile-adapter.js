// Every YouTube-specific selector in this extension lives in this file.
// When YouTube ships a redesign, this is the only file that needs changing.
import { parseAge } from '../locale/parse-age.js';
import { parseViews } from '../locale/parse-views.js';

// yt-lockup-view-model is the current tile. The ytd-* entries are legacy
// wrappers still present on some surfaces; see specs/2026-07-27-dom-findings.md.
export const TILE_SELECTOR =
  'yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer';

// Verified against test/fixtures/home-de-watched.html on 2026-07-27
const RESUME_SELECTOR =
  'yt-thumbnail-overlay-progress-bar-view-model .ytThumbnailOverlayProgressBarHostWatchedProgressBar';

// aria-label forms observed live: "Go to channel AlmondTheArtist",
// "Zu Kanal „Wissenswert“".
const CHANNEL_PATTERNS = [
  /^Go to channel\s+(.+)$/i,
  /^Zu Kanal\s+[„"'«]?(.+?)[“"'»]?$/i,
];

const METADATA_ROW_SELECTOR = '.ytContentMetadataViewModelMetadataRow';

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

    const titleElement =
      element.querySelector('.ytLockupMetadataViewModelTitle');
    const titleHeading = titleElement?.closest(
      '.ytLockupMetadataViewModelHeadingReset',
    );
    const legacyTitleElement = element.querySelector('#video-title');
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

    const locale = element.ownerDocument?.documentElement?.lang
      ?.toLowerCase()
      .startsWith('de')
      ? 'de'
      : 'en';

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
            channelName = match[1].trim();
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
      const text = element.querySelector(METADATA_ROW_SELECTOR)?.textContent?.trim();
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
