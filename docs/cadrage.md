# MetroTrack — Cadrage (phase 0)

Statut : **proposition, en attente de validation**. Rien n'est implémenté.
Date : 2026-11-15.

Documents liés : [`protocole.md`](protocole.md) (contrat boîtier ↔ serveur), [`decisions.md`](decisions.md) (journal des décisions).

---

## 1. Stack : deux options

Contraintes rappelées : un seul déployable (API + interface + base), SQLite, aucune dépendance Internet à l'exécution, auditable par une équipe SSI, le moins de dépendances possible.

Constat sur le poste de développement : **Node.js 26.13 LTS est installé** (SQLite 3.54 et OpenSSL 3.5.9 intégrés). Go, Python et un compilateur C ne sont pas installés.

### Option A — Node.js 26 LTS, zéro dépendance npm (recommandée)

Tout ce dont le MVP a besoin est dans la bibliothèque standard de Node 26, en API **stable** (vérifié sur la version installée, aucun avertissement « experimental ») :

| Besoin | Module intégré |
|---|---|
| HTTPS, TLS, mTLS (plus tard) | `node:https`, `node:tls` |
| AES-256-GCM, CSPRNG, comparaison en temps constant | `node:crypto` (OpenSSL 3.5) |
| Hachage des mots de passe argon2id | `node:crypto` (`argon2`) |
| Base SQLite | `node:sqlite` (SQLite officiel compilé dans Node) |
| Tests | `node:test` |

- **Dépendances tierces : 0.** Pas de `npm install`, pas de `node_modules`, pas de build. Le risque chaîne d'approvisionnement npm disparaît.
- **Déployable** : un dossier (serveur, pages, migrations SQL) + l'exécutable Node. Pas de compilation.
- **Audit** : l'auditeur lit uniquement notre code, et fait confiance à un seul composant tiers connu (Node : OpenSSL + SQLite inclus). Node 26 LTS est maintenu jusqu'en avril 2029.
- **Inconvénients** :
  - le runtime Node doit être installé (et mis à jour) sur le serveur pilote ;
  - pas de moteur de gabarits à échappement automatique : on écrit une petite fonction d'échappement HTML (environ 30 lignes, testée) et on ajoute une CSP stricte. ⚠️ C'est le principal point d'attention XSS ;
  - routage, lecture des cookies et protection CSRF écrits à la main. Chaque morceau est petit, mais c'est du code à nous à faire auditer ;
  - typage dynamique (compensé par les tests).

### Option B — Go (un binaire unique)

- Bibliothèque standard : `net/http`, `crypto/tls`, `crypto/aes` + GCM, `html/template` (**échappement automatique contextuel**, un vrai atout contre le XSS), `embed` (assets dans le binaire).
- **Dépendances : 2 directes.**
  - `golang.org/x/crypto` pour argon2id, maintenu par l'équipe Go ;
  - un pilote SQLite. Deux choix possibles :
    - `modernc.org/sqlite` : du C transpilé en Go, environ 10 modules transitifs, du code généré massif et un mainteneur principal unique. C'est le point faible de l'audit ;
    - `mattn/go-sqlite3` : SQLite officiel, mais via cgo, donc il faut un compilateur C (absent ici).
- **Déployable** : un seul fichier exécutable, sans runtime à installer. C'est le meilleur sur ce critère.
- **Inconvénients** :
  - Go est à installer sur le poste ;
  - courbe d'apprentissage si l'équipe ne connaît pas Go ;
  - le pilote SQLite est la dépendance la plus difficile à justifier devant une SSI.

### Recommandation

**Option A (Node 26, zéro dépendance)** : c'est la plus simple aujourd'hui (rien à installer, rien à compiler, aucun code tiers).
Condition : que la SSI accepte un runtime Node sur le serveur pilote. Si elle exige un binaire unique sans interpréteur, l'option B devient préférable.

Complexité signalée : avec l'option A, quelques briques qu'un framework fournirait (routeur, échappement HTML, CSRF) sont écrites par nous. C'est le prix du zéro dépendance. Chacune reste petite et testée.

---

## 2. Protocole

