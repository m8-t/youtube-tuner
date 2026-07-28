export function detectLocale(doc) {
  const lang = doc?.documentElement?.lang || '';
  return lang.toLowerCase().startsWith('de') ? 'de' : 'en';
}
