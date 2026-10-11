// Diagnostic du piano : à partir d'une mesure de chaque note, on estime le niveau général,
// on calcule une courbe d'accord adaptée à l'inharmonicité du piano et on prépare un plan d'accord.

import { KEY_COUNT, A4_KEY, railsbackCents } from './tuning.js';

const MID = [28, 60]; // touches servant à estimer le niveau général (Do3 à Sol♯5)
const ROUGH_LIMIT = 15; // ¢ : au-delà, une seule passe ne suffit pas (les cordes bougent en se tendant)
const OVERPULL = 0.25; // part de l'écart à dépasser lors de la passe de remise au diapason
const OVERPULL_MAX = 15; // ¢
const RISKY_RAISE = 50; // ¢ : remonter davantage en une fois risque de casser des cordes

// Historique du piano (demandé au rapport). Il dose la remontée par séance et l'espacement des séances :
// - un piano ancien supporte mal les grandes corrections : par pas de 10 à 15 ¢ de sur-tension au plus
//   pour un piano de 40 à 70 ans (Total Piano Care, « Pitch Raise ») ;
// - un piano délaissé longtemps a des cordes installées à basse tension depuis des années (et souvent
//   rouillées) : plus de risque de casse, et il redescend davantage entre deux séances ;
// - après une forte remontée, on réaccorde 2 à 4 semaines plus tard, puis vers 3 mois, puis tous les 6 mois
//   (même source) ; plusieurs remontées sont souvent nécessaires avant que l'accord tienne (PTG, Kawai).
export const LAST_TUNING = {
  recent: 'il y a moins d\u2019un an',
  few: 'il y a 1 à 3 ans',
  long: 'il y a 3 à 10 ans',
  veryLong: 'il y a plus de 10 ans',
  unknown: 'je ne sais pas',
};
export const PIANO_AGE = { young: 'moins de 40 ans', old: '40 ans ou plus', unknown: 'je ne sais pas' };

export const TEMPERAMENT_OCTAVE = [37, 49]; // La3 → La4, accordé en premier

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Inharmonicité typique d'un piano droit, utilisée là où aucune mesure n'existe.
export function defaultB(key) {
  // ≈ 2,5e-4 vers Fa♯2 (le minimum), ≈ 9e-4 au La4, ≈ 1,4e-2 au Do8, ≈ 5e-4 au La0
  return key >= 30 ? 10 ** (-3.6 + 0.03 * (key - 30)) : 10 ** (-3.6 + 0.01 * (30 - key));
}

// Lisse les mesures de B (bruitées, parfois absentes) : médiane locale du rapport mesure / modèle.
export function smoothB(measured) {
  const ratios = {};
  for (const [k, B] of Object.entries(measured)) {
    if (B > 0) ratios[k] = Math.log(B / defaultB(Number(k)));
  }
  const all = Object.values(ratios);
  const global = all.length ? median(all) : 0;
  const out = new Array(KEY_COUNT + 1).fill(0);
  for (let k = 1; k <= KEY_COUNT; k++) {
    const near = [];
    for (let j = k - 4; j <= k + 4; j++) if (ratios[j] != null) near.push(ratios[j]);
    const r = near.length >= 2 ? median(near) : global;
    out[k] = defaultB(k) * Math.exp(r);
  }
  return out;
}

// Courbe d'accord (cents par rapport au tempérament égal) qui rend les octaves pures pour ce piano :
// octave 2:1 dans le médium et l'aigu, 4:2 puis 6:3 dans le grave, à partir d'une octave La3–La4 tempérée.
export function curveFromB(B) {
  const c = new Array(KEY_COUNT + 1).fill(0);
  const half = (x) => 600 * Math.log2(x); // 1200·log2(√x)
  for (let k = TEMPERAMENT_OCTAVE[1] + 1; k <= KEY_COUNT; k++) {
    // partiel 2 de la note grave = partiel 1 de la note aiguë
    c[k] = c[k - 12] + half((1 + 4 * B[k - 12]) / (1 + B[k]));
  }
  for (let k = TEMPERAMENT_OCTAVE[0] - 1; k >= 1; k--) {
    const up = k + 12;
    if (k >= 25) c[k] = c[up] + half((1 + B[up]) / (1 + 4 * B[k])); // 2:1
    else if (k >= 13) c[k] = c[up] + half((1 + 4 * B[up]) / (1 + 16 * B[k])); // 4:2 : partiel 4 grave = partiel 2 aigu
    else c[k] = c[up] + half((1 + 9 * B[up]) / (1 + 36 * B[k])); // 6:3 dans l'extrême grave
  }
  return c;
}

