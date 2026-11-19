// Inventaire en lecture : liste avec recherche, fiche d'un objet, derniers scans de sa puce.
// La localisation n'est jamais stockée : elle est lue dans la vue item_locations (D-006).
// Toutes les requêtes sont paramétrées : aucune donnée n'est concaténée dans le SQL.

export const MAX_QUERY_CHARS = 100;
export const RECENT_SCANS = 20;

// Tri alphabétique français insensible à la casse et aux accents (« étuve » avec « Étuve »,
// avant « Four ») ; numeric : « Poste 2 » avant « Poste 10 ».
export const collator = new Intl.Collator('fr-FR', { sensitivity: 'base', numeric: true });

// Identifiant de fiche dans l'URL : entier strictement positif, 16 chiffres au plus, sans
// zéro initial ni signe. Tout le reste (vide, « 1.5 », « 0x1 », « 1e3 », encodé...) est refusé.
const ITEM_ID_FORMAT = /^[1-9][0-9]{0,15}$/;

/** Texte d'URL → identifiant (BigInt, exact au-delà de 2^53), ou null si le format est invalide. */
export function parseItemId(text) {
  return typeof text === 'string' && ITEM_ID_FORMAT.test(text) ? BigInt(text) : null;
}

// Caractères retirés de la saisie (recherche, et nom, clés et valeurs des fiches) avant usage
// et avant tout réaffichage :
// - contrôles C0 (dont NUL), DEL, contrôles C1 ;
// - mise en forme bidirectionnelle (U+202A à U+202E, U+2066 à U+2069, marques U+200E et U+200F,
//   marque arabe U+061C), qui pourraient inverser visuellement le texte affiché ;
// - invisibles : espace sans chasse U+200B, indicateur d'ordre U+FEFF, trait d'union
//   conditionnel U+00AD, séparateurs de ligne et de paragraphe U+2028 et U+2029. Ils
//   permettraient deux noms identiques à l'œil mais différents (ou un nom vide en apparence).
// U+200C et U+200D (antiliant, liant) sont GARDÉS : légitimes dans certaines langues et emoji.
export const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// Suite de blancs Unicode dans une saisie sur une ligne → UNE espace ordinaire. Sans cela,
// « Poste   2 », ou « Poste 2 » écrit avec une espace insécable (U+00A0, U+202F, U+2007),
// s'afficheraient comme « Poste 2 » tout en échappant au contrôle des doublons (noms de
// poste, clés de propriété). \s couvre déjà tous les blancs Unicode ; les trois espaces
// insécables sont listées en plus, pour l'auditeur. Les notes et descriptions (plusieurs
// lignes, cleanNotes) ne sont pas concernées. Partagée par cleanLine (items.js) et la
// recherche (normalizeQuery) : « Poste  2 » cherche « Poste 2 ».
export const LINE_BLANKS = /[\s\u00A0\u2007\u202F]+/g;

/**
 * Saisie de recherche : caractères de contrôle retirés, suites de blancs réduites à une
 * espace (LINE_BLANKS), espaces de bord retirés, limitée à
 * MAX_QUERY_CHARS caractères (points de code : pas d'unité UTF-16 coupée en deux). Une saisie
 * dont la forme de comparaison est vide (accent combinant isolé, par exemple) est traitée
 * comme une recherche vide : tout l'inventaire, champ vide.
 */
export function normalizeQuery(value) {
  if (typeof value !== 'string') return '';
  const query = [...value.replace(CONTROL_CHARS, '').replace(LINE_BLANKS, ' ').trim()].slice(0, MAX_QUERY_CHARS).join('').trim();
  return fold(query).trim() === '' ? '' : query;
}

/**
 * Forme de comparaison d'un texte : minuscules, sans diacritiques (« Étuve », « ÉTUVE »,
 * « etuve » → « etuve »). NFD sépare les lettres de leurs accents, qui sont ensuite retirés.
 */
export function fold(text) {
  return text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * Fragment d'UID cherché : majuscules, sans espaces, deux-points ni tirets (« 04:a1-b2 » →
 * « 04A1B2 »). Il faut qu'il soit hexadécimal, d'au moins 4 caractères, et qu'il contienne un
 * chiffre OU ait la longueur d'un UID complet (8, 14 ou 20 : « DEADBEEF »). Sinon null : la
 * recherche porte sur le nom seulement. Ainsi « de », « a », mais aussi des mots entièrement
 * hexadécimaux comme « face » ou « decade », ne font pas remonter d'UID par hasard.
 */
