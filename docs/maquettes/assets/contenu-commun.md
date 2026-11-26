# Contenu commun des maquettes

Les trois directions visuelles montrent **exactement le même contenu**, pour qu'on compare le style et non les données. Moment fictif : mercredi 25 novembre 2026, 16 h 10.

## Vocabulaire imposé

- Termes à employer : poste, objet, fiche, puce, emplacement, lecteur, déplacé, « scanné », « corrigé à la main ».
- Termes interdits à l'écran : UID, compteur, AES, requête, trame, ID, identifiant technique, « null », « erreur 4xx ».
- Le numéro de puce s'affiche seulement sur la fiche, en petit, en JetBrains Mono, groupé par 2 : `04 A1 B2 C3 D4 E5 F6`, avec l'étiquette « Numéro de puce ».

## Site et postes

- Site : **Laboratoire Lyon-Gerland**.
- Postes :
  - **Poste A · Réception** : lecteur actif, dernier scan il y a 25 min ;
  - **Poste B · Banc d'essais** : lecteur actif, dernier scan il y a 4 min ;
  - **Poste C · Atelier mécanique** : lecteur **silencieux**, aucun scan depuis 3 jours (dimanche 22 nov. à 17 h 48) ;
  - **Magasin** : lecteur actif, dernier scan hier à 18 h 02.
- Utilisateur connecté : **Claire Martin** (responsable du matériel).
- Inventaire : 248 objets, 4 postes, 4 lecteurs.

## Écran 1 — Accueil

- Recherche au centre, très visible : « Où est… ? » avec l'indication « Ctrl K ».
- **Derniers mouvements** (en direct, le plus récent en haut, mis en évidence comme « nouveau ») :
  1. Multimètre Fluke 87V n° 7 → Poste B · Banc d'essais — il y a 4 min (16 h 06)
  2. Oscilloscope Rigol DS1054Z → Poste A · Réception — il y a 25 min (15 h 45)
  3. Clé dynamométrique Facom 40–200 N·m → Magasin — il y a 1 h (15 h 08), *corrigé à la main par Claire Martin*
  4. Caméra thermique FLIR E8 → Poste B · Banc d'essais — il y a 2 h (14 h 02)
  5. Alimentation de labo Keysight E36313A → Poste A · Réception — ce matin à 9 h 31
- **Puces inconnues à traiter** (2) :
  - puce scannée au Poste B · Banc d'essais il y a 12 min → boutons « Créer une fiche » et « Associer à une fiche existante » ;
  - puce scannée au Poste A · Réception hier à 11 h 20 → mêmes boutons.
- **Lecteurs** :
  - 3 lecteurs fonctionnent normalement ;
  - « Poste C · Atelier mécanique : aucun scan reçu depuis 3 jours » (attention, orange + icône + texte).
- Encadré repliable « Comment ça marche ? » (fermé), 3 phrases au plus.

## Écran 2 — Résultat de recherche

Recherche tapée : `multi`. 3 résultats, le premier mis en avant :

1. **Multimètre Fluke 87V n° 7** — au **Poste B · Banc d'essais** depuis 4 min (aujourd'hui 16 h 06). Scanné.
2. **Multimètre Fluke 87V n° 3** — au **Poste A · Réception** depuis hier 16 h 12. Scanné.
3. **Multimètre de table Keithley 2110** — au **Magasin** depuis 12 jours (13 nov. à 10 h 40). Corrigé à la main.

Le terme cherché est surligné dans les noms. Le premier résultat affiche l'emplacement **en grand**.

## Écran 3 — Fiche d'un objet : Multimètre Fluke 87V n° 7

- **En-tête** : nom, emplacement actuel en grand (« Poste B · Banc d'essais »), « depuis 4 min — aujourd'hui à 16 h 06 », « Scanné ».
- **Actions** :
  - « Corriger l'emplacement » ;
  - « Modifier la fiche » ;
  - un menu « … » pour Supprimer.
- **Propriétés** :
  - Marque : Fluke ;
  - Modèle : 87V ;
  - N° de série : 41230987 ;
  - Équipe : Maintenance électrique ;
  - Acheté le : mars 2023.
- **Notes** : « Sonde rouge à remplacer. Rangé dans la mallette grise. »
- **Numéro de puce** : `04 A1 B2 C3 D4 E5 F6` (discret).
- **Historique des déplacements** (frise verticale, du plus récent au plus ancien) :
  1. aujourd'hui 16 h 06 — Poste B · Banc d'essais — scanné
  2. aujourd'hui 8 h 42 — Poste A · Réception — scanné
  3. hier 18 h 02 — Magasin — scanné
  4. hier 15 h 20 — Magasin — **corrigé à la main** par Claire Martin
  5. 18 nov. 2026 à 10 h 15 — Poste C · Atelier mécanique — scanné
  6. 12 nov. 2026 — fiche créée par Claire Martin
- Encadré repliable « Comment ça marche ? ».
