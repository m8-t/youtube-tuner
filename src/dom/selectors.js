// Every YouTube-specific selector in this extension lives in this file.
// When YouTube ships a redesign, this is the file to change.

// --- Video tiles -----------------------------------------------------------

// yt-lockup-view-model is the current tile. The ytd-* entries are legacy
// wrappers still present on some surfaces.
export const TILE_SELECTOR =
  'yt-lockup-view-model, ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer';

// Verified against test/fixtures/home-de-watched.html on 2026-07-27
export const RESUME_SELECTOR =
  'yt-thumbnail-overlay-progress-bar-view-model .ytThumbnailOverlayProgressBarHostWatchedProgressBar';

export const METADATA_ROW_SELECTOR = '.ytContentMetadataViewModelMetadataRow';
export const TITLE_SELECTOR = '.ytLockupMetadataViewModelTitle';
export const TITLE_HEADING_SELECTOR = '.ytLockupMetadataViewModelHeadingReset';
export const LEGACY_TITLE_SELECTOR = '#video-title';

// Shelves on the home feed that can end up with every tile hidden.
export const RICH_SECTION_SELECTOR = 'ytd-rich-section-renderer';

// --- YouTube's own tile menu -----------------------------------------------

export const MENU_TRIGGER_SELECTOR =
  '.ytLockupMetadataViewModelMenuButton button';
export const MENU_ITEM_SELECTOR =
  'yt-list-item-view-model.ytListItemViewModelHost[role="menuitem"], yt-list-item-view-model [role="menuitem"]';
export const MENU_DROPDOWN_SELECTOR = 'tp-yt-iron-dropdown';

// The notice YouTube puts in place of a tile after a native action.
export const NATIVE_UNDO_RENDERER = 'notification-multi-action-renderer';

// --- Channel links and the subscribe button --------------------------------

export const CHANNEL_LINK_SELECTOR = 'a[href^="/@"], a[href^="/channel/"]';

export const SUBSCRIBE_BUTTON_SELECTOR =
  'ytd-subscribe-button-renderer, yt-subscribe-button-view-model'; // UNVERIFIED
// Verified live 2026-07-28 ancestor chain:
// ytd-subscribe-button-renderer -> div#subscribe-button -> div#owner ->
// div#top-row -> div#above-the-fold -> ytd-watch-metadata.
export const OWNER_SELECTOR = '#owner';

// --- The subscriptions list on /feed/channels ------------------------------

export const SUBS_CHANNEL_NAME_SELECTOR = [
  'ytd-channel-renderer #channel-title',
  'ytd-grid-channel-renderer #channel-title',
  'yt-lockup-view-model a[href^="/@"] .yt-core-attributed-string',
  'yt-lockup-view-model a[href^="/channel/"] .yt-core-attributed-string',
].join(',');

export const SUBS_CONTINUATION_SELECTOR = 'ytd-continuation-item-renderer';