Voir [`protocole.md`](protocole.md) (v0, avec les points à valider avec Yanis).

---

## 3. Schéma SQL du MVP (brouillon, non exécuté)

Principes :
- **la localisation n'est pas stockée** : elle est calculée par une vue, à partir du scan le plus récent de la puce de l'objet ou de la dernière correction manuelle, en prenant le plus récent des deux ;
- `scans` et `audit_log` sont en ajout seul. Des triggers bloquent UPDATE et DELETE. C'est une défense en profondeur contre les bugs, pas contre quelqu'un qui a accès au fichier ;
- horodatages en texte ISO 8601 UTC à la milliseconde, toujours produits par le serveur (`2026-11-15T18:42:07.123Z`). Leur ordre alphabétique est leur ordre chronologique ;
- UID NFC en hexadécimal majuscule sans séparateur : 8, 14 ou 20 caractères (puces de 4, 7 ou 10 octets).

```sql
-- À chaque connexion : PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
-- Version du schéma suivie par PRAGMA user_version (migrations SQL numérotées).

CREATE TABLE users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,                 -- argon2id au format PHC ; jamais le mot de passe
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT    NOT NULL
);

CREATE TABLE sessions (
  token_hash  BLOB    PRIMARY KEY,                -- SHA-256 du jeton ; le jeton en clair n'existe que dans le cookie
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL
) WITHOUT ROWID;

CREATE TABLE stations (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  description TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);

CREATE TABLE readers (
  id          INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 4294967295),  -- = reader_id de la trame (uint32)
  station_id  INTEGER REFERENCES stations(id) ON DELETE SET NULL,      -- NULL = lecteur non affecté
  aead_key    BLOB    NOT NULL CHECK (length(aead_key) = 32),          -- AES-256, générée par le serveur
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at  TEXT    NOT NULL
);

CREATE TABLE items (
  id          INTEGER PRIMARY KEY,
  uid_nfc     TEXT    UNIQUE                      -- NULL autorisé : fiche créée avant pose de la puce
              CHECK (uid_nfc IS NULL OR (length(uid_nfc) IN (8, 14, 20) AND uid_nfc NOT GLOB '*[^0-9A-F]*')),
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  properties  TEXT    NOT NULL DEFAULT '{}'       -- propriétés libres : objet JSON clé → valeur texte
              CHECK (json_valid(properties) AND json_type(properties) = 'object'),
  notes       TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

-- Journal des scans ACCEPTÉS (trames authentifiées uniquement). Source de vérité de la localisation.
CREATE TABLE scans (
  id          INTEGER PRIMARY KEY,
  reader_id   INTEGER NOT NULL REFERENCES readers(id),
  station_id  INTEGER REFERENCES stations(id),    -- poste du lecteur AU MOMENT du scan (NULL si non affecté)
  uid_nfc     TEXT    NOT NULL CHECK (length(uid_nfc) IN (8, 14, 20) AND uid_nfc NOT GLOB '*[^0-9A-F]*'),
  counter     INTEGER NOT NULL CHECK (counter BETWEEN 1 AND 4294967295),
  received_at TEXT    NOT NULL,
  UNIQUE (reader_id, counter)                     -- anti-rejeu : filet de sécurité au niveau base
);
CREATE INDEX scans_by_uid ON scans (uid_nfc, received_at);  -- migration 006 : remplacé par (uid_nfc, received_at, id, station_id), voir D-016

-- Corrections manuelles de localisation. Cette table est son propre journal (qui, où, quand).
CREATE TABLE location_corrections (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  station_id  INTEGER NOT NULL REFERENCES stations(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT    NOT NULL
);
CREATE INDEX corrections_by_item ON location_corrections (item_id, created_at);

-- Journal des modifications manuelles (fiches, postes, lecteurs, comptes).
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id),       -- NULL = commande d'administration en ligne de commande
  action      TEXT    NOT NULL,                   -- ex. 'item.update', 'reader.create', 'station.delete'
  entity_id   INTEGER,
  details     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(details))  -- avant/après ; JAMAIS de clé ni de mot de passe
);

-- Ajout seul.
CREATE TRIGGER scans_no_update     BEFORE UPDATE ON scans     BEGIN SELECT RAISE(ABORT, 'scans: append-only'); END;
CREATE TRIGGER scans_no_delete     BEFORE DELETE ON scans     BEGIN SELECT RAISE(ABORT, 'scans: append-only'); END;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log: append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log: append-only'); END;

-- ⚠️ Forme de calcul REMPLACÉE par la migration 003 (D-013) : la version ci-dessous, avec row_number()
-- sur tous les événements, est matérialisée en entier à chaque lecture (environ 1,9 s pour 300 000 scans).
-- L'implémentation réelle utilise une sous-requête corrélée par objet sur l'index scans_by_uid.
-- L'étape 5 doit garder cette forme : une sous-requête pour le dernier scan, une pour la dernière
-- correction, et la plus récente des deux l'emporte. La sémantique ci-dessous reste la référence.
-- Localisation actuelle : événement le plus récent (scan de la puce de l'objet, ou correction manuelle).
-- Un objet absent de la vue n'a jamais été localisé. station_id NULL = scanné sur un lecteur non affecté.
CREATE VIEW item_locations AS
WITH events AS (
  SELECT i.id AS item_id, s.station_id, s.received_at AS at, 'scan' AS source, s.reader_id, s.id AS event_id
    FROM items i JOIN scans s ON s.uid_nfc = i.uid_nfc
  UNION ALL
  SELECT c.item_id, c.station_id, c.created_at, 'manual', NULL, c.id
    FROM location_corrections c
), ranked AS (
  SELECT *, row_number() OVER (
           PARTITION BY item_id
           ORDER BY at DESC, (source = 'manual') DESC, event_id DESC) AS rn
    FROM events
)
SELECT item_id, station_id, at, source, reader_id FROM ranked WHERE rn = 1;
```

