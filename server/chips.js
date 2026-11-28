// Puces inconnues et association (étape 7).
//
// Une puce inconnue est un UID présent dans le journal des scans qu'aucune fiche ne porte
// (items.uid_nfc). Il n'existe pas de table des puces : la liste est calculée à chaque lecture
// à partir de scans et items, sans donnée en double (CLAUDE.md §5.3).
//
// JOURNAL DES SCANS (D-006) : rien ici n'écrit dans scans. Associer une puce, c'est seulement
// poser items.uid_nfc. La vue item_locations retrouve les scans par l'UID : la fiche est
// localisée aussitôt au poste du dernier scan de la puce (ou reste à sa correction manuelle si
// celle-ci est plus récente, même règle que partout ailleurs).
// Une ancienne puce remplacée est détachée de la fiche : ses scans restent dans le journal et
// redeviennent ceux d'une puce inconnue.
//
// Écritures : chaque écriture et sa ligne audit_log dans UNE transaction (inTransaction,
// BEGIN IMMEDIATE). L'état de la puce (scannée, toujours inconnue) et de la fiche est relu DANS
// cette transaction : une association concurrente ne peut pas passer entre la vérification et
// l'écriture. UNIQUE (uid_nfc) reste le filet au niveau base. Requêtes paramétrées.

import { ACTIONS, audit, inTransaction, insertItem, insertCorrection } from './items.js';

// Recherche de la fiche à associer : au plus ce nombre de fiches affichées (la page invite à
// préciser la recherche au-delà), pour ne pas produire une page de milliers de lignes.
export const MAX_ASSOCIATE_RESULTS = 50;

// Liste des puces inconnues : au plus ce nombre de puces affichées, les plus récemment vues.
// SÉCURITÉ (disponibilité) : un lecteur compromis (dont la clé a fuité) peut remplir le
// journal de faux UID. Sans plafond, la page construirait une ligne par UID (mesuré : 7 s et
// 156 Mo pour 300 000 puces inconnues), pendant lesquels node:sqlite, synchrone, bloque aussi
// la réception des trames. Le plafond borne le rendu et les décomptes de scans ; le parcours
// de l'index, lui, reste proportionnel au nombre d'UID distincts (voir UNKNOWN_UIDS).
export const MAX_UNKNOWN_CHIPS = 200;
// Page « Donner une puce » (fiche d'un objet, étape U3) : les puces inconnues les plus récemment
// scannées, au plus ce nombre (la puce qu'on vient de scanner est en tête).
export const MAX_OFFERED_CHIPS = 20;

// Puces inconnues. La table scans n'a pas de liste des UID distincts.
// Forme retenue : un parcours de l'index scans_by_uid (uid_nfc, received_at) « par sauts ».
// Chaque pas cherche dans l'index le premier UID strictement plus grand que le précédent, puis
// on garde ceux qu'aucune fiche ne porte (index unique items.uid_nfc).
// Coût : une recherche d'index par UID DISTINCT, indépendant du nombre de scans. Mesures à
// 300 000 scans : environ 20 ms pour 5 500 UID distincts, contre 40 ms pour un GROUP BY qui lit
// tout le journal. Le coût croît avec le nombre d'UID distincts : quand presque chaque scan
// porte un UID différent (journal rempli de faux UID), chaque pas coûte plus qu'une ligne de
// GROUP BY, et ce parcours devient plus lent que lui. Le cas normal (des milliers de puces,
// beaucoup de scans chacune) reste le plus favorable, et MAX_UNKNOWN_CHIPS borne le reste.
const UNKNOWN_UIDS = `
  WITH RECURSIVE seen(uid) AS (
    SELECT (SELECT min(uid_nfc) FROM scans)
    UNION ALL
    SELECT (SELECT min(s.uid_nfc) FROM scans s WHERE s.uid_nfc > seen.uid) FROM seen WHERE seen.uid IS NOT NULL
  ), unknown(uid) AS (
    SELECT uid FROM seen
     WHERE uid IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.uid_nfc = seen.uid)
  )`;

// Dernier scan d'une puce : même départage que la vue item_locations (heure de réception, puis
// id le plus grand), lu à rebours dans l'index scans_by_uid.
const LAST_SCAN_OF = (uidColumn) => `(SELECT s2.id FROM scans s2 WHERE s2.uid_nfc = ${uidColumn}
                                       ORDER BY s2.received_at DESC, s2.id DESC LIMIT 1)`;

