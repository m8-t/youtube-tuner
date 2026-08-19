export const UPDATE_CHECK_URL =
  'https://api.github.com/repos/m8-t/youtube-tuner/releases/latest';
export const BETA_UPDATE_CHECK_URL =
  'https://api.github.com/repos/m8-t/youtube-tuner/releases?per_page=15';
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

function betaVersionName() {
  try {
    const versionName = chrome.runtime.getManifest().version_name;
    return typeof versionName === 'string' && versionName.includes('-beta.')
      ? versionName
      : null;
  } catch {
    return null;
  }
}

function releaseVersionSegments(version) {
  if (typeof version !== 'string') return null;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version);
  if (match === null) return null;

  const segments = match.slice(1, 4).map(Number);
  const beta = match[4] === undefined ? Infinity : Number(match[4]);
  return segments.every(Number.isSafeInteger) &&
    (beta === Infinity || Number.isSafeInteger(beta))
    ? [...segments, beta]
    : null;
}

function releaseTagSegments(tag) {
  return typeof tag === 'string' && tag.startsWith('v')
    ? releaseVersionSegments(tag.slice(1))
    : null;
}

function compareReleaseSegments(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }
  return 0;
}

function isNewerBetaVersion(tag, current) {
  const tagSegments = releaseTagSegments(tag);
  const currentSegments = releaseVersionSegments(current);
  return tagSegments !== null &&
    currentSegments !== null &&
    compareReleaseSegments(tagSegments, currentSegments) > 0;
}

function latestBetaTag(releases) {
  if (!Array.isArray(releases)) return null;

  let latestTag = null;
  let latestSegments = null;
  for (const release of releases) {
    if (release === null || typeof release !== 'object' || release.draft) {
      continue;
    }
    const segments = releaseTagSegments(release.tag_name);
    if (segments === null) continue;
    if (
      latestSegments === null ||
      compareReleaseSegments(segments, latestSegments) > 0
    ) {
      latestTag = release.tag_name;
      latestSegments = segments;
    }
  }
  return latestTag;
}

export function isNewerVersion(tag, current) {
  const runningBetaVersion = betaVersionName();
  if (runningBetaVersion !== null) {
    return isNewerBetaVersion(tag, runningBetaVersion);
  }

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
    const runningBetaVersion = betaVersionName();
    const url = runningBetaVersion === null
      ? UPDATE_CHECK_URL
      : BETA_UPDATE_CHECK_URL;
    const response = await fetchFn(url, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`update check HTTP ${response.status}`);

    const result = await response.json();
    let latestTag;
    if (runningBetaVersion === null) {
      if (
        result === null ||
        typeof result !== 'object' ||
        typeof result.tag_name !== 'string'
      ) {
        throw new Error('update check response has no tag_name');
      }

      latestTag = result.tag_name;
      if (
        versionSegments(latestTag, { stripLeadingV: true }) === null ||
        versionSegments(currentVersion) === null
      ) {
        throw new Error('update check response has an invalid version');
      }
    } else {
      latestTag = latestBetaTag(result);
      if (
        latestTag === null ||
        releaseVersionSegments(runningBetaVersion) === null
      ) {
        throw new Error('update check response has an invalid version');
      }
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
