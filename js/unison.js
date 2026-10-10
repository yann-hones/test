// Assistant d'unisson : quand deux cordes sonnent ensemble, on démodule le signal à la fréquence
// mesurée de la corde de référence. La corde de référence donne alors un vecteur fixe et la corde
// à accorder un vecteur qui tourne à la vitesse des battements : le sens de rotation dit si elle
// est trop haute ou trop basse, sans avoir à entendre l'ondulation.

const HOP = 0.01; // s entre deux trames démodulées
const ATTACK_SKIP = 0.15; // s ignorées après la frappe du marteau

// Début de la dernière frappe (saut d'énergie) dans `samples`, en indice d'échantillon.
export function lastStrikeStart(samples, sampleRate) {
  const block = Math.round(sampleRate * HOP);
  const energies = [];
  for (let i = 0; i + block <= samples.length; i += block) {
    let e = 0;
    for (let j = i; j < i + block; j++) e += samples[j] * samples[j];
    energies.push(e / block);
  }
  // Une frappe dépasse nettement le maximum des 250 ms précédentes ; un creux de battement
  // suivi d'une remontée, lui, ne dépasse pas le niveau d'avant.
  const look = Math.round(0.25 / HOP);
  for (let b = energies.length - 1; b >= 3; b--) {
    let before = 0;
    for (let j = Math.max(0, b - look); j <= b - 3; j++) before = Math.max(before, energies[j]);
    if (energies[b] > 2.5 * before + 1e-9 && energies[b] >= energies[b - 1]) return b * block;
  }
  return 0;
}

// Trames complexes z_k = Σ x·w·e^{-i2πf t} (fenêtre de Hann, phase en temps absolu du segment).
function demodulate(samples, sampleRate, freq, win) {
  const hop = Math.round(sampleRate * HOP);
  const w = new Float64Array(win);
  for (let i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1));
  const step = (2 * Math.PI * freq) / sampleRate;
  const t = [];
  const re = [];
  const im = [];
  for (let start = 0; start + win <= samples.length; start += hop) {
    let cr = Math.cos(step * start);
    let ci = -Math.sin(step * start);
    const cs = Math.cos(step);
    const sn = Math.sin(step);
    let sr = 0;
    let si = 0;
    for (let i = 0; i < win; i++) {
      const v = samples[start + i] * w[i];
      sr += v * cr;
      si += v * ci;
      const tmp = cr * cs + ci * sn;
      ci = ci * cs - cr * sn;
      cr = tmp;
    }
    t.push((start + win / 2) / sampleRate);
    re.push(sr);
    im.push(si);
  }
  return { t, re, im };
}

// Ajuste z(t) ≈ a1 + a2·e^{iωt} par moindres carrés pour une pulsation ω donnée ; renvoie le résidu.
function residual(t, re, im, omega, total) {
  const n = t.length;
  let ur = 0;
  let ui = 0; // Σu
  let zr = 0;
  let zi = 0; // Σz
  let pr = 0;
  let pi = 0; // Σ z·conj(u)
  for (let k = 0; k < n; k++) {
    const c = Math.cos(omega * t[k]);
    const s = Math.sin(omega * t[k]);
    ur += c;
    ui += s;
    zr += re[k];
    zi += im[k];
    pr += re[k] * c + im[k] * s;
    pi += im[k] * c - re[k] * s;
  }
  // Système [n, Σu ; conj(Σu), n]·[a1 ; a2] = [Σz ; Σz·conj(u)]
  const det = n * n - (ur * ur + ui * ui);
  if (det <= 1e-9) return { res: total };
  const a1r = (n * zr - (ur * pr - ui * pi)) / det;
  const a1i = (n * zi - (ur * pi + ui * pr)) / det;
  const a2r = (n * pr - (ur * zr + ui * zi)) / det;
  const a2i = (n * pi - (ur * zi - ui * zr)) / det;
  const proj = a1r * zr + a1i * zi + a2r * pr + a2i * pi;
  return { res: total - proj, a1: Math.hypot(a1r, a1i), a2: Math.hypot(a2r, a2i) };
}

