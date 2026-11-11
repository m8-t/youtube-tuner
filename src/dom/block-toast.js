export const BLOCK_TOAST_CLASS = 'ytt-block-toast';

let activeTimer = null;

export function removeBlockToast(doc) {
  try {
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    for (const toast of doc.querySelectorAll(`.${BLOCK_TOAST_CLASS}`)) {
      toast.remove();
    }
  } catch {
    // Cleanup must never throw into the page.
  }
}

// One toast at a time. `text` is page-derived (channel names) and is only
// ever set as text content.
export function showToast({
  doc,
  text,
  actions = [],
  timeoutMs = 6000,
}) {
  try {
    removeBlockToast(doc);
    const toast = doc.createElement('div');
    toast.className = BLOCK_TOAST_CLASS;
    toast.setAttribute('role', 'status');

    const label = doc.createElement('span');
    label.textContent = text;
    toast.append(label);

    for (const action of actions) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeBlockToast(doc);
        try {
          Promise.resolve(action.onClick?.()).catch(() => {});
        } catch {
          // A failing action must not escape into YouTube's click handler.
        }
      });
      toast.append(button);
    }

    doc.body.appendChild(toast);
    activeTimer = setTimeout(() => removeBlockToast(doc), timeoutMs);
    return toast;
  } catch {
    return null;
  }
}

export function showBlockToast({
  doc,
  channelName,
  onUndo,
  timeoutMs = 6000,
}) {
  return showToast({
    doc,
    text: `Blocked ${channelName}`,
    actions: [{ label: 'Undo', onClick: onUndo }],
    timeoutMs,
  });
}
