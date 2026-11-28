// Écran d'accueil (étape U4) : derniers mouvements, puces à traiter, état des lecteurs.
//
// Tout est calculé à la lecture, sans donnée stockée en double (CLAUDE.md §5.3) : un
// « mouvement » est déduit du journal des scans et des corrections manuelles.
//
// MOUVEMENT : un événement (scan d'une puce portée par une fiche, ou correction manuelle) dont le
// lieu diffère de celui de l'événement précédent de la même fiche. Un nouveau scan au même poste
// n'est donc pas un mouvement. Ordre des événements : celui de la vue item_locations (heure, puis
// scan avant correction, puis numéro). « Lecteur non affecté » est un lieu à part (D-016).
//
// COÛT BORNÉ : seuls les MOVEMENT_SCAN_WINDOW derniers scans du journal (ordre d'insertion, clé
// primaire : aucune lecture de tout le journal) et les MOVEMENT_CORRECTION_WINDOW dernières
// corrections sont examinés. Pour chacun, l'événement précédent est lu dans les index
// scans_by_uid et corrections_by_item (une recherche chacun). LIMITE ACCEPTÉE : si ces derniers
// scans ne sont que des rescans au même poste (ou des puces inconnues), l'accueil montre moins
// de mouvements que HOME_MOVEMENTS, alors que des mouvements plus anciens existent.

import { listReaders } from './readers.js';
import { unknownChipsOverview } from './chips.js';

// Mouvements lus pour l'accueil : les HOME_VISIBLE_MOVEMENTS premiers sont affichés, les autres
// derrière « Voir plus » (dépliage, sans script).
export const HOME_MOVEMENTS = 20;
export const HOME_VISIBLE_MOVEMENTS = 5;
export const MOVEMENT_SCAN_WINDOW = 2000;
export const MOVEMENT_CORRECTION_WINDOW = 200;
export const HOME_CHIPS = 3;
// Lecteur actif « silencieux » : aucun scan depuis plus de ce délai, ou jamais (seuil fixe,
// docs/ux/carte-et-parcours.md §4, sans réglage pour l'instant).
export const SILENT_READER_MS = 24 * 60 * 60 * 1000;

/**
 * Scans examinés avec, pour chacun, l'événement précédent de la même puce (scan) et de la même
 * fiche (correction). source : sous-requête CONSTANTE écrite dans ce fichier (paramètres liés).
 * Les scans de puces inconnues sont gardés (item_id NULL) : le direct en a besoin.
 */
const scanMovesSql = (source) => `
  SELECT s.id, s.reader_id, s.station_id, st.name AS station_name, s.received_at AS at,
         i.id AS item_id, i.name AS item_name,
         p.received_at AS prev_scan_at, p.station_id AS prev_scan_station,
         c.created_at AS prev_corr_at, c.station_id AS prev_corr_station
    FROM ${source} s
    LEFT JOIN items i ON i.uid_nfc = s.uid_nfc
    LEFT JOIN stations st ON st.id = s.station_id
    LEFT JOIN scans p ON i.id IS NOT NULL AND p.id = (
           SELECT p2.id FROM scans p2
            WHERE p2.uid_nfc = s.uid_nfc AND (p2.received_at, p2.id) < (s.received_at, s.id)
            ORDER BY p2.received_at DESC, p2.id DESC LIMIT 1)
    LEFT JOIN location_corrections c ON i.id IS NOT NULL AND c.id = (
           SELECT c2.id FROM location_corrections c2
            WHERE c2.item_id = i.id AND c2.created_at < s.received_at
            ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1)`;

/**
 * Lieu précédent d'un événement : la plus récente de ses deux sources (à heure égale, la
 * correction suit le scan). undefined : aucun événement précédent (première localisation).
 */
function previousPlace(row) {
  const hasScan = row.prev_scan_at !== null;
  const hasCorr = row.prev_corr_at !== null;
  if (hasCorr && (!hasScan || row.prev_corr_at >= row.prev_scan_at)) return row.prev_corr_station;
  if (hasScan) return row.prev_scan_station;
  return undefined;
}

const isMove = (row) => {
  const before = previousPlace(row);
  return before === undefined || before !== row.station_id;
};

/**
 * Un scan enregistré, pour le direct : poste, fiche (ou null : puce inconnue) et s'il s'agit d'un
 * mouvement. null si le scan n'existe pas.
 */
export function scanMove(db, scanId) {
  const row = db.prepare(scanMovesSql('(SELECT * FROM scans WHERE id = ?)')).get(scanId);
  if (!row) return null;
  return { ...row, move: row.item_id === null ? false : isMove(row) };
}

/**
 * Derniers mouvements de toutes les fiches, du plus récent au plus ancien, au plus `limit` :
 * [{type: 'scan'|'correction', at, item_id, item_name, station_id, station_name, reader_id,
 *   username}]. reader_id : scans seulement ; username : corrections seulement.
 */
