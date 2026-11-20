// Puces inconnues et association (étape 7), logique métier sans HTTP :
// - liste des puces inconnues (poste et heure du dernier scan, nombre de scans, ordre) ;
// - création d'une fiche depuis une puce : localisation immédiate, puce retirée de la liste,
//   audit avec l'UID ;
// - association à une fiche existante, avec ou sans puce : ancienne puce détachée et tracée
//   (previous_uid), qui réapparaît dans la liste ; un scan ultérieur de l'ancienne puce ne
//   déplace plus la fiche ;
// - correction manuelle plus récente que le dernier scan : garde la priorité (vue) ;
// - journal des scans strictement inchangé ; refus sans écriture (jamais scanné, déjà connu,
//   fiche absente, fiche changée de puce) ; atomicité écriture + audit ;
// - format d'UID dans l'adresse ; libellés d'historique ; plan de requête sans parcours du journal.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { getItem, parseUid } from '../server/inventory.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import { createItem, correctLocation, itemHistory, auditLabel, validateItemInput } from '../server/items.js';
import {
  listUnknownChips, getChip, chipPreviousOwner, createItemForChip, associateChip, MAX_UNKNOWN_CHIPS,
} from '../server/chips.js';
import { deleteItem } from '../server/items.js';

const T0 = '2026-11-19T08:00:00.000Z';
const T1 = '2026-11-19T09:00:00.000Z';
const T2 = '2026-11-19T10:00:00.000Z';
const T3 = '2026-11-19T11:00:00.000Z';
const T4 = '2026-11-19T12:00:00.000Z';
const KEY = Buffer.alloc(32, 0x42);
const KNOWN = '04A1B2C3D4E5F6';
const NEW = '04B7C8D9EAFB0C';
const OTHER = 'DEADBEEF';

let db, alice;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?), (2, 'Labo', ?)").run(T0, T0);
  // Lecteur 1 à l'Atelier, lecteur 2 au Labo, lecteur 3 non affecté.
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?)')
    .run(KEY, T0, KEY, T0, KEY, T0);
  alice = Number(db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('alice', 'x', ?)").run(T0).lastInsertRowid);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?), (2, NULL, 'Oscilloscope', ?, ?)")
    .run(KNOWN, T0, T0, T0, T0);
});

afterEach(() => db.close());

const counters = { 1: 0, 2: 0, 3: 0 };
const scanAt = (readerId, uid, at) => {
  const result = ingestFrame(db, encodeFrame({ readerId, counter: ++counters[readerId], uid: Buffer.from(uid, 'hex'), key: KEY }), at);
  assert.equal(result.ok, true);
};
const valid = (fields) => {
  const result = validateItemInput(fields);
  assert.equal(result.ok, true);
  return result.item;
};
const scansDump = () => JSON.stringify(db.prepare('SELECT * FROM scans ORDER BY id').all());
const auditRows = () => db.prepare('SELECT at, user_id, action, entity_id, details FROM audit_log ORDER BY id').all()
  .map((r) => ({ ...r, details: JSON.parse(r.details) }));
