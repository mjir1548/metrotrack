// Lecteurs (étape 6), logique métier sans HTTP : création (identifiant MAX+1, clé de 32 octets
// aléatoires), affectation, désactivation définitive, remplacement de clé (nouveau lecteur,
// ancien désactivé), journal audit_log SANS la clé, plage d'identifiants uint32 épuisée,
// historique figé quand un lecteur change de poste, lectures sans la clé, plans d'index.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import {
  createReader, assignReader, deactivateReader, replaceReader, listReaders, getReader, readerScans, MAX_READER_ID,
  renameReader, validateReaderName, MAX_READER_NAME_CHARS,
} from '../server/readers.js';
import { MAX_STATION_NAME_CHARS } from '../server/stations.js';
import { readerLabel } from '../server/views.js';

const T0 = '2026-11-18T10:00:00.000Z';
const T1 = '2026-11-18T11:00:00.000Z';
const UID = '04A1B2C3D4E5F6';
let db, alice;

beforeEach(() => {
  db = openDb(':memory:');
  alice = Number(db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('alice', 'x', ?)").run(T0).lastInsertRowid);
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Banc 1', ?), (2, 'Banc 2', ?)").run(T0, T0);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, T0, T0);
});
afterEach(() => db.close());

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const lastAudit = () => {
  const row = db.prepare('SELECT at, user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return { ...row, details: JSON.parse(row.details) };
};
const frame = (readerId, counter, key, uid = UID) => encodeFrame({ readerId, counter, uid: Buffer.from(uid, 'hex'), key });
const storedKey = (id) => Buffer.from(db.prepare('SELECT aead_key FROM readers WHERE id = ?').get(id).aead_key);
const state = () => JSON.stringify(['readers', 'audit_log', 'scans'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

/** Vrai si la clé (octets bruts, hexadécimal minuscule ou majuscule) apparaît dans le texte ou les octets donnés. */
function containsKey(haystack, key) {
  const bytes = Buffer.isBuffer(haystack) ? haystack : Buffer.from(String(haystack));
  const text = bytes.toString('latin1').toLowerCase();
  return bytes.includes(key) || text.includes(key.toString('hex'));
}

test('création : identifiant MAX(id)+1 (1 sur une base vide), clé de 32 octets stockée, poste facultatif, audit sans la clé', () => {
  const first = createReader(db, alice, 1n, T0);
  assert.equal(first.id, 1);
  assert.ok(Buffer.isBuffer(first.key) && first.key.length === 32);
  assert.deepEqual(first.station, { id: 1, name: 'Banc 1' });
  assert.ok(storedKey(1).equals(first.key));
  assert.deepEqual(lastAudit(), { at: T0, user_id: alice, action: 'reader.create', entity_id: 1, details: { id: 1, name: '', station: { id: 1, name: 'Banc 1' } } });

  db.prepare('INSERT INTO readers (id, aead_key, created_at) VALUES (41, ?, ?)').run(Buffer.alloc(32, 1), T0);
  const second = createReader(db, alice, null, T0);
  assert.equal(second.id, 42);
  assert.equal(second.station, null);
  assert.equal(getReader(db, 42).station_id, null);
  assert.deepEqual(lastAudit().details, { id: 42, name: '', station: null });
  assert.ok(!second.key.equals(first.key), 'clés distinctes');
  for (const row of db.prepare('SELECT details FROM audit_log').all()) {
    assert.ok(!containsKey(row.details, first.key) && !containsKey(row.details, second.key));
  }
});

test('création : clés issues du CSPRNG, toutes distinctes et non triviales', () => {
  const keys = Array.from({ length: 50 }, () => createReader(db, alice, null, T0).key.toString('hex'));
  assert.equal(new Set(keys).size, 50);
  assert.ok(keys.every((k) => /^[0-9a-f]{64}$/.test(k) && !/^(.)\1+$/.test(k)));
});

test('création : poste inexistant refusé, sans écriture', () => {
  const before = state();
  assert.equal(createReader(db, alice, 99n, T0), 'no_station');
  assert.equal(state(), before);
});

test('plage d\'identifiants : un lecteur 4294967295 existe → création et remplacement refusés proprement, sans écriture', () => {
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (?, 1, ?, ?)').run(MAX_READER_ID - 1, Buffer.alloc(32, 2), T0);
  const last = createReader(db, alice, null, T0);
  assert.equal(last.id, MAX_READER_ID, 'le dernier identifiant possible est attribué');
  const before = state();
  assert.equal(createReader(db, alice, 1n, T1), 'ids_exhausted');
  assert.equal(replaceReader(db, alice, MAX_READER_ID - 1, T1), 'ids_exhausted');
  assert.equal(state(), before);
  assert.equal(getReader(db, MAX_READER_ID - 1).active, 1, 'l\'ancien lecteur reste actif');
  assert.equal(db.isTransaction, false);
});

test('lecteur créé : ses trames sont acceptées avec la clé renvoyée ; rejeu → replay', () => {
  const { id, key } = createReader(db, alice, 1n, T0);
  assert.equal(ingestFrame(db, frame(id, 1, key), T0).ok, true);
  assert.deepEqual(ingestFrame(db, frame(id, 1, key), T0), { ok: false, reason: 'replay', readerId: id });
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 1);
});

test('affectation : avant/après journalisés ; sans changement rien n\'est écrit ; l\'historique reste figé', () => {
  const { id, key } = createReader(db, alice, 1n, T0);
  assert.equal(ingestFrame(db, frame(id, 1, key), T0).ok, true);
  const scansBefore = JSON.stringify(db.prepare('SELECT * FROM scans').all());

  const auditCount = count('audit_log');
  assert.deepEqual(assignReader(db, alice, id, 1n, T1), { changed: false });
  assert.equal(count('audit_log'), auditCount, 'pas d\'audit sans changement');

  assert.deepEqual(assignReader(db, alice, id, 2n, T1), { changed: true });
  assert.deepEqual(lastAudit(), { at: T1, user_id: alice, action: 'reader.assign', entity_id: id, details: { before: { id: 1, name: 'Banc 1' }, after: { id: 2, name: 'Banc 2' } } });
  // Ni le journal des scans ni la localisation actuelle ne changent.
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM scans').all()), scansBefore);
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 1);
  // Le scan suivant est rattaché au nouveau poste.
  assert.equal(ingestFrame(db, frame(id, 2, key), T1).ok, true);
  assert.deepEqual(db.prepare('SELECT station_id FROM scans ORDER BY id').all().map((r) => r.station_id), [1, 2]);

  assert.deepEqual(assignReader(db, alice, id, null, T1), { changed: true });
  assert.deepEqual(lastAudit().details, { before: { id: 2, name: 'Banc 2' }, after: null });
  assert.equal(getReader(db, id).station_id, null);

  const before = state();
  assert.equal(assignReader(db, alice, id, 99n, T1), 'no_station');
  assert.equal(assignReader(db, alice, 999, 1n, T1), 'no_reader');
  assert.equal(state(), before);
});

test('désactivation : définitive, trames refusées ensuite, aucune réaffectation ni remplacement possible', () => {
  const { id, key } = createReader(db, alice, 1n, T0);
  assert.equal(ingestFrame(db, frame(id, 1, key), T0).ok, true);
  assert.equal(deactivateReader(db, alice, id, T1), 'ok');
  assert.deepEqual(lastAudit(), { at: T1, user_id: alice, action: 'reader.deactivate', entity_id: id, details: { station: { id: 1, name: 'Banc 1' } } });
  assert.deepEqual(ingestFrame(db, frame(id, 2, key), T1), { ok: false, reason: 'inactive_reader', readerId: id });
  const before = state();
  assert.equal(deactivateReader(db, alice, id, T1), 'inactive');
  assert.equal(assignReader(db, alice, id, 2n, T1), 'inactive');
  assert.equal(replaceReader(db, alice, id, T1), 'inactive');
  assert.equal(deactivateReader(db, alice, 999, T1), 'no_reader');
  assert.equal(state(), before);
  assert.equal(getReader(db, id).station_id, 1, 'le poste reste affiché');
});

test('remplacement : nouveau lecteur (nouvel id, nouvelle clé, même poste), ancien désactivé, une ligne d\'audit sans clé', () => {
  const old = createReader(db, alice, 2n, T0);
  assert.equal(ingestFrame(db, frame(old.id, 7, old.key), T0).ok, true);
  const replaced = replaceReader(db, alice, old.id, T1);
  assert.equal(replaced.id, old.id + 1);
  assert.equal(replaced.oldId, old.id);
  assert.deepEqual(replaced.station, { id: 2, name: 'Banc 2' });
  assert.ok(!replaced.key.equals(old.key));
  assert.deepEqual({ ...getReader(db, replaced.id) }, {
    id: replaced.id, name: '', station_id: 2, station_name: 'Banc 2', active: 1, created_at: T1, last_scan_at: null, last_counter: null,
  });
  assert.equal(getReader(db, old.id).active, 0);
  // Deux lignes dans la même transaction : reader.replace sur l'ancien, reader.create sur le nouveau.
  const lines = db.prepare('SELECT at, user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 2').all()
    .reverse().map((r) => ({ ...r, details: JSON.parse(r.details) }));
  assert.deepEqual(lines, [
    { at: T1, user_id: alice, action: 'reader.replace', entity_id: old.id, details: { old_id: old.id, new_id: replaced.id, station: { id: 2, name: 'Banc 2' } } },
    { at: T1, user_id: alice, action: 'reader.create', entity_id: replaced.id, details: { replaces: old.id, name: '', station: { id: 2, name: 'Banc 2' } } },
  ]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log WHERE entity_id = ? AND action = ?').get(replaced.id, 'reader.create').n, 1);
  // L'ancien est refusé ; le nouveau repart de son propre compteur.
  assert.equal(ingestFrame(db, frame(old.id, 8, old.key), T1).reason, 'inactive_reader');
  assert.equal(ingestFrame(db, frame(replaced.id, 1, replaced.key), T1).ok, true);
  assert.equal(ingestFrame(db, frame(replaced.id, 2, old.key), T1).reason, 'bad_tag', 'ancienne clé inutilisable pour le nouveau lecteur');
  const audit = db.prepare('SELECT details FROM audit_log').all().map((r) => r.details).join('\n');
  assert.ok(!containsKey(audit, old.key) && !containsKey(audit, replaced.key));
});

test('atomicité : si l\'audit échoue, ni création ni remplacement ni désactivation ne sont écrits', () => {
  const { id } = createReader(db, alice, 1n, T0);
  const before = state();
  db.exec("CREATE TEMP TRIGGER audit_en_panne BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit en panne'); END");
  for (const action of [() => createReader(db, alice, 1n, T1), () => replaceReader(db, alice, id, T1), () => deactivateReader(db, alice, id, T1), () => assignReader(db, alice, id, 2n, T1)]) {
    assert.throws(action, /audit en panne/);
    assert.equal(db.isTransaction, false);
  }
  db.exec('DROP TRIGGER temp.audit_en_panne');
  assert.equal(state(), before);
});

test('lectures : liste (actifs d\'abord), dernier scan et dernier compteur, 20 derniers scans avec l\'objet ; jamais la clé', () => {
  const a = createReader(db, alice, 1n, T0);
  const b = createReader(db, alice, null, T0);
  deactivateReader(db, alice, a.id, T0);
  const c = createReader(db, alice, 2n, T0);
  for (let n = 1; n <= 25; n++) {
    const at = new Date(Date.parse(T0) + n * 1000).toISOString();
    assert.equal(ingestFrame(db, frame(c.id, n * 3, c.key, n % 2 === 0 ? UID : 'DEADBEEF'), at).ok, true);
  }
  const list = listReaders(db);
  assert.deepEqual(list.map((r) => [r.id, r.active]), [[b.id, 1], [c.id, 1], [a.id, 0]]);
  for (const row of list) assert.ok(!Object.hasOwn(row, 'aead_key'));
  const cRow = list.find((r) => r.id === c.id);
  assert.equal(cRow.last_counter, 75);
  assert.equal(cRow.last_scan_at, new Date(Date.parse(T0) + 25_000).toISOString());
  assert.equal(list.find((r) => r.id === b.id).last_scan_at, null);
  const scans = readerScans(db, c.id);
  assert.equal(scans.length, 20);
  assert.deepEqual(scans.slice(0, 2).map((s) => [s.counter, s.uid_nfc, s.item_id, s.item_name, s.station_name]),
    [[75, 'DEADBEEF', null, null, 'Banc 2'], [72, UID, 1, 'Multimètre', 'Banc 2']]);
  assert.equal(getReader(db, 999), null);
});

test('plans : liste, fiche et derniers scans d\'un lecteur lus par l\'index (reader_id, counter), sans parcourir les scans', () => {
  createReader(db, alice, 1n, T0);
  // Requêtes réellement exécutées par les fonctions (faux db.prepare), puis leurs plans.
  const seen = [];
  const spy = { prepare: (sql) => { seen.push(sql); return db.prepare(sql); } };
  listReaders(spy);
  getReader(spy, 1);
  readerScans(spy, 1);
  assert.equal(seen.length, 3);
  for (const sql of seen) {
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split('?').length - 1).fill(1)).map((r) => r.detail);
    assert.ok(plan.some((d) => /INDEX sqlite_autoindex_scans_1/.test(d)), plan.join('\n'));
    assert.ok(!plan.some((d) => /^SCAN (s|s2|scans)\b/.test(d)), plan.join('\n'));
  }
});

// ---------------------------------------------------------------- nom libre (D-019)

test('nom : validateReaderName nettoie comme les noms de postes ; vide permis ; invisible seul ou trop long refusé', () => {
  assert.equal(MAX_READER_NAME_CHARS, MAX_STATION_NAME_CHARS);
  assert.deepEqual(validateReaderName(undefined), { ok: true, name: '', error: null });
  assert.deepEqual(validateReaderName('   '), { ok: true, name: '', error: null });
  // NFC (i + accent circonflexe combinant U+0302), blancs réduits (espace insécable U+00A0),
  // contrôles (U+0007), bidi (U+202E) et invisibles (U+200B) retirés (cleanLine). Caractères
  // construits par leur code : aucun invisible littéral dans les sources (sources-invisibles.test.js).
  const cp = (code) => String.fromCodePoint(code);
  const raw = `  Boi${cp(0x302)}tier ${cp(0x202E)}établi${cp(0x200B)} ${cp(0xA0)} gauche${cp(0x7)} `;
  assert.deepEqual(validateReaderName(raw), { ok: true, name: 'Boîtier établi gauche', error: null });
  // Fait seulement de caractères sans glyphe que cleanLine garde (remplissage hangul, braille vide).
  for (const value of [cp(0x3164), cp(0x2800).repeat(2)]) {
    const r = validateReaderName(value);
    assert.equal(r.ok, false, JSON.stringify(value));
    assert.match(r.error, /au moins une lettre/);
  }
  assert.equal(validateReaderName('x'.repeat(MAX_READER_NAME_CHARS)).ok, true);
  const long = validateReaderName('x'.repeat(MAX_READER_NAME_CHARS + 1));
  assert.equal(long.ok, false);
  assert.match(long.error, /ne doit pas dépasser 100 caractères \(101 saisis\)/);
});

test('nom : création avec nom (audit), renommage avec avant/après, sans changement rien n\'est écrit, lecteur désactivé renommable', () => {
  const { id, name } = createReader(db, alice, 1n, T0, 'Boîtier établi gauche');
  assert.equal(name, 'Boîtier établi gauche');
  assert.equal(getReader(db, id).name, 'Boîtier établi gauche');
  assert.deepEqual(lastAudit().details, { id, name: 'Boîtier établi gauche', station: { id: 1, name: 'Banc 1' } });

  const before = state();
  assert.deepEqual(renameReader(db, alice, id, 'Boîtier établi gauche', T1), { changed: false });
  assert.equal(state(), before, 'rien n\'est écrit');

  assert.deepEqual(renameReader(db, alice, id, 'Boîtier droit', T1), { changed: true });
  assert.deepEqual(lastAudit(), { at: T1, user_id: alice, action: 'reader.rename', entity_id: id, details: { name: { before: 'Boîtier établi gauche', after: 'Boîtier droit' } } });
  assert.deepEqual(renameReader(db, alice, id, '', T1), { changed: true });
  assert.deepEqual(lastAudit().details, { name: { before: 'Boîtier droit', after: '' } });

  assert.equal(deactivateReader(db, alice, id, T1), 'ok');
  assert.deepEqual(renameReader(db, alice, id, 'Retiré', T1), { changed: true });
  assert.equal(getReader(db, id).name, 'Retiré');
  assert.equal(renameReader(db, alice, 999, 'X', T1), 'no_reader');
});

test('nom : le remplaçant d\'un lecteur reprend son nom ; noms en double permis', () => {
  const old = createReader(db, alice, 2n, T0, 'Boîtier établi gauche');
  createReader(db, alice, 1n, T0, 'Boîtier établi gauche');
  const replaced = replaceReader(db, alice, old.id, T1);
  assert.equal(replaced.name, 'Boîtier établi gauche');
  assert.equal(getReader(db, replaced.id).name, 'Boîtier établi gauche');
  assert.deepEqual(lastAudit().details, { replaces: old.id, name: 'Boîtier établi gauche', station: { id: 2, name: 'Banc 2' } });
});

test('nom : CHECK de la table (migration 007) — au plus 100 caractères, jamais NULL, vide par défaut', () => {
  db.prepare('INSERT INTO readers (id, aead_key, created_at) VALUES (5, ?, ?)').run(Buffer.alloc(32, 5), T0);
  assert.equal(getReader(db, 5).name, '');
  db.prepare('UPDATE readers SET name = ? WHERE id = 5').run('é'.repeat(100));
  assert.throws(() => db.prepare('UPDATE readers SET name = ? WHERE id = 5').run('é'.repeat(101)), /CHECK constraint failed/);
  assert.throws(() => db.prepare('UPDATE readers SET name = NULL WHERE id = 5').run(), /NOT NULL constraint failed/);
});

test('readerLabel : nom, sinon « Lecteur du poste … » si affecté, sinon « Lecteur n° … »', () => {
  assert.equal(readerLabel({ id: 7, name: 'Boîtier établi gauche', station_id: 1, station_name: 'Banc 1' }), 'Boîtier établi gauche');
  assert.equal(readerLabel({ id: 7, name: 'Boîtier établi gauche', station_id: null, station_name: null }), 'Boîtier établi gauche');
  assert.equal(readerLabel({ id: 7, name: '', station_id: 1, station_name: 'Banc 1' }), 'Lecteur du poste Banc 1');
  assert.equal(readerLabel({ id: 7, name: '', station_id: null, station_name: null }), 'Lecteur n° 7');
  // Les lectures fournissent les colonnes attendues.
  createReader(db, alice, 1n, T0);
  createReader(db, alice, null, T0, 'Mobile');
  assert.deepEqual(listReaders(db).map(readerLabel), ['Lecteur du poste Banc 1', 'Mobile']);
});
