// Lecteurs (étape 6) : création avec génération de la clé, affectation à un poste,
// désactivation définitive, remplacement de clé, lectures pour les pages.
// Un lecteur n'est jamais supprimé : ses scans le désignent (journal en ajout seul).
//
// SÉCURITÉ (clé AES-256 du lecteur, protocole.md §6) :
//   - générée ici par crypto.randomBytes (CSPRNG du système, via OpenSSL) ;
//   - renvoyée UNE fois à l'appelant (création, remplacement) pour être affichée une seule
//     fois ; aucune autre fonction ne la lit : les lectures ci-dessous ne sélectionnent
//     jamais la colonne aead_key ;
//   - jamais écrite dans audit_log ni dans un message d'erreur.
// Remplacer la clé = créer un NOUVEAU lecteur (nouvel identifiant, nouvelle clé) et
// désactiver l'ancien : un même reader_id ne voit jamais son compteur repartir à zéro (D-005).
// Changer un lecteur de poste ne réécrit pas l'historique : scans.station_id est figé au
// moment du scan (D-006).
//
// JOURNAL : chaque écriture et sa ligne audit_log sont dans UNE même transaction.

import { randomBytes } from 'node:crypto';
import { inTransaction, audit } from './items.js';

// reader_id de la trame : entier non signé de 32 bits (protocole.md §2), CHECK de la table.
export const MAX_READER_ID = 4_294_967_295;
export const READER_KEY_BYTES = 32; // AES-256
export const RECENT_READER_SCANS = 20;

export const READER_ACTIONS = {
  create: 'reader.create',
  assign: 'reader.assign',
  deactivate: 'reader.deactivate',
  replace: 'reader.replace',
};

/** Identifiant du prochain lecteur : MAX(id) + 1 (au moins 1), ou null si la plage uint32 est épuisée. */
function nextReaderId(db) {
  const { max } = db.prepare('SELECT coalesce(max(id), 0) AS max FROM readers').get();
  return max >= MAX_READER_ID ? null : max + 1;
}

/** Poste {id, name} pour l'audit et l'affichage, ou null si stationId est null ou inconnu. */
function stationRef(db, stationId) {
  if (stationId === null) return null;
  const row = db.prepare('SELECT id, name FROM stations WHERE id = ?').get(stationId);
  return row ? { id: row.id, name: row.name } : null;
}

/** Insère un lecteur actif avec une clé neuve ; renvoie la clé (Buffer de 32 octets). */
function insertReader(db, id, stationId, now) {
  const key = randomBytes(READER_KEY_BYTES);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(id, stationId, key, now);
  return key;
}

/**
 * Crée un lecteur, affecté au poste donné ou non affecté (stationId null).
 * @param {number|bigint|null} stationId
 * @returns {'no_station'|'ids_exhausted'|{id: number, key: Buffer, station: {id, name}|null}}
 *   key : à afficher une seule fois, puis à oublier (jamais journalisée).
 */
export function createReader(db, userId, stationId, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const station = stationRef(db, stationId);
    if (stationId !== null && !station) return 'no_station';
    const id = nextReaderId(db);
    if (id === null) return 'ids_exhausted';
    const key = insertReader(db, id, station?.id ?? null, now);
    // Audit : identifiant et poste seulement, JAMAIS la clé.
    audit(db, { at: now, userId, action: READER_ACTIONS.create, entityId: id, details: { id, station } });
    return { id, key, station };
  });
}

/**
 * Affecte un lecteur actif à un poste, ou le désaffecte (stationId null). Les scans passés
 * gardent leur poste (scans.station_id figé). Sans changement, rien n'est écrit.
 * @returns {'no_reader'|'inactive'|'no_station'|{changed: boolean}}
 */
export function assignReader(db, userId, readerId, stationId, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const reader = db.prepare('SELECT id, station_id, active FROM readers WHERE id = ?').get(readerId);
    if (!reader) return 'no_reader';
    if (reader.active !== 1) return 'inactive';
    const after = stationRef(db, stationId);
    if (stationId !== null && !after) return 'no_station';
    if ((after?.id ?? null) === reader.station_id) return { changed: false };
    const before = stationRef(db, reader.station_id);
    db.prepare('UPDATE readers SET station_id = ? WHERE id = ?').run(after?.id ?? null, reader.id);
    audit(db, { at: now, userId, action: READER_ACTIONS.assign, entityId: reader.id, details: { before, after } });
    return { changed: true };
  });
}

