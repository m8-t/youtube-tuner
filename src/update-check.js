export const UPDATE_CHECK_URL =
  'https://api.github.com/repos/m8-t/youtube-tuner/releases/latest';
export const UPDATE_CHECK_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;
export const UPDATE_CHECK_COMPLETE_MESSAGE = 'update-check-complete';

const STORAGE_KEY = 'updateCheck';

function versionSegments(version, { stripLeadingV = false } = {}) {
  if (typeof version !== 'string') return null;
  const normalized =
    stripLeadingV && version.startsWith('v') ? version.slice(1) : version;
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) return null;

  const segments = normalized.split('.').map(Number);
  return segments.every(Number.isSafeInteger) ? segments : null;
}

export function isNewerVersion(tag, current) {
  const tagSegments = versionSegments(tag, { stripLeadingV: true });
  const currentSegments = versionSegments(current);
  if (tagSegments === null || currentSegments === null) return false;

  const length = Math.max(tagSegments.length, currentSegments.length);
  for (let index = 0; index < length; index += 1) {
    const tagSegment = tagSegments[index] ?? 0;
    const currentSegment = currentSegments[index] ?? 0;
    if (tagSegment > currentSegment) return true;
    if (tagSegment < currentSegment) return false;
  }
  return false;
}

async function loadUpdateCheck(storage) {
  try {
    const stored = await storage.local.get(STORAGE_KEY);
    const record = stored[STORAGE_KEY];
    return record !== null && typeof record === 'object'
      ? record
      : {};
  } catch {
    return {};
  }
}

export async function checkForUpdate({
  fetchFn,
  storage,
  now,
  currentVersion,
  force = false,
}) {
  const cached = await loadUpdateCheck(storage);
  if (
    !force &&
    Number.isFinite(cached.lastCheckedAt) &&
    now - cached.lastCheckedAt < UPDATE_CHECK_MIN_INTERVAL_MS
  ) {
    return typeof cached.latestTag === 'string' ? cached.latestTag : null;
  }

  try {
    const response = await fetchFn(UPDATE_CHECK_URL, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`update check HTTP ${response.status}`);

    const result = await response.json();
    if (
      result === null ||
      typeof result !== 'object' ||
      typeof result.tag_name !== 'string'
    ) {
      throw new Error('update check response has no tag_name');
    }

    const latestTag = result.tag_name;
    if (
      versionSegments(latestTag, { stripLeadingV: true }) === null ||
      versionSegments(currentVersion) === null
    ) {
      throw new Error('update check response has an invalid version');
    }
    await storage.local.set({
      [STORAGE_KEY]: { lastCheckedAt: now, latestTag },
    });
    return latestTag;
  } catch {
    await storage.local.set({
      [STORAGE_KEY]: { lastCheckedAt: now },
    });
    return null;
  }
}

export async function updateAvailable({ storage, currentVersion }) {
  const cached = await loadUpdateCheck(storage);
  return isNewerVersion(cached.latestTag, currentVersion)
    ? cached.latestTag
    : null;
}