// Analyse les deux cordes. `refFreq` = fréquence mesurée du partiel suivi sur la corde déjà juste.
// Renvoie null (pas assez de son) ou { status, beat, cents, fit, ratio, span } :
//   status 'high' / 'low' : la corde à accorder est trop haute / trop basse (beat en Hz, signé) ;
//   status 'slow'         : ondulation trop lente pour être mesurée ⇒ presque juste ;
//   status 'unsure'       : pas de rotation nette (juste, ou une seule corde sonne, ou trop de bruit).
export function analyzeUnison(samples, sampleRate, refFreq, { fundamental = refFreq, maxBeat = 6, minBeat = 0.12, minSpan = 0.7 } = {}) {
  const start = lastStrikeStart(samples, sampleRate) + Math.round(ATTACK_SKIP * sampleRate);
  const seg = samples.subarray(Math.min(start, samples.length));
  // Fenêtre assez longue pour séparer les partiels voisins, assez courte pour suivre les battements.
  const win = Math.round(sampleRate * Math.min(0.25, Math.max(0.05, 6 / fundamental)));
  const span = (seg.length - win) / sampleRate;
  if (span < minSpan) return null;
  const { t, re, im } = demodulate(seg, sampleRate, refFreq, win);

  // Compense la décroissance du son (ajustement linéaire de log|z|).
  const logs = t.map((_, k) => Math.log(Math.hypot(re[k], im[k]) + 1e-12));
  const mt = t.reduce((s, v) => s + v, 0) / t.length;
  const ml = logs.reduce((s, v) => s + v, 0) / t.length;
  let num = 0;
  let den = 0;
  for (let k = 0; k < t.length; k++) {
    num += (t[k] - mt) * (logs[k] - ml);
    den += (t[k] - mt) ** 2;
  }
  const decay = den ? num / den : 0;
  for (let k = 0; k < t.length; k++) {
    const g = Math.exp(-decay * (t[k] - mt));
    re[k] *= g;
    im[k] *= g;
  }

  let total = 0;
  let mr = 0;
  let mi = 0;
  for (let k = 0; k < t.length; k++) {
    total += re[k] ** 2 + im[k] ** 2;
    mr += re[k];
    mi += im[k];
  }
  const variance = total - (mr * mr + mi * mi) / t.length; // ce que le vecteur fixe n'explique pas
  if (variance <= total * 1e-6) return { status: 'unsure', beat: 0, cents: 0, fit: 0, ratio: 0, span };

  // Recherche de ω sur une grille, puis affinage parabolique.
  const stepHz = Math.min(0.02, 0.1 / span);
  let best = null;
  const evalAt = (hz) => ({ hz, ...residual(t, re, im, 2 * Math.PI * hz, total) });
  for (let hz = -maxBeat; hz <= maxBeat; hz += stepHz) {
    if (Math.abs(hz) < minBeat) continue;
    const r = evalAt(hz);
    if (!best || r.res < best.res) best = r;
  }
  const l = evalAt(best.hz - stepHz);
  const h = evalAt(best.hz + stepHz);
  const d = l.res - 2 * best.res + h.res;
  if (d > 0) best = evalAt(best.hz + Math.max(-0.5, Math.min(0.5, (0.5 * (l.res - h.res)) / d)) * stepHz);

  const fit = Math.max(0, 1 - best.res / variance); // part des variations expliquée par une rotation
  const ratio = best.a1 ? best.a2 / best.a1 : 0; // force relative des deux cordes
  let status;
  if (fit < 0.6 || ratio < 0.15 || ratio > 6) status = 'unsure';
  else if (Math.abs(best.hz) * span < 0.4) status = 'slow'; // moins de 0,4 tour observé : sens douteux
  else status = best.hz > 0 ? 'high' : 'low';
  return {
    status,
    beat: best.hz,
    cents: 1200 * Math.log2((refFreq + best.hz) / refFreq),
    fit,
    ratio,
    span,
  };
}
