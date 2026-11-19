// Édition des fiches (étape 5) : nettoyage et validation des saisies, création, modification,
// suppression, correction manuelle de localisation, historique des modifications d'une fiche.
//
// JOURNAL : chaque écriture et sa ligne audit_log sont faites dans UNE même transaction
// (BEGIN IMMEDIATE … COMMIT, ROLLBACK sur toute erreur). Une modification n'existe donc jamais
// sans sa trace, ni une trace sans sa modification. audit_log est en ajout seul (triggers de
// la migration 004). Ses détails ne contiennent que des données de fiche et de poste : jamais
// de secret (mot de passe, jeton, clé de lecteur).
// Toutes les requêtes sont paramétrées. L'UID de la puce n'est ni créé ni modifié ici
// (association des puces : étape 7).

import { CONTROL_CHARS, LINE_BLANKS, collator, propertyPairs } from './inventory.js';

// Bornes des saisies, en caractères comptés en unités UTF-16 (text.length), comme l'attribut
// HTML maxlength : le navigateur et le serveur appliquent la même limite (un emoji hors du
// plan de base compte pour deux). Comptées après nettoyage et normalisation NFC.
export const MAX_NAME_CHARS = 200; //            nom, obligatoire
export const MAX_NOTES_CHARS = 10_000; //        notes multilignes
export const MAX_PROPERTIES = 50; //             paires clé → valeur par fiche
export const MAX_PROPERTY_KEY_CHARS = 100; //    clé : de 1 à 100 caractères
export const MAX_PROPERTY_VALUE_CHARS = 1_000; // valeur : 0 à 1 000 caractères
// Nombre de lignes de l'historique des modifications affiché sur une fiche.
export const HISTORY_ENTRIES = 20;

export const ACTIONS = {
  create: 'item.create',
  update: 'item.update',
  delete: 'item.delete',
  correctLocation: 'item.location_correct',
};

// Notes : exactement CONTROL_CHARS (inventory.js, voir la liste commentée), sauf le retour à
// la ligne (U+000A) et la tabulation (U+0009), qui sont gardés.
const NOTES_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * Saisie sur une ligne (nom, clé, valeur) : contrôles, bidi et invisibles retirés, forme NFC
 * (un « é » saisi précomposé ou décomposé est le même texte), suites de blancs réduites à
 * une espace ordinaire (LINE_BLANKS), espaces de bord retirés.
 */
export function cleanLine(value) {
  return typeof value === 'string'
    ? value.replace(CONTROL_CHARS, '').normalize('NFC').replace(LINE_BLANKS, ' ').trim()
    : '';
}

/** Notes : CRLF → LF, mêmes retraits (sauf LF et tabulation), forme NFC, espaces de bord retirés. */
export function cleanNotes(value) {
  return typeof value === 'string'
    ? value.replace(/\r\n/g, '\n').replace(NOTES_CONTROL_CHARS, '').normalize('NFC').trim()
    : '';
}

// Caractère visible : lettre, chiffre, symbole ou ponctuation, SAUF les caractères
// « ignorables par défaut » d'Unicode (Default_Ignorable_Code_Point : remplissages hangul
// U+115F, U+1160, U+3164, U+FFA0, joints et sélecteurs de variante...) et la cellule braille
// vide U+2800, qui sont classés lettre ou symbole mais ne s'affichent pas.
const VISIBLE_CHAR = /[[\p{L}\p{N}\p{S}\p{P}]--[\p{Default_Ignorable_Code_Point}\u2800]]/v;

/**
 * Vrai si le texte contient au moins un caractère visible. Règle positive, en complément de
 * la liste de retrait : un nom ou une clé faits seulement d'espaces, de joints ou de
 * caractères sans glyphe (U+2060, U+3164, U+2800, U+200D, U+FE0F, espaces insécables...)
 * seraient sinon des valeurs « vides » à l'écran, impossibles à distinguer entre elles.
 */
export function hasVisibleChar(text) {
  return VISIBLE_CHAR.test(text);
}

/**
 * Forme de comparaison d'une clé de propriété pour les doublons : majuscules puis minuscules,
 * ce qui confond aussi les casses qui changent de longueur (« Straße », « STRASSE » →
 * « strasse »). La clé est déjà en NFC (cleanLine).
 */
export function keyFold(key) {
  return key.toUpperCase().toLowerCase();
}

/**
 * Nettoie et valide une saisie de fiche.
 * @param {{name?: string|null, notes?: string|null, keys?: string[], values?: string[]}} input
 *   keys[i] et values[i] forment la ligne de propriété i.
 * @returns {{
 *   ok: boolean,
 *   form: {name: string, notes: string, rows: {key: string, value: string, error: string|null}[], blankRows: number},
 *   errors: {name?: string, notes?: string, properties?: string},
 *   item: {name: string, notes: string, properties: [string, string][]} | null,
 * }}
 *   form : valeurs nettoyées, pour réafficher le formulaire sans rien perdre (lignes non vides,
 *   chacune avec son erreur éventuelle ; blankRows = nombre de lignes vides reçues) ;
 *   item : la fiche à enregistrer, seulement si ok.
 */
