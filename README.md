# youtube-tuner

[![Release](https://github.com/m8-t/youtube-tuner/actions/workflows/release.yml/badge.svg)](https://github.com/m8-t/youtube-tuner/actions/workflows/release.yml)

youtube-tuner removes unwanted videos from your YouTube recommendations. It is
a Manifest V3 extension for Chromium browsers and operates fully in your
browser.

🧹 **What it hides** in the home feed and the watch-page sidebar:

- Videos from channels on your local blocklist
- Videos that you hid one by one
- Videos that you opened before
- Videos that are older than your age limit
- Videos with too few views after a grace period

🛡️ **What it protects:** the age rule and the view rule do not apply to your
subscribed channels. Only the blocklist rule, the hidden videos, the title
rule, and the watched rule apply to all channels.

**Local first:** a block or a hidden video stays in the extension. YouTube
is not told. Feedback to YouTube is a separate option. It is off by default
and has a weekly limit.

🔒 **Private by design:** no analytics, no accounts, no third-party code in
the bundle. The only external call is one optional request per day to
`api.github.com` for the update check. A switch in the toolbar menu turns
this off.

🔄 **Self-maintaining:** after one initial collection, the subscription list
updates itself when you subscribe or unsubscribe. This also works for changes
that you make on a different device.

☁️ **Sync between devices (beta):** optional sync through your own WebDAV
storage. The extension encrypts the data before upload. No accounts, no
project servers.

🌍 **Language support:** the German YouTube interface is verified. English has
code, but its action labels are not verified. On all other languages, the
extension falls back to safe behavior.

📜 **License:** AGPL-3.0.

![The YouTube home feed with the two tile controls on each
video](assets/home-feed.jpg)

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

An update over an installed CRX can stay inactive until you fully restart
the browser. The extensions page shows the new version number only after
the restart.

The project uses one permanent signing key for all CRX releases. The same key
gives each CRX release the same extension ID. The extension has no automatic
update service. Install each new release manually.

The extension can tell you about a new release. Once per day it asks the
GitHub releases API for the newest version. If a newer release exists, the
toolbar menu and the icon tooltip show a notice with a link to the releases
page. The extension does not download or install the release. The toolbar
menu has a **Check for updates** button for a manual check and a switch that
turns the daily check off.

The browser connects stored data to the extension ID. If you remove the
extension, the browser deletes its stored data: the settings, the blocklist,
the watched history, and the subscription list. An update keeps the data.

The options page has an **Export settings** and an **Import settings**
function for this case. Before you remove the extension or change the
installation method, export your settings to a JSON file. After the new
installation, import the file. The import restores all stored data.

After each installation or update, reload the open YouTube tabs. The
extension does not attach to tabs that were open before.

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

The extension filters the home feed, the watch-page sidebar, the
subscriptions feed, and the search results.

The toolbar badge shows the number of hidden videos. An amber badge means that
the subscription list is absent or stale.

A click on the toolbar icon opens the control menu. The menu has the filter
on/off switch, the subscription-list status with a refresh button, the
**Check for updates** button, and the daily update check switch. When sync
is enabled, the menu also has a **Sync now** button, the time of the last
sync, and the last sync error if one exists. The **Options** button opens
the options page. The popup and the options page follow the system light
or dark theme.

Use the options page to set the limits, edit channel lists, clear the watched
history, and export or import settings.

The first applicable rule gives the result.

| Order | Condition | Result |
|---|---|---|
| 1 | Filtering is off. | Show the video. |
| 2 | You hid this video. | Hide the video. |
| 3 | The channel is on the local blocklist. | Hide the video. |
| 4 | The title contains a blocked phrase. | Hide the video. |
| 5 | The page is a search result page. | Show the video. |
| 6 | The video has a resume bar or is in the watched set. | Hide the video. |
| 7 | No subscription set is available. | Show the video. |
| 8 | The channel is in the subscription set. | Show the video. |
| 9 | The video is younger than the minimum age (off by default). | Hide the video. |
| 10 | The video is older than the age limit. | Hide the video. |
| 11 | The video has too few views after the grace period. | Hide the video. |
| 12 | No rule above applies. | Show the video. |

You asked for the videos on a search result page. Thus only your own blocks
apply there (rules 2 to 4). The watched rule, the age rule, and the view rule
do not apply.

The default limits are 1095 days, 5000 views, and a 48-hour grace period. The minimum age is 0 hours (off). A minimum age above the grace period makes the grace period have no effect.

### Channel rules

The options page has a "Channel rules" table for per-channel exceptions. For
each channel you can:

- Turn the watched rule off.
- Set the age rule to off, or to a custom day limit.
- Set the view rule to off, or to a custom view limit.

A rule with no override entry uses the global settings. An explicit
per-channel rule is stronger than the general behavior: it also applies to
your subscribed channels, and it stays active when the subscription list is
absent. The blocklist has no per-channel override; remove the channel from
the blocklist instead.

The channel rules use the channel display name. They do not use the
channel handle. The rules are part of the synchronized settings.

### Sync between devices (beta)

The browsers that this extension targets have no Google account sync. The
extension can synchronize its data through your own WebDAV storage instead.
Nextcloud, mailbox.org, and most hosting providers offer WebDAV.

The sync transfers the settings, the channel rules, the blocklist with its
channel handles and snooze dates, the hidden videos, the manual subscription
entries, and the watched history. The sync does not transfer the YouTube
feedback log, the "tell YouTube next time" marks, and the statistics of the
blocked channels. These stay on each device. The collected
subscription list transfers only if you turn on **Sync subscription list**
in the Sync section. Without it, each device collects that list from YouTube
itself.

Turn on **Sync subscription list** only if every device uses the same YouTube
account. With different accounts, for example a Brand Account on one device,
the lists mix. The switch is a synced setting, so one device is enough. A
device without its own list then takes the synced list and needs no
**Refresh now**. A full collection on any device updates the list and its
age on all devices. After you turn the switch on, select **Refresh now** on
one device so that all devices start from the same complete list. The
channel handles of the subscription list do not transfer. A device that took
the synced list identifies the subscribed channels by name until it does its
own collection.

All devices need version 2.0.0 or later. Version 2.0.0 writes a new sync
format. An older version cannot read it, stops its sync, and reports an
error until you update it. No data is lost.

The extension encrypts the data with a passphrase before each upload
(AES-256-GCM, key from PBKDF2 with 600000 iterations). The storage provider
only sees an encrypted file. The passphrase is never stored and never
uploaded. If you lose the passphrase, the remote data is not readable; sync
must then start again with a new passphrase.

Use this procedure on the first device:

1. Create an app password in your WebDAV provider. Do not use the account
   password.
2. Open the extension options page, section **Sync**.
3. Enter the full file URL for the sync data, for example
   `https://cloud.example.com/remote.php/dav/files/USER/youtube-tuner.bin`.
   The URL must end with a file name. The file does not have to exist; the
   extension creates it. A folder URL causes an HTTP error such as 403. The
   folders in the path must already exist.
4. Enter the username, the app password, and a new passphrase. A new
   passphrase must have a minimum of 12 characters.
5. Select **Test connection**. The browser asks for permission for this
   server. The test writes and deletes a probe file and reports if the
   server supports safe concurrent writes. If the test fails, sync will not
   enable.
6. Select **Enable sync**.

On each additional device, use the same procedure with the same URL and the
same passphrase. An additional device merges its existing data with the
server state when sync is enabled: entries that exist only on that device
(blocked channels, overrides, manual subscriptions, watched history) are
kept and uploaded. Where both sides differ directly, for example a setting
with a different value or a channel that was deliberately removed on another
device, the server copy wins.

After the setup, sync is automatic: a change uploads after a short delay,
and each device checks the server every 15 minutes and at each browser
start. The check is a conditional request: if nothing changed on the
server, no data is downloaded. The **Sync
now** button forces an immediate sync. Changes merge per item; a deletion on
one device wins over an old entry on another device. A device that is
offline for more than 90 days can bring a deleted entry back.

**Disable sync** removes the server settings, the encryption key, and the
sync state from the device. It also gives back the permission for the server.
The local filter data stays. The settings export
never contains the sync credentials or the sync state.

### Tile controls

Each readable video tile has these controls. They are visible when the pointer
is on the tile.

| Control | Icon | Effect |
|---|---|---|
| Hide this video | Eye with a line | Hides this one video. Local only. |
| Block channel | Circle with a line | Hides all videos of the channel. Local only. Not shown for subscribed channels. |
| Save to Watch later | Clock | Selects YouTube's **Save to Watch later** menu item. Watch page only. |
| Not interested | Thumb down | Sends YouTube's **Not interested**. Only if you turned on YouTube feedback. |

After **Hide this video**, a toast shows an **Undo** button. After **Block
channel**, the toast shows **Undo** and **30 days only**. **30 days only**
changes the block into a block that ends by itself. The options page lists
all blocked channels. There you can unblock a channel, limit a block to 30
days, or make it permanent.

#### How the extension identifies a channel

Channel names are not unique on YouTube. Thus the extension uses the channel
handle (`@name`) where a tile shows one. The home feed and the search results
show it. The watch-page sidebar does not show it. There the extension uses
the channel name.

- A block from a tile with a handle applies to that handle. A different
  channel with the same name stays visible.
- A channel that changes its name stays blocked, because the handle stays
  the same.
- A block from an older version has no handle. It applies to the name until
  the extension sees the name together with a handle. Then the block belongs
  to that handle. If that is the incorrect channel, unblock it and block the
  correct one.
- The subscription list uses the same method. A channel that copies the name
  of a subscribed channel does not get the exemption from the age rule and
  the view rule.

#### Blocked channels that come back

The extension counts how often it hides videos of each blocked channel. It
keeps only the counts, on this device. The options page shows them:

- A channel that YouTube recommends again and again has the note "keeps
  coming back". Each hidden video uses one position in your feed.
- A channel that did not show up for 180 days is in a separate list. One
  button unblocks all these channels.

#### YouTube feedback is optional and has a limit

**Not interested** and **Don't recommend channel** are YouTube feedback. YouTube
stores them in your Google account. They stay there after you remove the
extension. With many **Don't recommend channel** entries, the home feed can
shrink to a few channels
([issue #1](https://github.com/m8-t/youtube-tuner/issues/1)). Thus the
extension sends no feedback unless you permit it.

The options page has the section **YouTube feedback (optional)**:

- **Allow sending feedback to YouTube** is the main switch. It is off by
  default. When it is on, the tiles on the home feed and the watch page get
  the **Not interested** control.
- **Send at most N signals per week** is the limit. The default is 3. The
  maximum is 20. When the limit is used up, the extension sends nothing and
  the toast tells you. The local hide or block always operates.
- **Also send YouTube's "Don't recommend channel" when blocking** is a second
  switch. It needs the main switch. Each signal counts against the limit.
- The section shows a log of all signals that the extension sent: the date,
  the type, the channel, and the video.

For a blocked channel that keeps coming back, the options page has the button
**Tell YouTube next time**. The next time a video of this channel is in your
feed, the extension sends one **Not interested** for it. This also counts
against the limit. This function is new, and it is not verified on the live
YouTube page. If YouTube's menu does not open, the extension sends nothing.

The native YouTube actions support exact English and German menu labels. If the
extension cannot find one exact menu item, it does not select a menu item.

YouTube stores the feedback under the account that is active on YouTube. If you
use a Brand Account, switch to it first, or the feedback page looks empty. To
review or delete the feedback, open YouTube > History > Manage all history >
Other activity > YouTube user feedback. My Activity deletes it one day at a
time only. [Issue #1](https://github.com/m8-t/youtube-tuner/issues/1) has a
console script that deletes all days in one run.

Your watch history also shapes the feed. Subscribed channels skip the age and
view rules. If you mostly watch those channels, the feed narrows to them even
without feedback. Loosen the view and age rules, or prune the watch history,
to widen the feed again.

![A watch page with the filtered sidebar and the tile
controls](assets/watch-page.jpg)

## Privacy and compatibility

The extension has no analytics. It reads YouTube pages and uses the browser
storage APIs. It does not send data to the project author. There are two
possible external calls. The first is the optional daily update check: one
request to `api.github.com` that contains no personal data beyond your IP
address. The toolbar menu has a switch that turns it off. The second is the
optional sync: encrypted uploads to the WebDAV server that you configure
yourself. Both are off unless you turn them on (the update check is on by
default; the sync is off by default).

The manifest requests `storage`, `alarms`, `scripting`, and access to
`https://www.youtube.com`. The extension uses `scripting` only to attach again
to open YouTube tabs after an update. The sync feature asks for permission for
your own WebDAV server only when you enable it, and gives the permission back
when you disable sync. The extension requests no other permissions. The update
check needs no extra permission because the GitHub API permits cross-origin
requests.

The text-dependent features have code for English and German. Live captures
verified the German interface and the English watch-page sidebar. The English
action labels (the menu items and the subscribe button) are not verified.

If a menu label does not match exactly, the extension does not select a menu
item. If a subscribe-button label does not match exactly, the extension does
not change the subscription list. The **Hide this video** control and the
**Block channel** control do not use YouTube's menu.

The automated tests use fixtures from live pages: three German pages and one
English sidebar page. The age and view parsers have test coverage in both
languages.

The extension treats every other interface language as English. If it cannot
parse an age or a view count, it shows the video. The watched rule and the
blocklist rule can still hide the video.

| Data | Storage area |
|---|---|
| Filter switches, limits, and blocked title phrases | `local` |
| Per-channel rule overrides | `local` |
| Fetched and manual subscription names, channel handles | `local` |
| Blocked channel names, their handles and snooze dates | `local` |
| Hidden video IDs | `local` |
| Watched video IDs | `local` |
| Counts for blocked channels | `local` |
| YouTube feedback log and "tell YouTube next time" marks | `local` |
| Update check time and newest release tag | `local` |
| Sync document, sync state, and WebDAV settings | IndexedDB |
| Sync encryption key (non-extractable) | IndexedDB |

The page script of YouTube cannot read the IndexedDB of the extension. The
extension keeps the WebDAV password there for this reason. The options page
does not show a saved password again.

The part of the extension that runs in the YouTube page (the content script)
has no access to the stored data. It gets one copy of the filter data from the
background worker. For each change, it sends a request, and the background
worker examines the request before it writes. The content script cannot
change the settings or the sync configuration. Where the browser supports it,
the extension also locks `chrome.storage` for content scripts.

The watched set and the hidden set each contain a maximum of 5000 video IDs.
If a new ID exceeds this limit, the extension removes the oldest ID.

Versions before 2.0.0 kept the settings and the channel rules in
`storage.sync`. Version 2.0.0 moves them to `storage.local` at the first
start.

The settings export contains all data from `storage.local`. It never
contains the sync document, the sync state, or the WebDAV settings. An import
examines each entry of the file and ignores unknown or invalid entries. It
shows a warning before a file turns on YouTube feedback. Version 2.0.0 can
import the export files of older versions.

## Architecture

```
src/
  content.js          content script entry: state, SPA navigation
  content/
    client.js         the only link to the background worker
    lifecycle.js      start and stop of filtering, per page type
    actions.js        what the tile controls do, feedback budget flow
    collection.js     subscription collection on /feed/channels
    lifeline.js  canary.js
  background.js       badge, alarms, sync, message routing by sender
  background/
    content-api.js    examines and executes content-script requests
    serial.js         one queue for all data writes
  options.js          settings UI, manual refresh
  options/            blocked channels, sync, backup, channel rules
  popup.js            toolbar control menu
  update-check.js     daily and manual release check via the GitHub API
  rules/
    decide.js         pure decision function
    identity.js       blocked and subscribed, by handle or by name
    defaults.js
  dom/
    selectors.js      all YouTube selectors
    tile-adapter.js   reads one tile into plain data
    applier.js        MutationObserver, hide and restore
    block-button.js   the tile controls
    native-menu.js    operates YouTube's own menu, fail-closed
    styles.js  empty-sections.js  starvation.js  block-toast.js
  locale/             age and view parsing, EN and DE
  storage/            config, overrides, blocklist, hidden, watched, subs,
                      feedback budget and log, block statistics, schema
  sync/               cross-device sync: clocked document, LWW merge,
                      AES-GCM envelope, WebDAV backend with CAS probe,
                      engine with diff capture, IndexedDB stores
  subs-refresh.js     subscription collection loop
  subs-scrape.js      channel names and handles from the page
  subs-capture.js     subscribe, unsubscribe, and reconcile on /watch
  channel-name.js     name and handle normalization
```

Design rules:

- Filters fail open. An unreadable tile stays visible. An unparseable age or
  view count only disables the age rule and the view rule.
- Local first. A block or a hide changes only the data of the extension.
  Feedback to YouTube needs an explicit option and stays in a weekly limit.
- Native actions and subscription-list writes fail closed. An unknown
  element, an unknown label, or a timeout causes no click and no write.
- The content script is not trusted. It has no storage access and no network
  code. The background worker examines each request and accepts sync
  messages only from the pages of the extension.
- Decisions use the video ID, not the DOM node. YouTube uses DOM nodes again
  for different videos.
- A channel is identified by its handle where the tile shows one, and by its
  display name where it does not.
- All YouTube selectors are in `src/dom/selectors.js`.

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

Three tests protect the security properties. One test builds the bundles and
makes sure that no bundle contains an HTML injection sink and that the
content script bundle contains no storage, network, or credential code. One
test runs the real content script against the real background handlers. One
test makes sure that each content-script request type is permitted for the
content script only.

The CRX tool reads the RSA private key from `YTT_CRX_KEY`. If this variable is
not set, it reads `key.pem` from the repository root. The tool stops if the key
does not exist. It never creates a replacement key because a different key
changes the extension ID.

After you install a new build, reload each open YouTube tab. Old content scripts
stay active until you reload the tab.

Push a tag in the form `v<version>` to create a release. The workflow has
three jobs. The build job runs the tests, checks the manifest version, and
builds the ZIP file. It has no secrets. The sign job creates the CRX file. It
has the signing key, but it does not install or run npm packages. The release
job creates the GitHub release.

Each release has a `SHA256SUMS` file and a build provenance attestation. To
verify a downloaded file, use this command:

```
gh attestation verify youtube-tuner-<version>.zip --repo m8-t/youtube-tuner
```

## License

The project uses the [AGPL-3.0 license](LICENSE). YouTube is a trademark of
Google LLC. This project has no connection with Google.
