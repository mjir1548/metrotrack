// Édition des fiches (étape 5) : nettoyage et validation des saisies, création, modification,
// suppression, correction manuelle de localisation, historique des modifications d'une fiche.
//
// JOURNAL : chaque écriture et sa ligne audit_log sont faites dans UNE même transaction
// (BEGIN IMMEDIATE … COMMIT, ROLLBACK sur toute erreur). Une modification n'existe donc jamais
// sans sa trace, ni une trace sans sa modification. audit_log est en ajout seul (triggers de
// la migration 004). Ses détails ne contiennent que des données de fiche et de poste : jamais
// de secret (mot de passe, jeton, clé de lecteur).
// Toutes les requêtes sont paramétrées. L'UID de la puce n'est jamais saisi à la main : il
// n'est posé que par l'association d'une puce scannée (server/chips.js, étape 7), qui réutilise
// insertItem, inTransaction et audit.

import { CONTROL_CHARS, LINE_BLANKS, UID_FORMAT, collator, propertyPairs } from './inventory.js';

// Bornes des saisies, en caractères comptés en unités UTF-16 (text.length), comme l'attribut
// HTML maxlength : le navigateur et le serveur appliquent la même limite (un emoji hors du
// plan de base compte pour deux). Comptées après nettoyage et normalisation NFC.
export const MAX_NAME_CHARS = 200; //            nom, obligatoire
export const MAX_NOTES_CHARS = 10_000; //        notes multilignes
export const MAX_PROPERTIES = 50; //             paires clé → valeur par fiche
export const MAX_PROPERTY_KEY_CHARS = 100; //    clé : de 1 à 100 caractères
export const MAX_PROPERTY_VALUE_CHARS = 1_000; // valeur : 0 à 1 000 caractères
// Nombre de lignes de la carte « Modifications de la fiche » (itemChanges).
export const HISTORY_ENTRIES = 20;

export const ACTIONS = {
  create: 'item.create',
  update: 'item.update',
  delete: 'item.delete',
  correctLocation: 'item.location_correct',
  chipAssociate: 'item.chip_associate', // étape 7, server/chips.js
  chipDetach: 'item.chip_detach', // étape U3, server/chips.js
};

// Notes : exactement CONTROL_CHARS (inventory.js, voir la liste commentée), sauf le retour à
// la ligne (U+000A) et la tabulation (U+0009), qui sont gardés.
const NOTES_CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// Coupures de ligne et tabulations d'une saisie sur une ligne (souvent un copier-coller) :
// tabulation, saut de ligne, tabulation verticale, saut de page, retour chariot, NEL (U+0085),
// séparateurs de ligne et de paragraphe (U+2028, U+2029). Remplacées par une espace AVANT le
// retrait des contrôles, sinon « ligne1⏎ligne2 » deviendrait « ligne1ligne2 ». Échappements
// \x et \u{...} : aucun caractère invisible littéral dans les sources.
const LINE_BREAKS = /[\t\n\v\f\r\x85\u{2028}\u{2029}]/gu;

/**
 * Saisie sur une ligne (nom, clé, valeur) : coupures de ligne et tabulations changées en
 * espace (LINE_BREAKS), contrôles, bidi et invisibles retirés, forme NFC (un « é » saisi
 * précomposé ou décomposé est le même texte), suites de blancs réduites à une espace
 * ordinaire (LINE_BLANKS), espaces de bord retirés.
 */
export function cleanLine(value) {
  return typeof value === 'string'
    ? value.replace(LINE_BREAKS, ' ').replace(CONTROL_CHARS, '').normalize('NFC').replace(LINE_BLANKS, ' ').trim()
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
  return inTransaction(db, () => insertItem(db, userId, item, null, now));
}

/**
 * Insère une fiche et sa ligne d'audit item.create, SANS ouvrir de transaction : à appeler
 * dans inTransaction (createItem ci-dessus ; création depuis une puce inconnue, server/chips.js).
 * uid : UID de la puce (déjà validé et vérifié inconnu par l'appelant), ou null. Il figure
 * dans les détails d'audit seulement s'il est renseigné.
 * @returns {number} identifiant de la fiche
 */
export function insertItem(db, userId, item, uid, now) {
  const properties = propertiesJson(item.properties);
  const id = db.prepare('INSERT INTO items (uid_nfc, name, properties, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(uid, item.name, properties, item.notes, now, now).lastInsertRowid;
  const details = { name: item.name, properties: JSON.parse(properties), notes: item.notes };
  if (uid !== null) details.uid = uid;
  audit(db, { at: now, userId, action: ACTIONS.create, entityId: id, details });
  return id;
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
    return insertCorrection(db, userId, itemId, stationId, now) ? 'ok' : 'no_station';
  });
}

/**
 * Enregistre une correction et sa ligne d'audit, SANS ouvrir de transaction : à appeler dans
 * inTransaction (correctLocation ci-dessus ; retrait de puce qui garde l'emplacement,
 * server/chips.js). La fiche doit exister (vérifié par l'appelant).
 * @returns {boolean} faux si le poste n'existe pas (rien n'est écrit)
 */
