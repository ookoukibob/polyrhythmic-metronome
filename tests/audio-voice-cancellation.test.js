/**
 * Issue B (audio side) — clearing the scheduler interval does not cancel
 * oscillator nodes that Web Audio already accepted. The engine must be able to
 * silence the look-ahead window on pause / stop / reset without touching the
 * AudioContext clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

function newEngine() {
  const harness = loadApp();
  const engine = new harness.api.MetronomeAudioEngine();
  engine.ensureContext();
  return { engine, ctx: harness.audioContext };
}

test('audio: playClick schedules a voice and tracks it', () => {
  const { engine } = newEngine();

  engine.playClick(1.0, 'accent', 'classic', 0.8, 1.3);

  assert.equal(engine.activeVoices.size, 1);
  const voice = list(engine.activeVoices)[0];
  assert.ok(voice.nodes.length > 0, 'sources must be tracked for cancellation');
});

test('audio: mute beats schedule nothing', () => {
  const { engine } = newEngine();

  engine.playClick(1.0, 'mute', 'classic', 0.8, 1.3);

  assert.equal(engine.activeVoices.size, 0);
});

test('audio: non-finite time or volume is rejected before creating nodes', () => {
  const { engine, ctx } = newEngine();
  const sourcesBefore = ctx.sources.length;

  engine.playClick(NaN, 'accent', 'classic', 0.8, 1.3);
  engine.playClick(Infinity, 'accent', 'classic', 0.8, 1.3);
  engine.playClick(1.0, 'accent', 'classic', NaN, 1.3);
  engine.playClick(1.0, 'accent', 'classic', 0.8, Infinity);

  assert.equal(engine.activeVoices.size, 0);
  assert.equal(ctx.sources.length, sourcesBefore);
});

test('audio: every synth registers its sources', () => {
  for (const sound of ['classic', 'wood', 'electronic', 'soft', 'cowbell']) {
    const { engine } = newEngine();
    engine.playClick(1.0, 'accent', sound, 0.8, 1.3);
    const voice = list(engine.activeVoices)[0];
    assert.ok(voice && voice.nodes.length > 0, `${sound} must register sources`);
  }
});

test('audio: cancelScheduledVoices stops pending nodes and silences their gain', () => {
  const { engine, ctx } = newEngine();

  engine.playClick(1.0, 'accent', 'classic', 0.8, 1.3);
  engine.playClick(1.05, 'normal', 'wood', 0.8, 1.3);
  assert.equal(engine.activeVoices.size, 2);

  ctx.currentTime = 0.5;
  engine.cancelScheduledVoices();

  assert.equal(engine.activeVoices.size, 0);

  // Each tracked source was re-stopped at the current time, cutting its tail.
  const stopped = list(ctx.sources).filter((s) => s.stopCalls.length > 1);
  assert.equal(stopped.length, ctx.sources.length);
  for (const source of stopped) {
    assert.equal(source.stopCalls[source.stopCalls.length - 1], 0.5);
  }

  // The per-click gain is zeroed so a cancelled exponential ramp cannot
  // re-emerge from its old curve.
  for (const gain of ctx.gains) {
    if (!gain.gain.events.length) continue;
    const zeroed = gain.gain.events.some((e) => e[0] === 'setValueAtTime' && e[1] === 0);
    if (gain.gain.events.some((e) => e[0] === 'cancelScheduledValues')) {
      assert.ok(zeroed, 'cancelled gain must be set to 0');
    }
  }
});

test('audio: cancelling twice is safe', () => {
  const { engine, ctx } = newEngine();

  engine.playClick(1.0, 'accent', 'classic', 0.8, 1.3);
  ctx.currentTime = 0.2;
  engine.cancelScheduledVoices();

  assert.doesNotThrow(() => engine.cancelScheduledVoices());
  assert.equal(engine.activeVoices.size, 0);
});

test('audio: the AudioContext clock is never suspended or rewound', async () => {
  const { engine, ctx } = newEngine();

  engine.playClick(1.0, 'accent', 'classic', 0.8, 1.3);
  ctx.currentTime = 0.5;
  const before = ctx.currentTime;
  engine.cancelScheduledVoices();

  assert.equal(ctx.currentTime, before, 'currentTime must keep advancing');
  assert.equal(ctx.state, 'running', 'the context must not be suspended');
  assert.equal(await ctx.suspend(), undefined);
});

test('audio: finished voices are pruned, not accumulated forever', () => {
  const { engine, ctx } = newEngine();

  engine.playClick(1.0, 'accent', 'classic', 0.8, 1.3);
  assert.equal(engine.activeVoices.size, 1);

  // Past the longest tail (cowbell 0.28 s) plus margin.
  ctx.currentTime = 10;
  engine.playClick(10.0, 'normal', 'classic', 0.8, 1.3);

  assert.equal(engine.activeVoices.size, 1, 'the finished voice is pruned');
});

test('audio: cancel is a no-op before the context exists', () => {
  const harness = loadApp();
  const engine = new harness.api.MetronomeAudioEngine();

  assert.doesNotThrow(() => engine.cancelScheduledVoices());
  assert.equal(engine.activeVoices.size, 0);
});

test('audio: look-ahead and interval constants are unchanged', () => {
  const harness = loadApp();
  const engine = new harness.api.MetronomeAudioEngine();

  assert.equal(engine.lookahead, 0.08);
  assert.equal(engine.scheduleInterval, 25);
});
