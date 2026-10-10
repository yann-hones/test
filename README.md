# Accordeur de piano

Accordeur de piano professionnel qui tourne dans le navigateur (ordinateur ou téléphone), sans installation ni dépendance.

## Fonctionnalités

- **Détection automatique de la note** (méthode de McLeod / NSDF), avec hystérésis pour éviter les sauts.
- **Note cible verrouillée** : clic sur une des 88 touches du clavier, ou flèches ← / →.
- **Mesure fine au dixième de cent** : DFT fenêtrée évaluée autour du partiel attendu, affinée par interpolation parabolique.
- **Mesure sur le partiel choisi** : par défaut le 4ᵉ dans l'extrême grave, le 2ᵉ dans le grave, le fondamental ailleurs (les micros captent mal les fondamentaux graves).
- **Inharmonicité** : le coefficient B de la corde est estimé en direct à partir des partiels 1 à 8 et sert à convertir le partiel mesuré en fondamental.
- **Courbe de Railsback** : étirement réglable de 0 à 200 % (≈ −28 ¢ au La0, ≈ +32 ¢ au Do8 à 100 %).
- **Diapason réglable** (La4 = 440, 442 Hz…) et **tempéraments historiques** (Werckmeister III, Kirnberger III, Vallotti, mésotonique).
- Aiguille ±50 ¢, **stroboscope**, barres des partiels, **courbe d'accord** du clavier entier avec les mesures.
- **Suivi de progression** : une note restée dans la tolérance pendant 1 s est marquée accordée (vert) ; passage automatique à la note suivante en option. Réglages et progression sont gardés dans le navigateur.
- Note de référence jouable, écran maintenu allumé pendant l'écoute.

Raccourcis : `←`/`→` note précédente/suivante, `A` mode auto, `R` référence, `Espace` micro.

## Lancer

Le micro n'est accessible que sur `https://` ou `localhost` :

```sh
npm start          # ou : python3 -m http.server 8000
```

puis ouvrir <http://localhost:8000>. Pour l'utiliser sur un téléphone, publier le dossier en HTTPS (GitHub Pages par exemple).

## Tests

```sh
npm test
```

Les tests vérifient les calculs de justesse et l'analyse du signal sur des notes de piano synthétiques (détection de hauteur, précision < 0,1 ¢, estimation de B).

## Structure

- `index.html`, `style.css` : interface
- `js/tuning.js` : notes, fréquences cibles, tempéraments, courbe de Railsback, inharmonicité
- `js/pitch.js` : détection de hauteur, mesure des partiels, ajustement de B
- `js/main.js` : micro, boucle d'analyse, affichage et interactions
