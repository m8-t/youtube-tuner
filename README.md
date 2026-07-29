# youtube-tuner

youtube-tuner removes unwanted videos from your YouTube recommendations. It is
a Manifest V3 extension for Chromium browsers and operates fully in your
browser.

**What it hides** in the home feed and the watch-page sidebar:

- Videos from channels on your local blocklist
- Videos that you opened before
- Videos that are older than your age limit
- Videos with too few views after a grace period

**What it protects:** the age rule and the view rule do not apply to your
subscribed channels. Only the blocklist rule and the watched rule apply to
all channels.

**Private by design:** no analytics, no remote API calls, no accounts. The
extension requests only `storage`, `alarms`, and access to `youtube.com`.

**Self-maintaining:** after one initial collection, the subscription list
updates itself when you subscribe or unsubscribe. This also works for changes
that you make on a different device.

**Language support:** the German YouTube interface is verified. English has
code, but its action labels are not verified. On all other languages, the
extension falls back to safe behavior.

**License and quality:** AGPL-3.0, 257 automated tests, zero runtime
dependencies.

This README uses [ASD-STE100 Simplified Technical
English](https://www.asd-ste100.org/). The simple sentences are intentional.

## Install

Download the files from the [releases page](../../releases).

### Install the ZIP file

Use this procedure in a Chromium browser that can load unpacked extensions.

1. Download `youtube-tuner-<version>.zip`.
2. Make a new, empty folder in a permanent location, for example
   `Documents/youtube-tuner`. Do not use the Downloads folder.
3. Extract the ZIP file into this folder. The folder must then contain the
   file `manifest.json`.
4. Type `chrome://extensions` in the browser address bar and press Enter.
5. Turn on the **Developer mode** switch in the top right corner of the
   page.
6. Select the **Load unpacked** button in the top left corner of the page.
7. In the folder dialog, select the folder from step 2.

The browser loads the extension from this folder at each start. If you
delete, move, or rename the folder, the extension stops.

To update the extension: download the new ZIP file, extract it into the same
folder, and replace all files. Then select the reload symbol (circular
arrow) on the youtube-tuner card in `chrome://extensions`.

### Install the CRX file

Use this procedure only if your browser permits external CRX files. Helium and
ungoogled-chromium support this method.

1. Save `youtube-tuner-<version>.crx` to your computer.
2. Open `chrome://extensions`.
3. Drag the CRX file to the page.

If a direct download causes `CRX_REQUIRED_PROOF_MISSING`, use one of these
procedures:

- Click the link with the right mouse button and select **Save Link As**.
  Then use the drag procedure.
- Set `chrome://flags/#extension-mime-request-handling` to "Always prompt for
  install". Then a direct click installs the file.

If the browser rejects the CRX file, use the ZIP procedure.

The project uses one permanent signing key for all CRX releases. The same key
gives each CRX release the same extension ID. The extension has no automatic
update service. Install each new release manually.

The browser connects stored data to the extension ID. Export your settings
before you change the installation method.

## Configure

### Collect your subscriptions

The extension needs your subscription list before it can safely use the age
rule and the view rule. Use this procedure:

1. Open the extension options page.
2. Select **Refresh now**.
3. Confirm the operation.

The extension opens your YouTube channels page in a foreground tab. It scrolls
to the end, saves the complete list, and closes the tab.

Alternatively, open `youtube.com/feed/channels` and scroll to the end yourself.
The extension monitors this page when the list is absent or stale. It does not
scroll during this passive collection.

If no fetched or manual subscription list exists, the age rule and the view
rule do not operate. The watched rule and the blocklist rule still operate.

After a full collection, the extension updates the stored list in these ways:

- A subscribe action on a watch page adds the channel.
- An unsubscribe action removes the channel after two matching checks.
- Two matching checks on a watch page can correct a change from another
  device.
- A passive collection can replace an absent or stale list when you scroll to
  the end of `youtube.com/feed/channels`.

The watch-page updates operate only while filtering is on. They also require a
usable fetched subscription list.

A full list becomes stale after 30 days. A stale list remains in use. The
extension saves a full collection only when the list is nonempty, stable, and
complete. If collection fails, it keeps the last good full list.

### Filter order

The toolbar badge shows the number of hidden videos. An amber badge means that
the subscription list is absent or stale. In this case, the toolbar icon opens
a panel with the filter switch and the refresh control. With a current list,
the icon turns filtering on or off.

Use the options page to set the limits, edit channel lists, clear the watched
history, and export or import settings.

The first applicable rule gives the result.

| Order | Condition | Result |
|---|---|---|
| 1 | Filtering is off. | Show the video. |
| 2 | The channel is on the local blocklist. | Hide the video. |
| 3 | The video has a resume bar or is in the watched set. | Hide the video. |
| 4 | No subscription set is available. | Show the video. |
| 5 | The channel is in the subscription set. | Show the video. |
| 6 | The video is older than the age limit. | Hide the video. |
| 7 | The video has too few views after the grace period. | Hide the video. |
| 8 | No rule above applies. | Show the video. |

The default limits are 1095 days, 5000 views, and a 48-hour grace period.

### Tile controls

Each readable video tile has a **Not interested** control. This control tries
to select YouTube's **Not interested** menu item.

A tile also has a **Block channel** control if the channel is not in the known
subscription set. This control adds the channel to the local blocklist. It also
tries to select YouTube's **Don't recommend channel** menu item.

The native YouTube actions support exact English and German menu labels. If the
extension cannot find one exact menu item, it does not select a menu item. The
local blocklist update does not depend on the native YouTube action.

## Privacy and compatibility

The extension has no analytics and does not call a remote API. It reads YouTube
pages and uses the browser storage APIs. It does not send data to the project
author.

The manifest requests `storage`, `alarms`, and access to `youtube.com`. It does
not request other permissions.

The text-dependent features have code for English and German. Live captures
verified the German interface and the English watch-page sidebar. The English
action labels (the menu items and the subscribe button) are not verified.

If a menu label does not match exactly, the extension does not select a menu
item. If a subscribe-button label does not match exactly, the extension does
not change the subscription list. The **Block channel** control updates the
local blocklist independently of the menu label.

The automated tests use fixtures from live pages: three German pages and one
English sidebar page. The age and view parsers have test coverage in both
languages.

The extension treats every other interface language as English. If it cannot
parse an age or a view count, it shows the video. The watched rule and the
blocklist rule can still hide the video.

| Data | Storage area |
|---|---|
| Filter switches and limits | `sync` |
| Fetched and manual subscription names | `local` |
| Blocked channel names | `local` |
| Watched video IDs | `local` |
| Subscription cache and collection times | `local` |

The watched set contains a maximum of 5000 video IDs. If a new ID exceeds this
limit, the extension removes the oldest ID.

Your browser can sync the filter configuration because the extension uses
`storage.sync`. The extension keeps the channel lists and watched IDs in
`storage.local`.

The settings export contains all data from both storage areas. An import
replaces each storage area that is present in the import file.

## Architecture

```
src/
  content.js          wiring, SPA navigation, state refresh
  background.js       badge, alarms, collect-tab lifecycle
  options.js          settings UI, manual refresh
  popup.js            stale-list toolbar panel
  rules/
    decide.js         pure decision function
    defaults.js
  dom/
    tile-adapter.js   all YouTube tile selectors
    applier.js        MutationObserver, hide and restore
    block-button.js   the two tile controls
    native-menu.js    operates YouTube's own menu, fail-closed
    styles.js  empty-sections.js  starvation.js
  locale/             age and view parsing, EN and DE
  storage/            config (sync); blocklist, watched, subs (local)
  subs-refresh.js     subscription collection loop
  subs-scrape.js      channel-name extraction from the page
  subs-capture.js     subscribe, unsubscribe, and reconcile on /watch
  channel-name.js     shared name normalization
```

Design rules:

- Filters fail open. An unreadable tile stays visible. An unparseable age or
  view count only disables the age rule and the view rule.
- Native actions and subscription-list writes fail closed. An unknown
  element, an unknown label, or a timeout causes no click and no write. The
  local blocklist write is intentionally independent.
- Decisions use the video ID, not the DOM node. YouTube uses DOM nodes again
  for different videos.
- Channel rules use the channel display name. The tile DOM does not contain a
  channel ID.
- All YouTube selectors are in central locations.

## Develop

| Command | Result |
|---|---|
| `npm test` | Run the Node.js tests with jsdom. |
| `npm run build` | Create the IIFE bundles. |
| `npm run icons` | Create the four PNG icon files. |
| `npm run package` | Create `youtube-tuner-<version>.zip`. |
| `npm run crx` | Create a signed CRX3 file. |

The direct development dependencies are esbuild and jsdom. The package tool
uses an allowlist of 11 extension files. A test verifies this list so that the
package does not include source files.

The CRX tool reads the RSA private key from `YTT_CRX_KEY`. If this variable is
not set, it reads `key.pem` from the repository root. The tool stops if the key
does not exist. It never creates a replacement key because a different key
changes the extension ID.

After you install a new build, reload each open YouTube tab. Old content scripts
stay active until you reload the tab.

Push a tag in the form `v<version>` to create a release. The workflow runs the
tests, checks the manifest version, builds both release files, and creates the
GitHub release.

## License

The project uses the [AGPL-3.0 license](LICENSE). YouTube is a trademark of
Google LLC. This project has no connection with Google.
