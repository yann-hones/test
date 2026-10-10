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
- **Assistant 2–3 cordes (unisson)** : la première corde se règle seule à l'aiguille, puis l'appli compare chaque corde
  suivante à la première **pendant qu'elles sonnent ensemble** et dit « tendre » ou « détendre » — pas besoin d'entendre
  l'ondulation (battement) soi-même. Repli possible : valider la corde, ou la mesurer seule contre la note mémorisée
  de la corde 1.
- Consignes en clair (« ▲ Tendre », « ▼ Détendre », « ✓ Juste ») et mode d'emploi intégré.
- Note de référence jouable, écran maintenu allumé pendant l'écoute.

### Comment l'appli trouve le sens de correction de l'unisson

La fréquence exacte de la corde 1 est mémorisée quand elle est juste. Ensuite, le son des deux cordes est démodulé
à cette fréquence : la corde 1 donne un vecteur immobile, la corde à accorder un vecteur qui tourne à la vitesse
des battements. Le **sens de rotation** dit si elle est trop haute ou trop basse, la **vitesse** donne l'écart.
Quand l'ondulation est trop lente pour être mesurée sur une frappe (moins de ~1 ¢ dans le médium), l'appli
répond « presque juste » plutôt que de risquer un mauvais sens.

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

Les tests vérifient les calculs de justesse et l'analyse du signal sur des notes de piano synthétiques (détection de hauteur, précision < 0,1 ¢, estimation de B, sens de correction de l'unisson).

## Structure

- `index.html`, `style.css` : interface
- `js/tuning.js` : notes, fréquences cibles, tempéraments, courbe de Railsback, inharmonicité
- `js/pitch.js` : détection de hauteur, mesure des partiels, ajustement de B
- `js/unison.js` : comparaison de deux cordes qui sonnent ensemble (sens et vitesse des battements)
- `js/capture-worklet.js` : capture continue du micro (plusieurs secondes de son sans coupure)
- `js/main.js` : micro, boucle d'analyse, affichage et interactions
