import { HIDDEN_CLASS } from './applier.js';
import {
  BLOCK_BUTTON_CLASS,
  BLOCK_HOST_CLASS,
  NOT_INTERESTED_BUTTON_CLASS,
  WATCH_LATER_BUTTON_CLASS,
} from './block-button.js';
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
    .${BLOCK_BUTTON_CLASS} { top: 46px; }
    .${WATCH_LATER_BUTTON_CLASS} { top: 74px; }
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
    .${BLOCK_BUTTON_CLASS}:hover { background: rgba(200,0,0,.9); }
    .${NOT_INTERESTED_BUTTON_CLASS}:hover { background: rgba(70,70,70,.95); }
    .${WATCH_LATER_BUTTON_CLASS}:hover { background: rgba(0,90,200,.9); }
  `;
  doc.head.appendChild(style);
}
