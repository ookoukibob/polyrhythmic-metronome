/**
 * Polyrhythmic Metronome
 * Pure Vanilla JavaScript + Web Audio API
 * Fully Standalone — No Server / Node Required
 */

// ============================================================================
// 0. Shared Configuration Constraints
// ============================================================================
// Single source of truth for every value that can arrive from the UI, a
// shared URL hash or a saved preset. Both import paths run through
// MetronomeState.normalizeConfiguration(), so neither can bypass these limits.

const METRONOME_LIMITS = Object.freeze({
  bpm: { min: 20, max: 600 },
  numerator: { min: 1, max: 1024 },
  denominator: { min: 1, max: 256 },
  bpmMultiplier: { min: 0.1, max: 8 },
  volume: { min: 0, max: 1 },
  accentVolume: { min: 0.5, max: 2 },
  groupSize: { min: 1, max: 512 },
  maxLayers: 64,
  maxGroupEntries: 1024,
  maxOverrides: 1024,
  maxNameLength: 200,
  maxPayloadLength: 200000,
});

const METRONOME_SOUNDS = ['classic', 'wood', 'electronic', 'soft', 'cowbell'];
const METRONOME_BEAT_TYPES = ['accent', 'normal', 'mute'];

// Rendering thresholds for the layer list. Kept in one place so the collapse
// policy is not re-derived in individual handlers.
//
// A layer's "detail" (grouping tags + subdivision grid) is what costs DOM:
// a full 1024-subdivision card is ~9.3k nodes. Above these thresholds the
// list starts collapsed and detail is built only when a layer is expanded.
const LAYER_RENDER_POLICY = Object.freeze({
  // Collapse detail by default when the configuration is at least this big.
  autoCollapseLayerCount: 8,
  autoCollapseTotalSubdivisions: 4000,
  // A layer whose own subdivision count exceeds this also starts collapsed,
  // even when the whole configuration is small (e.g. a single 59/16 layer is
  // fine, but a single 1024-subdivision layer is not).
  autoCollapseLayerSubdivisions: 512,
});

// Virtualisation budget for the per-layer detail. Detail content (group tags
// and pattern cells) is mounted only for the slice near the viewport, so DOM
// stays bounded no matter how many layers are expanded or how big they are.
//
// Measured sizes used to place spacers without measuring the DOM on every
// scroll. They are intentionally the design constants from style.css; a real
// measurement overrides them per layer on first render.
const VIRTUAL_POLICY = Object.freeze({
  // Extra items mounted above/below the visible slice, to hide scroll gaps.
  overscanItems: 6,
  // Force at least this many items mounted even when the viewport is unknown
  // (e.g. first paint before layout has happened).
  minWindowItems: 24,
  // Below this many items, mounting everything is cheaper than virtualising.
  fullRenderThreshold: 120,
  // Fallback geometry, used until a layer's real size is measured.
  fallbackTagWidth: 92,   // .group-tag incl. gap
  fallbackTagHeight: 30,  // .group-tag height incl. row gap
  fallbackCellWidth: 34,  // .subdiv-cell-wrap incl. gap
  fallbackCellHeight: 60, // .subdiv-cell-wrap full height
  // Deceleration window for scroll events: one rAF batch per frame.
  scrollSettleMs: 16,
});

// Accept JSON numbers and numeric strings; reject NaN, Infinity and junk.
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// Numeric but out of range is clamped, exactly like the UI inputs do.
// Non-numeric / non-finite values fall back instead of reaching the scheduler.
function clampNumber(value, range, fallback) {
  const n = toFiniteNumber(value);
  if (n === null) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

function clampInt(value, range, fallback) {
  const n = toFiniteNumber(value);
  if (n === null) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(n)));
}

function normalizeName(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, METRONOME_LIMITS.maxNameLength);
  return trimmed || fallback;
}

// One group size, clamped to exactly the range normalizeGroups() accepts.
// The UI uses this so it cannot produce a grouping that import would reject.
function clampGroupValue(value) {
  return clampInt(value, METRONOME_LIMITS.groupSize, METRONOME_LIMITS.groupSize.min);
}

// The import path compares the length of the encoded fragment it reads back
// from location.hash. Export must measure the same string, otherwise a link
// could be generated that this app refuses to load.
function isPayloadWithinLimit(encodedHash) {
  return typeof encodedHash === 'string' && encodedHash.length <= METRONOME_LIMITS.maxPayloadLength;
}

// ============================================================================
// Virtualisation window maths (pure functions, no DOM)
// ============================================================================
//
// Both the group-tag list and the pattern grid mount only a slice of their
// items. These helpers turn "how much of the list is on screen" into an
// [start, end) index range plus the spacer sizes that keep the scroll geometry
// identical to a fully-rendered list.

// Number of items in the viewport, given the item size along the scroll axis.
function itemsPerViewport(viewportSize, itemSize) {
  const size = toFiniteNumber(itemSize);
  if (size === null || size <= 0) return 0;
  const view = toFiniteNumber(viewportSize);
  if (view === null || view <= 0) return 0;
  return view / size;
}

/**
 * Compute the mounted slice for a one-dimensional virtual list.
 *
 * `scrollOffset` is how far the list's own scroll position has advanced along
 * its axis (0 when the list is laid out in normal page flow and only the page
 * scrolls — see computeVisibleRange for that case).
 *
 * Returns { start, end, before, after } where [start, end) are the item indexes
 * to mount and `before`/`after` are the spacer sizes before and after them, in
 * items (multiply by the item size for pixels). `end` may equal `start` when
 * there is nothing to mount, never less.
 */
function computeWindow({ total, viewportSize, itemSize, scrollOffset = 0, overscan = 0, minItems = 0 }) {
  const count = toFiniteNumber(total);
  if (count === null || count <= 0) {
    return { start: 0, end: 0, before: 0, after: 0 };
  }
  const totalItems = Math.floor(count);
  const size = toFiniteNumber(itemSize);
  const view = toFiniteNumber(viewportSize);
  const offset = Number.isFinite(toFiniteNumber(scrollOffset)) ? toFiniteNumber(scrollOffset) : 0;

  // Degenerate geometry: mount everything rather than produce an empty window.
  if (size === null || size <= 0 || view === null || view <= 0) {
    return { start: 0, end: totalItems, before: 0, after: 0 };
  }

  const visibleCount = Math.max(1, Math.ceil(view / size) + 1);
  const firstVisible = Math.floor(Math.max(0, offset) / size);

  let start = firstVisible - overscan;
  let end = firstVisible + visibleCount + overscan;

  if (minItems > 0) {
    const shortfall = minItems - (end - start);
    if (shortfall > 0) {
      end += shortfall;
    }
  }

  start = Math.max(0, start);
  end = Math.min(totalItems, end);
  if (end < start) end = start;

  return {
    start,
    end,
    before: start,
    after: totalItems - end,
  };
}

/**
 * Window for a list laid out in normal document flow (no inner scroller).
 *
 * `elementTop`/`elementHeight` describe the list's box in viewport
 * coordinates; only the part that intersects [0, viewportHeight] is visible.
 * Horizontal lists additionally use their own scrollLeft, since the pattern
 * grid scrolls sideways inside the card.
 */
function computeVisibleRange({
  total,
  viewportStart,      // px, list coordinate == 0 at first item
  viewportEnd,        // px
  itemSize,
  overscan = 0,
  minItems = 0,
  maxMount,           // hard cap on mounted items, 0/undefined = no cap
}) {
  const count = toFiniteNumber(total);
  if (count === null || count <= 0) {
    return { start: 0, end: 0, before: 0, after: 0 };
  }
  const totalItems = Math.floor(count);
  const size = toFiniteNumber(itemSize);

  if (size === null || size <= 0) {
    return { start: 0, end: totalItems, before: 0, after: 0 };
  }

  const vStart = toFiniteNumber(viewportStart);
  const vEnd = toFiniteNumber(viewportEnd);

  // Unknown geometry: mount a conservative opening window, not everything.
  if (vStart === null || vEnd === null) {
    let start = 0;
    let end = Math.max(1, minItems, 1);
    end = Math.min(totalItems, end);
    return { start, end, before: start, after: totalItems - end };
  }

  const firstVisible = Math.floor(Math.max(0, vStart) / size);
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, vEnd - vStart) / size) + 1);

  let start = firstVisible - overscan;
  let end = firstVisible + visibleCount + overscan;

  if (minItems > 0) {
    const shortfall = minItems - (end - start);
    if (shortfall > 0) end += shortfall;
  }

  start = Math.max(0, start);
  end = Math.min(totalItems, end);

  if (maxMount && maxMount > 0 && end - start > maxMount) {
    end = start + maxMount;
  }

  if (end < start) end = start;

  return {
    start,
    end,
    before: start,
    after: totalItems - end,
  };
}

// Effective window: small lists skip virtualisation entirely.
function computeEffectiveWindow(total, window, threshold = VIRTUAL_POLICY.fullRenderThreshold) {
  const count = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0;
  if (count <= threshold) {
    return { start: 0, end: count, before: 0, after: 0, virtualized: false };
  }
  return { ...window, virtualized: true };
}

// Grouping is validated structurally only. Its SUM is deliberately NOT
// validated here: the UI allows temporarily incomplete groupings (Clear
// Grouping) and reports the mismatch as a warning, so that stays editable.
// Returns a fresh array, or null when the structure itself is unusable.
function normalizeGroups(raw, fallbackGroups) {
  if (raw === undefined || raw === null) {
    return Array.isArray(fallbackGroups) ? [...fallbackGroups] : null;
  }
  if (!Array.isArray(raw) || raw.length > METRONOME_LIMITS.maxGroupEntries) return null;

  const groups = [];
  for (const entry of raw) {
    const n = toFiniteNumber(entry);
    if (n === null || !Number.isInteger(n)) return null;
    if (n < METRONOME_LIMITS.groupSize.min || n > METRONOME_LIMITS.groupSize.max) return null;
    groups.push(n);
  }
  return groups;
}

// Overrides: { [subdivIndex]: 'accent'|'normal'|'mute' } or [[index, type], ...].
// Entries whose index is outside this layer's subdivision range, or whose beat
// type is unknown, are dropped — an override is optional, so dropping it falls
// back to the grouping-derived default rather than corrupting the pattern.
// Returns a fresh object, or null when the container structure is unusable.
function normalizeOverrides(raw, numerator) {
  if (raw === undefined || raw === null) return {};

  let entries;
  if (Array.isArray(raw)) {
    if (raw.length > METRONOME_LIMITS.maxOverrides) return null;
    entries = raw;
  } else if (typeof raw === 'object') {
    entries = Object.entries(raw);
    if (entries.length > METRONOME_LIMITS.maxOverrides) return null;
  } else {
    return null;
  }

  const overrides = {};
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const index = toFiniteNumber(entry[0]);
    const type = entry[1];
    if (index === null || !Number.isInteger(index)) continue;
    if (index < 0 || index >= numerator) continue;
    if (!METRONOME_BEAT_TYPES.includes(type)) continue;
    overrides[index] = type;
  }
  return overrides;
}

// ============================================================================
// 1. Audio Engine & Sound Synthesizer (Look-Ahead Scheduling)
// ============================================================================