/**
 * Puces inconnues, la plus récemment vue en premier, au plus `limit` :
 * {chips: [{uid, scan_count, received_at, reader_id, station_id, station_name}], more: boolean}
 * (dernier scan : heure, lecteur, poste figé au moment du scan, null si le lecteur n'était pas
 * affecté). more : il existe d'autres puces inconnues, plus anciennes, non renvoyées.
 *
 * Le total exact n'est pas calculé : on lit limit + 1 puces, ce qui suffit à savoir s'il y en a
 * plus. Les puces retenues sont choisies d'abord (CTE « recent », MATERIALIZED : calculée une
 * fois, avant le reste) ; le nombre de scans n'est compté ensuite que pour elles.
 */
export function listUnknownChips(db, limit = MAX_UNKNOWN_CHIPS) {
  const rows = db.prepare(
    `${UNKNOWN_UIDS}, recent AS MATERIALIZED (
       SELECT u.uid, s.id AS scan_id
         FROM unknown u
         JOIN scans s ON s.id = ${LAST_SCAN_OF('u.uid')}
        ORDER BY s.received_at DESC, s.id DESC
        LIMIT ?
     )
     SELECT r.uid,
            (SELECT count(*) FROM scans c WHERE c.uid_nfc = r.uid) AS scan_count,
            s.received_at, s.reader_id, s.station_id, st.name AS station_name
       FROM recent r
       JOIN scans s ON s.id = r.scan_id
       LEFT JOIN stations st ON st.id = s.station_id
      ORDER BY s.received_at DESC, s.id DESC`
  ).all(limit + 1).map((row) => ({ ...row }));
  return { chips: rows.slice(0, limit), more: rows.length > limit };
}

/**
 * Aperçu des puces inconnues pour l'écran d'accueil et le direct (étape U4) : les `limit` plus
 * récemment vues, et leur nombre total, en UN parcours de l'index (même parcours par sauts que
 * listUnknownChips : le total est compté par une fonction de fenêtre, avant la limite).
 * Le nombre de scans n'est compté que pour les puces retenues (étape U5 : « 3 scans · dernier il y
 * a … » sur la page « Puces inconnues » mise à jour en direct), comme dans listUnknownChips.
 * @returns {{chips: {uid, scan_count, received_at, reader_id, station_id, station_name}[], total: number}}
 */
export function unknownChipsOverview(db, limit) {
  const rows = db.prepare(
    `${UNKNOWN_UIDS}, recent AS MATERIALIZED (
       SELECT u.uid, s.id AS scan_id, count(*) OVER () AS total
         FROM unknown u
         JOIN scans s ON s.id = ${LAST_SCAN_OF('u.uid')}
        ORDER BY s.received_at DESC, s.id DESC
        LIMIT ?
     )
     SELECT r.uid, r.total, (SELECT count(*) FROM scans c WHERE c.uid_nfc = r.uid) AS scan_count,
            s.received_at, s.reader_id, s.station_id, st.name AS station_name
       FROM recent r
       JOIN scans s ON s.id = r.scan_id
       LEFT JOIN stations st ON st.id = s.station_id
      ORDER BY s.received_at DESC, s.id DESC`
  ).all(Math.max(1, limit));
  const total = rows.length === 0 ? 0 : rows[0].total;
  const chips = rows.slice(0, limit).map(({ total: _total, ...chip }) => ({ ...chip }));
  return { chips, total };
}

// Compteur de la barre de navigation : au-delà, « 200+ » (le décompte s'arrête là).
export const NAV_CHIPS_CAP = MAX_UNKNOWN_CHIPS;

/** Nombre de puces inconnues, plafonné à cap + 1 (même parcours, arrêté dès cap + 1 trouvées). */
export function unknownChipsCount(db, cap = NAV_CHIPS_CAP) {
  return db.prepare(`${UNKNOWN_UIDS} SELECT count(*) AS n FROM (SELECT uid FROM unknown LIMIT ?)`).get(cap + 1).n;
}

/**
 * Compteur mémorisé (étape U4) : le parcours des puces coûte jusqu'à quelques dizaines de ms sur
 * une grosse base ; il n'est refait que si le nombre a pu changer (invalidate : scan d'une puce
 * inconnue, association, retrait, suppression de fiche), au plus une fois par minIntervalMs, et
 * au moins toutes les ttlMs. Entre deux calculs rapprochés, la valeur peut avoir une seconde de
 * retard (limite acceptée : borne le coût si un lecteur envoie des puces inconnues en rafale).
 * Mémoire du processus seulement : rien n'est stocké en base (D-006).
 */