const location = (id) => {
  const item = getItem(db, id);
  return { station_id: item.station_id, at: item.at, source: item.source, reader_id: item.reader_id };
};
const unknownUids = () => listUnknownChips(db).chips.map((chip) => chip.uid);
// État complet des tables qu'une écriture refusée ne doit pas toucher.
const snapshot = () => JSON.stringify(['items', 'audit_log', 'scans', 'location_corrections']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

// ---------------------------------------------------------------- format de l'UID dans l'adresse

test('parseUid : 8, 14 ou 20 caractères hexadécimaux majuscules ; tout le reste refusé, sans normalisation', () => {
  for (const uid of ['DEADBEEF', KNOWN, '0123456789ABCDEF0123']) assert.equal(parseUid(uid), uid);
  const refused = [
    '', 'deadbeef', 'DeadBeef', '04a1b2c3d4e5f6', 'DEADBEE', 'DEADBEEF0', '04A1B2C3D4E5F', '04A1B2C3D4E5F6A',
    '0123456789ABCDEF012', '0123456789ABCDEF01234', 'DEADBEEG', 'DEAD BEEF', 'DE:AD:BE:EF', 'DE-AD-BE-EF',
    '%44EADBEEF', 'DEADBEE%46', '%44%45%41%44%42%45%45%46', 'DEADBEEF%00', 'DEADBEEF\n', ' DEADBEEF',
    '0xDEADBEEF', String.fromCodePoint(0xFF24) + 'EADBEEF', // D pleine chasse
    null, undefined, 123,
  ];
  for (const text of refused) assert.equal(parseUid(text), null, JSON.stringify(text));
});

// ---------------------------------------------------------------- liste

test('liste : puce inconnue avec poste et heure du dernier scan, nombre de scans ; puce connue absente', () => {
  assert.deepEqual(listUnknownChips(db), { chips: [], more: false });
  scanAt(1, NEW, T1);
  scanAt(2, NEW, T2); // dernier scan : Labo
  scanAt(1, KNOWN, T3); // puce connue : jamais listée
  assert.deepEqual(listUnknownChips(db).chips, [
    { uid: NEW, scan_count: 2, received_at: T2, reader_id: 2, station_id: 2, station_name: 'Labo' },
  ]);
});

test('liste : la plus récemment vue en premier ; lecteur non affecté : poste null, lecteur indiqué', () => {
  scanAt(1, NEW, T1);
  scanAt(3, OTHER, T2);
  assert.deepEqual(unknownUids(), [OTHER, NEW]);
  const [other] = listUnknownChips(db).chips;
  assert.equal(other.station_id, null);
  assert.equal(other.station_name, null);
  assert.equal(other.reader_id, 3);
  scanAt(2, NEW, T3);
  assert.deepEqual(unknownUids(), [NEW, OTHER]);
});

test('liste : même heure à la milliseconde → départage par le dernier reçu, comme la vue de localisation', () => {
  scanAt(1, NEW, T1);
  scanAt(2, NEW, T1);
  assert.equal(listUnknownChips(db).chips[0].station_id, 2);
  assert.equal(getChip(db, NEW).station_id, 2);
});

test('getChip : puce inconnue, puce connue (fiche indiquée), puce jamais scannée (null)', () => {
  scanAt(1, NEW, T1);
  scanAt(1, KNOWN, T1);
  assert.deepEqual(getChip(db, NEW), {
    uid: NEW, scan_count: 1, received_at: T1, reader_id: 1, station_id: 1, station_name: 'Atelier', item_id: null,
  });
  assert.equal(getChip(db, KNOWN).item_id, 1);
  assert.equal(getChip(db, OTHER), null);
});

// ---------------------------------------------------------------- créer une fiche

test('créer une fiche depuis une puce : localisée immédiatement au poste du scan, retirée de la liste, audit avec l\'UID', () => {
  scanAt(2, NEW, T1);
  const scans = scansDump();
  const outcome = createItemForChip(db, alice, NEW, valid({ name: 'Étuve', notes: 'n', keys: ['Marque'], values: ['Memmert'] }), T2);
  const id = outcome.id;
  assert.ok(id > 2);
  assert.equal(db.prepare('SELECT uid_nfc FROM items WHERE id = ?').get(id).uid_nfc, NEW);
  assert.deepEqual(location(id), { station_id: 2, at: T1, source: 'scan', reader_id: 2 });
  assert.deepEqual(unknownUids(), []);
  assert.deepEqual(auditRows().at(-1), {
    at: T2, user_id: alice, action: 'item.create', entity_id: id,
    details: { name: 'Étuve', properties: { Marque: 'Memmert' }, notes: 'n', uid: NEW },
  });
  assert.deepEqual(itemHistory(db, id).map((h) => h.label), [['Fiche créée avec la puce ', { uid: NEW }]]);
  assert.equal(scansDump(), scans, 'journal des scans inchangé');
});

test('créer une fiche : puce jamais scannée ou déjà associée → refus, aucune écriture', () => {
  scanAt(1, KNOWN, T1);
  const before = snapshot();
  assert.equal(createItemForChip(db, alice, OTHER, valid({ name: 'x' }), T2), 'never_scanned');
  assert.deepEqual(createItemForChip(db, alice, KNOWN, valid({ name: 'x' }), T2), { known: 1 });
  assert.equal(snapshot(), before);
});

test('une fiche créée normalement (étape 5) garde un audit sans UID', () => {
  const id = createItem(db, alice, valid({ name: 'Sans puce' }), T1);
  assert.deepEqual(auditRows().at(-1).details, { name: 'Sans puce', properties: {}, notes: '' });
  assert.equal(db.prepare('SELECT uid_nfc FROM items WHERE id = ?').get(id).uid_nfc, null);
});

// ---------------------------------------------------------------- associer

test('associer à une fiche sans puce : même résultat que la création (localisation, liste, audit), journal inchangé', () => {
  scanAt(1, NEW, T1);
  const scans = scansDump();
  assert.deepEqual(location(2), { station_id: null, at: null, source: null, reader_id: null });
  assert.deepEqual(associateChip(db, alice, NEW, 2, '', T2), { id: 2, previousUid: null });
  const row = db.prepare('SELECT uid_nfc, updated_at FROM items WHERE id = 2').get();
  assert.deepEqual({ ...row }, { uid_nfc: NEW, updated_at: T2 });
  assert.deepEqual(location(2), { station_id: 1, at: T1, source: 'scan', reader_id: 1 });
  assert.deepEqual(unknownUids(), []);
  assert.deepEqual(auditRows().at(-1), {
    at: T2, user_id: alice, action: 'item.chip_associate', entity_id: 2,
    details: { uid: NEW, previous_uid: null, name: 'Oscilloscope' },
  });
  assert.deepEqual(itemHistory(db, 2).map((h) => h.label), [['Puce associée : ', { uid: NEW }]]);
  assert.equal(scansDump(), scans);
});

test('remplacer la puce d\'une fiche : ancienne puce détachée, tracée (previous_uid), de retour dans la liste ; la fiche suit la nouvelle', () => {
  scanAt(1, KNOWN, T1); // l'ancienne puce a des scans (Atelier)
  scanAt(2, NEW, T2); // la nouvelle est vue au Labo
  assert.deepEqual(unknownUids(), [NEW]);
  const scansBefore = db.prepare('SELECT count(*) AS n FROM scans').get().n;
  const scans = scansDump();

  assert.deepEqual(associateChip(db, alice, NEW, 1, KNOWN, T3), { id: 1, previousUid: KNOWN });
  assert.deepEqual(auditRows().at(-1).details, { uid: NEW, previous_uid: KNOWN, name: 'Multimètre' });
  assert.deepEqual(itemHistory(db, 1).map((h) => h.label), [['Puce associée : ', { uid: NEW }, ' (remplace ', { uid: KNOWN }, ')']]);
  // La fiche est localisée par la nouvelle puce ; l'ancienne est redevenue inconnue.
  assert.deepEqual(location(1), { station_id: 2, at: T2, source: 'scan', reader_id: 2 });
  assert.deepEqual(listUnknownChips(db).chips, [
    { uid: KNOWN, scan_count: 1, received_at: T1, reader_id: 1, station_id: 1, station_name: 'Atelier' },
  ]);
  // Journal des scans : même nombre, même contenu.
  assert.equal(db.prepare('SELECT count(*) AS n FROM scans').get().n, scansBefore);
  assert.equal(scansDump(), scans);

  // Un scan ultérieur de l'ancienne puce ne déplace plus la fiche.
  scanAt(1, KNOWN, T4);
  assert.deepEqual(location(1), { station_id: 2, at: T2, source: 'scan', reader_id: 2 });
  assert.equal(listUnknownChips(db).chips[0].scan_count, 2);
  // Un scan de la nouvelle puce, si.
  scanAt(1, NEW, T4);
  assert.equal(location(1).station_id, 1);
});

test('ancienne puce jamais scannée : détachée et tracée, mais absente de la liste (aucun scan)', () => {
  scanAt(2, NEW, T1);
  assert.deepEqual(associateChip(db, alice, NEW, 1, KNOWN, T2), { id: 1, previousUid: KNOWN });
  assert.equal(auditRows().at(-1).details.previous_uid, KNOWN);
  assert.deepEqual(unknownUids(), []);
});

test('correction manuelle plus récente que le dernier scan de la puce : garde la priorité après association', () => {
  scanAt(1, NEW, T1); // puce vue à l'Atelier à T1
  assert.equal(correctLocation(db, alice, 2, 2, T2), 'ok'); // fiche corrigée au Labo à T2 > T1
  associateChip(db, alice, NEW, 2, '', T3);
  assert.deepEqual(location(2), { station_id: 2, at: T2, source: 'manual', reader_id: null });
  // Le prochain scan de la puce reprend la main.
  scanAt(1, NEW, T4);
  assert.deepEqual(location(2), { station_id: 1, at: T4, source: 'scan', reader_id: 1 });
});

test('correction manuelle plus ancienne que le dernier scan : le scan de la puce associée l\'emporte', () => {
  assert.equal(correctLocation(db, alice, 2, 2, T1), 'ok');
  scanAt(1, NEW, T2);
  associateChip(db, alice, NEW, 2, '', T3);
  assert.deepEqual(location(2), { station_id: 1, at: T2, source: 'scan', reader_id: 1 });
});

test('associer : refus sans écriture (jamais scannée, déjà connue, fiche absente, fiche changée de puce, champ absent)', () => {
  scanAt(1, NEW, T1);
  scanAt(1, KNOWN, T1);
  const before = snapshot();
  assert.equal(associateChip(db, alice, OTHER, 2, '', T2), 'never_scanned');
  assert.deepEqual(associateChip(db, alice, KNOWN, 2, '', T2), { known: 1 });
  assert.equal(associateChip(db, alice, NEW, 99, '', T2), 'no_item');
  // La page de confirmation montrait « aucune puce » alors que la fiche 1 en porte une, et
  // inversement : rien n'est détaché sans avertissement.
  assert.deepEqual(associateChip(db, alice, NEW, 1, '', T2), { changed: true });
  assert.deepEqual(associateChip(db, alice, NEW, 2, KNOWN, T2), { changed: true });
  assert.deepEqual(associateChip(db, alice, NEW, 1, null, T2), { changed: true });
  assert.equal(snapshot(), before);
});

test('deux associations successives du même UID : la seconde est refusée (déjà connue), sans écriture', () => {
  scanAt(1, NEW, T1);
  db.prepare("INSERT INTO items (id, name, created_at, updated_at) VALUES (3, 'Pince', ?, ?)").run(T0, T0);
  assert.deepEqual(associateChip(db, alice, NEW, 2, '', T2), { id: 2, previousUid: null });
  const before = snapshot();
  assert.deepEqual(associateChip(db, alice, NEW, 3, '', T2), { known: 2 });
  assert.deepEqual(createItemForChip(db, alice, NEW, valid({ name: 'x' }), T2), { known: 2 });
  assert.equal(snapshot(), before);
});

test('atomicité : si l\'audit échoue, l\'association et la création sont annulées', () => {
  scanAt(1, NEW, T1);
  db.exec("CREATE TEMP TRIGGER casse_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit en panne'); END");
  const before = snapshot();
  assert.throws(() => associateChip(db, alice, NEW, 2, '', T2), /audit en panne/);
  assert.throws(() => createItemForChip(db, alice, NEW, valid({ name: 'x' }), T2), /audit en panne/);
  assert.equal(snapshot(), before);
  assert.equal(db.isTransaction, false);
});

test('suppression d\'une fiche : sa puce redevient inconnue (scans conservés)', () => {
  scanAt(1, KNOWN, T1);
  assert.deepEqual(unknownUids(), []);
  db.prepare('DELETE FROM items WHERE id = 1').run();
  assert.deepEqual(unknownUids(), [KNOWN]);
});

// ---------------------------------------------------------------- plafond de la liste

test('liste plafonnée : les plus récentes seulement, more indique qu\'il en reste ; nombre de scans exact', () => {
  assert.equal(MAX_UNKNOWN_CHIPS, 200);
  const uids = ['0A000001', '0A000002', '0A000003', '0A000004', '0A000005'];
  uids.forEach((uid, i) => scanAt(1, uid, `2026-11-19T08:0${i}:00.000Z`));
  scanAt(2, '0A000001', '2026-11-19T07:00:00.000Z'); // scan plus ancien : ne change pas l'ordre
  const top = listUnknownChips(db, 3);
  assert.deepEqual(top.chips.map((c) => c.uid), ['0A000005', '0A000004', '0A000003']);
  assert.equal(top.more, true);
  assert.deepEqual(listUnknownChips(db, 5).chips.map((c) => c.uid), [...uids].reverse());
  assert.equal(listUnknownChips(db, 5).more, false);
  assert.equal(listUnknownChips(db, 5).chips.at(-1).scan_count, 2);
  assert.equal(listUnknownChips(db, 6).more, false);
});

// ---------------------------------------------------------------- réutilisation d'une puce

test('ancien propriétaire : puce jamais associée → null', () => {
  scanAt(1, NEW, T1);
  assert.equal(chipPreviousOwner(db, NEW), null);
  createItem(db, alice, valid({ name: 'Sans puce' }), T2); // audit item.create sans UID
  assert.equal(chipPreviousOwner(db, NEW), null);
});

test('ancien propriétaire : fiche supprimée qui portait la puce → nom, numéro, heure, fiche disparue', () => {
  scanAt(1, KNOWN, T1);
  assert.equal(deleteItem(db, alice, 1, T2), true);
  assert.deepEqual(chipPreviousOwner(db, KNOWN), { itemId: 1, name: 'Multimètre', until: T2, exists: false });
});

test('ancien propriétaire : puce remplacée sur sa fiche → fiche toujours existante ; la plus récente l\'emporte', () => {
  scanAt(1, KNOWN, T1);
  scanAt(1, NEW, T1);
  associateChip(db, alice, NEW, 1, KNOWN, T2); // KNOWN quitte la fiche 1
  assert.deepEqual(chipPreviousOwner(db, KNOWN), { itemId: 1, name: 'Multimètre', until: T2, exists: true });
  // Réutilisée sur la fiche 2, puis la fiche 2 est supprimée : c'est elle qui est citée.
  associateChip(db, alice, KNOWN, 2, '', T3);
  deleteItem(db, alice, 2, T4);
  assert.deepEqual(chipPreviousOwner(db, KNOWN), { itemId: 2, name: 'Oscilloscope', until: T4, exists: false });
  // Une autre puce, jamais détachée, reste sans ancien propriétaire.
  assert.equal(chipPreviousOwner(db, OTHER), null);
});

test('ancien propriétaire : détails d\'audit inattendus (nom absent, valeur non textuelle) sans erreur', () => {
  db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, NULL, 'item.delete', 77, ?)")
    .run(T1, JSON.stringify({ uid_nfc: OTHER, name: 5 }));
  assert.deepEqual(chipPreviousOwner(db, OTHER), { itemId: 77, name: null, until: T1, exists: false });
  // Le même UID dans un autre champ ou une autre action n'est pas pris en compte.
  db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, NULL, 'item.update', 1, ?)")
    .run(T2, JSON.stringify({ uid_nfc: NEW, previous_uid: NEW }));
  db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, NULL, 'item.chip_associate', 1, ?)")
    .run(T2, JSON.stringify({ uid: NEW, previous_uid: null }));
  assert.equal(chipPreviousOwner(db, NEW), null);
});

