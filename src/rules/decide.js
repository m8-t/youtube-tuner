import { parseAge } from '../locale/parse-age.js';
import { parseViews } from '../locale/parse-views.js';
import { normalizeChannelName } from '../channel-name.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

const show = (reason) => ({ hide: false, reason });
const hide = (reason) => ({ hide: true, reason });

function channelOverride(overrides, channelName) {
  const name = normalizeChannelName(channelName);
  if (!name || !overrides) return undefined;
  if (overrides instanceof Map) return overrides.get(name);
  if (typeof overrides !== 'object' || Array.isArray(overrides)) return undefined;
  return Object.hasOwn(overrides, name) ? overrides[name] : undefined;
}

export function decide(tile, config, state) {
  if (!config.enabled) return show('disabled');

  const override = channelOverride(state.overrides, tile.channelName);

  if (
    config.blocklistRule.enabled &&
    tile.channelName &&
    state.blocklist.has(tile.channelName)
  ) {
    return hide('blocked');
  }

  if (config.titleRule?.enabled && tile.title) {
    const titles = Array.isArray(tile.titles) && tile.titles.length > 0
      ? tile.titles
      : [tile.title];
    const patterns = Array.isArray(config.titleRule.patterns)
      ? config.titleRule.patterns
      : [];
    for (const pattern of patterns) {
      if (typeof pattern !== 'string') continue;
      const normalized = pattern.trim().toLowerCase();
      if (
        normalized &&
        titles.some((title) =>
          typeof title === 'string' && title.toLowerCase().includes(normalized))
      ) {
        return hide('title');
      }
    }
  }

  if (
    config.watchedRule.enabled &&
    override?.watched?.enabled !== false &&
    (tile.hasResumeBar || state.watched.has(tile.videoId))
  ) {
    return hide('watched');
  }

  const ageForced = override?.age?.enabled === true;
  const viewForced = override?.view?.enabled === true;
  let skipReason = null;
  if (state.subs === null) {
    skipReason = 'subs-unavailable';
  } else if (tile.channelName && state.subs.has(tile.channelName)) {
    skipReason = 'subscribed';
  }
  if (skipReason && !ageForced && !viewForced) return show(skipReason);

  const ageMs = parseAge(tile.ageText, state.locale);
  const ageEnabled = skipReason
    ? ageForced
    : override?.age?.enabled ?? config.ageRule.enabled;
  const maxAgeDays =
    override?.age?.maxAgeDays ?? config.ageRule.maxAgeDays;

  if (ageEnabled && ageMs !== null) {
    if (ageMs > maxAgeDays * DAY_MS) {
      return hide(override?.age ? 'age-override' : 'age');
    }
  }

  const viewEnabled = skipReason
    ? viewForced
    : override?.view?.enabled ?? config.viewRule.enabled;
  if (viewEnabled && ageMs !== null) {
    const views = parseViews(tile.viewText, state.locale);
    const pastGrace = ageMs > config.viewRule.graceHours * HOUR_MS;
    const minViews = override?.view?.minViews ?? config.viewRule.minViews;
    if (views !== null && pastGrace && views < minViews) {
      return hide(override?.view ? 'views-override' : 'views');
    }
  }

  return show(skipReason ?? 'shown');
}
