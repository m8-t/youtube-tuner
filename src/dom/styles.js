import { GHOST_CLASS, HIDDEN_CLASS } from './applier.js';
import {
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  HIDE_VIDEO_BUTTON_CLASS,
  NO_BLOCK_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
  WATCH_LATER_BUTTON_CLASS,
} from './block-button.js';
import { BLOCK_TOAST_CLASS } from './block-toast.js';
import { COLLAPSED_SECTION_CLASS } from './empty-sections.js';
import { MENU_CLOAK_CLASS } from './native-menu.js';
import { MENU_DROPDOWN_SELECTOR } from './selectors.js';

const CONTROLS = [
  HIDE_VIDEO_BUTTON_CLASS,
  BLOCK_BUTTON_CLASS,
  WATCH_LATER_BUTTON_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
];

const each = (suffix) => CONTROLS.map((name) => `.${name}${suffix}`).join(',\n    ');

export function injectStyles(doc) {
  if (doc.getElementById('ytt-styles')) return;
  const style = doc.createElement('style');
  style.id = 'ytt-styles';
  style.textContent = `
    .${HIDDEN_CLASS} { display: none !important; }
    .${GHOST_CLASS} { visibility: hidden !important; }
    .${COLLAPSED_SECTION_CLASS} { display: none !important; }
    .${MENU_CLOAK_CLASS} ${MENU_DROPDOWN_SELECTOR} {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .${BLOCK_HOST_CLASS} { position: relative; }
    ${each('')} {
      position: absolute; left: 6px; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      opacity: .45; transition: opacity .12s;
      border: none; border-radius: 6px; cursor: pointer;
      background: rgba(0,0,0,.75); color: #fff;
      line-height: 1; padding: 4px;
    }
    /* Compact sidebar lockups are ~100px tall, so three stacked controls must
       fit; the optional YouTube-feedback control sits beside the first. */
    .${HIDE_VIDEO_BUTTON_CLASS} { top: 6px; }
    .${BLOCK_BUTTON_CLASS} { top: 34px; }
    .${WATCH_LATER_BUTTON_CLASS} { top: 62px; }
    .${NO_BLOCK_CLASS} .${WATCH_LATER_BUTTON_CLASS} { top: 34px; }
    .${NOT_INTERESTED_BUTTON_CLASS} { top: 6px; left: 36px; }
    ${CONTROLS.map((name) => `.${BLOCK_HOST_CLASS}:hover > .${name}`).join(',\n    ')},
    ${each(':focus-visible')} { opacity: 1; }
    ${each(':focus-visible')} {
      outline: 2px solid #fff; outline-offset: 2px;
    }
    .${BLOCK_TOAST_CLASS} {
      position: fixed; left: 24px; bottom: 24px; z-index: 2147483647;
      display: flex; align-items: center; gap: 16px; max-width: 80vw;
      background: #0f0f0f; color: #fff; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,.5);
      font: 500 18px/1.3 Roboto, Arial, sans-serif; padding: 18px 24px;
    }
    .${BLOCK_TOAST_CLASS} button {
      border: none; border-radius: 18px; background: #3ea6ff; color: #0f0f0f;
      cursor: pointer; font: inherit; font-weight: 700; padding: 8px 18px;
      white-space: nowrap;
    }
    html[dark] .${BLOCK_TOAST_CLASS} { background: #f1f1f1; color: #0f0f0f; }
    html[dark] .${BLOCK_TOAST_CLASS} button { background: #065fd4; color: #fff; }
    .${HIDE_VIDEO_BUTTON_CLASS}:hover { background: rgba(70,70,70,.95); }
    .${BLOCK_BUTTON_CLASS}:hover { background: rgba(200,0,0,.9); }
    .${WATCH_LATER_BUTTON_CLASS}:hover { background: rgba(0,90,200,.9); }
    .${NOT_INTERESTED_BUTTON_CLASS}:hover { background: rgba(150,90,0,.95); }
  `;
  doc.head.appendChild(style);
}
