export function normalizeChannelName(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}

const HANDLE_PATH = /^\/(@[^/?#]+)/;
const CHANNEL_ID_PATH = /^\/channel\/(UC[\w-]{20,30})(?:[/?#]|$)/;
const HANDLE_KEY = /^(?:@[^\s/?#]{1,100}|UC[\w-]{20,30})$/;

// A stable identifier for a channel, taken from a link to it: "@handle"
// (lowercased, percent-decoded) or the "UC..." channel ID. Display names are
// not unique on YouTube; this is.
export function channelKeyFromHref(href) {
  if (typeof href !== 'string') return null;
  let path = href;
  try {
    if (/^https?:\/\//i.test(href)) path = new URL(href).pathname;
  } catch {
    return null;
  }
  const handle = HANDLE_PATH.exec(path);
  if (handle) {
    let decoded = handle[1];
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Keep the raw form: it still compares equal to itself.
    }
    return normalizeChannelKey(decoded.toLowerCase());
  }
  const id = CHANNEL_ID_PATH.exec(path);
  return id ? id[1] : null;
}

export function normalizeChannelKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.startsWith('@') ? value.toLowerCase() : value;
  return HANDLE_KEY.test(key) ? key : null;
}