/**
 * Désactive un lecteur, DÉFINITIVEMENT (il n'existe aucune réactivation) : ses trames sont
 * ensuite rejetées (ingest.js, étape 3 et condition active = 1 de l'insertion).
 * @returns {'ok'|'no_reader'|'inactive'}
 */
export function deactivateReader(db, userId, readerId, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const reader = db.prepare('SELECT id, station_id, active FROM readers WHERE id = ?').get(readerId);
    if (!reader) return 'no_reader';
    if (reader.active !== 1) return 'inactive';
    db.prepare('UPDATE readers SET active = 0 WHERE id = ?').run(reader.id);
    audit(db, { at: now, userId, action: READER_ACTIONS.deactivate, entityId: reader.id, details: { station: stationRef(db, reader.station_id) } });
    return 'ok';
  });
}

/**
 * Remplacement de clé (protocole.md §6) : nouveau lecteur (nouvel identifiant, nouvelle clé,
 * même poste) et désactivation de l'ancien, dans la même transaction. Deux lignes
 * d'audit : reader.replace sur l'ancien lecteur {old_id, new_id, station}, et reader.create
 * sur le nouveau {replaces, station}.
 * @returns {'no_reader'|'inactive'|'ids_exhausted'|{id: number, key: Buffer, oldId: number, station: {id, name}|null}}
 */
export function replaceReader(db, userId, readerId, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const old = db.prepare('SELECT id, station_id, active FROM readers WHERE id = ?').get(readerId);
    if (!old) return 'no_reader';
    if (old.active !== 1) return 'inactive';
    const id = nextReaderId(db);
    if (id === null) return 'ids_exhausted';
    const station = stationRef(db, old.station_id);
    db.prepare('UPDATE readers SET active = 0 WHERE id = ?').run(old.id);
    const key = insertReader(db, id, old.station_id, now);
    // Audit, JAMAIS la clé : une ligne sur l'ancien lecteur, une sur le nouveau (son
    // historique commence par sa création, comme pour un lecteur créé directement).
    audit(db, { at: now, userId, action: READER_ACTIONS.replace, entityId: old.id, details: { old_id: old.id, new_id: id, station } });
    audit(db, { at: now, userId, action: READER_ACTIONS.create, entityId: id, details: { replaces: old.id, station } });
    return { id, key, oldId: old.id, station };
  });
}

// Colonnes affichées d'un lecteur, SANS la clé. Dernier scan accepté : celui de plus grand
// compteur (les compteurs acceptés sont strictement croissants, D-005), lu dans l'index de
// UNIQUE (reader_id, counter), sans parcourir les scans.
const READER_SELECT = `
  SELECT r.id, r.station_id, st.name AS station_name, r.active, r.created_at,
         s.received_at AS last_scan_at, s.counter AS last_counter
    FROM readers r
    LEFT JOIN stations st ON st.id = r.station_id
    LEFT JOIN scans s ON s.id = (SELECT s2.id FROM scans s2 WHERE s2.reader_id = r.id ORDER BY s2.counter DESC LIMIT 1)`;

/** Tous les lecteurs, actifs d'abord, puis par numéro. */
export function listReaders(db) {
  return db.prepare(`${READER_SELECT} ORDER BY r.active DESC, r.id`).all();
}

/** Un lecteur (mêmes colonnes que listReaders), ou null. */
export function getReader(db, id) {
  const row = db.prepare(`${READER_SELECT} WHERE r.id = ?`).get(id);
  return row ? { ...row } : null;
}

/**
 * Derniers scans d'un lecteur, du plus récent au plus ancien (index (reader_id, counter)) :
 * [{uid_nfc, received_at, counter, station_id, station_name, item_id, item_name}].
 * station : poste figé au moment du scan ; item : fiche qui porte actuellement cette puce.
 */
export function readerScans(db, id, limit = RECENT_READER_SCANS) {
  return db.prepare(
    `SELECT s.uid_nfc, s.received_at, s.counter, s.station_id, st.name AS station_name,
            i.id AS item_id, i.name AS item_name
       FROM scans s
       LEFT JOIN stations st ON st.id = s.station_id
       LEFT JOIN items i ON i.uid_nfc = s.uid_nfc
      WHERE s.reader_id = ?
      ORDER BY s.counter DESC
      LIMIT ?`
  ).all(id, limit);
}
