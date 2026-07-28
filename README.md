# youtube-tuner

Filters YouTube's recommendations on the home feed and the watch-page
sidebar: old, already-watched, low-view and blocked-channel videos disappear,
your subscriptions stay. A Chromium MV3 extension that keeps your
subscription list in sync without any external API and adds one-click
controls for training YouTube itself.

Everything runs locally. The extension makes **zero network requests** of its
own: no telemetry, no external services, no YouTube API calls. It only reads
the pages you already have open.

- **Permissions:** `storage`, `alarms`, and host access to `youtube.com` -
  nothing else.
- **248 tests**, `node --test` + jsdom, no browser dependency.
- **License:** AGPL-3.0.
- **Language support: German YouTube UI only, for now.** Every
  string-dependent piece - the native menu items, the subscribe/unsubscribe
  labels - is verified against the German UI. English equivalents exist in
  the code but are untested against the live page, and other languages are
  not implemented at all. Everything degrades safely on an unsupported
  locale: actions and capture do nothing rather than clicking or writing the
  wrong thing, and unparseable metadata leaves videos visible.

---

## Install

Grab the latest release from the [releases page](../../releases). Every
version tag ships two artifacts:

- `youtube-tuner-<version>.zip` - unzip somewhere permanent, open
  `chrome://extensions`, enable Developer mode, **Load unpacked**, select the
  folder. Works in every Chromium browser.
- `youtube-tuner-<version>.crx` - drag-and-drop onto `chrome://extensions`.
  Works in Chromium forks that drop the Web Store restriction (Helium,
  ungoogled-chromium). Stock Chrome refuses CRX files from outside the Web
  Store and needs the zip route.

The CRX is signed with a persistent key, so the extension ID - and with it
your settings, blocklist and watched history - survives updates. There is no
auto-update: installing a new version means downloading the new file and
reinstalling.

To move settings between machines or between an unpacked and a CRX install
(storage is keyed to the extension ID), use the export/import buttons in the
options page.

## Usage

Nothing to set up: browse YouTube and the filters apply. The toolbar badge
shows how many videos are currently hidden on the page; clicking the icon
toggles filtering on and off. Thresholds, the channel blocklist, manual
subscription entries, and settings export/import live in the options page.

---

## What it does

### Filtering

Videos are hidden when they are older than 3 years, have fewer than 5000
views, have already been watched, or come from a blocked channel. Subscribed
channels are exempt from the age and view rules, but **not** from the watched
rule. Thresholds are configurable in the options page.

Decision order is fixed and lives in `src/rules/decide.js`. Precedence
matters:

| # | Check | Result |
|---|-------|--------|
| 1 | extension disabled | show |
| 2 | channel on local blocklist | **hide** |
| 3 | watched (resume bar, or in the watched set) | **hide** |
| 4 | subscription list unavailable | show - stand down |
| 5 | channel is subscribed | show - exempt |
| 6 | older than `maxAgeDays` | **hide** |
| 7 | fewer than `minViews`, past the grace window | **hide** |
| 8 | - | show |

Defaults (`src/rules/defaults.js`): 1095 days, 5000 views, 48-hour grace for
new uploads.

Step 4 is deliberate: filtering a user's own subscriptions is worse than
filtering nothing, so an unavailable subscription list disables the age and
view rules entirely rather than treating every channel as unsubscribed.

Filtering is scoped to `/` and `/watch`. Other routes - search results, the
subscriptions feed, channel pages - are left untouched, and the kill switch
(toolbar icon) tears down every artifact live, without a reload.

### Per-tile buttons

Two stacked controls appear on hover on every recommendation tile:

- **👎 Not interested** - fires YouTube's native per-video action. Shown on
  every tile, including subscribed channels, since it is a per-video
  judgement.
- **🚫 Block channel** - fires YouTube's native "don't recommend channel"
  action **and** writes to the local blocklist. Suppressed on subscribed
  channels.

Both layers are kept for the block button on purpose: the native ban only
shapes *future* recommendations and does not remove tiles already on screen.
The local list makes the click take effect immediately.

### The subscription cache maintains itself