Choix de modélisation à valider :

1. **`scans` ne contient pas `item_id`.** L'objet est retrouvé par l'UID au moment de la lecture.
   - Avantage : quand on associe une puce inconnue à une fiche, l'objet est **immédiatement localisé** au poste du scan qui l'a fait apparaître, sans réécrire le journal, qui reste strictement en ajout seul.
   - Limite : si on change la puce d'un objet, les scans de l'ancienne puce ne figurent plus dans son historique. Réutiliser une ancienne puce sur un autre objet lui rattacherait ces vieux scans. Règle proposée : ne pas réutiliser une puce.
2. **`scans.station_id` fige le poste au moment du scan.** Déplacer un lecteur vers un autre poste ne réécrit donc pas l'historique ni la localisation actuelle des objets. Ce n'est pas un doublon : c'est le fait historique.
3. **Anti-rejeu sans état supplémentaire.** Le dernier compteur accepté d'un lecteur est `MAX(counter)` de ses scans (index unique). Remplacer la clé d'un boîtier crée un **nouveau lecteur** (nouvel identifiant, nouvelle clé) et désactive l'ancien. Il n'y a donc jamais de remise à zéro de compteur sous un même identifiant.
4. **Suppressions.**
   - Un lecteur ou un poste qui a un historique de scans ne peut pas être supprimé : on désactive le lecteur, on renomme le poste.
   - Un compte utilisateur se désactive, il ne se supprime pas.
   - Une fiche objet peut être supprimée : ses corrections manuelles partent avec elle et `audit_log` garde la trace.
5. **Performance.** La vue recalcule à chaque lecture. C'est largement suffisant pour quelques milliers d'objets et quelques centaines de milliers de scans. On optimisera seulement si une mesure le justifie.

---

## 4. Plan en étapes

Chaque étape passe par la boucle `dev` → `testeur` → `revue-securite` (CLAUDE.md §9), puis attend ton accord avant le commit.

### Étape 1 — Squelette : un scan simulé met à jour la localisation d'un objet

Objectif : la chaîne minimale trame → vérification → journal → localisation, sans interface ni comptes.

