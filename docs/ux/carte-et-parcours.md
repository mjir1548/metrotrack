# MetroTrack bureau — Carte du logiciel et parcours

Statut : **proposition, à valider**. Date : 2026-11-25.

## 1. Les écrans

| Écran | Pour qui | Ce que la personne veut, tout de suite |
|---|---|---|
| **Assistant de premier lancement** (5 pas) | Installateur | Être opérationnel sans manuel |
| **Connexion** | Tous | Entrer vite |
| **Accueil** | Tous | Trouver un objet ; voir ce qui bouge ; savoir s'il y a quelque chose à traiter |
| **Recherche** (palette `Ctrl K` par-dessus n'importe quel écran, et page de résultats) | Utilisateur au poste | « Où est le multimètre n° 7 ? » |
| **Inventaire** (liste de tous les objets, filtre par poste) | Responsable | Parcourir, repérer, ajouter |
| **Fiche objet** | Tous | Où est l'objet, depuis quand, son histoire ; corriger si besoin |
| **Nouvelle fiche** (panneau) | Responsable | Créer avec juste un nom |
| **Postes** (tuiles) → **Un poste** | Tous | Ce qu'il y a à ce poste ; son lecteur va-t-il bien ? |
| **Puces inconnues** | Responsable | Rattacher chaque nouvelle puce à un objet |
| **Réglages** : Site, Lecteurs, Comptes, Sauvegarde, À propos | Installateur / responsable | Configurer une fois, puis oublier |

Éléments présents partout :
- la barre de navigation (Accueil, Inventaire, Postes, Puces inconnues avec compteur, Réglages) ;
- la recherche (`Ctrl K`) ;
- les notifications brèves (« Fiche enregistrée ») ;
- l'encadré « Comment ça marche ? ».

## 2. Navigation

```
                         ┌──────────── Ctrl K (partout) ─────────────┐
                         ▼                                            │
Connexion ──► ACCUEIL ──► Recherche ──► Fiche objet ◄── Inventaire ◄─┤
   ▲            │  │                      │   ▲   ▲                   │
   │            │  │                      │   │   └── Un poste ◄── Postes
 Assistant      │  └─► Puces inconnues ───┘   │
 (1er lancement)│        (créer / associer)   └── Nouvelle fiche
                └─► Réglages (Site, Lecteurs, Comptes, Sauvegarde)
```

- Un clic sur un mouvement de l'accueil ouvre la fiche de l'objet.
- Un clic sur un nom de poste ouvre le poste, partout où il apparaît.
- Une notification « Puce inconnue scannée au Poste B » ouvre directement le choix « Créer / Associer ».

## 3. Les six parcours, pas à pas

### Parcours 1 — Premier lancement (installateur)
1. Le logiciel s'ouvre sur **Bienvenue** : « On va préparer MetroTrack en 4 étapes, environ 5 minutes. » [Commencer]
2. **Votre compte** : prénom et nom, identifiant, mot de passe (deux fois, avec indicateur de solidité). [Continuer]
3. **Votre site** : « Comment s'appelle ce lieu ? » (ex. « Laboratoire Lyon-Gerland »). [Continuer]
4. **Vos postes** : une liste à remplir (« Poste A · Réception », « Banc d'essais »…) ; Entrée ajoute une ligne. Au moins un poste. [Continuer]
5. **Vos lecteurs** : pour chaque poste, [Appairer un lecteur]. Une carte affiche :
   - le numéro du lecteur et sa clé, en gros, avec [Copier] en un clic ;
   - un message rassurant : « Cette clé ne s'affichera qu'une fois. Copiez-la dans le boîtier maintenant. Si vous la perdez, pas de panique : vous pourrez en générer une nouvelle. »
   - une case à cocher « J'ai copié la clé dans le boîtier ».

   On peut passer cette étape et la faire plus tard.
6. **C'est prêt** : « Scannez votre premier objet au poste de votre choix. » L'écran attend le scan en direct. Dès qu'une puce arrive : « Puce reçue au Poste A ! Créons sa fiche. » (parcours 3).

### Parcours 2 — « Où est cet objet ? » (le parcours principal)
1. Depuis n'importe quel écran : `Ctrl K` (ou clic sur la recherche toujours visible).
2. On tape « multi » : les résultats s'affichent **pendant la frappe** (nom, numéro, valeur de propriété comme le n° de série).
3. Le premier résultat montre **en grand** « Poste B · Banc d'essais — depuis 4 min ». La réponse est déjà là : **parcours terminé en 1 geste et 5 lettres**.
4. Optionnel : Entrée ou clic ouvre la fiche.

### Parcours 3 — Une puce inconnue vient d'être scannée
1. Le scan arrive. Partout dans le logiciel, une notification apparaît en direct : « Nouvelle puce scannée au Poste B · Banc d'essais ». L'accueil la montre aussi en tête de « À traiter ».
2. Deux boutons : [Créer une fiche] [Associer à une fiche existante].
3. **Créer** : un panneau s'ouvre avec la puce déjà rattachée ; on tape un nom, Entrée. L'objet est aussitôt localisé au Poste B. Notification : « Multimètre n° 8 créé, au Poste B. »
4. **Associer** : un champ de recherche d'objet ; on choisit. Si l'objet avait déjà une puce : « Cet objet a déjà une puce. La nouvelle la remplacera, et l'ancienne ne servira plus. » [Remplacer] [Annuler]. Si la puce avait déjà servi pour un autre objet : « Cette puce était utilisée pour “Oscilloscope n° 2” jusqu'au 18 nov. Vous allez la donner à un autre objet. »

### Parcours 4 — Consulter et modifier une fiche
1. En haut : le nom, puis l'emplacement actuel en grand (« Poste B · Banc d'essais, depuis 4 min »), avec [Corriger l'emplacement] et [Modifier].
2. Dessous : propriétés, notes, puis l'historique en frise (« scanné » / « corrigé à la main par Claire Martin »).
3. **Corriger l'emplacement** : un petit panneau, liste des postes, [Enregistrer]. La frise montre aussitôt « Corrigé à la main », mis en évidence.
4. **Modifier** : les champs deviennent éditables sur place ; [Enregistrer] ou Échap pour annuler.
5. **Donner une puce** (objet sans puce, ou puce cassée) : [Donner une puce], puis « Scannez la nouvelle puce sur n'importe quel lecteur… ». La fiche attend le scan en direct, puis demande confirmation. Aujourd'hui, ce parcours fait 6 étapes via « Puces inconnues ».

### Parcours 5 — Voir ce qu'il y a à un poste
1. Clic sur « Poste B » (n'importe où), ou menu Postes puis la tuile.
2. La page du poste montre :
   - les objets présents, avec leur ancienneté (« depuis 2 h ») ;
   - l'état du lecteur (« dernier scan il y a 4 min ») ;
   - les derniers mouvements du poste.

### Parcours 6 — Gérer postes et lecteurs
1. **Postes** : [Ajouter un poste] (un nom suffit) ; [Renommer] se fait sur place.
2. **Désactiver un lecteur** : « Ce lecteur n'enverra plus de scans. Les scans passés restent dans l'historique. Ce choix est définitif. » [Désactiver] [Annuler].
3. **Remplacer une clé** : « Une nouvelle clé va être créée. L'ancienne cessera de fonctionner dès maintenant : pensez à mettre à jour le boîtier. » Puis la carte de clé (copie en un clic) du parcours 1.
4. **Supprimer un poste** : seulement s'il n'a pas d'historique. Sinon, explication : « Ce poste a un historique ; vous pouvez le renommer. »

## 4. Écran d'accueil proposé (à valider)

- **Au centre** : la recherche « Où est… ? » (`Ctrl K`).
- **Colonne principale** : « Derniers mouvements », en direct : le nouveau mouvement apparaît en haut, mis en évidence quelques secondes.
- **Colonne latérale** :
  - « À traiter » : les puces inconnues, avec les boutons Créer et Associer ;
  - « Lecteurs » : « 3 fonctionnent » et, en orange avec une icône, « Poste C : aucun scan reçu depuis 3 jours ».

Seuil proposé pour « lecteur silencieux » : **plus de 24 h sans scan**. Il est fixe dans un premier temps, pour ne pas ajouter de réglage.

## 5. Ce que ces parcours demandent techniquement (signalé : complexité)

- **Un peu de JavaScript côté navigateur** : aujourd'hui, il n'y en a aucun. Il faut un seul fichier local, sans dépendance, autorisé par la CSP actuelle (`script-src 'self'`, sans script en ligne) pour :
  - `Ctrl K` et la recherche pendant la frappe ;
  - le direct ;
  - les panneaux.

  Chaque page continue de fonctionner sans ce fichier (formulaires classiques).
- **Le direct** : le serveur pousse les nouveaux mouvements au navigateur par « Server-Sent Events », une fonction standard des navigateurs, sans bibliothèque. C'est l'option la plus simple ; le WebSocket n'est pas nécessaire.
- **Le nom du site** : une nouvelle donnée (une ligne de réglages en base). C'est un petit changement du modèle de données, **à valider**.
- **Création du premier compte dans l'assistant**, et **ajout de collègues dans Réglages › Comptes** : aujourd'hui, ça se fait seulement en ligne de commande. C'est une fonctionnalité légère mais nouvelle, **à valider**. La page de premier compte n'est accessible que depuis le PC lui-même et tant qu'aucun compte n'existe.
- **Les dates humaines** : l'heure « relative » est calculée côté serveur, puis rafraîchie par le JavaScript de chaque page.