export function uidFragment(query) {
  const compact = query.toUpperCase().replace(/[\s:-]/g, '');
  if (!/^[0-9A-F]{4,}$/.test(compact)) return null;
  return /[0-9]/.test(compact) || [8, 14, 20].includes(compact.length) ? compact : null;
}

// Colonnes de localisation (vue item_locations, D-006). at NULL = jamais localisé ;
// station_id NULL avec at renseigné = scan sur un lecteur non affecté ; source = 'scan'
// (reader_id renseigné) ou 'manual' (correction manuelle, migration 004).
const LOCATION_COLUMNS = 'l.at, l.source, l.reader_id, l.station_id, st.name AS station_name';
const NO_LOCATION = { at: null, source: null, reader_id: null, station_id: null, station_name: null };

/**
 * Objets dont le nom contient la saisie (casse et accents ignorés) ou dont l'UID contient le
 * fragment d'UID. Saisie vide : tout l'inventaire. Trié par nom.
 *
 * Une seule requête, sans requête par ligne. La vue y est calculée une fois pour tous les
 * objets, soit une lecture d'index par objet (migration 003). Le filtre est appliqué en JS sur
 * les lignes chargées : la liste est de toute façon chargée en entier (pas de pagination), la
 * comparaison sans accents est simple à écrire en JS, et aucun motif LIKE n'est construit
 * (ni joker à échapper, ni motif tronqué au caractère NUL).
 */
export function listItems(db, query) {
  const rows = db.prepare(
    `SELECT i.id, i.name, i.uid_nfc, ${LOCATION_COLUMNS}
       FROM items i
       LEFT JOIN item_locations l ON l.item_id = i.id
       LEFT JOIN stations st ON st.id = l.station_id`
  ).all();
  let matches = rows;
  if (query !== '') {
    const needle = fold(query);
    const uid = uidFragment(query);
    matches = rows.filter((row) => fold(row.name).includes(needle)
      || (uid !== null && row.uid_nfc !== null && row.uid_nfc.includes(uid)));
  }
  return matches.sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}

/**
 * Fiche complète avec sa localisation, ou null si elle n'existe pas.
 * properties : liste de paires [clé, valeur texte], dans l'ordre d'Object.entries : clés
 * entières (« 1 », « 42 ») d'abord, par ordre croissant, puis les autres dans l'ordre stocké.
 */
export function getItem(db, id) {
  const row = db.prepare(
    'SELECT id, uid_nfc, name, properties, notes, created_at, updated_at FROM items WHERE id = ?'
  ).get(id);
  if (!row) return null;
  // Localisation lue à part, la vue en tête de requête et filtrée par item_id : SQLite
  // l'intègre à la requête et ne lit que cet objet (aucune matérialisation de la vue).
  const location = db.prepare(
    `SELECT ${LOCATION_COLUMNS}
       FROM item_locations l
       LEFT JOIN stations st ON st.id = l.station_id
      WHERE l.item_id = ?`
  ).get(id) ?? NO_LOCATION;
  // Localisation issue d'une correction manuelle : son auteur. C'est la dernière correction de
  // l'objet, avec le même ordre que la vue (heure, puis id) ; index corrections_by_item.
  const correctedBy = location.source !== 'manual' ? null : db.prepare(
    `SELECT u.username
       FROM location_corrections c JOIN users u ON u.id = c.user_id
      WHERE c.item_id = ?
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT 1`
  ).get(id)?.username ?? null;
  return { ...row, ...location, corrected_by: correctedBy, properties: propertyPairs(row.properties) };
}

/**
 * Propriétés stockées (texte JSON d'un objet, garanti par le CHECK de la table) → liste de
 * paires [clé, valeur texte]. Valeur non textuelle (donnée importée) : affichée en JSON.
 */
export function propertyPairs(json) {
  return Object.entries(JSON.parse(json))
    .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]);
}

/** Derniers scans d'une puce, du plus récent au plus ancien (index scans_by_uid). */
export function recentScans(db, uid, limit = RECENT_SCANS) {
  return db.prepare(
    `SELECT s.received_at, s.reader_id, s.station_id, st.name AS station_name
       FROM scans s
       LEFT JOIN stations st ON st.id = s.station_id
      WHERE s.uid_nfc = ?
      ORDER BY s.received_at DESC, s.id DESC
      LIMIT ?`
  ).all(uid, limit);
}
