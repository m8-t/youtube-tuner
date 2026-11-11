// Detects that the extension was updated or removed under a running content
// script, so the orphaned copy can clean up after itself.
export const LIFELINE_PORT_NAME = 'ytt-lifeline';
export const LIFELINE_RECONNECT_DELAY_MS = 1_000;
export const LIFELINE_MAX_RECONNECT_DELAY_MS = 30_000;

export function createRuntimeLifeline({
  runtime = globalThis.chrome?.runtime,
  onInvalidated = () => {},
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  reconnectDelayMs = LIFELINE_RECONNECT_DELAY_MS,
  maxReconnectDelayMs = LIFELINE_MAX_RECONNECT_DELAY_MS,
} = {}) {
  let port = null;
  let reconnectTimer = null;
  let retryDelayMs = reconnectDelayMs;
  let stopped = false;

  function runtimeIsValid() {
    try {
      return typeof runtime?.id === 'string' && runtime.id.length > 0;
    } catch {
      return false;
    }
  }

  function invalidate() {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) {
      try {
        clearTimeoutFn(reconnectTimer);
      } catch {}
      reconnectTimer = null;
    }
    port = null;
    try {
      onInvalidated();
    } catch {
      // An orphan must never throw teardown failures into the page.
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(retryDelayMs * 2, maxReconnectDelayMs);
    try {
      reconnectTimer = setTimeoutFn(() => {
        reconnectTimer = null;
        if (stopped) return;
        if (!runtimeIsValid()) {
          invalidate();
          return;
        }
        connect();
      }, delay);
    } catch {
      // Losing the retry timer must not affect the host page.
    }
  }

  function handleDisconnect() {
    port = null;
    if (stopped) return;
    if (!runtimeIsValid()) {
      invalidate();
      return;
    }
    retryDelayMs = reconnectDelayMs;
    scheduleReconnect();
  }

  function connect() {
    if (stopped) return false;
    if (!runtimeIsValid()) {
      invalidate();
      return false;
    }
    try {
      const nextPort = runtime.connect({ name: LIFELINE_PORT_NAME });
      if (typeof nextPort?.onDisconnect?.addListener !== 'function') {
        throw new Error('lifeline port has no disconnect event');
      }
      nextPort.onDisconnect.addListener(handleDisconnect);
      port = nextPort;
      retryDelayMs = reconnectDelayMs;
      return true;
    } catch {
      port = null;
      if (!runtimeIsValid()) {
        invalidate();
      } else {
        scheduleReconnect();
      }
      return false;
    }
  }

  function start() {
    try {
      return connect();
    } catch {
      return false;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== null) {
      try {
        clearTimeoutFn(reconnectTimer);
      } catch {}
      reconnectTimer = null;
    }
    const currentPort = port;
    port = null;
    try {
      currentPort?.onDisconnect?.removeListener?.(handleDisconnect);
    } catch {}
    try {
      currentPort?.disconnect?.();
    } catch {}
  }

  return { start, stop };
}
