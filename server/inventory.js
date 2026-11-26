// Inventaire en lecture : liste avec recherche, fiche d'un objet, derniers scans de sa puce.
// La localisation n'est jamais stockée : elle est lue dans la vue item_locations (D-006).
// Toutes les requêtes sont paramétrées : aucune donnée n'est concaténée dans le SQL.

export const MAX_QUERY_CHARS = 100;
export const RECENT_SCANS = 20;
// Nombre maximal de scans examinés par objet pour trouver son heure d'arrivée (withLocations).
// Borne le coût d'un affichage quelle que soit la longueur de la série au même endroit : au
// pire environ 2 × 2 000 entrées d'index par objet concerné (moins d'1 ms). 2 000 scans
// couvrent largement un usage normal (plusieurs scans par jour pendant des mois) ; au-delà,
// l'affichage indique « depuis au moins ».
export const MAX_RUN_SCANS = 2000;

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

// UID de puce NFC : 8, 14 ou 20 caractères hexadécimaux en MAJUSCULES (puces de 4, 7 ou
// 10 octets), le format stocké dans scans et items (CHECK des migrations 001 et 004).
export const UID_FORMAT = /^(?:[0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/;

/**
 * Segment d'URL → UID, ou null. SÉCURITÉ : aucune normalisation. Le segment est comparé tel
 * qu'il est reçu, sans décodage %XX (server/http.js ne décode pas le chemin) ni passage en
 * majuscules : un UID n'a qu'une seule représentation acceptée, celle des liens produits par
 * l'application. Minuscules, séparateurs, encodages (%34, %00...), espaces, longueurs autres
 * que 8, 14 ou 20 : refusés (404 pour l'appelant).
 */
export function parseUid(text) {
  return typeof text === 'string' && UID_FORMAT.test(text) ? text : null;
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
// ATTENTION : expression avec le drapeau /g. Sûre avec .replace() (qui repart toujours du
// début), mais à NE PAS utiliser avec .test() ni .exec() : ces méthodes mémorisent la position
// de la dernière correspondance (lastIndex) d'un appel à l'autre, et un second appel pourrait
// alors échouer à tort. Même règle pour CONTROL_CHARS ci-dessus.
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

/**
 * Clause WITH qui définit la table « locations » : la localisation actuelle de chaque objet
 * localisé (vue item_locations, D-006), complétée de son HEURE D'ARRIVÉE à cet emplacement.
 * Colonnes : item_id, station_id, at, source, reader_id, arrived_at, arrived_at_bounded,
 * arrival_source.
 *   - arrival_source : nature de l'événement d'ARRIVÉE, 'scan' ou 'manual' (correction) ;
 *   - arrived_at_bounded : 1 si la remontée a atteint MAX_RUN_SCANS (voir plus bas) ; l'objet
 *     est alors à cet emplacement depuis AU MOINS arrived_at. Sinon 0, et arrived_at est exact.
 *
 * Rien n'est stocké (D-006) : tout est recalculé depuis le journal des scans et les
 * corrections manuelles.
 *
 * Événements d'un objet : les scans de sa puce ACTUELLE (comme la vue) et ses corrections
 * manuelles. Ils sont rangés dans l'ordre de la vue : heure, puis, à heure égale, le scan avant
 * la correction (la correction l'emporte dans la vue), puis l'id. Pour comparer deux événements
 * de tables différentes, chacun reçoit une clé textuelle qui suit cet ordre :
 *   « heure|0|id » pour un scan, « heure|1|id » pour une correction, id sur 19 chiffres.
 * (Les heures sont toutes au format ISO 8601 UTC à la milliseconde du serveur : leur ordre
 * alphabétique est l'ordre chronologique, comme dans la vue elle-même.)
 *
 * Emplacement actuel : celui du dernier événement (la vue, inchangée).
 * Heure d'arrivée : heure du PREMIER événement de la dernière série ininterrompue d'événements
 * au même emplacement. « lecteur non affecté » (station_id NULL) compte comme un emplacement à
 * part entière : d'où les comparaisons « IS NOT », vraies aussi entre NULL et un poste.
 * Calcul en deux temps, par lectures d'index :
 *   1. b.k : clé du dernier événement AILLEURS qu'à l'emplacement actuel (le départ de
 *      l'emplacement précédent), ou '' s'il n'y en a aucun. On remonte les scans de la puce
 *      (index scans_by_uid, migration 006) jusqu'au premier scan d'un autre emplacement, on lit
 *      de même la dernière correction vers un autre poste (index corrections_by_item), et on
 *      garde la plus récente des deux clés.
 *   2. arrived_at : heure du premier événement APRÈS b.k (tous à l'emplacement actuel, par
 *      construction) : une lecture d'index à partir de l'heure de b.k, pour les scans et pour
 *      les corrections ; la plus ancienne des deux.
 * Exemple : scans B (lundi), A (mardi), B (mercredi 9 h), B (mercredi 14 h) → b.k = le scan A
 * de mardi, arrived_at = mercredi 9 h.
 *
 * Valeurs sentinelles, car max() et min() à plusieurs arguments rendent NULL dès qu'un argument
 * est NULL : '' (avant toute clé) quand il n'y a pas d'événement ailleurs, '~' (après toute
 * heure, qui commence par un chiffre) quand il n'y a pas de scan ou pas de correction après
 * b.k. Au moins l'un des deux existe : le dernier événement est forcément après b.k.
 *
 * Choix de forme, mesurés (5 000 objets, 300 000 scans ; rapport de l'étape U0) :
 *   - la vue est la table de départ (FROM item_locations), et tout le calcul est fait dans la
 *     même ligne : les scans de la puce viennent d'être lus par la vue et sont encore en
 *     mémoire. (Avec FROM items LEFT JOIN, SQLite calcule d'abord la vue pour tous les objets,
 *     puis l'heure d'arrivée : environ 40 % plus lent.) MATERIALIZED garde cet ordre de calcul ;
 *     l'appelant rattache ensuite les objets jamais localisés par LEFT JOIN ;
 *   - b est une sous-requête avec LIMIT : SQLite la calcule une fois, puis b.k est relu quatre
 *     fois (sans LIMIT, il pourrait recopier son calcul à chaque usage).
 * Coût par objet : la dernière série de scans au même endroit est parcourue (en général
 * quelques scans : on scanne en arrivant au poste), plus quelques lectures d'index.
 *
 * BORNE (MAX_RUN_SCANS) : la remontée examine au plus les MAX_RUN_SCANS scans les plus
 * récents de la puce. Sans borne, son coût croît sans limite avec la série : une puce posée en
 * permanence sur un lecteur, ou un lecteur compromis qui répète un même UID, ralentirait à
 * chaque affichage la liste, la fiche et le poste, et avec elles tout le serveur (node:sqlite
 * est synchrone, la réception des trames attend aussi). Si aucun des scans examinés n'est
 * ailleurs et qu'il en existe au moins MAX_RUN_SCANS, la limite d'examen tient lieu de départ :
 * arrived_at = heure du plus ancien scan examiné, arrived_at_bounded = 1 (« depuis au moins »).
 * Une correction vers un autre poste plus récente que ce scan redonne un résultat exact.
 * (Une puce qui a exactement MAX_RUN_SCANS scans, tous au même endroit, est aussi marquée :
 * « au moins » reste vrai, et cela évite une lecture de plus.)
 *
 * Mise en forme : le calcul par objet rend une seule valeur texte, « heure|source|borne »
 * (packed), découpée ensuite dans la table locations. Une sous-requête ne rend qu'une valeur ;
 * la découper dans une table matérialisée évite de refaire le calcul pour chaque colonne.
 *
 * @param {string} filter condition SQL CONSTANTE sur l (item_locations) et i (items), écrite
 *   dans le code, jamais construite à partir d'une saisie (paramètres liés par « ? »).
 */
export function withLocations(filter) {
  // Lecture de bas en haut :
  //   x.ek : clé du dernier scan AILLEURS parmi les MAX_RUN_SCANS scans les plus récents de la
  //          puce (w, lus à rebours dans l'index ; la lecture s'arrête au premier trouvé) ;
  //   y.bt : seulement si x.ek est NULL, heure du MAX_RUN_SCANS-ième scan le plus récent
  //          (NULL s'il y en a moins : la série couvre alors tout l'historique, résultat exact) ;
  //   y.ck : clé de la dernière correction vers un autre poste ;
  //   b.k  : la plus récente des clés (x.ek, ou « bt| » qui précède tout événement de l'heure
  //          bt, et y.ck) ; b.bounded : la borne d'examen a servi de départ ;
  //   nxt  : premier scan et première correction après b.k (sentinelle '~' si aucun) ;
  //   packed : « heure d'arrivée|source de l'arrivée|borne ». À heure égale, le scan précède
  //          la correction (ordre de la vue) : l'arrivée est une correction seulement si fc < fs.
  return `WITH located AS MATERIALIZED (
  SELECT l.item_id, l.station_id, l.at, l.source, l.reader_id,
         (SELECT CASE WHEN nxt.fc < nxt.fs THEN nxt.fc || '|manual|' ELSE nxt.fs || '|scan|' END || nxt.bounded
            FROM (SELECT coalesce((SELECT s.received_at
                                     FROM scans s
                                    WHERE s.uid_nfc = i.uid_nfc
                                      AND s.received_at >= substr(b.k, 1, instr(b.k, '|') - 1)
                                      AND s.received_at || '|0|' || printf('%019d', s.id) > b.k
                                    ORDER BY s.received_at, s.id
                                    LIMIT 1), '~') AS fs,
                         coalesce((SELECT c.created_at
                                     FROM location_corrections c
                                    WHERE c.item_id = i.id
                                      AND c.created_at >= substr(b.k, 1, instr(b.k, '|') - 1)
                                      AND c.created_at || '|1|' || printf('%019d', c.id) > b.k
                                    ORDER BY c.created_at, c.id
                                    LIMIT 1), '~') AS fc,
                         b.bounded
                    FROM (SELECT max(coalesce(y.ek, y.bt || '|', ''), coalesce(y.ck, '')) AS k,
                                 CASE WHEN y.ek IS NULL AND y.bt IS NOT NULL AND coalesce(y.ck, '') < y.bt || '|'
                                      THEN 1 ELSE 0 END AS bounded
                            FROM (SELECT x.ek,
                                         CASE WHEN x.ek IS NULL THEN
                                           (SELECT s.received_at
                                              FROM scans s
                                             WHERE s.uid_nfc = i.uid_nfc
                                             ORDER BY s.received_at DESC, s.id DESC
                                             LIMIT 1 OFFSET ${MAX_RUN_SCANS - 1})
                                         END AS bt,
                                         (SELECT c.created_at || '|1|' || printf('%019d', c.id)
                                            FROM location_corrections c
                                           WHERE c.item_id = i.id AND c.station_id IS NOT l.station_id
                                           ORDER BY c.created_at DESC, c.id DESC
                                           LIMIT 1) AS ck
                                    FROM (SELECT (SELECT w.received_at || '|0|' || printf('%019d', w.id)
                                                    FROM (SELECT s.received_at, s.id, s.station_id
                                                            FROM scans s
                                                           WHERE s.uid_nfc = i.uid_nfc
                                                           ORDER BY s.received_at DESC, s.id DESC
                                                           LIMIT ${MAX_RUN_SCANS}) AS w
                                                   WHERE w.station_id IS NOT l.station_id
                                                   ORDER BY w.received_at DESC, w.id DESC
                                                   LIMIT 1) AS ek
                                          LIMIT 1) AS x
                                   LIMIT 1) AS y
                           LIMIT 1) AS b
                   LIMIT 1) AS nxt
         ) AS packed
    FROM item_locations l
    JOIN items i ON i.id = l.item_id
   WHERE ${filter}
),
locations AS (
  SELECT item_id, station_id, at, source, reader_id,
         substr(packed, 1, instr(packed, '|') - 1)                     AS arrived_at,
         CASE WHEN instr(packed, '|manual|') > 0 THEN 'manual' ELSE 'scan' END AS arrival_source,
         CAST(substr(packed, -1) AS INTEGER)                           AS arrived_at_bounded
    FROM located
)
`;
}

// Colonnes de localisation (table « locations » de withLocations, D-006). at NULL = jamais
// localisé ; at = heure du DERNIER événement (scan ou correction) ; arrived_at = heure
// d'arrivée à cet emplacement (affichée « Depuis »), arrived_at_bounded = 1 pour « depuis au
// moins », arrival_source = nature de l'événement d'arrivée ; station_id NULL avec at
// renseigné = scan sur un lecteur non affecté ; source = nature du DERNIER événement, 'scan'
// (reader_id renseigné) ou 'manual' (correction manuelle, migration 004).
const LOCATION_COLUMNS = 'l.at, l.arrived_at, l.arrived_at_bounded, l.arrival_source, l.source, l.reader_id, l.station_id, st.name AS station_name';
const NO_LOCATION = {
  at: null, arrived_at: null, arrived_at_bounded: null, arrival_source: null, source: null, reader_id: null, station_id: null, station_name: null,
};

/**
 * Objets dont le nom contient la saisie (casse et accents ignorés) ou dont l'UID contient le
 * fragment d'UID. Saisie vide : tout l'inventaire. Trié par nom.
 *
 * Une seule requête, sans requête par ligne. La localisation y est calculée une fois pour tous
 * les objets, par lectures d'index (migration 003, withLocations). Le filtre est appliqué en JS sur
 * les lignes chargées : la liste est de toute façon chargée en entier (pas de pagination), la
 * comparaison sans accents est simple à écrire en JS, et aucun motif LIKE n'est construit
 * (ni joker à échapper, ni motif tronqué au caractère NUL).
 */
export function listItems(db, query) {
  const rows = db.prepare(
    `${withLocations('1')}
     SELECT i.id, i.name, i.uid_nfc, ${LOCATION_COLUMNS}
       FROM items i
       LEFT JOIN locations l ON l.item_id = i.id
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
  // Localisation lue à part, filtrée par item_id DANS la clause WITH : seul cet objet est
  // calculé (la table matérialisée n'a qu'une ligne).
  const location = db.prepare(
    `${withLocations('l.item_id = ?')}
     SELECT ${LOCATION_COLUMNS}
       FROM locations l
       LEFT JOIN stations st ON st.id = l.station_id`
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
