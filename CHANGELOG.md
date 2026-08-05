# Changelog

Notable changes per release. Older releases are documented on the
[releases page](https://github.com/m8-t/youtube-tuner/releases).

## 1.0.0 - unreleased

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

### Fixed

- WebDAV capability probe no longer fails on Nextcloud, which keeps the
  previous ETag for writes within the same wall-clock second.

## 0.8.0 - 2026-07-29

See the [release page](https://github.com/m8-t/youtube-tuner/releases/tag/v0.8.0).