class MetronomeAudioEngine {
  constructor() {
    this.audioCtx = null;
    this.masterGain = null;

    // Scheduler timing
    this.lookahead = 0.08;      // Look-ahead window (seconds)
    this.scheduleInterval = 25; // How often scheduler runs (ms)
    this.timerId = null;

    // Voices already handed to Web Audio and not finished yet. The transport
    // uses this to cancel the look-ahead window on pause / stop / reset —
    // clearing the scheduler interval alone leaves scheduled nodes alive.
    this.activeVoices = new Set();

    // Callbacks
    this.onBeatScheduled = null; // Called when a beat is scheduled

    // Voice currently being built by playClick(); synths register their
    // sources here so the transport can cancel them on pause/stop/reset.
    this._currentVoice = null;

    // Sound Synthesizers
    this.soundEngines = {
      classic: (time, isAccent, gainNode) => this.synthClassic(time, isAccent, gainNode),
      wood: (time, isAccent, gainNode) => this.synthWood(time, isAccent, gainNode),
      electronic: (time, isAccent, gainNode) => this.synthElectronic(time, isAccent, gainNode),
      soft: (time, isAccent, gainNode) => this.synthSoft(time, isAccent, gainNode),
      cowbell: (time, isAccent, gainNode) => this.synthCowbell(time, isAccent, gainNode),
    };
  }

  ensureContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.setValueAtTime(0.9, this.audioCtx.currentTime);
      this.masterGain.connect(this.audioCtx.destination);
    }
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  get currentTime() {
    return this.audioCtx ? this.audioCtx.currentTime : 0;
  }

  // --- Sound Synthesizers (Web Audio Synthesis, 0 external assets) ---

  // Register a source node with the voice currently being built by playClick().
  // Returns the node unchanged so synths can stay one-liners.
  trackVoiceNode(node) {
    if (this._currentVoice) {
      this._currentVoice.nodes.push(node);
    }
    return node;
  }

  synthClassic(time, isAccent, destination) {
    const ctx = this.audioCtx;
    const osc = this.trackVoiceNode(ctx.createOscillator());
    const env = ctx.createGain();

    const startFreq = isAccent ? 2200 : 1300;
    const endFreq = isAccent ? 600 : 350;
    const duration = isAccent ? 0.045 : 0.035;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + duration);

    env.gain.setValueAtTime(1.0, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.connect(env);
    env.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.01);
  }

  synthWood(time, isAccent, destination) {
    const ctx = this.audioCtx;

    // Tuned body
    const osc = this.trackVoiceNode(ctx.createOscillator());
    const oscEnv = ctx.createGain();
    const freq = isAccent ? 980 : 720;
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, time);

    oscEnv.gain.setValueAtTime(0.8, time);
    oscEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
    osc.connect(oscEnv);
    oscEnv.connect(destination);

    osc.start(time);
    osc.stop(time + 0.05);

    // Resonant noise click
    const bufferSize = Math.floor(ctx.sampleRate * 0.02);
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      output[i] = Math.random() * 2 - 1;
    }

    const noise = this.trackVoiceNode(ctx.createBufferSource());
    noise.buffer = noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(isAccent ? 2800 : 2100, time);
    filter.Q.value = 4.0;

    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.6, time);
    noiseEnv.gain.exponentialRampToValueAtTime(0.001, time + 0.02);

    noise.connect(filter);
    filter.connect(noiseEnv);
    noiseEnv.connect(destination);

    noise.start(time);
    noise.stop(time + 0.025);
  }

  synthElectronic(time, isAccent, destination) {
    const ctx = this.audioCtx;
    const osc = this.trackVoiceNode(ctx.createOscillator());
    const env = ctx.createGain();

    osc.type = 'square';
    const startFreq = isAccent ? 2400 : 1600;
    const endFreq = isAccent ? 300 : 200;
    const duration = isAccent ? 0.05 : 0.035;

    osc.frequency.setValueAtTime(startFreq, time);
    osc.frequency.exponentialRampToValueAtTime(endFreq, time + duration);

    env.gain.setValueAtTime(0.7, time);
    env.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.connect(env);
    env.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.01);
  }

  synthSoft(time, isAccent, destination) {
    const ctx = this.audioCtx;
    const osc = this.trackVoiceNode(ctx.createOscillator());
    const env = ctx.createGain();

    osc.type = 'sine';
    const freq = isAccent ? 560 : 420;
    const duration = 0.06;

    osc.frequency.setValueAtTime(freq, time);

    env.gain.setValueAtTime(0.001, time);
    env.gain.linearRampToValueAtTime(0.9, time + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, time + duration);

    osc.connect(env);
    env.connect(destination);

    osc.start(time);
    osc.stop(time + duration + 0.01);
  }

  synthCowbell(time, isAccent, destination) {
    const ctx = this.audioCtx;
    const f1 = isAccent ? 620 : 540;
    const f2 = isAccent ? 890 : 800;

    [f1, f2].forEach((freq) => {
      const osc = this.trackVoiceNode(ctx.createOscillator());
      const env = ctx.createGain();

      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, time);

      env.gain.setValueAtTime(0.4, time);
      env.gain.exponentialRampToValueAtTime(0.001, time + 0.25);

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(freq, time);
      filter.Q.value = 3;

      osc.connect(filter);
      filter.connect(env);
      env.connect(destination);

      osc.start(time);
      osc.stop(time + 0.28);
    });
  }

  // Play click using selected sound
  playClick(time, beatType, soundType, volume, accentVolume, layerId) {
    if (beatType === 'mute') return;

    const ctx = this.ensureContext();
    const isAccent = beatType === 'accent';
    const finalVolume = isAccent ? volume * accentVolume : volume;

    // Defensive: a non-finite volume or time would poison the whole voice.
    if (!Number.isFinite(time) || !Number.isFinite(finalVolume)) return;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(Math.min(1.0, Math.max(0, finalVolume)), time);
    gainNode.connect(this.masterGain);

    // Longest synth tail (cowbell, 0.28s) plus margin: a voice is finished
    // once AudioContext time passes this, so it can be pruned.
    const voice = { nodes: [], gainNode, endTime: time + 0.35, layerId };
    this._currentVoice = voice;
    try {
      const synthFn = this.soundEngines[soundType] || this.soundEngines.classic;
      synthFn(time, isAccent, gainNode);
    } finally {
      this._currentVoice = null;
    }

    if (voice.nodes.length > 0) {
      this.pruneFinishedVoices();
      this.activeVoices.add(voice);
    }
  }

  // Drop voices whose last node has already finished playing.
  pruneFinishedVoices() {
    if (this.activeVoices.size === 0) return;
    const now = this.currentTime;
    this.activeVoices.forEach((voice) => {
      if (voice.endTime <= now) this.activeVoices.delete(voice);
    });
  }

  // Silence everything already handed to Web Audio (the look-ahead window).
  // Clearing the scheduler interval alone leaves those nodes scheduled, so a
  // pause would still produce a short click tail. This does not touch the
  // AudioContext clock, so timing model and browser/Electron behaviour are
  // unchanged — only the pending voices are cancelled.
  // Pass a layerId to cancel just that layer's pending voices.
  cancelScheduledVoices(layerId) {
    if (!this.audioCtx || this.activeVoices.size === 0) {
      this.activeVoices.clear();
      return;
    }

    const now = this.currentTime;
    const cancelled = new Set();
    this.activeVoices.forEach((voice) => {
      if (layerId !== undefined && voice.layerId !== layerId) return;
      cancelled.add(voice);

      try {
        // Zero the per-click gain first: a cancelled exponential ramp would
        // otherwise be re-evaluated from the old curve.
        voice.gainNode.gain.cancelScheduledValues(now);
        voice.gainNode.gain.setValueAtTime(0, now);
      } catch (e) {
        console.warn('Failed to silence scheduled voice gain:', e);
      }

      voice.nodes.forEach((node) => {
        try {
          node.stop(now);
        } catch (e) {
          // Already stopped / never started: nothing left to cancel.
        }
      });
    });

    cancelled.forEach((voice) => this.activeVoices.delete(voice));
  }
}

// ============================================================================
// 2. Rhythm State Management & Polyrhythm Coordinator
// ============================================================================

class MetronomeState {
  constructor() {
    this.bpm = 140;
    this.isPlaying = false;
    this.isPaused = false;
    this.layers = [];
    this.activePresetId = null;

    // Visual queue for synchronization
    this.visualQueue = []; // array of { layerId, subdivIndex, audioTime }, sorted by audioTime

    // Monotonic tie-breaker so events with identical audioTime keep their
    // insertion order and sorting stays stable across engines.
    this.visualSeq = 0;
  }

  // Insert a visual event so the queue is always ordered globally by
  // audioTime — not grouped by layer. Binary search over the tail because new
  // events are normally the latest ones; equal timestamps keep FIFO order.
  enqueueVisualEvent(layerId, subdivIndex, audioTime) {
    if (!Number.isFinite(audioTime)) return;

    const queue = this.visualQueue;
    const event = { layerId, subdivIndex, audioTime, seq: this.visualSeq++ };

    let low = 0;
    let high = queue.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      const midEvent = queue[mid];
      if (
        midEvent.audioTime < audioTime ||
        (midEvent.audioTime === audioTime && midEvent.seq <= event.seq)
      ) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    queue.splice(low, 0, event);
  }

  // Remove and return every event whose audio time has arrived, earliest first.
  takeDueVisualEvents(now) {
    const queue = this.visualQueue;
    let count = 0;
    while (count < queue.length && queue[count].audioTime <= now) {
      count++;
    }
    if (count === 0) return [];
    return queue.splice(0, count);
  }

  clearVisualQueue() {
    this.visualQueue.length = 0;
    this.visualSeq = 0;
  }

  // Calculate subdivision interval in seconds:
  // Quarter note = 60 / BPM
  // Sixteenth (den=16): 60 / BPM / (16/4) = 60 / BPM / 4
  // Generic: (4 / denominator) * (60 / (BPM * multiplier))
  getSubdivDuration(layer) {
    const num = Math.max(1, toFiniteNumber(layer.numerator) ?? 1);
    const den = Math.max(1, toFiniteNumber(layer.denominator) ?? 1);
    const bpm = toFiniteNumber(this.bpm) ?? 140;
    const multiplier = toFiniteNumber(layer.bpmMultiplier) ?? 1;
    const effectiveBpm = Math.max(10, bpm * multiplier);
    return (4 / den) * (60 / effectiveBpm);
  }

  // Generate automatic groupings
  autoGroup(numerator) {
    if (numerator <= 0) return [1];
    const groups = [];
    let rem = numerator;
    while (rem > 0) {
      if (rem >= 3) {
        groups.push(3);
        rem -= 3;
      } else {
        groups.push(rem);
        rem = 0;
      }
    }
    return groups;
  }

