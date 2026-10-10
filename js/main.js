import { rms, detectPitch, measurePeak, fitInharmonicity } from './pitch.js';
import {
  KEY_COUNT, keyName, isBlackKey, pitchClass, cents, targetFreq, targetOffsetCents,
  railsbackCents, nearestKey, defaultPartial, inharmonicRatio, TEMPERAMENTS,
} from './tuning.js';

const $ = (id) => document.getElementById(id);

const GATE = 0.004; // niveau RMS minimal pour analyser
const ANALYSIS_INTERVAL = 1000 / 15;
const IN_TUNE_HOLD = 1.0; // secondes dans la tolérance avant de valider une note
const MAX_PARTIALS = 8;

const settings = {
  a4: 440,
  temperament: 'equal',
  stretch: 1,
  partial: 'auto',
  tolerance: 1,
  lang: 'fr',
  autoAdvance: false,
  ...load('accordeur.settings', {}),
};
// progress[key] = { cents, tuned, B }
const progress = load('accordeur.progress', {});

const state = {
  mode: 'auto', // 'auto' | 'target'
  key: 49,
  signal: false,
  cents: null,
  measuredFreq: null,
  partial: 1,
  history: [],
  candidate: null,
  candidateCount: 0,
  lastAutoHit: 0,
  inTuneTime: 0,
  advanceAt: 0,
  frame: 0,
  partials: [],
  strobePhase: 0,
};

let audioCtx = null;
let analyser = null;
let stream = null;
let buf = null;
let refOsc = null;
let wakeLock = null;

function load(name, fallback) {
  try {
    return JSON.parse(localStorage.getItem(name)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save() {
  try {
    localStorage.setItem('accordeur.settings', JSON.stringify(settings));
    localStorage.setItem('accordeur.progress', JSON.stringify(progress));
  } catch {
    // stockage indisponible (navigation privée…) : on continue sans persistance
  }
}

function tuningOpts() {
  return { a4: settings.a4, temperament: settings.temperament, stretch: settings.stretch };
}

function partialFor(key) {
  const n = settings.partial === 'auto' ? defaultPartial(key) : Number(settings.partial);
  // ne pas chercher un partiel au-delà de ce que le micro restitue correctement
  const f = targetFreq(key, tuningOpts());
  let p = n;
  while (p > 1 && p * f > Math.min(10000, (audioCtx?.sampleRate ?? 44100) / 2.2)) p--;
  return p;
}

// ---------- Audio ----------

async function startMic() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    alert(`Impossible d'accéder au micro : ${err.message}`);
    return;
  }
  audioCtx = audioCtx || new AudioContext();
  await audioCtx.resume();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 32768;
  buf = new Float32Array(analyser.fftSize);
  audioCtx.createMediaStreamSource(stream).connect(analyser);
  $('mic-btn').textContent = 'Couper le micro';
  $('mic-btn').classList.remove('primary');
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    // le verrouillage de l'écran n'est pas indispensable
  }
}

function stopMic() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  analyser = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  state.signal = false;
  $('mic-btn').textContent = 'Activer le micro';
  $('mic-btn').classList.add('primary');
  $('level-bar').style.width = '0';
}

function toggleReference() {
  if (refOsc) {
    stopReference();
    return;
  }
  audioCtx = audioCtx || new AudioContext();
  audioCtx.resume();
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = targetFreq(state.key, tuningOpts());
  const t = audioCtx.currentTime;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.2, t + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 4);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  osc.stop(t + 4);
  osc.onended = () => {
    if (refOsc === osc) stopReference();
  };
  refOsc = osc;
  $('ref-btn').classList.add('active');
}

function stopReference() {
  try {
    refOsc?.stop();
  } catch {
    // déjà arrêté
  }
  refOsc = null;
  $('ref-btn').classList.remove('active');
}

// ---------- Analyse ----------

