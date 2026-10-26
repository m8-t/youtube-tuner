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

export function showBlockToast({
  doc,
  channelName,
  onUndo,
  timeoutMs = 6000,
}) {
  try {
    removeBlockToast(doc);
    const toast = doc.createElement('div');
    toast.className = BLOCK_TOAST_CLASS;
    toast.setAttribute('role', 'status');

    const label = doc.createElement('span');
    label.textContent = `Blocked ${channelName}`;

    const undo = doc.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Undo';
    undo.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeBlockToast(doc);
      try {
        Promise.resolve(onUndo?.()).catch(() => {});
      } catch {
        // Undo failures must not escape into YouTube's click handler.
      }
    });

    toast.append(label, undo);
    doc.body.appendChild(toast);
    activeTimer = setTimeout(() => removeBlockToast(doc), timeoutMs);
    return toast;
  } catch {
    return null;
  }
}
