// Historique des déplacements d'un objet (étape U3) : la frise de sa fiche et la page
// « Tout l'historique ».
//
// Rien n'est stocké (D-006) : la frise est recalculée à chaque lecture depuis le journal des
// scans, les corrections manuelles et le journal des modifications (audit_log).
//
// TOUTES LES PUCES DE LA FICHE : une fiche peut avoir porté plusieurs puces (remplacement,
// retrait, puis nouvelle puce). Les périodes de possession sont reconstruites à partir
// d'audit_log (item.create avec puce, item.chip_associate, item.chip_detach). Pour chaque
// période, la frise montre :
//   - les scans de cette puce PENDANT la période (début exclu, fin incluse) ;
//   - le dernier scan de la puce AVANT le début de la période : c'est lui qui localise la fiche
//     au moment où elle reçoit la puce (vue item_locations), il doit donc figurer dans la frise.
// Un repère marque chaque changement : « Puce donnée », « Puce changée », « Puce retirée ».
// Fiche dont la puce actuelle n'apparaît dans aucune ligne d'audit (données créées avant
// l'étape 7, ou à la main) : tous les scans de cette puce sont pris, comme le fait la vue.
// La vue item_locations (emplacement actuel) n'est pas modifiée.
//
// On montre les DÉPLACEMENTS : des scans consécutifs au même emplacement forment une seule
// entrée. Une correction manuelle et un repère de puce sont toujours des entrées à part.
// « Lecteur non affecté » (station_id NULL) compte comme un emplacement à part entière (D-016).
//
// Ordre des événements : heure, puis à heure égale scan, correction, repère de puce, puis id ;
// le plus récent en premier. Clé textuelle d'un événement (la même forme que withLocations) :
//   « heure|0|id » scan, « heure|1|id » correction, « heure|2|id » repère (id de la ligne
//   d'audit), id sur 19 chiffres. Elle sert aussi de curseur de pagination (?avant=).
//
// COÛT BORNÉ : chaque source (les scans d'une période, les corrections) est lue au plus
// SCAN_WINDOW lignes à la fois, par les index (scans_by_uid, corrections_by_item ;
// audit_by_entity pour les périodes). Si une source a été coupée par cette borne, seuls les
// événements plus récents que la coupure sont gardés, et la page suivante reprend derrière.
// Les périodes sont parcourues de la plus récente à la plus ancienne ; celles qui finissent
// avant une coupure ne sont pas lues. Le nombre de périodes ne dépend que des changements de
// puce faits à la main.
// Toutes les requêtes sont paramétrées.

import { MAX_RUN_SCANS } from './inventory.js';
import { ACTIONS } from './items.js';

// Déplacements affichés sur la fiche (au-delà : « Voir tout l'historique »).
export const TIMELINE_ENTRIES = 30;
// Déplacements par page de « Tout l'historique ».
export const TIMELINE_PAGE_ENTRIES = 50;
// Lignes lues au plus par source et par affichage : même borne que « Depuis » (D-016).
export const SCAN_WINDOW = MAX_RUN_SCANS;

// Curseur ?avant= : clé d'événement au format exact produit par eventKey. L'heure suit le format
// ISO 8601 UTC du serveur (toISOString) ; l'id a 16 chiffres au plus (entier JavaScript exact).
// Tout le reste est refusé (null) : la page répond 404.
const CURSOR_FORMAT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([012])\|(\d{19})$/;
const MAX_ID_DIGITS = 16;
// Heure plus récente que toute heure réelle (qui commence par un chiffre) ; '' : plus ancienne.
const AFTER_ALL = '~';

/** Clé d'ordre d'un événement (voir l'en-tête). */
function eventKey(at, kind, id) {
  return `${at}|${kind}|${String(id).padStart(19, '0')}`;
}

