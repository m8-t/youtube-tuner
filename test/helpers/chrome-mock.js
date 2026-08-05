export function installChromeMock({ install = true } = {}) {
  const areas = { sync: {}, local: {} };
  const listeners = [];
  const events = {
    alarm: [],
    clicked: [],
    connected: [],
    installed: [],
    message: [],
    removed: [],
    startup: [],
  };
  const alarmCreates = [];
  const ports = [];
  const runtimeCalls = { connect: [] };
  const scriptingCalls = [];
  const tabQueries = [];
  const actionCalls = {
    popups: [],
  };

  const makeEvent = (name) => ({
    addListener(fn) {
      events[name].push(fn);
    },
    removeListener(fn) {
      const index = events[name].indexOf(fn);
      if (index !== -1) events[name].splice(index, 1);
    },
  });

  const makeArea = (name) => ({
    async get(keys) {
      const store = areas[name];
      if (keys === null || keys === undefined) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in store) out[k] = store[k];
      return out;
    },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: areas[name][k], newValue: v };
        areas[name][k] = v;
      }
      for (const fn of listeners) fn(changes, name);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        delete areas[name][key];
      }
    },
    async clear() {
      areas[name] = {};
    },
  });

  const chromeMock = {
    storage: {
      sync: makeArea('sync'),
      local: makeArea('local'),
      onChanged: {
        addListener: (fn) => listeners.push(fn),
        removeListener(fn) {
          const index = listeners.indexOf(fn);
          if (index !== -1) listeners.splice(index, 1);
        },
      },
    },
    action: {
      onClicked: makeEvent('clicked'),
      setBadgeText() {},
      setBadgeBackgroundColor() {},
      setPopup(options) {
        actionCalls.popups.push(options);
      },
      setTitle() {},
    },
    alarms: {
      create(name, options) {
        alarmCreates.push({ name, options });
      },
      onAlarm: makeEvent('alarm'),
    },
    runtime: {
      id: 'youtube-tuner-test-extension',
      connect(options) {
        runtimeCalls.connect.push(options);
        const disconnectListeners = [];
        const port = {
          name: options?.name,
          onDisconnect: {
            addListener(fn) {
              disconnectListeners.push(fn);
            },
            removeListener(fn) {
              const index = disconnectListeners.indexOf(fn);
              if (index !== -1) disconnectListeners.splice(index, 1);
            },
          },
          disconnect() {
            for (const fn of [...disconnectListeners]) fn(port);
          },
        };
        ports.push(port);
        for (const fn of events.connected) fn(port);
        return port;
      },
      getManifest() {
        return { version: '0.7.0' };
      },
      onConnect: makeEvent('connected'),
      onInstalled: makeEvent('installed'),
      onMessage: makeEvent('message'),
      onStartup: makeEvent('startup'),
    },
    tabs: {
      async create() {
        return { id: 1 };
      },
      async query(options) {
        tabQueries.push(options);
        return [];
      },
      async remove() {},
      async sendMessage() {},
      async update() {},
      onRemoved: makeEvent('removed'),
    },
    scripting: {
      async executeScript(options) {
        scriptingCalls.push(options);
      },
    },
  };
  if (install) globalThis.chrome = chromeMock;

  return {
    actionCalls,
    alarmCreates,
    areas,
    chrome: chromeMock,
    events,
    ports,
    runtimeCalls,
    scriptingCalls,
    tabQueries,
    reset() {
      areas.sync = {};
      areas.local = {};
      listeners.length = 0;
    },
  };
}