  // Validate and normalize a whole configuration document — the shared path
  // for URL hashes and saved presets, so neither can bypass the constraints.
  // Returns { ok: true, bpm, layers } or { ok: false, reason }.
  // Structural problems reject the document; numeric problems are clamped or
  // replaced by defaults, matching what the UI itself allows.
  normalizeConfiguration(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, reason: 'configuration is not an object' };
    }
    if (!Array.isArray(raw.layers)) {
      return { ok: false, reason: 'configuration has no layer array' };
    }
    if (raw.layers.length === 0) {
      return { ok: false, reason: 'configuration has no layers' };
    }
    if (raw.layers.length > METRONOME_LIMITS.maxLayers) {
      return { ok: false, reason: `configuration exceeds ${METRONOME_LIMITS.maxLayers} layers` };
    }

    const layers = [];
    for (let idx = 0; idx < raw.layers.length; idx++) {
      const rawLayer = raw.layers[idx];
      if (rawLayer === null || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) {
        return { ok: false, reason: `layer ${idx + 1} is not an object` };
      }

      const numerator = clampInt(rawLayer.numerator, METRONOME_LIMITS.numerator, null);
      if (numerator === null) {
        return { ok: false, reason: `layer ${idx + 1} has an invalid numerator` };
      }

      // Grouping structure is checked, but its sum is not: incomplete groupings
      // are a supported editing state.
      const groups = normalizeGroups(rawLayer.groups, this.autoGroup(numerator));
      if (groups === null) {
        return { ok: false, reason: `layer ${idx + 1} has an invalid grouping` };
      }

      const overrides = normalizeOverrides(rawLayer.overrides, numerator);
      if (overrides === null) {
        return { ok: false, reason: `layer ${idx + 1} has invalid overrides` };
      }

      layers.push(this.createLayer({
        name: rawLayer.name,
        numerator,
        denominator: rawLayer.denominator,
        bpmMultiplier: rawLayer.bpmMultiplier,
        groups,
        overrides,
        sound: rawLayer.sound,
        volume: rawLayer.volume,
        accentVolume: rawLayer.accentVolume,
        muted: rawLayer.muted,
        color: this.getLayerColor(idx),
      }));
    }

    return {
      ok: true,
      bpm: clampInt(raw.bpm, METRONOME_LIMITS.bpm, 120),
      layers,
    };
  }

  // Create a new layer with default settings.
  // Every incoming value is normalized here, so callers (UI, URL hash,
  // presets) cannot inject NaN/Infinity or out-of-range numbers into the
  // scheduler. Structurally invalid input is rejected by
  // normalizeConfiguration() before this is reached.
  createLayer(config = {}) {
    const id = 'layer_' + Date.now() + '_' + Math.floor(Math.random() * 1000);

    const numerator = clampInt(config.numerator, METRONOME_LIMITS.numerator, 59);
    const denominator = clampInt(config.denominator, METRONOME_LIMITS.denominator, 16);
    const groups = normalizeGroups(config.groups, this.autoGroup(numerator)) || this.autoGroup(numerator);
    const overrides = normalizeOverrides(config.overrides, numerator) || {};
    const name = normalizeName(config.name, `Layer ${this.layers.length + 1}`);
    const sound = METRONOME_SOUNDS.includes(config.sound) ? config.sound : 'classic';

    return {
      id,
      name,
      numerator,
      denominator,
      bpmMultiplier: clampNumber(config.bpmMultiplier, METRONOME_LIMITS.bpmMultiplier, 1.0),
      groups,
      overrides, // { [subdivIndex]: 'accent'|'normal'|'mute' }
      sound,
      volume: clampNumber(config.volume, METRONOME_LIMITS.volume, 0.8),
      accentVolume: clampNumber(config.accentVolume, METRONOME_LIMITS.accentVolume, 1.3),
      muted: !!config.muted,

      // Runtime scheduler state
      nextNoteTime: 0,
      currentSubdiv: 0,
      color: typeof config.color === 'string' && config.color ? config.color : this.getLayerColor(this.layers.length),
    };
  }

  getLayerColor(index) {
    const colors = ['#00d2ff', '#00e676', '#ff5e36', '#b388ff', '#ffd600', '#ff4081', '#40c4ff'];
    return colors[index % colors.length];
  }

  // Get effective beat type for a specific subdivision cell
  getBeatType(layer, index) {
    if (layer.overrides[index] !== undefined) {
      return layer.overrides[index];
    }
    // Check if this index is a group boundary (start of group)
    let pos = 0;
    for (let i = 0; i < layer.groups.length; i++) {
      if (index === pos) {
        return 'accent';
      }
      pos += layer.groups[i];
    }
    return 'normal';
  }

  // Cycle beat type: normal -> accent -> mute -> normal
  cycleBeatType(current) {
    if (current === 'normal') return 'accent';
    if (current === 'accent') return 'mute';
    return 'normal';
  }
}

// ============================================================================
// 3. Application Controller & UI View
// ============================================================================

