/**
 * Progressive layer rendering — large configurations must reach an
 * interactive state quickly by deferring per-layer detail DOM.
 *
 * These tests drive the real rendering methods (renderLayers, addLayer,
 * removeLayer, setLayerExpanded, bindLayerHeaderEvents, bindLayerDetailEvents)
 * against the harness DOM, so the shipped code is what is being measured.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

function newApp() {
  const harness = loadApp();
  const app = createApp(harness, { now: 0 });
  return { app, harness, limits: harness.api.METRONOME_LIMITS };
}

// 64 layers x 1024 groups: the largest configuration the limits allow.
function hugePreset(limits) {
  const layers = [];
  for (let i = 0; i < limits.maxLayers; i++) {
    layers.push({
      name: `Big ${i}`,
      numerator: limits.numerator.max,
      denominator: 16,
      bpmMultiplier: 1,
      groups: new Array(limits.maxGroupEntries).fill(1),
      overrides: {},
      sound: 'classic',
      volume: 0.8,
      accentVolume: 1.3,
      muted: false,
    });
  }
  return { name: 'huge', bpm: 120, layers };
}

const countCards = (app) => app.dom.layersList.querySelectorAll('.layer-card').length;
const countTags = (app) => app.dom.layersList.querySelectorAll('.group-tag').length;
const countCells = (app) => app.dom.layersList.querySelectorAll('.subdiv-cell').length;

// ---------------------------------------------------------------------------
// A. Large configuration initialisation
// ---------------------------------------------------------------------------

test('progressive: a 64x1024 config loads and stays valid', () => {
  const { app, limits } = newApp();
  const preset = hugePreset(limits);

  assert.equal(app.loadPresetData(preset), true);

  assert.equal(app.state.layers.length, 64);
  assert.equal(app.state.layers[0].groups.length, 1024);

  const normalized = app.state.normalizeConfiguration({
    bpm: app.state.bpm,
    layers: app.state.layers,
  });
  assert.equal(normalized.ok, true, 'the loaded config is still valid');
});

test('progressive: initial render does not build per-layer detail', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  assert.equal(countCards(app), 64, 'every layer has a card');

  // The expensive parts must NOT exist yet.
  assert.equal(countTags(app), 0, 'no group tags rendered initially');
  assert.equal(countCells(app), 0, 'no subdivision cells rendered initially');
});

test('progressive: every layer exposes its header controls while collapsed', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  for (const layer of app.state.layers) {
    const card = app.document.getElementById(layer.id);
    assert.ok(card, `card exists for ${layer.id}`);
    assert.ok(card.querySelector('.layer-name-input'), 'name input present');
    assert.ok(card.querySelector('.meter-num-input'), 'numerator input present');
    assert.ok(card.querySelector('.expand-btn'), 'expand control present');
    assert.equal(card.dataset.expanded, '0');
  }
});

test('progressive: collapsed cards still report their grouping state', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];
  const card = app.document.getElementById(layer.id);
  const summary = card.querySelector('.layer-summary');
  assert.ok(summary, 'summary element exists');
  // 1024 groups of 1, numerator 1024 -> sum matches.
  assert.match(summary.textContent, /1024 组/);
  assert.match(summary.textContent, /✓/);
});

test('progressive: unrendered content is still present in state', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  // Nothing is rendered, yet the data is complete.
  assert.equal(countTags(app), 0);
  const total = app.state.layers.reduce((sum, l) => sum + l.groups.length, 0);
  assert.equal(total, 65536, 'all 65,536 group entries exist in state');
});

// ---------------------------------------------------------------------------
// B. Deferred expansion
// ---------------------------------------------------------------------------

test('progressive: expanding a layer renders only that layer', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const target = app.state.layers[0];
  app.setLayerExpanded(target.id, true);

  // Only the expanded layer has any detail container at all.
  const cardsWithDetail = app.state.layers.filter((l) => {
    const card = app.document.getElementById(l.id);
    return card && card.querySelector('.layer-detail')
      && card.querySelector('.layer-detail').children.length > 0;
  });
  assert.equal(cardsWithDetail.length, 1, 'only the expanded layer has detail');
  assert.equal(cardsWithDetail[0].id, target.id);

  // And that detail is bounded, not one-to-one with the data.
  const tags = countTags(app);
  assert.ok(tags <= limits.maxGroupEntries, 'never more than the data');

  const card = app.document.getElementById(target.id);
  assert.equal(card.dataset.expanded, '1');

  // Other layers stay collapsed.
  const others = app.state.layers.filter((l) => l.id !== target.id);
  for (const other of others) {
    assert.equal(app.document.getElementById(other.id).dataset.expanded, '0');
  }
});

test('progressive: collapsing removes the detail DOM', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const target = app.state.layers[0];
  app.setLayerExpanded(target.id, true);
  const expandedNodes = countTags(app) + countCells(app);
  assert.ok(expandedNodes > 0);

  app.setLayerExpanded(target.id, false);

  assert.equal(countTags(app), 0, 'group tags removed');
  assert.equal(countCells(app), 0, 'subdivision cells removed');
  assert.equal(app.document.getElementById(target.id).dataset.expanded, '0');
});

test('progressive: re-expanding rebuilds from current state', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const target = app.state.layers[0];
  app.setLayerExpanded(target.id, true);

  // Mutate through the model while expanded, then collapse and expand again.
  target.groups[0] = 7;
  app.setLayerExpanded(target.id, false);
  app.setLayerExpanded(target.id, true);

  const card = app.document.getElementById(target.id);
  const firstVal = card.querySelector('.group-tag-val');
  assert.equal(String(firstVal.value), '7', 're-expanded detail reflects state');
});

test('progressive: expanding different layers keeps their data separate', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const a = app.state.layers[0];
  const b = app.state.layers[1];
  a.groups[0] = 5;
  b.groups[0] = 9;

  app.setLayerExpanded(a.id, true);
  assert.equal(String(app.document.getElementById(a.id).querySelector('.group-tag-val').value), '5');

  app.setLayerExpanded(b.id, true);
  assert.equal(String(app.document.getElementById(b.id).querySelector('.group-tag-val').value), '9');

  // Both remain expanded (no forced single-layer mode).
  assert.equal(app.document.getElementById(a.id).dataset.expanded, '1');
  assert.equal(app.document.getElementById(b.id).dataset.expanded, '1');
});

test('progressive: multiple layers can stay expanded at once', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  app.setLayerExpanded(app.state.layers[0].id, true);
  app.setLayerExpanded(app.state.layers[1].id, true);
  app.setLayerExpanded(app.state.layers[2].id, true);

  // Three layers hold detail simultaneously: expansion is not forced to one.
  const expanded = app.state.layers.filter(
    (l) => app.document.getElementById(l.id).dataset.expanded === '1'
  );
  assert.equal(expanded.length, 3);

  // Each mounts its own bounded window; totals stay far below 3 x 1024.
  assert.ok(countTags(app) > 0);
  assert.ok(countTags(app) < 3 * 1024, 'mounting is windowed per layer');
});

// ---------------------------------------------------------------------------
// C. State retention across collapse / expand
// ---------------------------------------------------------------------------

test('progressive: group edit survives collapse and re-expand', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const card = app.document.getElementById(layer.id);
  const input = card.querySelector('.group-tag-val');
  input.value = '42';
  input.dispatchEvent({ type: 'change', target: input });

  assert.equal(layer.groups[0], 42, 'state updated by the delegated handler');

  app.setLayerExpanded(layer.id, false);
  assert.equal(layer.groups[0], 42, 'collapse does not touch beat data');

  app.setLayerExpanded(layer.id, true);
  const reopened = app.document.getElementById(layer.id).querySelector('.group-tag-val');
  assert.equal(String(reopened.value), '42');
});

test('progressive: pattern edit survives collapse and re-expand', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const card = app.document.getElementById(layer.id);
  const cell = card.querySelector('.subdiv-cell');
  cell.dispatchEvent({ type: 'click', target: cell, closest: () => cell });

  const assigned = layer.overrides[0];
  assert.ok(assigned, 'override recorded from the pattern click');

  app.setLayerExpanded(layer.id, false);
  app.setLayerExpanded(layer.id, true);

  const reopened = app.document.getElementById(layer.id).querySelector('.subdiv-cell');
  assert.equal(reopened.className, `subdiv-cell ${assigned}`, 'pattern restored from state');
});

test('progressive: layer name survives collapse and re-expand', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];
  const card = app.document.getElementById(layer.id);
  const nameInput = card.querySelector('.layer-name-input');
  nameInput.value = 'Renamed';
  nameInput.dispatchEvent({ type: 'change', target: nameInput });

  assert.equal(layer.name, 'Renamed');

  app.setLayerExpanded(layer.id, true);
  app.setLayerExpanded(layer.id, false);

  // Header is not rebuilt by collapse, so the value must simply persist.
  assert.equal(layer.name, 'Renamed');
  assert.equal(String(app.document.getElementById(layer.id)
    .querySelector('.layer-name-input').value), 'Renamed');
});

test('progressive: muted state is independent of expansion', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];
  const card = app.document.getElementById(layer.id);
  const muteBtn = card.querySelector('.mute-btn');
  muteBtn.dispatchEvent({ type: 'click', target: muteBtn });

  assert.equal(layer.muted, true);
  app.setLayerExpanded(layer.id, true);
  app.setLayerExpanded(layer.id, false);
  assert.equal(layer.muted, true);
});

// ---------------------------------------------------------------------------
// D. Local updates
// ---------------------------------------------------------------------------

test('progressive: editing one layer does not rebuild the others', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const edited = app.state.layers[0];
  const untouched = app.state.layers[1];

  const untouchedCardBefore = app.document.getElementById(untouched.id);
  const rendersBefore = app.renderCount;

  app.setLayerExpanded(edited.id, true);
  const card = app.document.getElementById(edited.id);
  const input = card.querySelector('.group-tag-val');
  input.value = '3';
  input.dispatchEvent({ type: 'change', target: input });

  // A full list rebuild would replace every card element.
  assert.equal(app.document.getElementById(untouched.id), untouchedCardBefore,
    'the untouched layer keeps the same DOM node');
  assert.equal(app.renderCount, rendersBefore, 'no full re-render was triggered');
  assert.equal(edited.groups[0], 3);
});

test('progressive: a group edit updates the summary in place', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const card = app.document.getElementById(layer.id);
  const summaryBefore = card.querySelector('.layer-summary').textContent;

  const input = card.querySelector('.group-tag-val');
  input.value = '5';
  input.dispatchEvent({ type: 'change', target: input });

  const summaryAfter = card.querySelector('.layer-summary').textContent;
  assert.notEqual(summaryAfter, summaryBefore, 'summary reflects the new sum');
  assert.match(summaryAfter, new RegExp(`和 ${layer.groups.reduce((a, b) => a + b, 0)}`));
});

test('progressive: delegated handlers survive repeated re-renders', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];

  for (let round = 0; round < 3; round++) {
    app.setLayerExpanded(layer.id, true);
    const card = app.document.getElementById(layer.id);
    const input = card.querySelector('.group-tag-val');
    input.value = String(round + 2);
    input.dispatchEvent({ type: 'change', target: input });
    assert.equal(layer.groups[0], round + 2, `round ${round} edit applied`);
    app.setLayerExpanded(layer.id, false);
  }
});

test('progressive: non-expanded layer exposes no detail handlers that fire', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const layer = app.state.layers[0];
  const card = app.document.getElementById(layer.id);

  // Detail is empty, so these queries find nothing.
  assert.equal(card.querySelector('.group-tag-val'), null);
  assert.equal(card.querySelector('.subdiv-cell'), null);
  assert.equal(card.querySelector('.add-group-btn'), null);
});

// ---------------------------------------------------------------------------
// E. Presets and sharing regression
// ---------------------------------------------------------------------------

test('progressive: a huge config saves as a preset with full data', () => {
  const { app, harness, limits } = newApp();
  app.dom.userPresets = { innerHTML: '', appendChild: () => {} };
  app.renderUserPresets = () => {};
  app.loadPresetData(hugePreset(limits));

  assert.equal(app.saveUserPreset('huge'), true);

  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].layers.length, 64, 'all layers saved');
  // Collapsed layers must still save their complete grouping.
  assert.equal(stored[0].layers[0].groups.length, 1024, 'collapsed layer saved in full');
});

test('progressive: a huge preset reloads with full data', () => {
  const { app, harness, limits } = newApp();
  app.dom.userPresets = { innerHTML: '', appendChild: () => {} };
  app.renderUserPresets = () => {};
  app.loadPresetData(hugePreset(limits));
  app.saveUserPreset('huge');
  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));

  const { app: fresh } = newApp();
  assert.equal(fresh.loadPresetData(stored[0]), true);
  assert.equal(fresh.state.layers.length, 64);
  assert.equal(fresh.state.layers[0].groups.length, 1024);
  assert.equal(countCells(fresh), 0, 'and it loads collapsed again');
});

test('progressive: expansion state does not change the share payload', () => {
  const { app, harness, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const copied = [];
  harness.clipboard.writeText = (t) => { copied.push(t); return Promise.resolve(); };

  // Share while everything is collapsed -> over the limit, refused.
  assert.equal(app.shareConfiguration(), false);

  // Expand a few layers; the payload is unchanged, so still refused.
  app.setLayerExpanded(app.state.layers[0].id, true);
  app.setLayerExpanded(app.state.layers[1].id, true);
  assert.equal(app.shareConfiguration(), false);
  assert.equal(copied.length, 0, 'clipboard still untouched');
});

test('progressive: a small config still shares and re-imports', () => {
  const { app, harness } = newApp();
  app.state.layers = [
    app.state.createLayer({ name: 'Small', numerator: 7, denominator: 8, groups: [3, 2, 2] }),
  ];
  app.applyInitialExpansionState();
  app.renderAll();

  const copied = [];
  harness.clipboard.writeText = (t) => { copied.push(t); return Promise.resolve(); };
  assert.equal(app.shareConfiguration(), true);

  const hash = copied[0].slice(copied[0].indexOf('#') + 1);
  const { app: fresh, harness: freshHarness } = newApp();
  freshHarness.window.location.hash = '#' + hash;
  assert.equal(fresh.loadStateFromUrl(), true);
  assert.equal(fresh.state.layers[0].numerator, 7);
  assert.deepEqual(list(fresh.state.layers[0].groups), [3, 2, 2]);
});

// ---------------------------------------------------------------------------
// F. Playback regression
// ---------------------------------------------------------------------------

test('progressive: a large config starts playing normally', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  app.startPlayback();
  assert.equal(app.state.isPlaying, true);
  assert.equal(app.state.isPaused, false);

  app.scheduler();
  assert.ok(app.state.visualQueue.length > 0, 'scheduling works while collapsed');
});

test('progressive: expanding during playback does not disturb the transport', () => {
  const { app, limits, harness } = newApp();
  app.loadPresetData(hugePreset(limits));

  app.startPlayback();
  const intervalsAfterStart = harness.getActiveIntervals();
  assert.equal(intervalsAfterStart, 1);

  app.scheduler();
  const nextTimesBefore = list(app.state.layers).map((l) => l.nextNoteTime);

  app.setLayerExpanded(app.state.layers[0].id, true);
  app.setLayerExpanded(app.state.layers[1].id, true);
  app.setLayerExpanded(app.state.layers[0].id, false);

  assert.equal(app.state.isPlaying, true, 'still playing');
  assert.equal(app.state.isPaused, false);
  assert.equal(harness.getActiveIntervals(), 1, 'no extra scheduler interval');
  assert.equal(app.audioEngine.timerId !== null, true, 'timer still set');

  // Expansion must not re-anchor the audio timeline.
  const nextTimesAfter = list(app.state.layers).map((l) => l.nextNoteTime);
  assert.deepEqual(nextTimesAfter, nextTimesBefore, 'expansion does not touch nextNoteTime');
});

test('progressive: collapsing during playback keeps queue and position', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  app.startPlayback();
  app.scheduler();

  const queueBefore = app.state.visualQueue.length;
  app.setLayerExpanded(app.state.layers[0].id, true);
  app.setLayerExpanded(app.state.layers[0].id, false);

  assert.equal(app.state.visualQueue.length, queueBefore, 'visual queue untouched');
  assert.equal(app.state.isPlaying, true);
});

// ---------------------------------------------------------------------------
// Layer add / remove under progressive rendering
// ---------------------------------------------------------------------------

test('progressive: adding a layer renders only the new card', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  // At the layer cap, so make room first: the test is about how a successful
  // add renders, not about the cap (that is covered elsewhere).
  app.removeLayer(app.state.layers[0].id);

  const rendersBefore = app.renderCount;
  const cardsBefore = countCards(app);

  assert.equal(app.addLayer({ name: 'New', numerator: 4, denominator: 4 }), true);

  assert.equal(countCards(app), cardsBefore + 1);
  assert.equal(app.renderCount, rendersBefore, 'no full list rebuild');

  const added = app.state.layers[app.state.layers.length - 1];
  const card = app.document.getElementById(added.id);
  assert.ok(card, 'the new card is in the DOM');
  assert.equal(card.dataset.expanded, '1', 'a new layer opens expanded');
});

test('progressive: removing a layer drops its card and expansion entry', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  const doomed = app.state.layers[2];
  app.setLayerExpanded(doomed.id, true);
  assert.ok(app.expandedLayerIds.has(doomed.id));

  const cardsBefore = countCards(app);
  app.removeLayer(doomed.id);

  assert.equal(countCards(app), cardsBefore - 1);
  assert.equal(app.document.getElementById(doomed.id), null, 'card element gone');
  assert.equal(app.expandedLayerIds.has(doomed.id), false, 'expansion entry cleaned up');
  assert.equal(app.state.layers.length, 63);
});

test('progressive: layer indexes are renumbered after a removal', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  app.removeLayer(app.state.layers[0].id);

  const firstCard = app.document.getElementById(app.state.layers[0].id);
  const tag = firstCard.querySelector('.layer-tag');
  assert.equal(tag.textContent, '#1', 'the new first layer is numbered #1');
});

// ---------------------------------------------------------------------------
// Collapse policy
// ---------------------------------------------------------------------------

test('progressive: small configurations keep the historical expanded default', () => {
  const { app } = newApp();
  app.state.layers = [
    app.state.createLayer({ name: 'A', numerator: 7, denominator: 8 }),
    app.state.createLayer({ name: 'B', numerator: 4, denominator: 4 }),
  ];
  app.applyInitialExpansionState();

  for (const layer of app.state.layers) {
    assert.equal(app.isLayerExpanded(layer.id), true, 'small config stays expanded');
  }
});

test('progressive: many layers start collapsed', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  for (const layer of app.state.layers) {
    assert.equal(app.isLayerExpanded(layer.id), false);
  }
});

test('progressive: a single very dense layer starts collapsed', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'Dense', numerator: 1024, denominator: 16 })];
  app.applyInitialExpansionState();

  assert.equal(app.isLayerExpanded(app.state.layers[0].id), false,
    'a single 1024-subdivision layer is dense enough to collapse');
});

test('progressive: the collapse thresholds are centrally defined', () => {
  const harness = loadApp();
  const policy = harness.api.LAYER_RENDER_POLICY;
  assert.ok(policy, 'policy object is exported');
  assert.equal(typeof policy.autoCollapseLayerCount, 'number');
  assert.equal(typeof policy.autoCollapseTotalSubdivisions, 'number');
  assert.equal(typeof policy.autoCollapseLayerSubdivisions, 'number');
});

test('progressive: loading a small preset re-expands even after a huge one', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));
  assert.equal(app.isLayerExpanded(app.state.layers[0].id), false);

  const small = app.factoryPresetsData && app.factoryPresetsData[0];
  app.loadPresetData({ name: 'small', bpm: 120, layers: [{ name: 'S', numerator: 4, denominator: 4 }] });

  assert.equal(app.state.layers.length, 1);
  assert.equal(app.isLayerExpanded(app.state.layers[0].id), true,
    'a small config is expanded again');
});
