/**
 * Performance probe for the visual queue.
 *
 * This file measures; it does not change behaviour and it does not assert
 * absolute wall-clock budgets (those are machine-dependent). It asserts only
 * structural invariants — ordering and drain correctness — and prints the
 * numbers so a regression is visible.
 *
 * MEASUREMENT DISCIPLINE (see the report for the numbers):
 *
 *  - Timed region for a "scheduler pass" is exactly `app.scheduler()`:
 *    from the call to its return. Nothing else is inside the timer.
 *  - Draining the queue (`takeDueVisualEvents`) and advancing the fake clock
 *    happen AFTER the timer stops, so a pass is never charged for them.
 *  - The fake engine records every click into an array. Left unbounded that
 *    array grows to hundreds of thousands of objects and its GC pressure lands
 *    inside the measured region, which is what made earlier runs of this file
 *    non-comparable. The recording sink is therefore bounded per pass: the
 *    array is cleared between passes so the workload is identical every pass
 *    and only the scheduler's own work is timed.
 *  - Warm-up passes are discarded and never enter the samples.
 *  - p50/p95/max are nearest-rank on the sorted sample array:
 *    index = floor(n * p) for p < 1, and n - 1 for max.
 *  - Every configuration compared in one table is built by the same builder,
 *    run for the same number of passes, on the same warm-up.
 *
 * The queue implementation is intentionally left unchanged.
 *
 * Run with: node --test tests/visual-queue-perf.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, createApp } = require('./helpers/app-harness');

const list = (iterable) => Array.from(iterable);

// Passes used for every measured run in this file, so all numbers in the
// report come from the same sample size.
const PASSES = 120;
const WARMUP_PASSES = 10;

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const mean = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
  return {
    n: samplesMs.length,
    mean,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted[sorted.length - 1],
  };
}

function line(label, s, unit = 'ms') {
  console.log(
    `[perf] ${label}: n=${s.n} mean=${s.mean.toFixed(2)}${unit} ` +
      `p50=${s.p50.toFixed(2)}${unit} p95=${s.p95.toFixed(2)}${unit} max=${s.max.toFixed(2)}${unit}`
  );
}

function newState() {
  const harness = loadApp();
  return { state: new harness.api.MetronomeState(), limits: harness.api.METRONOME_LIMITS };
}

// The largest configuration the UI and validator both allow.
// recordClicks:false makes the fake engine tally clicks instead of retaining
// an object per click — the app itself keeps no such history, and retaining it
// here would put allocation/GC pressure inside the timed region.
function buildMaximalApp(harness, overrides = {}) {
  const L = harness.api.METRONOME_LIMITS;
  const app = createApp(harness, { now: 0, lookahead: 0.08, recordClicks: false });
  app.state.bpm = 600;
  app.state.layers = Array.from({ length: L.maxLayers }, (_, i) =>
    app.state.createLayer({
      name: `L${i}`,
      numerator: L.numerator.max,
      denominator: L.denominator.max,
      bpmMultiplier: 1 + i * 0.1,
      groups: overrides.groups ? overrides.groups.slice() : new Array(L.maxGroupEntries).fill(1),
    })
  );
  app.state.isPlaying = true;
  app.state.layers.forEach((layer) => {
    layer.nextNoteTime = 0;
  });
  return app;
}

/**
 * Time scheduler passes with a fixed warm-up and identical setup per run.
 *
 * The click sink is a counter (recordClicks:false): the shipped app keeps no
 * per-click history, so retaining objects here would charge allocation and GC
 * to the timed region and make pass 1 and pass 120 measure different work.
 *
 * Returns per-pass scheduler timings plus drain timings measured separately,
 * so the two are never conflated in the report.
 */
function measureScheduler(app, { passes = PASSES, warmup = WARMUP_PASSES } = {}) {
  const runPass = () => {
    const t0 = process.hrtime.bigint();
    app.scheduler();
    const t1 = process.hrtime.bigint();
    app.state.takeDueVisualEvents(app.audioEngine.currentTime);
    const t2 = process.hrtime.bigint();
    app.audioEngine.advance(0.025);
    return {
      schedMs: Number(t1 - t0) / 1e6,
      drainMs: Number(t2 - t1) / 1e6,
    };
  };

  for (let i = 0; i < warmup; i++) runPass();

  const schedSamples = [];
  const drainSamples = [];
  let maxQueue = 0;

  for (let i = 0; i < passes; i++) {
    const { schedMs, drainMs } = runPass();
    schedSamples.push(schedMs);
    drainSamples.push(drainMs);
    maxQueue = Math.max(maxQueue, app.state.visualQueue.length);
  }

  return {
    sched: summarize(schedSamples),
    drain: summarize(drainSamples),
    schedSamples,
    maxQueue,
    clicksPerPass: app.audioEngine.clickCount,
  };
}

