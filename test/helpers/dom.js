import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Fixtures are bare tile fragments; wrap them so `documentElement.lang`
// drives locale detection the way it does on a real page.
export function loadFixture(name, lang = 'en') {
  const path = fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
  const frag = readFileSync(path, 'utf8');
  return new JSDOM(`<html lang="${lang}"><body>${frag}</body></html>`).window.document;
}

export function html(markup, lang = 'en') {
  return new JSDOM(`<html lang="${lang}"><body>${markup}</body></html>`).window.document;
}
