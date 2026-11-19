-- Migration 005 : postes et lecteurs (étape 6).
--
-- 1. Trigger scans_no_replace recréé avec un message propre, « scans: duplicate ».
--    Conditions inchangées (migration 004) : une insertion qui reprend l'id d'un scan, ou un
--    couple (reader_id, counter) déjà enregistré, est refusée avant tout traitement du
--    conflit, quel que soit le mode demandé (REPLACE, IGNORE, UPSERT).
--    Raison : server/ingest.js reconnaît un rejeu à ce message. Avec l'ancien message,
--    « scans: append-only », il le partageait avec scans_no_update et scans_no_delete. Un
--    message propre à ce trigger ne peut être confondu avec aucun autre.
--    DROP puis CREATE dans la transaction de la migration (server/db.js) : il n'existe aucun
--    instant où la table est sans protection.
DROP TRIGGER scans_no_replace;
CREATE TRIGGER scans_no_replace BEFORE INSERT ON scans
WHEN EXISTS (SELECT 1 FROM scans WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM scans WHERE reader_id = NEW.reader_id AND counter = NEW.counter)
BEGIN SELECT RAISE(ABORT, 'scans: duplicate'); END;

-- 2. Index des scans par poste.
--    Raison : la suppression d'un poste n'est permise que s'il n'a aucun scan (étape 6). Ce
--    contrôle, le décompte affiché quand la suppression est impossible, et la vérification de
--    clé étrangère que SQLite fait lui-même au DELETE d'un poste (scans.station_id) liraient
--    sinon tout le journal des scans. node:sqlite étant synchrone, le serveur entier
--    attendrait (même raison que D-013).
--    Pas d'index équivalent sur location_corrections ni sur readers : ces tables sont
--    remplies à la main (quelques milliers de lignes au plus), leur parcours est négligeable.
CREATE INDEX scans_by_station ON scans (station_id);
