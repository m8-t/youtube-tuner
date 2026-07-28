const EN_MULTIPLIERS = {
  k: 1e3, m: 1e6, b: 1e9,
  thousand: 1e3, million: 1e6, billion: 1e9,
};
const DE_MULTIPLIERS = {
  tsd: 1e3, mio: 1e6, mrd: 1e9,
  tausend: 1e3, million: 1e6, millionen: 1e6,
  milliarde: 1e9, milliarden: 1e9,
};

const EN_ZERO = /^\s*no views\b/i;
const DE_ZERO = /^\s*keine aufrufe\b/i;

const EN_UNITS = '(?:thousand|million|billion|K|M|B)';
const DE_UNITS = '(?:Tausend|Millionen|Million|Milliarden|Milliarde|Tsd|Mio|Mrd)';

const EN_NUM = '([\\d][\\d,]*(?:\\.\\d+)?)';
const DE_NUM = '([\\d][\\d.]*(?:,\\d+)?)';

const EN_RE = new RegExp(`${EN_NUM}\\s*(${EN_UNITS})?\\s+views?\\b`, 'i');
const DE_RE = new RegExp(`${DE_NUM}\\s*(${DE_UNITS})?\\.?\\s+Aufrufe?\\b`, 'i');

const EN_BARE_RE = new RegExp(`^\\s*${EN_NUM}\\s*(${EN_UNITS})?\\s*$`, 'i');
const DE_BARE_RE = new RegExp(`^\\s*${DE_NUM}\\s*(${DE_UNITS})?\\.?\\s*$`, 'i');

function toNumberEn(raw) {
  return Number.parseFloat(raw.replace(/,/g, ''));
}

function toNumberDe(raw) {
  return Number.parseFloat(raw.replace(/\./g, '').replace(',', '.'));
}

function build(match, de) {
  if (!match) return null;
  const value = de ? toNumberDe(match[1]) : toNumberEn(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2] ? match[2].toLowerCase() : null;
  const multiplier = suffix
    ? (de ? DE_MULTIPLIERS : EN_MULTIPLIERS)[suffix]
    : 1;
  if (!multiplier) return null;
  return Math.round(value * multiplier);
}

export function parseViews(text, locale) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const de = locale === 'de';

  if ((de ? DE_ZERO : EN_ZERO).test(text)) return 0;

  return (
    build((de ? DE_RE : EN_RE).exec(text), de) ??
    build((de ? DE_BARE_RE : EN_BARE_RE).exec(text), de)
  );
}
