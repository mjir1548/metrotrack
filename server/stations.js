// Postes de travail (étape 6) : validation des saisies, création, modification, suppression
// (seulement pour un poste sans historique), lectures pour les pages.
//
// JOURNAL : chaque écriture et sa ligne audit_log sont dans UNE même transaction
// (inTransaction, server/items.js). Une soumission sans changement n'écrit rien.
// Nettoyage des saisies : fonctions de server/items.js (cleanLine, cleanNotes,
// hasVisibleChar, keyFold), sans copie. Toutes les requêtes sont paramétrées.

import { cleanLine, cleanNotes, hasVisibleChar, keyFold, inTransaction, audit } from './items.js';
import { collator } from './inventory.js';

// Bornes en unités UTF-16 (text.length), comme l'attribut HTML maxlength ; comptées après
// nettoyage et normalisation NFC.
export const MAX_STATION_NAME_CHARS = 100;
export const MAX_STATION_DESCRIPTION_CHARS = 1_000;

export const STATION_ACTIONS = {
  create: 'station.create',
  update: 'station.update',
  delete: 'station.delete',
};

const format = (n) => n.toLocaleString('fr-FR');

/**
 * Nettoie et valide une saisie de poste.
 *   - nom : une ligne (cleanLine), au moins un caractère visible, 100 caractères au plus ;
 *   - description : facultative, plusieurs lignes (cleanNotes), 1 000 caractères au plus.
 * L'unicité du nom est vérifiée à l'écriture (dans la transaction), pas ici.
 * @returns {{ok: boolean, form: {name: string, description: string}, errors: {name?: string, description?: string},
 *   station: {name: string, description: string}|null}}
 */
export function validateStationInput({ name, description }) {
  const form = { name: cleanLine(name), description: cleanNotes(description) };
  const errors = {};
  if (!hasVisibleChar(form.name)) errors.name = 'Le nom est obligatoire.';
  else if (form.name.length > MAX_STATION_NAME_CHARS) {
    errors.name = `Le nom ne doit pas dépasser ${MAX_STATION_NAME_CHARS} caractères (${form.name.length} saisis).`;
  }
  if (form.description.length > MAX_STATION_DESCRIPTION_CHARS) {
    errors.description = `La description ne doit pas dépasser ${format(MAX_STATION_DESCRIPTION_CHARS)} caractères (${format(form.description.length)} saisis).`;
  }
  const ok = Object.keys(errors).length === 0;
  return { ok, form, errors, station: ok ? { name: form.name, description: form.description } : null };
}

/**
 * Forme de comparaison d'un nom de poste pour l'unicité : le nom passe par cleanLine (NFC,
 * invisibles retirés, suites de blancs réduites à une espace), même s'il est déjà stocké :
 * un nom ancien ou écrit hors de l'interface est ainsi comparé avec la même règle que la
 * saisie. Puis casse confondue comme les clés de propriétés (keyFold : « Atelier »,
 * « ATELIER », « atelier » sont le même nom).
 */
export function stationNameKey(name) {
  return keyFold(cleanLine(name));
}

/** Poste (autre que exceptId) dont le nom a la même forme de comparaison, ou null. */
function stationWithSameName(db, name, exceptId = null) {
  const key = stationNameKey(name);
  // Comparaison en JS : SQLite ne sait confondre la casse que pour l'ASCII. Table remplie à
  // la main (quelques dizaines de postes) : la lire en entier ne coûte rien.
  return db.prepare('SELECT id, name FROM stations').all()
    .find((row) => row.id !== exceptId && stationNameKey(row.name) === key) ?? null;
}

/**
 * Crée un poste et sa ligne d'audit.
 * Numéro : le suivant du plus grand jamais attribué, y compris parmi les postes supprimés
 * (lignes station.delete du journal). Un numéro de poste supprimé n'est donc jamais redonné :
 * audit_log.entity_id désigne toujours un seul poste, et un formulaire ouvert sur un poste
 * supprimé ne peut pas viser un nouveau poste (même raison que D-014 pour les fiches).
 * @param {{name: string, description: string}} station déjà validé
 * @returns {{id: number}|{duplicate: string}} duplicate : nom du poste existant
 */
export function createStation(db, userId, station, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const same = stationWithSameName(db, station.name);
    if (same) return { duplicate: same.name };
    const { next } = db.prepare(
      `SELECT max(coalesce((SELECT max(id) FROM stations), 0),
                  coalesce((SELECT max(entity_id) FROM audit_log WHERE action = ?), 0)) + 1 AS next`
    ).get(STATION_ACTIONS.delete);
    db.prepare('INSERT INTO stations (id, name, description, created_at) VALUES (?, ?, ?, ?)')
      .run(next, station.name, station.description, now);
    audit(db, { at: now, userId, action: STATION_ACTIONS.create, entityId: next, details: { name: station.name, description: station.description } });
    return { id: next };
  });
}

/**
 * Modifie le nom et la description d'un poste. Seuls les champs changés sont journalisés
 * (avant/après) ; sans changement, rien n'est écrit.
 * @returns {null|{duplicate: string}|{changed: string[]}} null : poste inexistant ;
 *   changed : champs changés, dans l'ordre name, description (vide : aucun changement)
 */
