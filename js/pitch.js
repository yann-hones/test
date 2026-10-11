// Analyse du signal : détection de la hauteur (McLeod / NSDF) et mesure fine des partiels.

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

export function rms(buf, length = buf.length) {
  let s = 0;
  for (let i = buf.length - length; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / length);
}

// Méthode de McLeod (NSDF) sur les `size` derniers échantillons.
// Renvoie { freq, clarity } ou null si aucune périodicité nette.
export function detectPitch(buf, sampleRate, { size = 8192, minFreq = 25, maxFreq = 4500, threshold = 0.9 } = {}) {
  const n = Math.min(size, buf.length);
  const offset = buf.length - n;
  let fftSize = 1;
  while (fftSize < 2 * n) fftSize <<= 1;
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < n; i++) re[i] = buf[offset + i];
  fft(re, im);
  for (let i = 0; i < fftSize; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im); // la puissance est réelle et paire : une FFT directe vaut l'inverse à un facteur près
  const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
  const maxTau = Math.min(n - 2, Math.ceil(sampleRate / minFreq));
  const nsdf = new Float64Array(maxTau + 2);
  let m = 0;
  for (let i = 0; i < n; i++) m += 2 * buf[offset + i] ** 2;
  if (m === 0) return null;
  for (let tau = 0; tau <= maxTau + 1; tau++) {
    if (tau > 0) m -= buf[offset + tau - 1] ** 2 + buf[offset + n - tau] ** 2;
    nsdf[tau] = m > 0 ? (2 * re[tau]) / fftSize / m : 0;
  }

  // Maxima de chaque lobe positif (après le premier passage par zéro).
  const peaks = [];
  let tau = 1;
  while (tau < maxTau && nsdf[tau] > 0) tau++;
  while (tau < maxTau) {
    while (tau < maxTau && nsdf[tau] <= 0) tau++;
    let best = -1;
    while (tau < maxTau && nsdf[tau] > 0) {
      if (tau >= minTau && (best < 0 || nsdf[tau] > nsdf[best])) best = tau;
      tau++;
    }
    if (best > 0) peaks.push(best);
  }
  if (!peaks.length) return null;
  const top = Math.max(...peaks.map((p) => nsdf[p]));
  const chosen = peaks.find((p) => nsdf[p] >= threshold * top);
  const a = nsdf[chosen - 1];
  const b = nsdf[chosen];
  const c = nsdf[chosen + 1];
  const denom = a - 2 * b + c;
  const shift = denom ? (0.5 * (a - c)) / denom : 0;
  return { freq: sampleRate / (chosen + shift), clarity: b };
}

const windows = new Map();
function hann(n) {
  if (!windows.has(n)) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    windows.set(n, w);
    if (windows.size > 32) windows.delete(windows.keys().next().value);
  }
  return windows.get(n);
}

// Amplitude de la composante à `freq` (DFT fenêtrée de Hann évaluée à une fréquence arbitraire).
function amplitudeAt(buf, offset, w, freq, sampleRate) {
  const n = w.length;
  const step = (2 * Math.PI * freq) / sampleRate;
  const cs = Math.cos(step);
  const sn = Math.sin(step);
  let pr = 1;
  let pi = 0;
  let sr = 0;
  let si = 0;
  for (let i = 0; i < n; i++) {
    const v = buf[offset + i] * w[i];
    sr += v * pr;
    si += v * pi;
    const t = pr * cs - pi * sn;
    pi = pr * sn + pi * cs;
    pr = t;
  }
  return (4 * Math.hypot(sr, si)) / n; // somme d'une fenêtre de Hann ≈ n/2
}

// Mesure précise d'un pic spectral autour de `freq` (± rangeCents).
// La fenêtre couvre ~`periods` périodes, bornée à la taille du tampon.
// Renvoie { freq, amplitude, strength } ; strength ≈ part du signal portée par ce pic (0..1).
export function measurePeak(buf, sampleRate, freq, { rangeCents = 70, periods = 40, minSize = 2048 } = {}) {
  const n = Math.min(buf.length, Math.max(minSize, Math.round((sampleRate * periods) / freq)));
  const offset = buf.length - n;
  const w = hann(n);
  const amp = (f) => amplitudeAt(buf, offset, w, f, sampleRate);
  const lo = freq * 2 ** (-rangeCents / 1200);
  const hi = freq * 2 ** (rangeCents / 1200);
  // Pas de grille ≤ 1/4 de la largeur du lobe principal (2·fs/n) pour ne pas rater le pic.
  const steps = Math.max(16, Math.ceil((hi - lo) / ((0.5 * sampleRate) / n)));
  let bestF = lo;
  let bestA = -1;
  for (let i = 0; i <= steps; i++) {
    const f = lo + ((hi - lo) * i) / steps;
    const a = amp(f);
    if (a > bestA) {
      bestA = a;
      bestF = f;
    }
  }
  let h = (hi - lo) / steps;
  for (let iter = 0; iter < 12; iter++) {
    const a = Math.log(amp(bestF - h) + 1e-12);
    const b = Math.log(amp(bestF) + 1e-12);
    const c = Math.log(amp(bestF + h) + 1e-12);
    const denom = a - 2 * b + c;
    if (denom < 0) bestF += Math.max(-h, Math.min(h, (0.5 * h * (a - c)) / denom));
    h /= 2.5;
  }
  bestA = amp(bestF);
  let energy = 0;
  for (let i = offset; i < buf.length; i++) energy += buf[i] * buf[i];
  const level = Math.sqrt((2 * energy) / n); // amplitude d'une sinusoïde de même énergie
  // pic collé au bord de la zone de recherche : pas de vrai partiel dans la zone, la mesure ne vaut rien
  const edge = Math.min(bestF - lo, hi - bestF) < (hi - lo) * 0.02;
  return { freq: bestF, amplitude: bestA, strength: level ? bestA / level : 0, edge };
}

// Ajustement de f_n² / n² = f0² + f0²·B·n² (corde raide) par moindres carrés.
// `partials` : [{ n, freq }] ; renvoie { f0, B } ou null.
export function fitInharmonicity(partials) {
  if (partials.length < 3) return null;
  const pts = partials.map(({ n, freq }) => [n * n, (freq * freq) / (n * n)]);
  const mx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const my = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  let sxy = 0;
  let sxx = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
  }
  if (!sxx) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  if (intercept <= 0) return null;
  return { f0: Math.sqrt(intercept), B: slope / intercept };
}
