export function installChromeMock({ install = true } = {}) {
  const areas = { sync: {}, local: {} };
  const listeners = [];
  const events = {
    alarm: [],
    clicked: [],
    installed: [],
    message: [],
    removed: [],
    startup: [],
  };
  const alarmCreates = [];
  const actionCalls = {
    popups: [],
  };

  const makeEvent = (name) => ({
    addListener(fn) {
      events[name].push(fn);
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
      onChanged: { addListener: (fn) => listeners.push(fn) },
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
      getManifest() {
        return { version: '0.7.0' };
      },
      onInstalled: makeEvent('installed'),
      onMessage: makeEvent('message'),
      onStartup: makeEvent('startup'),
    },
    tabs: {
      async create() {
        return { id: 1 };
      },
      async query() {
        return [];
      },
      async remove() {},
      async sendMessage() {},
      async update() {},
      onRemoved: makeEvent('removed'),
    },
  };
  if (install) globalThis.chrome = chromeMock;

  return {
    actionCalls,
    alarmCreates,
    areas,
    chrome: chromeMock,
    events,
    reset() {
      areas.sync = {};
      areas.local = {};
      listeners.length = 0;
    },
  };
}