The subscription list drives the exemption rules and stays current through
four mechanisms, ordered from most to least automatic:

1. **Live capture on subscribe.** Clicking Subscribe on a watch page adds the
   channel to the cache instantly.
2. **Live capture on unsubscribe.** Unsubscribing on a watch page removes the
   channel again - verified by two delayed re-reads of the button state
   before anything is deleted.
3. **Passive collection.** When the cache is absent or stale and you visit
   `youtube.com/feed/channels` yourself, the extension observes as you
   scroll - never scrolling for you - and saves the list if you naturally
   reach the end.
4. **Manual full sync.** The "Refresh now" button opens the subscriptions
   page as a foreground tab, auto-scrolls it to the end, saves, and closes
   it.

The cache is marked *stale* after 30 days without a full sync. Staleness
never turns filtering off; it drives signals instead: an amber badge, a
tooltip naming the age in days, and a refresh prompt in the options page and
toolbar popup. A partial list is never cached - every collection either
completes positively or leaves the existing cache untouched.

---

## Architecture

```
src/
  content.js          wiring, SPA navigation, state refresh
  background.js       badge, alarms, collect-tab lifecycle
  options.js          settings UI, manual refresh
  popup.js            stale-cache toolbar panel
  rules/
    decide.js         pure decision function
    defaults.js
  dom/
    tile-adapter.js   ALL YouTube tile selectors live here
    applier.js        MutationObserver, hide/restore
    block-button.js   the two per-tile controls
    native-menu.js    drives YouTube's own menu (fail-closed)
    styles.js  empty-sections.js  starvation.js
  locale/             age and view parsing, EN + DE
  storage/            config (sync), blocklist/watched/subs (local)
  subs-refresh.js     subscription collection loop
  subs-scrape.js      channel-name extraction from the rendered page
  subs-capture.js     live subscribe/unsubscribe capture on /watch
  channel-name.js     shared name normalization
```

Design principles:

- **Fail-open for filtering, fail-closed for actions.** Any parse failure
  leaves a video *shown*. Everything that acts or writes - the native-menu
  driver, the subscription collectors, the live capture - inverts this: on a
  missing element, a timeout, or an unknown label it does nothing.
- **All decisions key on `videoId`, never on the DOM node.** YouTube recycles
  tiles.
- **Channel rules key on display name.** The tile DOM exposes no channel ID.
- All YouTube selectors are centralized and were captured from the live
  page, never assumed.

### Storage

| Key | Area | Notes |
|---|---|---|
| config | `sync` | thresholds and toggles |
| `subs` | `local` | `{ ids, fetchedAt, format }`, no expiry - 30 days marks it stale |
| `manualSubs` | `local` | user-supplied, unioned with the fetched set |
| `blocklist` | `local` | display names |
| `watched` | `local` | LRU, capped at 5000 |

---

## Development

```bash
npm test        # node --test + jsdom
npm run build   # esbuild, IIFE (MV3 content scripts cannot be ES modules)
npm run icons   # regenerate the four PNG sizes
npm run package # -> youtube-tuner-<version>.zip
npm run crx     # -> signed youtube-tuner-<version>.crx
```

**Reloading the extension does not update content scripts in already-open
tabs** - reload the YouTube tab too, or you will debug a stale build.

No npm dependencies beyond esbuild and jsdom: `tools/make-icons.mjs` encodes
PNGs and `tools/package.mjs` writes the ZIP container by hand, on `zlib` and
`crypto` alone. A test asserts the archive's file list in full, so an
accidental `src/` or `test/` inclusion fails the build rather than silently
shipping source.

`npm run crx` signs the archive into a CRX3. It reads the RSA key from
`YTT_CRX_KEY`, defaulting to `key.pem` in the repo root, and refuses to run
rather than generating one - the key determines the extension ID. `*.pem`
and `*.crx` are gitignored.

### Releases

Pushing a `v*` tag runs the GitHub Actions workflow: tests gate the build,
the tag must match the manifest version, and the release ships both the zip
and the signed CRX.

---

## License

[AGPL-3.0](LICENSE). YouTube is a trademark of Google LLC; this project is
not affiliated with or endorsed by Google.
