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

// The class list is derived from `className`, not kept in a parallel set:
// app.js assigns className in several places, and a divergent set made
// classList.contains() disagree with the class attribute.
function createClassList(getClassName, setClassName) {
  const tokens = () => String(getClassName() || '').split(/\s+/).filter(Boolean);
  const write = (list) => setClassName(list.join(' '));

  return {
    add: (...names) => {
      const list = tokens();
      for (const n of names) if (!list.includes(n)) list.push(n);
      write(list);
    },
    remove: (...names) => {
      write(tokens().filter((t) => !names.includes(t)));
    },
    toggle: (name, force) => {
      const list = tokens();
      const has = list.includes(name);
      const on = force === undefined ? !has : !!force;
      if (on === has) return on;
      if (on) write([...list, name]);
      else write(list.filter((t) => t !== name));
      return on;
    },
    contains: (name) => tokens().includes(name),
    get size() {
      return tokens().length;
    },
    get value() {
      return tokens().join(' ');
    },
  };
}

function createElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    _className: '',
    get className() {
      return el._className;
    },
    set className(value) {
      el._className = String(value === undefined || value === null ? '' : value);
    },
    _innerHTML: '',
    textContent: '',
    value: '',
    title: '',
    disabled: false,
    style: {},
    dataset: {},
    children: [],
    parentNode: null,
    listeners: {},
    scrollLeft: 0,
    get innerHTML() {
      return el._innerHTML;
    },
    set innerHTML(html) {
      // app.js builds markup via innerHTML then queries the result. This stub
      // records the markup and parses the class/attribute structure that the
      // shipped queries actually look for, so querySelector still works.
      el._innerHTML = String(html);
      el.children.slice().forEach((c) => el.removeChild(c));
      parseMarkupInto(el, el._innerHTML);
    },
    addEventListener(type, handler) {
      (el.listeners[type] = el.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    get classList() {
      return createClassList(() => el._className, (v) => { el._className = v; });
    },
    dispatch(type, event = {}) {
      (el.listeners[type] || []).forEach((handler) => handler({ target: el, ...event }));
    },
    // Bubble a real event up the ancestor chain, the way the browser does, so
    // delegated listeners on stable containers are actually exercised.
    dispatchEvent(event) {
      const type = event && event.type;
      let node = el;
      while (node) {
        const handlers = node.listeners && node.listeners[type];
        if (handlers) {
          handlers.forEach((h) => h({
            type,
            target: el,
            currentTarget: node,
            bubbles: true,
            stopPropagation() {},
            preventDefault() {},
          }));
        }
        node = node.parentNode;
      }
      return true;
    },
    appendChild(child) {
      if (child && child.parentNode) child.parentNode.removeChild(child);
      el.children.push(child);
      if (child) child.parentNode = el;
      return child;
    },
    removeChild(child) {
      const i = el.children.indexOf(child);
      if (i >= 0) el.children.splice(i, 1);
      if (child) child.parentNode = null;
      return child;
    },
    replaceChildren(...nodes) {
      el.children.slice().forEach((c) => el.removeChild(c));
      const flat = [];
      nodes.forEach((n) => {
        // Support the DocumentFragment case used by renderLayers().
        if (n && n.__isFragment) {
          n.children.slice().forEach((c) => flat.push(c));
        } else if (n) {
          flat.push(n);
        }
      });
      flat.forEach((n) => el.appendChild(n));
    },
    querySelector(selector) {
      return queryAll(el, selector)[0] || null;
    },
    querySelectorAll(selector) {
      return queryAll(el, selector);
    },
    closest(selector) {
      let node = el;
      while (node) {
        if (matchesSimple(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
    getAttribute(name) {
      if (name === 'class') return el.className || '';
      if (name === 'id') return el.id || '';
      if (name === 'tabindex') return el.tabIndex === undefined ? null : String(el.tabIndex);
      if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const v = el.dataset ? el.dataset[key] : undefined;
        return v === undefined ? null : String(v);
      }
      if (el.__attrs && Object.prototype.hasOwnProperty.call(el.__attrs, name)) {
        return String(el.__attrs[name]);
      }
      // Typed properties the parser may have set directly (role, aria-*).
      if (name === 'role' && el.role) return String(el.role);
      if (el.aria && Object.prototype.hasOwnProperty.call(el.aria, name)) {
        return String(el.aria[name]);
      }
      const direct = el[name];
      return direct === undefined ? null : String(direct);
    },
    setAttribute(name, value) {
      if (name === 'tabindex') { el.tabIndex = Number(value); return; }
      if (name === 'class') { el.className = String(value); return; }
      el.__attrs = el.__attrs || {};
      el.__attrs[name] = String(value);
    },
    removeAttribute(name) {
      if (name === 'tabindex') { el.tabIndex = -1; return; }
      if (el.__attrs) delete el.__attrs[name];
    },
    getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }),
    focus() {
      // Track a real active element so focus-preservation can be asserted.
      const doc = el.ownerDocument;
      if (doc) doc.activeElement = el;
    },
    blur() {
      const doc = el.ownerDocument;
      if (doc && doc.activeElement === el) doc.activeElement = doc.body;
    },
  };
  return el;
}

// A fragment that appendChild() splices into its parent, matching the real
// DocumentFragment semantics used by renderLayers().
function createFragment() {
  const frag = createElement('fragment');
  frag.__isFragment = true;
  frag.appendChild = (child) => {
    frag.children.push(child);
    return child;
  };
  return frag;
}

// ---------------------------------------------------------------------------
// Tiny HTML parser (enough to make innerHTML queryable)
// ---------------------------------------------------------------------------
//
// app.js builds layer / detail markup as a string and then queries it. Tests
// need those queries to find the same elements a browser would. This parser
// understands tags, class/id/data-* attributes and text; it is not a general
// HTML implementation.

function parseAttrs(attrText) {
  const attrs = {};
  const re = /([\w:-]+)(?:\s*=\s*"([^"]*)")?/g;
  let m;
  while ((m = re.exec(attrText))) {
    attrs[m[1]] = m[2] === undefined ? '' : m[2];
  }
  return attrs;
}

