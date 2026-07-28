# youtube-tuner

youtube-tuner removes unwanted videos from the YouTube home feed and from
the watch-page sidebar. It hides videos that are old, seen before, or low in
views, and videos from blocked channels. It does not hide videos from your
subscribed channels.

The extension operates only in your browser. It does not send data. It does
not connect to external services. It reads only the YouTube pages that are
open.

- **Permissions:** `storage`, `alarms`, and access to `youtube.com`. No
  other permissions.
- **Tests:** 244 tests with `node --test` and jsdom. A browser is not
  necessary for the tests.
- **License:** AGPL-3.0.
- **Language support:** The extension is verified with the German YouTube
  interface only. The English interface has code but is not tested. Other
  languages are not supported. On an unsupported language, the extension is
  safe: it does not click, it does not write, and all videos stay visible.

---

## Installation

Download the applicable file from the [releases page](../../releases). Each
release has two files.

### ZIP file (all Chromium browsers)

1. Download `youtube-tuner-<version>.zip`.
2. Extract the file to a permanent folder.
3. Open `chrome://extensions`. Set **Developer mode** to on.
4. Click **Load unpacked**.
5. Select the folder.

### CRX file (Helium, ungoogled-chromium)

1. Download `youtube-tuner-<version>.crx`.
2. Drag the file to the `chrome://extensions` page and release it there.

Google Chrome does not accept CRX files from sources other than the Chrome
Web Store. For Google Chrome, use the ZIP procedure.

The CRX file has a signature from one permanent key. Thus the extension ID
stays the same in each version, and your settings stay after an update.
There is no automatic update. To install a new version, download the new
file and do the installation again.

The browser connects the stored settings to the extension ID. To move
settings to a different installation, use the export and import functions on
the options page.

---

## Operation

Configuration is not necessary. Open YouTube. The extension applies the
filter rules.

The toolbar badge shows the number of hidden videos on the page. Click the
toolbar icon to set the filters to on or to off. When the subscription list
is more than 30 days old, the badge becomes amber. Then a click on the icon
opens a small panel. The panel has the same on/off control and a refresh
button.

Use the options page to change the thresholds, the channel blocklist, the
manual subscription entries, and the settings export and import.

### Filter rules

The rules apply in this sequence. The first applicable rule wins.

| # | Condition | Result |
|---|-----------|--------|
| 1 | the extension is off | show |
| 2 | the channel is on the local blocklist | **hide** |
| 3 | the video is seen (resume bar, or in the watched set) | **hide** |
| 4 | the subscription list is not available | show (rules 6 and 7 stop) |
| 5 | the channel is a subscribed channel | show |
| 6 | the video is older than `maxAgeDays` | **hide** |
| 7 | the views are less than `minViews` after the grace time | **hide** |
| 8 | none of the conditions above | show |

Default values (`src/rules/defaults.js`): 1095 days, 5000 views, 48 hours
of grace time for new uploads.

Rule 4 is intentional. Without the subscription list, the extension cannot
know your subscribed channels. Then it is safer to show all videos than to
hide videos from a subscribed channel.

The extension filters only the home feed (`/`) and the watch page
(`/watch`). It does not change other pages. The toolbar control stops the
filters immediately. A page reload is not necessary.

### Tile controls

Two controls show when the pointer is on a video tile:

- **👎 Not interested.** This control operates YouTube's own "Not
  interested" function for the video. It shows on all tiles.
- **🚫 Block channel.** This control operates YouTube's own "Don't recommend
  channel" function and puts the channel on the local blocklist. It does not
  show on subscribed channels.

The local blocklist is necessary because YouTube's function does not remove
the tiles that are on the screen. The local blocklist removes them
immediately.

### The subscription list

The subscription list controls rule 5. The extension keeps the list current
with four mechanisms:

1. **Subscribe capture.** When you subscribe on a watch page, the extension
   adds the channel to the list immediately.
2. **Unsubscribe capture.** When you unsubscribe on a watch page, the
   extension removes the channel. Before it removes the channel, it reads
   the button state two times to make sure.
3. **Passive collection.** When the list is absent or stale and you open
   `youtube.com/feed/channels`, the extension monitors the page. It does not
   scroll for you. It saves the list only if you go to the end of the page.
4. **Manual collection.** The "Refresh now" button opens the subscriptions
   page in a new foreground tab. The tab scrolls to the end, saves the
   list, and closes.

The list becomes stale 30 days after the last full collection. A stale list
does not stop the filters. The extension only shows the amber badge, a
tooltip with the age in days, and a refresh prompt on the options page and
in the toolbar panel.

The extension never saves an incomplete list. If a collection does not
complete, the extension keeps the last good list.

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
    block-button.js   the two tile controls
    native-menu.js    operates YouTube's own menu (fail-closed)
    styles.js  empty-sections.js  starvation.js
  locale/             age and view parsing, EN + DE
  storage/            config (sync), blocklist/watched/subs (local)
  subs-refresh.js     subscription collection loop
  subs-scrape.js      channel-name extraction from the page
  subs-capture.js     subscribe/unsubscribe capture on /watch
  channel-name.js     shared name normalization
```

Design rules:

- **Filters fail open. Actions fail closed.** If the extension cannot parse
  a video, the video stays visible. If an action or a write finds an unknown
  element, an unknown label, or a timeout, it does nothing.
- **Decisions use the `videoId`, not the DOM node.** YouTube uses DOM nodes
  again for different videos.
- **Channel rules use the channel display name.** The tile DOM does not
  contain a channel ID.
- All YouTube selectors are in central locations. Each selector is verified
  on the live page.

### Storage

| Key | Area | Notes |
|---|---|---|
| config | `sync` | thresholds and switches |
| `subs` | `local` | `{ ids, fetchedAt, format }`; stale after 30 days |
| `manualSubs` | `local` | user entries; the extension adds them to the fetched set |
| `blocklist` | `local` | channel display names |
| `watched` | `local` | LRU with a limit of 5000 entries |

---

## Development

```bash
npm test        # node --test + jsdom
npm run build   # esbuild, IIFE (MV3 content scripts cannot be ES modules)
npm run icons   # makes the four PNG files again
npm run package # -> youtube-tuner-<version>.zip
npm run crx     # -> signed youtube-tuner-<version>.crx
```

When you install a new build, also reload the open YouTube tabs. Old content
scripts stay in open tabs.

The only npm dependencies are esbuild and jsdom. `tools/make-icons.mjs`
makes the PNG files and `tools/package.mjs` makes the ZIP container with
`zlib` and `crypto` only. A test compares the full file list of the archive.
Thus the archive cannot contain source files by accident.

`npm run crx` signs the archive as a CRX3 file. It reads the RSA key from
the path in `YTT_CRX_KEY`, or from `key.pem` in the repository root. If the
key is absent, the tool stops. It does not make a new key, because the key
sets the extension ID. The patterns `*.pem` and `*.crx` are in `.gitignore`.

### Releases

Push a tag `v<version>` to start the release workflow. The workflow runs
the tests, compares the tag with the manifest version, builds the ZIP and
the signed CRX, and creates the GitHub release.

---

## License

The license is [AGPL-3.0](LICENSE). YouTube is a trademark of Google LLC.
This project has no connection with Google.
