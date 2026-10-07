/**
 * Polyrhythmic Metronome
 * Pure Vanilla JavaScript + Web Audio API
 * Fully Standalone — No Server / Node Required
 */

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

    // Callbacks
    this.onBeatScheduled = null; // Called when a beat is scheduled

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

  synthClassic(time, isAccent, destination) {
    const ctx = this.audioCtx;
    const osc = ctx.createOscillator();
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
    const osc = ctx.createOscillator();
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

    const noise = ctx.createBufferSource();
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
    const osc = ctx.createOscillator();
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
    const osc = ctx.createOscillator();
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
      const osc = ctx.createOscillator();
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
  playClick(time, beatType, soundType, volume, accentVolume) {
    if (beatType === 'mute') return;

    const ctx = this.ensureContext();
    const isAccent = beatType === 'accent';
    const finalVolume = isAccent ? volume * accentVolume : volume;

    const gainNode = ctx.createGain();
    gainNode.gain.setValueAtTime(Math.min(1.0, Math.max(0, finalVolume)), time);
    gainNode.connect(this.masterGain);

    const synthFn = this.soundEngines[soundType] || this.soundEngines.classic;
    synthFn(time, isAccent, gainNode);
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
    this.visualQueue = []; // array of { layerId, subdivIndex, audioTime }
  }

  // Calculate subdivision interval in seconds:
  // Quarter note = 60 / BPM
  // Sixteenth (den=16): 60 / BPM / (16/4) = 60 / BPM / 4
  // Generic: (4 / denominator) * (60 / (BPM * multiplier))
  getSubdivDuration(layer) {
    const num = Math.max(1, layer.numerator);
    const den = Math.max(1, layer.denominator);
    const effectiveBpm = Math.max(10, this.bpm * layer.bpmMultiplier);
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

  // Create a new layer with default settings
  createLayer(config = {}) {
    const id = 'layer_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const numerator = config.numerator !== undefined ? Math.max(1, parseInt(config.numerator, 10)) : 59;
    const denominator = config.denominator !== undefined ? Math.max(1, parseInt(config.denominator, 10)) : 16;
    const groups = config.groups ? [...config.groups] : this.autoGroup(numerator);

    return {
      id,
      name: config.name || `Layer ${this.layers.length + 1}`,
      numerator,
      denominator,
      bpmMultiplier: config.bpmMultiplier || 1.0,
      groups,
      overrides: config.overrides ? { ...config.overrides } : {}, // { [subdivIndex]: 'accent'|'normal'|'mute' }
      sound: config.sound || 'classic',
      volume: config.volume !== undefined ? config.volume : 0.8,
      accentVolume: config.accentVolume !== undefined ? config.accentVolume : 1.3,
      muted: !!config.muted,

      // Runtime scheduler state
      nextNoteTime: 0,
      currentSubdiv: 0,
      color: config.color || this.getLayerColor(this.layers.length),
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

    const startTime = ctx.currentTime + 0.05;

    // Reset nextNoteTime for all layers
    this.state.layers.forEach((layer) => {
      layer.nextNoteTime = startTime;
    });

    if (this.audioEngine.timerId) {
      clearInterval(this.audioEngine.timerId);
    }

    this.audioEngine.timerId = setInterval(() => this.scheduler(), this.audioEngine.scheduleInterval);
    this.updateTransportUI();
  }

  pausePlayback() {
    this.state.isPlaying = false;
    this.state.isPaused = true;
    this.releaseWakeLock();
    if (this.audioEngine.timerId) {
      clearInterval(this.audioEngine.timerId);
      this.audioEngine.timerId = null;
    }
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
    this.state.visualQueue = [];

    // Clear active playhead styles
    document.querySelectorAll('.subdiv-cell.active-playhead').forEach((el) => {
      el.classList.remove('active-playhead');
    });

    this.updateTransportUI();
  }

  resetPosition() {
    this.state.layers.forEach((layer) => {
      layer.currentSubdiv = 0;
      if (this.state.isPlaying && this.audioEngine.audioCtx) {
        layer.nextNoteTime = this.audioEngine.currentTime + 0.05;
      }
    });
    this.state.visualQueue = [];
    document.querySelectorAll('.subdiv-cell.active-playhead').forEach((el) => {
      el.classList.remove('active-playhead');
    });
  }

  // Scheduler: runs every 25ms, schedules audio ahead of time in AudioContext
  scheduler() {
    if (!this.state.isPlaying || !this.audioEngine.audioCtx) return;

    const currentTime = this.audioEngine.currentTime;
    const scheduleUntil = currentTime + this.audioEngine.lookahead;

    this.state.layers.forEach((layer) => {
      if (layer.muted) return;
      if (layer.numerator <= 0 || layer.denominator <= 0) return;

      const subdivDuration = this.state.getSubdivDuration(layer);

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
          layer.accentVolume
        );

        // Enqueue for visual display synchronization
        this.state.visualQueue.push({
          layerId: layer.id,
          subdivIndex: beatIndex,
          audioTime: layer.nextNoteTime,
        });

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

        // Process scheduled visual beats whose audio time has arrived
        while (this.state.visualQueue.length > 0 && this.state.visualQueue[0].audioTime <= now) {
          const beat = this.state.visualQueue.shift();
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
    if (cell) {
      cell.classList.add('active-playhead');

      // Auto-scroll inside horizontal scroll wrapper if cell is outside visible area
      const scrollWrap = layerEl.querySelector('.subdivision-scroll-wrap');
      if (scrollWrap) {
        const wrapRect = scrollWrap.getBoundingClientRect();
        const cellRect = cell.getBoundingClientRect();
        if (cellRect.left < wrapRect.left || cellRect.right > wrapRect.right) {
          cell.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
        }
      }
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
          this.state.layers = this.state.layers.filter((l) => l.id !== layer.id);
          this.renderLayers();
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
        this.loadPresetData(preset);
        this.showToast(`已加载预设：${preset.name}`);
      });
      this.dom.factoryPresets.appendChild(chip);
    });

    // 2. User Presets from LocalStorage
    this.renderUserPresets();
  }

  getUserPresets() {
    try {
      const data = localStorage.getItem('polyrhythm_metronome_presets');
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
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
      const chip = document.createElement('div');
      chip.className = 'preset-chip';
      chip.innerHTML = `
        <button class="preset-chip-load">${this.escapeHtml(preset.name)}</button>
        <button class="preset-chip-del" title="删除预设">✕</button>
      `;

      chip.querySelector('.preset-chip-load').addEventListener('click', () => {
        this.loadPresetData(preset);
        this.showToast(`已加载预设：${preset.name}`);
      });

      chip.querySelector('.preset-chip-del').addEventListener('click', () => {
        const updated = this.getUserPresets().filter((_, i) => i !== index);
        this.saveUserPresetsToStorage(updated);
        this.renderUserPresets();
        this.showToast(`已删除预设：${preset.name}`);
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
    const wasPlaying = this.state.isPlaying;
    if (wasPlaying) {
      this.stopPlayback();
    }

    this.state.bpm = preset.bpm || 120;
    this.state.layers = (preset.layers || []).map((l, idx) => {
      return this.state.createLayer({
        ...l,
        color: this.state.getLayerColor(idx),
      });
    });

    this.renderAll();

    if (wasPlaying) {
      this.startPlayback();
    }
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

  loadStateFromUrl() {
    const hash = window.location.hash.slice(1);
    if (!hash) return false;

    try {
      const jsonStr = decodeURIComponent(atob(hash));
      const config = JSON.parse(jsonStr);

      if (config.bpm) this.state.bpm = config.bpm;

      if (Array.isArray(config.layers) && config.layers.length > 0) {
        this.state.layers = config.layers.map((l, idx) => {
          const overrides = {};
          if (Array.isArray(l.ov)) {
            l.ov.forEach(([k, v]) => { overrides[k] = v; });
          }

          return this.state.createLayer({
            name: l.n,
            numerator: l.num,
            denominator: l.den,
            bpmMultiplier: l.mul,
            groups: l.g,
            overrides,
            sound: l.snd,
            volume: l.vol,
            accentVolume: l.av,
            muted: !!l.m,
            color: this.state.getLayerColor(idx),
          });
        });
        return true;
      }
    } catch (e) {
      console.warn('Failed to parse URL config:', e);
    }
    return false;
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
