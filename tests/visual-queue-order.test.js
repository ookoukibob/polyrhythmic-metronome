/**
 * Issue A — visual queue must be ordered globally by audioTime, not by the
 * order in which layers were iterated.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

function makeState() {
  const harness = loadApp();
  return new harness.api.MetronomeState();
}

// The app runs inside a vm context, so arrays it creates have a different
// Array prototype. Rebuild them in this realm before strict comparison.
const list = (iterable) => Array.from(iterable);

test('Issue A: later event inserted first does not block an earlier one', () => {
  const state = makeState();

  state.enqueueVisualEvent('layerA', 0, 1.1);
  state.enqueueVisualEvent('layerB', 0, 1.02);

  assert.equal(state.visualQueue[0].layerId, 'layerB');
  assert.equal(state.visualQueue[1].layerId, 'layerA');
  assert.deepEqual(
    list(state.visualQueue).map((e) => e.audioTime),
    [1.02, 1.1]
  );
});

test('Issue A: queue stays ordered across interleaved layer insertion', () => {
  const state = makeState();

  // Layer A at 1.10, 1.20, 1.30 — layer B at 1.02, 1.07, 1.12.
  state.enqueueVisualEvent('layerA', 0, 1.1);
  state.enqueueVisualEvent('layerB', 0, 1.02);
  state.enqueueVisualEvent('layerA', 1, 1.2);
  state.enqueueVisualEvent('layerB', 1, 1.07);
  state.enqueueVisualEvent('layerA', 2, 1.3);
  state.enqueueVisualEvent('layerB', 2, 1.12);

  const audioTimes = list(state.visualQueue).map((e) => e.audioTime);
  assert.deepEqual(audioTimes, [...audioTimes].sort((a, b) => a - b));
  assert.deepEqual(
    list(state.visualQueue).map((e) => `${e.layerId}:${e.subdivIndex}`),
    ['layerB:0', 'layerB:1', 'layerA:0', 'layerB:2', 'layerA:1', 'layerA:2']
  );
});

test('Issue A: identical timestamps keep insertion (FIFO) order', () => {
  const state = makeState();

  state.enqueueVisualEvent('first', 0, 2.0);
  state.enqueueVisualEvent('second', 0, 2.0);
  state.enqueueVisualEvent('third', 0, 2.0);

  assert.deepEqual(
    list(state.visualQueue).map((e) => e.layerId),
    ['first', 'second', 'third']
  );

  const due = state.takeDueVisualEvents(2.0);
  assert.deepEqual(
    list(due).map((e) => e.layerId),
    ['first', 'second', 'third']
  );
  assert.equal(state.visualQueue.length, 0);
});

test('Issue A: due events drain in chronological order without blocking', () => {
  const state = makeState();

  state.enqueueVisualEvent('layerA', 0, 1.1);
  state.enqueueVisualEvent('layerB', 0, 1.02);

  // Nothing due yet.
  assert.equal(state.takeDueVisualEvents(1.0).length, 0);

  // Only the earlier one is due; the later one must not block it.
  const first = state.takeDueVisualEvents(1.05);
  assert.deepEqual(list(first).map((e) => e.layerId), ['layerB']);
  assert.equal(state.visualQueue.length, 1);

  const second = state.takeDueVisualEvents(1.1);
  assert.deepEqual(list(second).map((e) => e.layerId), ['layerA']);
  assert.equal(state.visualQueue.length, 0);
});

test('Issue A: non-finite audioTime is not queued', () => {
  const state = makeState();

  state.enqueueVisualEvent('layerA', 0, NaN);
  state.enqueueVisualEvent('layerA', 1, Infinity);
  state.enqueueVisualEvent('layerA', 2, -Infinity);
  state.enqueueVisualEvent('layerA', 3, undefined);

  assert.equal(state.visualQueue.length, 0);

  state.enqueueVisualEvent('layerA', 4, 1.5);
  assert.equal(state.visualQueue.length, 1);
});

test('Issue A: clearVisualQueue empties the queue and resets the tie-breaker', () => {
  const state = makeState();

  state.enqueueVisualEvent('layerA', 0, 1.1);
  state.enqueueVisualEvent('layerB', 0, 1.2);
  assert.equal(state.visualQueue.length, 2);

  state.clearVisualQueue();
  assert.equal(state.visualQueue.length, 0);
  assert.equal(state.visualSeq, 0);
});

test('Issue A: scheduler enqueues multi-layer events in chronological order', () => {
  const harness = loadApp();
  const app = createApp(harness, { now: 100, lookahead: 0.6 });

  app.state.bpm = 120;
  // Layer A: 4/4, multiplier 1  -> subdivision = 0.5 s
  // Layer B: 4/4, multiplier 2  -> subdivision = 0.25 s
  app.state.layers = [
    app.state.createLayer({ name: 'A', numerator: 4, denominator: 4, bpmMultiplier: 1 }),
    app.state.createLayer({ name: 'B', numerator: 4, denominator: 4, bpmMultiplier: 2 }),
  ];
  app.state.isPlaying = true;
  app.state.layers.forEach((layer) => {
    layer.nextNoteTime = 100.01;
  });

  app.scheduler();

  const queue = app.state.visualQueue;
  assert.ok(queue.length >= 3, `expected several scheduled events, got ${queue.length}`);

  const audioTimes = list(queue).map((e) => e.audioTime);
  assert.deepEqual(audioTimes, [...audioTimes].sort((a, b) => a - b));

  // Both layers are represented — the faster layer must not be starved.
  const layerIds = new Set(list(queue).map((e) => e.layerId));
  assert.equal(layerIds.size, 2);
});

test('Issue A: audio scheduling is unaffected by queue ordering', () => {
  const harness = loadApp();
  const app = createApp(harness, { now: 50 });

  app.state.bpm = 120;
  app.state.layers = [
    app.state.createLayer({ name: 'A', numerator: 4, denominator: 4, bpmMultiplier: 1 }),
    app.state.createLayer({ name: 'B', numerator: 4, denominator: 4, bpmMultiplier: 4 }),
  ];
  app.state.isPlaying = true;
  app.state.layers.forEach((layer) => {
    layer.nextNoteTime = 50.01;
  });

  app.scheduler();

  const clickTimes = list(app.audioEngine.clicks).map((c) => c.time);
  assert.ok(clickTimes.length > 0);

  const layerA = app.state.layers[0];
  const layerB = app.state.layers[1];
  const expectedA = [];
  for (let t = 50.01; t < 50 + app.audioEngine.lookahead; t += app.state.getSubdivDuration(layerA)) {
    expectedA.push(t);
  }
  // Audio events still follow the legacy per-layer order and timing.
  assert.deepEqual(clickTimes.slice(0, expectedA.length), expectedA);
  assert.equal(app.state.getSubdivDuration(layerB), app.state.getSubdivDuration(layerA) / 4);
});

test('Issue A: single-layer behaviour is unchanged', () => {
  const harness = loadApp();
  const app = createApp(harness, { now: 10, lookahead: 0.5 });

  app.state.bpm = 140;
  app.state.layers = [app.state.createLayer({ name: 'only', numerator: 4, denominator: 16 })];
  app.state.isPlaying = true;
  app.state.layers[0].nextNoteTime = 10.0;

  app.scheduler();

  const queue = list(app.state.visualQueue);
  assert.ok(queue.length > 0);
  for (let i = 1; i < queue.length; i++) {
    assert.ok(queue[i].audioTime > queue[i - 1].audioTime);
  }
  assert.deepEqual(
    queue.map((e) => e.subdivIndex),
    queue.map((_, i) => i % 4)
  );
});

test('Issue A: visual loop processes every due event in one frame', () => {
  const harness = loadApp();
  const app = createApp(harness, { now: 100 });

  app.state.isPlaying = true;
  app.state.enqueueVisualEvent('layerA', 0, 100.1);
  app.state.enqueueVisualEvent('layerB', 0, 100.02);
  app.state.enqueueVisualEvent('layerA', 1, 100.06);

  app.audioEngine.setNow(100.2);
  app.startVisualLoop();
  harness.runFrame();

  assert.deepEqual(
    list(app.highlighted).map((h) => `${h.layerId}:${h.subdivIndex}`),
    ['layerB:0', 'layerA:1', 'layerA:0']
  );
  assert.equal(app.state.visualQueue.length, 0);
});

test('Issue A: visual loop leaves future events queued', () => {
  const harness = loadApp();
  const app = createApp(harness, { now: 100 });

  app.state.isPlaying = true;
  app.state.enqueueVisualEvent('layerA', 0, 100.02);
  app.state.enqueueVisualEvent('layerA', 1, 100.5);

  app.audioEngine.setNow(100.1);
  app.startVisualLoop();
  harness.runFrame();

  assert.deepEqual(list(app.highlighted).map((h) => h.subdivIndex), [0]);
  assert.equal(app.state.visualQueue.length, 1);
  assert.equal(app.state.visualQueue[0].subdivIndex, 1);
});
