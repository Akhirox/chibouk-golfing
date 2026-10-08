# Chibouk Golf

Mini golf 3D low poly dans le navigateur, avec des parcours de 9 trous générés à chaque partie
et un multijoueur en pair-à-pair (jusqu'à 8 joueurs), sans serveur de jeu.
Three.js pour le rendu, PeerJS (WebRTC) pour le réseau, aucune étape de compilation.

## Mettre en ligne sur GitHub Pages

1. Créez un dépôt sur GitHub, par exemple `chibouk-golf`.
2. Envoyez **tout le contenu de ce dossier** à la racine du dépôt :
   `index.html`, `.nojekyll`, `css/`, `js/` et `lib/`.
   - Par l'interface web : *Add file → Upload files*, glissez les fichiers et dossiers, puis *Commit changes*.
   - En ligne de commande :
     ```bash
     git init && git add . && git commit -m "Chibouk Golf"
     git branch -M main
     git remote add origin https://github.com/VOTRE-PSEUDO/chibouk-golf.git
     git push -u origin main
     ```
3. Dans le dépôt, allez dans **Settings → Pages**, choisissez *Source : Deploy from a branch*,
   branche `main`, dossier `/ (root)`, puis *Save*.
4. Au bout d'une minute environ, le jeu est en ligne à l'adresse
   `https://VOTRE-PSEUDO.github.io/chibouk-golf/`.

> Le fichier `.nojekyll` est caché sur macOS et Linux. Vérifiez qu'il a bien été envoyé.

## Tester en local

Il faut passer par un petit serveur web (les modules JavaScript ne se chargent pas en double-cliquant sur `index.html`) :

```bash
npx serve .            # ou : python3 -m http.server 8000
```

Ouvrez ensuite l'adresse affichée (par exemple http://localhost:3000).

## Jouer

- **Jouer en solo** : 9 trous, rien qu'à vous.
- **Créer un salon** : un code de 5 caractères s'affiche. Partagez-le, ou le lien d'invitation
  (le lien rejoint le salon automatiquement).
- **Rejoindre** : entrez le code reçu.
- Dans le salon, chacun choisit son **pseudo** et la **couleur de sa balle**, puis l'hôte lance la partie.

Tout le monde joue le même trou **en même temps**. Les balles des autres apparaissent en transparence,
avec leur pseudo, et ne se touchent pas. Le trou suivant démarre quand tout le monde a terminé.

### Commandes

| Action | Souris / clavier | Tactile |
|---|---|---|
| Viser et doser | Clic gauche maintenu, glisser vers l'arrière (comme un lance-pierre), relâcher pour tirer | Un doigt |
| Annuler un tir | Revenir au point de départ, `Échap` ou clic droit | Revenir au point de départ |
| Tourner la caméra | Clic droit + glisser, ou flèches / `Q` `D` / `A` `D` | Deux doigts |
| Zoom | Molette | Pincer |
| Vue d'ensemble du trou | `V` | Bouton œil |
| Recentrer vers le trou | `C` | — |
| Carte de score | `Tab` (maintenu) | Bouton tableau |

La flèche indique la direction du tir et s'allonge avec la puissance ; la jauge en bas de l'écran affiche le pourcentage.

### Score

Score de golf classique, comparé au **PAR** de chaque trou :
trou en un, albatros (−3), eagle (−2), birdie (−1), par, bogey (+1), double bogey (+2), triple bogey (+3)…

- Balle sortie du parcours : **+1 coup** de pénalité, on rejoue depuis l'endroit du tir.
- Limite de **10 coups** par trou : au-delà, le trou est compté **11**.

## Comment ça marche

### Parcours procéduraux

Chaque trou est un chemin de cases de 2 m tracé au hasard sur une grille, sans que le chemin se touche lui-même.
Le générateur ajoute ensuite :

- des **rampes** qui montent ou descendent,
- des reliefs : **bosses**, **creux**, **dévers**, **vagues**,
- des **angles biseautés** dans les virages pour jouer les bandes,
- des obstacles : **plots**, **blocs**, **portillons** à ouverture étroite, **moulinets** qui tournent,
- des **bunkers** de sable qui freinent la balle,
- un trou à plat, en **entonnoir** ou en **volcan**,
- un thème de décor : prairie, automne, désert, neige ou crépuscule.

La difficulté augmente doucement du trou 1 au trou 9.

### Estimation du PAR

Pour chaque trou généré, un joueur virtuel joue réellement le trou avec le même moteur physique :
il calcule une carte des distances jusqu'au trou en contournant murs et obstacles, teste des centaines
de coups (direction × puissance), garde le plus sûr, puis le joue avec une petite imprécision « humaine ».
Le PAR est la moyenne de ses coups sur deux parties, arrondie (entre 2 et 6).
Un trou que le joueur virtuel n'arrive pas à finir est jeté et régénéré : chaque trou proposé est jouable.

La génération tourne en arrière-plan (Web Worker) : le premier trou est prêt en une seconde environ,
les suivants se préparent pendant que vous jouez.

### Physique

Moteur maison, à pas fixe, en mètres et secondes : gravité, roulement d'une sphère pleine sur les pentes
(accélération à 5/7 de g·sin θ), résistance au roulement de la moquette, frottement plus fort dans le sable,
rebonds amortis sur les bordures et les plots, sauts sur les crêtes si la balle va vite,
et capture au trou réaliste : trop rapide, la balle saute par-dessus ou tourne sur la lèvre.

### Multijoueur sans serveur

Les joueurs se connectent directement entre eux en WebRTC. Seule la poignée de main initiale passe par
le service public et gratuit de [PeerJS](https://peerjs.com/), qui sert d'annuaire (et de relais TURN
si deux réseaux ne peuvent pas se joindre directement). Le navigateur de l'hôte fait office d'arbitre :
il génère les trous, tient les scores et relaie les positions des balles.

Si l'hôte quitte, la partie s'arrête pour tout le monde.

Pour utiliser votre propre serveur PeerJS (`npx peerjs --port 9000`), ajoutez à l'adresse :
`?peerhost=mon-serveur&peerport=9000&peersecure=1`.

## Structure

```
index.html            page et interface
css/style.css         style (orange et noir)
js/main.js            écrans, salon, HUD, carte de score
js/game.js            un trou : balle, caméra, visée, balles des autres joueurs
js/physics.js         physique de la balle
js/course.js          génération des trous et structure du parcours
js/bot.js             joueur virtuel : vérification et estimation du PAR
js/generator.js       génération d'un trou jouable
js/gen-worker.js      génération en arrière-plan
js/render.js          rendu Three.js low poly, décors par thème
js/session.js         logique de l'hôte (salon, enchaînement des trous, scores)
js/net.js             réseau pair-à-pair (PeerJS)
js/score.js           termes de golf et totaux
js/audio.js           sons synthétisés
lib/                  three.js r185 et PeerJS 1.5.5 (licences MIT incluses)
```