function autoKey(sr) {
  const now = performance.now();
  const r = detectPitch(buf, sr, { size: 8192 });
  if (!r || r.clarity < 0.8) {
    return now - state.lastAutoHit < 400 ? state.key : null;
  }
  const key = nearestKey(r.freq / 2 ** (railsbackCents(nearestKey(r.freq, settings.a4), settings.stretch) / 1200), settings.a4);
  state.lastAutoHit = now;
  if (key === state.key) {
    state.candidate = null;
    return key;
  }
  // hystérésis : il faut deux détections consécutives pour changer de note
  if (key === state.candidate) state.candidateCount++;
  else {
    state.candidate = key;
    state.candidateCount = 1;
  }
  return state.candidateCount >= 2 ? key : state.key;
}

function analyze(dt) {
  analyser.getFloatTimeDomainData(buf);
  const sr = audioCtx.sampleRate;
  const level = rms(buf, 4096);
  $('level-bar').style.width = `${Math.min(100, Math.sqrt(level) * 250)}%`;

  if (level < GATE) return noSignal();
  const key = state.mode === 'target' ? state.key : autoKey(sr);
  if (!key) return noSignal();
  if (key !== state.key) selectKey(key, false);

  const opts = tuningOpts();
  const ft = targetFreq(key, opts);
  const n = partialFor(key);
  const B = progress[key]?.B ?? 0;
  const ratio = inharmonicRatio(n, B);
  const m = measurePeak(buf, sr, n * ft * ratio, { rangeCents: 70 });
  if (m.strength < 0.05) return noSignal();

  const f1 = m.freq / (n * ratio);
  state.history.push(cents(f1, ft));
  if (state.history.length > 5) state.history.shift();
  const median = [...state.history].sort((a, b) => a - b)[state.history.length >> 1];
  state.cents = state.cents == null || !state.signal ? median : state.cents + 0.4 * (median - state.cents);
  state.measuredFreq = f1;
  state.partial = n;
  state.signal = true;

  if (++state.frame % 3 === 0) analyzePartials(key, f1, sr);
  trackProgress(key, dt);
}

function noSignal() {
  state.signal = false;
  state.inTuneTime = 0;
  state.history = [];
}

function analyzePartials(key, f1, sr) {
  const found = [];
  let B = progress[key]?.B ?? 0;
  for (let n = 1; n <= MAX_PARTIALS; n++) {
    const expected = n * f1 * inharmonicRatio(n, B);
    if (expected > Math.min(12000, sr / 2.2)) break;
    const m = measurePeak(buf, sr, expected, { rangeCents: 40 });
    if (m.strength > 0.03) {
      found.push({ n, freq: m.freq, strength: m.strength });
      // affine B au fil des partiels pour mieux centrer la recherche des suivants
      const fit = fitInharmonicity(found);
      if (fit && fit.B >= 0 && fit.B < 0.05) B = fit.B;
    }
  }
  const fit = fitInharmonicity(found);
  if (fit && fit.B >= 0 && fit.B < 0.05) {
    const p = (progress[key] ||= {});
    p.B = p.B == null ? fit.B : p.B + 0.2 * (fit.B - p.B);
  }
  const base = fit?.f0 ?? f1;
  state.partials = found.map((p) => ({ ...p, dev: cents(p.freq, p.n * base) }));
}

function trackProgress(key, dt) {
  const p = (progress[key] ||= {});
  p.cents = state.cents;
  if (Math.abs(state.cents) <= settings.tolerance) {
    state.inTuneTime += dt;
    if (state.inTuneTime >= IN_TUNE_HOLD && !p.tuned) {
      p.tuned = true;
      save();
      if (settings.autoAdvance && state.mode === 'target' && key < KEY_COUNT) {
        state.advanceAt = performance.now() + 700;
      }
    }
  } else {
    state.inTuneTime = 0;
    if (Math.abs(state.cents) > settings.tolerance * 3 && p.tuned) p.tuned = false;
  }
}

