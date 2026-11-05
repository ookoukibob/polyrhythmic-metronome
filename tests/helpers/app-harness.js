/**
 * Test harness for app.js.
 *
 * The application is a plain browser script: it declares its classes at the
 * top level and expects DOM / Web Audio globals. There is no bundler and no
 * module system to import from, so tests load the real file into a vm context
 * with a small set of stubs. Nothing is re-implemented here — every assertion
 * runs the shipped code.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_PATH = path.resolve(__dirname, '..', '..', 'app.js');

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------

function createClassList() {
  const set = new Set();
  return {
    add: (...names) => names.forEach((n) => set.add(n)),
    remove: (...names) => names.forEach((n) => set.delete(n)),
    toggle: (name, force) => {
      const on = force === undefined ? !set.has(name) : !!force;
      if (on) set.add(name);
      else set.delete(name);
      return on;
    },
    contains: (name) => set.has(name),
    get size() {
      return set.size;
    },
  };
}

function createElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    innerHTML: '',
    textContent: '',
    value: '',
    title: '',
    style: {},
    dataset: {},
    children: [],
    classList: createClassList(),
    listeners: {},
    scrollLeft: 0,
    addEventListener(type, handler) {
      (el.listeners[type] = el.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    dispatch(type, event = {}) {
      (el.listeners[type] || []).forEach((handler) => handler({ target: el, ...event }));
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    focus() {},
  };
  return el;
}

function createDocument() {
  const byId = new Map();
  const document = {
    elements: byId,
    getElementById(id) {
      if (!byId.has(id)) {
        const el = createElement('div');
        el.id = id;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => createElement(tag),
    addEventListener() {},
    body: createElement('body'),
  };
  return document;
}

// ---------------------------------------------------------------------------
// Minimal Web Audio (enough for every synthesizer in app.js)
// ---------------------------------------------------------------------------

function createParam() {
  const param = {
    value: 0,
    events: [],
    setValueAtTime(v, t) {
      param.value = v;
      param.events.push(['setValueAtTime', v, t]);
      return param;
    },
    linearRampToValueAtTime(v, t) {
      param.events.push(['linearRampToValueAtTime', v, t]);
      return param;
    },
    exponentialRampToValueAtTime(v, t) {
      param.events.push(['exponentialRampToValueAtTime', v, t]);
      return param;
    },
    cancelScheduledValues(t) {
      param.events.push(['cancelScheduledValues', t]);
      return param;
    },
  };
  return param;
}

function createAudioContextStub() {
  // Per the Web Audio spec, stop() may be called more than once and the last
  // invocation wins, so the stub records every call and keeps the latest time.
  const makeSource = (extra = {}) => {
    const node = {
      started: null,
      stopped: null,
      stopCalls: [],
      connections: [],
      connect(n) {
        node.connections.push(n);
      },
      start(t) {
        node.started = t;
      },
      stop(t) {
        node.stopCalls.push(t);
        node.stopped = t;
      },
      ...extra,
    };
    return node;
  };

  const ctx = {
    sampleRate: 48000,
    state: 'running',
    destination: { name: 'destination' },
    currentTime: 0,
    sources: [],
    gains: [],
    resume() {
      ctx.state = 'running';
      return Promise.resolve();
    },
    suspend() {
      ctx.state = 'suspended';
      return Promise.resolve();
    },
    createGain() {
      const node = { gain: createParam(), connections: [], connect: (n) => node.connections.push(n) };
      ctx.gains.push(node);
      return node;
    },
    createOscillator() {
      const node = makeSource({ type: 'sine', frequency: createParam() });
      ctx.sources.push(node);
      return node;
    },
    createBufferSource() {
      const node = makeSource({ buffer: null });
      ctx.sources.push(node);
      return node;
    },
    createBuffer(channels, length, sampleRate) {
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: () => new Float32Array(length),
      };
    },
    createBiquadFilter() {
      const node = {
        type: 'lowpass',
        frequency: createParam(),
        Q: { value: 0 },
        connections: [],
        connect: (n) => node.connections.push(n),
      };
      return node;
    },
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load app.js into an isolated context.
 * Returns the app's classes plus the stubs the tests need to drive them.
 */