class MetronomeApp {
  constructor() {
    this.audioEngine = new MetronomeAudioEngine();
    this.state = new MetronomeState();

    // Tap tempo helpers
    this.tapTimes = [];
    this.tapTimeout = null;

    // Cache DOM elements
    this.dom = {
      playBtn: document.getElementById('play-btn'),
      playIcon: document.getElementById('play-icon'),
      pauseBtn: document.getElementById('pause-btn'),
      stopBtn: document.getElementById('stop-btn'),
      resetBtn: document.getElementById('reset-btn'),
      bpmInput: document.getElementById('bpm-input'),
      bpmSlider: document.getElementById('bpm-slider'),
      tapBtn: document.getElementById('tap-btn'),
      addLayerBtn: document.getElementById('add-layer-btn'),
      shareBtn: document.getElementById('share-btn'),
      layersList: document.getElementById('layers-list'),
      factoryPresets: document.getElementById('factory-presets'),
      userPresets: document.getElementById('user-presets'),
      presetNameInput: document.getElementById('preset-name-input'),
      savePresetBtn: document.getElementById('save-preset-btn'),
      toast: document.getElementById('toast'),
    };

    // Factory presets definitions
    this.factoryPresetsData = [
      {
        name: '59/16 — 3+3+2+5+7... (核心用例)',
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
          }
        ]
      },
      {
        name: '59 : 7 : 11 复合复节奏 (Polyrhythm)',
        bpm: 130,
        layers: [
          {
            name: 'Layer A (59/16)',
            numerator: 59,
            denominator: 16,
            groups: [3, 3, 2, 5, 7, 4, 6, 5, 2, 3, 4, 5, 3, 3, 4],
            sound: 'classic',
            volume: 0.8,
            accentVolume: 1.3,
          },
          {
            name: 'Layer B (7/16)',
            numerator: 7,
            denominator: 16,
            groups: [3, 2, 2],
            sound: 'electronic',
            volume: 0.7,
            accentVolume: 1.3,
          },
          {
            name: 'Layer C (11/16)',
            numerator: 11,
            denominator: 16,
            groups: [3, 3, 3, 2],
            sound: 'wood',
            volume: 0.75,
            accentVolume: 1.3,
          }
        ]
      },
      {
        name: '73/32 实验微节奏',
        bpm: 110,
        layers: [
          {
            name: '73/32 Layer',
            numerator: 73,
            denominator: 32,
            groups: [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4],
            sound: 'electronic',
            volume: 0.85,
            accentVolume: 1.3,
          }
        ]
      },
      {
        name: '23/7 罕见分数拍 (Rare Fraction)',
        bpm: 120,
        layers: [
          {
            name: '23/7 Odd Layer',
            numerator: 23,
            denominator: 7,
            groups: [3, 3, 3, 3, 3, 3, 3, 2],
            sound: 'cowbell',
            volume: 0.8,
            accentVolume: 1.4,
          }
        ]
      },
      {
        name: '17/16 巴尔干节奏 (3+3+3+2+3+3)',
        bpm: 160,
        layers: [
          {
            name: '17/16 Balkan',
            numerator: 17,
            denominator: 16,
            groups: [3, 3, 3, 2, 3, 3],
            sound: 'wood',
            volume: 0.9,
            accentVolume: 1.4,
          }
        ]
      },
      {
        name: '7/8 保加利亚民谣 (2+2+3)',
        bpm: 180,
        layers: [
          {
            name: '7/8 Ruchenitsa',
            numerator: 7,
            denominator: 8,
            groups: [2, 2, 3],
            sound: 'classic',
            volume: 0.85,
            accentVolume: 1.4,
          }
        ]
      },
      {
        name: '4/4 标准节拍器',
        bpm: 120,
        layers: [
          {
            name: 'Standard 4/4',
            numerator: 4,
            denominator: 4,
            groups: [1, 1, 1, 1],
            sound: 'classic',
            volume: 0.85,
            accentVolume: 1.4,
          }
        ]
      }
    ];

    this.wakeLock = null;
    this.init();
  }

  async acquireWakeLock() {
    try {
      if ('wakeLock' in navigator && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {
      // Ignore if wake lock is denied or unsupported
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      try {
        this.wakeLock.release();
      } catch {}
      this.wakeLock = null;
    }
  }

  init() {
    // Expansion state must exist before any card is built.
    this.expandedLayerIds = new Set();

    // Virtualisation bookkeeping: one observer per expanded layer, plus a
    // coalescing set so a burst of resize/scroll signals costs one remount.
    this.virtualObservers = new Map();
    this.virtualRefreshQueued = new Map();

    // Check URL state first, otherwise load default
    if (!this.loadStateFromUrl()) {
      // Default directly to 59/16 signature metronome
      this.loadPresetData(this.factoryPresetsData[0]);
    }

    this.bindEvents();
    this.bindVirtualScroll();
    this.renderAll();
    this.renderPresets();

    // Start requestAnimationFrame visual loop
    this.startVisualLoop();
  }

  // One passive scroll listener for the whole page, one rAF batch at a time.
  // Individual cells never get their own scroll handlers.
  bindVirtualScroll() {
    if (this.virtualScrollBound) return;
    this.virtualScrollBound = true;

    let pending = false;
    const onScroll = () => {
      if (pending) return;
      pending = true;
      const flush = () => {
        pending = false;
        this.onPageScroll();
      };
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flush);
      } else {
        setTimeout(flush, VIRTUAL_POLICY.scrollSettleMs);
      }
    };

    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll, { passive: true });
    }

    // The pattern grid scrolls horizontally inside its own wrapper.
    if (this.dom.layersList && this.dom.layersList.addEventListener) {
      this.dom.layersList.addEventListener('scroll', (e) => {
        const wrap = e.target && e.target.closest && e.target.closest('.subdivision-scroll-wrap');
        if (!wrap) return;
        const card = wrap.closest('.layer-card');
        if (!card || !card.id) return;
        this.scheduleVirtualRefresh(card.id);
      }, { passive: true, capture: true });
    }
  }

  // ==========================================================================
  // Core Scheduler Loop (Precision Web Audio Look-Ahead)
  // ==========================================================================

  startPlayback() {
    const ctx = this.audioEngine.ensureContext();
    this.state.isPlaying = true;
    this.state.isPaused = false;
    this.acquireWakeLock();

    // Defensive: never inherit a queue from a previous transport state, and
    // never leave a second interval running.
    this.state.clearVisualQueue();
    if (this.audioEngine.timerId) {
      clearInterval(this.audioEngine.timerId);
      this.audioEngine.timerId = null;
    }

    const startTime = ctx.currentTime + 0.05;

    // Re-anchor the audio timeline. currentSubdiv is preserved, so playback
    // resumes at the same musical position (pause never rewinds the position).
    this.state.layers.forEach((layer) => {
      layer.nextNoteTime = startTime;
    });

    this.audioEngine.timerId = setInterval(() => this.scheduler(), this.audioEngine.scheduleInterval);
    this.updateTransportUI();
  }

  // Before dropping the queue, rewind each layer to the earliest subdivision
  // that was scheduled into the look-ahead window but had not become audible
  // yet. Resume restarts exactly there: nothing from the cancelled window is
  // lost, and nothing already heard is replayed. Events whose audioTime has
  // already passed were audible and must not be rewound.
  capturePendingPositions() {
    const now = this.audioEngine.audioCtx ? this.audioEngine.currentTime : 0;
    const pending = new Map();
    this.state.visualQueue.forEach((event) => {
      if (event.audioTime <= now) return;
      if (!pending.has(event.layerId)) {
        pending.set(event.layerId, event.subdivIndex);
      }
    });
    this.state.layers.forEach((layer) => {
      if (pending.has(layer.id)) {
        layer.currentSubdiv = pending.get(layer.id);
      }
    });
  }

  pausePlayback() {
    this.state.isPlaying = false;
    this.state.isPaused = true;
    this.releaseWakeLock();
    if (this.audioEngine.timerId) {
      clearInterval(this.audioEngine.timerId);
      this.audioEngine.timerId = null;
    }

    // Keep the musical position, but discard the events tied to the old
    // timeline. AudioContext.currentTime keeps advancing while paused, so
    // those timestamps are meaningless after resume.
    this.capturePendingPositions();
    this.state.clearVisualQueue();
    this.audioEngine.cancelScheduledVoices();

    this.updateTransportUI();
  }

  stopPlayback() {
    this.state.isPlaying = false;
    this.state.isPaused = false;
    this.releaseWakeLock();
    if (this.audioEngine.timerId) {
      clearInterval(this.audioEngine.timerId);
      this.audioEngine.timerId = null;
    }

    // Reset current subdivision
    this.state.layers.forEach((layer) => {
      layer.currentSubdiv = 0;
    });
    this.state.clearVisualQueue();
    this.audioEngine.cancelScheduledVoices();

    // Clear active playhead styles
    document.querySelectorAll('.subdiv-cell.active-playhead').forEach((el) => {
      el.classList.remove('active-playhead');
    });

    this.updateTransportUI();
  }

  resetPosition() {
    // Cancel first: otherwise the look-ahead window scheduled for the old
    // position would still sound after the playhead jumped back to beat 1.
    this.audioEngine.cancelScheduledVoices();
    this.state.clearVisualQueue();

    this.state.layers.forEach((layer) => {
      layer.currentSubdiv = 0;
      if (this.state.isPlaying && this.audioEngine.audioCtx) {
        layer.nextNoteTime = this.audioEngine.currentTime + 0.05;
      }
    });
    document.querySelectorAll('.subdiv-cell.active-playhead').forEach((el) => {
      el.classList.remove('active-playhead');
    });
  }

  // Single entry point for every UI path that adds a layer. The count is
  // checked before anything is created, so a rejected add leaves the state
  // completely untouched — no create-then-delete, no partial mutation.
  addLayer(config = {}) {
    if (this.state.layers.length >= METRONOME_LIMITS.maxLayers) {
      this.showToast(`已达到 Layer 数量上限 (${METRONOME_LIMITS.maxLayers})，无法继续添加。`);
      return false;
    }

    const newLayer = this.state.createLayer(config);
    this.state.layers.push(newLayer);

    // A newly added layer is small and worth showing in full.
    this.expandedLayerIds.add(newLayer.id);

    // Append just this card instead of rebuilding the whole list.
    const card = this.createLayerCardElement(newLayer, this.state.layers.length - 1);
    this.dom.layersList.appendChild(card);
    this.updateLayerIndexes();
    return true;
  }

  // Removing a layer while playing must also drop its pending visual events
  // and cancel the voices it already scheduled: the layer element disappears,
  // so those events could only act on a stale id, and its clicks would
  // otherwise still sound from the look-ahead window.
  removeLayer(layerId) {
    if (this.state.layers.length <= 1) return;

    this.state.layers = this.state.layers.filter((l) => l.id !== layerId);
    this.state.visualQueue = this.state.visualQueue.filter((event) => event.layerId !== layerId);
    this.audioEngine.cancelScheduledVoices(layerId);

    // Drop the id from the UI-only expansion set so it cannot leak between
    // configurations, and remove just that card.
    this.expandedLayerIds.delete(layerId);
    this.detachLayerVirtualObserver(layerId);
    if (this.currentPlayhead) this.currentPlayhead.delete(layerId);
    const card = document.getElementById(layerId);
    if (card && card.parentNode) card.parentNode.removeChild(card);

    this.updateLayerIndexes();
  }

  // Scheduler: runs every 25ms, schedules audio ahead of time in AudioContext
  scheduler() {
    if (!this.state.isPlaying || !this.audioEngine.audioCtx) return;

    const currentTime = this.audioEngine.currentTime;
    const scheduleUntil = currentTime + this.audioEngine.lookahead;

    this.state.layers.forEach((layer) => {
      if (layer.muted) return;
      if (!(layer.numerator > 0) || !(layer.denominator > 0)) return;

      const subdivDuration = this.state.getSubdivDuration(layer);
      // A non-finite or non-positive duration would spin this loop forever.
      if (!Number.isFinite(subdivDuration) || subdivDuration <= 0) {
        console.warn('Skipping layer with invalid subdivision duration:', layer.id, subdivDuration);
        return;
      }

      // Catch-up if nextNoteTime fell behind
      if (layer.nextNoteTime < currentTime) {
        layer.nextNoteTime = currentTime;
      }

      while (layer.nextNoteTime < scheduleUntil) {
        const beatIndex = layer.currentSubdiv;
        const beatType = this.state.getBeatType(layer, beatIndex);

        // Schedule synthesis
        this.audioEngine.playClick(
          layer.nextNoteTime,
          beatType,
          layer.sound,
          layer.volume,
          layer.accentVolume,
          layer.id
        );

        // Enqueue for visual display synchronization. The queue orders events
        // globally by audioTime, so layers with different subdivision
        // intervals cannot block each other.
        this.state.enqueueVisualEvent(layer.id, beatIndex, layer.nextNoteTime);

        // Advance layer time
        layer.nextNoteTime += subdivDuration;
        layer.currentSubdiv = (layer.currentSubdiv + 1) % layer.numerator;
      }
    });
  }

  // Visual Loop: Synchronized with AudioContext.currentTime using requestAnimationFrame
  startVisualLoop() {
    const loop = () => {
      if (this.state.isPlaying && this.audioEngine.audioCtx) {
        const now = this.audioEngine.currentTime;

        // Process every scheduled visual beat whose audio time has arrived,
        // in chronological order across all layers.
        const due = this.state.takeDueVisualEvents(now);
        for (const beat of due) {
          this.highlightBeat(beat.layerId, beat.subdivIndex);
        }
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  highlightBeat(layerId, subdivIndex) {
    // Playback position is recorded regardless of what is mounted, so a cell
    // that scrolls back into view can be painted with the current state. This
    // never forces mounting — scheduling must not depend on DOM presence.
    this.currentPlayhead = this.currentPlayhead || new Map();
    this.currentPlayhead.set(layerId, subdivIndex);

    const layerEl = document.getElementById(layerId);
    if (!layerEl) return;

    // Remove previous playhead in this layer
    const prev = layerEl.querySelector('.subdiv-cell.active-playhead');
    if (prev) {
      prev.classList.remove('active-playhead');
    }

    // Highlight current cell — only if this index is currently mounted.
    const cell = layerEl.querySelector(`.subdiv-cell[data-index="${subdivIndex}"]`);
    if (!cell) return;
    cell.classList.add('active-playhead');

    // Horizontal auto-follow: adjust ONLY this layer's own scroll wrapper by
    // setting its scrollLeft directly. Never uses scrollIntoView or any API
    // that could scroll the page. Follows only when the cell leaves the
    // wrapper's visible content box, and by the minimum distance needed —
    // so a user's manual horizontal position is not reset every beat.
    const wrap = layerEl.querySelector('.subdivision-scroll-wrap');
    if (!wrap) return;
    const wrapRect = this.rectOf(wrap);
    const cellRect = this.rectOf(cell);
    let leftEdge = wrapRect.left;
    let rightEdge = wrapRect.right;
    if (typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(wrap);
      leftEdge += parseFloat(cs.paddingLeft) || 0;
      rightEdge -= parseFloat(cs.paddingRight) || 0;
    }
    let delta = 0;
    if (cellRect.left < leftEdge) {
      delta = cellRect.left - leftEdge;
    } else if (cellRect.right > rightEdge) {
      delta = cellRect.right - rightEdge;
    }
    if (delta !== 0) {
      wrap.scrollLeft += delta;
    }
  }

  // ==========================================================================
  // Transport & Global Tempo Events
  // ==========================================================================

  bindEvents() {
    // Play / Pause / Stop / Reset
    this.dom.playBtn.addEventListener('click', () => {
      if (this.state.isPlaying) {
        this.pausePlayback();
      } else {
        this.startPlayback();
      }
    });

    this.dom.pauseBtn.addEventListener('click', () => {
      if (this.state.isPlaying) {
        this.pausePlayback();
      } else if (this.state.isPaused) {
        this.startPlayback();
      }
    });

    this.dom.stopBtn.addEventListener('click', () => this.stopPlayback());
    this.dom.resetBtn.addEventListener('click', () => this.resetPosition());

    // Spacebar shortcut
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        const tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        e.preventDefault();
        if (this.state.isPlaying) {
          this.pausePlayback();
        } else {
          this.startPlayback();
        }
      }
    });

    // BPM Input & Slider
    this.dom.bpmInput.addEventListener('change', (e) => {
      this.setBpm(parseInt(e.target.value, 10));
    });

    this.dom.bpmSlider.addEventListener('input', (e) => {
      this.setBpm(parseInt(e.target.value, 10));
    });

    // Stepper buttons (+/- 1, +/- 5)
    document.querySelectorAll('.step-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const step = parseInt(btn.dataset.step, 10);
        this.setBpm(this.state.bpm + step);
      });
    });

    // Tap Tempo
    this.dom.tapBtn.addEventListener('click', () => this.handleTap());

    // Add Layer
    this.dom.addLayerBtn.addEventListener('click', () => {
      this.addLayer({
        name: `Layer ${this.state.layers.length + 1}`,
        numerator: 16,
        denominator: 16,
      });
    });

    // Share URL
    this.dom.shareBtn.addEventListener('click', () => this.shareConfiguration());

    // Save Preset
    this.dom.savePresetBtn.addEventListener('click', () => {
      const name = this.dom.presetNameInput.value.trim() || `Preset ${new Date().toLocaleTimeString()}`;
      this.saveUserPreset(name);
      this.dom.presetNameInput.value = '';
    });
  }

  setBpm(newBpm) {
    // Shared limit, so the UI cannot set a BPM that import would clamp.
    this.state.bpm = clampInt(newBpm, METRONOME_LIMITS.bpm, 120);
    this.dom.bpmInput.value = this.state.bpm;
    this.dom.bpmSlider.value = this.state.bpm;
  }

  handleTap() {
    this.audioEngine.ensureContext();
    const now = performance.now();
    this.tapTimes.push(now);

    // Keep last 6 taps within 2.5 seconds window
    if (this.tapTimes.length > 6) {
      this.tapTimes.shift();
    }

    clearTimeout(this.tapTimeout);
    this.tapTimeout = setTimeout(() => {
      this.tapTimes = [];
    }, 2500);

    this.dom.tapBtn.classList.add('tapped');
    setTimeout(() => this.dom.tapBtn.classList.remove('tapped'), 100);

    if (this.tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < this.tapTimes.length; i++) {
        intervals.push(this.tapTimes[i] - this.tapTimes[i - 1]);
      }
      const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (avgInterval > 80 && avgInterval < 3000) {
        const calculatedBpm = Math.round(60000 / avgInterval);
        this.setBpm(calculatedBpm);
      }
    }
  }

  updateTransportUI() {
    if (this.state.isPlaying) {
      this.dom.playBtn.classList.add('active');
      this.dom.playIcon.textContent = '⏸';
      this.dom.pauseBtn.classList.remove('active');
    } else if (this.state.isPaused) {
      this.dom.playBtn.classList.remove('active');
      this.dom.playIcon.textContent = '▶';
      this.dom.pauseBtn.classList.add('active');
    } else {
      this.dom.playBtn.classList.remove('active');
      this.dom.playIcon.textContent = '▶';
      this.dom.pauseBtn.classList.remove('active');
    }
  }

  // ==========================================================================
  // Layer & UI Rendering
  // ==========================================================================

  renderAll() {
    this.setBpm(this.state.bpm);
    this.renderLayers();
  }

  // Collapse policy, applied when a configuration is swapped in (preset load,
  // URL import) rather than on every incremental re-render.
  shouldStartCollapsed(layer) {
    const policy = LAYER_RENDER_POLICY;
    if (layer.numerator > policy.autoCollapseLayerSubdivisions) return true;
    if (this.state.layers.length >= policy.autoCollapseLayerCount) return true;

    let total = 0;
    for (const l of this.state.layers) {
      total += l.numerator;
      if (total > policy.autoCollapseTotalSubdivisions) return true;
    }
    return false;
  }

  // Apply the default expansion state for the configuration now in state.
  // Small configurations keep the historical behaviour (everything expanded).
  applyInitialExpansionState() {
    this.expandedLayerIds = new Set();
    for (const layer of this.state.layers) {
      if (!this.shouldStartCollapsed(layer)) {
        this.expandedLayerIds.add(layer.id);
      }
    }
  }

  isLayerExpanded(layerId) {
    return this.expandedLayerIds.has(layerId);
  }

  // Full rebuild of the list. Used when the set of layers changes (load,
  // import, add, remove) — individual edits take a narrower path below.
  renderLayers() {
    const fragment = document.createDocumentFragment();
    this.state.layers.forEach((layer, index) => {
      fragment.appendChild(this.createLayerCardElement(layer, index));
    });
    this.dom.layersList.replaceChildren(fragment);
    this.updateLayerIndexes();
  }

  // Renumber the #N tags without touching anything else.
  updateLayerIndexes() {
    this.state.layers.forEach((layer, index) => {
      const card = document.getElementById(layer.id);
      if (!card) return;
      const tag = card.querySelector('.layer-tag');
      if (tag) tag.textContent = `#${index + 1}`;
    });
  }

  createLayerCardElement(layer, index) {
    const card = document.createElement('div');
    card.className = `layer-card ${layer.muted ? 'muted' : ''}`;
    card.id = layer.id;
    const expanded = this.isLayerExpanded(layer.id);
    card.dataset.expanded = expanded ? '1' : '0';
    if (!expanded) card.classList.add('collapsed');

    const accentBar = document.createElement('div');
    accentBar.className = 'layer-accent-bar';
    accentBar.style.background = layer.color;
    card.appendChild(accentBar);

    const main = document.createElement('div');
    main.className = 'layer-main';
    main.innerHTML = this.layerHeaderHtml(layer, index);

    // Detail host: always present, contents depend on expansion state.
    const detailHost = document.createElement('div');
    detailHost.className = 'layer-detail';
    main.appendChild(detailHost);
    card.appendChild(main);

    this.bindLayerHeaderEvents(card, layer);

    if (expanded) {
      this.renderLayerDetail(layer, card);
    }

    return card;
  }

  // Header + controls only. No grouping tags, no subdivision cells.
  layerHeaderHtml(layer, index) {
    return `
      <div class="layer-accent-bar" style="background: ${layer.color};"></div>
      <div class="layer-main">

        <!-- Top Header Bar -->
        <div class="layer-header-bar">
          <div class="layer-title-group">
            <span class="layer-tag" style="background: ${layer.color}22; color: ${layer.color};">#${index + 1}</span>
            <input type="text" class="layer-name-input" value="${this.escapeHtml(layer.name)}">
            <span class="layer-summary">${this.layerSummaryText(layer)}</span>
          </div>

          <!-- Time Signature Input -->
          <div class="meter-config">
            <label>METER</label>
            <input type="number" class="meter-num-input" min="1" max="1024" value="${layer.numerator}" title="分子：小节内细分拍数 (支持任意如 59, 73, 137)">
            <span class="meter-slash">/</span>
            <input type="number" class="meter-den-input" min="1" max="256" value="${layer.denominator}" title="分母：音符单位 (支持如 16, 32, 7, 5)">
          </div>

          <!-- Audio Settings -->
          <div class="layer-audio-settings">
            <div class="control-item">
              <span class="control-label">音色</span>
              <select class="select-sound">
                <option value="classic" ${layer.sound === 'classic' ? 'selected' : ''}>Classic Click</option>
                <option value="wood" ${layer.sound === 'wood' ? 'selected' : ''}>Wood Block</option>
                <option value="electronic" ${layer.sound === 'electronic' ? 'selected' : ''}>Electronic</option>
                <option value="soft" ${layer.sound === 'soft' ? 'selected' : ''}>Soft Click</option>
                <option value="cowbell" ${layer.sound === 'cowbell' ? 'selected' : ''}>Cowbell 🐄</option>
              </select>
            </div>

            <div class="control-item">
              <span class="control-label">音量</span>
              <div class="slider-group">
                <input type="range" class="vol-slider" min="0" max="1" step="0.05" value="${layer.volume}">
              </div>
            </div>

            <div class="control-item">
              <span class="control-label">重音</span>
              <div class="slider-group">
                <input type="range" class="accent-slider" min="0.5" max="2" step="0.1" value="${layer.accentVolume}">
              </div>
            </div>

            <div class="control-item">
              <span class="control-label">倍速</span>
              <input type="number" class="multiplier-input" min="0.1" max="8" step="0.1" value="${layer.bpmMultiplier}">
            </div>

            <div class="layer-btn-actions">
              <button class="expand-btn" title="展开 / 折叠该 Layer 的详细内容">${this.isLayerExpanded(layer.id) ? '▾' : '▸'}</button>
              <button class="mute-btn ${layer.muted ? 'active' : ''}">MUTE</button>
              ${this.state.layers.length > 1 ? '<button class="del-layer-btn" title="删除当前 Layer">✕</button>' : ''}
            </div>
          </div>
        </div>
    `;
  }

  // Compact one-line summary shown while collapsed, so a collapsed layer still
  // communicates its grouping state without building the full editor.
  layerSummaryText(layer) {
    const groupSum = layer.groups.reduce((a, b) => a + b, 0);
    const valid = groupSum === layer.numerator;
    const groups = layer.groups.length;
    return valid
      ? `${groups} 组 · 和 ${groupSum} ✓`
      : `${groups} 组 · 和 ${groupSum}/${layer.numerator}`;
  }

  groupingBadgeHtml(layer) {
    const groupSum = layer.groups.reduce((a, b) => a + b, 0);
    const isSumValid = groupSum === layer.numerator;
    const diff = groupSum - layer.numerator;
    const diffText = diff > 0 ? `+${diff}` : `${diff}`;
    return isSumValid
      ? `和 = ${groupSum} ✓`
      : `和 = ${groupSum} / 需 ${layer.numerator} (${diffText})`;
  }

  // Build (or rebuild) the expandable part of one card.
  renderLayerDetail(layer, card) {
    const host = card.querySelector('.layer-detail');
    if (!host) return;

    host.innerHTML = `
      <div class="grouping-bar">
        <div class="grouping-top">
          <div class="grouping-info">
            <span class="grouping-title">节奏分组 (Grouping)</span>
            <span class="grouping-sum-badge ${this.groupingBadgeHtml(layer).includes('✓') ? '' : 'error'}">${this.groupingBadgeHtml(layer)}</span>
          </div>

          <div class="grouping-quick-actions">
            <button class="btn btn-sm btn-auto-group" title="按3+3+2模式自动填充">自动分组</button>
            <button class="btn btn-sm btn-even-group" title="在当前组数间平均分配拍数">平均分配</button>
            <button class="btn btn-sm btn-group-accent" title="将各组起点标记为重音">组首重音</button>
            <button class="btn btn-sm btn-clear-group" title="清空所有分组">清空</button>
          </div>
        </div>

        <div class="groups-tags-container">
          <div class="groups-tags-list" data-virtual="groups"></div>
          <button class="add-group-btn">+ 添加组</button>
        </div>
      </div>

      <div class="grid-container">
        <div class="grid-top-actions">
          <div class="grid-legend">
            <div class="legend-item"><span class="legend-dot accent"></span> ● 重音 (Accent)</div>
            <div class="legend-item"><span class="legend-dot normal"></span> ○ 普音 (Normal)</div>
            <div class="legend-item"><span class="legend-dot mute"></span> × 静音 (Mute)</div>
            <span style="color: var(--text-muted); margin-left: 6px;">(点击任意单元格循环切换)</span>
          </div>

          <div class="grid-action-btns">
            <button class="btn btn-sm btn-reset-pattern" title="恢复为分组默认重音">重置 Pattern</button>
            <button class="btn btn-sm btn-all-normal" title="全部设为普通音">全部普音</button>
            <button class="btn btn-sm btn-random-pattern" title="随机生成重音/静音">随机 Pattern</button>
          </div>
        </div>

        <div class="subdivision-scroll-wrap">
          <div class="subdivision-grid" data-virtual="cells"></div>
        </div>
      </div>
    `;

    this.bindLayerDetailEvents(card, layer);
    this.mountLayerVirtualWindows(layer, card);
    this.attachLayerVirtualObserver(layer, card);
  }

  // --------------------------------------------------------------------------
  // Virtualised mounting for the two large per-layer collections
  // --------------------------------------------------------------------------
  //
  // Both collections are rebuilt from `layer` on every window change, so the
  // DOM never holds a stale copy: state stays the only source of truth.

  mountLayerVirtualWindows(layer, card) {
    this.mountGroupWindow(layer, card);
    this.mountCellWindow(layer, card);
  }

  // --- Group tags -----------------------------------------------------------
  //
  // Tags are a wrapping flex flow, so the whole list has a fixed measured
  // height and items are ordered by row then column. Virtualising by item index
  // keeps every mounting order simple; the spacers only need to reserve the
  // height of the skipped rows.

  mountGroupWindow(layer, card) {
    const host = card.querySelector('.groups-tags-list');
    if (!host) return;
    // A real (viewport-driven) mount supersedes any minimal mount.
    host.__minimal = false;

    const total = layer.groups.length;
    const geom = this.getGroupGeometry(host, layer);
    const perRow = geom.itemsPerRow;

    const hostRect = this.rectOf(host);
    // Tags scroll with the page, so the visible slice is expressed in the
    // list's own coordinate space.
    const visible = computeVisibleRange({
      total,
      viewportStart: -hostRect.top,
      viewportEnd: this.viewportHeight() - hostRect.top,
      itemSize: geom.rowHeight,
      overscan: VIRTUAL_POLICY.overscanItems,
      minItems: VIRTUAL_POLICY.minWindowItems,
    });
    const win = computeEffectiveWindow(total, visible);

    // Convert the row-based window into an item index range, snapped to whole
    // rows so the mounted block always wraps the same way as the full list.
    const firstRow = Math.floor(win.start / perRow);
    const lastRow = Math.ceil(win.end / perRow);
    const start = Math.max(0, firstRow * perRow);
    const end = Math.min(total, lastRow * perRow);

    const parts = [];
    for (let i = start; i < end; i++) {
      parts.push(this.groupTagHtml(layer, i));
    }

    // Spacers are whole rows, which is what flex-wrap actually lays out.
    const beforeRows = Math.floor(start / perRow);
    const afterRows = Math.max(0, geom.totalRows - Math.ceil(end / perRow));
    const beforeH = beforeRows * geom.rowHeight;
    const afterH = afterRows * geom.rowHeight;

    host.innerHTML = '';
    if (beforeH > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer';
      spacer.style.height = `${beforeH}px`;
      host.appendChild(spacer);
    }

    const row = document.createElement('div');
    row.className = 'groups-tags-mounted';
    row.innerHTML = parts.join('');
    host.appendChild(row);

    if (afterH > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer';
      spacer.style.height = `${afterH}px`;
      host.appendChild(spacer);
    }

    layer.__virtual = layer.__virtual || {};
    layer.__virtual.groups = { start, end };
  }

  // --- Pattern cells --------------------------------------------------------

  mountCellWindow(layer, card) {
    const grid = card.querySelector('.subdivision-grid');
    if (!grid) return;
    grid.__minimal = false;

    const wrap = card.querySelector('.subdivision-scroll-wrap');
    const total = layer.numerator;
    const geom = this.getCellGeometry(grid);

    // The grid is a horizontal scroller inside the card.
    const wrapWidth = wrap && wrap.clientWidth ? wrap.clientWidth : this.viewportWidth();
    const scrollLeft = wrap ? wrap.scrollLeft : 0;

    const visible = computeVisibleRange({
      total,
      viewportStart: scrollLeft,
      viewportEnd: scrollLeft + wrapWidth,
      itemSize: geom.itemWidth,
      overscan: VIRTUAL_POLICY.overscanItems,
      minItems: VIRTUAL_POLICY.minWindowItems,
    });
    const win = computeEffectiveWindow(total, visible);

    const starts = this.groupStartSet(layer);
    const parts = [];
    for (let i = win.start; i < win.end; i++) {
      parts.push(this.subdivCellHtml(layer, i, starts));
    }

    const beforeW = win.before * geom.itemWidth;
    const afterW = win.after * geom.itemWidth;

    grid.innerHTML = '';
    if (beforeW > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer-h';
      spacer.style.width = `${beforeW}px`;
      grid.appendChild(spacer);
    }

    const band = document.createElement('div');
    band.className = 'subdiv-cells-mounted';
    band.innerHTML = parts.join('');
    grid.appendChild(band);

    if (afterW > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer-h';
      spacer.style.width = `${afterW}px`;
      grid.appendChild(spacer);
    }

    layer.__virtual = layer.__virtual || {};
    layer.__virtual.cells = { start: win.start, end: win.end };
    layer.__virtual.starts = starts;
  }

  groupStartSet(layer) {
    const starts = new Set();
    let pos = 0;
    layer.groups.forEach((size) => {
      starts.add(pos);
      pos += size;
    });
    return starts;
  }

  groupTagHtml(layer, gIdx) {
    const val = layer.groups[gIdx];
    const isFirst = gIdx === 0;
    const isLast = gIdx === layer.groups.length - 1;
    return (
      `<div class="group-tag" data-gidx="${gIdx}">` +
        (isFirst ? '' : '<button class="group-tag-btn group-move-left" title="左移">◀</button>') +
        `<input type="number" class="group-tag-val" min="1" max="512" value="${val}">` +
        (isLast ? '' : '<button class="group-tag-btn group-move-right" title="右移">▶</button>') +
        '<button class="group-tag-btn group-tag-del" title="删除该组">×</button>' +
      '</div>'
    );
  }

  subdivCellHtml(layer, index, starts) {
    const type = this.state.getBeatType(layer, index);
    const isGroupStart = starts.has(index) && index > 0;
    const symbol = type === 'accent' ? '●' : (type === 'mute' ? '×' : '○');
    // A cell mounted while playing must show the current playhead immediately;
    // otherwise scrolling during playback would show stale visual state.
    const isPlayhead = this.currentPlayhead &&
      this.currentPlayhead.get(layer.id) === index &&
      this.state.isPlaying;
    return `
      <div class="subdiv-cell-wrap ${isGroupStart ? 'group-start' : ''}">
        <div class="subdiv-cell ${type}${isPlayhead ? ' active-playhead' : ''}" data-index="${index}" title="第 ${index + 1} 拍：${type}">
          <span class="cell-icon">${symbol}</span>
        </div>
        <span class="cell-num">${index + 1}</span>
      </div>
    `;
  }

  // --- Geometry -------------------------------------------------------------

  rectOf(el) {
    if (el && typeof el.getBoundingClientRect === 'function') {
      const r = el.getBoundingClientRect();
      if (r && Number.isFinite(r.top)) return r;
    }
    return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 };
  }

  viewportHeight() {
    const win = (typeof window !== 'undefined' && window) || {};
    const h = win.innerHeight;
    return Number.isFinite(h) && h > 0 ? h : 800;
  }

  viewportWidth() {
    const win = (typeof window !== 'undefined' && window) || {};
    const w = win.innerWidth;
    return Number.isFinite(w) && w > 0 ? w : 1280;
  }

  // Measured tag geometry, cached on the layer so scrolling does not remeasure.
  // Tags wrap, so the unit of layout is a row: how many fit per line and how
  // tall each line is.
  getGroupGeometry(host, layer) {
    const cached = host.__geom;
    if (cached && cached.rowHeight > 0 && cached.itemsPerRow > 0) return cached;

    const total = layer ? layer.groups.length : (host.querySelectorAll('.group-tag').length || 1);

    let itemWidth = VIRTUAL_POLICY.fallbackTagWidth;
    let rowHeight = VIRTUAL_POLICY.fallbackTagHeight;

    const first = host.querySelector('.group-tag');
    if (first) {
      const r = this.rectOf(first);
      if (r.width > 0) itemWidth = r.width + 8;   // flex column gap
      if (r.height > 0) rowHeight = r.height + 8; // flex row gap
    }

    const availWidth = host.clientWidth || this.viewportWidth() - 80;
    const itemsPerRow = Math.max(1, Math.floor(availWidth / itemWidth));

    const geom = {
      itemWidth,
      rowHeight,
      itemsPerRow,
      totalRows: Math.ceil(total / itemsPerRow),
    };
    host.__geom = geom;
    return geom;
  }

  getCellGeometry(grid) {
    const cached = grid.__geom;
    if (cached && cached.itemWidth > 0) return cached;

    const first = grid.querySelector('.subdiv-cell-wrap');
    let itemWidth = VIRTUAL_POLICY.fallbackCellWidth;
    if (first) {
      const r = this.rectOf(first);
      if (r.width > 0) itemWidth = r.width + 2; // flex gap
    }
    const geom = { itemWidth };
    grid.__geom = geom;
    return geom;
  }

  // Observe the two virtual hosts of one layer. Recreated whenever the detail
  // DOM is rebuilt; torn down when the layer collapses or is removed.
  attachLayerVirtualObserver(layer, card) {
    this.detachLayerVirtualObserver(layer.id);
    if (typeof ResizeObserver !== 'function') return;

    const tagsHost = card.querySelector('.groups-tags-list');
    const grid = card.querySelector('.subdivision-grid');
    const wrap = card.querySelector('.subdivision-scroll-wrap');
    if (!tagsHost && !grid) return;

    const observer = new ResizeObserver(() => this.scheduleVirtualRefresh(layer.id));
    if (tagsHost) observer.observe(tagsHost);
    if (grid) observer.observe(grid);
    if (wrap) observer.observe(wrap);

    this.virtualObservers.set(layer.id, observer);
  }

  detachLayerVirtualObserver(layerId) {
    const observer = this.virtualObservers.get(layerId);
    if (observer) {
      try { observer.disconnect(); } catch (e) { /* already gone */ }
      this.virtualObservers.delete(layerId);
    }
    const scheduled = this.virtualRefreshQueued.get(layerId);
    if (scheduled !== undefined) {
      this.virtualRefreshQueued.delete(layerId);
    }
  }

  // Coalesce many resize/scroll signals into one rAF-batched remount per layer.
  scheduleVirtualRefresh(layerId) {
    if (this.virtualRefreshQueued.has(layerId)) return;
    this.virtualRefreshQueued.set(layerId, true);

    const run = () => {
      this.virtualRefreshQueued.delete(layerId);
      this.refreshLayerVirtualWindows(layerId);
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, VIRTUAL_POLICY.scrollSettleMs);
    }
  }

  refreshLayerVirtualWindows(layerId) {
    const layer = this.state.layers.find((l) => l.id === layerId);
    if (!layer || !this.isLayerExpanded(layerId)) return;
    const card = document.getElementById(layerId);
    if (!card) return;

    this.mountGroupWindow(layer, card);
    this.mountCellWindow(layer, card);
  }

  // Called once per animation frame while the page scrolls: refresh only the
  // expanded layers whose virtual host is near the viewport.
  onPageScroll() {
    const vh = this.viewportHeight();
    for (const layer of this.state.layers) {
      if (!this.isLayerExpanded(layer.id)) continue;
      const card = document.getElementById(layer.id);
      if (!card) continue;

      const r = this.rectOf(card);
      // Far outside the viewport: shrink the layer's detail to its minimum so
      // off-screen layers do not keep a full window mounted while scrolling.
      // It is rebuilt the moment it comes back into range.
      if (r.height > 0 && (r.bottom < -vh || r.top > vh * 2)) {
        this.collapseVirtualWindow(layer.id);
        continue;
      }
      this.scheduleVirtualRefresh(layer.id);
    }
  }

  // Reduce an expanded layer's mounted detail to the smallest legal window.
  // Used while the layer is far off-screen; state is untouched.
  collapseVirtualWindow(layerId) {
    const layer = this.state.layers.find((l) => l.id === layerId);
    if (!layer || !this.isLayerExpanded(layerId)) return;
    const card = document.getElementById(layerId);
    if (!card) return;

    const tagsHost = card.querySelector('.groups-tags-list');
    if (tagsHost && !(tagsHost.__minimal)) {
      tagsHost.__minimal = true;
      this.renderMinimalGroupWindow(layer, card);
    }

    const grid = card.querySelector('.subdivision-grid');
    if (grid && !grid.__minimal) {
      grid.__minimal = true;
      this.renderMinimalCellWindow(layer, card);
    }
  }

  // Smallest mount that still keeps the list's geometry: a handful of rows for
  // tags, a handful of cells for the grid, with spacers for the rest.
  renderMinimalGroupWindow(layer, card) {
    const host = card.querySelector('.groups-tags-list');
    if (!host) return;
    const total = layer.groups.length;
    const geom = this.getGroupGeometry(host, layer);
    const perRow = geom.itemsPerRow;

    const mountRows = 2;
    const end = Math.min(total, perRow * mountRows);

    const parts = [];
    for (let i = 0; i < end; i++) parts.push(this.groupTagHtml(layer, i));

    const afterRows = Math.max(0, geom.totalRows - mountRows);
    host.innerHTML = '';

    const row = document.createElement('div');
    row.className = 'groups-tags-mounted';
    row.innerHTML = parts.join('');
    host.appendChild(row);

    if (afterRows > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer';
      spacer.style.height = `${afterRows * geom.rowHeight}px`;
      host.appendChild(spacer);
    }

    layer.__virtual = layer.__virtual || {};
    layer.__virtual.groups = { start: 0, end };
  }

  renderMinimalCellWindow(layer, card) {
    const grid = card.querySelector('.subdivision-grid');
    if (!grid) return;
    const total = layer.numerator;
    const geom = this.getCellGeometry(grid);

    const mountCount = Math.min(total, VIRTUAL_POLICY.minWindowItems);
    const starts = this.groupStartSet(layer);

    const parts = [];
    for (let i = 0; i < mountCount; i++) parts.push(this.subdivCellHtml(layer, i, starts));

    const afterW = Math.max(0, (total - mountCount) * geom.itemWidth);
    grid.innerHTML = '';

    const band = document.createElement('div');
    band.className = 'subdiv-cells-mounted';
    band.innerHTML = parts.join('');
    grid.appendChild(band);

    if (afterW > 0) {
      const spacer = document.createElement('div');
      spacer.className = 'virtual-spacer-h';
      spacer.style.width = `${afterW}px`;
      grid.appendChild(spacer);
    }

    layer.__virtual = layer.__virtual || {};
    layer.__virtual.cells = { start: 0, end: mountCount };
  }

  // Refresh only the cheap derived bits of a card (summary + badge), leaving
  // grouping tags and subdivision cells untouched.
  refreshLayerSummary(layer) {
    const card = document.getElementById(layer.id);
    if (!card) return;
    const summary = card.querySelector('.layer-summary');
    if (summary) summary.textContent = this.layerSummaryText(layer);
    const badge = card.querySelector('.grouping-sum-badge');
    if (badge) {
      const text = this.groupingBadgeHtml(layer);
      badge.textContent = text;
      badge.classList.toggle('error', !text.includes('✓'));
    }
  }

  // Rebuild one layer's detail without touching any other layer.
  refreshLayerDetail(layer) {
    const card = document.getElementById(layer.id);
    if (!card || !this.isLayerExpanded(layer.id)) return;
    this.renderLayerDetail(layer, card);
    this.refreshLayerSummary(layer);
  }

  // Expand or collapse a single layer. Collapsing drops the detail DOM but
  // keeps every value in state, so re-expanding rebuilds from the truth.
  setLayerExpanded(layerId, expanded) {
    const layer = this.state.layers.find((l) => l.id === layerId);
    if (!layer) return;

    const card = document.getElementById(layerId);
    if (!card) return;

    if (expanded) {
      this.expandedLayerIds.add(layerId);
    } else {
      this.expandedLayerIds.delete(layerId);
    }

    card.dataset.expanded = expanded ? '1' : '0';
    card.classList.toggle('collapsed', !expanded);

    const btn = card.querySelector('.expand-btn');
    if (btn) btn.textContent = expanded ? '▾' : '▸';

    const host = card.querySelector('.layer-detail');
    if (!host) return;

    if (expanded) {
      this.renderLayerDetail(layer, card);
    } else {
      // Release the detail DOM entirely; state is unaffected. The observer is
      // torn down too, so a collapsed layer keeps no live watchers.
      this.detachLayerVirtualObserver(layerId);
      host.replaceChildren();
    }
  }

  toggleLayerExpanded(layerId) {
    this.setLayerExpanded(layerId, !this.isLayerExpanded(layerId));
  }

  // ==========================================================================
  // Layer Card Event Listeners
  // ==========================================================================

  // Events for the always-present header controls.
  bindLayerHeaderEvents(card, layer) {
    // Name
    const nameInput = card.querySelector('.layer-name-input');
    nameInput.addEventListener('change', (e) => {
      // Keep the stored name inside the same length normalizeName() enforces,
      // so a saved preset round-trips without being silently truncated.
      const next = normalizeName(e.target.value, layer.name);
      layer.name = next;
      e.target.value = next;
    });

    // Expand / collapse this layer's detail.
    const expandBtn = card.querySelector('.expand-btn');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => this.toggleLayerExpanded(layer.id));
    }

    // Numerator. Changing it rebuilds the grouping, so only THIS layer's
    // detail is refreshed — the other cards keep their DOM and state.
    const numInput = card.querySelector('.meter-num-input');
    numInput.addEventListener('change', (e) => {
      const newNum = clampInt(e.target.value, METRONOME_LIMITS.numerator, layer.numerator);
      e.target.value = newNum;
      if (newNum !== layer.numerator) {
        layer.numerator = newNum;
        layer.groups = this.state.autoGroup(newNum);
        layer.overrides = {};
        this.refreshLayerDetail(layer);
      }
    });

    // Denominator
    const denInput = card.querySelector('.meter-den-input');
    denInput.addEventListener('change', (e) => {
      const newDen = clampInt(e.target.value, METRONOME_LIMITS.denominator, layer.denominator);
      layer.denominator = newDen;
      e.target.value = newDen;
    });

    // Sound selection
    const soundSelect = card.querySelector('.select-sound');
    soundSelect.addEventListener('change', (e) => {
      layer.sound = METRONOME_SOUNDS.includes(e.target.value) ? e.target.value : 'classic';
    });

    // Volume
    const volSlider = card.querySelector('.vol-slider');
    volSlider.addEventListener('input', (e) => {
      // Range inputs are visually bounded, but the stored value is what gets
      // saved and exported — keep it inside the shared limits regardless.
      layer.volume = clampNumber(e.target.value, METRONOME_LIMITS.volume, layer.volume);
    });

    // Accent Volume
    const accSlider = card.querySelector('.accent-slider');
    accSlider.addEventListener('input', (e) => {
      layer.accentVolume = clampNumber(e.target.value, METRONOME_LIMITS.accentVolume, layer.accentVolume);
    });

    // Multiplier
    const mulInput = card.querySelector('.multiplier-input');
    mulInput.addEventListener('change', (e) => {
      const next = clampNumber(e.target.value, METRONOME_LIMITS.bpmMultiplier, layer.bpmMultiplier);
      layer.bpmMultiplier = next;
      e.target.value = next;
    });

    // Mute toggle
    const muteBtn = card.querySelector('.mute-btn');
    muteBtn.addEventListener('click', () => {
      layer.muted = !layer.muted;
      muteBtn.classList.toggle('active', layer.muted);
      card.classList.toggle('muted', layer.muted);
    });

    // Delete layer
    const delBtn = card.querySelector('.del-layer-btn');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        if (this.state.layers.length > 1) {
          this.removeLayer(layer.id);
        }
      });
    }
  }

  // Events for the expandable detail (grouping tags + subdivision grid).
  // Rewired every time the detail DOM is rebuilt, and never registered on
  // collapsed cards because their detail is empty.
  bindLayerDetailEvents(card, layer) {
    // --- Grouping Operations ---

    // Auto Group
    card.querySelector('.btn-auto-group').addEventListener('click', () => {
      layer.groups = this.state.autoGroup(layer.numerator);
      layer.overrides = {};
      this.refreshLayerDetail(layer);
    });

    // Even Group
    card.querySelector('.btn-even-group').addEventListener('click', () => {
      const count = Math.max(1, layer.groups.length);
      const base = Math.floor(layer.numerator / count);
      const rem = layer.numerator % count;
      // When there are more groups than beats, base is 0 — clamp so the
      // result stays inside the range normalizeGroups() accepts.
      layer.groups = Array.from({ length: count }, (_, i) =>
        clampGroupValue(base + (i < rem ? 1 : 0))
      );
      layer.overrides = {};
      this.refreshLayerDetail(layer);
    });

    // Group Starts Accent
    card.querySelector('.btn-group-accent').addEventListener('click', () => {
      layer.overrides = {};
      let pos = 0;
      layer.groups.forEach((size) => {
        layer.overrides[pos] = 'accent';
        for (let i = 1; i < size && pos + i < layer.numerator; i++) {
          layer.overrides[pos + i] = 'normal';
        }
        pos += size;
      });
      this.refreshLayerDetail(layer);
    });

    // Clear Grouping
    card.querySelector('.btn-clear-group').addEventListener('click', () => {
      layer.groups = [];
      this.refreshLayerDetail(layer);
    });

    // Add Group
    card.querySelector('.add-group-btn').addEventListener('click', () => {
      // maxGroupEntries is a per-layer limit: normalizeGroups() receives one
      // layer's groups array, so the UI must count the same array.
      if (layer.groups.length >= METRONOME_LIMITS.maxGroupEntries) {
        this.showToast(`该 Layer 的分组数量已达上限 (${METRONOME_LIMITS.maxGroupEntries})。`);
        return;
      }

      const currentSum = layer.groups.reduce((a, b) => a + b, 0);
      const remaining = Math.max(1, layer.numerator - currentSum);
      layer.groups.push(clampGroupValue(remaining > 0 ? remaining : 2));
      this.refreshLayerDetail(layer);
    });

    // Group tag interactions are delegated to the two stable containers, so a
    // 1024-group layer costs 1 listener instead of ~4000. The index is read
    // from the DOM at click time, which keeps it correct after edits.
    const tagsContainer = card.querySelector('.groups-tags-container');
    if (tagsContainer && !tagsContainer.dataset.bound) {
      tagsContainer.dataset.bound = '1';

      tagsContainer.addEventListener('change', (e) => {
        const input = e.target.closest('.group-tag-val');
        if (!input) return;
        const tag = input.closest('.group-tag');
        if (!tag) return;
        const gIdx = parseInt(tag.dataset.gidx, 10);
        if (!Number.isInteger(gIdx)) return;

        const val = clampGroupValue(input.value);
        layer.groups[gIdx] = val;
        input.value = val;

        // Only the derived summary changes; the group list itself is correct
        // in place, so the tags are NOT rebuilt here.
        this.refreshLayerSummary(layer);
        this.refreshSubdivisionTypes(layer);
      });

      tagsContainer.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const tag = btn.closest('.group-tag');
        const gIdx = tag ? parseInt(tag.dataset.gidx, 10) : -1;

        if (btn.classList.contains('group-tag-del')) {
          if (!Number.isInteger(gIdx)) return;
          layer.groups.splice(gIdx, 1);
          this.refreshLayerDetail(layer);
          return;
        }

        if (btn.classList.contains('group-move-left')) {
          if (!Number.isInteger(gIdx) || gIdx <= 0) return;
          const temp = layer.groups[gIdx];
          layer.groups[gIdx] = layer.groups[gIdx - 1];
          layer.groups[gIdx - 1] = temp;
          this.refreshLayerDetail(layer);
          return;
        }

        if (btn.classList.contains('group-move-right')) {
          if (!Number.isInteger(gIdx) || gIdx >= layer.groups.length - 1) return;
          const temp = layer.groups[gIdx];
          layer.groups[gIdx] = layer.groups[gIdx + 1];
          layer.groups[gIdx + 1] = temp;
          this.refreshLayerDetail(layer);
        }
      });
    }

    // --- Subdivision Interactive Cell Click (delegated) ---
    const grid = card.querySelector('.subdivision-grid');
    if (grid && !grid.dataset.bound) {
      grid.dataset.bound = '1';
      grid.addEventListener('click', (e) => {
        const cell = e.target.closest('.subdiv-cell');
        if (!cell) return;
        const index = parseInt(cell.dataset.index, 10);
        if (!Number.isInteger(index)) return;

        const currentType = this.state.getBeatType(layer, index);
        const nextType = this.state.cycleBeatType(currentType);
        layer.overrides[index] = nextType;

        // Immediate visual update of the single cell that changed.
        cell.className = `subdiv-cell ${nextType}`;
        const icon = cell.querySelector('.cell-icon');
        if (icon) icon.textContent = nextType === 'accent' ? '●' : (nextType === 'mute' ? '×' : '○');
        cell.title = `第 ${index + 1} 拍：${nextType}`;
      });
    }

    // Pattern buttons
    card.querySelector('.btn-reset-pattern').addEventListener('click', () => {
      layer.overrides = {};
      this.refreshLayerDetail(layer);
    });

    card.querySelector('.btn-all-normal').addEventListener('click', () => {
      layer.overrides = {};
      for (let i = 0; i < layer.numerator; i++) {
        layer.overrides[i] = 'normal';
      }
      this.refreshLayerDetail(layer);
    });

    card.querySelector('.btn-random-pattern').addEventListener('click', () => {
      layer.overrides = {};
      const choices = ['accent', 'normal', 'normal', 'normal', 'mute'];
      for (let i = 0; i < layer.numerator; i++) {
        layer.overrides[i] = choices[Math.floor(Math.random() * choices.length)];
      }
      this.refreshLayerDetail(layer);
    });
  }

  // Repaint only the beat-type classes of the cells that are currently
  // mounted, without rebuilding any DOM. Used after a grouping edit changes
  // the derived accent pattern.
  //
  // With virtualisation the mounted cells are a contiguous slice that does not
  // start at 0, so the index must come from data-index — never from the loop
  // counter, which would paint the wrong beats.
  refreshSubdivisionTypes(layer) {
    const card = document.getElementById(layer.id);
    if (!card) return;
    const grid = card.querySelector('.subdivision-grid');
    if (!grid) return;

    const starts = this.groupStartSet(layer);
    const cells = grid.querySelectorAll('.subdiv-cell');
    for (const cell of cells) {
      const index = parseInt(cell.dataset.index, 10);
      if (!Number.isInteger(index) || index < 0 || index >= layer.numerator) continue;

      const type = this.state.getBeatType(layer, index);
      const wasPlayhead = cell.classList.contains('active-playhead');
      cell.className = `subdiv-cell ${type}${wasPlayhead ? ' active-playhead' : ''}`;
      const icon = cell.querySelector('.cell-icon');
      if (icon) icon.textContent = type === 'accent' ? '●' : (type === 'mute' ? '×' : '○');
      cell.title = `第 ${index + 1} 拍：${type}`;
      const wrapEl = cell.parentElement;
      if (wrapEl && wrapEl.classList) {
        wrapEl.classList.toggle('group-start', starts.has(index) && index > 0);
      }
    }
  }

  // ==========================================================================
  // Presets & LocalStorage
  // ==========================================================================

  renderPresets() {
    // 1. Factory Presets
    this.dom.factoryPresets.innerHTML = '';
    this.factoryPresetsData.forEach((preset) => {
      const chip = document.createElement('div');
      chip.className = 'preset-chip';
      chip.innerHTML = `<button class="preset-chip-load">${this.escapeHtml(preset.name)}</button>`;
      chip.querySelector('.preset-chip-load').addEventListener('click', () => {
        if (this.loadPresetData(preset)) {
          this.showToast(`已加载预设：${preset.name}`);
        }
      });
      this.dom.factoryPresets.appendChild(chip);
    });

    // 2. User Presets from LocalStorage
    this.renderUserPresets();
  }

  // Corrupted storage must degrade to "no presets", never throw during init.
  // Entries are returned as-is (minus structural junk) so the raw index stays
  // usable for deletion; each preset is validated when it is loaded.
  getUserPresets() {
    try {
      const data = localStorage.getItem('polyrhythm_metronome_presets');
      if (!data) return [];
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        console.warn('Ignoring preset storage: value is not an array.');
        return [];
      }
      return parsed;
    } catch (e) {
      console.warn('Failed to read preset storage:', e);
      return [];
    }
  }

  isPresetLike(preset) {
    return !!preset && typeof preset === 'object' && !Array.isArray(preset);
  }

  saveUserPresetsToStorage(presets) {
    try {
      localStorage.setItem('polyrhythm_metronome_presets', JSON.stringify(presets));
    } catch (e) {
      console.warn('LocalStorage error:', e);
    }
  }

  renderUserPresets() {
    const presets = this.getUserPresets();
    this.dom.userPresets.innerHTML = '';

    if (presets.length === 0) {
      this.dom.userPresets.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">暂无自定义预设，输入名称点击上方“保存当前预设”即可保存。</span>';
      return;
    }

    presets.forEach((preset, index) => {
      const presetName = this.isPresetLike(preset) && typeof preset.name === 'string'
        ? preset.name
        : `Preset ${index + 1}`;
      const chip = document.createElement('div');
      chip.className = 'preset-chip';
      chip.innerHTML = `
        <button class="preset-chip-load">${this.escapeHtml(presetName)}</button>
        <button class="preset-chip-del" title="删除预设">✕</button>
      `;

      chip.querySelector('.preset-chip-load').addEventListener('click', () => {
        if (this.loadPresetData(preset)) {
          this.showToast(`已加载预设：${presetName}`);
        }
      });

      chip.querySelector('.preset-chip-del').addEventListener('click', () => {
        const updated = this.getUserPresets().filter((_, i) => i !== index);
        this.saveUserPresetsToStorage(updated);
        this.renderUserPresets();
        this.showToast(`已删除预设：${presetName}`);
      });

      this.dom.userPresets.appendChild(chip);
    });
  }

  saveUserPreset(name) {
    const newPreset = {
      name: normalizeName(name, `Preset ${new Date().toLocaleTimeString()}`),
      bpm: this.state.bpm,
      layers: this.state.layers.map((l) => ({
        name: l.name,
        numerator: l.numerator,
        denominator: l.denominator,
        bpmMultiplier: l.bpmMultiplier,
        groups: [...l.groups],
        overrides: { ...l.overrides },
        sound: l.sound,
        volume: l.volume,
        accentVolume: l.accentVolume,
        muted: l.muted,
      })),
      timestamp: Date.now(),
    };

    // Never persist a preset the loader would refuse. This is the same
    // validator loadPresetData() uses, so save and load cannot disagree.
    const check = this.state.normalizeConfiguration(newPreset);
    if (!check.ok) {
      console.warn('Refusing to save invalid preset:', check.reason);
      this.showToast('当前配置无法保存为预设，已保持原有预设不变。');
      return false;
    }

    const presets = this.getUserPresets();
    presets.unshift(newPreset);
    this.saveUserPresetsToStorage(presets);
    this.renderUserPresets();
    this.showToast(`预设「${newPreset.name}」已保存到本地！`);
    return true;
  }

  loadPresetData(preset) {
    // Presets use the long-form field names. Route them through the same
    // validator as shared URLs so a hand-edited localStorage entry cannot
    // inject NaN/Infinity or out-of-range meters into the scheduler.
    const normalized = this.state.normalizeConfiguration(preset);
    if (!normalized.ok) {
      console.warn('Rejected preset:', normalized.reason, preset);
      this.showToast('该预设数据无效，已保持当前配置。');
      return false;
    }

    const wasPlaying = this.state.isPlaying;
    if (wasPlaying) {
      this.stopPlayback();
    }

    this.applyConfiguration(normalized);

    if (wasPlaying) {
      this.startPlayback();
    }
    return true;
  }

  // Single place that swaps the live configuration and resets transport state.
  // Expansion state is UI-only, so it is recomputed for the new configuration;
  // the beat data itself is never touched by render state.
  applyConfiguration({ bpm, layers }) {
    this.state.bpm = bpm;
    this.state.layers = layers;
    this.state.clearVisualQueue();
    this.applyInitialExpansionState();
    this.renderAll();
  }

  // ==========================================================================
  // URL Sharing
  // ==========================================================================

  shareConfiguration() {
    const config = {
      bpm: this.state.bpm,
      layers: this.state.layers.map((l) => ({
        n: l.name,
        num: l.numerator,
        den: l.denominator,
        mul: l.bpmMultiplier,
        g: l.groups,
        ov: Object.entries(l.overrides).map(([k, v]) => [Number(k), v]),
        snd: l.sound,
        vol: l.volume,
        av: l.accentVolume,
        m: l.muted ? 1 : 0,
      })),
    };

    try {
      const jsonStr = JSON.stringify(config);
      const encoded = btoa(encodeURIComponent(jsonStr));

      // Same measurement as the import path (loadStateFromUrl compares
      // hash.length). Checked before touching the clipboard or the URL, so an
      // oversized config can never produce a link this app would refuse.
      //
      // A configuration being too large to share does NOT make it invalid: it
      // is still a legal local configuration and can be saved as a preset.
      // The message says so explicitly, so the two conditions are not confused.
      if (!isPayloadWithinLimit(encoded)) {
        this.showToast(
          `配置过大（${encoded.length} 字符，上限 ${METRONOME_LIMITS.maxPayloadLength}），无法生成分享链接；该配置仍然有效，可保存为本地预设。`
        );
        return false;
      }

      const url = new URL(window.location.href);
      url.hash = encoded;

      navigator.clipboard.writeText(url.toString()).then(() => {
        this.showToast('已复制完整配置的分享链接到剪贴板！');
      }).catch(() => {
        window.location.hash = encoded;
        this.showToast('已更新 URL Hash，可直接复制地址栏分享！');
      });
      return true;
    } catch (e) {
      console.error('URL encode failed', e);
      this.showToast('生成分享链接失败，请检查当前配置。');
      return false;
    }
  }

  // Expand the compact share-link field names into the long form used by
  // presets, so both formats meet in normalizeConfiguration(). Non-object
  // entries are passed through untouched for the validator to reject.
  expandUrlConfiguration(config) {
    return {
      bpm: config.bpm,
      layers: config.layers.map((l) => {
        if (l === null || typeof l !== 'object' || Array.isArray(l)) return l;

        // `ov` is the compact [[index, type], ...] form; `overrides` is
        // accepted too so older/hand-written links keep working.
        const overrides = l.ov !== undefined ? l.ov : l.overrides;
        return {
          name: l.n !== undefined ? l.n : l.name,
          numerator: l.num !== undefined ? l.num : l.numerator,
          denominator: l.den !== undefined ? l.den : l.denominator,
          bpmMultiplier: l.mul !== undefined ? l.mul : l.bpmMultiplier,
          groups: l.g !== undefined ? l.g : l.groups,
          overrides,
          sound: l.snd !== undefined ? l.snd : l.sound,
          volume: l.vol !== undefined ? l.vol : l.volume,
          accentVolume: l.av !== undefined ? l.av : l.accentVolume,
          muted: l.m !== undefined ? !!l.m : !!l.muted,
        };
      }),
    };
  }

  loadStateFromUrl() {
    const hash = window.location.hash.slice(1);
    if (!hash) return false;

    // Bound the work before decoding: a huge or malformed hash must not be
    // able to stall or crash initialization. Shares the exact same predicate
    // as shareConfiguration().
    if (!isPayloadWithinLimit(hash)) {
      console.warn('Ignoring URL config: payload too large.');
      return false;
    }

    let config;
    try {
      config = JSON.parse(decodeURIComponent(atob(hash)));
    } catch (e) {
      console.warn('Failed to parse URL config:', e);
      return false;
    }

    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      console.warn('Ignoring URL config: not a configuration object.');
      return false;
    }
    if (!Array.isArray(config.layers)) {
      console.warn('Ignoring URL config: missing layer array.');
      return false;
    }

    const normalized = this.state.normalizeConfiguration(this.expandUrlConfiguration(config));
    if (!normalized.ok) {
      console.warn('Ignoring URL config:', normalized.reason);
      return false;
    }

    this.applyConfiguration(normalized);
    return true;
  }

  // Toast feedback
  showToast(message) {
    this.dom.toast.textContent = message;
    this.dom.toast.classList.add('show');
    clearTimeout(this.toastTimeout);
    this.toastTimeout = setTimeout(() => {
      this.dom.toast.classList.remove('show');
    }, 2500);
  }

  escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

// Instantiate on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  window.metronomeApp = new MetronomeApp();
});
