/**
 * Regression tests for the third review round on PR #1.
 *
 *  1. playback beat changes must not invalidate the structural cell window
 *  2. uncommitted Group input values survive window recycling
 *  3. focus restoration uses preventScroll and does not steal outside focus
 *  4. flex-gap row capacity follows the real Flexbox packing rule
 *  5. Group move/delete preserves a logical focus destination
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);
const LIMITS = loadApp().api.METRONOME_LIMITS;
const POLICY = loadApp().api.VIRTUAL_POLICY;

function newApp() {
  const harness = loadApp();
  const app = createApp(harness, { now: 0 });
  return { app, harness };
}

function bigLayer(overrides = {}) {
  const groups = overrides.groups || new Array(300).fill(1);
  return {
    name: 'Big', numerator: 1024, denominator: 16, bpmMultiplier: 1,
    groups, overrides: {}, sound: 'classic', volume: 0.8,
    accentVolume: 1.3, muted: false, ...overrides, groups,
  };
}

function loadOne(overrides) {
  const { app, harness } = newApp();
  app.loadPresetData({ name: 'x', bpm: 120, layers: [bigLayer(overrides)] });
  return { app, harness };
}

const cellNodes = (app, layerId) =>
  list(app.document.getElementById(layerId).querySelectorAll('.subdiv-cell'));
const tagNodes = (app, layerId) =>
  list(app.document.getElementById(layerId).querySelectorAll('.group-tag'));

// ===========================================================================
// 1. Playback position is NOT structural
// ===========================================================================

test('playback: advancing the playhead inside one window does not rebuild cells', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);

  app.state.isPlaying = true;
  const before = cellNodes(app, layer.id);
  assert.ok(before.length > 0);
  const firstIdx = parseInt(before[0].dataset.index, 10);

  // Two beats inside the same mounted window.
  app.highlightBeat(layer.id, firstIdx);
  app.highlightBeat(layer.id, firstIdx + 1);
  app.refreshLayerVirtualWindows(layer.id, 'cells');

  const after = cellNodes(app, layer.id);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i], before[i], `cell ${i} kept its node across playback`);
  }
});

test('playback: repeated refreshes during playback cause no DOM churn', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  app.state.isPlaying = true;
  const before = cellNodes(app, layer.id);
  const start = parseInt(before[0].dataset.index, 10);

  // Walk the playhead across the whole mounted window, refreshing each step
  // the way a page-scroll rAF would. No window rebuild should occur.
  let churn = 0;
  for (let i = 0; i < before.length; i++) {
    app.highlightBeat(layer.id, start + i);
    app.refreshLayerVirtualWindows(layer.id, 'cells');
    const now = cellNodes(app, layer.id);
    if (now.length !== before.length || !now.every((n, j) => n === before[j])) churn++;
  }
  assert.equal(churn, 0, 'no rebuild while the playhead stays in range');
});

test('playback: highlightBeat keeps exactly one highlighted cell', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  app.state.isPlaying = true;
  const before = cellNodes(app, layer.id);
  const start = parseInt(before[0].dataset.index, 10);
  app.highlightBeat(layer.id, start);
  app.highlightBeat(layer.id, start + 1);

  const marks = cellNodes(app, layer.id).filter((c) => c.classList.contains('active-playhead'));
  assert.equal(marks.length, 1);
  assert.equal(parseInt(marks[0].dataset.index, 10), start + 1);
});

test('playback: a newly mounted cell receives the current playhead', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const grid = card.querySelector('.subdivision-grid');

  app.state.isPlaying = true;
  app.currentPlayhead.set(layer.id, 20);
  grid.__windowSig = null;
  app.mountCellWindow(layer, card);

  const cell = cellNodes(app, layer.id).find((c) => parseInt(c.dataset.index, 10) === 20);
  assert.ok(cell, 'beat 20 is mounted');
  assert.ok(cell.classList.contains('active-playhead'));
});

test('playback: stop clears highlights without rebuilding', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  app.startPlayback();
  const before = cellNodes(app, layer.id);
  const start = parseInt(before[0].dataset.index, 10);
  app.highlightBeat(layer.id, start);

  app.stopPlayback();
  const marks = cellNodes(app, layer.id).filter((c) => c.classList.contains('active-playhead'));
  assert.equal(marks.length, 0, 'no stale highlight after stop');
  const after = cellNodes(app, layer.id);
  for (let i = 0; i < before.length; i++) assert.equal(after[i], before[i]);
});

test('playback: a signature recorded at beat 100 stays valid at beat 101', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const grid = card.querySelector('.subdivision-grid');

  app.state.isPlaying = true;
  // Reproduce the exact reported sequence: mount with playhead 100, then
  // advance to 101 in place, then a page-scroll refresh.
  app.currentPlayhead.set(layer.id, 100);
  grid.__windowSig = null;
  app.mountCellWindow(layer, card);
  const sig = grid.__windowSig;
  assert.equal(sig.playhead, undefined, 'playhead is not in the structural signature');

  app.highlightBeat(layer.id, 101);
  app.currentPlayhead.set(layer.id, 101);
  const before = cellNodes(app, layer.id);
  app.refreshLayerVirtualWindows(layer.id, 'cells');
  const after = cellNodes(app, layer.id);
  for (let i = 0; i < before.length; i++) assert.equal(after[i], before[i]);
});

// ===========================================================================
// 2. Uncommitted Group input values
// ===========================================================================

test('group-input: an uncommitted value survives a window rebuild', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');

  const input = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  // State still holds 1; the DOM shows a value the user has NOT committed.
  const stateValue = layer.groups[0];
  input.value = '7';
  input.focus();
  assert.equal(layer.groups[0], stateValue, 'change was not dispatched');

  host.__windowSig = null;
  app.refreshLayerVirtualWindows(layer.id, 'groups');

  const again = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  assert.equal(again.value, '7', 'uncommitted value restored');
  assert.equal(app.document.activeElement, again, 'focus restored');
  assert.equal(layer.groups[0], stateValue, 'refresh did not commit the edit');
});

test('group-input: committing after the rebuild updates state normally', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);
  const host = card.querySelector('.groups-tags-list');

  const input = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  input.value = '7';
  input.focus();
  host.__windowSig = null;
  app.refreshLayerVirtualWindows(layer.id, 'groups');

  const again = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  // The delegated change handler must work on the replacement input.
  again.dispatchEvent({ type: 'change' });
  assert.equal(layer.groups[0], 7, 'state committed through the delegated handler');
});

test('group-input: captureVirtualFocus records the raw DOM value', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const card = app.document.getElementById(layer.id);

  const input = tagNodes(app, layer.id)[0].querySelector('.group-tag-val');
  input.value = '99';
  input.focus();
  const focus = app.captureVirtualFocus(card);

  assert.equal(focus.kind, 'group-input');
  assert.equal(focus.value, '99');
  assert.equal(focus.gidx, 0);
});

// ===========================================================================
// 3. Focus restoration and scrolling
// ===========================================================================

test('focus: focusReplacement passes preventScroll', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const cell = cellNodes(app, layer.id)[0];
  const calls = [];
  cell.focus = (opts) => calls.push(opts);
  app.focusReplacement(cell);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].preventScroll, true);
});

test('focus: focusReplacement falls back to a scoped scroll save', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const cell = cellNodes(app, layer.id)[0];
  let fallbackCalls = 0;
  // Reject the options form to force the fallback path.
  cell.focus = (opts) => {
    if (opts && opts.preventScroll) throw new Error('unsupported');
    fallbackCalls++;
  };
  app.focusReplacement(cell);

  assert.equal(fallbackCalls, 1, 'fallback focus was used');
});

test('focus: an unrelated control keeps focus across a refresh', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const other = app.document.createElement('button');
  app.document.body.appendChild(other);
  other.focus();
  const card = app.document.getElementById(layer.id);
  card.querySelector('.groups-tags-list').__windowSig = null;
  card.querySelector('.subdivision-grid').__windowSig = null;
  app.refreshLayerVirtualWindows(layer.id, 'both');

  assert.equal(app.document.activeElement, other);
});

// ===========================================================================
// 4. Flex-gap capacity
// ===========================================================================

test('flex: capacity follows (avail + gap) / (tagWidth + gap)', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const host = app.document.getElementById(layer.id).querySelector('.groups-tags-list');

  const cases = [
    [333, 2], [334, 3], [335, 3],
    [447, 3], [448, 4], [449, 4],
  ];
  for (const [width, expected] of cases) {
    host.__geom = null;
    host.innerHTML = '';
    host.clientWidth = width;
    const geom = app.getGroupGeometry(host, layer);
    assert.equal(geom.itemsPerRow, expected,
      `width ${width}: expected ${expected} per row, got ${geom.itemsPerRow}`);
  }
});

test('flex: geometry exposes tagWidth and gap separately', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const host = app.document.getElementById(layer.id).querySelector('.groups-tags-list');
  host.__geom = null;
  host.innerHTML = '';
  host.clientWidth = 334;

  const geom = app.getGroupGeometry(host, layer);
  assert.equal(geom.tagWidth, POLICY.groupTagWidth);
  assert.equal(geom.gap, POLICY.groupTagGap);
  assert.equal(geom.itemWidth, geom.tagWidth + geom.gap);
});

test('flex: a measured tag width changes capacity correctly', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const host = app.document.getElementById(layer.id).querySelector('.groups-tags-list');

  host.__geom = null;
  host.innerHTML = '<div class="group-tag"></div>';
  const tag = host.querySelector('.group-tag');
  tag.getBoundingClientRect = () => ({ width: 100, height: 30, top: 0, left: 0, bottom: 30, right: 100 });
  host.clientWidth = 316; // 3*100 + 2*8 = 316
  const geom = app.getGroupGeometry(host, layer);
  assert.equal(geom.itemsPerRow, 3);
  assert.equal(geom.itemWidth, 108);
});

test('flex: capacity is always at least one', () => {
  const { app } = loadOne();
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);
  const host = app.document.getElementById(layer.id).querySelector('.groups-tags-list');
  host.__geom = null;
  host.innerHTML = '';
  host.clientWidth = 1;
  assert.equal(app.getGroupGeometry(host, layer).itemsPerRow, 1);
});

// ===========================================================================
// 5. Group move/delete focus
// ===========================================================================

test('group-ops: moving right keeps focus on the moved group', () => {
  const { app } = loadOne({ groups: [2, 3, 4] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const tags = tagNodes(app, layer.id);
  const btn = tags[1].querySelector('.group-move-right');
  btn.focus();
  btn.dispatchEvent({ type: 'click' });

  const active = app.document.activeElement;
  assert.ok(active.className.includes('group-tag-btn'), 'focused a group action button');
  assert.equal(active.disabled, false, 'never focus a disabled boundary button');
  const focusedTag = active.closest('.group-tag');
  assert.equal(parseInt(focusedTag.dataset.gidx, 10), 2, 'focus followed the moved group');
  assert.deepEqual([...layer.groups], [2, 4, 3]);
});

test('group-ops: moving left keeps focus on the moved group', () => {
  const { app } = loadOne({ groups: [2, 3, 4] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const tags = tagNodes(app, layer.id);
  const btn = tags[2].querySelector('.group-move-left');
  btn.focus();
  btn.dispatchEvent({ type: 'click' });

  const focusedTag = app.document.activeElement.closest('.group-tag');
  assert.equal(parseInt(focusedTag.dataset.gidx, 10), 1);
  assert.deepEqual([...layer.groups], [2, 4, 3]);
});

test('group-ops: deleting focuses a surviving neighbour', () => {
  const { app } = loadOne({ groups: [2, 3, 4] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const tags = tagNodes(app, layer.id);
  const btn = tags[1].querySelector('.group-tag-del');
  btn.focus();
  btn.dispatchEvent({ type: 'click' });

  assert.equal(layer.groups.length, 2);
  const active = app.document.activeElement;
  assert.ok(active.className.includes('group-tag-btn'), 'focused a group action button');
  const focusedTag = active.closest('.group-tag');
  assert.ok(focusedTag, 'focus is inside a surviving group tag');
});

test('group-ops: deleting the last group focuses Add Group', () => {
  const { app } = loadOne({ groups: [2] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const btn = tagNodes(app, layer.id)[0].querySelector('.group-tag-del');
  btn.focus();
  btn.dispatchEvent({ type: 'click' });

  assert.equal(layer.groups.length, 0);
  assert.equal(app.document.activeElement.className, 'add-group-btn');
});

test('group-ops: an unrelated control keeps focus during a move', () => {
  const { app } = loadOne({ groups: [2, 3, 4] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  const other = app.document.createElement('button');
  app.document.body.appendChild(other);
  other.focus();

  // Click without focusing the button (pointer activation).
  const tags = tagNodes(app, layer.id);
  tags[1].querySelector('.group-move-right').dispatchEvent({ type: 'click' });

  assert.equal(app.document.activeElement, other, 'no focus stolen');
  assert.deepEqual([...layer.groups], [2, 4, 3]);
});

test('group-ops: a disabled boundary button is never focused', () => {
  const { app } = loadOne({ groups: [2, 3] });
  const layer = app.state.layers[0];
  app.setLayerExpanded(layer.id, true);

  // Move group 1 right: it becomes the last group, so its right button is
  // disabled. Focus must land on an enabled button instead.
  const tags = tagNodes(app, layer.id);
  const btn = tags[0].querySelector('.group-move-right');
  btn.focus();
  btn.dispatchEvent({ type: 'click' });

  assert.equal(app.document.activeElement.disabled, false);
  assert.ok(app.document.activeElement.closest('.group-tag'));
});