// ---------- Rendu ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = Number(canvas.getAttribute('height'));
  if (canvas.width !== Math.round(w * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.height = `${h}px`;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function colorFor(c) {
  const a = Math.abs(c);
  if (a <= settings.tolerance) return cssVar('--good');
  if (a <= 10) return cssVar('--warn');
  return cssVar('--bad');
}

function drawNeedle() {
  const { ctx, w, h } = fitCanvas($('needle'));
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h - 10;
  const r = Math.min(w / 2 - 20, h - 24);
  const angle = (c) => Math.PI * 1.5 + (Math.max(-50, Math.min(50, c)) / 50) * (Math.PI * 0.42);
  const muted = cssVar('--muted');

  ctx.lineWidth = 10;
  ctx.lineCap = 'butt';
  ctx.strokeStyle = cssVar('--border');
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle(-50), angle(50));
  ctx.stroke();
  ctx.strokeStyle = cssVar('--good');
  ctx.beginPath();
  ctx.arc(cx, cy, r, angle(-Math.max(settings.tolerance, 0.6)), angle(Math.max(settings.tolerance, 0.6)));
  ctx.stroke();

  ctx.fillStyle = muted;
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  for (let c = -50; c <= 50; c += 10) {
    const a = angle(c);
    const inner = c % 50 === 0 || c === 0 ? r - 22 : r - 14;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
    ctx.lineTo(cx + Math.cos(a) * (r - 6), cy + Math.sin(a) * (r - 6));
    ctx.stroke();
    if (c % 25 === 0 || c === 0) {
      ctx.fillText(c > 0 ? `+${c}` : `${c}`, cx + Math.cos(a) * (r - 34), cy + Math.sin(a) * (r - 34) + 4);
    }
  }

  const c = state.signal && state.cents != null ? state.cents : 0;
  const a = angle(c);
  ctx.strokeStyle = state.signal ? colorFor(c) : muted;
  ctx.globalAlpha = state.signal ? 1 : 0.35;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4));
  ctx.stroke();
  ctx.beginPath();
  ctx.fillStyle = ctx.strokeStyle;
  ctx.arc(cx, cy, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}

// Stroboscope : les bandes défilent à une vitesse proportionnelle à l'écart et s'arrêtent quand c'est juste.
function drawStrobe(dt) {
  const { ctx, w, h } = fitCanvas($('strobe'));
  ctx.fillStyle = cssVar('--bg');
  ctx.fillRect(0, 0, w, h);
  if (state.signal && state.cents != null) {
    state.strobePhase += Math.max(-80, Math.min(80, state.cents)) * dt * 6;
  }
  ctx.fillStyle = state.signal ? colorFor(state.cents ?? 0) : cssVar('--border');
  const rows = [
    { y: 0, size: 48, speed: 1 },
    { y: h / 2, size: 24, speed: 2 },
  ];
  for (const row of rows) {
    const off = (((state.strobePhase * row.speed) % (row.size * 2)) + row.size * 2) % (row.size * 2);
    for (let x = off - row.size * 2; x < w; x += row.size * 2) {
      ctx.fillRect(x, row.y + 2, row.size, h / 2 - 4);
    }
  }
}