function loadApp() {
  const document = createDocument();
  const audioContext = createAudioContextStub();

  const intervals = new Map();
  let nextIntervalId = 1;
  let setIntervalCalls = 0;
  let clearIntervalCalls = 0;

  const rafQueue = [];
  let rafScheduled = 0;

  const storage = new Map();

  const windowObject = {
    location: { hash: '', href: 'https://example.test/index.html' },
    AudioContext: function FakeAudioContext() {
      return audioContext;
    },
    addEventListener() {},
  };

  const sandbox = {
    console,
    document,
    window: windowObject,
    navigator: {
      clipboard: { writeText: () => Promise.resolve() },
      wakeLock: undefined,
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
      clear: () => storage.clear(),
    },
    atob: (s) => Buffer.from(String(s), 'base64').toString('binary'),
    btoa: (s) => Buffer.from(String(s), 'binary').toString('base64'),
    decodeURIComponent,
    encodeURIComponent,
    URL,
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms) => {
      setIntervalCalls++;
      const id = nextIntervalId++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => {
      clearIntervalCalls++;
      intervals.delete(id);
    },
    requestAnimationFrame: (cb) => {
      rafScheduled++;
      rafQueue.push(cb);
      return rafQueue.length;
    },
    performance: { now: () => Date.now() },
    getComputedStyle: () => ({ paddingLeft: '0px', paddingRight: '0px' }),
    Math,
    Date,
    JSON,
    Number,
    Object,
    Array,
    Set,
    Map,
    Promise,
    Float32Array,
    isNaN,
    parseFloat,
    parseInt,
  };

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_PATH, 'utf8'), sandbox, { filename: 'app.js' });
  // Top-level class/const declarations live in the context's global lexical
  // scope, so a second script in the same context can read them.
  vm.runInContext(
    'globalThis.__app = { MetronomeState, MetronomeApp, MetronomeAudioEngine, ' +
      'METRONOME_LIMITS, METRONOME_SOUNDS, METRONOME_BEAT_TYPES, ' +
      'toFiniteNumber, clampNumber, clampInt, normalizeGroups, normalizeOverrides, normalizeName };',
    sandbox
  );

  return {
    api: sandbox.__app,
    document,
    audioContext,
    storage,
    window: windowObject,

    // Timer inspection
    getActiveIntervals: () => intervals.size,
    getIntervalMs: () => [...intervals.values()].map((entry) => entry.ms),
    tickIntervals: () => [...intervals.values()].forEach((entry) => entry.fn()),
    get setIntervalCalls() {
      return setIntervalCalls;
    },
    get clearIntervalCalls() {
      return clearIntervalCalls;
    },

    // requestAnimationFrame inspection
    runFrame() {
      const due = rafQueue.splice(0, rafQueue.length);
      due.forEach((cb) => cb());
      return due.length;
    },
    get rafScheduled() {
      return rafScheduled;
    },
  };
}

// ---------------------------------------------------------------------------
// App instance without the DOM-bound constructor
// ---------------------------------------------------------------------------

/**
 * Build a MetronomeApp that uses the real prototype methods but a fake audio
 * engine and no DOM rendering. Constructor-only concerns (element caching,
 * factory preset table, init()) are skipped so transport logic can be driven
 * directly with a controllable clock.
 */
function createApp(harness, options = {}) {
  const api = harness.api;
  const app = Object.create(api.MetronomeApp.prototype);
  const clicks = [];

  const engine = {
    lookahead: options.lookahead !== undefined ? options.lookahead : 0.08,
    scheduleInterval: 25,
    timerId: null,
    _now: options.now !== undefined ? options.now : 0,
    // Mirror the real engine: audioCtx carries the clock the transport reads.
    audioCtx: null,
    clicks,
    cancelCount: 0,
    cancelledLayerIds: [],
    playClick(time, beatType, sound, volume, accentVolume, layerId) {
      clicks.push({ time, beatType, sound, volume, accentVolume, layerId });
    },
    cancelScheduledVoices(layerId) {
      engine.cancelCount++;
      engine.cancelledLayerIds.push(layerId);
    },
    ensureContext() {
      return engine.audioCtx;
    },
    get currentTime() {
      return engine._now;
    },
    setNow(t) {
      engine._now = t;
    },
    advance(dt) {
      engine._now += dt;
    },
  };
  engine.audioCtx = {
    get currentTime() {
      return engine._now;
    },
  };

  app.audioEngine = engine;
  app.state = new api.MetronomeState();
  app.dom = {};
  app.tapTimes = [];
  app.tapTimeout = null;
  app.toastTimeout = null;
  app.factoryPresetsData = [];
  app.document = harness.document;

  // Behaviour that belongs to the view layer.
  app.toasts = [];
  app.renderCount = 0;
  app.uiUpdates = 0;
  app.highlighted = [];

  app.acquireWakeLock = () => {};
  app.releaseWakeLock = () => {};
  app.showToast = (message) => app.toasts.push(message);
  app.renderAll = () => {
    app.renderCount++;
  };
  app.renderLayers = () => {
    app.renderCount++;
  };
  app.updateTransportUI = () => {
    app.uiUpdates++;
  };
  app.highlightBeat = (layerId, subdivIndex) => {
    app.highlighted.push({ layerId, subdivIndex });
  };

  // Lets a test drive startVisualLoop() one animation frame at a time.
  app.__frameDriver = { runFrame: () => harness.runFrame() };

  return app;
}

module.exports = {
  APP_PATH,
  createElement,
  createDocument,
  createAudioContextStub,
  loadApp,
  createApp,
};
