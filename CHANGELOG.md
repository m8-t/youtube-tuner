# Changelog

Notable changes per release. Older releases are documented on the
[releases page](https://github.com/m8-t/youtube-tuner/releases).

## [1.4.1] - 2026-08-13

### Fixed

- Native menu actions work again after YouTube moved `role="menuitem"` from the
  menu-row host element onto its inner button. Both the thumbs-down and the
  block button silently did nothing but leave YouTube's menu open; the block
  button also left the video hidden with no way back, because YouTube's blocked
  tile with its Undo button never rendered.
- The menu now closes when an action cannot be completed.

## [1.4.0] - 2026-08-05

### Added

- Re-injection into open YouTube tabs after an extension install or update.
- Stale button and filtering-artifact cleanup during content-script startup.

### Fixed

- Rejected block writes now emit a `console.warn` instead of failing silently.

## [1.3.0] - 2026-08-05

### Added

- Native Undo sync removes the matching channel from the local blocklist.

### Removed

- Block undo toast (YouTube's native blocked-tile UI already offers undo functionality)

## [1.2.0] - 2026-08-05

### Added

- First-run help in the popup.
- An undo toast for channel blocks.
- A subscribed-channel exemption note in the popup.

### Changed

- Sync errors and connection test results are reworded in plain language.
- The amber badge is explained in the popup.
- The DOM-breakage warning now suggests reloading the YouTube tab.
- Passphrase storage guidance was added to sync setup.

## [1.1.0] - 2026-08-05

### Added

- A DOM-breakage warning reports when YouTube page changes may have stopped
  channel filtering from working.
- CI runs the test suite on pushes to `main` and on pull requests.

### Security

- PBKDF2 iteration counts in encrypted sync data are capped to prevent
  excessive key-derivation work from malicious inputs.
- Sync rejects remote data older than state the device has already merged.

### Fixed

- Settings imports normalize channel overrides before saving them.

## 1.0.1 - 2026-08-05

### Fixed

- Installs on a 1.0.0 beta build could not update to 1.0.0: the browser
  treats the beta build number 1.0.0.N as higher than 1.0.0 and refuses
  the "downgrade". No other changes.

## 1.0.0 - 2026-08-05

### Added

- **Sync between devices.** Settings, channel overrides, blocklist, manual
  subscriptions, and watched history now sync through your own WebDAV
  storage (Nextcloud, ownCloud, or any server with strong ETags). No
  account, no third-party service: the extension talks only to YouTube and
  to the server you configure.
  - All sync data is end-to-end encrypted (AES-256-GCM, key derived from
    your passphrase with PBKDF2-SHA256, 600k iterations). The passphrase
    never leaves the device and is never stored.
  - Changes merge per item across devices; a deletion on one device wins
    over an old entry on another. Enabling sync on a device that already
    has data merges it with the server state instead of overwriting.
  - Sync is automatic: a change uploads after a short delay, and each
    device checks the server every 15 minutes and at browser start. The
    periodic check downloads nothing when the server is unchanged.
  - Concurrent writes from two devices are detected and re-merged safely
    (compare-and-swap with ETags). Before enabling, a capability probe
    verifies the server supports this and refuses servers that do not.
  - Sync is off by default. Disabling it removes the credentials and the
    encryption key but keeps the local data. Settings exports never
    contain sync credentials or sync state.
- Toolbar menu: **Sync now** button with the time of the last sync and the
  last sync error, and an **Options** button that opens the options page.
- Dark mode. The popup and the options page follow the system theme.

### Changed

- Enable/disable settings use toggle switches instead of checkboxes.
- Buttons have a refreshed look in both themes: rounded corners, palette
  borders, an elevated surface tone in dark mode, and hover and pressed
  states.

### Fixed

- WebDAV capability probe no longer fails on Nextcloud, which keeps the
  previous ETag for writes within the same wall-clock second.

## 0.8.0 - 2026-07-29

See the [release page](https://github.com/m8-t/youtube-tuner/releases/tag/v0.8.0).
