import { rms, detectPitch, measurePeak, fitInharmonicity } from './pitch.js';
import { analyzeUnison } from './unison.js';
import {
  KEY_COUNT, keyName, isBlackKey, pitchClass, cents, targetFreq, targetOffsetCents,
  railsbackCents, nearestKey, defaultPartial, defaultStrings, inharmonicRatio, TEMPERAMENTS,
} from './tuning.js';

const $ = (id) => document.getElementById(id);

const GATE = 0.004; // niveau RMS minimal pour analyser
const ANALYSIS_INTERVAL = 1000 / 15;
const IN_TUNE_HOLD = 1.0; // secondes dans la tolérance avant de valider une note
const MAX_PARTIALS = 8;
const RING_SIZE = 1 << 18; // ≈ 5 s d'historique continu
const UNISON_INTERVAL = 200; // ms entre deux analyses d'unisson
const UNISON_SECONDS = 4;

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
  partialFreqs: [], // dernières mesures du partiel suivi (Hz), pour figer la corde de référence
  // Assistant multi-cordes : step = numéro de la corde en cours (1 = corde de référence).
  unison: { strings: 3, step: 1, refFreq: null, refN: 1, result: null, okCount: 0, lastRun: 0, lastGood: null, lastGoodAt: 0, alone: false },
};

let audioCtx = null;
let stream = null;
let capture = null;
let buf = new Float32Array(32768); // dernière fenêtre pour l'analyse de hauteur
const ring = new Float32Array(RING_SIZE);
let ringPos = 0; // nombre total d'échantillons reçus
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
  try {
    await audioCtx.audioWorklet.addModule('js/capture-worklet.js');
    capture = new AudioWorkletNode(audioCtx, 'capture');
    capture.port.onmessage = (e) => pushSamples(e.data);
  } catch {
    // page ouverte depuis le disque (file://) ou navigateur ancien : capture par l'ancienne API
    capture = audioCtx.createScriptProcessor(2048, 1, 1);
    capture.onaudioprocess = (e) => pushSamples(e.inputBuffer.getChannelData(0));
  }
  const mute = audioCtx.createGain();
  mute.gain.value = 0; // le nœud doit être relié à la sortie pour être exécuté
  audioCtx.createMediaStreamSource(stream).connect(capture).connect(mute).connect(audioCtx.destination);
  ringPos = 0;
  ring.fill(0);
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
  capture?.disconnect();
  capture = null;
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

function pushSamples(chunk) {
  for (let i = 0; i < chunk.length; i++) ring[(ringPos + i) % RING_SIZE] = chunk[i];
  ringPos += chunk.length;
}

