export function normalizeChannelName(value) {
  if (typeof value !== 'string') return '';
  return value
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? '';
}