export function validateItemInput({ name, notes, keys = [], values = [] }) {
  const form = { name: cleanLine(name), notes: cleanNotes(notes), rows: [], blankRows: 0 };
  const errors = {};

  for (let i = 0; i < Math.max(keys.length, values.length); i++) {
    const key = cleanLine(keys[i]);
    const value = cleanLine(values[i]);
    if (key === '' && value === '') form.blankRows++; // ligne vide : ignorée
    else form.rows.push({ key, value, error: null });
  }

  const nameLength = form.name.length;
  if (!hasVisibleChar(form.name)) errors.name = 'Le nom est obligatoire.';
  else if (nameLength > MAX_NAME_CHARS) errors.name = `Le nom ne doit pas dépasser ${MAX_NAME_CHARS} caractères (${nameLength} saisis).`;

  const notesLength = form.notes.length;
  if (notesLength > MAX_NOTES_CHARS) errors.notes = `Les notes ne doivent pas dépasser ${format(MAX_NOTES_CHARS)} caractères (${format(notesLength)} saisis).`;

  if (form.rows.length > MAX_PROPERTIES) {
    errors.properties = `${MAX_PROPERTIES} propriétés au plus : ${form.rows.length} saisies. Retirez-en ${form.rows.length - MAX_PROPERTIES}.`;
  }
  // Clés uniques sans tenir compte de la casse (« Marque » et « marque » : doublon ; voir
  // keyFold). La première occurrence est acceptée, les suivantes sont signalées.
  const seen = new Map();
  for (const row of form.rows) {
    const folded = keyFold(row.key);
    if (!hasVisibleChar(row.key)) row.error = 'Indiquez le nom de la propriété : une valeur seule ne suffit pas.';
    else if (row.key.length > MAX_PROPERTY_KEY_CHARS) row.error = `Le nom de la propriété ne doit pas dépasser ${MAX_PROPERTY_KEY_CHARS} caractères (${row.key.length} saisis).`;
    else if (seen.has(folded)) row.error = `Propriété en double : « ${seen.get(folded)} » existe déjà (majuscules et minuscules confondues).`;
    else if (row.value.length > MAX_PROPERTY_VALUE_CHARS) row.error = `La valeur ne doit pas dépasser ${format(MAX_PROPERTY_VALUE_CHARS)} caractères (${format(row.value.length)} saisis).`;
    if (row.key !== '' && !seen.has(folded)) seen.set(folded, row.key);
  }

  const ok = Object.keys(errors).length === 0 && form.rows.every((row) => row.error === null);
  const item = ok ? { name: form.name, notes: form.notes, properties: form.rows.map((row) => [row.key, row.value]) } : null;
  return { ok, form, errors, item };
}

// Nombre avec séparateur de milliers français (espace insécable étroite) : « 10 000 ».
const format = (n) => n.toLocaleString('fr-FR');

/**
 * Paires → texte JSON stocké. Object.fromEntries crée des propriétés PROPRES : une clé
 * « __proto__ » reste une clé ordinaire (pas de modification du prototype).
 */
function propertiesJson(pairs) {
  return JSON.stringify(Object.fromEntries(pairs));
}

/**
 * Exécute work() dans une transaction d'écriture ; ROLLBACK et relance sur toute erreur.
 * Partagée avec server/stations.js et server/readers.js (même règle : écriture + audit ensemble).
 */
export function inTransaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    // isTransaction : ne pas masquer l'erreur d'origine si SQLite a déjà annulé.
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** Ligne audit_log (details : objet sérialisé en JSON ; JAMAIS de secret). À appeler dans inTransaction. */
export function audit(db, { at, userId, action, entityId, details }) {
  db.prepare('INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, ?, ?, ?, ?)')
    .run(at, userId, action, entityId, JSON.stringify(details));
}

/**
 * Crée une fiche (sans puce) et sa ligne d'audit.
 * @param {{name: string, notes: string, properties: [string, string][]}} item déjà validée
 * @returns {number} identifiant de la fiche
 */
export function createItem(db, userId, item, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const properties = propertiesJson(item.properties);
    const id = db.prepare('INSERT INTO items (name, properties, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(item.name, properties, item.notes, now, now).lastInsertRowid;
    audit(db, {
      at: now, userId, action: ACTIONS.create, entityId: id,
      details: { name: item.name, properties: JSON.parse(properties), notes: item.notes },
    });
    return id;
  });
}

/**
 * Modifie une fiche. Seuls les champs réellement changés sont journalisés (avant/après) ;
 * sans changement, rien n'est écrit (ni la fiche, ni updated_at, ni l'audit).
 * Propriétés comparées sous leur forme affichée (propertyPairs) : une valeur non textuelle
 * importée (42) resoumise telle quelle (« 42 ») n'est pas un changement, et reste stockée
 * telle quelle.
 * @returns {string[]|null} champs changés, dans l'ordre name, properties, notes (vide : aucun
 *   changement), ou null si la fiche n'existe pas.
 */