function drawCurve() {
  const { ctx, w, h } = fitCanvas($('curve'));
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 34, r: 8, t: 8, b: 20 };
  const range = 40;
  const x = (k) => pad.l + ((k - 1) / (KEY_COUNT - 1)) * (w - pad.l - pad.r);
  const y = (c) => pad.t + ((range - Math.max(-range, Math.min(range, c))) / (2 * range)) * (h - pad.t - pad.b);
  const muted = cssVar('--muted');
  const border = cssVar('--border');

  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.lineWidth = 1;
  for (let c = -range; c <= range; c += 10) {
    ctx.strokeStyle = c === 0 ? muted : border;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(c));
    ctx.lineTo(w - pad.r, y(c));
    ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(`${c > 0 ? '+' : ''}${c}`, pad.l - 4, y(c) + 3);
  }
  ctx.textAlign = 'center';
  for (let k = 4; k <= KEY_COUNT; k += 12) ctx.fillText(keyName(k, settings.lang), x(k), h - 5);

  ctx.strokeStyle = cssVar('--accent');
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let k = 1; k <= KEY_COUNT; k++) {
    const c = targetOffsetCents(k, settings);
    if (k === 1) ctx.moveTo(x(k), y(c));
    else ctx.lineTo(x(k), y(c));
  }
  ctx.stroke();

  for (let k = 1; k <= KEY_COUNT; k++) {
    const p = progress[k];
    if (p?.cents == null) continue;
    ctx.fillStyle = p.tuned ? cssVar('--good') : cssVar('--warn');
    ctx.beginPath();
    ctx.arc(x(k), y(targetOffsetCents(k, settings) + p.cents), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = cssVar('--text');
  ctx.globalAlpha = 0.3;
  ctx.beginPath();
  ctx.moveTo(x(state.key), pad.t);
  ctx.lineTo(x(state.key), h - pad.b);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function renderReadout() {
  const opts = tuningOpts();
  $('note-name').textContent = keyName(state.key, settings.lang);
  $('target-freq').textContent = targetFreq(state.key, opts).toFixed(2);
  $('stretch-used').textContent = formatCents(railsbackCents(state.key, settings.stretch));
  $('partial-used').textContent = partialFor(state.key);
  const B = progress[state.key]?.B;
  $('inharm').textContent = B == null ? '–' : B.toExponential(1);
  const el = $('cents');
  if (state.signal && state.cents != null) {
    el.textContent = `${formatCents(state.cents)} ¢`;
    const a = Math.abs(state.cents);
    el.className = `cents ${a <= settings.tolerance ? 'good' : a <= 10 ? 'warn' : 'bad'}`;
    $('measured-freq').textContent = state.measuredFreq.toFixed(2);
  } else {
    el.textContent = '— ¢';
    el.className = 'cents';
    $('measured-freq').textContent = '–';
  }
}

function formatCents(c) {
  return `${c > 0.05 ? '+' : ''}${c.toFixed(1)}`;
}

function renderPartials() {
  const box = $('partials');
  const max = Math.max(0.05, ...state.partials.map((p) => p.strength));
  box.innerHTML = '';
  for (let n = 1; n <= MAX_PARTIALS; n++) {
    const p = state.signal ? state.partials.find((q) => q.n === n) : null;
    const div = document.createElement('div');
    div.className = 'partial';
    div.innerHTML = `<div class="bar"><div class="fill" style="height:${p ? (p.strength / max) * 100 : 0}%"></div></div>
      <b>${p ? formatCents(p.dev) : '–'}</b>n=${n}`;
    box.append(div);
  }
}

function buildKeyboard() {
  const kb = $('keyboard');
  kb.innerHTML = '';
  let white = 0;
  for (let k = 1; k <= KEY_COUNT; k++) {
    const el = document.createElement('div');
    el.dataset.key = k;
    el.title = keyName(k, settings.lang);
    if (isBlackKey(k)) {
      el.className = 'key black';
      el.style.left = `calc(${white} * var(--w) - var(--w) * 0.31)`;
    } else {
      el.className = 'key white';
      el.style.left = `calc(${white} * var(--w))`;
      if (pitchClass(k) === 0) el.textContent = keyName(k, settings.lang);
      white++;
    }
    el.addEventListener('click', () => selectKey(k, true));
    kb.append(el);
  }
  renderKeyboard();
}

function renderKeyboard() {
  let tuned = 0;
  for (const el of $('keyboard').children) {
    const k = Number(el.dataset.key);
    const p = progress[k];
    if (p?.tuned) tuned++;
    el.classList.toggle('tuned', !!p?.tuned);
    el.classList.toggle('off', !p?.tuned && p?.cents != null);
    el.classList.toggle('current', k === state.key);
  }
  $('progress-count').textContent = tuned;
}

function scrollToKey(key) {
  const el = $('keyboard').querySelector(`[data-key="${key}"]`);
  const box = el?.closest('.keyboard-scroll');
  if (!box) return;
  const left = el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2;
  box.scrollTo({ left, behavior: 'smooth' });
}

// ---------- Interactions ----------

function selectKey(key, lock) {
  key = Math.min(KEY_COUNT, Math.max(1, key));
  if (lock) setMode('target');
  if (key !== state.key) {
    state.key = key;
    state.history = [];
    state.cents = null;
    state.inTuneTime = 0;
    state.partials = [];
    state.advanceAt = 0;
    if (refOsc) {
      stopReference();
      toggleReference();
    }
    scrollToKey(key);
  }
  renderKeyboard();
}

function setMode(mode) {
  state.mode = mode;
  const badge = $('mode-badge');
  badge.textContent = mode === 'auto' ? 'Auto' : 'Note verrouillée';
  badge.classList.toggle('target', mode === 'target');
  $('auto-btn').classList.toggle('active', mode === 'auto');
}

function bindSettings() {
  const sel = $('temperament');
  for (const [id, t] of Object.entries(TEMPERAMENTS)) sel.add(new Option(t.label, id));
  const fields = {
    a4: ['a4', (v) => Number(v) || 440],
    temperament: ['temperament', String],
    stretch: ['stretch', (v) => Number(v) / 100, (v) => Math.round(v * 100)],
    partial: ['partial', String],
    tolerance: ['tolerance', (v) => Math.max(0.1, Number(v) || 1)],
    lang: ['lang', String],
  };
  for (const [name, [id, parse, format = (v) => v]] of Object.entries(fields)) {
    const el = $(id);
    el.value = format(settings[name]);
    el.addEventListener('input', () => {
      settings[name] = parse(el.value);
      $('stretch-out').textContent = `${Math.round(settings.stretch * 100)} %`;
      if (name === 'lang') buildKeyboard();
      state.history = [];
      save();
    });
  }
  $('stretch-out').textContent = `${Math.round(settings.stretch * 100)} %`;
  $('auto-advance').checked = settings.autoAdvance;
  $('auto-advance').addEventListener('change', (e) => {
    settings.autoAdvance = e.target.checked;
    save();
  });
  $('reset-btn').addEventListener('click', () => {
    if (!confirm('Effacer la progression et les mesures d’inharmonicité ?')) return;
    for (const k of Object.keys(progress)) delete progress[k];
    save();
    renderKeyboard();
  });
}

function bindControls() {
  $('mic-btn').addEventListener('click', () => (stream ? stopMic() : startMic()));
  $('auto-btn').addEventListener('click', () => setMode('auto'));
  $('prev-btn').addEventListener('click', () => selectKey(state.key - 1, true));
  $('next-btn').addEventListener('click', () => selectKey(state.key + 1, true));
  $('ref-btn').addEventListener('click', toggleReference);
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowLeft') selectKey(state.key - 1, true);
    else if (e.key === 'ArrowRight') selectKey(state.key + 1, true);
    else if (e.key === 'a' || e.key === 'A') setMode('auto');
    else if (e.key === 'r' || e.key === 'R') toggleReference();
    else if (e.key === ' ') stream ? stopMic() : startMic();
    else return;
    e.preventDefault();
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && stream && !wakeLock) {
      try {
        wakeLock = await navigator.wakeLock?.request('screen');
      } catch {
        // ignoré
      }
    }
  });
}

let last = performance.now();
let lastAnalysis = 0;
let lastSlowRender = 0;
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (analyser && now - lastAnalysis >= ANALYSIS_INTERVAL) {
    analyze(Math.min(0.2, (now - lastAnalysis) / 1000));
    lastAnalysis = now;
  }
  if (state.advanceAt && now >= state.advanceAt) {
    state.advanceAt = 0;
    selectKey(state.key + 1, true);
  }
  drawNeedle();
  drawStrobe(dt);
  renderReadout();
  if (now - lastSlowRender > 250) {
    renderPartials();
    renderKeyboard();
    drawCurve();
    if (Math.floor(now / 2000) !== Math.floor(lastSlowRender / 2000)) save();
    lastSlowRender = now;
  }
  requestAnimationFrame(loop);
}

bindSettings();
bindControls();
buildKeyboard();
setMode('auto');
requestAnimationFrame(loop);
setTimeout(() => scrollToKey(state.key), 0);
