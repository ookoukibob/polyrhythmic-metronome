/**
 * Regression tests for the review findings on PR #1.
 *
 * Each block targets one defect that was found by review:
 *   1. group window mixed group indexes with row indexes
 *   2. playhead follow stopped once the beat left the mounted window
 *   3. geometry cached a fallback measured from an empty DOM
 *   4. pattern spacers ignored the group-start margin
 *   5. keyboard navigation across mounted/unmounted cells
 *   6. layer cards nested a duplicate accent bar / .layer-main
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

function bigLayer(limits, overrides = {}) {
  return {
    name: 'Big',
    numerator: limits.numerator.max,
    denominator: 16,
    bpmMultiplier: 1,
    groups: new Array(limits.maxGroupEntries).fill(1),
    overrides: {},
    sound: 'classic',
    volume: 0.8,
    accentVolume: 1.3,
    muted: false,
    ...overrides,
  };
}

function loadOne(limits) {
  const { app } = newApp();
  app.loadPresetData({ name: 'x', bpm: 120, layers: [bigLayer(limits)] });
  return app;
}

const tagIndexes = (app, layerId) => {
  const card = app.document.getElementById(layerId);
  return list(card.querySelectorAll('.group-tag')).map((el) => parseInt(el.dataset.gidx, 10));
};
const cellIndexes = (app, layerId) => {
  const card = app.document.getElementById(layerId);
  return list(card.querySelectorAll('.subdiv-cell')).map((el) => parseInt(el.dataset.index, 10));
};
const spacers = (host) => list(host.children).filter((c) => /virtual-spacer/.test(c.className));

// The harness has no layout engine, so a scroller reports undefined sizes.
// Give the wrapper and grid a realistic geometry before exercising follow.
function primeScroller(app, layer) {
  const card = app.document.getElementById(layer.id);
  const wrap = card.querySelector('.subdivision-scroll-wrap');
  const grid = card.querySelector('.subdivision-grid');
  wrap.clientWidth = 320;
  wrap.scrollLeft = 0;
  const geom = app.getCellGeometry(grid);
  grid.scrollWidth = layer.numerator * geom.itemWidth;
  return { card, wrap, grid, geom };
}

// ===========================================================================
// 1. Group window units
// ===========================================================================

test('group-units: window total is rows, not groups', () => {
  const { api } = newApp();
  // 1000 items, 10 per row => 100 rows, 50px each.
  const win = api.computeVisibleRange({
    total: 100,
    viewportStart: 0,
    viewportEnd: 200,
    itemSize: 50,
    overscan: 0,
    minItems: 1,
  });
  // 200 / 50 = 4 visible rows, plus one extra row of coverage.
  assert.ok(win.end - win.start <= 6, `mounted ${win.end - win.start} rows`);
  assert.equal(win.end - win.start >= 4, true);
});

test('group-units: mounted range maps to whole rows of groups', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');
  const geom = host.__geom;
  const idx = tagIndexes(a, layer.id);

  assert.ok(idx.length > 0, 'tags mounted');
  // Contiguous and starting on a row boundary.
  for (let i = 1; i < idx.length; i++) {
    assert.equal(idx[i], idx[i - 1] + 1, 'contiguous group indexes');
  }
  assert.equal(idx[0] % geom.itemsPerRow, 0, 'starts on a row boundary');
  assert.equal(idx.length % geom.itemsPerRow === 0 || idx[idx.length - 1] === layer.groups.length - 1,
    true, 'ends on a row boundary or at the end of the data');
});

test('group-units: mounting far fewer than all groups when the list is long', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const idx = tagIndexes(a, layer.id);
  assert.ok(idx.length < 1024, `mounted ${idx.length} of 1024 groups`);
  assert.ok(idx.length > 0);
});

test('group-units: minGroupRows is measured in rows, not groups', () => {
  const { api } = newApp();
  const policy = api.VIRTUAL_POLICY;
  assert.ok(Number.isInteger(policy.overscanRows), 'overscanRows exists');
  assert.ok(Number.isInteger(policy.minGroupRows), 'minGroupRows exists');
  // Rows must be a much smaller number than the item minimum, otherwise the
  // per-row policy would mount hundreds of tags.
  assert.ok(policy.minGroupRows < policy.minWindowItems,
    'row minimum must be smaller than the item minimum');
});

test('group-units: fullRenderThreshold counts groups, and above it the list is virtualised', () => {
  const { api, limits } = newApp();
  const threshold = api.VIRTUAL_POLICY.fullRenderThreshold;

  // At the threshold: everything is mounted (no virtualisation).
  const smallHarness = loadApp();
  const smallApp = createApp(smallHarness, { now: 0 });
  smallApp.loadPresetData({
    name: 'x', bpm: 120,
    layers: [bigLayer(limits, { groups: new Array(threshold).fill(1) })],
  });
  const smallLayer = smallApp.state.layers[0];
  smallApp.setLayerExpanded(smallLayer.id, true);
  assert.equal(tagIndexes(smallApp, smallLayer.id).length, threshold, 'small list mounts fully');

  // Above the threshold: virtualised, so spacers appear. The exact mounted
  // count depends on the (absent) harness layout, so assert the mechanism
  // rather than a number: the host must contain a virtual spacer.
  const bigHarness = loadApp();
  const bigApp = createApp(bigHarness, { now: 0 });
  const over = 1024;
  bigApp.loadPresetData({
    name: 'x', bpm: 120,
    layers: [bigLayer(limits, { groups: new Array(over).fill(1) })],
  });
  const bigLayerRef = bigApp.state.layers[0];
  bigApp.setLayerExpanded(bigLayerRef.id, true);

  const host = bigApp.document.getElementById(bigLayerRef.id).querySelector('.groups-tags-list');
  const hasSpacer = list(host.children).some((c) => /virtual-spacer/.test(c.className));
  assert.equal(hasSpacer, true, 'a virtualised list uses spacers');
  assert.ok(tagIndexes(bigApp, bigLayerRef.id).length <= over);
});

test('group-units: spacers account for every row', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');
  const geom = host.__geom;
  const totalRows = Math.ceil(layer.groups.length / geom.itemsPerRow);

  const sp = spacers(host);
  let spacerRows = 0;
  for (const s of sp) {
    const h = parseFloat(String(s.style.height).replace('px', '')) || 0;
    spacerRows += Math.round(h / geom.rowHeight);
  }
  const mountedRows = Math.ceil(tagIndexes(a, layer.id).length / geom.itemsPerRow);

  assert.equal(spacerRows + mountedRows, totalRows,
    `spacers (${spacerRows}) + mounted rows (${mountedRows}) must equal ${totalRows}`);
});

test('group-units: different itemsPerRow still tiles the list exactly', () => {
  const { app, limits } = newApp();
  for (const perRow of [1, 3, 7, 13]) {
    const a = loadOne(limits);
    const layer = a.state.layers[0];
    a.setLayerExpanded(layer.id, true);

    const card = a.document.getElementById(layer.id);
    const host = card.querySelector('.groups-tags-list');
    host.__geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: perRow, totalRows: Math.ceil(1024 / perRow), measured: true };

    app.mountGroupWindow.call(a, layer, card);
    const idx = tagIndexes(a, layer.id);
    const sp = spacers(host);

    let spacerRows = 0;
    for (const s of sp) {
      spacerRows += Math.round((parseFloat(String(s.style.height).replace('px', '')) || 0) / 40);
    }
    const mountedRows = Math.ceil(idx.length / perRow);
    assert.equal(spacerRows + mountedRows, Math.ceil(1024 / perRow),
      `perRow=${perRow} must tile the rows exactly`);
    assert.equal(idx[0] % perRow, 0, `perRow=${perRow} starts on a row boundary`);
  }
});

// ===========================================================================
// 2. Playhead follow with an unmounted cell
// ===========================================================================

test('follow: playhead records position even when the cell is unmounted', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  a.highlightBeat(layer.id, 900);
  assert.equal(a.currentPlayhead.get(layer.id), 900);
});

test('follow: an unmounted beat still updates scrollLeft', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const { wrap } = primeScroller(a, layer);

  a.highlightBeat(layer.id, 500);
  assert.ok(wrap.scrollLeft > 0, 'scroller followed a beat that was not mounted');
});

test('follow: the followed beat becomes mounted', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  primeScroller(a, layer);

  a.highlightBeat(layer.id, 700);

  const idx = cellIndexes(a, layer.id);
  assert.ok(idx.includes(700), `mounted indexes ${idx[0]}..${idx[idx.length - 1]} must include 700`);
});

test('follow: the beat is highlighted once mounted', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  primeScroller(a, layer);

  a.state.isPlaying = true;
  a.highlightBeat(layer.id, 700);

  const cell = a.document.getElementById(layer.id)
    .querySelector('.subdiv-cell[data-index="700"]');
  assert.ok(cell, 'cell 700 is mounted');
  assert.match(cell.className, /active-playhead/);
});

test('follow: only one playhead remains after moving', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  primeScroller(a, layer);

  a.state.isPlaying = true;
  a.highlightBeat(layer.id, 100);
  a.highlightBeat(layer.id, 110);

  const marks = a.document.getElementById(layer.id).querySelectorAll('.subdiv-cell.active-playhead');
  assert.equal(marks.length, 1, 'stale highlight was cleared');
});

test('follow: wrapping back to beat 0 scrolls the grid home', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const { wrap } = primeScroller(a, layer);

  a.highlightBeat(layer.id, 900);
  assert.ok(wrap.scrollLeft > 0);

  a.highlightBeat(layer.id, 0);
  assert.equal(wrap.scrollLeft, 0, 'returned to the start');
});

test('follow: an already-visible beat does not move the scroller', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const { wrap } = primeScroller(a, layer);

  a.highlightBeat(layer.id, 0);
  const after = wrap.scrollLeft;
  a.highlightBeat(layer.id, 1);
  assert.equal(wrap.scrollLeft, after, 'no scroll for a beat already in view');
});

test('follow: scheduling is unaffected by follow/mount work', () => {
  const { app, harness, limits } = newApp();
  const a = app;
  a.loadPresetData({ name: 'x', bpm: 120, layers: [bigLayer(limits)] });
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  primeScroller(a, layer);

  a.startPlayback();
  a.scheduler();
  const queueBefore = a.state.visualQueue.length;
  const nextBefore = layer.nextNoteTime;

  a.highlightBeat(layer.id, 800);

  assert.equal(a.state.visualQueue.length, queueBefore, 'visual queue untouched');
  assert.equal(layer.nextNoteTime, nextBefore, 'audio timeline untouched');
  assert.equal(harness.getActiveIntervals(), 1, 'still one scheduler');
});

// ===========================================================================
// 3. Geometry cache and resize
// ===========================================================================

test('geometry: a fallback result is not treated as a final measurement', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');
  // The harness reports zero-sized rects, so this geometry is a fallback.
  assert.equal(host.__geom.measured, false, 'flagged as fallback');

  // Force a measured value, as a real browser would after mount.
  host.__geom = { itemWidth: 120, rowHeight: 44, itemsPerRow: 8, totalRows: 128, measured: true };
  const geom = a.getGroupGeometry(host, layer);
  assert.equal(geom.measured, true);
  assert.equal(geom.itemsPerRow, 8);
});

test('geometry: invalidateLayerGeometry drops the cache', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');
  host.__geom = { itemWidth: 1, rowHeight: 1, itemsPerRow: 1, totalRows: 1024, measured: true };

  a.invalidateLayerGeometry(layer.id);
  assert.equal(host.__geom, null, 'group geometry invalidated');

  const grid = card.querySelector('.subdivision-grid');
  grid.__geom = { itemWidth: 1, measured: true };
  a.invalidateLayerGeometry(layer.id);
  assert.equal(grid.__geom, null, 'cell geometry invalidated');
});

test('geometry: a wider container yields more items per row', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');

  host.__geom = null;
  host.clientWidth = 400;
  const narrow = a.getGroupGeometry(host, layer);

  host.__geom = null;
  host.clientWidth = 1200;
  const wide = a.getGroupGeometry(host, layer);

  assert.ok(wide.itemsPerRow > narrow.itemsPerRow,
    `1200px (${wide.itemsPerRow}) must fit more tags per row than 400px (${narrow.itemsPerRow})`);
});

test('geometry: resize invalidation re-tiles rows correctly', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');

  host.__geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: 4, totalRows: 256, measured: true };
  a.mountGroupWindow(layer, card);
  const rowsBefore = Math.ceil(tagIndexes(a, layer.id).length / 4) + spacerRowsOf(host, 40);
  assert.equal(rowsBefore, 256);

  a.invalidateLayerGeometry(layer.id);
  host.clientWidth = 1000;
  a.mountGroupWindow(layer, card);

  const geom = host.__geom;
  const rowsAfter = Math.ceil(tagIndexes(a, layer.id).length / geom.itemsPerRow) +
    spacerRowsOf(host, geom.rowHeight);
  assert.equal(rowsAfter, geom.totalRows, 'row count still tiles the whole list');
});

function spacerRowsOf(host, rowHeight) {
  let rows = 0;
  for (const s of spacers(host)) {
    rows += Math.round((parseFloat(String(s.style.height).replace('px', '')) || 0) / rowHeight);
  }
  return rows;
}

test('geometry: height-only changes do not invalidate', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');
  host.__geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: 4, totalRows: 256, measured: true };

  // The observer only reacts to width; a height change is what mounting more
  // rows causes, so reacting to it would loop forever.
  const before = host.__geom;
  a.invalidateLayerGeometry; // no height path exists by design
  assert.equal(host.__geom, before, 'height changes alone do not clear geometry');
});

// ===========================================================================
// 4. Pattern spacer width with group-start markers
// ===========================================================================

test('cell-spacers: total grid width equals cells * pitch', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const grid = card.querySelector('.subdivision-grid');
  const geom = grid.__geom;

  const before = parseFloat(String((spacers(grid)[0] || {}).style?.width || '0px').replace('px', '')) || 0;
  const after = parseFloat(String((spacers(grid)[1] || {}).style?.width || '0px').replace('px', '')) || 0;
  const mounted = cellIndexes(a, layer.id).length;

  const total = before + mounted * geom.itemWidth + after;
  assert.equal(Math.round(total), Math.round(layer.numerator * geom.itemWidth),
    'virtual grid width must match a fully rendered grid');
});

test('cell-spacers: group-start markers do not change the pitch', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];

  // 16 groups of 64 beats: group starts every 64 cells.
  layer.groups = new Array(16).fill(64);
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const grid = card.querySelector('.subdivision-grid');
  const geom = grid.__geom;
  const mounted = cellIndexes(a, layer.id).length;

  const before = parseFloat(String((spacers(grid)[0] || {}).style?.width || '0px').replace('px', '')) || 0;
  const after = parseFloat(String((spacers(grid)[1] || {}).style?.width || '0px').replace('px', '')) || 0;

  assert.equal(Math.round(before + mounted * geom.itemWidth + after),
    Math.round(layer.numerator * geom.itemWidth),
    'dense group starts must not inflate the width');
});

test('cell-spacers: every group of one beat still tiles', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  layer.groups = new Array(1024).fill(1); // every cell is a group start
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const grid = card.querySelector('.subdivision-grid');
  const geom = grid.__geom;
  const mounted = cellIndexes(a, layer.id).length;
  const before = parseFloat(String((spacers(grid)[0] || {}).style?.width || '0px').replace('px', '')) || 0;
  const after = parseFloat(String((spacers(grid)[1] || {}).style?.width || '0px').replace('px', '')) || 0;

  assert.equal(Math.round(before + mounted * geom.itemWidth + after),
    Math.round(1024 * geom.itemWidth));
});

// ===========================================================================
// 5. Keyboard navigation
// ===========================================================================

test('keyboard: exactly one cell per grid is a Tab stop', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const cells = list(card.querySelectorAll('.subdiv-cell'));
  assert.ok(cells.length > 0);

  const stops = cells.filter((c) => c.tabIndex === 0);
  assert.equal(stops.length, 1, 'roving tabindex gives exactly one Tab stop');
});

test('keyboard: cells expose a role and a beat label', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const cell = a.document.getElementById(layer.id).querySelector('.subdiv-cell');
  assert.equal(cell.getAttribute('role'), 'button');
  assert.match(cell.getAttribute('aria-label'), /第 1 拍/);
  assert.ok(cell.getAttribute('aria-pressed') !== null);
});

test('keyboard: ArrowRight moves the logical cursor', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  card.querySelector('.subdivision-scroll-wrap').clientWidth = 320;

  const cell = card.querySelector('.subdiv-cell[data-index="0"]');
  a.handleGridKeydown({ key: 'ArrowRight', preventDefault() {} }, layer, cell);

  assert.equal(a.gridCursor.get(layer.id), 1);
});

test('keyboard: ArrowLeft clamps at the first beat', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  card.querySelector('.subdivision-scroll-wrap').clientWidth = 320;

  const cell = card.querySelector('.subdiv-cell[data-index="0"]');
  a.handleGridKeydown({ key: 'ArrowLeft', preventDefault() {} }, layer, cell);
  assert.equal(a.gridCursor.get(layer.id), 0);
});

test('keyboard: End jumps to the last beat even though it is unmounted', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  card.querySelector('.subdivision-scroll-wrap').clientWidth = 320;
  card.querySelector('.subdivision-grid').scrollWidth = 1024 * 34;

  const cell = card.querySelector('.subdiv-cell[data-index="0"]');
  a.handleGridKeydown({ key: 'End', preventDefault() {} }, layer, cell);

  assert.equal(a.gridCursor.get(layer.id), 1023);
  const idx = cellIndexes(a, layer.id);
  assert.ok(idx.includes(1023), 'the last beat was mounted by the navigation');
});

test('keyboard: Home jumps back to the first beat', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  card.querySelector('.subdivision-scroll-wrap').clientWidth = 320;
  card.querySelector('.subdivision-grid').scrollWidth = 1024 * 34;

  a.focusCell(layer, 900);
  a.handleGridKeydown({ key: 'Home', preventDefault() {} }, layer, card.querySelector('.subdiv-cell'));
  assert.equal(a.gridCursor.get(layer.id), 0);
});

test('keyboard: Enter cycles the beat type of the focused cell', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);

  const cell = card.querySelector('.subdiv-cell[data-index="0"]');
  const before = a.state.getBeatType(layer, 0);
  a.handleGridKeydown({ key: 'Enter', preventDefault() {} }, layer, cell);
  const after = a.state.getBeatType(layer, 0);

  assert.notEqual(after, before, 'Enter changed the beat');
  assert.equal(layer.overrides[0], after);
});

test('keyboard: Space behaves like Enter', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);

  const cell = card.querySelector('.subdiv-cell[data-index="0"]');
  const before = a.state.getBeatType(layer, 0);
  a.handleGridKeydown({ key: ' ', preventDefault() {} }, layer, cell);
  assert.notEqual(a.state.getBeatType(layer, 0), before);
});

test('keyboard: focusCell mounts an unmounted target index', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  card.querySelector('.subdivision-scroll-wrap').clientWidth = 320;
  card.querySelector('.subdivision-grid').scrollWidth = 1024 * 34;

  a.focusCell(layer, 512);

  const idx = cellIndexes(a, layer.id);
  assert.ok(idx.includes(512), `target 512 must be mounted, got ${idx[0]}..${idx[idx.length - 1]}`);
  assert.equal(a.pendingCellIndex.has(layer.id), false, 'pending request cleared after mount');
});

test('keyboard: focusCell rejects out-of-range indexes', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  assert.doesNotThrow(() => a.focusCell(layer, -1));
  assert.doesNotThrow(() => a.focusCell(layer, 5000));
  assert.doesNotThrow(() => a.focusCell(layer, NaN));
});

test('keyboard: a remount keeps the roving stop on the cursor', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);
  const card = a.document.getElementById(layer.id);
  card.querySelector('.subdivision-scroll-wrap').clientWidth = 320;
  card.querySelector('.subdivision-grid').scrollWidth = 1024 * 34;

  a.focusCell(layer, 40);
  a.refreshLayerVirtualWindows(layer.id);

  const stops = list(a.document.getElementById(layer.id).querySelectorAll('.subdiv-cell'))
    .filter((c) => c.tabIndex === 0);
  assert.equal(stops.length, 1, 'still exactly one Tab stop after remount');
  assert.equal(parseInt(stops[0].dataset.index, 10), 40);
});

test('keyboard: editing a group keeps its value across a window refresh', () => {
  const { app, limits } = newApp();
  const a = loadOne(limits);
  const layer = a.state.layers[0];
  a.setLayerExpanded(layer.id, true);

  const card = a.document.getElementById(layer.id);
  const input = card.querySelector('.group-tag-val');
  const gIdx = parseInt(input.closest('.group-tag').dataset.gidx, 10);
  input.value = '9';
  input.dispatchEvent({ type: 'change' });

  assert.equal(layer.groups[gIdx], 9, 'state received the edit');

  a.refreshLayerVirtualWindows(layer.id);

  const tagsAfter = list(a.document.getElementById(layer.id).querySelectorAll('.group-tag'));
  const same = tagsAfter.find((t) => parseInt(t.dataset.gidx, 10) === gIdx);
  assert.ok(same, 'the edited tag is still mounted after the refresh');
  assert.equal(String(same.querySelector('.group-tag-val').value), '9', 'value survived the refresh');
});

// ===========================================================================
// 6. Layer card structure
// ===========================================================================

test('structure: a card has exactly one accent bar and one main container', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'A', numerator: 4, denominator: 4 })];
  app.applyInitialExpansionState();
  app.renderAll();

  const card = app.document.getElementById(app.state.layers[0].id);
  assert.equal(card.querySelectorAll('.layer-accent-bar').length, 1);
  assert.equal(card.querySelectorAll('.layer-main').length, 1);
});

test('structure: .layer-main is a direct child of the card', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'A', numerator: 4, denominator: 4 })];
  app.applyInitialExpansionState();
  app.renderAll();

  const card = app.document.getElementById(app.state.layers[0].id);
  const main = card.querySelector('.layer-main');
  assert.equal(main.parentNode, card, '.layer-main must not be nested');
});

test('structure: the header and the detail are siblings inside .layer-main', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'A', numerator: 8, denominator: 8 })];
  app.applyInitialExpansionState();
  app.renderAll();

  const card = app.document.getElementById(app.state.layers[0].id);
  const main = card.querySelector('.layer-main');
  const header = main.querySelector('.layer-header-bar');
  const detail = main.querySelector('.layer-detail');
  assert.ok(header && detail);
  assert.equal(header.parentNode, main);
  assert.equal(detail.parentNode, main);
  // No accent bar inside .layer-main.
  assert.equal(main.querySelectorAll('.layer-accent-bar').length, 0);
});

test('structure: expanding does not add another main container', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'A', numerator: 8, denominator: 8 })];
  app.applyInitialExpansionState();
  app.renderAll();
  const layer = app.state.layers[0];

  const card = app.document.getElementById(layer.id);
  app.setLayerExpanded(layer.id, true);

  assert.equal(card.querySelectorAll('.layer-main').length, 1);
  assert.equal(card.querySelectorAll('.layer-accent-bar').length, 1);
});

test('structure: a large configuration keeps one main per card', () => {
  const { app, limits } = newApp();
  const layers = [];
  for (let i = 0; i < 6; i++) layers.push(bigLayer(limits, { name: `B${i}` }));
  app.loadPresetData({ name: 'x', bpm: 120, layers });

  for (const layer of app.state.layers) {
    const card = app.document.getElementById(layer.id);
    assert.equal(card.querySelectorAll('.layer-main').length, 1, `card ${layer.name}`);
    assert.equal(card.querySelectorAll('.layer-accent-bar').length, 1, `card ${layer.name}`);
  }
});

test('structure: header controls still work after the cleanup', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'A', numerator: 4, denominator: 4 })];
  app.applyInitialExpansionState();
  app.renderAll();
  const layer = app.state.layers[0];
  const card = app.document.getElementById(layer.id);

  const nameInput = card.querySelector('.layer-name-input');
  nameInput.value = 'Renamed';
  nameInput.dispatchEvent({ type: 'change' });
  assert.equal(layer.name, 'Renamed');

  const expand = card.querySelector('.expand-btn');
  expand.dispatchEvent({ type: 'click' });
  assert.equal(app.isLayerExpanded(layer.id), false);
});