export function createChipsCounter(db, { minIntervalMs = 1000, ttlMs = 30_000, now = Date.now } = {}) {
  let value = null;
  let at = 0;
  let dirty = true;
  return {
    get() {
      const t = now();
      if (value === null || ((dirty || t - at > ttlMs) && t - at >= minIntervalMs)) {
        value = unknownChipsCount(db);
        at = t;
        dirty = false;
      }
      return value;
    },
    invalidate() {
      dirty = true;
    },
    /** Recalcul immédiat (action d'un utilisateur : association, retrait, suppression). */
    refresh() {
      value = unknownChipsCount(db);
      at = now();
      dirty = false;
      return value;
    },
  };
}

/**
 * Dernière fiche qui a porté cette puce, d'après le journal des modifications, ou null si
 * aucune. Sert à avertir avant de RÉUTILISER une puce : ses scans d'alors, restés au journal,
 * seront rattachés à la nouvelle fiche (cadrage.md §3, choix 1).
 * @returns {{itemId: number, name: string|null, until: string, exists: boolean}|null}
 *   until : heure du détachement ; exists : la fiche existe encore (puce remplacée ou retirée).
 */
export function chipPreviousOwner(db, uid) {
  return chipPreviousOwners(db, [uid]).get(uid) ?? null;
}

/**
 * Même information pour plusieurs puces en UNE lecture (page « Donner une puce », au plus
 * MAX_OFFERED_CHIPS puces) : Map UID → ancien propriétaire (les puces sans ancien propriétaire
 * sont absentes).
 * Une puce quitte une fiche de trois façons, toutes journalisées :
 *   - item.delete : la fiche supprimée, details.uid_nfc = UID (fiche complète d'avant) ;
 *   - item.chip_associate : la puce remplacée sur sa fiche, details.previous_uid = UID ;
 *   - item.chip_detach : la puce retirée de sa fiche (étape U3), details.previous_uid = UID.
 * Lecture paramétrée de audit_log (liste d'UID liée en tableau JSON, lue par json_each), sans
 * index sur ces champs JSON : la table est parcourue une fois. Accepté : elle est remplie à la
 * main, et ces pages (création depuis une puce, confirmation d'association, choix d'une puce)
 * sont rarement affichées.
 */
export function chipPreviousOwners(db, uids) {
  const rows = db.prepare(
    `SELECT a.entity_id, a.at, json_extract(a.details, '$.name') AS name, i.id IS NOT NULL AS item_exists,
            CASE a.action WHEN ? THEN json_extract(a.details, '$.uid_nfc') ELSE json_extract(a.details, '$.previous_uid') END AS uid
       FROM audit_log a
       LEFT JOIN items i ON i.id = a.entity_id
      WHERE ((a.action = ? AND json_extract(a.details, '$.uid_nfc') IN (SELECT value FROM json_each(?)))
          OR (a.action IN (?, ?) AND json_extract(a.details, '$.previous_uid') IN (SELECT value FROM json_each(?))))
      ORDER BY a.id DESC`
  ).all(ACTIONS.delete, ACTIONS.delete, JSON.stringify(uids), ACTIONS.chipAssociate, ACTIONS.chipDetach, JSON.stringify(uids));
  const owners = new Map();
  for (const row of rows) {
    if (typeof row.uid !== 'string' || owners.has(row.uid)) continue; // la plus récente ligne l'emporte
    owners.set(row.uid, {
      itemId: row.entity_id,
      name: typeof row.name === 'string' ? row.name : null,
      until: row.at,
      exists: row.item_exists === 1,
    });
  }
  return owners;
}

/**
 * Une puce scannée au moins une fois, avec son dernier scan et la fiche qui la porte :
 * {uid, scan_count, received_at, reader_id, station_id, station_name, item_id (null : puce
 * inconnue)}, ou null si cet UID n'a jamais été scanné.
 * @param {string} uid UID déjà validé (parseUid)
 */
export function getChip(db, uid) {
  const row = db.prepare(
    `SELECT s.uid_nfc AS uid,
            (SELECT count(*) FROM scans c WHERE c.uid_nfc = s.uid_nfc) AS scan_count,
            s.received_at, s.reader_id, s.station_id, st.name AS station_name,
            i.id AS item_id
       FROM scans s
       LEFT JOIN stations st ON st.id = s.station_id
       LEFT JOIN items i ON i.uid_nfc = s.uid_nfc
      WHERE s.id = ${LAST_SCAN_OF('?')}`
  ).get(uid);
  return row ? { ...row } : null;
}

/**
 * État de la puce, relu dans la transaction d'écriture : 'never_scanned', {known: id de la
 * fiche qui la porte}, ou null si elle est scannée et toujours inconnue.
 */
