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
    // Check URL state first, otherwise load default
    if (!this.loadStateFromUrl()) {
      // Default directly to 59/16 signature metronome
      this.loadPresetData(this.factoryPresetsData[0]);
    }

    this.bindEvents();
    this.renderAll();
    this.renderPresets();

    // Start requestAnimationFrame visual loop
    this.startVisualLoop();
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

  // Removing a layer while playing must also drop its pending visual events
  // and cancel the voices it already scheduled: the layer element disappears,
  // so those events could only act on a stale id, and its clicks would
  // otherwise still sound from the look-ahead window.
  removeLayer(layerId) {
    if (this.state.layers.length <= 1) return;

    this.state.layers = this.state.layers.filter((l) => l.id !== layerId);
    this.state.visualQueue = this.state.visualQueue.filter((event) => event.layerId !== layerId);
    this.audioEngine.cancelScheduledVoices(layerId);
    this.renderLayers();
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
    const layerEl = document.getElementById(layerId);
    if (!layerEl) return;

    // Remove previous playhead in this layer
    const prev = layerEl.querySelector('.subdiv-cell.active-playhead');
    if (prev) {
      prev.classList.remove('active-playhead');
    }

    // Highlight current cell
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
    const wrapRect = wrap.getBoundingClientRect();
    const cellRect = cell.getBoundingClientRect();
    const cs = getComputedStyle(wrap);
    const leftEdge = wrapRect.left + (parseFloat(cs.paddingLeft) || 0);
    const rightEdge = wrapRect.right - (parseFloat(cs.paddingRight) || 0);
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
      const newLayer = this.state.createLayer({
        name: `Layer ${this.state.layers.length + 1}`,
        numerator: 16,
        denominator: 16,
      });
      this.state.layers.push(newLayer);
      this.renderLayers();
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
    if (isNaN(newBpm)) newBpm = 120;
    newBpm = Math.max(20, Math.min(600, Math.round(newBpm)));
    this.state.bpm = newBpm;
    this.dom.bpmInput.value = newBpm;
    this.dom.bpmSlider.value = newBpm;
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

  renderLayers() {
    this.dom.layersList.innerHTML = '';
    this.state.layers.forEach((layer, index) => {
      const card = this.createLayerCardElement(layer, index);
      this.dom.layersList.appendChild(card);
    });
  }

  createLayerCardElement(layer, index) {
    const card = document.createElement('div');
    card.className = `layer-card ${layer.muted ? 'muted' : ''}`;
    card.id = layer.id;

    // Calculate grouping sum & validation
    const groupSum = layer.groups.reduce((a, b) => a + b, 0);
    const isSumValid = groupSum === layer.numerator;
    const diff = groupSum - layer.numerator;
    const diffText = diff > 0 ? `+${diff}` : `${diff}`;

    card.innerHTML = `
      <div class="layer-accent-bar" style="background: ${layer.color};"></div>
      <div class="layer-main">

        <!-- Top Header Bar -->
        <div class="layer-header-bar">
          <div class="layer-title-group">
            <span class="layer-tag" style="background: ${layer.color}22; color: ${layer.color};">#${index + 1}</span>
            <input type="text" class="layer-name-input" value="${this.escapeHtml(layer.name)}">
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
              <button class="mute-btn ${layer.muted ? 'active' : ''}">MUTE</button>
              ${this.state.layers.length > 1 ? '<button class="del-layer-btn" title="删除当前 Layer">✕</button>' : ''}
            </div>
          </div>
        </div>

        <!-- Grouping Bar -->
        <div class="grouping-bar">
          <div class="grouping-top">
            <div class="grouping-info">
              <span class="grouping-title">节奏分组 (Grouping)</span>
              <span class="grouping-sum-badge ${isSumValid ? '' : 'error'}">
                ${isSumValid ? `和 = ${groupSum} ✓` : `和 = ${groupSum} / 需 ${layer.numerator} (${diffText})`}
              </span>
            </div>

            <div class="grouping-quick-actions">
              <button class="btn btn-sm btn-auto-group" title="按3+3+2模式自动填充">自动分组</button>
              <button class="btn btn-sm btn-even-group" title="在当前组数间平均分配拍数">平均分配</button>
              <button class="btn btn-sm btn-group-accent" title="将各组起点标记为重音">组首重音</button>
              <button class="btn btn-sm btn-clear-group" title="清空所有分组">清空</button>
            </div>
          </div>

          <!-- Group Tags Editor -->
          <div class="groups-tags-container">
            ${layer.groups.map((val, gIdx) => `
              <div class="group-tag" data-gidx="${gIdx}">
                ${gIdx > 0 ? '<button class="group-tag-btn group-move-left" title="左移">◀</button>' : ''}
                <input type="number" class="group-tag-val" min="1" max="512" value="${val}">
                ${gIdx < layer.groups.length - 1 ? '<button class="group-tag-btn group-move-right" title="右移">▶</button>' : ''}
                <button class="group-tag-btn group-tag-del" title="删除该组">×</button>
              </div>
            `).join('')}
            <button class="add-group-btn">+ 添加组</button>
          </div>
        </div>

        <!-- Subdivision Interactive Grid -->
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

          <!-- Scrollable Cells -->
          <div class="subdivision-scroll-wrap">
            <div class="subdivision-grid">
              ${this.renderSubdivisionCellsHtml(layer)}
            </div>
          </div>
        </div>

      </div>
    `;

    this.bindLayerCardEvents(card, layer);
    return card;
  }

  renderSubdivisionCellsHtml(layer) {
    const cellsHtml = [];
    let groupStartIndices = new Set();
    let pos = 0;
    layer.groups.forEach((size) => {
      groupStartIndices.add(pos);
      pos += size;
    });

    for (let i = 0; i < layer.numerator; i++) {
      const type = this.state.getBeatType(layer, i);
      const isGroupStart = groupStartIndices.has(i) && i > 0;
      const symbol = type === 'accent' ? '●' : (type === 'mute' ? '×' : '○');

      cellsHtml.push(`
        <div class="subdiv-cell-wrap ${isGroupStart ? 'group-start' : ''}">
          <div class="subdiv-cell ${type}" data-index="${i}" title="第 ${i + 1} 拍：${type}">
            <span class="cell-icon">${symbol}</span>
          </div>
          <span class="cell-num">${i + 1}</span>
        </div>
      `);
    }
    return cellsHtml.join('');
  }

  // ==========================================================================
  // Layer Card Event Listeners
  // ==========================================================================

  bindLayerCardEvents(card, layer) {
    // Name
    const nameInput = card.querySelector('.layer-name-input');
    nameInput.addEventListener('change', (e) => {
      layer.name = e.target.value.trim() || layer.name;
    });

    // Numerator
    const numInput = card.querySelector('.meter-num-input');
    numInput.addEventListener('change', (e) => {
      const newNum = Math.max(1, Math.min(1024, parseInt(e.target.value, 10) || 1));
      if (newNum !== layer.numerator) {
        layer.numerator = newNum;
        layer.groups = this.state.autoGroup(newNum);
        layer.overrides = {};
        this.renderLayers();
      }
    });

    // Denominator
    const denInput = card.querySelector('.meter-den-input');
    denInput.addEventListener('change', (e) => {
      const newDen = Math.max(1, Math.min(256, parseInt(e.target.value, 10) || 1));
      layer.denominator = newDen;
    });

    // Sound selection
    const soundSelect = card.querySelector('.select-sound');
    soundSelect.addEventListener('change', (e) => {
      layer.sound = e.target.value;
    });

    // Volume
    const volSlider = card.querySelector('.vol-slider');
    volSlider.addEventListener('input', (e) => {
      layer.volume = parseFloat(e.target.value);
    });

    // Accent Volume
    const accSlider = card.querySelector('.accent-slider');
    accSlider.addEventListener('input', (e) => {
      layer.accentVolume = parseFloat(e.target.value);
    });

    // Multiplier
    const mulInput = card.querySelector('.multiplier-input');
    mulInput.addEventListener('change', (e) => {
      layer.bpmMultiplier = Math.max(0.1, Math.min(8.0, parseFloat(e.target.value) || 1.0));
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

    // --- Grouping Operations ---

    // Auto Group
    card.querySelector('.btn-auto-group').addEventListener('click', () => {
      layer.groups = this.state.autoGroup(layer.numerator);
      layer.overrides = {};
      this.renderLayers();
    });

    // Even Group
    card.querySelector('.btn-even-group').addEventListener('click', () => {
      const count = Math.max(1, layer.groups.length);
      const base = Math.floor(layer.numerator / count);
      const rem = layer.numerator % count;
      layer.groups = Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
      layer.overrides = {};
      this.renderLayers();
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
      this.renderLayers();
    });

    // Clear Grouping
    card.querySelector('.btn-clear-group').addEventListener('click', () => {
      layer.groups = [];
      this.renderLayers();
    });

    // Add Group
    card.querySelector('.add-group-btn').addEventListener('click', () => {
      const currentSum = layer.groups.reduce((a, b) => a + b, 0);
      const remaining = Math.max(1, layer.numerator - currentSum);
      layer.groups.push(remaining > 0 ? remaining : 2);
      this.renderLayers();
    });

    // Group items: values, delete, re-order
    card.querySelectorAll('.group-tag').forEach((tagEl) => {
      const gIdx = parseInt(tagEl.dataset.gidx, 10);

      // Value change
      const valInput = tagEl.querySelector('.group-tag-val');
      valInput.addEventListener('change', (e) => {
        const val = Math.max(1, parseInt(e.target.value, 10) || 1);
        layer.groups[gIdx] = val;
        this.renderLayers();
      });

      // Delete
      tagEl.querySelector('.group-tag-del').addEventListener('click', () => {
        layer.groups.splice(gIdx, 1);
        this.renderLayers();
      });

      // Move Left
      const leftBtn = tagEl.querySelector('.group-move-left');
      if (leftBtn) {
        leftBtn.addEventListener('click', () => {
          if (gIdx > 0) {
            const temp = layer.groups[gIdx];
            layer.groups[gIdx] = layer.groups[gIdx - 1];
            layer.groups[gIdx - 1] = temp;
            this.renderLayers();
          }
        });
      }

      // Move Right
      const rightBtn = tagEl.querySelector('.group-move-right');
      if (rightBtn) {
        rightBtn.addEventListener('click', () => {
          if (gIdx < layer.groups.length - 1) {
            const temp = layer.groups[gIdx];
            layer.groups[gIdx] = layer.groups[gIdx + 1];
            layer.groups[gIdx + 1] = temp;
            this.renderLayers();
          }
        });
      }
    });

    // --- Subdivision Interactive Cell Click ---
    card.querySelectorAll('.subdiv-cell').forEach((cell) => {
      cell.addEventListener('click', () => {
        const index = parseInt(cell.dataset.index, 10);
        const currentType = this.state.getBeatType(layer, index);
        const nextType = this.state.cycleBeatType(currentType);
        layer.overrides[index] = nextType;

        // Immediate visual update of cell
        cell.className = `subdiv-cell ${nextType}`;
        cell.querySelector('.cell-icon').textContent = nextType === 'accent' ? '●' : (nextType === 'mute' ? '×' : '○');
        cell.title = `第 ${index + 1} 拍：${nextType}`;
      });
    });

    // Pattern buttons
    card.querySelector('.btn-reset-pattern').addEventListener('click', () => {
      layer.overrides = {};
      this.renderLayers();
    });

    card.querySelector('.btn-all-normal').addEventListener('click', () => {
      layer.overrides = {};
      for (let i = 0; i < layer.numerator; i++) {
        layer.overrides[i] = 'normal';
      }
      this.renderLayers();
    });

    card.querySelector('.btn-random-pattern').addEventListener('click', () => {
      layer.overrides = {};
      const choices = ['accent', 'normal', 'normal', 'normal', 'mute'];
      for (let i = 0; i < layer.numerator; i++) {
        layer.overrides[i] = choices[Math.floor(Math.random() * choices.length)];
      }
      this.renderLayers();
    });
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
    const presets = this.getUserPresets();
    const newPreset = {
      name,
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

    presets.unshift(newPreset);
    this.saveUserPresetsToStorage(presets);
    this.renderUserPresets();
    this.showToast(`预设「${name}」已保存到本地！`);
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
  applyConfiguration({ bpm, layers }) {
    this.state.bpm = bpm;
    this.state.layers = layers;
    this.state.clearVisualQueue();
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
      const url = new URL(window.location.href);
      url.hash = encoded;

      navigator.clipboard.writeText(url.toString()).then(() => {
        this.showToast('已复制完整配置的分享链接到剪贴板！');
      }).catch(() => {
        window.location.hash = encoded;
        this.showToast('已更新 URL Hash，可直接复制地址栏分享！');
      });
    } catch (e) {
      console.error('URL encode failed', e);
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
    // able to stall or crash initialization.
    if (hash.length > METRONOME_LIMITS.maxPayloadLength) {
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