export function insertCorrection(db, userId, itemId, stationId, now) {
  const station = stationId === null ? undefined : db.prepare('SELECT id, name FROM stations WHERE id = ?').get(stationId);
  if (!station) return false;
  db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, ?, ?)')
    .run(itemId, station.id, userId, now);
  audit(db, { at: now, userId, action: ACTIONS.correctLocation, entityId: itemId, details: { station: { id: station.id, name: station.name } } });
  return true;
}

/** Postes existants, triés par nom (ordre alphabétique français, comme l'inventaire). */
export function listStations(db) {
  return db.prepare('SELECT id, name FROM stations').all()
    .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}

/**
 * Modifications d'une fiche autres que l'emplacement (carte « Modifications de la fiche »), de
 * la plus récente à la plus ancienne : [{at, username (null = ligne de commande), labels}]
 * (labels : voir changeLabels). Les corrections d'emplacement et la création sont dans la frise
 * des déplacements (server/timeline.js) ; la suppression n'a pas de fiche où s'afficher.
 * Un numéro de fiche n'est jamais réutilisé (items en AUTOINCREMENT, migration 004) : toutes
 * les lignes item.* de ce numéro appartiennent à cette fiche. Lecture par l'index audit_by_entity.
 */
export function itemChanges(db, itemId, limit = HISTORY_ENTRIES) {
  const rows = db.prepare(
    `SELECT a.at, a.action, a.details, u.username
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_id = ?
        AND a.action IN (?, ?, ?)
      ORDER BY a.id DESC
      LIMIT ?`
  ).all(itemId, ACTIONS.update, ACTIONS.chipAssociate, ACTIONS.chipDetach, limit);
  return rows.map((row) => ({ at: row.at, username: row.username, labels: changeLabels(row.action, row.details) }));
}

/**
 * Libellés en langage simple d'une ligne d'audit de fiche (jamais le JSON brut) : une liste de
 * libellés, chacun un texte ou, s'il contient un numéro de puce, une liste de segments (textes et
 * objets {uid}, que la page affiche en chasse fixe, views.js). Aucun HTML n'est produit ici.
 * Modification : un libellé par changement (« Nom modifié », « Propriété « Marque » ajoutée »…).
 */
export function changeLabels(action, detailsJson) {
  let details;
  try {
    details = JSON.parse(detailsJson);
  } catch {
    details = null;
  }
  if (details === null || typeof details !== 'object') details = {};
  // UID lu dans le journal : affiché seulement s'il a le format d'un UID (texte libre exclu).
  const uidOf = (value) => (typeof value === 'string' && UID_FORMAT.test(value) ? { uid: value } : null);
  switch (action) {
    case ACTIONS.chipAssociate: {
      const uid = uidOf(details.uid);
      const previous = uidOf(details.previous_uid);
      if (uid === null) return ['Puce associée'];
      return [previous === null ? ['Puce associée : ', uid] : ['Puce remplacée : ', uid, ' (remplace ', previous, ')']];
    }
    case ACTIONS.chipDetach: {
      const previous = uidOf(details.previous_uid);
      return [previous === null ? 'Puce retirée' : ['Puce retirée : ', previous]];
    }
    case ACTIONS.update: {
      const labels = [];
      if (Object.hasOwn(details, 'name')) labels.push('Nom modifié');
      if (Object.hasOwn(details, 'properties')) labels.push(...propertyLabels(details.properties));
      if (Object.hasOwn(details, 'notes')) labels.push(notesLabel(details.notes));
      return labels.length === 0 ? ['Fiche modifiée'] : labels;
    }
    default: return ['Fiche modifiée'];
  }
}

/** Propriétés avant/après (objets JSON) → « Propriété « Marque » ajoutée / modifiée / retirée ». */
function propertyLabels(change) {
  const before = isPlainObject(change?.before) ? change.before : {};
  const after = isPlainObject(change?.after) ? change.after : {};
  const labels = [];
  for (const key of Object.keys(after)) {
    if (!Object.hasOwn(before, key)) labels.push(`Propriété ${quoted(key)} ajoutée`);
    else if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) labels.push(`${key} : ${shortValue(before[key])} → ${shortValue(after[key])}`);
  }
  for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) labels.push(`Propriété ${quoted(key)} retirée`);
  return labels.length === 0 ? ['Ordre des propriétés modifié'] : labels;
}

function notesLabel(change) {
  if (change?.before === '') return 'Notes ajoutées';
  if (change?.after === '') return 'Notes effacées';
  return 'Notes modifiées';
}

// Valeur de propriété dans « N° de série : 4123 → 4124 » : texte (JSON si importée non
// textuelle), « (vide) » si vide, coupée à SHORT_VALUE_CHARS points de code avec « … ».
const SHORT_VALUE_CHARS = 60;
function shortValue(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  if (text === '') return '(vide)';
  const chars = [...text];
  return chars.length > SHORT_VALUE_CHARS ? `${chars.slice(0, SHORT_VALUE_CHARS).join('')}…` : text;
}

// Guillemets français avec espaces insécables (échappement : aucun caractère invisible littéral).
const quoted = (text) => `«\u00A0${text}\u00A0»`;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