Contenu :
- `package.json` **sans aucune dépendance** ;
- `server/protocol.js` : décodage et vérification d'une trame v0, plus l'encodage, utilisé seulement par le simulateur et les tests ;
- `server/ingest.js` : traitement d'une trame dans l'ordre normatif de `protocole.md` §5, sans rien savoir du transport ;
- `server/db.js` et `server/migrations/001_init.sql` : `stations`, `readers`, `items`, `scans`, triggers, vue `item_locations` (sous-ensemble du schéma §3) ;
- `server/main.js` :
  - serveur HTTP écoutant **uniquement sur 127.0.0.1** (TLS à l'étape 2), route `POST /api/frames` ;
  - commande `dev-seed` : crée un poste, un lecteur (clé écrite dans `dev/`, ignoré par git) et un objet avec un UID connu ;
- `tools/simulateur.js` : construit et envoie une trame (`--url --reader --key-file --uid --counter`) ;
- `config.example.json`, `.gitignore`.

Critères de réussite :
- `node --test` vert, couvrant au minimum :
  - trame valide acceptée ;
  - les deux vecteurs de test de `protocole.md` reproduits octet pour octet ;
  - rejet des trames de 35 et de 37 octets ;
  - rejet d'une version inconnue ;
  - rejet d'un lecteur inconnu, et d'un lecteur désactivé ;
  - rejet d'un tag modifié d'un bit ;
  - rejet d'une trame chiffrée avec une mauvaise clé ;
  - rejet d'un compteur rejoué, et d'un compteur inférieur ;
  - rejet d'un `uid_len` invalide, et d'un bourrage non nul ;
  - puce inconnue : scan enregistré, aucune fiche modifiée.
- Bout en bout : `dev-seed`, puis le serveur, puis `simulateur --counter 1` donne **HTTP 204**. `item_locations` renvoie alors le poste du lecteur pour l'objet (test d'intégration et ligne dans le journal du serveur).
- Renvoyer exactement la même trame donne HTTP 400, sans nouvelle ligne dans `scans`.
- Tout rejet donne **400 sans corps, identique quelle que soit la cause**. La cause est écrite dans le journal du serveur.
- Aucune écoute hors de 127.0.0.1, aucun appel sortant, aucune clé dans le dépôt.

### Étape 2 — HTTPS

Objectif : tous les échanges passent en TLS.

Contenu :
- TLS 1.2 au minimum (1.3 de préférence), certificat et clé lus depuis la config, adresse d'écoute configurable ;
- `tools/devcert.sh` (OpenSSL) génère une autorité de certification de développement et un certificat serveur ;
- le simulateur vérifie le certificat du serveur.

Critères de réussite :
- simulateur en HTTPS : 204 ;
- simulateur avec une mauvaise CA : échec TLS ;
- `openssl s_client -tls1_1` : échec ;
- plus aucun port en clair ;
- le serveur refuse de démarrer sans certificat ;
- en-tête HSTS présent.

### Étape 3 — Comptes et connexion

Contenu :
- tables `users` et `sessions` ;
- commande `user-add` : mot de passe saisi au terminal, jamais en argument, aucun compte par défaut ;
- argon2id (`node:crypto`) ;
- pages connexion et déconnexion (HTML et CSS locaux) ;
- cookie de session `HttpOnly; Secure; SameSite=Strict` ;
- jeton CSRF et vérification de l'en-tête `Origin` ;
- CSP `default-src 'self'` ;
- délai après chaque échec de connexion.

Critères de réussite :
- mauvais mot de passe : refus avec un message générique ;
- page protégée sans session : redirection vers la connexion ;
- POST sans jeton CSRF valide : 403 ;
- hachage stocké au format `$argon2id$` ;
- après déconnexion ou expiration, la session est invalide côté serveur ;
- aucune ressource externe dans les pages.

### Étape 4 — Inventaire : liste et fiche (lecture)

Contenu :
- page d'accueil = liste des objets (nom, localisation, depuis quand), avec recherche par nom ou UID ;
- fiche objet : propriétés, notes, localisation, derniers scans ;
- fonction d'échappement HTML, testée.

Critères de réussite :
- après un scan simulé, la nouvelle localisation apparaît au rechargement ;
- un nom contenant `<script>` s'affiche échappé ;
- un objet jamais scanné affiche « jamais localisé » ;
- un scan sur un lecteur non affecté affiche « inconnue (lecteur n° X non affecté) ».