export function updateItem(db, userId, id, item, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const old = db.prepare('SELECT name, properties, notes FROM items WHERE id = ?').get(id);
    if (!old) return null;
    const properties = propertiesJson(item.properties);
    const changes = {};
    if (item.name !== old.name) changes.name = { before: old.name, after: item.name };
    if (JSON.stringify(propertyPairs(old.properties)) !== JSON.stringify(propertyPairs(properties))) {
      changes.properties = { before: JSON.parse(old.properties), after: JSON.parse(properties) };
    }
    if (item.notes !== old.notes) changes.notes = { before: old.notes, after: item.notes };
    const fields = Object.keys(changes);
    if (fields.length === 0) return fields;
    db.prepare('UPDATE items SET name = ?, properties = ?, notes = ?, updated_at = ? WHERE id = ?').run(
      changes.name ? item.name : old.name,
      changes.properties ? properties : old.properties,
      changes.notes ? item.notes : old.notes,
      now, id,
    );
    audit(db, { at: now, userId, action: ACTIONS.update, entityId: id, details: changes });
    return fields;
  });
}

/**
 * Supprime une fiche. Ses corrections de localisation partent avec elle (ON DELETE CASCADE) ;
 * le journal des scans et audit_log restent. L'audit garde la fiche complète d'avant.
 * @returns {boolean} faux si la fiche n'existe pas
 */
export function deleteItem(db, userId, id, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    const row = db.prepare('SELECT id, uid_nfc, name, properties, notes, created_at, updated_at FROM items WHERE id = ?').get(id);
    if (!row) return false;
    audit(db, { at: now, userId, action: ACTIONS.delete, entityId: id, details: { ...row, properties: JSON.parse(row.properties) } });
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
    return true;
  });
}

/**
 * Correction manuelle de localisation : l'objet est déclaré au poste donné, à l'heure du
 * serveur. Elle vaut jusqu'au prochain scan de sa puce (vue item_locations).
 * La fiche elle-même n'est pas modifiée (updated_at inchangé) : la correction est un
 * événement, journalisé dans location_corrections et dans audit_log.
 * @param {bigint|number|null} stationId identifiant de poste (null : saisie invalide)
 * @returns {'ok'|'no_item'|'no_station'}
 */
export function correctLocation(db, userId, itemId, stationId, now = new Date().toISOString()) {
  return inTransaction(db, () => {
    if (!db.prepare('SELECT 1 FROM items WHERE id = ?').get(itemId)) return 'no_item';
    const station = stationId === null ? undefined : db.prepare('SELECT id, name FROM stations WHERE id = ?').get(stationId);
    if (!station) return 'no_station';
    db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(itemId, station.id, userId, now);
    audit(db, { at: now, userId, action: ACTIONS.correctLocation, entityId: itemId, details: { station: { id: station.id, name: station.name } } });
    return 'ok';
  });
}

/** Postes existants, triés par nom (ordre alphabétique français, comme l'inventaire). */
export function listStations(db) {
  return db.prepare('SELECT id, name FROM stations').all()
    .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}

/**
 * Dernières modifications d'une fiche, de la plus récente à la plus ancienne :
 * [{at, username (null = ligne de commande), label}].
 * Un numéro de fiche n'est jamais réutilisé (items en AUTOINCREMENT, migration 004) : toutes
 * les lignes item.* de ce numéro appartiennent à cette fiche. Lecture par l'index audit_by_entity.
 */
export function itemHistory(db, itemId, limit = HISTORY_ENTRIES) {
  const rows = db.prepare(
    `SELECT a.at, a.action, a.details, u.username
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_id = ?
        AND a.action IN (?, ?, ?, ?)
      ORDER BY a.id DESC
      LIMIT ?`
  ).all(itemId, ACTIONS.create, ACTIONS.update, ACTIONS.delete, ACTIONS.correctLocation, limit);
  return rows.map((row) => ({ at: row.at, username: row.username, label: auditLabel(row.action, row.details) }));
}

const FIELD_LABELS = { name: 'nom', properties: 'propriétés', notes: 'notes' };

/** Libellé français d'une ligne d'audit de fiche (jamais le JSON brut). */
export function auditLabel(action, detailsJson) {
  let details;
  try {
    details = JSON.parse(detailsJson);
  } catch {
    details = {};
  }
  switch (action) {
    case ACTIONS.create: return 'Fiche créée';
    case ACTIONS.delete: return 'Fiche supprimée';
    case ACTIONS.update: {
      const fields = Object.keys(FIELD_LABELS).filter((field) => Object.hasOwn(details ?? {}, field)).map((field) => FIELD_LABELS[field]);
      return fields.length === 0 ? 'Fiche modifiée' : `Fiche modifiée : ${fields.join(', ')}`;
    }
    case ACTIONS.correctLocation: {
      const station = details?.station?.name;
      return typeof station === 'string' ? `Localisation corrigée : ${station}` : 'Localisation corrigée';
    }
    default: return action;
  }
}