/** Texte du paramètre ?avant= → {at, kind, id}, ou null s'il n'a pas le format exact. */
export function parseCursor(text) {
  const match = typeof text === 'string' ? CURSOR_FORMAT.exec(text) : null;
  if (!match) return null;
  const digits = match[3].replace(/^0+(?=.)/, '');
  if (digits.length > MAX_ID_DIGITS) return null;
  return { at: match[1], kind: Number(match[2]), id: Number(digits) };
}

// Sans curseur : tout est « avant ».
const NO_CURSOR = { at: AFTER_ALL, kind: 2, id: Number.MAX_SAFE_INTEGER };

/**
 * Périodes de possession des puces de la fiche, et repères de changement, d'après audit_log
 * (index audit_by_entity ; un numéro de fiche n'est jamais réutilisé, D-014).
 * @returns {{periods: {uid: string, start: string, end: string}[], marks: object[]}}
 *   start : heure de l'attribution ('' : depuis toujours) ; end : heure du détachement
 *   (AFTER_ALL : puce actuelle). marks : {type: 'chip', change: 'donnee'|'changee'|'retiree',
 *   at, id, username, uid, previous}.
 */
function chipPeriods(db, item) {
  const rows = db.prepare(
    `SELECT a.id, a.at, a.action, a.details, u.username
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_id = ? AND a.action IN (?, ?, ?)
      ORDER BY a.id`
  ).all(item.id, ACTIONS.create, ACTIONS.chipAssociate, ACTIONS.chipDetach);
  const periods = [];
  const marks = [];
  let open = null;
  const close = (at) => {
    if (open) open.end = at;
    open = null;
  };
  for (const row of rows) {
    let details;
    try {
      details = JSON.parse(row.details) ?? {};
    } catch {
      details = {};
    }
    const uid = typeof details.uid === 'string' ? details.uid : null;
    if (row.action === ACTIONS.create) {
      if (uid !== null) periods.push(open = { uid, start: row.at, end: AFTER_ALL });
    } else if (row.action === ACTIONS.chipAssociate) {
      if (uid === null) continue;
      const previous = typeof details.previous_uid === 'string' ? details.previous_uid : null;
      close(row.at);
      periods.push(open = { uid, start: row.at, end: AFTER_ALL });
      marks.push({ type: 'chip', change: previous === null ? 'donnee' : 'changee', at: row.at, id: row.id, username: row.username, uid, previous });
    } else {
      close(row.at);
      const previous = typeof details.previous_uid === 'string' ? details.previous_uid : null;
      marks.push({ type: 'chip', change: 'retiree', at: row.at, id: row.id, username: row.username, uid: null, previous });
    }
  }
  // Puce actuelle sans trace dans l'audit : tous ses scans (comme la vue item_locations).
  if (item.uid_nfc !== null && (open === null || open.uid !== item.uid_nfc)) {
    close(AFTER_ALL);
    periods.push({ uid: item.uid_nfc, start: '', end: AFTER_ALL });
  }
  return { periods, marks };
}

/**
 * Événements antérieurs au curseur, du plus récent au plus ancien, et si une borne a coupé.
 * reader_name : nom ACTUEL du lecteur (D-019, '' sans nom) ; station_name : nom actuel du poste
 * figé au moment de l'événement.
 */