function chipConflict(db, uid) {
  if (!db.prepare('SELECT 1 FROM scans WHERE uid_nfc = ? LIMIT 1').get(uid)) return 'never_scanned';
  const owner = db.prepare('SELECT id FROM items WHERE uid_nfc = ?').get(uid);
  return owner ? { known: owner.id } : null;
}

/**
 * Crée une fiche qui porte une puce inconnue (formulaire de l'étape 5, UID imposé).
 * Ligne d'audit item.create, avec l'UID dans ses détails.
 * @param {string} uid UID validé (parseUid)
 * @param {{name: string, notes: string, properties: [string, string][]}} item déjà validée
 * @returns {'never_scanned'|{known: number}|{id: number}} rien n'est écrit sauf {id}
 */
export function createItemForChip(db, userId, uid, item, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const conflict = chipConflict(db, uid);
    if (conflict !== null) return conflict;
    return { id: insertItem(db, userId, item, uid, now) };
  });
}

/**
 * Associe une puce inconnue à une fiche existante. Si la fiche portait une puce, celle-ci est
 * détachée (ses scans restent au journal et redeviennent ceux d'une puce inconnue).
 * Ligne d'audit item.chip_associate : {uid, previous_uid (null si aucune), name}.
 *
 * expectedPrevious : puce de la fiche telle qu'affichée sur la page de confirmation ('' :
 * aucune). Si la fiche a changé de puce depuis, rien n'est écrit ({changed}) : l'utilisateur
 * ne peut pas détacher une puce dont la page ne l'a pas averti.
 * @param {string} uid UID validé (parseUid)
 * @param {string|null} expectedPrevious champ du formulaire (null : absent, donc refusé)
 * @returns {'never_scanned'|{known: number}|'no_item'|{changed: true}|{id: number, previousUid: string|null}}
 */
export function associateChip(db, userId, uid, itemId, expectedPrevious, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const conflict = chipConflict(db, uid);
    if (conflict !== null) return conflict;
    const item = db.prepare('SELECT id, name, uid_nfc FROM items WHERE id = ?').get(itemId);
    if (!item) return 'no_item';
    if ((item.uid_nfc ?? '') !== expectedPrevious) return { changed: true };
    db.prepare('UPDATE items SET uid_nfc = ?, updated_at = ? WHERE id = ?').run(uid, now, item.id);
    audit(db, {
      at: now, userId, action: ACTIONS.chipAssociate, entityId: item.id,
      details: { uid, previous_uid: item.uid_nfc, name: item.name },
    });
    return { id: item.id, previousUid: item.uid_nfc };
  });
}

/**
 * Retire la puce d'une fiche (étape U3) : la fiche n'a plus de puce, la puce redevient inconnue
 * (ses scans restent au journal, D-006). Ligne d'audit item.chip_detach : {previous_uid, name}.
 *
 * keepStationId : si non null, l'emplacement est gardé : une correction manuelle vers ce poste
 * est enregistrée à la même heure, dans la même transaction (avec son audit habituel), avant le
 * retrait. Sans elle, la fiche perdrait l'emplacement donné par les scans de sa puce.
 * expectedUid : puce de la fiche telle qu'affichée sur la page de confirmation. Si la fiche n'a
 * plus cette puce (autre retrait, remplacement), rien n'est écrit ({changed}) : on ne détache
 * jamais une puce dont la page n'a pas parlé. Même règle que associateChip.
 * @param {string|null} expectedUid champ du formulaire (null : absent, donc refusé)
 * @param {bigint|number|null} [keepStationId] poste à garder, ou null
 * @returns {'no_item'|'no_station'|{changed: true}|{id: number, previousUid: string, kept: boolean}}
 */
export function detachChip(db, userId, itemId, expectedUid, keepStationId = null, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const item = db.prepare('SELECT id, name, uid_nfc FROM items WHERE id = ?').get(itemId);
    if (!item) return 'no_item';
    if (item.uid_nfc === null || item.uid_nfc !== expectedUid) return { changed: true };
    if (keepStationId !== null && !insertCorrection(db, userId, item.id, keepStationId, now)) return 'no_station';
    db.prepare('UPDATE items SET uid_nfc = NULL, updated_at = ? WHERE id = ?').run(now, item.id);
    audit(db, {
      at: now, userId, action: ACTIONS.chipDetach, entityId: item.id,
      details: { previous_uid: item.uid_nfc, name: item.name },
    });
    return { id: item.id, previousUid: item.uid_nfc, kept: keepStationId !== null };
  });
}