### Étape 5 — Édition des fiches et journal des modifications

Contenu :
- créer, modifier et supprimer une fiche (nom, propriétés libres, notes) ;
- corriger la localisation à la main (`location_corrections`) ;
- `audit_log` avec les valeurs avant et après.

Critères de réussite :
- chaque modification ajoute une ligne `audit_log` avec son auteur ;
- une correction manuelle change la localisation, et un scan ultérieur reprend la main ;
- UPDATE et DELETE sur `scans` ou `audit_log` sont refusés par la base.

### Étape 6 — Postes et lecteurs

Contenu :
- postes : création, modification, suppression ;
- lecteurs :
  - création : identifiant et clé AES-256 générés par le serveur, clé affichée une seule fois pour être injectée dans le boîtier ;
  - affectation à un poste ;
  - désactivation ;
  - remplacement de clé (= nouveau lecteur, l'ancien est désactivé) ;
- `audit_log`, sans jamais la clé.

Critères de réussite :
- un lecteur créé dans l'interface est accepté par le simulateur ;
- un lecteur désactivé reçoit 400 ;
- déplacer un lecteur ne modifie pas les localisations passées ;
- la clé n'apparaît dans aucun journal.

### Étape 7 — Puces inconnues et association

Contenu :
- liste des puces scannées sans fiche (poste, heure) ;
- action « Créer une fiche » : UID pré-rempli ;
- action « Associer à une fiche existante » : confirmation si la fiche avait déjà une puce ;
- `audit_log`.

Critères de réussite :
- une puce inconnue scannée apparaît dans la liste ;
- après création de la fiche, l'objet est localisé immédiatement au poste du scan ;
- l'association à une fiche existante produit le même résultat, et l'ancienne puce est détachée et tracée.

### Étape 8 — Préparation du pilote (à confirmer)

Contenu :
- `docs/securite.md` : modèle de menace, choix cryptographiques, journalisation, sauvegarde ;
- procédure d'installation hors ligne ;
- exemple de service systemd ;
- sauvegarde SQLite (`VACUUM INTO`).

Critère de réussite : une installation depuis zéro sur une machine sans Internet réussit en suivant seulement la documentation.

**Hors plan tant que le boîtier mère n'existe pas** : mTLS pour la mère, réglages radio. Le point d'entrée `POST /api/frames` reste le même et aucune logique métier ne change.

---

## 5. Questions

### Bloquantes pour démarrer l'étape 1

1. **Stack** : valides-tu l'option A (Node 26, zéro dépendance) ? Ou préfères-tu Go ? Quel langage maîtrises-tu le mieux ?
2. **Serveur pilote** : quel système (Linux ?) ? La SSI de l'ONERA accepte-t-elle un runtime Node, ou exige-t-elle un binaire unique ? La réponse peut faire basculer la question 1.
3. **Protocole v0** : puis-je implémenter l'étape 1 sur cette base sans attendre le retour de Yanis ? Un changement ultérieur resterait confiné à `server/protocol.js` et aux vecteurs de test.
4. **Git** : le dossier n'est pas un dépôt. Y a-t-il un dépôt GitHub existant à cloner ici, ou je fais `git init` en local ?

### Non bloquantes (étapes 3 et suivantes)

5. **Rôles** : aucun dans le MVP, c'est-à-dire que tout compte peut tout faire, y compris gérer les lecteurs et leurs clés ?
6. **Fiche** : « informations » (CLAUDE.md §2) désigne-t-il les propriétés libres et les notes, ou un champ de plus ?
7. **Wi-Fi direct** : réservé au prototype et au développement, ou option de production ? L'ONERA autorise-t-il le Wi-Fi ?
8. **Clés des lecteurs** : stockées en clair dans la base, protégée par les droits du fichier, et présentées comme telles à la SSI. Chiffrer avec une clé maîtresse sur la même machine n'apporte presque rien. D'accord pour le MVP ?
9. **Suppression** : un poste ou un lecteur qui a un historique ne se supprime pas (on renomme ou on désactive). D'accord ?