function readEvents(db, item, cursor) {
  const c = cursor ?? NO_CURSOR;
  const { periods, marks } = chipPeriods(db, item);
  // Scans d'une puce « avant » le curseur, dans (lo, hi] : heure plus ancienne que le curseur,
  // ou même heure et (curseur sur une correction ou un repère, ou id plus petit).
  const scansOf = db.prepare(
    `SELECT s.id, s.received_at AS at, s.station_id, st.name AS station_name, s.reader_id, r.name AS reader_name, s.uid_nfc AS uid
       FROM scans s
       JOIN readers r ON r.id = s.reader_id
       LEFT JOIN stations st ON st.id = s.station_id
      WHERE s.uid_nfc = ?
        AND s.received_at > ? AND s.received_at <= ?
        AND s.received_at <= ?
        AND (s.received_at < ? OR ? >= 1 OR s.id < ?)
      ORDER BY s.received_at DESC, s.id DESC
      LIMIT ?`
  );
  // Corrections « avant » le curseur : heure plus ancienne, ou même heure et (curseur sur un
  // repère, ou sur une correction d'id plus grand).
  const corrections = db.prepare(
    `SELECT c.id, c.created_at AS at, c.station_id, st.name AS station_name, u.username
       FROM location_corrections c
       LEFT JOIN stations st ON st.id = c.station_id
       LEFT JOIN users u ON u.id = c.user_id
      WHERE c.item_id = ?
        AND c.created_at <= ?
        AND (c.created_at < ? OR ? = 2 OR (? = 1 AND c.id < ?))
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ?`
  ).all(item.id, c.at, c.at, c.kind, c.kind, c.id, SCAN_WINDOW + 1);

  const cursorKey = eventKey(c.at, c.kind, c.id);
  let boundary = '';
  const events = [];
  const add = (rows, kind, limit) => {
    const cut = rows.length > limit;
    const kept = cut ? rows.slice(0, limit) : rows;
    for (const row of kept) events.push({ ...row, kind, key: eventKey(row.at, kind, row.id) });
    if (cut) {
      const last = kept[kept.length - 1];
      const key = eventKey(last.at, kind, last.id);
      if (key > boundary) boundary = key;
    }
  };
  add(corrections, 1, SCAN_WINDOW);
  for (const mark of marks) {
    const key = eventKey(mark.at, 2, mark.id);
    if (key < cursorKey) events.push({ ...mark, kind: 2, key });
  }
  // Périodes, de la plus récente à la plus ancienne. Une période qui finit avant la coupure
  // n'apporterait que des événements écartés : elle n'est pas lue.
  // Les scans de toutes les périodes partagent la même borne SCAN_WINDOW : une fiche aux
  // nombreuses puces ne lit pas SCAN_WINDOW lignes par puce.
  let budget = SCAN_WINDOW;
  for (const period of [...periods].reverse()) {
    if (boundary !== '' && period.end !== AFTER_ALL && period.end < boundary.slice(0, boundary.indexOf('|'))) continue;
    if (budget === 0) {
      // Borne atteinte pile à la fin d'une période : coupure au plus ancien scan déjà lu.
      const oldest = events.filter((event) => event.kind === 0).reduce((min, event) => (event.key < min ? event.key : min), AFTER_ALL);
      if (oldest > boundary) boundary = oldest;
      break;
    }
    const rows = scansOf.all(period.uid, period.start, period.end, c.at, c.at, c.kind, c.id, budget + 1);
    add(rows, 0, budget);
    budget -= Math.min(rows.length, budget);
    if (period.start !== '') {
      // Dernier scan de la puce avant son attribution (il localise la fiche à ce moment-là).
      add(scansOf.all(period.uid, '', period.start, c.at, c.at, c.kind, c.id, 1), 0, 1);
    }
  }
  // Un même scan peut être pris deux fois (dernier scan avant une période, déjà dans la période
  // précédente de la même puce) : clés uniques.
  const unique = [...new Map(events.map((event) => [event.key, event])).values()];
  unique.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return { events: boundary === '' ? unique : unique.filter((event) => event.key >= boundary), truncated: boundary !== '' };
}

/**
 * Regroupe les événements (du plus récent au plus ancien) en entrées, au plus `max` :
 *   {type: 'scan', station_id, station_name, reader_id, reader_name, uid, arrived_at, last_at,
 *    count, bounded, oldestKey} — arrivée = scan le plus ancien de la série (lecteur de ce scan) ;
 *   {type: 'correction', at, station_id, station_name, username, oldestKey} ;
 *   {type: 'chip', change, at, username, uid, previous, oldestKey} (repère de puce).
 */
