# MetroTrack — Journal des décisions

Chaque décision structurante en quelques lignes : date, décision, alternatives écartées, raison.
Statuts : **Proposée** (en attente de validation), **Validée**, **Remplacée par D-xxx**.
Les décisions qui touchent au contrat boîtier ↔ serveur doivent aussi être validées par Yanis.

---

## D-001 — Journal des décisions

- **Date** : 2026-11-15 · **Statut** : Validée
- **Décision** : les décisions structurantes sont consignées ici, numérotées, et jamais effacées : une décision changée est marquée « Remplacée ».
- **Raison** : CLAUDE.md §8 ; traçabilité pour l'audit SSI.

## D-002 — Stack : Node.js 26 LTS sans dépendance npm

- **Date** : 2026-11-15 · **Statut** : Validée (2026-11-15)
- **Décision** : serveur unique en Node.js 26 LTS, avec uniquement les modules intégrés (`node:https`, `node:crypto`, `node:sqlite`, `node:test`). Interface en HTML rendu côté serveur, avec CSS et JS locaux, sans étape de build.
- **Alternatives écartées** :
  - Go : binaire unique et échappement HTML automatique, mais 2 dépendances, dont un pilote SQLite difficile à auditer, et la chaîne d'outils à installer ;
  - Python ou frameworks Node : plus de dépendances tierces.
- **Raison** : zéro code tiers à auditer, rien à installer ni à compiler.
- **Condition** : la SSI doit accepter un runtime Node sur le serveur.
- **Détail** : [`cadrage.md`](cadrage.md) §1.

## D-003 — Trame de scan binaire fixe de 36 octets

- **Date** : 2026-11-15 · **Statut** : Proposée (à valider avec Yanis)
- **Décision** : la trame a la forme `version ‖ reader_id ‖ counter ‖ AES-GCM(uid_len ‖ uid complété à 10 octets) ‖ tag`, soit 36 octets, et elle est identique en Wi-Fi et en LoRa.
- **Alternatives écartées** : JSON ou CBOR (environ 2 à 3 fois plus gros, et analyse plus complexe) ; taille variable selon l'UID (gain de 6 octets au plus).
- **Raison** : compatible avec la charge utile LoRa, validation triviale (taille exacte), même logique serveur quel que soit le transport.
- **Détail** : [`protocole.md`](protocole.md) §2.

## D-004 — AES-256-GCM de bout en bout, clé par lecteur, mère sans clé

- **Date** : 2026-11-15 · **Statut** : Proposée (à valider avec Yanis)
- **Décision** :
  - AEAD AES-256-GCM entre le boîtier fille et le serveur ;
  - nonce = `reader_id ‖ counter ‖ 0⁴`, AAD = en-tête ;
  - le boîtier mère relaie la trame telle quelle, sans détenir de clé.
- **Alternatives écartées** :
  - ChaCha20-Poly1305 : équivalent, mais sans accélération matérielle sur ESP32 et moins classique dans les référentiels ;
  - déchiffrement par la mère et re-chiffrement en TLS : une compromission de la mère suffirait alors à forger des scans.
- **Raison** : sécurité indépendante du transport ; mère plus simple et moins critique.

## D-005 — Anti-rejeu par compteur strictement croissant, sans état supplémentaire

- **Date** : 2026-11-15 · **Statut** : Proposée
- **Décision** :
  - une trame est acceptée seulement si son compteur est supérieur au dernier accepté pour ce lecteur, c'est-à-dire `MAX(counter)` de ses scans ;
  - la vérification est atomique, avec `UNIQUE (reader_id, counter)` en filet de sécurité ;
  - remplacer la clé d'un boîtier crée un nouveau lecteur.
- **Alternatives écartées** :
  - colonne `last_counter` sur le lecteur : un état en double ;
  - fenêtre glissante : plus complexe ;
  - horodatage dans la trame : pas d'horloge fiable sur le boîtier.
- **Raison** : simple, vérifiable en base, cohérent avec le principe « pas de donnée en double ».
- **Limite** : une trame dépassée par une plus récente est perdue.

## D-006 — Localisation dérivée par une vue

- **Date** : 2026-11-15 · **Statut** : Proposée
- **Décision** :
  - la localisation actuelle est l'événement le plus récent entre le dernier scan de la puce de l'objet et sa dernière correction manuelle (vue `item_locations`) ;
  - `scans` n'a pas d'`item_id` : l'objet est retrouvé par l'UID ;
  - `scans` fige `station_id` au moment du scan.
- **Alternatives écartées** :
  - colonne « localisation » sur la fiche : un doublon ;
  - `item_id` résolu à la réception : l'association d'une puce inconnue obligerait à modifier le journal.
- **Raison** : CLAUDE.md §5.3 ; journal strictement en ajout seul ; une puce associée après coup donne une localisation immédiate.
- **Détail** : [`cadrage.md`](cadrage.md) §3.

## D-007 — Heure du scan = heure de réception par le serveur

- **Date** : 2026-11-15 · **Statut** : Proposée (à valider avec Yanis)
- **Décision** : aucune heure dans la trame ; le serveur horodate à la réception.
- **Alternative écartée** : horodatage par le boîtier, qui n'a pas d'horloge fiable sans réseau.
- **Raison** : minimisation, simplicité.
- **À revoir** : si les scans peuvent être mis en mémoire hors ligne, ajouter un champ « âge du scan ».

## D-008 — Rejets uniformes côté HTTP

- **Date** : 2026-11-15 · **Statut** : Proposée
- **Décision** :
  - le Content-Type et le plafond de corps (64 octets) sont vérifiés par la couche HTTP ; la fonction de traitement commune ne connaît que les octets de la trame ;
  - tout rejet renvoie 400 sans corps avec `Connection: close`, quelle que soit la cause ;
  - toute exception dans le gestionnaire HTTP donne un 500 sans corps, sans jamais arrêter le serveur.
- **Alternative écartée** : garder la connexion ouverte après un rejet. Les en-têtes différeraient alors selon la cause (rejet précoce ou non).
- **Raison** : ne rien révéler à l'émetteur ; garder le traitement indépendant du transport ; résister aux requêtes mal formées.