// Remontée par séances : pas maximal par séance (¢) et semaines entre deux séances, selon l'historique.
// En cas de doute (âge ou dernier accord inconnus), on choisit la prudence.
export function raisePolicy({ lastTuning = 'unknown', age = 'unknown' } = {}) {
  const neglected = lastTuning === 'veryLong' || lastTuning === 'unknown';
  const old = age !== 'young';
  // la passe de remise au diapason sur-tend en plus de 25 % : 20 ¢ de remontée ≈ 25 ¢ de tension ajoutée
  const step = old && neglected ? 15 : old || neglected ? 20 : 30;
  return { step, weeks: neglected ? 4 : 3 };
}

// Réaccords conseillés après une remontée de `raise` ¢ (Total Piano Care) : en semaines après la séance.
export function followUp(raise) {
  if (raise >= 25) return [3, 13]; // 2 à 4 semaines, puis vers 3 mois
  if (raise >= 20) return [4];
  if (raise >= 10) return [9];
  return [];
}

// measured : { key: cents par rapport au tempérament égal à 440 Hz, sans étirement }.
// history : { lastTuning, age } (voir LAST_TUNING, PIANO_AGE).
// Renvoie le résumé et les options de diapason proposées.
export function summarize(measured, curve = null, history = {}) {
  const target = (k) => (curve ? curve[k] : railsbackCents(k));
  const dev = {};
  for (const [k, c] of Object.entries(measured)) dev[k] = c - target(Number(k));
  const mid = Object.entries(dev).filter(([k]) => k >= MID[0] && k <= MID[1]).map(([, d]) => d);
  const level = median(mid.length >= 5 ? mid : Object.values(dev)) ?? 0;

  const option = (shift) => {
    const devs = Object.values(dev).map((d) => d - shift);
    const far = devs.filter((d) => Math.abs(d) > ROUGH_LIMIT).length;
    const passes = devs.length && far / devs.length >= 0.2 ? 2 : 1;
    return { a4: 440 * 2 ** (shift / 1200), shift, passes, typical: median(devs.map(Math.abs)) ?? 0 };
  };
  const at440 = option(0);
  const keep = option(level);
  // Écart d'une note à ses voisines : signale les notes qui se distinguent du reste.
  const outliers = [];
  for (const [k, d] of Object.entries(dev)) {
    const key = Number(k);
    const around = [];
    for (let j = key - 3; j <= key + 3; j++) if (j !== key && dev[j] != null) around.push(dev[j]);
    if (around.length >= 2 && Math.abs(d - median(around)) > 12) outliers.push({ key, offset: d - median(around) });
  }
  outliers.sort((a, b) => Math.abs(b.offset) - Math.abs(a.offset));
  // Piano trop bas de plus d'un pas : on remonte vers 440 Hz en plusieurs séances, à pas égaux.
  const policy = raisePolicy(history);
  let staged = null;
  if (level < -policy.step) {
    const sessions = Math.ceil(-level / policy.step);
    const shifts = Array.from({ length: sessions }, (_, i) => level * (1 - (i + 1) / sessions) + 0); // + 0 : pas de « −0 »
    staged = {
      ...option(shifts[0]),
      sessions,
      step: -level / sessions,
      weeks: policy.weeks,
      schedule: shifts.map((shift) => ({ shift, a4: 440 * 2 ** (shift / 1200) })),
    };
  }
  const risky = level < -RISKY_RAISE;
  // grand écart : la remontée en plusieurs séances est la voie sûre vers 440 Hz
  const recommended = staged && (risky || -level > 2 * policy.step) ? 'staged' : Math.abs(level) <= 20 ? 'a440' : 'keep';
  return {
    count: Object.keys(measured).length,
    level, // ¢ : niveau général du piano par rapport à la cible à 440 Hz
    deviations: dev,
    options: staged ? { a440: at440, keep, staged } : { a440: at440, keep },
    recommended,
    risky,
    policy,
    outliers: outliers.slice(0, 8),
  };
}

// Ordre d'accord : octave du milieu (en partant du La4), puis vers l'aigu, puis vers le grave.
export function tuningOrder() {
  const order = [A4_KEY];
  for (let k = TEMPERAMENT_OCTAVE[0]; k < A4_KEY; k++) order.push(k);
  for (let k = A4_KEY + 1; k <= KEY_COUNT; k++) order.push(k);
  for (let k = TEMPERAMENT_OCTAVE[0] - 1; k >= 1; k--) order.push(k);
  return order;
}

// Plan d'accord. `dev` : écart mesuré de chaque note à sa cible (¢) ; `shift` : décalage de diapason
// choisi (¢). Avec deux passes, la première sur-tend de 25 % de l'écart pour compenser la détente
// du piano pendant qu'on remonte le reste.
export function buildPlan(dev, shift, passes) {
  const steps = [];
  for (let pass = 1; pass <= passes; pass++) {
    for (const key of tuningOrder()) {
      let overpull = 0;
      if (passes === 2 && pass === 1 && dev[key] != null) {
        const d = dev[key] - shift;
        overpull = Math.max(-OVERPULL_MAX, Math.min(OVERPULL_MAX, -OVERPULL * d));
      }
      steps.push({ key, pass, overpull });
    }
  }
  return { passes, shift, steps };
}