// ---------------------------------------------------------------- libellés

test('auditLabel : association et création avec puce ; valeurs hors format jamais affichées', () => {
  assert.deepEqual(auditLabel('item.chip_associate', JSON.stringify({ uid: NEW, previous_uid: null })), ['Puce associée : ', { uid: NEW }]);
  assert.deepEqual(auditLabel('item.chip_associate', JSON.stringify({ uid: NEW, previous_uid: KNOWN })), ['Puce associée : ', { uid: NEW }, ' (remplace ', { uid: KNOWN }, ')']);
  assert.equal(auditLabel('item.chip_associate', '{}'), 'Puce associée');
  assert.equal(auditLabel('item.chip_associate', 'pas du json'), 'Puce associée');
  assert.equal(auditLabel('item.chip_associate', JSON.stringify({ uid: '<b>x</b>', previous_uid: 5 })), 'Puce associée');
  assert.deepEqual(auditLabel('item.chip_associate', JSON.stringify({ uid: NEW, previous_uid: 'texte' })), ['Puce associée : ', { uid: NEW }]);
  assert.deepEqual(auditLabel('item.create', JSON.stringify({ uid: NEW })), ['Fiche créée avec la puce ', { uid: NEW }]);
  assert.equal(auditLabel('item.create', JSON.stringify({ uid: 'abc' })), 'Fiche créée');
  assert.equal(auditLabel('item.create', '{}'), 'Fiche créée');
});

// ---------------------------------------------------------------- plan de requête

test('plans : la liste et la fiche d\'une puce lisent le journal par l\'index scans_by_uid, sans le parcourir', () => {
  for (let i = 0; i < 50; i++) scanAt(1 + (i % 3), i % 2 ? NEW : (0x10000000 + i).toString(16).toUpperCase(), T1);
  for (const sql of [listQuery(), chipQuery()]) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split('?').length - 1).fill(NEW)).map((r) => r.detail);
    assert.ok(plan.some((d) => /USING COVERING INDEX scans_by_uid/.test(d)), plan.join('\n'));
    assert.ok(!plan.some((d) => /SCAN (s|s2|c|scans)\b/.test(d)), plan.join('\n'));
  }
});

// Requêtes réellement préparées par listUnknownChips et getChip (capturées, pas recopiées).
function captured(fn) {
  let sql;
  fn({ prepare: (text) => { sql = text; return db.prepare(text); } });
  return sql;
}
const listQuery = () => captured((spy) => listUnknownChips(spy));
const chipQuery = () => captured((spy) => getChip(spy, NEW));