function applyAttrs(el, attrs) {
  for (const [name, value] of Object.entries(attrs)) {
    if (name === 'class') el.className = value;
    else if (name === 'id') el.id = value;
    else if (name === 'value') el.value = value;
    else if (name === 'title') el.title = value;
    else if (name === 'style') el.style = value;
    else if (name === 'tabindex') el.tabIndex = Number(value);
    else if (name === 'disabled') el.disabled = true;
    else if (name.startsWith('data-')) {      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      el.dataset[key] = value;
    } else {
      el[name] = value;
    }
  }
}

function parseMarkupInto(parent, html) {
  const stack = [parent];
  const re = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const [, closing, tagName, attrText, selfClosing, text] = m;

    if (text !== undefined) {
      const trimmed = text.trim();
      if (trimmed) {
        const top = stack[stack.length - 1];
        top.textContent = top.textContent ? `${top.textContent} ${trimmed}` : trimmed;
      }
      continue;
    }

    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }

    const el = createElement(tagName);
    // Inherit the document so focus()/activeElement tracking works on parsed
    // nodes exactly as it does on nodes created through document.createElement.
    el.ownerDocument = parent.ownerDocument || null;
    applyAttrs(el, parseAttrs(attrText || ''));
    stack[stack.length - 1].appendChild(el);

    const voidTags = new Set(['INPUT', 'BR', 'IMG', 'HR', 'META', 'LINK']);
    if (!selfClosing && !voidTags.has(el.tagName)) {
      stack.push(el);
    }
  }
  return parent;
}

