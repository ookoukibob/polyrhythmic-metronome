/**
 * Issue C — shared configuration validation for URL hashes and saved presets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

function newApp() {
  const harness = loadApp();
  const app = createApp(harness, { now: 0 });
  return { app, harness };
}

// Encode exactly like shareConfiguration() does.
function encodeConfig(config) {
  return Buffer.from(encodeURIComponent(JSON.stringify(config)), 'binary').toString('base64');
}

// A config in the compact share-link shape.
function sharedConfig(overrides = {}) {
  return {
    bpm: 130,
    layers: [
      {
        n: 'Layer A',
        num: 59,
        den: 16,
        mul: 1,
        g: [3, 3, 2, 5, 7, 4, 6, 5, 2, 3, 4, 5, 3, 3, 4],
        ov: [],
        snd: 'classic',
        vol: 0.8,
        av: 1.3,
        m: 0,
      },
      {
        n: 'Layer B',
        num: 7,
        den: 16,
        mul: 2,
        g: [3, 2, 2],
        ov: [[0, 'mute'], [2, 'accent']],
        snd: 'wood',
        vol: 0.6,
        av: 1.5,
        m: 0,
      },
    ],
    ...overrides,
  };
}

function loadFromHash(app, harness, hash) {
  harness.window.location.hash = hash;
  return app.loadStateFromUrl();
}

// ---------------------------------------------------------------------------
// Valid input keeps working
// ---------------------------------------------------------------------------

test('Issue C: a valid shared URL is loaded unchanged', () => {
  const { app, harness } = newApp();
  const config = sharedConfig();

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig(config)), true);

  assert.equal(app.state.bpm, 130);
  assert.equal(app.state.layers.length, 2);

  const [a, b] = app.state.layers;
  assert.equal(a.name, 'Layer A');
  assert.equal(a.numerator, 59);
  assert.equal(a.denominator, 16);
  assert.deepEqual(list(a.groups), config.layers[0].g);
  assert.equal(a.sound, 'classic');
  assert.equal(a.volume, 0.8);
  assert.equal(a.accentVolume, 1.3);

  assert.equal(b.bpmMultiplier, 2);
  assert.equal(b.sound, 'wood');
  assert.deepEqual({ ...b.overrides }, { 0: 'mute', 2: 'accent' });
  assert.equal(b.muted, false);
});

test('Issue C: share -> load round trip preserves meaning', () => {
  const { app, harness } = newApp();

  app.state.bpm = 173;
  app.state.layers = [
    app.state.createLayer({ name: 'RT', numerator: 11, denominator: 8, bpmMultiplier: 1.5, groups: [3, 3, 3, 2] }),
  ];
  app.state.layers[0].overrides = { 1: 'mute', 4: 'accent' };
  app.state.layers[0].volume = 0.55;
  app.state.layers[0].accentVolume = 1.7;
  app.state.layers[0].sound = 'cowbell';

  // Build the share payload with the app's own encoder logic.
  const payload = {
    bpm: app.state.bpm,
    layers: app.state.layers.map((l) => ({
      n: l.name,
      num: l.numerator,
      den: l.denominator,
      mul: l.bpmMultiplier,
      g: l.groups,
      ov: Object.entries(l.overrides).map(([k, v]) => [Number(k), v]),
      snd: l.sound,
      vol: l.volume,
      av: l.accentVolume,
      m: l.muted ? 1 : 0,
    })),
  };

  const { app: fresh, harness: freshHarness } = newApp();
  assert.equal(loadFromHash(fresh, freshHarness, '#' + encodeConfig(payload)), true);

  assert.equal(fresh.state.bpm, 173);
  const layer = fresh.state.layers[0];
  assert.equal(layer.numerator, 11);
  assert.equal(layer.denominator, 8);
  assert.equal(layer.bpmMultiplier, 1.5);
  assert.deepEqual(list(layer.groups), [3, 3, 3, 2]);
  assert.deepEqual({ ...layer.overrides }, { 1: 'mute', 4: 'accent' });
  assert.equal(layer.sound, 'cowbell');
  assert.equal(layer.volume, 0.55);
  assert.equal(layer.accentVolume, 1.7);
});

test('Issue C: a valid long-form preset still loads', () => {
  const { app } = newApp();
  const preset = {
    name: 'legacy',
    bpm: 99,
    layers: [
      {
        name: 'Legacy 4/4',
        numerator: 4,
        denominator: 4,
        bpmMultiplier: 1,
        groups: [1, 1, 1, 1],
        overrides: {},
        sound: 'soft',
        volume: 0.7,
        accentVolume: 1.2,
        muted: false,
      },
    ],
    timestamp: 1,
  };

  assert.equal(app.loadPresetData(preset), true);
  assert.equal(app.state.bpm, 99);
  assert.equal(app.state.layers[0].sound, 'soft');
  assert.equal(app.state.layers[0].numerator, 4);
});

// ---------------------------------------------------------------------------
// Malformed input is rejected, not fatal
// ---------------------------------------------------------------------------

test('Issue C: invalid JSON hash is ignored without throwing', () => {
  const { app, harness } = newApp();
  assert.equal(loadFromHash(app, harness, '#not-json-at-all'), false);
  assert.equal(app.state.layers.length, 0, 'state untouched, caller loads the default');
});

test('Issue C: invalid base64 hash is ignored without throwing', () => {
  const { app, harness } = newApp();
  assert.equal(loadFromHash(app, harness, '#%%%not-base64%%%'), false);
});

test('Issue C: valid base64 of invalid JSON is ignored', () => {
  const { app, harness } = newApp();
  const bad = Buffer.from(encodeURIComponent('{ this is not json'), 'binary').toString('base64');
  assert.equal(loadFromHash(app, harness, '#' + bad), false);
});

test('Issue C: an empty hash leaves the app on its default path', () => {
  const { app, harness } = newApp();
  assert.equal(loadFromHash(app, harness, ''), false);
});

test('Issue C: structurally invalid documents are rejected', () => {
  const { app, harness } = newApp();
  const cases = [
    ['#', null],
    ['#' + encodeConfig({ bpm: 120 }), 'missing layers'],
    ['#' + encodeConfig({ bpm: 120, layers: [] }), 'empty layers'],
    ['#' + encodeConfig({ bpm: 120, layers: 'nope' }), 'layers not an array'],
    ['#' + encodeConfig({ bpm: 120, layers: [null] }), 'null layer'],
    ['#' + encodeConfig({ bpm: 120, layers: ['x'] }), 'string layer'],
    ['#' + encodeConfig({ bpm: 120, layers: [[]] }), 'array layer'],
    ['#' + encodeConfig([1, 2, 3]), 'top-level array'],
  ];

  for (const [hash, label] of cases) {
    assert.equal(loadFromHash(app, harness, hash), false, `should reject: ${label}`);
    assert.equal(app.state.layers.length, 0, `state untouched for: ${label}`);
  }
});

test('Issue C: out-of-range numeric values are clamped, not accepted raw', () => {
  const { app, harness } = newApp();
  const config = sharedConfig({
    bpm: 99999,
    layers: [
      { n: 'A', num: 5000, den: 9999, mul: 99, g: [3], ov: [], snd: 'classic', vol: 5, av: 99, m: 0 },
    ],
  });

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig(config)), true);

  assert.equal(app.state.bpm, 600);
  const layer = app.state.layers[0];
  assert.equal(layer.numerator, 1024);
  assert.equal(layer.denominator, 256);
  assert.equal(layer.bpmMultiplier, 8);
  assert.equal(layer.volume, 1);
  assert.equal(layer.accentVolume, 2);
});

test('Issue C: NaN-like and Infinity-like values never reach the scheduler', () => {
  const { app, harness } = newApp();
  // JSON cannot carry NaN/Infinity, so they arrive as strings or as null.
  const config = {
    bpm: 'NaN',
    layers: [
      {
        n: 'A',
        num: 'Infinity',
        den: 'NaN',
        mul: 'abc',
        g: ['NaN', 'Infinity'],
        ov: [['NaN', 'accent'], [0, 'Infinity']],
        snd: 'nope',
        vol: 'Infinity',
        av: '-Infinity',
        m: 0,
      },
    ],
  };

  const loaded = loadFromHash(app, harness, '#' + encodeConfig(config));
  assert.equal(loaded, false, 'a layer with an unusable numerator is rejected');

  // Same values on a preset path: the guard must hold there too.
  const { app: presetApp } = newApp();
  assert.equal(
    presetApp.loadPresetData({ name: 'bad', bpm: 'NaN', layers: [{ name: 'A', numerator: 'Infinity' }] }),
    false
  );
});

test('Issue C: NaN-like fields that are optional fall back to defaults', () => {
  const { app, harness } = newApp();
  const config = sharedConfig({
    bpm: 'not-a-number',
    layers: [
      { n: 'A', num: 4, den: 4, mul: 'x', g: [1, 1, 1, 1], ov: [], snd: 'bogus', vol: 'y', av: 'z', m: 0 },
    ],
  });

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig(config)), true);

  const layer = app.state.layers[0];
  assert.equal(app.state.bpm, 120, 'invalid BPM falls back to the default');
  assert.equal(layer.bpmMultiplier, 1, 'invalid multiplier falls back to 1');
  assert.equal(layer.volume, 0.8, 'invalid volume falls back to 0.8');
  assert.equal(layer.accentVolume, 1.3, 'invalid accent volume falls back to 1.3');
  assert.equal(layer.sound, 'classic', 'unknown sound falls back to classic');
  assert.ok(Number.isFinite(app.state.getSubdivDuration(layer)));
});

test('Issue C: invalid grouping structures are rejected', () => {
  const { app, harness } = newApp();
  const cases = [
    [['3', 'a']],          // non-numeric entry
    [[0]],                 // below minimum group size
    [[-2]],                // negative
    [[1.5]],               // not an integer
    [[10000]],             // above maximum group size
    ['3+3+2'],             // string instead of array
    [{ size: 3 }],         // object instead of number
    [null],                // null entry
  ];

  for (const groups of cases) {
    const config = sharedConfig({ layers: [{ n: 'A', num: 6, den: 8, g: groups, ov: [] }] });
    assert.equal(
      loadFromHash(app, harness, '#' + encodeConfig(config)),
      false,
      `grouping should be rejected: ${JSON.stringify(groups)}`
    );
  }
});

test('Issue C: invalid override indices and beat types are dropped', () => {
  const { app, harness } = newApp();
  const config = sharedConfig({
    layers: [
      {
        n: 'A',
        num: 4,
        den: 4,
        g: [1, 1, 1, 1],
        // index 99 is out of range for num=4; 'loud' is not a beat type;
        // index -1 is negative. Only [1,'mute'] and [3,'accent'] are valid.
        ov: [[99, 'accent'], [1, 'mute'], [-1, 'normal'], [3, 'accent'], [2, 'loud']],
      },
    ],
  });

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig(config)), true);
  assert.deepEqual({ ...app.state.layers[0].overrides }, { 1: 'mute', 3: 'accent' });
});

test('Issue C: an unusable override container rejects the layer', () => {
  const { app, harness } = newApp();
  const config = sharedConfig({
    layers: [{ n: 'A', num: 4, den: 4, g: [1, 1, 1, 1], ov: 'accent-at-0' }],
  });

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig(config)), false);
});

test('Issue C: excessively large payloads are ignored before decoding', () => {
  const { app, harness } = newApp();
  const huge = '#'.padEnd(300000, 'A');
  assert.equal(loadFromHash(app, harness, huge), false);
  assert.equal(app.state.layers.length, 0);
});

test('Issue C: too many layers are rejected', () => {
  const { app, harness } = newApp();
  const layers = Array.from({ length: 100 }, (_, i) => ({
    n: `L${i}`, num: 4, den: 4, g: [1, 1, 1, 1], ov: [],
  }));

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig({ bpm: 120, layers })), false);
});

// ---------------------------------------------------------------------------
// Grouping sum is NOT a fatal error
// ---------------------------------------------------------------------------

test('Issue C: incomplete grouping sums load and stay editable', () => {
  const { app, harness } = newApp();
  // 3+3+2 = 8 for a 12-subdivision layer: incomplete, but a supported state.
  const config = sharedConfig({
    layers: [{ n: 'Partial', num: 12, den: 8, g: [3, 3, 2], ov: [] }],
  });

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig(config)), true);
  const layer = app.state.layers[0];
  assert.deepEqual(list(layer.groups), [3, 3, 2]);
  assert.equal(layer.numerator, 12);

  const sum = list(layer.groups).reduce((a, b) => a + b, 0);
  assert.notEqual(sum, layer.numerator, 'the mismatch is preserved, not "fixed"');
});

test('Issue C: an empty grouping array is accepted (Clear Grouping state)', () => {
  const { app, harness } = newApp();
  const config = sharedConfig({ layers: [{ n: 'Cleared', num: 9, den: 8, g: [], ov: [] }] });

  assert.equal(loadFromHash(app, harness, '#' + encodeConfig(config)), true);
  assert.equal(app.state.layers[0].groups.length, 0);
});

// ---------------------------------------------------------------------------
// LocalStorage
// ---------------------------------------------------------------------------

test('Issue C: corrupted localStorage presets degrade to an empty list', () => {
  const { app, harness } = newApp();
  harness.storage.set('polyrhythm_metronome_presets', '{not json');

  assert.deepEqual(list(app.getUserPresets()), []);
});

test('Issue C: a non-array preset store is ignored', () => {
  const { app, harness } = newApp();
  harness.storage.set('polyrhythm_metronome_presets', JSON.stringify({ a: 1 }));

  assert.deepEqual(list(app.getUserPresets()), []);
});

test('Issue C: a preset store with junk entries still renders the valid ones', () => {
  const { app, harness } = newApp();
  harness.storage.set(
    'polyrhythm_metronome_presets',
    JSON.stringify([null, 'string', { name: 'ok', bpm: 120, layers: [{ name: 'L', numerator: 4 }] }])
  );

  const presets = list(app.getUserPresets());
  assert.equal(presets.length, 3, 'entries are returned as stored');

  // Loading the junk entries must fail cleanly, loading the valid one must work.
  assert.equal(app.loadPresetData(presets[0]), false);
  assert.equal(app.loadPresetData(presets[1]), false);
  assert.equal(app.loadPresetData(presets[2]), true);
  assert.equal(app.state.layers[0].numerator, 4);
});

test('Issue C: a corrupted preset does not disturb the live configuration', () => {
  const { app } = newApp();
  app.state.bpm = 145;
  app.state.layers = [app.state.createLayer({ name: 'Live', numerator: 7, denominator: 8 })];

  const rejected = app.loadPresetData({ name: 'broken', bpm: 300, layers: [{ n: 1 }] });

  assert.equal(rejected, false);
  assert.equal(app.state.bpm, 145, 'BPM unchanged');
  assert.equal(app.state.layers.length, 1);
  assert.equal(app.state.layers[0].name, 'Live');
  assert.ok(app.toasts.length > 0, 'the user is told the preset was invalid');
});

test('Issue C: localStorage write failures do not throw', () => {
  const { app, harness } = newApp();
  const original = harness.storage.set;
  // Simulate a full quota by making setItem throw.
  Object.defineProperty(harness.storage, 'set', {
    value: () => {
      throw new Error('QuotaExceededError');
    },
    configurable: true,
  });

  app.dom.userPresets = { innerHTML: '', appendChild: () => {} };
  assert.doesNotThrow(() => app.saveUserPreset('x'));

  Object.defineProperty(harness.storage, 'set', { value: original, configurable: true });
});

// ---------------------------------------------------------------------------
// createLayer hardening
// ---------------------------------------------------------------------------

test('Issue C: createLayer clamps and defaults every field', () => {
  const { api } = loadApp();
  const state = new api.MetronomeState();

  const layer = state.createLayer({
    name: '   ',
    numerator: 'NaN',
    denominator: -5,
    bpmMultiplier: 0,
    groups: [3, 3],
    overrides: { 0: 'accent', 5: 'nope', 99: 'mute' },
    sound: 'unknown',
    volume: -3,
    accentVolume: 50,
  });

  assert.equal(layer.name, 'Layer 1');
  assert.equal(layer.numerator, 59, 'invalid numerator falls back to the default');
  assert.equal(layer.denominator, 1, 'negative denominator clamps to the minimum');
  assert.equal(layer.bpmMultiplier, 0.1, 'zero multiplier clamps to the minimum');
  assert.deepEqual(list(layer.groups), [3, 3]);
  assert.deepEqual({ ...layer.overrides }, { 0: 'accent' });
  assert.equal(layer.sound, 'classic');
  assert.equal(layer.volume, 0);
  assert.equal(layer.accentVolume, 2);
});

test('Issue C: getSubdivDuration never returns NaN or Infinity', () => {
  const { api } = loadApp();
  const state = new api.MetronomeState();

  const broken = [
    { numerator: NaN, denominator: 16, bpmMultiplier: 1 },
    { numerator: 4, denominator: NaN, bpmMultiplier: 1 },
    { numerator: 4, denominator: 16, bpmMultiplier: NaN },
    { numerator: 4, denominator: 0, bpmMultiplier: 0 },
    { numerator: Infinity, denominator: Infinity, bpmMultiplier: Infinity },
  ];

  for (const layer of broken) {
    const duration = state.getSubdivDuration(layer);
    assert.ok(Number.isFinite(duration), `duration must be finite for ${JSON.stringify(layer)}`);
    assert.ok(duration > 0, 'duration must be positive');
  }

  state.bpm = NaN;
  assert.ok(Number.isFinite(state.getSubdivDuration({ numerator: 4, denominator: 4, bpmMultiplier: 1 })));
});

test('Issue C: scheduler survives a layer with a poisoned duration', () => {
  const { app } = newApp();
  app.state.bpm = 120;
  app.state.layers = [app.state.createLayer({ name: 'A', numerator: 4, denominator: 4 })];
  app.state.layers[0].denominator = NaN;
  app.state.isPlaying = true;
  app.state.layers[0].nextNoteTime = 0;

  assert.doesNotThrow(() => app.scheduler());
  assert.ok(list(app.state.visualQueue).every((e) => Number.isFinite(e.audioTime)));
});

test('Issue C: normalizeConfiguration accepts valid input and reports reasons', () => {
  const { api } = loadApp();
  const state = new api.MetronomeState();

  const ok = state.normalizeConfiguration({ bpm: 120, layers: [{ numerator: 4, denominator: 4 }] });
  assert.equal(ok.ok, true);
  assert.equal(ok.bpm, 120);
  assert.equal(ok.layers.length, 1);

  const bad = state.normalizeConfiguration(null);
  assert.equal(bad.ok, false);
  assert.equal(typeof bad.reason, 'string');

  const badLayer = state.normalizeConfiguration({ bpm: 120, layers: [{ numerator: 'abc' }] });
  assert.equal(badLayer.ok, false);
});
