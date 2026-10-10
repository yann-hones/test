// Calculs de justesse : notes, fréquences cibles, tempéraments, courbe de Railsback.
// Les touches du piano sont numérotées de 1 (La0) à 88 (Do8) ; La4 = touche 49.

export const KEY_COUNT = 88;
export const A4_KEY = 49;

const NAMES = {
  fr: ['Do', 'Do♯', 'Ré', 'Ré♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'],
  en: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
};

export function keyToMidi(key) {
  return key + 20;
}

export function pitchClass(key) {
  return keyToMidi(key) % 12;
}

export function octave(key) {
  return Math.floor(keyToMidi(key) / 12) - 1;
}

export function isBlackKey(key) {
  return [1, 3, 6, 8, 10].includes(pitchClass(key));
}

export function keyName(key, lang = 'fr') {
  return `${(NAMES[lang] || NAMES.fr)[pitchClass(key)]}${octave(key)}`;
}

export function cents(f, ref) {
  return 1200 * Math.log2(f / ref);
}

// Écarts en cents par rapport au tempérament égal, par classe de hauteur (Do..Si),
// normalisés pour que La = 0 afin que le diapason reste exact.
export const TEMPERAMENTS = {
  equal: { label: 'Égal (standard)', offsets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  werckmeister3: {
    label: 'Werckmeister III',
    offsets: [11.7, 1.9, 3.9, 5.8, 1.9, 9.7, 0, 7.8, 3.9, 0, 7.8, 3.9],
  },
  kirnberger3: {
    label: 'Kirnberger III',
    offsets: [10.3, 0.5, 3.5, 4.4, -3.4, 8.3, -1.4, 6.9, 2.5, 0, 6.4, -1.4],
  },
  vallotti: {
    label: 'Vallotti',
    offsets: [5.9, 0, 2.0, 3.9, -2.0, 7.8, -2.0, 3.9, 2.0, 0, 5.9, -3.9],
  },
  meantone: {
    label: 'Mésotonique 1/4 de comma',
    offsets: [10.3, -13.7, 3.4, 20.5, -3.4, 13.7, -10.3, 6.8, -17.1, 0, 17.1, -6.8],
  },
};

// Approximation de la courbe de Railsback moyenne d'un piano droit / quart de queue :
// ≈ −28 cents au La0, ≈ 0 dans le médium, ≈ +32 cents au Do8.
// `amount` = 1 pour la courbe standard, 0 pour un accord sans étirement.
export function railsbackCents(key, amount = 1) {
  if (key >= A4_KEY) {
    const x = (key - A4_KEY) / (KEY_COUNT - A4_KEY);
    return amount * 32 * x ** 2.5;
  }
  const x = (A4_KEY - key) / (A4_KEY - 1);
  return -amount * 28 * x ** 3;
}

// Écart total (cents) de la cible par rapport au tempérament égal non étiré.
export function targetOffsetCents(key, { temperament = 'equal', stretch = 1 } = {}) {
  const t = TEMPERAMENTS[temperament] || TEMPERAMENTS.equal;
  return t.offsets[pitchClass(key)] + railsbackCents(key, stretch);
}

export function equalFreq(key, a4 = 440) {
  return a4 * 2 ** ((key - A4_KEY) / 12);
}

// Fréquence cible du fondamental de la touche, étirement et tempérament compris.
export function targetFreq(key, opts = {}) {
  return equalFreq(key, opts.a4 ?? 440) * 2 ** (targetOffsetCents(key, opts) / 1200);
}

export function nearestKey(freq, a4 = 440) {
  const key = Math.round(A4_KEY + 12 * Math.log2(freq / a4));
  return Math.min(KEY_COUNT, Math.max(1, key));
}

// Partiel mesuré par défaut selon le registre : les micros captent mal les fondamentaux graves.
export function defaultPartial(key) {
  if (key < 12) return 4;
  if (key < 28) return 2;
  return 1;
}

// Corde raide : f_n = n·f0·√(1 + B·n²). Facteur entre le partiel n réel et n × f1.
export function inharmonicRatio(n, B) {
  return Math.sqrt((1 + B * n * n) / (1 + B));
}

// Nombre de cordes par note le plus courant : 1 dans l'extrême grave, 2 dans le grave, 3 ensuite.
export function defaultStrings(key) {
  if (key <= 8) return 1;
  if (key <= 26) return 2;
  return 3;
}
