-- Migration 001 : postes, lecteurs, objets, journal des scans, localisation dérivée.
-- Sous-ensemble du schéma de docs/cadrage.md §3. Les tables users, sessions,
-- location_corrections et audit_log viendront à leurs étapes.
-- Horodatages : texte ISO 8601 UTC à la milliseconde, produits par le serveur.
-- UID NFC : hexadécimal majuscule sans séparateur (8, 14 ou 20 caractères).

CREATE TABLE stations (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  description TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL
);

CREATE TABLE readers (
  id          INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 4294967295),  -- = reader_id de la trame (uint32)
  station_id  INTEGER REFERENCES stations(id) ON DELETE SET NULL,      -- NULL = lecteur non affecté
  aead_key    BLOB    NOT NULL CHECK (length(aead_key) = 32),          -- AES-256, générée par le serveur ; jamais journalisée
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
  UNIQUE (reader_id, counter)                     -- anti-rejeu : filet de sécurité au niveau base (sert aussi d'index pour MAX(counter))
);
CREATE INDEX scans_by_uid ON scans (uid_nfc, received_at);

-- Ajout seul : défense en profondeur contre les bugs (pas contre un accès direct au fichier).
CREATE TRIGGER scans_no_update BEFORE UPDATE ON scans BEGIN SELECT RAISE(ABORT, 'scans: append-only'); END;
CREATE TRIGGER scans_no_delete BEFORE DELETE ON scans BEGIN SELECT RAISE(ABORT, 'scans: append-only'); END;

-- Localisation actuelle = scan le plus récent de la puce de l'objet.
-- (Les corrections manuelles s'y ajouteront à l'étape 5 ; les colonnes sont déjà celles de la vue cible.)
-- Un objet absent de la vue n'a jamais été localisé. station_id NULL = scanné sur un lecteur non affecté.
CREATE VIEW item_locations AS
WITH ranked AS (
  SELECT i.id AS item_id, s.station_id, s.received_at AS at, 'scan' AS source, s.reader_id,
         row_number() OVER (PARTITION BY i.id ORDER BY s.received_at DESC, s.id DESC) AS rn
    FROM items i JOIN scans s ON s.uid_nfc = i.uid_nfc
)
SELECT item_id, station_id, at, source, reader_id FROM ranked WHERE rn = 1;
