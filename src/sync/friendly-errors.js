const NETWORK_ERROR =
  /failed to fetch|networkerror|network request failed|fetch failed|load failed|webdav request (?:failed|timed out)/i;
const NOT_FOUND_ERROR = /\b(?:http(?: status)?\s*)?404\b/i;
const AUTH_ERROR = /\b(?:http(?: status)?\s*)?(?:401|403)\b/i;
const STALE_REMOTE_ERROR =
  /remote data is older than previously seen state/i;

export function friendlySyncError(error, fallback = 'Sync failed') {
  const message = typeof error === 'string'
    ? error
    : error?.message;
  if (typeof message !== 'string' || message.length === 0) return fallback;

  if (STALE_REMOTE_ERROR.test(message)) {
    return 'The server returned older data than this device has already seen. ' +
      'If you restored a server backup on purpose, disable and re-enable sync.';
  }
  if (AUTH_ERROR.test(message)) return message;
  if (NOT_FOUND_ERROR.test(message)) {
    return 'Sync location not found on the server. Check the folder path.';
  }
  if (NETWORK_ERROR.test(message)) {
    return 'Could not reach the sync server. Check the URL and your connection.';
  }
  return message;
}
