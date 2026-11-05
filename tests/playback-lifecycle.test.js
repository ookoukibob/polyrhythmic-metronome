/**
 * Issue B — visual queue lifecycle across pause / resume / stop / reset and
 * structural layer changes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

function buildApp(options = {}) {
  const harness = loadApp();
  const app = createApp(harness, { now: 100, lookahead: 0.5, ...options });
  app.state.bpm = 120;
  app.state.layers = [
    app.state.createLayer({ name: 'A', numerator: 8, denominator: 8, bpmMultiplier: 1 }),
  ];
  return { app, harness };
}

test('Issue B: pause clears pending visual events', () => {
  const { app } = buildApp();

  app.startPlayback();
  assert.equal(app.state.isPlaying, true);

  app.scheduler();
  assert.ok(app.state.visualQueue.length > 0, 'scheduler should queue events');

  app.pausePlayback();

  assert.equal(app.state.visualQueue.length, 0);
  assert.equal(app.state.isPaused, true);
  assert.equal(app.state.isPlaying, false);
  assert.equal(app.audioEngine.timerId, null);
});

test('Issue B: resume after a long pause does not replay stale events', () => {
  const { app } = buildApp();

  app.startPlayback();
  app.scheduler();
  const scheduledBeforePause = app.state.visualQueue.length;
  assert.ok(scheduledBeforePause > 0);

  app.pausePlayback();

  // AudioContext keeps advancing while paused.
  app.audioEngine.advance(30);

  app.startPlayback();
  assert.equal(app.state.visualQueue.length, 0, 'resume must not inherit old events');

  // First visual frame after resume must not emit anything: the new timeline
  // starts 0.05 s ahead of the resumed clock.
  app.startVisualLoop();
  app.__frameDriver.runFrame();
  assert.deepEqual(list(app.highlighted), []);

  // Advance past the new start offset: only newly scheduled events fire.
  app.scheduler();
  const newEvents = list(app.state.visualQueue);
  assert.ok(newEvents.length > 0);
  const firstNewTime = newEvents[0].audioTime;
  assert.ok(firstNewTime > app.audioEngine.currentTime);

  app.audioEngine.setNow(firstNewTime);
  app.__frameDriver.runFrame();
  assert.equal(app.highlighted.length, 1);
});

test('Issue B: resume preserves the musical subdivision', () => {
  const { app } = buildApp();
  const layer = app.state.layers[0];

  app.startPlayback();
  app.scheduler();

  // Walk a few subdivisions so the position is clearly not zero.
  for (let i = 0; i < 3; i++) {
    app.audioEngine.setNow(app.audioEngine.currentTime + app.state.getSubdivDuration(layer));
    app.scheduler();
    app.__frameDriver.runFrame();
  }

  const positionBeforePause = layer.currentSubdiv;
  assert.ok(positionBeforePause > 0);

  // Subdivisions that were scheduled into the look-ahead window but are not
  // audible yet: these are exactly the ones pause must not silently swallow.
  const unheard = list(app.state.visualQueue)
    .filter((e) => e.audioTime > app.audioEngine.currentTime)
    .map((e) => e.subdivIndex);
  const firstUnheard = unheard.length > 0 ? Math.min(...unheard) : positionBeforePause;

  app.pausePlayback();

  // Position rewinds only to the first click that never sounded — never to 0,
  // never past the last audible beat.
  assert.equal(layer.currentSubdiv, firstUnheard);
  assert.ok(layer.currentSubdiv > 0, 'pause must not reset the position to the start');
  assert.ok(
    layer.currentSubdiv <= positionBeforePause,
    'pause must not skip ahead of the last scheduled subdivision'
  );

  app.audioEngine.advance(5);
  app.startPlayback();

  // Resume continues from that position rather than restarting the bar.
  assert.equal(layer.currentSubdiv, firstUnheard);
  app.scheduler();
  const resumed = list(app.state.visualQueue);
  assert.ok(resumed.length > 0);
  assert.equal(resumed[0].subdivIndex, firstUnheard, 'first resumed event continues the pattern');
});

test('Issue B: stop resets position and clears pending events', () => {
  const { app } = buildApp();
  const layer = app.state.layers[0];

  app.startPlayback();
  app.scheduler();
  app.audioEngine.setNow(app.audioEngine.currentTime + app.state.getSubdivDuration(layer) * 3);
  app.scheduler();
  assert.ok(layer.currentSubdiv > 0);

  app.stopPlayback();

  assert.equal(layer.currentSubdiv, 0);
  assert.equal(app.state.visualQueue.length, 0);
  assert.equal(app.state.isPlaying, false);
  assert.equal(app.state.isPaused, false);
  assert.equal(app.audioEngine.timerId, null);
});

test('Issue B: reset position during playback does not replay old events', () => {
  const { app } = buildApp();
  const layer = app.state.layers[0];

  app.startPlayback();
  app.scheduler();
  const staleCount = app.state.visualQueue.length;
  assert.ok(staleCount > 0);

  app.resetPosition();

  assert.equal(app.state.visualQueue.length, 0);
  assert.equal(layer.currentSubdiv, 0);
  assert.equal(app.state.isPlaying, true, 'reset must not stop playback');
  assert.ok(layer.nextNoteTime > app.audioEngine.currentTime);

  // Old events are gone: a frame right after reset must not paint anything.
  app.startVisualLoop();
  app.__frameDriver.runFrame();
  assert.deepEqual(list(app.highlighted), []);
});

test('Issue B: repeated pause/resume never leaves a second scheduler interval', () => {
  const { app, harness } = buildApp();

  app.startPlayback();
  assert.equal(harness.getActiveIntervals(), 1);

  for (let i = 0; i < 5; i++) {
    app.pausePlayback();
    assert.equal(harness.getActiveIntervals(), 0, `pause #${i + 1} must clear the interval`);
    app.startPlayback();
    assert.equal(harness.getActiveIntervals(), 1, `resume #${i + 1} must leave exactly one interval`);
  }

  // Calling start twice in a row must not stack intervals either.
  app.startPlayback();
  assert.equal(harness.getActiveIntervals(), 1);
  assert.deepEqual(harness.getIntervalMs(), [25], 'scheduler interval stays 25 ms');
});

test('Issue B: pause/stop/reset cancel already-scheduled audio voices', () => {
  const { app } = buildApp();

  app.startPlayback();
  app.scheduler();
  assert.ok(app.audioEngine.clicks.length > 0);

  const before = app.audioEngine.cancelCount;
  app.pausePlayback();
  assert.equal(app.audioEngine.cancelCount, before + 1, 'pause must cancel the look-ahead window');

  app.startPlayback();
  app.scheduler();
  app.stopPlayback();
  assert.equal(app.audioEngine.cancelCount, before + 2, 'stop must cancel scheduled voices');

  app.startPlayback();
  app.scheduler();
  app.resetPosition();
  assert.equal(app.audioEngine.cancelCount, before + 3, 'reset must cancel scheduled voices');
});

test('Issue B: deleting a layer while playing drops its pending visual events', () => {
  const { app } = buildApp();

  app.state.layers.push(
    app.state.createLayer({ name: 'B', numerator: 5, denominator: 8, bpmMultiplier: 2 })
  );
  app.state.isPlaying = true;
  app.state.layers.forEach((layer) => {
    layer.nextNoteTime = app.audioEngine.currentTime;
  });

  app.scheduler();

  const doomed = app.state.layers[1];
  const remaining = app.state.layers[0];
  assert.ok(list(app.state.visualQueue).some((e) => e.layerId === doomed.id));

  app.removeLayer(doomed.id);

  assert.equal(app.state.layers.length, 1);
  assert.equal(app.state.layers[0].id, remaining.id);
  assert.ok(
    !list(app.state.visualQueue).some((e) => e.layerId === doomed.id),
    'no event may reference the deleted layer'
  );
  assert.equal(app.renderCount > 0, true);
});

test('Issue B: removing the last remaining layer is refused', () => {
  const { app } = buildApp();

  app.removeLayer(app.state.layers[0].id);

  assert.equal(app.state.layers.length, 1);
});

test('Issue B: visual loop ignores events while not playing', () => {
  const { app } = buildApp();

  app.state.isPlaying = false;
  app.state.enqueueVisualEvent(app.state.layers[0].id, 0, 0);
  app.startVisualLoop();
  app.__frameDriver.runFrame();

  assert.deepEqual(list(app.highlighted), []);
  assert.equal(app.state.visualQueue.length, 1, 'queue is untouched while stopped');
});

test('Issue B: pause then stop then start yields a clean timeline', () => {
  const { app } = buildApp();

  app.startPlayback();
  app.scheduler();
  app.pausePlayback();
  app.audioEngine.advance(12);
  app.stopPlayback();
  app.audioEngine.advance(3);
  app.startPlayback();

  assert.equal(app.state.visualQueue.length, 0);
  assert.equal(app.state.isPlaying, true);
  assert.equal(app.state.isPaused, false);
  assert.equal(app.state.layers[0].currentSubdiv, 0);

  app.startVisualLoop();
  app.__frameDriver.runFrame();
  assert.deepEqual(list(app.highlighted), []);
});
