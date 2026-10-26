import { HIDDEN_CLASS } from './applier.js';
import {
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  NO_BLOCK_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
  WATCH_LATER_BUTTON_CLASS,
} from './block-button.js';
import { BLOCK_TOAST_CLASS } from './block-toast.js';
import { COLLAPSED_SECTION_CLASS } from './empty-sections.js';
import { MENU_CLOAK_CLASS } from './native-menu.js';

export function injectStyles(doc) {
  if (doc.getElementById('ytt-styles')) return;
  const style = doc.createElement('style');
  style.id = 'ytt-styles';
  style.textContent = `
    .${HIDDEN_CLASS} { display: none !important; }
    .${COLLAPSED_SECTION_CLASS} { display: none !important; }
    .${MENU_CLOAK_CLASS} tp-yt-iron-dropdown {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    .${BLOCK_HOST_CLASS} { position: relative; }
    .${BLOCK_BUTTON_CLASS},
    .${NOT_INTERESTED_BUTTON_CLASS},
    .${WATCH_LATER_BUTTON_CLASS} {
      position: absolute; left: 6px; z-index: 9999;
      opacity: .45; transition: opacity .12s;
      border: none; border-radius: 6px; cursor: pointer;
      background: rgba(0,0,0,.75); color: #fff;
      font-size: 18px; line-height: 1; padding: 4px 7px;
    }
    /* Compact sidebar lockups are ~100px tall, so all three controls must fit. */
    .${NOT_INTERESTED_BUTTON_CLASS} { top: 6px; }
    .${BLOCK_BUTTON_CLASS} { top: 34px; }
    .${WATCH_LATER_BUTTON_CLASS} { top: 62px; }
    .${NO_BLOCK_CLASS} .${WATCH_LATER_BUTTON_CLASS} { top: 34px; }
    .${BLOCK_HOST_CLASS}:hover > .${BLOCK_BUTTON_CLASS},
    .${BLOCK_HOST_CLASS}:hover > .${NOT_INTERESTED_BUTTON_CLASS},
    .${BLOCK_HOST_CLASS}:hover > .${WATCH_LATER_BUTTON_CLASS},
    .${BLOCK_BUTTON_CLASS}:focus-visible,
    .${NOT_INTERESTED_BUTTON_CLASS}:focus-visible,
    .${WATCH_LATER_BUTTON_CLASS}:focus-visible { opacity: 1; }
    .${BLOCK_BUTTON_CLASS}:focus-visible,
    .${NOT_INTERESTED_BUTTON_CLASS}:focus-visible,
    .${WATCH_LATER_BUTTON_CLASS}:focus-visible {
      outline: 2px solid #fff; outline-offset: 2px;
    }
    .${BLOCK_TOAST_CLASS} {
      position: fixed; left: 24px; bottom: 24px; z-index: 2147483647;
      display: flex; align-items: center; gap: 24px;
      background: #0f0f0f; color: #fff; border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,.5);
      font: 500 18px/1.3 Roboto, Arial, sans-serif; padding: 18px 24px;
    }
    .${BLOCK_TOAST_CLASS} button {
      border: none; border-radius: 18px; background: #3ea6ff; color: #0f0f0f;
      cursor: pointer; font: inherit; font-weight: 700; padding: 8px 18px;
    }
    html[dark] .${BLOCK_TOAST_CLASS} { background: #f1f1f1; color: #0f0f0f; }
    html[dark] .${BLOCK_TOAST_CLASS} button { background: #065fd4; color: #fff; }
    .${BLOCK_BUTTON_CLASS}:hover { background: rgba(200,0,0,.9); }
    .${NOT_INTERESTED_BUTTON_CLASS}:hover { background: rgba(70,70,70,.95); }
    .${WATCH_LATER_BUTTON_CLASS}:hover { background: rgba(0,90,200,.9); }
  `;
  doc.head.appendChild(style);
}
