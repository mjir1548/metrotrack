-- Migration 003 : vue item_locations réécrite pour s'appuyer sur l'index scans_by_uid.
-- Mêmes colonnes et mêmes résultats que la version 001 ; seule la méthode de calcul change.
--
-- Version 001 : row_number() sur TOUS les scans, matérialisé à chaque lecture de la vue, même
-- pour une seule fiche (environ 1,9 s pour 5 000 objets et 300 000 scans ; node:sqlite étant
-- synchrone, le serveur entier attendait). Ici, pour chaque objet, une sous-requête corrélée
-- lit le dernier scan de sa puce directement dans l'index (uid_nfc, received_at), parcouru à
-- rebours : coût proportionnel au nombre d'objets lus, indépendant du nombre de scans.
--
-- Départage inchangé : received_at le plus récent, puis id le plus grand (le dernier reçu).
-- Objet sans puce (uid_nfc NULL) : la sous-requête ne trouve rien, l'objet est absent de la
-- vue (= jamais localisé), comme avant.

DROP VIEW item_locations;

CREATE VIEW item_locations AS
SELECT i.id AS item_id, s.station_id, s.received_at AS at, 'scan' AS source, s.reader_id
  FROM items i
  JOIN scans s ON s.id = (SELECT s2.id
                            FROM scans s2
                           WHERE s2.uid_nfc = i.uid_nfc
                           ORDER BY s2.received_at DESC, s2.id DESC
                           LIMIT 1);
