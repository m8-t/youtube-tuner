# youtube-tuner

A Chromium MV3 extension that filters YouTube's recommendations on the home
feed and the watch-page sidebar, keeps your subscription list in sync without
any external API, and adds one-click controls for training YouTube itself.

Everything runs locally. The extension makes **zero network requests** of its
own: no telemetry, no external services, no YouTube API calls. It only reads
the pages you already have open.

- **Permissions:** `storage`, `alarms`, and host access to `youtube.com` -
  nothing else.
- **248 tests**, `node --test` + jsdom, no browser dependency.
- **License:** AGPL-3.0.

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
your settings, blocklist and watched history - survives updates. Updating
still means downloading the new file and reinstalling; there is no auto-update
without a Web Store listing.

To move settings between machines or between an unpacked and a CRX install
(storage is keyed to the extension ID), use the export/import buttons in the
options page.

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

Two stacked controls appear on hover, top-left at `z-index: 9999` (top-right
collided with YouTube's watch-later overlay):

- **👎 Not interested** - fires YouTube's native per-video action. Shown on
  every tile, including subscribed channels, since it is a per-video
  judgement.
- **🚫 Block channel** - fires YouTube's native "don't recommend channel"
  action **and** writes to the local blocklist. Suppressed on subscribed
  channels.

Both layers are kept for the block button on purpose: the native ban only
shapes *future* recommendations, cannot be read back to verify, and does not
remove tiles already on screen. The local list makes the click take effect
immediately.

### The subscription cache maintains itself

The subscription list is the linchpin of the exemption rules, and it stays
current through four mechanisms, ordered from most to least automatic:

1. **Live capture on subscribe.** Clicking Subscribe on a watch page adds the
   channel to the cache instantly. A freshly subscribed channel is never
   age/view-filtered, not even for a minute.
2. **Live capture on unsubscribe.** Unsubscribing on a watch page removes the
   channel again - verified by two delayed re-reads of the button state
   before anything is deleted, because removal is the risky direction.
3. **Passive collection.** When the cache is absent or stale and you visit
   `youtube.com/feed/channels` yourself, the extension observes as you
   scroll - never scrolling for you - and saves the list if you naturally
   reach the end.
4. **Manual full sync.** The "Refresh now" button opens
   `/feed/channels#ytt-collect` as a foreground tab (the one context Chrome
   fully renders - see the dead-ends table below), auto-scrolls it to the
   end, saves, and closes it.

The cache is marked *stale* after 30 days without a full sync - live captures
deliberately do not reset that clock. Staleness never turns filtering off; it
drives signals instead: an amber badge, a tooltip naming the age in days, and
a refresh prompt in the options page and toolbar popup.

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

### Invariants that must not be broken

**`applier.js` uses `attributeFilter: ['href']`.** The scan loop only
converges because the buttons write `dataset` and `class` on every pass and
those do not match the filter. Widening it causes an infinite loop.

**`readTile` returns `null` for nested tiles.** The grid wraps
`ytd-rich-item-renderer` around `yt-lockup-view-model` 1:1, so without
`isOutermostTile` every video counts twice and gets two sets of buttons.

**All decisions key on `videoId`, never on the DOM node.** YouTube recycles
tiles.

**Fail-open for filtering, fail-closed for actions.** Any parse failure
leaves a video *shown*. But everything that acts or writes - the native-menu
driver, the subscription collectors, the live capture - inverts this: on a
missing popup, a timeout, an unknown label, or anything short of an exact
match, it does **nothing**. "Melden" / "Report" sits two rows below both
targets in that menu.

---

## Verified DOM findings

Captured live, never assumed. Fixtures in `test/fixtures/`.

- Tiles are `yt-lockup-view-model`. `ytd-compact-video-renderer` no longer
  exists anywhere.
- **No channel ID is present in the tile DOM** - no `/@handle`, no
  `/channel/UC...`. Channel rules therefore key on **display name**, exact
  match after normalization.
- Metadata comes from `aria-label` first; visible text is unparseable on
  English tiles (`3.4M`, `3mo ago`). Home-feed view counts have no
  `aria-label` at all and need the visible-text fallback.
- Watched marker is
  `yt-thumbnail-overlay-progress-bar-view-model .ytThumbnailOverlayProgressBarHostWatchedProgressBar`.
- Ragged grid rows came from zero-height full-width
  `ytd-rich-section-renderer` elements forcing flex line breaks; collapsing
  them fixes the gaps.
- The per-tile menu button is `.ytLockupMetadataViewModelMenuButton button` -
  located structurally, **not** by `aria-label`, which is locale-dependent.
- Menu items render in a **document-level shared popup**, outside the tile:
  `yt-list-item-view-model.ytListItemViewModelHost[role="menuitem"]`. There
  is no reliable wrapper selector; a container walk climbs to `<html>`.
- German menu strings: `Kein Interesse`, `Keine Videos von diesem Kanal
  empfehlen`. The second is *not* the literal translation one would guess,
  which is why the English pair is treated as unverified best-effort.
- On the watch page, the subscribe button sits in `div#owner` (chain:
  `ytd-subscribe-button-renderer` > `div#subscribe-button` > `div#owner` >
  `ytd-watch-metadata`) - `ytd-video-owner-renderer` no longer exists there.
  The first channel anchor under `#owner` is a textless avatar link; the
  display name lives in the second.

---

## The subscription list: what didn't work

Getting the full subscription list took six attempts. Recording the dead ends
because each looked plausible.

| Attempt | Result |
|---|---|
| Parse `/feed/channels` HTML once | 98 of 330 names. The page lazy-loads; only page one is in `ytInitialData`. |
| InnerTube from the service worker | **403.** No `Origin`, no `Referer` (forbidden headers an extension cannot set), no `SAPISIDHASH`. |
| InnerTube from a MAIN-world script | **200 with an empty 1574-byte body.** |
| Same, with key/context/token all from one fetch | Identical empty 200 - ruling out session mismatch. |
| Hidden iframe at `left: -10000px` | 98 names, bottom reached, sentinel still present. |
| Same iframe in-viewport at `opacity: 0` | Identical. |

**Conclusions, all measured:**

- An empty 200 from `/youtubei/v1/*` means *unauthenticated*. Cookies alone
  do not authenticate InnerTube; it wants a `SAPISIDHASH` header. See the
  section below - this was later proven and is no longer the blocker it
  looked like.
- Chrome withholds the rendering work that YouTube's `IntersectionObserver`
  lazy-loader depends on in any frame it considers non-visible. No
  positioning trick changes this. Background and occluded tabs are throttled
  the same way, which is why the manual sync opens a *foreground* tab.
- `ytInitialGuideData` is not embedded in the page and exists as no global.
  The rendered guide DOM holds only navigation plus a stub - 60 entries for
  a 330-subscription account. The full list materializes only after a real
  click on "Show more".

### InnerTube auth: solved, deliberately not used

Measured after the six attempts above. The `SAPISIDHASH` theory was correct
and the header **does** authenticate. Computed in the page context:

```js
ts   = Math.floor(Date.now() / 1000)
hash = SHA1(`${ts} ${SAPISID} https://www.youtube.com`)     // WebCrypto
head = `SAPISIDHASH ${ts}_${hash}`
```

`SAPISID` is readable from `document.cookie` on youtube.com - it is **not**
HttpOnly, so no `cookies` permission and no background-worker cookie handoff
would be needed.

With that header on a POST to `/youtubei/v1/browse`:

| Field | Before | After |
|---|---|---|
| body size | 1574 B | 21337 B |
| `responseContext…loggedOut` | (absent) | **`false`** |

So the extension can authenticate to InnerTube. What remains is not an auth
problem: `browseId: FEchannels` returns a `tabRenderer` whose content shell
is empty - zero channel entries, zero continuation tokens - while the page's
own `ytInitialData` under the identical session holds 98 `channelRenderer`
entries plus one continuation token. The raw call is missing a `params` blob
the web client sends. The untested next step would be to reuse the page's own
token rather than reconstruct the browse call.

**Not implemented, by choice.** The tab flow plus live capture already covers
everything, and this route trades a rare tab flash for an undocumented API
that changes without notice, plus a nonzero risk of account restrictions on
authenticated automation. The same reasoning rules out the official Data API:
`subscriptions.list(mine=true)` over OAuth would work, but a Google Cloud
project, a consent screen, and refresh-token custody is a lot of
infrastructure for a sync that live capture has made roughly-annual. Recorded
so the dead-end table above is not read as "impossible" - both routes are
possible, they are just not worth it.

## The subscription list: what works

**Live capture** (`src/subs-capture.js`) handles the common case: subscribe
and unsubscribe actions on watch pages update the cache the moment they
happen. The unsubscribe side never parses YouTube's popup menu or
confirmation dialog - it arms on a click on the subscribed button and
removes only after two delayed re-reads agree the button flipped back to the
unsubscribed state. Unknown labels mean the DOM changed, and nothing happens.

**Manual refresh** opens `https://www.youtube.com/feed/channels#ytt-collect`
as an *active foreground* tab - the one context Chrome fully renders. The
content script recognizes the hash marker, scrolls its own top-level document
to the end, reports back, and the background closes the tab it created. Gated
behind an explicit confirmation, because a tab that opens, scrolls itself and
closes reads as the browser acting alone.

**Passive collection** runs on an unmarked `/feed/channels` visit when the
cache is absent or stale: it observes without ever scrolling or navigating,
and saves only if the user naturally reaches the end.

The background alarm never opens a tab. It only reads the cache.

### Never cache a partial list

The single most important guarantee, and the one that made every failure
above *visible* instead of silent. A truncated list looks perfectly healthy:
plausible names, a fresh timestamp, no error anywhere. That is how an early
98-name truncation hid for weeks.

`saveSubs` is called only when the collector reports `complete === true` with
a non-empty list. Every failure path keeps the existing cache and surfaces a
named reason plus diagnostic counters in the options UI. Live capture edits
the membership of an existing complete record but never fabricates one.

### Recurring root cause: absence read as completion

Three separate bugs, one shape:

- no continuation token found → "complete"
- a continuation returning zero names → "complete"
- a scroll that stopped growing → "complete"

Completeness is now established **positively**: YouTube renders
`ytd-continuation-item-renderer` while more pages remain and removes it at
the end, so its *absence after the grid settles* is affirmative evidence.
Combined with stability across three checks, bottom reached, a time budget,
and a non-empty result.

### The name-duplication bug

`#channel-title` contains the display name **twice**, so `textContent`
flattened to `"hessencam\n  \n  \n  \n    hessencam"`. `trim()` only strips
the ends, so exact-match membership failed for all 330 names and every
subscribed channel wrongly kept its block button.

Fixed by first-non-empty-line extraction (`src/channel-name.js`), applied
both at scrape time and inside `normalizeNames`, so dirty caches self-heal on
load. Collapsing whitespace runs would have been wrong - it yields the name
duplicated on one line.

---

## Storage

| Key | Area | Notes |
|---|---|---|
| config | `sync` | thresholds and toggles |
| `subs` | `local` | `{ ids, fetchedAt, format }`, no expiry - 30 days marks it stale |
| `manualSubs` | `local` | user-supplied, unioned with the fetched set |
| `blocklist` | `local` | display names |
| `watched` | `local` | LRU, capped at 5000 |

`subs` carries a **format version**. A record written by an older, broken
scraper is treated as absent on load, so a bad cache cannot re-perpetuate.
Live capture preserves `fetchedAt` on both add and remove - the staleness
clock measures full-sync age, not last-touched.

### Age nudges, it does not invalidate

The cache originally expired after 7 days, and `loadSubs()` returned `null`
past that point - which made `decide()` stand down and silently switched off
the age and view rules. Nothing re-collected the list, so the extension's two
headline rules went dark one week after the last refresh with no prompt.

That chose the worse of two failure modes:

| State | Consequence |
|---|---|
| Slightly stale list | A recently-subscribed channel is not exempt yet. A few of its videos get filtered. Mild. |
| No list at all | Age and view rules stop completely. |

A year-old list still beats none. `loadSubs()` now returns the names
regardless of age and only `null` for a genuinely absent or unusable record.
Age drives signals instead: an amber badge, a toolbar tooltip naming the age
in days, a prompt in the options page, and a toolbar popup. Live capture has
since made staleness rare enough that the window is 30 days.

**The popup only exists while the cache is stale.** `chrome.action.onClicked`
fires only when the action has no popup, so `popup.html` is attached and
detached at runtime rather than declared in the manifest - fresh cache, the
icon toggles the kill switch; stale cache, it opens a panel offering "Refresh
now". The panel carries the kill-switch toggle too, since the icon can no
longer provide it while the popup is attached.

The panel explains in one sentence that a tab will open, scroll itself and
close. That sentence *is* the confirmation: creating the collect tab takes
focus and closes the popup, so a `window.confirm()` there would be a trap.

The daily alarm refreshes those indicators. It still never opens a tab - that
constraint is what the whole foreground-tab flow exists to respect.

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

### Releases

Pushing a `v*` tag runs the GitHub Actions workflow: tests gate the build,
the tag must match the manifest version, and the release ships both the zip
and the signed CRX. The signing key lives in the `YTT_CRX_KEY_PEM` repository
secret and is written only to a temp file outside the workspace during the
run.

### Packaging

No npm dependencies beyond esbuild and jsdom, and none were added for any of
this: `tools/make-icons.mjs` encodes PNGs and `tools/package.mjs` writes the
ZIP container by hand, on `zlib` and `crypto` alone. Keep it that way.

The archive ships exactly eleven files - manifest, options page, popup page,
four bundles, four icons. A test asserts the entry list in full, so an
accidental `src/` or `test/` inclusion fails rather than silently shipping
source.

`npm run crx` signs that archive into a CRX3. It reads the RSA key from
`YTT_CRX_KEY`, defaulting to `key.pem` in the repo root, and refuses to run
rather than generating one - the key determines the extension ID, so a
silently-generated key would produce an extension that installs alongside the
real one instead of over it. `*.pem` and `*.crx` are gitignored.

### Settings export and import

The options page writes a JSON file holding both storage areas. Import
validates before it writes anything: a malformed file, a wrong `format`, or a
non-object storage area leaves existing settings untouched. Only the areas
present in the file are replaced, so a `local`-only export cannot clear
`sync`.

This exists because storage is keyed to the extension ID, and the ID comes
from the signing key. Moving between an unpacked install and a CRX - or
losing the `.pem` - starts from empty storage.

Fixtures under `test/fixtures/` are real captured markup. Never hand-edit
them.

---

## Known gaps

- **`src/subs-parse.js` is dead production code.** It parsed `ytInitialData`
  for the abandoned InnerTube approach and is now referenced only by its own
  test. Safe to delete along with `test/subs-parse.test.js`.
- **English UI strings are unverified.** German is live-captured; the English
  menu pair in `native-menu.js` and the `Subscribe`/`Subscribed` labels in
  `subs-capture.js` are best-effort. A miss fails closed - nothing is
  clicked, nothing is written.
- **Whether "Kein Interesse" needs a confirmation click** is unresolved. The
  driver is structured so an optional second poll-and-click step slots in.
- **No auto-update.** Releases make the download easy, but installing an
  update on a second machine is still a manual step. Auto-update would need
  an update manifest served over HTTPS, or an unlisted Chrome Web Store
  listing - the only route that also syncs.
- **Subscribes made on other devices** (phone, TV) reach the cache only
  through a passive or manual full sync, or the first time you subscribe or
  unsubscribe to the same channel in this browser.

---

## License

[AGPL-3.0](LICENSE). YouTube is a trademark of Google LLC; this project is
not affiliated with or endorsed by Google.
