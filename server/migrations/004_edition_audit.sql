-- Migration 004 : édition des fiches (étape 5).
-- - items reconstruite avec AUTOINCREMENT (D-014) ;
-- - location_corrections : corrections manuelles de localisation ; la table est son propre
--   journal (qui, où, quand). Elle part avec la fiche (ON DELETE CASCADE, cadrage.md §3.4) ;
--   l'audit_log, lui, garde la trace de la suppression.
-- - audit_log : journal des modifications manuelles, en ajout seul.
-- - vue item_locations : le plus récent entre le dernier scan et la dernière correction.
-- Tables et index de docs/cadrage.md §3, plus l'index audit_by_entity (voir plus bas).

-- La vue lit items : supprimée AVANT la reconstruction (sinon le renommage de la table
-- échoue sur une vue qui désigne une table absente). Recréée en fin de migration.
DROP VIEW item_locations;

-- items avec AUTOINCREMENT (D-014) : un numéro de fiche n'est JAMAIS réutilisé, même après
-- la suppression de la fiche la plus récente. Sans cela, SQLite redonnerait ce numéro à la
-- fiche suivante, qui hériterait des lignes audit_log (entity_id) de la fiche supprimée.
-- Colonnes, CHECK, UNIQUE et DEFAULT identiques à la migration 001. Les lignes sont copiées
-- avec leur id : sqlite_sequence part du plus grand id existant. Aucune table ne référence
-- items à ce stade (location_corrections est créée plus bas) ; items n'a ni index (hors
-- UNIQUE, recréé par la définition) ni trigger.
CREATE TABLE items_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid_nfc     TEXT    UNIQUE                      -- NULL autorisé : fiche créée avant pose de la puce
              CHECK (uid_nfc IS NULL OR (length(uid_nfc) IN (8, 14, 20) AND uid_nfc NOT GLOB '*[^0-9A-F]*')),
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  properties  TEXT    NOT NULL DEFAULT '{}'       -- propriétés libres : objet JSON clé → valeur texte
              CHECK (json_valid(properties) AND json_type(properties) = 'object'),
  notes       TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
INSERT INTO items_new (id, uid_nfc, name, properties, notes, created_at, updated_at)
  SELECT id, uid_nfc, name, properties, notes, created_at, updated_at FROM items ORDER BY id;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;

CREATE TABLE location_corrections (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  station_id  INTEGER NOT NULL REFERENCES stations(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT    NOT NULL                    -- heure du serveur, ISO 8601 UTC à la milliseconde
);
CREATE INDEX corrections_by_item ON location_corrections (item_id, created_at);

-- Journal des modifications manuelles (fiches ; postes, lecteurs et comptes aux étapes suivantes).
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id),       -- NULL = commande d'administration en ligne de commande
  action      TEXT    NOT NULL,                   -- ex. 'item.update', 'reader.create', 'station.delete'
  entity_id   INTEGER,
  details     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(details))  -- avant/après ; JAMAIS de clé ni de mot de passe
);
-- Historique d'une fiche (20 dernières lignes) : lecture par l'index, sans parcourir tout le
-- journal. L'id (rowid) est implicitement la dernière colonne de l'index : l'ordre
-- chronologique d'une entité est lu directement, à rebours.
CREATE INDEX audit_by_entity ON audit_log (entity_id);

