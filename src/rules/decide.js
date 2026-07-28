import { parseAge } from '../locale/parse-age.js';
import { parseViews } from '../locale/parse-views.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

const show = (reason) => ({ hide: false, reason });
const hide = (reason) => ({ hide: true, reason });

export function decide(tile, config, state) {
  if (!config.enabled) return show('disabled');

  if (
    config.blocklistRule.enabled &&
    tile.channelName &&
    state.blocklist.has(tile.channelName)
  ) {
    return hide('blocked');
  }

  if (
    config.watchedRule.enabled &&
    (tile.hasResumeBar || state.watched.has(tile.videoId))
  ) {
    return hide('watched');
  }

  if (state.subs === null) return show('subs-unavailable');

  if (tile.channelName && state.subs.has(tile.channelName)) return show('subscribed');

  const ageMs = parseAge(tile.ageText, state.locale);

  if (config.ageRule.enabled && ageMs !== null) {
    if (ageMs > config.ageRule.maxAgeDays * DAY_MS) return hide('age');
  }

  if (config.viewRule.enabled && ageMs !== null) {
    const views = parseViews(tile.viewText, state.locale);
    const pastGrace = ageMs > config.viewRule.graceHours * HOUR_MS;
    if (views !== null && pastGrace && views < config.viewRule.minViews) {
      return hide('views');
    }
  }

  return show('shown');
}
