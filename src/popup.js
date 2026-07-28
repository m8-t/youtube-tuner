import { loadConfig, saveConfig } from './storage/config.js';
import { loadSubsMeta } from './storage/subs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function subscriptionAgeText(meta) {
  if (meta === null) return 'Subscription list is unavailable.';

  const ageDays = Math.floor(Math.max(0, meta.ageMs) / DAY_MS);
  const dayLabel = ageDays === 1 ? 'day' : 'days';
  return `Subscription list is ${ageDays} ${dayLabel} old.`;
}

export function requestSubscriptionRefresh({
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  closePopup = () => window.close(),
} = {}) {
  try {
    const response = sendMessage({ type: 'refresh-subs' });
    void Promise.resolve(response).catch((error) => {
      console.warn('[youtube-tuner] subscription refresh failed', error);
    });
    return response;
  } finally {
    closePopup();
  }
}

export async function initializePopup({
  documentObject = document,
  loadMeta = loadSubsMeta,
  loadConfiguration = loadConfig,
  saveConfiguration = saveConfig,
  sendMessage = (message) => chrome.runtime.sendMessage(message),
  closePopup = () => window.close(),
} = {}) {
  const [meta, config] = await Promise.all([
    loadMeta(),
    loadConfiguration(),
  ]);
  const ageElement = documentObject.getElementById('subs-age');
  const refreshButton = documentObject.getElementById('refresh-subs');
  const enabledToggle = documentObject.getElementById('enabled');

  ageElement.textContent = subscriptionAgeText(meta);
  enabledToggle.checked = config.enabled;

  refreshButton.addEventListener('click', () => {
    requestSubscriptionRefresh({ sendMessage, closePopup });
  });
  enabledToggle.addEventListener('change', () => {
    config.enabled = enabledToggle.checked;
    try {
      void Promise.resolve(saveConfiguration(config)).catch((error) => {
        console.warn('[youtube-tuner] kill switch failed', error);
      });
    } catch (error) {
      console.warn('[youtube-tuner] kill switch failed', error);
    }
  });

  return { config, meta };
}

if (typeof document !== 'undefined') {
  initializePopup().catch((error) => {
    console.error('[youtube-tuner] popup setup failed', error);
  });
}