export function updateStation(db, userId, id, station, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const old = db.prepare('SELECT id, name, description FROM stations WHERE id = ?').get(id);
    if (!old) return null;
    const changes = {};
    if (station.name !== old.name) changes.name = { before: old.name, after: station.name };
    if (station.description !== old.description) changes.description = { before: old.description, after: station.description };
    const changed = Object.keys(changes);
    if (changed.length === 0) return { changed };
    if (changes.name) {
      const same = stationWithSameName(db, station.name, old.id);
      if (same) return { duplicate: same.name };
    }
    db.prepare('UPDATE stations SET name = ?, description = ? WHERE id = ?').run(station.name, station.description, old.id);
    audit(db, { at: now, userId, action: STATION_ACTIONS.update, entityId: old.id, details: changes });
    return { changed };
  });
}

/**
 * Historique d'un poste, qui interdit sa suppression : scans enregistrés à ce poste (index
 * scans_by_station, migration 005), corrections manuelles vers ce poste, lecteurs affectés
 * (actifs ou désactivés).
 * @returns {{scans: number, corrections: number, readers: number}}
 */
export function stationHistory(db, id) {
  return { ...db.prepare(
    `SELECT (SELECT count(*) FROM scans WHERE station_id = ?)                AS scans,
            (SELECT count(*) FROM location_corrections WHERE station_id = ?) AS corrections,
            (SELECT count(*) FROM readers WHERE station_id = ?)              AS readers`
  ).get(id, id, id) };
}

export const hasHistory = (history) => history.scans > 0 || history.corrections > 0 || history.readers > 0;

/**
 * Vrai si le poste a un historique (même définition que stationHistory). Tests d'existence
 * (EXISTS) : SQLite s'arrête à la première ligne trouvée, sans rien compter. Sert à la page
 * du poste et au contrôle avant suppression ; les décomptes ne sont calculés que pour être
 * affichés (suppression impossible).
 */
export function stationHasHistory(db, id) {
  return db.prepare(
    `SELECT EXISTS (SELECT 1 FROM scans WHERE station_id = ?)
         OR EXISTS (SELECT 1 FROM location_corrections WHERE station_id = ?)
         OR EXISTS (SELECT 1 FROM readers WHERE station_id = ?) AS used`
  ).get(id, id, id).used === 1;
}

/**
 * Supprime un poste sans historique. Le contrôle et la suppression sont dans la même
 * transaction (BEGIN IMMEDIATE : aucun scan ni lecteur ne peut arriver entre les deux).
 * Les clés étrangères (scans, location_corrections) sont ainsi anticipées, jamais subies.
 * L'audit garde le poste complet d'avant.
 * @returns {'ok'|'no_station'|{blocked: {scans: number, corrections: number, readers: number}}}
 */
export function deleteStation(db, userId, id, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const row = db.prepare('SELECT id, name, description, created_at FROM stations WHERE id = ?').get(id);
    if (!row) return 'no_station';
    if (stationHasHistory(db, row.id)) return { blocked: stationHistory(db, row.id) };
    audit(db, { at: now, userId, action: STATION_ACTIONS.delete, entityId: row.id, details: { ...row } });
    db.prepare('DELETE FROM stations WHERE id = ?').run(row.id);
    return 'ok';
  });
}

/** Poste {id, name, description, created_at}, ou null. */
export function getStation(db, id) {
  const row = db.prepare('SELECT id, name, description, created_at FROM stations WHERE id = ?').get(id);
  return row ? { ...row } : null;
}

/**
 * Postes pour la liste, triés par nom (ordre alphabétique français) :
 * [{id, name, description, active_readers, items_here}].
 * items_here : objets dont la localisation ACTUELLE est ce poste. Une seule lecture de la vue
 * item_locations pour tous les objets (deux lectures d'index par objet, D-013), sans
 * parcourir les scans.
 */
export function listStationSummaries(db) {
  const counts = new Map(db.prepare(
    'SELECT station_id, count(*) AS n FROM item_locations WHERE station_id IS NOT NULL GROUP BY station_id'
  ).all().map((row) => [row.station_id, row.n]));
  return db.prepare(
    `SELECT st.id, st.name, st.description,
            (SELECT count(*) FROM readers r WHERE r.station_id = st.id AND r.active = 1) AS active_readers
       FROM stations st`
  ).all()
    .map((row) => ({ ...row, items_here: counts.get(row.id) ?? 0 }))
    .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}

/** Lecteurs affectés à un poste, actifs d'abord : [{id, active, created_at}]. Jamais la clé. */
export function stationReaders(db, id) {
  return db.prepare('SELECT id, active, created_at FROM readers WHERE station_id = ? ORDER BY active DESC, id').all(id);
}

/** Objets actuellement localisés au poste, triés par nom : [{id, name, uid_nfc, at, source}]. */
export function stationItems(db, id) {
  return db.prepare(
    `SELECT i.id, i.name, i.uid_nfc, l.at, l.source
       FROM item_locations l
       JOIN items i ON i.id = l.item_id
      WHERE l.station_id = ?`
  ).all(id).sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}