/**
 * Run `measureScheduler` on `rounds` independently built apps and keep the
 * MEDIAN round's summary.
 *
 * Why: the scheduler pass time on this workload is bimodal across whole
 * processes (roughly 6 ms or ~21 ms for the identical configuration) depending
 * on how V8 has tiered the hot functions in that process. A single round is
 * therefore not reproducible. Reporting the median of several fresh rounds is,
 * and the spread is printed so the variance is visible rather than hidden.
 */
function measureRounds(buildFn, rounds = 3, options = {}) {
  const perRound = [];
  for (let i = 0; i < rounds; i++) {
    perRound.push(measureScheduler(buildFn(), options));
  }
  const p50s = perRound.map((r) => r.sched.p50);
  const order = [...p50s].sort((a, b) => a - b);
  const medianP50 = order[Math.floor(order.length / 2)];
  const chosen = perRound[p50s.indexOf(medianP50)];
  return { chosen, perRound, p50s, spread: [order[0], order[order.length - 1]] };
}

// ---------------------------------------------------------------------------
// Insert cost vs queue depth
// ---------------------------------------------------------------------------

test('perf: ordered insert cost grows with queue depth', () => {
  const { state } = newState();
  const results = [];

  for (const depth of [1000, 13600, 27000]) {
    state.clearVisualQueue();
    for (let i = 0; i < depth; i++) {
      state.enqueueVisualEvent(`l${i % 64}`, i, 100 + i * 0.0001);
    }

    const inserts = 5000;
    const start = process.hrtime.bigint();
    for (let i = 0; i < inserts; i++) {
      // Insert into the middle so the splice actually moves elements.
      state.enqueueVisualEvent(`l${i % 64}`, i, 100 + (i % depth) * 0.0001 + 5e-7);
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    results.push({ depth, elapsedMs, perInsertUs: (elapsedMs * 1000) / inserts });
    console.log(
      `[perf] depth=${depth} inserts=${inserts} total=${elapsedMs.toFixed(2)}ms ` +
        `per-insert=${((elapsedMs * 1000) / inserts).toFixed(3)}us`
    );

    // Structural invariant holds at every depth.
    const queue = list(state.visualQueue);
    for (let i = 1; i < queue.length; i++) {
      assert.ok(queue[i].audioTime >= queue[i - 1].audioTime, 'queue stays ordered');
    }
  }

  // Cost per insert must grow with depth (this is the documented risk: the
  // ordered insert uses Array#splice, so it moves the tail).
  assert.ok(
    results[2].perInsertUs > results[0].perInsertUs,
    'insert cost should scale with queue depth'
  );
});

test('perf: plain push is much cheaper than ordered insert at depth', () => {
  const { state } = newState();
  const depth = 27000;
  const ops = 5000;

  state.clearVisualQueue();
  for (let i = 0; i < depth; i++) {
    state.enqueueVisualEvent(`l${i % 64}`, i, 100 + i * 0.0001);
  }

  let start = process.hrtime.bigint();
  for (let i = 0; i < ops; i++) {
    state.enqueueVisualEvent(`l${i % 64}`, i, 100 + (i % depth) * 0.0001 + 5e-7);
  }
  const orderedMs = Number(process.hrtime.bigint() - start) / 1e6;

  state.clearVisualQueue();
  start = process.hrtime.bigint();
  for (let i = 0; i < ops; i++) {
    state.visualQueue.push({ layerId: 'l', subdivIndex: i, audioTime: 100 + i });
  }
  const pushMs = Number(process.hrtime.bigint() - start) / 1e6;

  console.log(
    `[perf] depth=${depth}: ordered-insert=${orderedMs.toFixed(2)}ms ` +
      `plain-push=${pushMs.toFixed(2)}ms ratio=${(orderedMs / pushMs).toFixed(1)}x`
  );

  assert.ok(orderedMs >= pushMs, 'ordered insert is never cheaper than push');
});

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

test('perf: draining a large due batch', () => {
  const { state, limits } = newState();
  const total = limits.maxLayers * 64;

  const samples = [];
  for (let pass = 0; pass < 30; pass++) {
    state.clearVisualQueue();
    for (let i = 0; i < total; i++) {
      state.enqueueVisualEvent(`l${i % limits.maxLayers}`, i, 100 + i * 0.0001);
    }

    const start = process.hrtime.bigint();
    const due = state.takeDueVisualEvents(1e9);
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);

    assert.equal(due.length, total, 'every due event is returned');
    assert.equal(state.visualQueue.length, 0, 'the queue is emptied');
  }

  line(`drain ${total} due events`, summarize(samples));
});