function groupEvents(events, max) {
  const groups = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (event.kind === 0 && last?.type === 'scan' && last.station_id === event.station_id && last.uid === event.uid) {
      last.arrived_at = event.at;
      last.reader_id = event.reader_id;
      last.reader_name = event.reader_name;
      last.count++;
      last.oldestKey = event.key;
      continue;
    }
    if (groups.length === max) break;
    if (event.kind === 0) {
      groups.push({
        type: 'scan', station_id: event.station_id, station_name: event.station_name, reader_id: event.reader_id,
        reader_name: event.reader_name, uid: event.uid, arrived_at: event.at, last_at: event.at, count: 1, bounded: false, oldestKey: event.key,
      });
    } else if (event.kind === 1) {
      groups.push({
        type: 'correction', at: event.at, station_id: event.station_id, station_name: event.station_name,
        username: event.username, oldestKey: event.key,
      });
    } else {
      groups.push({
        type: 'chip', change: event.change, at: event.at, username: event.username, uid: event.uid, previous: event.previous, oldestKey: event.key,
      });
    }
  }
  return groups;
}

/**
 * Création de la fiche, pour le bas de la frise : {type: 'creation', at, username, known}.
 * known : une ligne d'audit item.create existe (sinon, fiche importée : auteur inconnu) ;
 * username null avec known : créée en ligne de commande. Index audit_by_entity.
 */
function creationEntry(db, item) {
  const row = db.prepare(
    `SELECT u.username
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_id = ? AND a.action = ?
      ORDER BY a.id
      LIMIT 1`
  ).get(item.id, ACTIONS.create);
  return { type: 'creation', at: item.created_at, username: row?.username ?? null, known: row !== undefined };
}

/**
 * Marque (current: true) l'entrée qui donne l'emplacement actuel de la fiche (vue
 * item_locations) : sa dernière correction si la source est manuelle, sinon le dernier scan de
 * sa puce actuelle. Seulement sur la première page (sans curseur).
 */
function markCurrent(entries, item) {
  let current;
  if (item.source === 'manual') current = entries.find((entry) => entry.type === 'correction');
  else if (item.source === 'scan') current = entries.find((entry) => entry.type === 'scan' && entry.uid === item.uid_nfc);
  if (current) current.current = true;
}

/**
 * Déplacements d'un objet, du plus récent au plus ancien, au plus `limit`, à partir du curseur
 * (null : depuis le plus récent).
 * @param {{id: number|bigint, uid_nfc: string|null, created_at: string, source?: string|null}} item
 *   fiche lue par getItem (source : nature de l'événement qui donne l'emplacement actuel).
 * @returns {{entries: object[], next: string|null}}
 *   entries : entrées (groupEvents), puis l'entrée de création quand l'historique est complet ;
 *   next : curseur de la page suivante, ou null s'il n'y en a pas.
 */
export function itemTimeline(db, item, { cursor = null, limit = TIMELINE_ENTRIES } = {}) {
  const { events, truncated } = readEvents(db, item, cursor);
  const groups = groupEvents(events, limit + 1);
  let result;
  if (groups.length > limit) {
    // Il reste au moins une entrée : la dernière affichée est complète (une autre la suit).
    const entries = groups.slice(0, limit);
    result = { entries, next: entries[entries.length - 1].oldestKey };
  } else if (truncated) {
    // La borne a coupé : la dernière entrée lue peut continuer au-delà. S'il en reste d'autres,
    // elle est laissée à la page suivante ; si elle est seule (une très longue série au même
    // endroit), elle est affichée avec « au moins ».
    if (groups.length > 1) groups.pop();
    else if (groups[0].type === 'scan') groups[0].bounded = true;
    result = { entries: groups, next: groups[groups.length - 1].oldestKey };
  } else {
    result = { entries: [...groups, creationEntry(db, item)], next: null };
  }
  if (cursor === null) markCurrent(result.entries, item);
  return result;
}