// Minimal selector support: class selectors (.a), attribute selectors
// ([data-x="1"]) and tag names, all matched by walking the children tree.
// Only what app.js actually queries needs to work.
function matchesSimple(el, selector) {
  const sel = selector.trim();
  if (sel === '*') return true;

  // Compound selector support: ".subdiv-cell[data-index=\"0\"]" and similar.
  // Every simple part must match; a comma list matches if any branch does.
  if (sel.includes(',')) {
    return sel.split(',').some((part) => matchesSimple(el, part));
  }

  const parts = [];
  const re = /(\.[\w-]+|\[[\w-]+(?:="[^"]*")?\]|^[a-zA-Z][\w-]*)/g;
  let m;
  while ((m = re.exec(sel))) parts.push(m[1]);
  if (parts.length > 1) {
    return parts.every((p) => matchesSimple(el, p));
  }

  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return typeof el.className === 'string' && el.className.split(/\s+/).includes(cls);
  }
  if (sel.startsWith('[')) {
    const m = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
    if (!m) return false;
    const [, attr, expected] = m;
    let actual;
    if (attr.startsWith('data-')) {
      const key = attr.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      actual = el.dataset ? el.dataset[key] : undefined;
    } else if (attr === 'id') {
      actual = el.id;
    }
    if (actual === undefined) return false;
    return expected === undefined ? true : String(actual) === expected;
  }
  return el.tagName === sel.toUpperCase();
}

function walk(el, visit) {
  for (const child of el.children || []) {
    if (!child) continue;
    if (visit(child)) return child;
    const found = walk(child, visit);
    if (found) return found;
  }
  return null;
}

// Collect every descendant matching `selector` (depth-first, document order).
function queryAll(root, selector) {
  const out = [];
  const visit = (el) => {
    for (const child of el.children || []) {
      if (!child) continue;
      if (matchesSimple(child, selector)) out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function createDocument() {
  const byId = new Map();
  const root = createElement('root');

  const document = {
    elements: byId,
    root,
    activeElement: null,
    getElementById(id) {
      // Search the live tree only. Unlike a browser, this does NOT synthesise
      // a node for an unknown id — tests need `null` to mean "not in the DOM".
      return walk(root, (child) => child.id === id);
    },
    querySelector: (selector) => queryAll(root, selector)[0] || null,
    querySelectorAll: (selector) => queryAll(root, selector),
    createElement: (tag) => {
      const el = createElement(tag);
      el.ownerDocument = document;
      return el;
    },
    createDocumentFragment: () => {
      const frag = createFragment();
      frag.ownerDocument = document;
      return frag;
    },
    addEventListener() {},
    body: null,
  };
  document.body = document.createElement('body');
  document.root.appendChild(document.body);
  document.activeElement = document.body;
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
function loadApp(options = {}) {
  const document = createDocument();
  const audioContext = createAudioContextStub();

  // Optional ResizeObserver stub. Tests can drive the callback with real
  // entries to verify invalidation without a layout engine.
  let observerCallback = null;
  const observed = [];
  if (options.resizeObserver) {
    const Stub = class {
      constructor(cb) { observerCallback = cb; }
      observe(el) { observed.push(el); }
      disconnect() { observed.length = 0; }
    };
    options.resizeObserver.stub = Stub;
  }

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

  // Tests swap writeText to observe clipboard behaviour.
  const clipboard = {
    writes: [],
    writeText(text) {
      clipboard.writes.push(text);
      return Promise.resolve();
    },
  };

  const sandbox = {
    console,
    document,
    window: windowObject,
    ResizeObserver: options.resizeObserver ? options.resizeObserver.stub : undefined,
    navigator: {
      clipboard,
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
      'toFiniteNumber, clampNumber, clampInt, normalizeGroups, normalizeOverrides, normalizeName, ' +
      'clampGroupValue, isPayloadWithinLimit, LAYER_RENDER_POLICY, VIRTUAL_POLICY, ' +
      'computeWindow, computeVisibleRange, computeEffectiveWindow, itemsPerViewport };',
    sandbox
  );

  return {
    api: sandbox.__app,
    document,
    audioContext,
    storage,
    window: windowObject,
    // Real clipboard object the app calls into, plus a convenience alias.
    clipboard,
    sandboxNavigator: sandbox.navigator,

    // ResizeObserver inspection (when a stub was injected).
    get observerCallback() { return observerCallback; },
    get observedTargets() { return [...observed]; },
    fireResize(entries) {
      if (!observerCallback) throw new Error('no ResizeObserver callback installed');
      observerCallback(entries);
    },

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

  // Recording strategy. 'record' keeps every click object (what most tests
  // assert on). 'count' only tallies them, so a benchmark does not pay for
  // hundreds of thousands of short-lived objects — that allocation pressure
  // lands inside the timed region and makes runs incomparable.
  const recordMode = options.recordClicks !== false;
  let clickCount = 0;

  const engine = {
    lookahead: options.lookahead !== undefined ? options.lookahead : 0.08,
    scheduleInterval: 25,
    timerId: null,
    _now: options.now !== undefined ? options.now : 0,
    // Mirror the real engine: audioCtx carries the clock the transport reads.
    audioCtx: null,
    clicks,
    get clickCount() {
      return clickCount;
    },
    resetClickCount() {
      clickCount = 0;
      clicks.length = 0;
    },
    cancelCount: 0,
    cancelledLayerIds: [],
    playClick(time, beatType, sound, volume, accentVolume, layerId) {
      clickCount++;
      if (recordMode) {
        clicks.push({ time, beatType, sound, volume, accentVolume, layerId });
      }
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
  app.document = harness.document;

  // Real container so card-building paths (addLayer/removeLayer/renderLayers)
  // run against the same DOM shape the browser uses.
  const layersList = harness.document.createElement('div');
  layersList.id = 'layers-list';
  harness.document.root.appendChild(layersList);

  app.dom = {
    layersList,
    playBtn: harness.document.createElement('button'),
    playIcon: harness.document.createElement('span'),
    pauseBtn: harness.document.createElement('button'),
    stopBtn: harness.document.createElement('button'),
    resetBtn: harness.document.createElement('button'),
    bpmInput: harness.document.createElement('input'),
    bpmSlider: harness.document.createElement('input'),
    tapBtn: harness.document.createElement('button'),
    addLayerBtn: harness.document.createElement('button'),
    shareBtn: harness.document.createElement('button'),
    factoryPresets: harness.document.createElement('div'),
    userPresets: harness.document.createElement('div'),
    presetNameInput: harness.document.createElement('input'),
    savePresetBtn: harness.document.createElement('button'),
    toast: harness.document.createElement('div'),
  };

  app.tapTimes = [];
  app.tapTimeout = null;
  app.toastTimeout = null;
  app.factoryPresetsData = [];

  // UI-only expansion state, same initialisation the real constructor path
  // performs in init().
  app.expandedLayerIds = new Set();

  // Virtualisation bookkeeping, also initialised by init() in the real app.
  app.virtualObservers = new Map();
  app.virtualRefreshQueued = new Map();
  app.currentPlayhead = new Map();
  app.pendingCellIndex = new Map();
  app.gridCursor = new Map();

  // Behaviour that belongs to the view layer.
  app.toasts = [];
  app.renderCount = 0;
  app.uiUpdates = 0;
  app.highlighted = [];

  app.acquireWakeLock = () => {};
  app.releaseWakeLock = () => {};
  app.showToast = (message) => app.toasts.push(message);

  // Keep the real renderLayers()/renderAll() so tests exercise the shipped
  // rendering path; only count the calls for assertions.
  const realRenderLayers = app.renderLayers.bind(app);
  app.renderLayers = function countingRenderLayers(...args) {
    app.renderCount++;
    return realRenderLayers(...args);
  };
  const realRenderAll = app.renderAll.bind(app);
  app.renderAll = function countingRenderAll(...args) {
    app.renderCount++;
    return realRenderAll(...args);
  };

  app.updateTransportUI = () => {
    app.uiUpdates++;
  };

  // Record highlights for assertions, then run the real implementation so the
  // playhead bookkeeping and DOM painting are exercised as well.
  const realHighlightBeat = app.highlightBeat.bind(app);
  app.highlightBeat = (layerId, subdivIndex) => {
    app.highlighted.push({ layerId, subdivIndex });
    return realHighlightBeat(layerId, subdivIndex);
  };

  // Lets a test drive startVisualLoop() one animation frame at a time.
  app.__frameDriver = { runFrame: () => harness.runFrame() };

  return app;
}

// ---------------------------------------------------------------------------
// Fake layer card, so UI handlers can be exercised for real
// ---------------------------------------------------------------------------

/**
 * Build a stand-in for the DOM subtree createLayerCardElement() produces and
 * hand it to the real bindLayerCardEvents(). Only the selectors that method
 * queries are provided; every handler attached is the shipped one.
 */
function createFakeLayerCard(layer) {
  const make = (className, extra = {}) => {
    const el = createElement('div');
    el.className = className;
    Object.assign(el, extra);
    return el;
  };

  const groupTags = layer.groups.map((value, gIdx) => {
    const tag = make('group-tag');
    tag.dataset.gidx = String(gIdx);
    const valInput = make('group-tag-val', { value: String(value) });
    const delBtn = make('group-tag-del');
    const leftBtn = make('group-move-left');
    const rightBtn = make('group-move-right');
    tag.querySelector = (sel) => {
      if (sel === '.group-tag-val') return valInput;
      if (sel === '.group-tag-del') return delBtn;
      if (sel === '.group-move-left') return leftBtn;
      if (sel === '.group-move-right') return rightBtn;
      return null;
    };
    tag.children = { valInput, delBtn, leftBtn, rightBtn };
    return tag;
  });

  const cells = Array.from({ length: layer.numerator }, (_, i) => {
    const cell = make('subdiv-cell');
    cell.dataset.index = String(i);
    const icon = make('cell-icon');
    cell.querySelector = (sel) => (sel === '.cell-icon' ? icon : null);
    cell.children = { icon };
    return cell;
  });

  const singles = {
    '.layer-name-input': make('layer-name-input', { value: layer.name }),
    '.expand-btn': make('expand-btn'),
    '.meter-num-input': make('meter-num-input', { value: String(layer.numerator) }),
    '.meter-den-input': make('meter-den-input', { value: String(layer.denominator) }),
    '.select-sound': make('select-sound', { value: layer.sound }),
    '.vol-slider': make('vol-slider', { value: String(layer.volume) }),
    '.accent-slider': make('accent-slider', { value: String(layer.accentVolume) }),
    '.multiplier-input': make('multiplier-input', { value: String(layer.bpmMultiplier) }),
    '.mute-btn': make('mute-btn'),
    '.del-layer-btn': make('del-layer-btn'),
    '.btn-auto-group': make('btn-auto-group'),
    '.btn-even-group': make('btn-even-group'),
    '.btn-group-accent': make('btn-group-accent'),
    '.btn-clear-group': make('btn-clear-group'),
    '.add-group-btn': make('add-group-btn'),
    '.btn-reset-pattern': make('btn-reset-pattern'),
    '.btn-all-normal': make('btn-all-normal'),
    '.btn-random-pattern': make('btn-random-pattern'),
  };

  const card = make('layer-card');
  card.id = layer.id;
  card.querySelector = (sel) => {
    if (sel === '.subdivision-scroll-wrap') return null;
    return singles[sel] || null;
  };
  card.querySelectorAll = (sel) => {
    if (sel === '.group-tag') return groupTags;
    if (sel === '.subdiv-cell') return cells;
    return [];
  };
  card.singles = singles;
  card.groupTags = groupTags;
  card.cells = cells;
  return card;
}

module.exports = {
  APP_PATH,
  createElement,
  createDocument,
  createAudioContextStub,
  createFakeLayerCard,
  loadApp,
  createApp,
};