test('perf: draining is proportional to the number of due events', () => {
  const { state } = newState();

  const timeDrain = (count) => {
    state.clearVisualQueue();
    for (let i = 0; i < count; i++) {
      state.enqueueVisualEvent('l0', i, 100 + i * 0.0001);
    }
    const start = process.hrtime.bigint();
    state.takeDueVisualEvents(1e9);
    return Number(process.hrtime.bigint() - start) / 1e6;
  };

  // Warm up so the first call does not pay JIT costs.
  timeDrain(1000);
  timeDrain(1000);

  const small = Math.min(...Array.from({ length: 5 }, () => timeDrain(1000)));
  const large = Math.min(...Array.from({ length: 5 }, () => timeDrain(20000)));

  console.log(`[perf] drain 1000=${small.toFixed(3)}ms drain 20000=${large.toFixed(3)}ms`);
  assert.ok(large >= small, 'a bigger batch is never faster than a small one');
});

// ---------------------------------------------------------------------------
// Scheduler at the legal maximum
// ---------------------------------------------------------------------------

test('perf: sustained scheduler passes at the largest legal configuration', () => {
  const harness = loadApp();
  const { chosen, perRound, p50s, spread } = measureRounds(() => buildMaximalApp(harness));

  line(`scheduler pass (64 layers @ 600 BPM, n=${PASSES}, median of ${perRound.length} rounds)`, chosen.sched);
  line('drain per pass (measured outside the scheduler timer)', chosen.drain);
  console.log(`[perf] peak queue depth=${chosen.maxQueue}, clicks scheduled in run=${chosen.clicksPerPass}`);
  console.log(
    `[perf] per-round p50: ${p50s.map((v) => v.toFixed(2)).join(', ')}ms ` +
      `(spread ${spread[0].toFixed(2)}–${spread[1].toFixed(2)}ms)`
  );

  // Structural invariants only.
  assert.ok(chosen.maxQueue > 0, 'the workload produced events');
  assert.equal(chosen.sched.n, PASSES);

  const overBudget = chosen.schedSamples.filter((ms) => ms > 25).length;
  console.log(
    `[perf] passes over the 25ms interval (median round): ${overBudget}/${chosen.sched.n} ` +
      `(${((overBudget / chosen.sched.n) * 100).toFixed(1)}%)`
  );
});

test('perf: scheduler cost attributed to enqueue (same config, same passes, same rounds)', () => {
  const harness = loadApp();

  // Both runs use the identical builder, warm-up, pass count and round count,
  // so the two numbers are directly comparable. The only difference is whether
  // the queue insert happens.
  const withQueue = measureRounds(() => buildMaximalApp(harness));
  const withoutQueue = measureRounds(() => {
    const app = buildMaximalApp(harness);
    app.state.enqueueVisualEvent = () => {};
    return app;
  });

  line('scheduler WITH enqueue (median round)', withQueue.chosen.sched);
  line('scheduler WITHOUT enqueue (median round)', withoutQueue.chosen.sched);
  console.log(
    `[perf] per-round p50 WITH   : ${withQueue.p50s.map((v) => v.toFixed(2)).join(', ')}ms`
  );
  console.log(
    `[perf] per-round p50 WITHOUT: ${withoutQueue.p50s.map((v) => v.toFixed(2)).join(', ')}ms`
  );
  console.log(
    `[perf] enqueue share (median rounds): p50=${(withQueue.chosen.sched.p50 - withoutQueue.chosen.sched.p50).toFixed(2)}ms ` +
      `p95=${(withQueue.chosen.sched.p95 - withoutQueue.chosen.sched.p95).toFixed(2)}ms ` +
      `max=${(withQueue.chosen.sched.max - withoutQueue.chosen.sched.max).toFixed(2)}ms`
  );

  assert.equal(withQueue.chosen.sched.n, withoutQueue.chosen.sched.n, 'same sample size');
  assert.equal(withQueue.chosen.sched.n, PASSES);
  assert.ok(withQueue.chosen.sched.p50 >= withoutQueue.chosen.sched.p50, 'enqueue adds cost, never removes it');
});

test('perf: getBeatType group scan cost (reported, not asserted)', () => {
  const harness = loadApp();

  // Same builder, same warm-up, same pass count and round count for both.
  const manyGroups = measureRounds(() => buildMaximalApp(harness, { groups: new Array(1024).fill(1) }));
  const fewGroups = measureRounds(() => buildMaximalApp(harness, { groups: [1024] }));

  line('scheduler, groups=1024 (median round)', manyGroups.chosen.sched);
  line('scheduler, groups=1 (median round)', fewGroups.chosen.sched);
  console.log(
    `[perf] per-round p50 groups=1024: ${manyGroups.p50s.map((v) => v.toFixed(2)).join(', ')}ms`
  );
  console.log(
    `[perf] per-round p50 groups=1   : ${fewGroups.p50s.map((v) => v.toFixed(2)).join(', ')}ms`
  );

  // Deliberately no cross-config speed assertion: the spread between rounds is
  // larger than the difference between these two configurations, so any
  // comparison would be noise. The numbers are reported for inspection only.
  assert.equal(manyGroups.chosen.sched.n, fewGroups.chosen.sched.n, 'same sample size');
  assert.ok(Number.isFinite(manyGroups.chosen.sched.p50) && Number.isFinite(fewGroups.chosen.sched.p50));
});
