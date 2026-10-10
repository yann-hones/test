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
- **Diagnostic du piano** : on joue les 88 notes, l'appli mesure l'écart de chacune et la raideur des cordes, puis
  produit un rapport (niveau général, notes à surveiller) et propose un plan : diapason (440 Hz ou celui du piano),
  une ou deux passes (remise au diapason avec sur-tension de 25 %, puis accord fin), ordre des accordeurs.
- **Courbe d'accord calculée pour le piano** à partir de l'inharmonicité mesurée (octaves pures 2:1, 4:2 puis 6:3
  dans le grave), au choix à la place de la courbe de Railsback moyenne.
- Consignes en clair (« ▲ Tendre », « ▼ Détendre », « ✓ Juste ») et mode d'emploi intégré.
- **Guide de démarrage** à la première visite (matériel, placement de l'appareil, test du micro, par où commencer),
  réouvrable avec le bouton « Guide ».
- Installable sur l'écran d'accueil du téléphone et utilisable hors connexion (en https).
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

puis ouvrir <http://localhost:8000>. Sans serveur : `npm run build` produit `accordeur.html`, un fichier unique
qu'il suffit d'ouvrir dans Chrome ou Edge. Pour l'utiliser sur un téléphone, publier le dossier en HTTPS (GitHub Pages par exemple).

## Sur téléphone (GitHub Pages)

Le dépôt étant public, GitHub Pages l'héberge gratuitement en https (indispensable pour le micro) :

1. Sur GitHub, ouvrir le dépôt → **Settings** → **Pages**.
2. Dans **Build and deployment**, choisir **Deploy from a branch**, puis la branche `ccr-9cad2021-4wireu` et le dossier `/ (root)`, et **Save**.
3. Après une à deux minutes, l'appli est en ligne sur <https://yann-hones.github.io/test/>.

Sur le téléphone, ouvrir cette adresse puis « Ajouter à l'écran d'accueil » : l'appli s'ouvre alors comme une
application et reste utilisable sans réseau.

## Tests

```sh
npm test
```

Les tests vérifient les calculs de justesse et l'analyse du signal sur des notes de piano synthétiques (détection de hauteur, précision < 0,1 ¢, estimation de B, sens de correction de l'unisson).

## Structure

- `index.html`, `style.css` : interface
- `js/tuning.js` : notes, fréquences cibles, tempéraments, courbe de Railsback, inharmonicité
- `js/pitch.js` : détection de hauteur, mesure des partiels, ajustement de B
- `js/diagnostic.js` : rapport du diagnostic, courbe calculée, ordre et plan d'accord
- `js/unison.js` : comparaison de deux cordes qui sonnent ensemble (sens et vitesse des battements)
- `js/capture-worklet.js` : capture continue du micro (plusieurs secondes de son sans coupure)
- `js/main.js` : micro, boucle d'analyse, affichage et interactions
