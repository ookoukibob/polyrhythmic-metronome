/**
 * Regression tests for the second review round on PR #1.
 *
 *  1. unchanged virtual windows must not rebuild their DOM
 *  2. horizontal pattern scrolling must not rebuild group tags
 *  3. group tags are uniform width, so the row model matches the layout
 *  4. the group-start marker must be visible above the cell
 *  5. aria attributes stay in sync after grouping edits
 *  6. focus survives window recycling
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

// Shared limits table, loaded once — every harness exposes the same frozen copy.
const LIMITS = loadApp().api.METRONOME_LIMITS;

function newApp(options = {}) {
  const harness = loadApp();
  const app = createApp(harness, { now: 0, ...options });
  return { app, harness, limits: harness.api.METRONOME_LIMITS, api: harness.api };
}

function bigLayer(limits, overrides = {}) {
  // A "large" layer only needs enough entries to cross the virtualisation
  // threshold; using the full 1024 makes each mount allocate a huge HTML
  // string and starves the test runner.
  const groups = overrides.groups || new Array(300).fill(1);
  return {
    name: 'Big',
    numerator: 1024,
    denominator: 16,
    bpmMultiplier: 1,
    groups,
    overrides: {},
    sound: 'classic',
    volume: 0.8,
    accentVolume: 1.3,
    muted: false,
    ...overrides,
    groups,
  };
}

function loadOne(limits, overrides) {
  const { app, harness } = newApp();
  app.loadPresetData({ name: 'x', bpm: 120, layers: [bigLayer(limits, overrides)] });
  return { app, harness };
}

const tagNodes = (app, layerId) =>
  list(app.document.getElementById(layerId).querySelectorAll('.group-tag'));
const cellNodes = (app, layerId) =>
  list(app.document.getElementById(layerId).querySelectorAll('.subdiv-cell'));

// ===========================================================================
// 1. Unchanged windows are not rebuilt
// ===========================================================================

test('refresh: an identical group window preserves node identity', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  // Pin the geometry so the window is deterministic regardless of layout.
  const card = app.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');
  host.__geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: 8, totalRows: 128, measured: true };

  app.mountGroupWindow(layer, card);
  const before = tagNodes(app, layer.id);
  assert.ok(before.length > 0);

  app.mountGroupWindow(layer, card);
  const after = tagNodes(app, layer.id);

  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], `tag ${i} must be the same node`);
  }
});

test('refresh: an identical cell window preserves node identity', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);

  const before = cellNodes(app, layer.id);
  assert.ok(before.length > 0);

  app.mountCellWindow(layer, card);
  const after = cellNodes(app, layer.id);

  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], `cell ${i} must be the same node`);
  }
});

test('refresh: a changed group window does rebuild', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');

  const geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: 8, totalRows: 38, measured: true };
  host.__geom = geom;
  app.mountGroupWindow(layer, card);
  const before = tagNodes(app, layer.id);
  assert.ok(before.length > 0);

  // Move the list up by ten rows: the visible slice shifts to a later range.
  host.getBoundingClientRect = () => ({
    top: -400, left: 0, width: 800, height: 320, bottom: -80, right: 800,
  });
  app.mountGroupWindow(layer, card);

  const after = tagNodes(app, layer.id);
  assert.ok(after.length > 0, 'the moved window still mounts tags');
  assert.notEqual(after[0], before[0], 'a moved window mounts different nodes');
  assert.notEqual(after[0].dataset.gidx, before[0].dataset.gidx);
});

test('refresh: a data revision forces a rebuild', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');
  host.__geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: 8, totalRows: 128, measured: true };

  app.mountGroupWindow(layer, card);
  const before = tagNodes(app, layer.id);

  layer.groups[0] = 7;
  app.bumpLayerDataRevision(layer);
  app.mountGroupWindow(layer, card);

  const after = tagNodes(app, layer.id);
  assert.notEqual(after[0], before[0], 'data change must not be skipped');
  assert.equal(String(after[0].querySelector('.group-tag-val').value), '7');
});

test('refresh: a geometry change forces a rebuild', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');

  host.__geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: 8, totalRows: 128, measured: true };
  app.mountGroupWindow(layer, card);
  const before = tagNodes(app, layer.id);

  host.__geom = { itemWidth: 100, rowHeight: 40, itemsPerRow: 4, totalRows: 256, measured: true };
  app.mountGroupWindow(layer, card);

  const after = tagNodes(app, layer.id);
  assert.notEqual(after.length, before.length, 'row count change alters the window');
});

test('refresh: a small full-render list is not rebuilt on repeat', () => {
  const { app } = newApp();
  app.state.layers = [app.state.createLayer({ name: 'S', numerator: 12, denominator: 8, groups: [3, 3, 2, 4] })];
  app.applyInitialExpansionState();
  app.renderAll();
  const layer = app.state.layers[0];
  const card = app.document.getElementById(layer.id);

  app.mountGroupWindow(layer, card);
  const before = tagNodes(app, layer.id);

  app.mountGroupWindow(layer, card);
  const after = tagNodes(app, layer.id);

  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], 'full render must be stable too');
  }
});

// ===========================================================================
// 2. Horizontal scrolling does not touch group tags
// ===========================================================================

test('targeted: a cell-only refresh leaves group tags untouched', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);

  const tagsBefore = tagNodes(app, layer.id);
  assert.ok(tagsBefore.length > 0);

  app.refreshLayerVirtualWindows(layer.id, 'cells');

  const tagsAfter = tagNodes(app, layer.id);
  for (let i = 0; i < tagsBefore.length; i++) {
    assert.equal(tagsAfter[i], tagsBefore[i], 'group tags keep their nodes');
  }
});

test('targeted: a group-only refresh leaves cells untouched', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);

  const cellsBefore = cellNodes(app, layer.id);
  assert.ok(cellsBefore.length > 0);

  app.refreshLayerVirtualWindows(layer.id, 'groups');

  const cellsAfter = cellNodes(app, layer.id);
  for (let i = 0; i < cellsBefore.length; i++) {
    assert.equal(cellsAfter[i], cellsBefore[i], 'cells keep their nodes');
  }
});

test('targeted: scheduling widens a pending narrow refresh', () => {
  const { app, limits } = newApp();
  app.loadPresetData({ name: 'x', bpm: 120, layers: [bigLayer(limits)] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  // Expanding already queued a refresh; start from a clean slate.
  app.virtualRefreshQueued.delete(layer.id);

  app.scheduleVirtualRefresh(layer.id, 'cells');
  assert.equal(app.virtualRefreshQueued.get(layer.id), 'cells');

  // A second, broader request must widen the pending work, not be dropped.
  app.scheduleVirtualRefresh(layer.id, 'groups');
  assert.equal(app.virtualRefreshQueued.get(layer.id), 'both');
});

// ===========================================================================
// 3. Uniform tag width
// ===========================================================================

test('uniform: every tag renders both move buttons', () => {
  const { app, limits } = loadOne(LIMITS, { groups: [3, 3, 2] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const tags = tagNodes(app, layer.id);
  assert.equal(tags.length, 3);
  for (const tag of tags) {
    assert.ok(tag.querySelector('.group-move-left'), 'left button always present');
    assert.ok(tag.querySelector('.group-move-right'), 'right button always present');
  }
});

test('uniform: boundary buttons are disabled, not omitted', () => {
  const { app, limits } = loadOne(LIMITS, { groups: [3, 3, 2] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const tags = tagNodes(app, layer.id);
  assert.equal(tags[0].querySelector('.group-move-left').disabled, true, 'first cannot move left');
  assert.equal(tags[0].querySelector('.group-move-right').disabled, false);
  assert.equal(tags[2].querySelector('.group-move-right').disabled, true, 'last cannot move right');
  assert.equal(tags[2].querySelector('.group-move-left').disabled, false);
});

test('uniform: clicking a disabled boundary button does nothing', () => {
  const { app, limits } = loadOne(LIMITS, { groups: [3, 3, 2] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const before = [...layer.groups];
  const tags = tagNodes(app, layer.id);
  tags[0].querySelector('.group-move-left').dispatchEvent({ type: 'click' });

  assert.deepEqual([...layer.groups], before, 'a disabled move is a no-op');
});

test('uniform: the row model uses one pitch for all tags', () => {
  const { app, limits } = loadOne(LIMITS, { groups: [3, 3, 2] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');

  // Fake a real measurement: every tag reports the same width.
  const tags = tagNodes(app, layer.id);
  for (const tag of tags) {
    tag.getBoundingClientRect = () => ({ width: 106, height: 30, top: 0, left: 0, bottom: 30, right: 106 });
  }
  host.clientWidth = 530;
  host.__geom = null;

  const geom = app.getGroupGeometry(host, layer);
  assert.equal(geom.measured, true);
  assert.equal(geom.itemWidth, 114, 'width plus flex gap');
  assert.equal(geom.itemsPerRow, 4, '530 / 114 floors to 4');
});

// ===========================================================================
// 4. Group-start marker
// ===========================================================================

test('marker: group-start wraps carry the marker class', () => {
  // Groups of 4 across 40 beats: a boundary lands at beat 4, inside the
  // mounted window, so the marker is observable without scrolling.
  const { app } = loadOne(LIMITS, { groups: new Array(10).fill(4) });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const wraps = list(app.document.getElementById(layer.id).querySelectorAll('.subdiv-cell-wrap'));
  const starts = wraps.filter((w) => w.classList.contains('group-start'));
  assert.ok(starts.length > 0, 'at least one group boundary is visible');
  const idx = parseInt(starts[0].querySelector('.subdiv-cell').dataset.index, 10);
  assert.equal(idx % 4, 0, 'the marker sits on a group boundary');
  assert.ok(idx > 0, 'index 0 is the list start, not a boundary marker');
});

test('marker: the marker does not alter the cell pitch', () => {
  const { app, limits } = loadOne(LIMITS, { groups: [4, 4] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const grid = card.querySelector('.subdivision-grid');

  // All wraps share one width whether or not they are a group start.
  const wraps = list(grid.querySelectorAll('.subdiv-cell-wrap'));
  for (const w of wraps) {
    w.getBoundingClientRect = () => ({ width: 32, height: 60, top: 0, left: 0, bottom: 60, right: 32 });
  }
  grid.__geom = null;
  const geom = app.getCellGeometry(grid);
  assert.equal(geom.itemWidth, 34, 'pitch is width plus gap, unaffected by the marker');
});

// ===========================================================================
// 5. ARIA stays in sync
// ===========================================================================

test('aria: a grouping edit updates aria-label and aria-pressed', () => {
  const { app, limits } = loadOne(LIMITS, { groups: [4] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const cell = cellNodes(app, layer.id)[0];
  const before = cell.getAttribute('aria-label');
  assert.match(before, /第 1 拍/);

  // Make beat 0 silent by overriding it, then repaint.
  layer.overrides[0] = 'mute';
  app.refreshSubdivisionTypes(layer);

  assert.equal(cell.getAttribute('aria-label'), '第 1 拍：mute');
  assert.equal(cell.getAttribute('aria-pressed'), 'false');
});

test('aria: manual toggle keeps the attributes in sync', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const cell = cellNodes(app, layer.id)[0];
  const before = cell.getAttribute('aria-pressed');
  cell.dispatchEvent({ type: 'click' });

  const after = cell.getAttribute('aria-pressed');
  assert.notEqual(after, before, 'aria-pressed follows the new beat type');
  assert.match(cell.getAttribute('aria-label'), /第 1 拍/);
});

test('aria: a rebuilt window renders synchronized attributes', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  layer.overrides[0] = 'mute';
  app.setLayerExpanded(layer.id, true);

  const cell = cellNodes(app, layer.id)[0];
  assert.match(cell.getAttribute('aria-label'), /mute/);
  assert.equal(cell.getAttribute('aria-pressed'), 'false');
});

// ===========================================================================
// 6. Focus preservation
// ===========================================================================

test('focus: an unrelated active element is not stolen', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const outside = app.document.createElement('button');
  app.document.body.appendChild(outside);
  outside.focus();
  assert.equal(app.document.activeElement, outside);

  app.refreshLayerVirtualWindows(layer.id, 'cells');

  assert.equal(app.document.activeElement, outside, 'refresh must not steal focus');
});

test('focus: a focused cell keeps its beat across a cell refresh', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const cell = cellNodes(app, layer.id)[3];
  const index = parseInt(cell.dataset.index, 10);
  cell.focus();
  assert.equal(app.document.activeElement, cell);

  // Force a rebuild by invalidating the signature.
  const card = app.document.getElementById(layer.id);
  card.querySelector('.subdivision-grid').__windowSig = null;
  app.refreshLayerVirtualWindows(layer.id, 'cells');

  const again = cellNodes(app, layer.id).find((c) => parseInt(c.dataset.index, 10) === index);
  assert.ok(again, 'the same beat is still mounted');
  assert.equal(app.document.activeElement, again, 'focus moved to the replacement node');
});

test('focus: a focused group input keeps its value and caret', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const tag = tagNodes(app, layer.id)[0];
  const input = tag.querySelector('.group-tag-val');
  // Edit through state, the way the change handler does, then commit.
  layer.groups[0] = 7;
  input.value = '7';
  input.selectionStart = 1;
  input.selectionEnd = 1;
  input.focus();
  assert.equal(app.document.activeElement, input);

  const card = app.document.getElementById(layer.id);
  card.querySelector('.groups-tags-list').__windowSig = null;
  app.refreshLayerVirtualWindows(layer.id, 'groups');

  const again = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  assert.equal(again.value, '7', 'value is taken from state');
  assert.equal(app.document.activeElement, again, 'focus follows the group');
});

test('focus: captureVirtualFocus ignores elements outside the card', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);

  const outside = app.document.createElement('button');
  app.document.body.appendChild(outside);
  outside.focus();

  assert.equal(app.captureVirtualFocus(card), null);
});

test('focus: captureVirtualFocus describes a cell logically', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);

  const cell = cellNodes(app, layer.id)[2];
  cell.focus();
  const focus = app.captureVirtualFocus(card);

  assert.equal(focus.kind, 'cell');
  assert.equal(focus.index, parseInt(cell.dataset.index, 10));
});

test('focus: keyboard navigation still works after a focus-preserving refresh', () => {
  const { app, limits } = loadOne(LIMITS);
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const cell = cellNodes(app, layer.id)[0];
  cell.focus();
  app.refreshLayerVirtualWindows(layer.id, 'cells');

  const current = cellNodes(app, layer.id)[0];
  app.handleGridKeydown({ key: 'ArrowRight', preventDefault() {} }, layer, current);
  assert.equal(app.gridCursor.get(layer.id), parseInt(current.dataset.index, 10) + 1);
});

// ===========================================================================
// Off-screen draft preservation (Test A - E)
// ===========================================================================

// Helper: a small, fully-mounted layer with one group whose committed value
// is 4. Small lists use the `groups-full` window, which is exactly what an
// off-screen collapse + re-mount exercises.
function draftApp() {
  const { app } = loadOne(LIMITS, { groups: [4, 4, 4] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  return { app, layer };
}

const firstInput = (app, layerId) =>
  tagNodes(app, layerId)[0].querySelector('.group-tag-val');

// Simulate the real page-scroll collapse path, then a fresh mount.
function collapseAndRemount(app, layer) {
  app.collapseVirtualWindow(layer.id);
  // The layer is expanded again by the normal mount path; reset the minimal
  // flags exactly as a scroll back into view would through mountGroupWindow.
  const card = app.document.getElementById(layer.id);
  app.mountGroupWindow(layer, card);
}

test('draft A: an uncommitted value survives off-screen collapse and re-mount', () => {
  const { app, layer } = draftApp();

  const input = firstInput(app, layer.id);
  assert.equal(String(layer.groups[0]), '4');
  input.value = '7';
  input.dispatchEvent({ type: 'input' });   // NO change event

  collapseAndRemount(app, layer);

  const again = firstInput(app, layer.id);
  assert.equal(again.value, '7', 'draft restored on the replacement input');
  assert.equal(String(layer.groups[0]), '4', 'committed state untouched');
  assert.equal(app.getGroupDraft(layer.id, 0), '7', 'draft still uncommitted');
});

test('draft B: restoring a draft does not steal focus', () => {
  const { app, layer } = draftApp();
  const card = app.document.getElementById(layer.id);

  // --- Phase 1: initial edit, input mounted and focused ---
  const input = firstInput(app, layer.id);
  assert.equal(String(layer.groups[0]), '4', 'committed state starts at 4');
  input.focus();
  input.value = '7';
  input.dispatchEvent({ type: 'input' });   // NO change event
  assert.equal(app.getGroupDraft(layer.id, 0), '7', 'draft saved');
  assert.equal(app.document.activeElement, input, 'input is focused');

  // The mini DOM has no Element#contains, so walk the parent chain instead.
  const isMountedIn = (node, root) => {
    let n = node;
    while (n) {
      if (n === root) return true;
      n = n.parentNode;
    }
    return false;
  };
  assert.equal(isMountedIn(input, card), true, 'the input is in the DOM before collapse');

  // --- Phase 2: COLLAPSE ONLY. No re-mount helper is called here. ---
  app.collapseVirtualWindow(layer.id);
  const host = card.querySelector('.groups-tags-list');
  assert.equal(host.__minimal, true, 'Group window is in minimal state');
  assert.equal(tagNodes(app, layer.id).length, 0, 'all Group tags removed');
  assert.equal(app.document.getElementById(layer.id).querySelector('.group-tag-val'), null,
    'no Group input is mounted');
  assert.equal(isMountedIn(input, card), false,
    'the original input node is gone from the DOM');
  assert.equal(String(layer.groups[0]), '4', 'committed state still 4');
  assert.equal(app.getGroupDraft(layer.id, 0), '7', 'draft survived the collapse');

  // --- Phase 3: while STILL off-screen, move focus to an unrelated control ---
  const other = app.document.createElement('button');
  other.className = 'add-layer-btn';
  app.document.body.appendChild(other);
  other.focus();
  assert.equal(app.document.activeElement, other, 'unrelated control now holds focus');
  assert.equal(host.__minimal, true, 'still minimal while focus moves');

  // --- Phase 4: re-mount through the normal path ---
  app.mountGroupWindow(layer, card);
  assert.equal(host.__minimal, false, 'Group window mounted again');
  const again = firstInput(app, layer.id);
  assert.notEqual(again, input, 'a new input node was created');
  assert.equal(again.value, '7', 'restored input displays the draft');
  assert.equal(String(layer.groups[0]), '4', 'committed state still 4');
  assert.equal(app.getGroupDraft(layer.id, 0), '7', 'draft still uncommitted');
  assert.equal(app.document.activeElement, other,
    're-mounting the draft did NOT steal focus from the unrelated control');
});

test('draft C: a restored draft commits normally and is then cleared', () => {
  const { app, layer } = draftApp();

  firstInput(app, layer.id).value = '7';
  firstInput(app, layer.id).dispatchEvent({ type: 'input' });
  collapseAndRemount(app, layer);

  const again = firstInput(app, layer.id);
  assert.equal(again.value, '7');
  // Normal commit through the delegated change handler.
  again.dispatchEvent({ type: 'change' });

  assert.equal(String(layer.groups[0]), '7', 'state committed');
  assert.equal(app.getGroupDraft(layer.id, 0), undefined, 'draft cleared');

  // Another collapse/re-mount must show the committed value, not a stale draft.
  collapseAndRemount(app, layer);
  assert.equal(firstInput(app, layer.id).value, '7');
  assert.equal(app.getGroupDraft(layer.id, 0), undefined);
});

test('draft D: a move keeps the draft with its own group, not its index', () => {
  const { app, layer } = draftApp();

  const input = tagNodes(app, layer.id)[1].querySelector('.group-tag-val');
  input.value = '9';
  input.dispatchEvent({ type: 'input' });
  assert.equal(app.getGroupDraft(layer.id, 1), '9');

  // Move group 1 left by clicking its left button.
  const tag = tagNodes(app, layer.id)[1];
  tag.querySelector('.group-move-left').dispatchEvent({ type: 'click' });

  assert.equal(app.getGroupDraft(layer.id, 0), '9', 'draft followed the group to index 0');
  assert.equal(app.getGroupDraft(layer.id, 1), undefined, 'no draft left on the shifted group');
  const movedInput = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  assert.equal(movedInput.value, '9');
});

test('draft D: deleting a group clears its draft', () => {
  const { app, layer } = draftApp();

  const input = tagNodes(app, layer.id)[1].querySelector('.group-tag-val');
  input.value = '9';
  input.dispatchEvent({ type: 'input' });
  assert.equal(app.getGroupDraft(layer.id, 1), '9');

  tagNodes(app, layer.id)[1].querySelector('.group-tag-del').dispatchEvent({ type: 'click' });

  assert.equal(layer.groups.length, 2);
  assert.equal(app.draftsFor(layer.id).size, 0, 'deleted group draft removed');
});

test('draft D: inserting a group does not reassign an existing draft', () => {
  const { app, layer } = draftApp();

  const input = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  input.value = '9';
  input.dispatchEvent({ type: 'input' });

  const card = app.document.getElementById(layer.id);
  card.querySelector('.add-group-btn').dispatchEvent({ type: 'click' });

  assert.equal(layer.groups.length, 4);
  assert.equal(app.getGroupDraft(layer.id, 0), '9', 'draft still on the original group');
  assert.equal(app.getGroupDraft(layer.id, 3), undefined, 'new group has no draft');
});

test('draft D: loading a new configuration clears stale drafts', () => {
  const { app, layer } = draftApp();
  firstInput(app, layer.id).value = '7';
  firstInput(app, layer.id).dispatchEvent({ type: 'input' });
  assert.equal(app.getGroupDraft(layer.id, 0), '7');

  app.loadPresetData({ name: 'new', bpm: 120, layers: [{
    name: 'N', numerator: 8, denominator: 8, bpmMultiplier: 1,
    groups: [2, 2, 2, 2], overrides: {}, sound: 'classic',
    volume: 0.8, accentVolume: 1.3, muted: false,
  }] });

  assert.equal(app.groupDrafts.size, 0, 'all drafts cleared on config replacement');
});

test('draft D: removing a layer clears its drafts', () => {
  const { app, layer } = draftApp();
  // Add a second layer so removal is allowed.
  app.addLayer({ name: 'Other', numerator: 4, denominator: 4, groups: [2, 2] });
  firstInput(app, layer.id).value = '7';
  firstInput(app, layer.id).dispatchEvent({ type: 'input' });

  app.removeLayer(layer.id);
  assert.equal(app.groupDrafts.has(layer.id), false);
});

test('draft E: an unchanged refresh does not touch a mounted input', () => {
  const { app, layer } = draftApp();
  const input = firstInput(app, layer.id);
  input.focus();
  input.value = '7';
  input.dispatchEvent({ type: 'input' });

  // Instrument the LIVE node: a no-op refresh must not re-assign value or
  // call focus() on it (that would disturb the caret / IME composition).
  let valueWrites = 0;
  let focusCalls = 0;
  let stored = '7';
  Object.defineProperty(input, 'value', {
    get() { return stored; },
    set(v) { valueWrites++; stored = String(v); },
    configurable: true,
  });
  const originalFocus = input.focus;
  input.focus = () => { focusCalls++; return originalFocus.call(input); };

  app.refreshLayerVirtualWindows(layer.id, 'groups');  // identical signature

  assert.equal(app.document.activeElement, input, 'focus stays on the same node');
  assert.equal(valueWrites, 0, 'no value re-assignment on an unchanged window');
  assert.equal(focusCalls, 0, 'no focus() call on an unchanged window');
  assert.equal(input.value, '7', 'the in-progress edit is intact');
});

test('draft E: a real window change still restores focus', () => {
  const { app, layer } = draftApp();
  const input = firstInput(app, layer.id);
  input.focus();
  input.value = '7';
  input.dispatchEvent({ type: 'input' });

  const host = app.document.getElementById(layer.id).querySelector('.groups-tags-list');
  host.__windowSig = null;                 // force a genuine rebuild
  app.refreshLayerVirtualWindows(layer.id, 'groups');

  const again = firstInput(app, layer.id);
  assert.notEqual(again, input, 'the node really was replaced');
  assert.equal(app.document.activeElement, again, 'focus restored after a real rebuild');
  assert.equal(again.value, '7');
});

