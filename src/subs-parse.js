function findObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }

  return -1;
}

function titleText(renderer) {
  const title = renderer?.title;
  if (typeof title?.simpleText === 'string') return title.simpleText;
  if (!Array.isArray(title?.runs)) return null;
  return title.runs
    .map((run) => run?.text)
    .filter((text) => typeof text === 'string')
    .join('');
}

function addRendererName(renderer, names) {
  const name = titleText(renderer)?.trim();
  if (name) names.add(name);
}

function collectChannelNames(value, names) {
  if (Array.isArray(value)) {
    for (const item of value) collectChannelNames(item, names);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value)) {
    if (key === 'channelRenderer' || key === 'gridChannelRenderer') {
      addRendererName(child, names);
    } else {
      collectChannelNames(child, names);
    }
  }
}

function continuationTokenFromObject(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = continuationTokenFromObject(item);
      if (token) return token;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;

  const commandToken = value.continuationCommand?.token;
  if (typeof commandToken === 'string' && commandToken) return commandToken;

  const nextToken = value.nextContinuationData?.continuation;
  if (typeof nextToken === 'string' && nextToken) return nextToken;

  const reloadToken = value.reloadContinuationData?.continuation;
  if (typeof reloadToken === 'string' && reloadToken) return reloadToken;

  for (const child of Object.values(value)) {
    const token = continuationTokenFromObject(child);
    if (token) return token;
  }
  return null;
}

function extractMarkedObjects(text, marker) {
  const objects = [];
  let match;

  while ((match = marker.exec(text)) !== null) {
    const start = marker.lastIndex;
    const end = findObjectEnd(text, start);
    if (end === -1) continue;

    try {
      objects.push(JSON.parse(text.slice(start, end)));
    } catch {
      // Ignore malformed candidates.
    }
  }

  return objects;
}

// The extension service worker has no DOMParser, so read channel renderers
// directly from the ytInitialData JSON embedded in the channels page.
export function extractSubscribedChannelNames(html) {
  if (typeof html !== 'string') return [];

  const names = new Set();
  const marker = /"(?:channelRenderer|gridChannelRenderer)"\s*:\s*(?=\{)/g;
  let match;

  while ((match = marker.exec(html)) !== null) {
    const start = marker.lastIndex;
    const end = findObjectEnd(html, start);
    if (end === -1) continue;

    try {
      addRendererName(JSON.parse(html.slice(start, end)), names);
    } catch {
      // Ignore malformed candidates. The caller rejects an empty result.
    }
  }

  return [...names];
}

export function extractInnertubeConfig(html) {
  if (typeof html !== 'string') return { apiKey: null, context: null };

  const config = {};
  const markers = [
    /ytcfg\.set\s*\(\s*(?=\{)/g,
    /ytcfg\.data_\s*=\s*(?=\{)/g,
  ];

  for (const marker of markers) {
    for (const candidate of extractMarkedObjects(html, marker)) {
      Object.assign(config, candidate);
    }
  }

  const apiKey =
    typeof config.INNERTUBE_API_KEY === 'string' &&
    config.INNERTUBE_API_KEY.trim()
      ? config.INNERTUBE_API_KEY
      : null;
  const context =
    config.INNERTUBE_CONTEXT &&
    typeof config.INNERTUBE_CONTEXT === 'object' &&
    !Array.isArray(config.INNERTUBE_CONTEXT)
      ? config.INNERTUBE_CONTEXT
      : null;

  return { apiKey, context };
}

export function extractContinuationToken(value) {
  if (typeof value !== 'string') return continuationTokenFromObject(value);

  try {
    return continuationTokenFromObject(JSON.parse(value));
  } catch {
    // An HTML page is not itself JSON; inspect only known continuation objects.
  }

  const marker =
    /"(continuationCommand|nextContinuationData|reloadContinuationData)"\s*:\s*(?=\{)/g;
  let match;
  while ((match = marker.exec(value)) !== null) {
    const start = marker.lastIndex;
    const end = findObjectEnd(value, start);
    if (end === -1) continue;

    try {
      const candidate = JSON.parse(value.slice(start, end));
      const token =
        match[1] === 'continuationCommand'
          ? candidate.token
          : candidate.continuation;
      if (typeof token === 'string' && token) return token;
    } catch {
      // Ignore malformed candidates.
    }
  }
  return null;
}

export function parseSubscriptionContinuation(value) {
  const names = new Set();
  collectChannelNames(value, names);
  return {
    names: [...names],
    continuation: continuationTokenFromObject(value),
  };
}
