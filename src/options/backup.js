// Settings export and import. An imported file is untrusted input.
import {
  DATA_KEYS,
  LEGACY_SYNC_KEYS,
  accountFeedbackFlags,
  cleanStoredData,
} from '../storage/schema.js';
import { el } from './dom.js';

export const SETTINGS_FORMAT = 2;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Returns the raw data of a settings file and the storage keys it is allowed
// to replace. Format 1 (up to 1.7.x) had a "local" and a "sync" section and
// replaced only the sections it contained.
function readSettingsFile(settings) {
  if (!isObject(settings)) {
    throw new Error('the file must contain a settings object');
  }

  if (settings.format === 2) {
    if (!isObject(settings.data)) {
      throw new Error('the file contains no settings data');
    }
    return { data: settings.data, scope: [...DATA_KEYS], stray: [] };
  }

  if (settings.format !== 1) {
    throw new Error(
      `unsupported or missing format (expected 1 or ${SETTINGS_FORMAT})`,
    );
  }
  const hasLocal = Object.hasOwn(settings, 'local');
  const hasSync = Object.hasOwn(settings, 'sync');
  if (!hasLocal && !hasSync) {
    throw new Error('the file contains neither local nor sync settings');
  }
  if (hasLocal && !isObject(settings.local)) {
    throw new Error('local settings must be an object');
  }
  if (hasSync && !isObject(settings.sync)) {
    throw new Error('sync settings must be an object');
  }

  const data = {};
  const scope = [];
  const stray = [];
  if (hasLocal) {
    scope.push(...DATA_KEYS.filter((key) => !LEGACY_SYNC_KEYS.includes(key)));
    for (const [key, value] of Object.entries(settings.local)) {
      if (LEGACY_SYNC_KEYS.includes(key)) stray.push(key);
      else data[key] = value;
    }
  }
  if (hasSync) {
    scope.push(...LEGACY_SYNC_KEYS);
    for (const [key, value] of Object.entries(settings.sync)) {
      if (LEGACY_SYNC_KEYS.includes(key)) data[key] = value;
      else stray.push(key);
    }
  }
  return { data, scope, stray };
}

function importedCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function importSuccessMessage(values, dropped) {
  const subscriptions = importedCount(values.subs?.ids);
  const blocked = importedCount(values.blocklist);
  const watched = importedCount(values.watched);
  const overrides = isObject(values.channelOverrides)
    ? Object.keys(values.channelOverrides).length
    : 0;
  return `Imported ${subscriptions} subscriptions, ${blocked} blocked channels, ` +
    `${watched} watched videos, ${overrides} channel overrides.` +
    (dropped.length > 0
      ? ` Ignored unknown or invalid entries: ${dropped.join(', ')}.`
      : '');
}

async function replaceKeys(storageArea, scope, values) {
  if (Object.keys(values).length > 0) await storageArea.set(values);
  const obsolete = scope.filter((key) => !Object.hasOwn(values, key));
  if (obsolete.length > 0) await storageArea.remove(obsolete);
}

export async function exportSettings({
  button = el('settings-export'),
  statusElement = el('settings-status'),
  localStorage = chrome.storage.local,
  now = () => new Date(),
  BlobCtor = Blob,
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  createElement = (tagName) => document.createElement(tagName),
} = {}) {
  button.disabled = true;
  try {
    const exportedAt = now().toISOString();
    // Only known keys are exported, so nothing internal can leak into a file.
    const { values: data } = cleanStoredData(await localStorage.get(null));
    const settings = { format: SETTINGS_FORMAT, exportedAt, data };
    const blob = new BlobCtor(
      [JSON.stringify(settings, null, 2)],
      { type: 'application/json' },
    );
    const url = createObjectURL(blob);
    try {
      const anchor = createElement('a');
      anchor.href = url;
      anchor.download =
        `youtube-tuner-settings-${exportedAt.slice(0, 10)}.json`;
      anchor.click();
    } finally {
      revokeObjectURL(url);
    }
    statusElement.textContent = 'Settings exported.';
    return settings;
  } catch (error) {
    statusElement.textContent = `Export failed: ${error.message}`;
    return null;
  } finally {
    button.disabled = false;
  }
}

export async function importSettings({
  file,
  button = el('settings-import'),
  statusElement = el('settings-status'),
  confirmFn = (message) => window.confirm(message),
  localStorage = chrome.storage.local,
  readFileText = (selectedFile) => selectedFile.text(),
  renderResult = async () => {},
} = {}) {
  button.disabled = true;
  try {
    if (!file) throw new Error('no settings file was selected');

    let settings;
    try {
      settings = JSON.parse(await readFileText(file));
    } catch {
      throw new Error('the selected file is not valid JSON');
    }
    const { data, scope, stray } = readSettingsFile(settings);

    // Keep only known keys with valid values, and never let a file turn on
    // account feedback unnoticed.
    const cleaned = cleanStoredData(data);
    const dropped = [...cleaned.dropped, ...stray];
    const feedbackFlags = accountFeedbackFlags(cleaned.values.config);

    const confirmed = confirmFn(
      'Importing this file will replace the existing settings that the ' +
      'file covers.' +
      (feedbackFlags.length > 0
        ? ' WARNING: this file turns on a setting that sends feedback to ' +
          `your Google account: ${feedbackFlags.join('; ')}.`
        : '') +
      ' Continue?',
    );
    if (!confirmed) {
      statusElement.textContent = 'Import cancelled.';
      return false;
    }

    const previous = await localStorage.get(scope);
    try {
      await replaceKeys(localStorage, scope, cleaned.values);
    } catch (error) {
      try {
        await replaceKeys(localStorage, scope, previous);
      } catch {}
      throw error;
    }
    await renderResult();
    statusElement.textContent = importSuccessMessage(cleaned.values, dropped);
    return true;
  } catch (error) {
    statusElement.textContent = `Import failed: ${error.message}`;
    return false;
  } finally {
    button.disabled = false;
  }
}