export function recentMovements(db, limit = HOME_MOVEMENTS) {
  const scans = db.prepare(`${scanMovesSql(`(SELECT * FROM scans ORDER BY id DESC LIMIT ${MOVEMENT_SCAN_WINDOW})`)}
     WHERE i.id IS NOT NULL`).all()
    .filter(isMove)
    .map((row) => ({
      type: 'scan', id: row.id, at: row.at, item_id: row.item_id, item_name: row.item_name,
      station_id: row.station_id, station_name: row.station_name, reader_id: row.reader_id, username: null,
    }));
  // Corrections : l'événement précédent est le dernier scan de la puce actuelle à la même heure
  // ou avant (le scan précède la correction), ou la correction précédente de la fiche.
  const corrections = db.prepare(
    `SELECT c.id, c.created_at AS at, c.item_id, i.name AS item_name, c.station_id, st.name AS station_name,
            u.username,
            p.received_at AS prev_scan_at, p.station_id AS prev_scan_station,
            pc.created_at AS prev_corr_at, pc.station_id AS prev_corr_station
       FROM (SELECT * FROM location_corrections ORDER BY id DESC LIMIT ${MOVEMENT_CORRECTION_WINDOW}) c
       JOIN items i ON i.id = c.item_id
       LEFT JOIN stations st ON st.id = c.station_id
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN scans p ON p.id = (
              SELECT p2.id FROM scans p2
               WHERE p2.uid_nfc = i.uid_nfc AND p2.received_at <= c.created_at
               ORDER BY p2.received_at DESC, p2.id DESC LIMIT 1)
       LEFT JOIN location_corrections pc ON pc.id = (
              SELECT c2.id FROM location_corrections c2
               WHERE c2.item_id = c.item_id AND (c2.created_at, c2.id) < (c.created_at, c.id)
               ORDER BY c2.created_at DESC, c2.id DESC LIMIT 1)`
  ).all()
    .filter(isMove)
    .map((row) => ({
      type: 'correction', id: row.id, at: row.at, item_id: row.item_id, item_name: row.item_name,
      station_id: row.station_id, station_name: row.station_name, reader_id: null, username: row.username,
    }));
  // Du plus récent au plus ancien ; à heure égale, la correction (qui suit le scan) d'abord.
  const order = { scan: 0, correction: 1 };
  return [...scans, ...corrections]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : order[b.type] - order[a.type] || b.id - a.id))
    .slice(0, limit);
}

/**
 * État des lecteurs ACTIFS : ceux qui fonctionnent (scan reçu depuis moins de SILENT_READER_MS)
 * et les silencieux (aucun scan depuis plus longtemps, ou jamais), du plus ancien silence au plus
 * récent. lastScanAt : scan le plus récent parmi les lecteurs actifs (ou null).
 */
export function readersHealth(db, now = Date.now()) {
  const active = listReaders(db).filter((reader) => reader.active === 1);
  const silent = [];
  let working = 0;
  let lastScanAt = null;
  for (const reader of active) {
    const at = reader.last_scan_at;
    if (at !== null && (lastScanAt === null || at > lastScanAt)) lastScanAt = at;
    if (at !== null && now - Date.parse(at) <= SILENT_READER_MS) working += 1;
    else silent.push(reader);
  }
  silent.sort((a, b) => (a.last_scan_at ?? '').localeCompare(b.last_scan_at ?? '') || a.id - b.id);
  return { total: active.length, working, silent, lastScanAt };
}

/**
 * Démarrage guidé (étape U4) : vrai tant qu'aucun objet n'a jamais été localisé (aucun scan
 * d'une puce portée par une fiche, aucune correction). EXISTS s'arrête au premier trouvé ; au
 * pire, une recherche d'index (scans_by_uid) par fiche portant une puce.
 */
export function isOnboarding(db) {
  return db.prepare(
    `SELECT NOT (EXISTS (SELECT 1 FROM location_corrections)
                 OR EXISTS (SELECT 1 FROM items i WHERE i.uid_nfc IS NOT NULL
                              AND EXISTS (SELECT 1 FROM scans s WHERE s.uid_nfc = i.uid_nfc))) AS onboarding`
  ).get().onboarding === 1;
}

/** Tout ce que montre l'écran d'accueil (web.js, homePage). */
export function homeData(db, now = Date.now()) {
  const counts = db.prepare(
    `SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM stations) AS stations,
            (SELECT count(*) FROM readers) AS readers, EXISTS (SELECT 1 FROM scans) AS scans`
  ).get();
  return {
    counts,
    onboarding: isOnboarding(db),
    movements: recentMovements(db),
    chips: unknownChipsOverview(db, HOME_CHIPS),
    readers: readersHealth(db, now),
  };
}
