/**
 * Virtualisation — window maths, group-tag mounting, pattern-cell mounting,
 * playback decoupling and DOM-count guarantees.
 *
 * The DOM assertions run against the harness DOM (a real tree with the same
 * shape the browser sees). Window arithmetic is tested as pure functions so
 * the boundary cases do not depend on layout at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

function newApp(options = {}) {
  const harness = loadApp();
  const app = createApp(harness, { now: 0, ...options });
  return { app, harness, limits: harness.api.METRONOME_LIMITS, api: harness.api };
}

function hugePreset(limits, layerCount) {
  const layers = [];
  const n = layerCount === undefined ? limits.maxLayers : layerCount;
  for (let i = 0; i < n; i++) {
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

const countTags = (app) => app.dom.layersList.querySelectorAll('.group-tag').length;
const countCells = (app) => app.dom.layersList.querySelectorAll('.subdiv-cell').length;
const countAll = (app) => app.dom.layersList.querySelectorAll('*').length;

// ---------------------------------------------------------------------------
// A. Window maths (pure functions)
// ---------------------------------------------------------------------------

function w(api, args) {
  return api.computeWindow(args);
}

test('window: first items are visible at offset 0', () => {
  const { api } = newApp();
  const r = w(api, { total: 1000, viewportSize: 300, itemSize: 30, overscan: 0 });
  assert.equal(r.start, 0);
  assert.ok(r.end >= 10, 'about a viewport worth of items');
  assert.equal(r.before, 0);
});

test('window: last items are visible at the maximum offset', () => {
  const { api } = newApp();
  const total = 1000;
  const itemSize = 30;
  const viewport = 300;
  const maxOffset = total * itemSize - viewport;
  const r = w(api, { total, viewportSize: viewport, itemSize, scrollOffset: maxOffset, overscan: 0 });
  assert.equal(r.end, total, 'reaches the final item');
  assert.equal(r.after, 0, 'no spacer after the end');
  assert.ok(r.start > 0);
});

test('window: a middle slice neither starts at 0 nor ends at total', () => {
  const { api } = newApp();
  const r = w(api, { total: 1000, viewportSize: 300, itemSize: 30, scrollOffset: 30 * 500, overscan: 0 });
  assert.ok(r.start > 0);
  assert.ok(r.end < 1000);
  assert.ok(r.before > 0 && r.after > 0);
});

test('window: empty data mounts nothing', () => {
  const { api } = newApp();
  const r = w(api, { total: 0, viewportSize: 300, itemSize: 30 });
  assert.deepEqual({ start: r.start, end: r.end, before: r.before, after: r.after },
    { start: 0, end: 0, before: 0, after: 0 });
});

test('window: a single item mounts exactly that item', () => {
  const { api } = newApp();
  const r = w(api, { total: 1, viewportSize: 300, itemSize: 30 });
  assert.equal(r.start, 0);
  assert.equal(r.end, 1);
  assert.equal(r.before, 0);
  assert.equal(r.after, 0);
});

test('window: overscan never produces negative indexes', () => {
  const { api } = newApp();
  const r = w(api, { total: 100, viewportSize: 300, itemSize: 30, scrollOffset: 0, overscan: 50 });
  assert.equal(r.start, 0, 'clamped at the top');
  assert.ok(r.before >= 0);
});

test('window: overscan never exceeds the data at the bottom', () => {
  const { api } = newApp();
  const r = w(api, { total: 100, viewportSize: 300, itemSize: 30, scrollOffset: 30 * 95, overscan: 50 });
  assert.equal(r.end, 100, 'clamped at the end');
  assert.equal(r.after, 0);
});

test('window: scrolling forward moves the window forward', () => {
  const { api } = newApp();
  const a = w(api, { total: 2000, viewportSize: 300, itemSize: 30, scrollOffset: 0 });
  const b = w(api, { total: 2000, viewportSize: 300, itemSize: 30, scrollOffset: 30 * 200 });
  assert.ok(b.start > a.start);
  assert.ok(b.end > a.end);
});

test('window: a taller viewport mounts more items', () => {
  const { api } = newApp();
  const small = w(api, { total: 5000, viewportSize: 200, itemSize: 30 });
  const large = w(api, { total: 5000, viewportSize: 800, itemSize: 30 });
  assert.ok(large.end - large.start > small.end - small.start);
});

test('window: more data does not enlarge the mounted slice', () => {
  const { api } = newApp();
  const a = w(api, { total: 500, viewportSize: 300, itemSize: 30 });
  const b = w(api, { total: 50000, viewportSize: 300, itemSize: 30 });
  assert.equal(b.end - b.start, a.end - a.start, 'mount count is viewport-bound');
});

test('window: invalid geometry falls back to mounting everything', () => {
  const { api } = newApp();
  for (const bad of [0, -10, NaN, Infinity]) {
    const r = w(api, { total: 50, viewportSize: bad, itemSize: 30 });
    assert.equal(r.start, 0);
    assert.equal(r.end, 50, `viewport ${bad} must not hide data`);
  }
});

test('window: invalid item size falls back to mounting everything', () => {
  const { api } = newApp();
  for (const bad of [0, -1, NaN]) {
    const r = w(api, { total: 50, viewportSize: 300, itemSize: bad });
    assert.equal(r.start, 0);
    assert.equal(r.end, 50);
  }
});

test('window: non-numeric total is treated as empty', () => {
  const { api } = newApp();
  for (const bad of [NaN, undefined, null, 'abc']) {
    const r = w(api, { total: bad, viewportSize: 300, itemSize: 30 });
    assert.equal(r.end, 0);
  }
});

test('window: start never exceeds end', () => {
  const { api } = newApp();
  for (const offset of [0, 1e9, -1e9]) {
    const r = w(api, { total: 100, viewportSize: 300, itemSize: 30, scrollOffset: offset, overscan: 10 });
    assert.ok(r.start <= r.end, `offset ${offset}`);
  }
});

test('window: spacers always account for the whole list', () => {
  const { api } = newApp();
  for (const offset of [0, 500, 2000, 2900]) {
    const r = w(api, { total: 100, viewportSize: 300, itemSize: 30, scrollOffset: offset, overscan: 3 });
    assert.equal(r.before + (r.end - r.start) + r.after, 100, `geometry complete at ${offset}`);
  }
});

test('range: visible range for page-flow lists', () => {
  const { api } = newApp();
  // The list starts 500px below the fold; the first 500px are off-screen.
  const r = api.computeVisibleRange({
    total: 1000,
    viewportStart: -500,
    viewportEnd: 300,
    itemSize: 30,
    overscan: 0,
  });
  assert.ok(r.start >= 0);
  assert.ok(r.end > r.start);
});

test('range: unknown geometry mounts a bounded opening window, not everything', () => {
  const { api } = newApp();
  const r = api.computeVisibleRange({
    total: 5000,
    viewportStart: null,
    viewportEnd: null,
    itemSize: 30,
    minItems: 24,
  });
  assert.equal(r.start, 0);
  assert.ok(r.end >= 24);
  assert.ok(r.end < 5000, 'must not mount the entire list');
});

test('range: maxMount caps the mounted slice', () => {
  const { api } = newApp();
  const r = api.computeVisibleRange({
    total: 10000,
    viewportStart: 0,
    viewportEnd: 100000, // absurd viewport
    itemSize: 10,
    overscan: 0,
    maxMount: 100,
  });
  assert.ok(r.end - r.start <= 100);
});

test('effective: small lists are not virtualised', () => {
  const { api } = newApp();
  const win = { start: 10, end: 20, before: 10, after: 0 };
  const eff = api.computeEffectiveWindow(50, win, 120);
  assert.equal(eff.virtualized, false);
  assert.equal(eff.start, 0);
  assert.equal(eff.end, 50, 'everything mounts below the threshold');
});

test('effective: large lists are virtualised', () => {
  const { api } = newApp();
  const win = { start: 100, end: 140, before: 100, after: 860 };
  const eff = api.computeEffectiveWindow(1000, win, 120);
  assert.equal(eff.virtualized, true);
  assert.equal(eff.start, 100);
  assert.equal(eff.end, 140);
});

// ---------------------------------------------------------------------------
// B. Group virtualisation
// ---------------------------------------------------------------------------

test('groups: 1024 groups are not all mounted at once', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  app.setLayerExpanded(app.state.layers[0].id, true);

  assert.equal(app.state.layers[0].groups.length, 1024, 'data is complete');
  assert.ok(countTags(app) > 0, 'some tags are mounted');
  assert.ok(countTags(app) < 1024, 'but not all of them');
});

test('groups: the mounted range is contiguous and index-ordered', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  app.setLayerExpanded(app.state.layers[0].id, true);

  const idx = list(app.dom.layersList.querySelectorAll('.group-tag'))
    .map((el) => parseInt(el.dataset.gidx, 10));
  assert.ok(idx.length > 0);
  for (let i = 1; i < idx.length; i++) {
    assert.equal(idx[i], idx[i - 1] + 1, 'no gaps or duplicates');
  }
});

test('groups: the first mount starts at index 0 for a scrolled-to-top layer', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  app.setLayerExpanded(app.state.layers[0].id, true);

  const first = app.dom.layersList.querySelector('.group-tag');
  assert.equal(parseInt(first.dataset.gidx, 10), 0);
});

test('groups: a small list mounts everything (no virtualisation overhead)', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'S', numerator: 12, denominator: 8, groups: [3, 3, 2, 4] })];
  app.applyInitialExpansionState();
  app.renderAll();

  assert.equal(countTags(app), 4);
});

test('groups: shrinking the data shrinks the mount', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const before = countTags(app);

  layer.groups = [4];
  app.refreshLayerDetail(layer);

  assert.ok(countTags(app) < before);
  assert.equal(countTags(app), 1);
});

test('groups: growing the data keeps the mount bounded', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  layer.groups = [4];
  app.setLayerExpanded(layer.id, true);
  assert.equal(countTags(app), 1);

  layer.groups = new Array(1024).fill(1);
  app.refreshLayerDetail(layer);

  assert.ok(countTags(app) > 1);
  assert.ok(countTags(app) < 1024);
});

test('groups: each expanded layer keeps its own window', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 3));
  const [a, b] = app.state.layers;

  a.groups[0] = 5;
  b.groups[0] = 9;

  app.setLayerExpanded(a.id, true);
  app.setLayerExpanded(b.id, true);

  const tagsA = app.document.getElementById(a.id).querySelectorAll('.group-tag');
  const tagsB = app.document.getElementById(b.id).querySelectorAll('.group-tag');

  assert.equal(String(tagsA[0].querySelector('.group-tag-val').value), '5');
  assert.equal(String(tagsB[0].querySelector('.group-tag-val').value), '9');
});

test('groups: editing a group value writes the original index', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const tag = app.dom.layersList.querySelectorAll('.group-tag')[0];
  const idx = parseInt(tag.dataset.gidx, 10);
  const input = tag.querySelector('.group-tag-val');
  input.value = '7';
  input.dispatchEvent({ type: 'change' });

  assert.equal(layer.groups[idx], 7, 'state received the edit at the right index');
});

// ---------------------------------------------------------------------------
// C. Pattern virtualisation
// ---------------------------------------------------------------------------

test('cells: a 1024-beat layer does not mount every cell', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  app.setLayerExpanded(app.state.layers[0].id, true);

  assert.equal(app.state.layers[0].numerator, 1024, 'data is complete');
  assert.ok(countCells(app) > 0);
  assert.ok(countCells(app) < 1024, 'cells are windowed');
});

test('cells: mounted data-index values are contiguous', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  app.setLayerExpanded(app.state.layers[0].id, true);

  const idx = list(app.dom.layersList.querySelectorAll('.subdiv-cell'))
    .map((el) => parseInt(el.dataset.index, 10));
  assert.ok(idx.length > 0);
  for (let i = 1; i < idx.length; i++) {
    assert.equal(idx[i], idx[i - 1] + 1);
  }
});

test('cells: clicking a mounted cell edits the correct original index', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const cell = app.dom.layersList.querySelectorAll('.subdiv-cell')[3];
  const index = parseInt(cell.dataset.index, 10);
  assert.ok(Number.isInteger(index));

  const before = app.state.getBeatType(layer, index);
  cell.dispatchEvent({ type: 'click' });

  const after = app.state.getBeatType(layer, index);
  assert.notEqual(after, before, 'the click cycled this beat');
  assert.equal(layer.overrides[index], after, 'override stored at the right index');
});

test('cells: pattern data survives when the cell is not mounted', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  // Set an override on an index that the current window may not include.
  layer.overrides[900] = 'mute';
  assert.equal(app.state.getBeatType(layer, 900), 'mute');

  // Remount the window: the unmounted beat is still correct in state.
  app.refreshLayerVirtualWindows(layer.id);
  assert.equal(app.state.getBeatType(layer, 900), 'mute');
});

test('cells: remounting shows the current pattern for mounted cells', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  layer.overrides[0] = 'mute';
  app.refreshLayerVirtualWindows(layer.id);

  const cell = app.dom.layersList.querySelector('.subdiv-cell');
  assert.equal(parseInt(cell.dataset.index, 10), 0);
  assert.match(cell.className, /mute/);
});

test('cells: small layers keep full cells without virtualisation', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'S', numerator: 8, denominator: 8 })];
  app.applyInitialExpansionState();
  app.renderAll();

  assert.equal(countCells(app), 8);
});

// ---------------------------------------------------------------------------
// D. Playback decoupling
// ---------------------------------------------------------------------------

test('playback: highlighting an unmounted cell does not throw', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  app.setLayerExpanded(app.state.layers[0].id, true);

  const layer = app.state.layers[0];
  // This index is far outside any mounted window.
  assert.doesNotThrow(() => app.highlightBeat(layer.id, 1000));
});

test('playback: highlight records the position even when unmounted', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  app.setLayerExpanded(app.state.layers[0].id, true);

  const layer = app.state.layers[0];
  app.highlightBeat(layer.id, 1000);

  assert.equal(app.currentPlayhead.get(layer.id), 1000);
});

test('playback: a freshly mounted cell inherits the current playhead', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  app.state.isPlaying = true;
  app.highlightBeat(layer.id, 0);
  assert.ok(app.currentPlayhead.has(layer.id));

  // Remount: the mounted window includes index 0, which must be highlighted.
  app.refreshLayerVirtualWindows(layer.id);
  const cell = app.dom.layersList.querySelector('.subdiv-cell[data-index="0"]');
  assert.ok(cell, 'cell 0 is mounted');
  assert.match(cell.className, /active-playhead/);
});

test('playback: only one cell per layer carries the playhead after remount', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  app.state.isPlaying = true;
  app.highlightBeat(layer.id, 5);
  app.refreshLayerVirtualWindows(layer.id);

  const marks = app.dom.layersList.querySelectorAll('.subdiv-cell.active-playhead');
  assert.equal(marks.length, 1);
});

test('playback: the scheduler does not depend on mounted cells', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1)); // collapsed: nothing mounted
  assert.equal(countCells(app), 0);

  app.startPlayback();
  assert.doesNotThrow(() => app.scheduler());
  assert.ok(app.state.visualQueue.length > 0, 'scheduling works with no cells mounted');
});

test('playback: expanding during playback keeps the audio timeline', () => {
  const { app, limits, harness } = newApp();
  app.loadPresetData(hugePreset(limits, 3));
  const layer = app.state.layers[0];

  app.startPlayback();
  app.scheduler();
  const nextBefore = layer.nextNoteTime;
  const intervalsBefore = harness.getActiveIntervals();

  app.setLayerExpanded(layer.id, true);
  app.refreshLayerVirtualWindows(layer.id);

  assert.equal(layer.nextNoteTime, nextBefore, 'timeline untouched');
  assert.equal(harness.getActiveIntervals(), intervalsBefore);
  assert.equal(app.state.isPlaying, true);
});

// ---------------------------------------------------------------------------
// E. Data integrity
// ---------------------------------------------------------------------------

test('integrity: a huge config saves complete data', () => {
  const { app, harness, limits } = newApp();
  app.dom.userPresets = { innerHTML: '', appendChild: () => {} };
  app.renderUserPresets = () => {};
  app.loadPresetData(hugePreset(limits));

  app.setLayerExpanded(app.state.layers[0].id, true);
  assert.ok(countTags(app) < 1024, 'the DOM is only partially mounted');

  assert.equal(app.saveUserPreset('huge'), true);
  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));

  assert.equal(stored[0].layers.length, 64);
  for (const layer of stored[0].layers) {
    assert.equal(layer.groups.length, 1024, 'every group saved, not just mounted ones');
  }
});

test('integrity: a huge preset reloads with identical contents', () => {
  const { app, harness, limits } = newApp();
  app.dom.userPresets = { innerHTML: '', appendChild: () => {} };
  app.renderUserPresets = () => {};
  app.loadPresetData(hugePreset(limits));
  app.state.layers[2].groups[5] = 11;
  app.state.layers[2].overrides[7] = 'mute';
  app.saveUserPreset('huge');

  const stored = JSON.parse(harness.storage.get('polyrhythm_metronome_presets'));
  const { app: fresh } = newApp();
  assert.equal(fresh.loadPresetData(stored[0]), true);

  assert.equal(fresh.state.layers.length, 64);
  assert.equal(fresh.state.layers[2].groups[5], 11);
  assert.equal(fresh.state.layers[2].overrides[7], 'mute');
});

test('integrity: the share payload ignores what is mounted', () => {
  const { app, limits } = newApp();
  app.state.layers = [
    app.state.createLayer({ name: 'T', numerator: 7, denominator: 8, groups: [3, 2, 2] }),
  ];
  app.applyInitialExpansionState();
  app.renderAll();
  const layer = app.state.layers[0];

  const payloadFor = () => JSON.stringify({
    bpm: app.state.bpm,
    layers: app.state.layers.map((l) => ({
      n: l.name, num: l.numerator, den: l.denominator, mul: l.bpmMultiplier,
      g: l.groups, ov: l.overrides, snd: l.sound, vol: l.volume, av: l.accentVolume, m: l.muted,
    })),
  });

  const expanded = payloadFor();
  app.setLayerExpanded(layer.id, false);
  const collapsed = payloadFor();
  app.setLayerExpanded(layer.id, true);
  const reExpanded = payloadFor();

  assert.equal(collapsed, expanded);
  assert.equal(reExpanded, expanded);
});

test('integrity: scroll-style remounts do not alter configuration', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 2));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const snapshot = JSON.stringify(app.state.layers.map((l) => l.groups));
  for (let i = 0; i < 5; i++) {
    app.refreshLayerVirtualWindows(layer.id);
  }
  assert.equal(JSON.stringify(app.state.layers.map((l) => l.groups)), snapshot);
});

// ---------------------------------------------------------------------------
// F. DOM count under the worst case
// ---------------------------------------------------------------------------

test('dom: expanding all 64 layers stays bounded', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));

  for (const layer of app.state.layers) {
    app.setLayerExpanded(layer.id, true);
  }

  const expandedCount = app.state.layers.filter((l) => app.isLayerExpanded(l.id)).length;
  assert.equal(expandedCount, 64, 'every layer is expanded');

  const tags = countTags(app);
  const cells = countCells(app);
  const all = countAll(app);

  // The data is 65,536 groups and 64 x 1024 cells; the DOM must be far smaller.
  assert.ok(tags > 0 && cells > 0, 'detail really is mounted');
  assert.ok(tags < 65536 / 10, `tags mounted (${tags}) must be a small fraction`);
  assert.ok(cells < 64 * 1024 / 10, `cells mounted (${cells}) must be a small fraction`);

  // Whole-list node count must stay in the low thousands, not ~600k.
  assert.ok(all < 60000, `total nodes ${all} must stay bounded`);
});

test('dom: node count does not scale with the data inside each layer', () => {
  // What virtualisation must fix: a layer's inner DOM must not grow with its
  // group / subdivision count. Layer count still legitimately adds one card
  // each, so this compares the same layer count at two data sizes.
  const build = (groups, numerator) => {
    const { app, limits } = newApp();
    const layers = [];
    for (let i = 0; i < 4; i++) {
      layers.push({
        name: `L${i}`,
        numerator,
        denominator: 16,
        bpmMultiplier: 1,
        groups: new Array(groups).fill(1),
        overrides: {},
        sound: 'classic',
        volume: 0.8,
        accentVolume: 1.3,
        muted: false,
      });
    }
    app.loadPresetData({ name: 'x', bpm: 120, layers });
    for (const layer of app.state.layers) app.setLayerExpanded(layer.id, true);
    return { app, limits };
  };

  const small = build(32, 128);
  const large = build(1024, 1024);

  const smallNodes = countAll(small.app);
  const largeNodes = countAll(large.app);

  // 32x more groups and 8x more beats per layer must not multiply the DOM.
  assert.ok(
    largeNodes < smallNodes * 4,
    `8x/32x the data produced ${largeNodes} nodes vs ${smallNodes} — must stay near-flat`
  );
});

test('dom: node count stays bounded when all 64 layers are expanded', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits));
  for (const layer of app.state.layers) app.setLayerExpanded(layer.id, true);

  const all = countAll(app);
  // 64 headers plus 64 bounded detail windows; nowhere near 593,813.
  assert.ok(all < 40000, `total nodes ${all} must stay well under the 593k baseline`);
});

test('dom: repeated remounts do not accumulate nodes', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 2));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const before = countAll(app);
  for (let i = 0; i < 20; i++) {
    app.refreshLayerVirtualWindows(layer.id);
  }
  const after = countAll(app);

  assert.equal(after, before, 'no node growth after repeated remounts');
});

test('dom: collapsing an expanded layer releases its detail', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 2));
  const layer = app.state.layers[0];

  app.setLayerExpanded(layer.id, true);
  assert.ok(countAll(app) > 0);

  app.setLayerExpanded(layer.id, false);
  assert.equal(countTags(app), 0);
  assert.equal(countCells(app), 0);
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

test('cleanup: collapsing disconnects the layer observer', () => {
  const { app, limits } = newApp();
  if (typeof ResizeObserver !== 'function') {
    // Environment without ResizeObserver: no observers are created at all.
    app.loadPresetData(hugePreset(limits, 1));
    app.setLayerExpanded(app.state.layers[0].id, true);
    assert.equal(app.virtualObservers.size, 0);
    return;
  }

  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  assert.equal(app.virtualObservers.size, 1);

  app.setLayerExpanded(layer.id, false);
  assert.equal(app.virtualObservers.size, 0, 'observer released on collapse');
});

test('cleanup: removing a layer disconnects and forgets it', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 3));
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  app.removeLayer(layer.id);

  assert.equal(app.virtualObservers.has(layer.id), false);
  assert.equal(app.expandedLayerIds.has(layer.id), false);
  assert.equal(app.currentPlayhead.has(layer.id), false);
});

test('cleanup: re-expanding does not stack observers', () => {
  const { app, limits } = newApp();
  app.loadPresetData(hugePreset(limits, 1));
  const layer = app.state.layers[0];

  for (let i = 0; i < 3; i++) {
    app.setLayerExpanded(layer.id, true);
    app.setLayerExpanded(layer.id, false);
  }
  app.setLayerExpanded(layer.id, true);

  assert.ok(app.virtualObservers.size <= 1, 'at most one observer per layer');
});
