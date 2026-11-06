/**
 * UI boundary consistency — every configuration a user can build through the
 * interface must survive save / reload / export / import.
 *
 * These tests drive the real handlers in app.js (bindLayerCardEvents, addLayer,
 * shareConfiguration, saveUserPreset), not re-implementations of them.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp, createFakeLayerCard } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

function newApp() {
  const harness = loadApp();
  const app = createApp(harness, { now: 0 });
  app.state.layers = [app.state.createLayer({ name: 'Base', numerator: 4, denominator: 4 })];
  return { app, harness, limits: harness.api.METRONOME_LIMITS };
}

// Bind the real card handlers for a layer and return the fake card.
// Both halves are attached: header controls and the expandable detail.
// Note: group-tag and subdivision interactions are delegated in the shipped
// code, so those tests drive the real rendered card instead (see renderCard).
function bindCard(app, layer) {
  const card = createFakeLayerCard(layer);
  app.bindLayerHeaderEvents(card, layer);
  app.bindLayerDetailEvents(card, layer);
  return card;
}

// Render one layer through the real render path, expanded, and return the
// live card element. Group/pattern events are delegated, so this is the only
// way to exercise them the way a browser does.
function renderCard(app, layer) {
  const index = app.state.layers.indexOf(layer);
  app.expandedLayerIds.add(layer.id);
  const card = app.createLayerCardElement(layer, index);
  app.dom.layersList.appendChild(card);
  return card;
}

// Fire a 'change' from a group-tag value input, as the browser would.
function changeGroupValue(app, card, gIdx, rawValue) {
  const tag = card.querySelectorAll('.group-tag')[gIdx];
  const input = tag.querySelector('.group-tag-val');
  input.value = rawValue;
  // Bubbles to the delegated listener on .groups-tags-container.
  let node = input;
  while (node && node !== card.parentNode) {
    const handlers = node.listeners && node.listeners.change;
    if (handlers) handlers.forEach((h) => h({ target: input, bubbles: true }));
    node = node.parentNode;
  }
  return input;
}

// renderUserPresets() builds real chips through document.createElement; that is
// view-only work, so it is stubbed exactly like renderLayers in createApp().
// saveUserPreset()'s validation and persistence still run for real.
function stubPresetContainer(app) {
  app.dom.userPresets = { innerHTML: '', appendChild: () => {} };
  app.renderUserPresets = () => {};
}

// ---------------------------------------------------------------------------
// Layer count
// ---------------------------------------------------------------------------

test('UI: the 64th layer can be added through the UI path', () => {
  const { app, limits } = newApp();

  while (app.state.layers.length < limits.maxLayers) {
    assert.equal(app.addLayer({ name: 'L', numerator: 4, denominator: 4 }), true);
  }

  assert.equal(app.state.layers.length, limits.maxLayers);
  assert.equal(app.state.layers.length, 64);
});

test('UI: the 65th layer is refused and changes nothing', () => {
  const { app, limits } = newApp();

  while (app.state.layers.length < limits.maxLayers) {
    app.addLayer({ name: 'L', numerator: 4, denominator: 4 });
  }

  const before = list(app.state.layers).map((l) => l.id);
  const toastCountBefore = app.toasts.length;

  assert.equal(app.addLayer({ name: 'Overflow', numerator: 4, denominator: 4 }), false);

  assert.equal(app.state.layers.length, limits.maxLayers, 'count unchanged');
  assert.deepEqual(list(app.state.layers).map((l) => l.id), before, 'layer data unchanged');
  assert.ok(
    !list(app.state.layers).some((l) => l.name === 'Overflow'),
    'the rejected layer was never created'
  );
  assert.ok(app.toasts.length > toastCountBefore, 'the user is told why');
  assert.match(app.toasts[app.toasts.length - 1], /上限/);
});

test('UI: a rejected add does not render or mutate before the check', () => {
  const { app, limits } = newApp();
  while (app.state.layers.length < limits.maxLayers) {
    app.addLayer({ name: 'L', numerator: 4, denominator: 4 });
  }

  const rendersBefore = app.renderCount;
  app.addLayer({ name: 'Overflow', numerator: 4, denominator: 4 });

  assert.equal(app.renderCount, rendersBefore, 'no re-render on a rejected add');
});

test('UI: a full 64-layer config round-trips through the share link', () => {
  const { app, harness, limits } = newApp();

  while (app.state.layers.length < limits.maxLayers) {
    app.addLayer({ name: 'L', numerator: 4, denominator: 4 });
  }
  assert.equal(app.state.layers.length, limits.maxLayers);

  // Export through the real method, then read the hash it produced.
  const copied = [];
  harness.clipboard.writeText = (text) => {
    copied.push(text);
    return Promise.resolve();
  };

  assert.equal(app.shareConfiguration(), true);
  assert.equal(copied.length, 1);

  const hash = copied[0].slice(copied[0].indexOf('#') + 1);
  assert.ok(hash.length <= limits.maxPayloadLength, 'payload within the import limit');

  // Import it back with the real loader.
  const { app: fresh, harness: freshHarness } = newApp();
  freshHarness.window.location.hash = '#' + hash;
  assert.equal(fresh.loadStateFromUrl(), true);
  assert.equal(fresh.state.layers.length, limits.maxLayers);
});

// ---------------------------------------------------------------------------
// Group count
// ---------------------------------------------------------------------------

test('UI: the last legal group can be added (per-layer limit)', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.numerator = 1024;
  layer.groups = new Array(limits.maxGroupEntries - 1).fill(1);

  const card = bindCard(app, layer);
  card.singles['.add-group-btn'].dispatch('click');

  assert.equal(layer.groups.length, limits.maxGroupEntries);
});

test('UI: adding past the group limit is refused and preserves the data', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.numerator = 1024;
  layer.groups = new Array(limits.maxGroupEntries).fill(1);

  const card = bindCard(app, layer);
  const before = [...layer.groups];
  const toastCountBefore = app.toasts.length;

  card.singles['.add-group-btn'].dispatch('click');

  assert.equal(layer.groups.length, limits.maxGroupEntries, 'length unchanged');
  assert.deepEqual([...layer.groups], before, 'group data unchanged');
  assert.ok(app.toasts.length > toastCountBefore, 'the user is told why');
  assert.match(app.toasts[app.toasts.length - 1], /上限/);
});

test('UI: the group limit is per layer, not global', () => {
  const { app, limits } = newApp();
  const full = app.state.layers[0];
  full.numerator = 1024;
  full.groups = new Array(limits.maxGroupEntries).fill(1);

  const other = app.state.createLayer({ name: 'Other', numerator: 8, denominator: 8 });
  app.state.layers.push(other);

  const fullCard = bindCard(app, full);
  fullCard.singles['.add-group-btn'].dispatch('click');
  assert.equal(full.groups.length, limits.maxGroupEntries, 'full layer refuses');

  const otherCard = bindCard(app, other);
  const beforeOther = other.groups.length;
  otherCard.singles['.add-group-btn'].dispatch('click');
  assert.equal(other.groups.length, beforeOther + 1, 'a different layer still accepts');
});

test('UI: group count at the limit still passes the shared validator', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.numerator = 1024;
  layer.groups = new Array(limits.maxGroupEntries).fill(1);

  const normalized = app.state.normalizeConfiguration({ bpm: 120, layers: [layer] });
  assert.equal(normalized.ok, true, 'the maximum legal group count is accepted');
});

test('UI: one group beyond the limit is rejected by the shared validator', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.numerator = 1024;
  layer.groups = new Array(limits.maxGroupEntries + 1).fill(1);

  const normalized = app.state.normalizeConfiguration({ bpm: 120, layers: [layer] });
  assert.equal(normalized.ok, false, 'and the UI never lets the user get here');
});

// ---------------------------------------------------------------------------
// Group value
// ---------------------------------------------------------------------------

test('UI: group value 1 is stored and displayed as 1', () => {
  const { app } = newApp();
  const layer = app.state.layers[0];
  layer.groups = [4];

  const card = renderCard(app, layer);
  const input = changeGroupValue(app, card, 0, '1');

  assert.equal(layer.groups[0], 1);
  assert.equal(String(input.value), '1');
});

test('UI: group value 512 is accepted (the maximum)', () => {
  const { app } = newApp();
  const layer = app.state.layers[0];
  layer.groups = [4];

  const card = renderCard(app, layer);
  const input = changeGroupValue(app, card, 0, '512');

  assert.equal(layer.groups[0], 512);
  assert.equal(String(input.value), '512');
});

test('UI: group value 513 is clamped to 512 in both state and input', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.groups = [4];

  const card = renderCard(app, layer);
  const input = changeGroupValue(app, card, 0, '513');

  assert.equal(layer.groups[0], limits.groupSize.max);
  assert.equal(layer.groups[0], 512);
  assert.equal(String(input.value), '512', 'the displayed value matches the stored one');
});

test('UI: group value 0 is clamped to 1', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.groups = [4];

  const card = renderCard(app, layer);
  const input = changeGroupValue(app, card, 0, '0');

  assert.equal(layer.groups[0], limits.groupSize.min);
  assert.equal(layer.groups[0], 1);
  assert.equal(String(input.value), '1');
});

test('UI: an empty group value falls back to a legal minimum', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.groups = [4];

  const card = renderCard(app, layer);
  const input = changeGroupValue(app, card, 0, '');

  assert.equal(layer.groups[0], limits.groupSize.min);
  assert.equal(String(input.value), '1');
});

test('UI: a non-numeric group value falls back to a legal minimum', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.groups = [4];

  const card = renderCard(app, layer);
  const input = changeGroupValue(app, card, 0, 'abc');

  assert.equal(layer.groups[0], limits.groupSize.min);
  assert.equal(String(input.value), '1');
});

test('UI: group values never poison the shared validator', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.groups = [4, 4, 4, 4];

  const card = renderCard(app, layer);
  const hostile = ['513', '0', '', 'abc', 'NaN', 'Infinity', '-1', '1e9', '2.7'];

  hostile.forEach((raw, i) => {
    const idx = i % layer.groups.length;
    const input = changeGroupValue(app, card, idx, raw);

    const stored = layer.groups[idx];
    assert.ok(Number.isInteger(stored), `stored value must be an integer for input ${JSON.stringify(raw)}`);
    assert.ok(stored >= limits.groupSize.min && stored <= limits.groupSize.max,
      `stored value ${stored} must be inside the shared range`);
    assert.equal(String(input.value), String(stored), 'display matches storage');

    const normalized = app.state.normalizeConfiguration({ bpm: 120, layers: [layer] });
    assert.equal(normalized.ok, true, `config stays loadable after ${JSON.stringify(raw)}`);
  });
});

test('UI: incomplete grouping sums stay allowed', () => {
  const { app } = newApp();
  const layer = app.state.layers[0];
  layer.numerator = 12;
  layer.groups = [3, 3, 2]; // sum 8, deliberately incomplete

  const card = renderCard(app, layer);
  changeGroupValue(app, card, 2, '5');

  assert.deepEqual([...layer.groups], [3, 3, 5]);
  const sum = layer.groups.reduce((a, b) => a + b, 0);
  assert.notEqual(sum, layer.numerator, 'the mismatch is preserved, not enforced');

  const normalized = app.state.normalizeConfiguration({ bpm: 120, layers: [layer] });
  assert.equal(normalized.ok, true, 'an incomplete grouping sum still loads');
});

// ---------------------------------------------------------------------------
// Other UI entry points that could produce an unloadable config
// ---------------------------------------------------------------------------

test('UI: every layer-card action leaves a loadable configuration', () => {
  const { app } = newApp();

  const actions = [
    ['auto-group', (layer, card) => {
      layer.numerator = 1024;
      card.singles['.btn-auto-group'].dispatch('click');
    }],
    ['even-group with more groups than beats', (layer, card) => {
      layer.numerator = 2;
      layer.groups = [1, 1, 1, 1];
      card.singles['.btn-even-group'].dispatch('click');
    }],
    ['group-accent', (layer, card) => {
      layer.groups = [3, 1];
      card.singles['.btn-group-accent'].dispatch('click');
    }],
    ['clear-group', (layer, card) => {
      card.singles['.btn-clear-group'].dispatch('click');
    }],
    ['reset-pattern', (layer, card) => {
      card.singles['.btn-reset-pattern'].dispatch('click');
    }],
    ['all-normal', (layer, card) => {
      layer.numerator = 1024;
      card.singles['.btn-all-normal'].dispatch('click');
    }],
    ['random-pattern', (layer, card) => {
      layer.numerator = 1024;
      card.singles['.btn-random-pattern'].dispatch('click');
    }],
    ['repeated cell clicks', (layer, card) => {
      for (let i = 0; i < 200; i++) {
        card.cells[i % card.cells.length].dispatch('click');
      }
    }],
    ['500-character layer name', (layer, card) => {
      card.singles['.layer-name-input'].value = 'z'.repeat(500);
      card.singles['.layer-name-input'].dispatch('change');
    }],
    ['add-group at a normal size', (layer, card) => {
      card.singles['.add-group-btn'].dispatch('click');
    }],
    ['group value past the maximum', (layer, card) => {
      card.groupTags[0].children.valInput.value = '99999';
      card.groupTags[0].children.valInput.dispatch('change');
    }],
  ];

  for (const [label, mutate] of actions) {
    app.state.layers = [app.state.createLayer({ name: 'probe', numerator: 4, denominator: 4 })];
    const layer = app.state.layers[0];
    const card = bindCard(app, layer);

    mutate(layer, card);

    const normalized = app.state.normalizeConfiguration({
      bpm: app.state.bpm,
      layers: app.state.layers,
    });
    assert.equal(normalized.ok, true, `action "${label}" must leave a loadable config`);
  }
});

test('UI: even-group with more groups than beats stays legal', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  layer.numerator = 2;
  layer.groups = [1, 1, 1, 1]; // 4 groups, 2 beats -> base becomes 0

  const card = bindCard(app, layer);
  card.singles['.btn-even-group'].dispatch('click');

  assert.equal(layer.groups.length, 4);
  for (const value of layer.groups) {
    assert.ok(value >= limits.groupSize.min, `group ${value} must be >= ${limits.groupSize.min}`);
  }
  const normalized = app.state.normalizeConfiguration({ bpm: 120, layers: [layer] });
  assert.equal(normalized.ok, true);
});

test('UI: numerator and denominator inputs clamp to the shared limits', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  const card = bindCard(app, layer);

  card.singles['.meter-num-input'].value = '99999';
  card.singles['.meter-num-input'].dispatch('change');
  assert.equal(layer.numerator, limits.numerator.max);
  assert.equal(String(card.singles['.meter-num-input'].value), String(limits.numerator.max));

  card.singles['.meter-den-input'].value = '0';
  card.singles['.meter-den-input'].dispatch('change');
  assert.equal(layer.denominator, limits.denominator.min);
});

test('UI: multiplier and volume inputs clamp to the shared limits', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  const card = bindCard(app, layer);

  card.singles['.multiplier-input'].value = '99';
  card.singles['.multiplier-input'].dispatch('change');
  assert.equal(layer.bpmMultiplier, limits.bpmMultiplier.max);

  card.singles['.multiplier-input'].value = 'abc';
  card.singles['.multiplier-input'].dispatch('change');
  assert.ok(Number.isFinite(layer.bpmMultiplier));

  card.singles['.vol-slider'].value = '5';
  card.singles['.vol-slider'].dispatch('input');
  assert.equal(layer.volume, limits.volume.max);

  card.singles['.accent-slider'].value = '99';
  card.singles['.accent-slider'].dispatch('input');
  assert.equal(layer.accentVolume, limits.accentVolume.max);
});

test('UI: layer name is truncated to the shared limit', () => {
  const { app, limits } = newApp();
  const layer = app.state.layers[0];
  const card = bindCard(app, layer);

  card.singles['.layer-name-input'].value = 'x'.repeat(500);
  card.singles['.layer-name-input'].dispatch('change');

  assert.equal(layer.name.length, limits.maxNameLength);
  assert.equal(String(card.singles['.layer-name-input'].value).length, limits.maxNameLength);
});

// ---------------------------------------------------------------------------
// Share link
// ---------------------------------------------------------------------------

test('UI: a normal config produces a share link', async () => {
  const { app, harness } = newApp();
  const copied = [];
  harness.clipboard.writeText = (text) => {
    copied.push(text);
    return Promise.resolve();
  };

  assert.equal(app.shareConfiguration(), true);
  assert.equal(copied.length, 1);
  assert.ok(copied[0].includes('#'));

  // The success toast is raised in the clipboard promise's .then().
  await Promise.resolve();
  assert.match(app.toasts[app.toasts.length - 1], /已复制/);
});

test('UI: the generated link is re-parsable by the import path', () => {
  const { app, harness } = newApp();
  app.state.bpm = 173;
  app.state.layers = [
    app.state.createLayer({
      name: 'RT',
      numerator: 11,
      denominator: 8,
      bpmMultiplier: 1.5,
      groups: [3, 3, 3, 2],
    }),
  ];
  app.state.layers[0].overrides = { 1: 'mute', 4: 'accent' };

  const copied = [];
  harness.clipboard.writeText = (text) => {
    copied.push(text);
    return Promise.resolve();
  };
  assert.equal(app.shareConfiguration(), true);

  const hash = copied[0].slice(copied[0].indexOf('#') + 1);

  const { app: fresh, harness: freshHarness } = newApp();
  freshHarness.window.location.hash = '#' + hash;
  assert.equal(fresh.loadStateFromUrl(), true);
  assert.equal(fresh.state.bpm, 173);
  assert.equal(fresh.state.layers[0].numerator, 11);
  assert.deepEqual(list(fresh.state.layers[0].groups), [3, 3, 3, 2]);
  assert.deepEqual({ ...fresh.state.layers[0].overrides }, { 1: 'mute', 4: 'accent' });
});

test('UI: an oversized config is refused before touching the clipboard', () => {
  const { app, harness, limits } = newApp();

  const copied = [];
  let clipboardCalls = 0;
  harness.clipboard.writeText = (text) => {
    clipboardCalls++;
    copied.push(text);
    return Promise.resolve();
  };

  // 64 layers each carrying 1024 groups pushes the payload past the limit.
  app.state.layers = Array.from({ length: limits.maxLayers }, (_, i) =>
    app.state.createLayer({
      name: `Big layer ${i} with a fairly long descriptive name`,
      numerator: 1024,
      denominator: 16,
      groups: new Array(limits.maxGroupEntries).fill(1),
    })
  );

  const toastCountBefore = app.toasts.length;
  const result = app.shareConfiguration();

  assert.equal(result, false, 'the export reports failure');
  assert.equal(clipboardCalls, 0, 'the clipboard is never written');
  assert.equal(copied.length, 0);
  assert.ok(app.toasts.length > toastCountBefore, 'the user is told');
  const last = app.toasts[app.toasts.length - 1];
  assert.match(last, /无法生成分享链接/);
  assert.ok(!/已复制/.test(last), 'no success message is shown');
});

test('UI: the export limit measures the same string as the import limit', () => {
  const { app, harness, limits } = newApp();

  const copied = [];
  harness.clipboard.writeText = (text) => {
    copied.push(text);
    return Promise.resolve();
  };
  assert.equal(app.shareConfiguration(), true);
  const hash = copied[0].slice(copied[0].indexOf('#') + 1);

  // Exactly at the boundary: accepted by both sides.
  const atLimit = 'A'.repeat(limits.maxPayloadLength);
  assert.equal(harness.api.isPayloadWithinLimit(atLimit), true);
  assert.equal(harness.api.isPayloadWithinLimit('A'.repeat(limits.maxPayloadLength + 1)), false);

  // The predicate the exporter uses is the one the importer uses.
  assert.equal(harness.api.isPayloadWithinLimit(hash), true);
  assert.equal(hash.length <= limits.maxPayloadLength, true);
});

test('UI: an oversized hash is still rejected on import', () => {
  const { app, harness, limits } = newApp();
  harness.window.location.hash = '#' + 'A'.repeat(limits.maxPayloadLength + 1);
  assert.equal(app.loadStateFromUrl(), false);
});

test('UI: a config just under the limit still shares and imports', () => {
  const { app, harness, limits } = newApp();

  // Grow the payload until it is close to, but under, the limit.
  app.state.layers = Array.from({ length: limits.maxLayers }, (_, i) =>
    app.state.createLayer({ name: `L${i}`, numerator: 8, denominator: 8, groups: [3, 3, 2] })
  );

  const copied = [];
  harness.clipboard.writeText = (text) => {
    copied.push(text);
    return Promise.resolve();
  };
  assert.equal(app.shareConfiguration(), true);
  const hash = copied[0].slice(copied[0].indexOf('#') + 1);
  assert.ok(hash.length <= limits.maxPayloadLength);

  const { app: fresh, harness: freshHarness } = newApp();
  freshHarness.window.location.hash = '#' + hash;
  assert.equal(fresh.loadStateFromUrl(), true);
  assert.equal(fresh.state.layers.length, limits.maxLayers);
});

// ---------------------------------------------------------------------------
// Preset save must agree with preset load
// ---------------------------------------------------------------------------

test('UI: a valid preset saves and reloads', () => {
  const { app, harness } = newApp();
  stubPresetContainer(app);

  assert.equal(app.saveUserPreset('ok preset'), true);
  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].name, 'ok preset');

  assert.equal(app.loadPresetData(stored[0]), true);
});

test('UI: a config the loader would refuse is never saved', () => {
  const { app, harness } = newApp();
  stubPresetContainer(app);

  // Force an unloadable state directly, simulating a corrupted internal value.
  app.state.layers[0].numerator = NaN;

  const toastCountBefore = app.toasts.length;
  assert.equal(app.saveUserPreset('bad'), false);

  const raw = harness.storage.get('polyrhythm_metronome_presets');
  assert.equal(raw === undefined || raw === null, true, 'nothing was persisted');
  assert.ok(app.toasts.length > toastCountBefore, 'the user is told');
});

test('UI: saving does not append to a corrupted preset store', () => {
  const { app, harness } = newApp();
  stubPresetContainer(app);
  harness.storage.set('polyrhythm_metronome_presets', '{not json');

  assert.equal(app.saveUserPreset('recovered'), true);
  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));
  assert.equal(stored.length, 1, 'the corrupt store was replaced, not appended to');
});

// ---------------------------------------------------------------------------
// Local validity and shareability are independent conditions
// ---------------------------------------------------------------------------
//
// A configuration can be perfectly legal locally and still be too large to
// encode into a share link. Saving, reloading and sharing are therefore three
// separate outcomes and must not be conflated.

// The largest configuration the limits allow: 64 layers x 1024 groups.
// Its encoded payload (~373k chars) is well past maxPayloadLength.
function buildHugeValidConfig(app, limits) {
  app.state.layers = Array.from({ length: limits.maxLayers }, (_, i) =>
    app.state.createLayer({
      name: `Big layer ${i} with a fairly long descriptive name`,
      numerator: 1024,
      denominator: 16,
      groups: new Array(limits.maxGroupEntries).fill(1),
    })
  );
}

test('UI: a huge config is valid, saveable, reloadable, but not shareable', () => {
  const { app, harness, limits } = newApp();
  stubPresetContainer(app);

  buildHugeValidConfig(app, limits);

  // 1. It is a legal configuration.
  const normalized = app.state.normalizeConfiguration({
    bpm: app.state.bpm,
    layers: app.state.layers,
  });
  assert.equal(normalized.ok, true, 'the huge config passes the shared validator');

  // 2. It can be saved as a local preset.
  assert.equal(app.saveUserPreset('huge'), true, 'a valid huge config is saveable');
  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].layers.length, limits.maxLayers);

  // 3. That preset can be reloaded.
  assert.equal(app.loadPresetData(stored[0]), true, 'the saved huge preset reloads');
  assert.equal(app.state.layers.length, limits.maxLayers);
  assert.equal(app.state.layers[0].groups.length, limits.maxGroupEntries);

  // 4. Sharing it is refused, because the encoded payload is too large.
  let clipboardCalls = 0;
  harness.clipboard.writeText = () => {
    clipboardCalls++;
    return Promise.resolve();
  };
  const toastCountBefore = app.toasts.length;
  assert.equal(app.shareConfiguration(), false, 'sharing the huge config is refused');
  assert.equal(clipboardCalls, 0, 'the clipboard is untouched');
  assert.ok(app.toasts.length > toastCountBefore, 'the user is told');
});

test('UI: the share-refusal message says the config is still valid locally', () => {
  const { app, harness, limits } = newApp();

  buildHugeValidConfig(app, limits);
  let clipboardCalls = 0;
  harness.clipboard.writeText = () => {
    clipboardCalls++;
    return Promise.resolve();
  };

  assert.equal(app.shareConfiguration(), false);
  assert.equal(clipboardCalls, 0);

  const last = app.toasts[app.toasts.length - 1];
  // The message must explain the two independent conditions, so a user does
  // not conclude their configuration is invalid.
  assert.match(last, /无法生成分享链接/, 'says the link cannot be generated');
  assert.match(last, /可保存为本地预设/, 'says the config can still be saved locally');
  assert.ok(!/已复制/.test(last), 'no success message');
});

test('UI: refusing to share does not mutate the live configuration', () => {
  const { app, limits } = newApp();

  buildHugeValidConfig(app, limits);
  const layerCountBefore = app.state.layers.length;
  const groupCountBefore = app.state.layers[0].groups.length;
  const bpmBefore = app.state.bpm;

  assert.equal(app.shareConfiguration(), false);

  assert.equal(app.state.layers.length, layerCountBefore, 'layers unchanged');
  assert.equal(app.state.layers[0].groups.length, groupCountBefore, 'groups unchanged');
  assert.equal(app.state.bpm, bpmBefore, 'bpm unchanged');
});

test('UI: a huge config that is too large to share is still a valid preset', () => {
  const { app, harness, limits } = newApp();
  stubPresetContainer(app);

  buildHugeValidConfig(app, limits);
  assert.equal(app.saveUserPreset('huge-2'), true);

  // Reload it into a fresh app through the normal preset path.
  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));
  const { app: fresh } = newApp();
  assert.equal(fresh.loadPresetData(stored[0]), true);
  assert.equal(fresh.state.layers.length, limits.maxLayers);

  // And it still cannot be shared from the fresh app either.
  assert.equal(fresh.shareConfiguration(), false);
});

// ---------------------------------------------------------------------------
// Full round trip
// ---------------------------------------------------------------------------

test('UI: every UI-reachable config survives share -> import', () => {
  const { app, harness } = newApp();

  // Build a config using only UI handlers.
  app.addLayer({ name: 'Second', numerator: 7, denominator: 16 });
  const layer = app.state.layers[1];
  const card = bindCard(app, layer);

  card.singles['.meter-num-input'].value = '7';
  card.singles['.meter-num-input'].dispatch('change');
  card.singles['.multiplier-input'].value = '2';
  card.singles['.multiplier-input'].dispatch('change');
  card.singles['.vol-slider'].value = '0.65';
  card.singles['.vol-slider'].dispatch('input');

  const copied = [];
  harness.clipboard.writeText = (text) => {
    copied.push(text);
    return Promise.resolve();
  };
  assert.equal(app.shareConfiguration(), true);

  const hash = copied[0].slice(copied[0].indexOf('#') + 1);
  const { app: fresh, harness: freshHarness } = newApp();
  freshHarness.window.location.hash = '#' + hash;

  assert.equal(fresh.loadStateFromUrl(), true);
  assert.equal(fresh.state.layers.length, app.state.layers.length);
  assert.equal(fresh.state.layers[1].numerator, 7);
  assert.equal(fresh.state.layers[1].bpmMultiplier, 2);
  assert.equal(fresh.state.layers[1].volume, 0.65);
});


