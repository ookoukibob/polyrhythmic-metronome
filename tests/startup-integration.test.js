/**
 * Integration — startup path with a malformed hash, and the transport as a
 * whole. This drives MetronomeApp.init() with the view layer stubbed so the
 * configuration-loading branch that runs at boot is exercised for real.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

// Boot the app the way init() does, without building real DOM cards.
function boot(harness, hash) {
  harness.window.location.hash = hash;
  const app = createApp(harness, { now: 0 });

  // The default preset table from the shipped app.
  app.factoryPresetsData = [
    {
      name: 'default 59/16',
      bpm: 140,
      layers: [
        {
          name: 'Main Meter (59/16)',
          numerator: 59,
          denominator: 16,
          groups: [3, 3, 2, 5, 7, 4, 6, 5, 2, 3, 4, 5, 3, 3, 4],
          sound: 'classic',
          volume: 0.85,
          accentVolume: 1.4,
        },
      ],
    },
  ];

  // init() minus DOM wiring.
  if (!app.loadStateFromUrl()) {
    app.loadPresetData(app.factoryPresetsData[0]);
  }
  return app;
}

test('startup: a valid hash boots from the URL', () => {
  const harness = loadApp();
  const payload = {
    bpm: 210,
    layers: [{ n: 'From URL', num: 13, den: 8, mul: 1, g: [3, 3, 3, 2, 2], ov: [], snd: 'wood', vol: 0.7, av: 1.2, m: 0 }],
  };
  const hash = '#' + Buffer.from(encodeURIComponent(JSON.stringify(payload)), 'binary').toString('base64');

  const app = boot(harness, hash);

  assert.equal(app.state.bpm, 210);
  assert.equal(app.state.layers.length, 1);
  assert.equal(app.state.layers[0].name, 'From URL');
  assert.equal(app.state.layers[0].numerator, 13);
});

test('startup: a malformed hash falls back to the default preset', () => {
  const harness = loadApp();
  const app = boot(harness, '#%%%garbage%%%');

  assert.equal(app.state.layers.length, 1, 'the default preset still loaded');
  assert.equal(app.state.layers[0].numerator, 59);
  assert.equal(app.state.bpm, 140);
});

test('startup: a hash whose layers are all invalid falls back to the default preset', () => {
  const harness = loadApp();
  const payload = { bpm: 999, layers: [{ n: 'bad', num: 'NaN', g: 'nope' }] };
  const hash = '#' + Buffer.from(encodeURIComponent(JSON.stringify(payload)), 'binary').toString('base64');

  const app = boot(harness, hash);

  assert.equal(app.state.bpm, 140, 'invalid BPM did not leak through');
  assert.equal(app.state.layers[0].numerator, 59);
});

test('startup: no hash boots the default preset', () => {
  const harness = loadApp();
  const app = boot(harness, '');

  assert.equal(app.state.layers.length, 1);
  assert.equal(app.state.bpm, 140);
  assert.deepEqual(list(app.state.layers[0].groups), [3, 3, 2, 5, 7, 4, 6, 5, 2, 3, 4, 5, 3, 3, 4]);
});

test('startup: loaded state is immediately schedulable', () => {
  const harness = loadApp();
  const app = boot(harness, '');

  app.startPlayback();
  app.scheduler();

  const queue = list(app.state.visualQueue);
  assert.ok(queue.length > 0);
  for (const event of queue) {
    assert.ok(Number.isFinite(event.audioTime), 'no NaN timestamps reach the queue');
    assert.ok(event.audioTime >= 0);
  }
  for (const click of list(app.audioEngine.clicks)) {
    assert.ok(Number.isFinite(click.time));
    assert.ok(Number.isFinite(click.volume));
    assert.ok(Number.isFinite(click.accentVolume));
  }
});

test('integration: a full play -> pause -> resume -> stop cycle stays consistent', () => {
  const harness = loadApp();
  const app = boot(harness, '');
  const layer = app.state.layers[0];

  app.startPlayback();
  app.startVisualLoop();
  for (let i = 0; i < 4; i++) {
    app.audioEngine.advance(0.05);
    app.scheduler();
    harness.runFrame();
  }
  assert.ok(app.highlighted.length > 0, 'playhead advanced');

  app.pausePlayback();
  const pausedAt = layer.currentSubdiv;
  assert.equal(app.state.visualQueue.length, 0);

  app.audioEngine.advance(20);
  app.startPlayback();
  assert.equal(layer.currentSubdiv, pausedAt, 'position carried over');
  assert.equal(harness.getActiveIntervals(), 1);

  app.stopPlayback();
  assert.equal(layer.currentSubdiv, 0);
  assert.equal(app.state.visualQueue.length, 0);
  assert.equal(harness.getActiveIntervals(), 0);
});

test('integration: switching preset mid-playback keeps one scheduler', () => {
  const harness = loadApp();
  const app = boot(harness, '');

  app.startPlayback();
  app.scheduler();
  assert.equal(harness.getActiveIntervals(), 1);

  app.loadPresetData({
    name: 'switch',
    bpm: 88,
    layers: [{ name: 'S', numerator: 5, denominator: 8, groups: [3, 2] }],
  });

  // loadPresetData stops (clearing the interval) then resumes, so exactly one
  // interval remains and the queue belongs to the new timeline.
  assert.equal(harness.getActiveIntervals(), 1);
  assert.equal(app.state.bpm, 88);
  assert.equal(app.state.layers[0].numerator, 5);
  assert.ok(list(app.state.visualQueue).every((e) => Number.isFinite(e.audioTime)));

  app.stopPlayback();
  assert.equal(harness.getActiveIntervals(), 0);
});
