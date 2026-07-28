const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = Math.round(30.4375 * DAY);
const YEAR = Math.round(365.25 * DAY);

const UNITS = {
  en: {
    second: SECOND, minute: MINUTE, hour: HOUR,
    day: DAY, week: WEEK, month: MONTH, year: YEAR,
  },
  de: {
    sekunde: SECOND, minute: MINUTE, stunde: HOUR,
    tag: DAY, woche: WEEK, monat: MONTH, jahr: YEAR,
  },
};

// Compact units as shown in yt-lockup-view-model visible text ("3mo ago").
// Order matters in the alternation below: 'mo' and 'min' must be tried
// before 'm' would ever match, or "3mo ago" reads as 3 minutes.
const COMPACT = {
  s: SECOND, min: MINUTE, h: HOUR, d: DAY, w: WEEK, mo: MONTH, y: YEAR,
};

// en full: "3 years ago", "Streamed 3 years ago"
const EN_RE = /(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i;
// en compact: "3mo ago", "6y ago"
const EN_COMPACT_RE = /(\d+)\s*(mo|min|s|h|d|w|y)\s+ago/i;
// de: "vor 3 Jahren", "Live gestreamt vor 1 Tag".
// \s covers the non-breaking space YouTube uses here.
// German plural suffixes: Jahr/Jahren, Monat/Monaten, Tag/Tagen,
// Woche/Wochen, Stunde/Stunden, Minute/Minuten, Sekunde/Sekunden
const DE_RE = /vor\s+(\d+)\s+(sekunde|minute|stunde|tag|woche|monat|jahr)(?:e|n|en)?\b/i;

function fromMatch(match, units) {
  if (!match) return null;
  const count = Number.parseInt(match[1], 10);
  if (!Number.isFinite(count)) return null;
  const unitMs = units[match[2].toLowerCase()];
  return unitMs ? count * unitMs : null;
}

export function parseAge(text, locale) {
  if (typeof text !== 'string' || text.length === 0) return null;

  if (locale === 'de') return fromMatch(DE_RE.exec(text), UNITS.de);

  return (
    fromMatch(EN_RE.exec(text), UNITS.en) ??
    fromMatch(EN_COMPACT_RE.exec(text), COMPACT)
  );
}