// Copie des `n` derniers échantillons, dans l'ordre chronologique.
function recent(n, out = new Float32Array(n)) {
  const start = ringPos - n;
  for (let i = 0; i < n; i++) out[i] = ring[(((start + i) % RING_SIZE) + RING_SIZE) % RING_SIZE];
  return out;
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

function inUnisonStep() {
  const u = state.unison;
  return state.mode === 'target' && u.step > 1 && u.step <= u.strings;
}

function analyze(dt) {
  recent(buf.length, buf);
  const sr = audioCtx.sampleRate;
  const level = rms(buf, 4096);
  $('level-bar').style.width = `${Math.min(100, Math.sqrt(level) * 250)}%`;

  if (inUnisonStep() && state.unison.alone) return analyzeAlone(dt, level);
  if (inUnisonStep()) return analyzeUnisonStep(dt, level);
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
  state.partialFreqs.push(m.freq);
  if (state.partialFreqs.length > 15) state.partialFreqs.shift();

  if (++state.frame % 3 === 0) analyzePartials(key, f1, sr);
  const done = state.mode === 'target' && state.unison.strings > 1 && state.unison.step > state.unison.strings;
  if (!done) trackProgress(key, dt); // note finie : toutes les cordes sonnent, la mesure n'est qu'indicative
}

function noSignal() {
  state.signal = false;
  state.inTuneTime = 0;
  state.history = [];
  state.partialFreqs = [];
}

// Cordes 2 et 3 : on compare la corde libérée à la corde de référence déjà juste.
function analyzeUnisonStep(dt, level) {
  const u = state.unison;
  const now = performance.now();
  if (now - u.lastRun < UNISON_INTERVAL) return;
  u.lastRun = now;
  const sr = audioCtx.sampleRate;
  const samples = recent(Math.min(RING_SIZE, Math.round(sr * UNISON_SECONDS)));
  let r = level < GATE ? null : analyzeUnison(samples, sr, u.refFreq, { fundamental: u.refFreq / u.refN });
  const confident = r && r.status !== 'unsure';
  if (confident) {
    u.lastGood = r;
    u.lastGoodAt = now;
  } else if (u.lastGood && now - u.lastGoodAt < 1500) {
    // juste après une frappe, le son est trop court pour conclure : on garde la dernière consigne fiable
    u.result = u.lastGood;
    return;
  }
  u.result = r;
  state.signal = !!r && (r.status === 'high' || r.status === 'low' || r.status === 'slow');
  state.cents = !r ? null : r.status === 'slow' ? 0 : r.cents;
  state.measuredFreq = r && state.signal ? (u.refFreq + (r.status === 'slow' ? 0 : r.beat)) / u.refN : null;
  if (r?.status === 'slow' || (state.signal && Math.abs(r.cents) <= settings.tolerance)) {
    if (++u.okCount >= 4) finishString();
  } else {
    u.okCount = 0;
  }
}

// Corde mesurée seule (la corde 1 étouffée) : comparaison directe avec la fréquence mémorisée de la corde 1.
function analyzeAlone(dt, level) {
  const u = state.unison;
  if (level < GATE) return noSignal();
  const m = measurePeak(buf, audioCtx.sampleRate, u.refFreq, { rangeCents: 70 });
  if (m.strength < 0.05) return noSignal();
  state.history.push(cents(m.freq, u.refFreq));
  if (state.history.length > 5) state.history.shift();
  const median = [...state.history].sort((a, b) => a - b)[state.history.length >> 1];
  state.cents = state.cents == null || !state.signal ? median : state.cents + 0.4 * (median - state.cents);
  state.measuredFreq = m.freq / u.refN;
  state.signal = true;
  if (Math.abs(state.cents) <= settings.tolerance) {
    state.inTuneTime += dt;
    if (state.inTuneTime >= IN_TUNE_HOLD) finishString();
  } else {
    state.inTuneTime = 0;
  }
}

function finishString() {
  const u = state.unison;
  u.okCount = 0;
  u.result = null;
  u.lastGood = null;
  u.alone = false;
  state.inTuneTime = 0;
  state.history = [];
  if (u.step < u.strings) {
    u.step++;
    return;
  }
  const p = (progress[state.key] ||= {});
  p.tuned = true;
  p.unison = true;
  save();
  u.step = u.strings + 1; // terminé
  state.signal = false;
  if (settings.autoAdvance && state.key < KEY_COUNT) state.advanceAt = performance.now() + 900;
}

// La corde de référence est juste : on fige sa fréquence et on passe à la corde suivante.
function captureReference() {
  const u = state.unison;
  const f = [...state.partialFreqs].sort((a, b) => a - b)[state.partialFreqs.length >> 1];
  u.refFreq = f;
  u.refN = state.partial;
  u.step = 2;
  u.okCount = 0;
  u.result = null;
  state.signal = false;
  state.cents = null;
}

function resetUnison() {
  const u = state.unison;
  u.strings = defaultStringsFor(state.key);
  u.step = 1;
  u.refFreq = null;
  u.result = null;
  u.lastGood = null;
  u.alone = false;
  u.okCount = 0;
}

function defaultStringsFor(key) {
  return progress[key]?.strings ?? defaultStrings(key);
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
    const multi = state.mode === 'target' && state.unison.strings > 1 && state.unison.step === 1;
    if (multi && state.inTuneTime >= IN_TUNE_HOLD && state.partialFreqs.length >= 5) {
      captureReference();
      return;
    }
    if (!multi && state.inTuneTime >= IN_TUNE_HOLD && !p.tuned) {
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
  renderAssistant();
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

// Consigne en clair : quoi faire avec la clé d'accord.
function hintText() {
  const u = state.unison;
  const name = (n) => `la corde ${n}`;
  if (state.mode === 'target' && u.strings > 1 && u.step > u.strings) {
    return { cls: 'good', text: '✓ Note terminée', sub: 'Passe à la note suivante (▶).' };
  }
  if (inUnisonStep() && u.alone) {
    const which = name(u.step);
    if (!state.signal || state.cents == null) {
      return { cls: '', text: 'Joue la note', sub: `Seule ${which} doit sonner : étouffe la corde 1${u.step === 3 ? ' et la corde 2' : ''}.` };
    }
    const c = state.cents;
    if (Math.abs(c) <= settings.tolerance) return { cls: 'good', text: '✓ Juste', sub: `${which} est accordée sur la corde 1…` };
    const small = Math.abs(c) < 5 ? ' (un tout petit peu)' : '';
    return c > 0
      ? { cls: 'warn', text: `▼ Détendre ${which}${small}`, sub: 'Trop aiguë par rapport à la corde 1.' }
      : { cls: 'warn', text: `▲ Tendre ${which}${small}`, sub: 'Trop grave par rapport à la corde 1.' };
  }
  if (inUnisonStep()) {
    const r = u.result;
    const which = name(u.step);
    if (!r) return { cls: '', text: 'Joue la note fort et laisse-la sonner', sub: `Comparaison de ${which} avec la corde 1…` };
    if (r.status === 'unsure') {
      return {
        cls: '',
        text: 'Pas d\u2019ondulation nette',
        sub: `Vérifie que ${which} n'est plus étouffée et rejoue la note fort. Si elle sonne bien, elle est sans doute déjà juste : valide-la, ou mesure-la seule pour en être sûr.`,
      };
    }
    const beats = `Ondulation : ${Math.abs(r.beat).toFixed(1).replace('.', ',')} par seconde`;
    if (r.status === 'slow' || Math.abs(r.cents) <= settings.tolerance) {
      return { cls: 'good', text: `✓ ${which[0].toUpperCase()}${which.slice(1)} est juste`, sub: 'Ne touche plus à la cheville.' };
    }
    const small = Math.abs(r.cents) < 5 ? ' (un tout petit peu)' : '';
    return r.status === 'high'
      ? { cls: 'warn', text: `▼ Détendre ${which}${small}`, sub: `Trop aiguë par rapport à la corde 1. ${beats}` }
      : { cls: 'warn', text: `▲ Tendre ${which}${small}`, sub: `Trop grave par rapport à la corde 1. ${beats}` };
  }
  if (!state.signal || state.cents == null) return { cls: '', text: 'Joue la note', sub: '' };
  const c = state.cents;
  if (Math.abs(c) <= settings.tolerance) return { cls: 'good', text: '✓ Juste', sub: 'Garde la note qui sonne quelques instants…' };
  const small = Math.abs(c) < 5 ? ' (un tout petit peu)' : '';
  return c > 0
    ? { cls: 'warn', text: `▼ Trop aigu : détendre${small}`, sub: '' }
    : { cls: 'warn', text: `▲ Trop grave : tendre${small}`, sub: '' };
}

function stepTexts(strings, alone, step) {
  if (strings === 1) return ['Joue la note et tourne la cheville jusqu\u2019au vert.'];
  const others = strings === 2 ? 'l\u2019autre corde' : 'les deux autres cordes';
  const steps = [
    `<b>Corde 1</b> (celle du milieu, ou la gauche s'il n'y en a que deux) : étouffe ${others} avec un coin ou une bande de feutre, joue la note et règle la corde 1 avec l'aiguille.`,
    `<b>Corde 2</b> : libère la corde 2${strings === 3 ? ' (la 3 reste étouffée)' : ''} et joue la note. L'appli compare les deux cordes et te dit dans quel sens tourner.`,
  ];
  if (strings === 3) steps.push('<b>Corde 3</b> : retire le dernier coin et joue la note. Règle la corde 3 de la même façon.');
  if (alone && step > 1) {
    const muted = step === 3 ? 'les cordes 1 et 2' : 'la corde 1';
    steps[step - 1] = `<b>Corde ${step} seule</b> : étouffe ${muted} pour que seule la corde ${step} sonne, joue la note et suis l'aiguille : elle compare la corde ${step} à la note mémorisée de la corde 1.`;
  }
  return steps;
}

let lastAssistantHtml = '';
function renderAssistant() {
  const u = state.unison;
  const hint = hintText();
  const hintEl = $('hint');
  hintEl.className = `hint ${hint.cls}`;
  $('hint-text').textContent = hint.text;
  $('hint-sub').textContent = hint.sub;

  let html;
  if (state.mode !== 'target') {
    html = '<p class="muted">Clique une touche du clavier (ou ◀ ▶) pour choisir la note à accorder : l\u2019assistant te guidera corde par corde.</p>';
  } else {
    const buttons = [1, 2, 3]
      .map((n) => `<button data-strings="${n}" class="${n === u.strings ? 'active' : ''}">${n}</button>`)
      .join('');
    const steps = stepTexts(u.strings, u.alone, u.step)
      .map((t, i) => {
        const cls = u.strings === 1 ? 'current' : i + 1 < u.step ? 'done' : i + 1 === u.step ? 'current' : '';
        return `<li class="${cls}">${t}</li>`;
      })
      .join('');
    const tools = inUnisonStep()
      ? `<div class="unison-tools"><button data-validate>✓ Valider la corde ${u.step}</button>
        <button data-alone class="${u.alone ? 'active' : ''}">${u.alone ? 'Revenir à la comparaison des deux cordes' : `Mesurer la corde ${u.step} seule`}</button></div>`
      : '';
    html = `<div class="assistant-head"><span>Cordes pour cette note</span><span class="seg">${buttons}</span>
      <button data-restart>Recommencer la note</button></div><ol class="steps">${steps}</ol>${tools}`;
  }
  if (html !== lastAssistantHtml) {
    $('assistant').innerHTML = html;
    lastAssistantHtml = html;
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
    state.partialFreqs = [];
    state.advanceAt = 0;
    resetUnison();
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
  $('assistant').addEventListener('click', (e) => {
    const strings = e.target.closest('[data-strings]')?.dataset.strings;
    if (strings) {
      (progress[state.key] ||= {}).strings = Number(strings);
      resetUnison();
      save();
    } else if (e.target.closest('[data-validate]')) {
      finishString();
    } else if (e.target.closest('[data-alone]')) {
      state.unison.alone = !state.unison.alone;
      state.unison.result = null;
      state.unison.lastGood = null;
      noSignal();
    } else if (e.target.closest('[data-restart]')) {
      if (progress[state.key]) progress[state.key].tuned = false;
      resetUnison();
      state.inTuneTime = 0;
    }
  });
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
  if (capture && ringPos >= buf.length && now - lastAnalysis >= ANALYSIS_INTERVAL) {
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
resetUnison();
setMode('auto');
requestAnimationFrame(loop);
setTimeout(() => scrollToKey(state.key), 0);