-- Ajout seul : défense en profondeur contre les bugs (pas contre un accès direct au fichier).
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log: append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log: append-only'); END;
-- Anti-REPLACE, indépendant de toute option de connexion : « INSERT OR REPLACE » supprime la
-- ligne en conflit sans déclencher les triggers DELETE si la connexion n'a pas activé
-- PRAGMA recursive_triggers (server/db.js l'active, mais pas un outil SQLite externe). Une
-- insertion qui reprend une clé existante est donc refusée AVANT tout traitement du conflit,
-- quel que soit le mode demandé (REPLACE, IGNORE, UPSERT). Recherches par clé primaire ou par
-- index unique : coût négligeable. (Id non fourni : attribué par SQLite, jamais en conflit.)
CREATE TRIGGER audit_log_no_replace BEFORE INSERT ON audit_log
WHEN EXISTS (SELECT 1 FROM audit_log WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'audit_log: append-only'); END;
-- scans : même règle, sur l'id ET sur (reader_id, counter), la seconde clé unique de la table
-- (index de UNIQUE (reader_id, counter)). Un compteur déjà reçu est donc refusé ici avant la
-- contrainte UNIQUE : server/ingest.js traite les deux erreurs comme un rejeu.
CREATE TRIGGER scans_no_replace BEFORE INSERT ON scans
WHEN EXISTS (SELECT 1 FROM scans WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM scans WHERE reader_id = NEW.reader_id AND counter = NEW.counter)
BEGIN SELECT RAISE(ABORT, 'scans: append-only'); END;
-- Une correction ne se modifie jamais (une nouvelle correction la remplace). Pas de trigger
-- sur DELETE : il bloquerait la suppression en cascade avec la fiche.
CREATE TRIGGER location_corrections_no_update BEFORE UPDATE ON location_corrections
BEGIN SELECT RAISE(ABORT, 'location_corrections: append-only'); END;
-- Faute de trigger DELETE, « INSERT OR REPLACE » avec l'id d'une correction existante
-- l'écraserait (suppression implicite non bloquée) : une insertion qui désigne un id déjà
-- présent est refusée, quel que soit le mode de conflit demandé. (Id non fourni : attribué
-- par SQLite, jamais en conflit.)
CREATE TRIGGER location_corrections_no_replace BEFORE INSERT ON location_corrections
WHEN EXISTS (SELECT 1 FROM location_corrections WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'location_corrections: append-only'); END;

-- Localisation actuelle (D-006, forme D-013). Pour chaque objet :
--   s = son dernier scan : sous-requête corrélée sur l'index scans_by_uid (uid_nfc, received_at),
--       départage à la milliseconde par l'id le plus grand (le dernier reçu) ;
--   c = sa dernière correction : sous-requête corrélée sur l'index corrections_by_item
--       (item_id, created_at), même départage. c n'est retenue que si elle est au moins aussi
--       récente que s : à égalité d'heure, la correction manuelle l'emporte (cadrage.md §3).
-- Résultat : c si elle est retenue, sinon s. Une correction a toujours un poste
-- (station_id NOT NULL) et une heure : coalesce choisit donc la colonne de c dès qu'elle est
-- retenue. Un objet sans scan ni correction est absent de la vue (= jamais localisé).
-- Coût : deux lectures d'index par objet lu, indépendant du nombre de scans.
-- (L'ancienne vue a été supprimée en tête de migration.)
CREATE VIEW item_locations AS
SELECT i.id AS item_id,
       coalesce(c.station_id, s.station_id)              AS station_id,
       coalesce(c.created_at, s.received_at)             AS at,
       CASE WHEN c.id IS NULL THEN 'scan' ELSE 'manual' END AS source,
       CASE WHEN c.id IS NULL THEN s.reader_id END        AS reader_id
  FROM items i
  LEFT JOIN scans s
         ON s.id = (SELECT s2.id
                      FROM scans s2
                     WHERE s2.uid_nfc = i.uid_nfc
                     ORDER BY s2.received_at DESC, s2.id DESC
                     LIMIT 1)
  LEFT JOIN location_corrections c
         ON c.id = (SELECT c2.id
                      FROM location_corrections c2
                     WHERE c2.item_id = i.id
                     ORDER BY c2.created_at DESC, c2.id DESC
                     LIMIT 1)
        AND (s.id IS NULL OR c.created_at >= s.received_at)
 WHERE s.id IS NOT NULL OR c.id IS NOT NULL;
