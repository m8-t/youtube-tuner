// The Sync section: WebDAV settings, connection test, enable and disable.
import { friendlySyncError } from '../sync/friendly-errors.js';
import { el } from './dom.js';

export function validateSyncUrl(value) {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url) throw new Error('Server URL is required');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Server URL is invalid');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Server URL must use https://');
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    throw new Error('Server URL must include a file path');
  }
  if (parsed.pathname.endsWith('/')) {
    throw new Error('Server URL path must not end with /');
  }
  return {
    origin: `${parsed.origin}/*`,
    url: parsed.href,
  };
}

function syncFormValues() {
  const { origin, url } = validateSyncUrl(el('sync-url').value);
  return {
    origin,
    passphrase: el('sync-passphrase').value,
    settings: {
      url,
      username: el('sync-username').value,
      password: el('sync-password').value,
    },
  };
}

function errorMessage(error) {
  return friendlySyncError(error, 'Unknown error');
}

function formatLastSync(value) {
  if (value === null || value === undefined || value === '') return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function renderSyncStatus(status = {}, settings = {}) {
  const configuredSettings = settings || {};
  el('sync-url').value =
    typeof configuredSettings.url === 'string' ? configuredSettings.url : '';
  el('sync-username').value =
    typeof configuredSettings.username === 'string'
      ? configuredSettings.username
      : '';
  // The saved app password is never read back into the page.
  el('sync-password').value = '';
  el('sync-passphrase').value = '';

  const enabled = status.enabled === true;
  el('sync-password').placeholder = enabled
    ? 'saved - type it again only to test or change it'
    : '';
  el('sync-enable').hidden = enabled;
  el('sync-enable').disabled = enabled;
  el('sync-disable').hidden = !enabled;
  el('sync-disable').disabled = !enabled;
  el('sync-run').hidden = !enabled;
  el('sync-run').disabled = !enabled;

  const lastSync = status.configured === false
    ? 'never'
    : formatLastSync(status.lastSyncAt);
  let text =
    `Sync ${enabled ? 'enabled' : 'disabled'}. ` +
    `Last sync: ${lastSync}.`;
  if (status.lastError) {
    const lastError = errorMessage(status.lastError);
    const punctuation = /[.!?]$/.test(lastError) ? '' : '.';
    text += ` Last error: ${lastError}${punctuation}`;
  }
  el('sync-status').textContent = text;
}

export async function refreshSyncStatus({
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  const status = await sendMessage({ type: 'sync-status' });
  renderSyncStatus(status, {
    url: status?.url,
    username: status?.username,
  });
  return status;
}

async function requestSyncPermission(requestPermission) {
  const values = syncFormValues();
  const granted = await requestPermission({ origins: [values.origin] });
  if (!granted) {
    el('sync-message').textContent = 'Permission denied';
    return null;
  }
  return values;
}

export function formatSyncCapabilities(capabilities = {}) {
  if (capabilities.ok === true) {
    return 'Connection OK — server is compatible.';
  }

  const failure = typeof capabilities.failure === 'string'
    ? capabilities.failure
    : '';
  const friendlyFailure = friendlySyncError(failure, '');
  if (capabilities.authOk === false) {
    return 'WebDAV credentials were rejected';
  }
  if (failure && friendlyFailure !== failure) {
    return friendlyFailure;
  }
  if (
    (capabilities.strongEtags === false &&
      (!failure || /etag/i.test(failure))) ||
    (capabilities.cas === false &&
      (capabilities.strongEtags === true ||
        /conditional update/i.test(failure)))
  ) {
    return 'This server does not support safe concurrent updates, sync would ' +
      'risk data loss.';
  }
  return failure || 'Server compatibility could not be confirmed.';
}

export async function testSyncConnection({
  button = el('sync-test'),
  requestPermission =
    (request) => chrome.permissions.request(request),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  button.disabled = true;
  try {
    const values = await requestSyncPermission(requestPermission);
    if (values === null) return null;
    const response = await sendMessage({
      type: 'sync-test',
      settings: values.settings,
    });
    if (response?.error && !response.capabilities) {
      throw new Error(errorMessage(response.error));
    }
    const capabilities = response?.capabilities || response || {};
    try {
      console.info('[youtube-tuner] sync capability test', capabilities);
    } catch {}
    el('sync-message').textContent =
      formatSyncCapabilities(capabilities);
    return capabilities;
  } catch (error) {
    el('sync-message').textContent =
      `Connection test failed: ${errorMessage(error)}`;
    return null;
  } finally {
    button.disabled = false;
  }
}

export async function enableSync({
  button = el('sync-enable'),
  requestPermission =
    (request) => chrome.permissions.request(request),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  button.disabled = true;
  let enabled = false;
  try {
    const values = await requestSyncPermission(requestPermission);
    if (values === null) return false;
    const response = await sendMessage({
      type: 'sync-enable',
      settings: values.settings,
      passphrase: values.passphrase,
    });
    if (response?.ok !== true) {
      throw new Error(errorMessage(response?.error || 'Sync could not be enabled'));
    }
    el('sync-passphrase').value = '';
    el('sync-message').textContent = 'Sync enabled.';
    enabled = true;
    return true;
  } catch (error) {
    el('sync-message').textContent =
      `Enable failed: ${errorMessage(error)}`;
    return false;
  } finally {
    button.disabled = false;
    if (enabled) {
      try {
        await refreshSyncStatus({ sendMessage });
      } catch (error) {
        el('sync-message').textContent =
          `Status refresh failed: ${errorMessage(error)}`;
      }
    }
  }
}

// Gives the WebDAV host permission back once sync no longer needs it.
async function releaseSyncPermission(url, removePermission) {
  try {
    const { origin } = validateSyncUrl(url);
    if (new URL(url).hostname.endsWith('youtube.com')) return false;
    return await removePermission({ origins: [origin] });
  } catch {
    return false;
  }
}

export async function disableSync({
  button = el('sync-disable'),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  removePermission = (request) => chrome.permissions.remove(request),
} = {}) {
  button.disabled = true;
  let disabled = false;
  try {
    let configuredUrl = '';
    try {
      configuredUrl = (await sendMessage({ type: 'sync-status' }))?.url ?? '';
    } catch {}
    const response = await sendMessage({ type: 'sync-disable' });
    if (response?.error) throw new Error(errorMessage(response.error));
    await releaseSyncPermission(configuredUrl, removePermission);
    el('sync-message').textContent = 'Sync disabled.';
    disabled = true;
    return true;
  } catch (error) {
    el('sync-message').textContent =
      `Disable failed: ${errorMessage(error)}`;
    return false;
  } finally {
    button.disabled = false;
    if (disabled) {
      try {
        await refreshSyncStatus({ sendMessage });
      } catch (error) {
        el('sync-message').textContent =
          `Status refresh failed: ${errorMessage(error)}`;
      }
    }
  }
}

export async function runSyncNow({
  button = el('sync-run'),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
} = {}) {
  button.disabled = true;
  try {
    const response = await sendMessage({ type: 'sync-run' });
    if (response?.ok !== true) {
      throw new Error(errorMessage(response?.error || 'Sync failed'));
    }
    el('sync-message').textContent = 'Sync complete.';
    return true;
  } catch (error) {
    el('sync-message').textContent =
      `Sync failed: ${errorMessage(error)}`;
    return false;
  } finally {
    button.disabled = false;
  }
}

export async function setupSyncControls({
  requestPermission =
    (request) => chrome.permissions.request(request),
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  removePermission = (request) => chrome.permissions.remove(request),
} = {}) {
  el('sync-test').addEventListener('click', async () => {
    await testSyncConnection({ requestPermission, sendMessage });
  });
  el('sync-enable').addEventListener('click', async () => {
    await enableSync({ requestPermission, sendMessage });
  });
  el('sync-disable').addEventListener('click', async () => {
    await disableSync({ sendMessage, removePermission });
  });
  el('sync-run').addEventListener('click', async () => {
    await runSyncNow({ sendMessage });
  });

  try {
    return await refreshSyncStatus({ sendMessage });
  } catch (error) {
    el('sync-message').textContent =
      `Status unavailable: ${errorMessage(error)}`;
    return null;
  }
}
