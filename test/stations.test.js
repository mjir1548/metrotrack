// Postes (étape 6), logique métier sans HTTP : nettoyage et validation (bornes, nom
// invisible), unicité du nom (casse, NFC/NFD), création, modification, suppression
// seulement sans historique (scan, correction, lecteur), journal audit_log, numéros jamais
// réutilisés, lectures pour les pages (compteurs, objets présents).
// Les caractères invisibles sont construits par String.fromCodePoint : aucun n'est écrit tel
// quel dans ce fichier (voir sources-invisibles.test.js).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import { correctLocation } from '../server/items.js';
import {
  validateStationInput, stationNameKey, createStation, updateStation, deleteStation, stationHistory, hasHistory, stationHasHistory,
  getStation, listStationSummaries, stationReaders, stationItems, MAX_STATION_NAME_CHARS, MAX_STATION_DESCRIPTION_CHARS,
} from '../server/stations.js';

const T0 = '2026-11-18T10:00:00.000Z';
const T1 = '2026-11-18T11:00:00.000Z';
const KEY = Buffer.alloc(32, 0x24);
const ch = (...codes) => String.fromCodePoint(...codes);

let db, alice;

beforeEach(() => {
  db = openDb(':memory:');
  alice = Number(db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('alice', 'x', ?)").run(T0).lastInsertRowid);
});
afterEach(() => db.close());

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const auditRows = () => db.prepare('SELECT at, user_id, action, entity_id, details FROM audit_log ORDER BY id').all()
  .map((r) => ({ ...r, details: JSON.parse(r.details) }));
const valid = (fields) => {
  const result = validateStationInput(fields);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.station;
};
const create = (name, description = '') => createStation(db, alice, valid({ name, description }), T0);

// ---------------------------------------------------------------- validation

test('validation : nom nettoyé (contrôles, bidi, espaces de bord), NFC ; description multiligne CRLF → LF', () => {
  const result = validateStationInput({ name: `  Atelier${ch(0x202E)} B${ch(0)}  `, description: ' Salle 2\r\nArmoire B ' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.station, { name: 'Atelier B', description: 'Salle 2\nArmoire B' });
  assert.equal(validateStationInput({ name: 'e' + ch(0x301), description: '' }).station.name, ch(0xE9));
  assert.deepEqual(validateStationInput({ name: 'X' }).station, { name: 'X', description: '' }, 'description absente : vide');
});

test('validation : nom obligatoire avec un caractère visible ; bornes 100 et 1 000', () => {
  for (const name of [undefined, null, '', '   ', ch(0x200B), ch(0x3164, 0x2800), ch(0xA0, 0x2060)]) {
    const result = validateStationInput({ name, description: '' });
    assert.equal(result.ok, false, JSON.stringify(name));
    assert.equal(result.errors.name, 'Le nom est obligatoire.');
  }
  assert.equal(validateStationInput({ name: 'n'.repeat(MAX_STATION_NAME_CHARS) }).ok, true);
  const long = validateStationInput({ name: 'n'.repeat(MAX_STATION_NAME_CHARS + 1) });
  assert.equal(long.errors.name, 'Le nom ne doit pas dépasser 100 caractères (101 saisis).');
  assert.equal(long.form.name.length, 101, 'saisie conservée pour réaffichage');
  assert.equal(validateStationInput({ name: 'x', description: 'd'.repeat(MAX_STATION_DESCRIPTION_CHARS) }).ok, true);
  const desc = validateStationInput({ name: 'x', description: 'd'.repeat(MAX_STATION_DESCRIPTION_CHARS + 1) });
  assert.match(desc.errors.description, /^La description ne doit pas dépasser 1.000 caractères \(1.001 saisis\)\.$/u);
});

test('forme de comparaison : casse confondue (y compris ß / SS), NFC et NFD identiques', () => {
  assert.equal(stationNameKey('Étuve'), stationNameKey('ÉTUVE'));
  assert.equal(stationNameKey('E' + ch(0x301) + 'tuve'), stationNameKey(ch(0xC9) + 'tuve'));
  assert.equal(stationNameKey('Straße'), stationNameKey('STRASSE'));
  assert.notEqual(stationNameKey('Poste 1'), stationNameKey('Poste 2'));
});

// ---------------------------------------------------------------- création, unicité

test('création : poste et ligne d\'audit station.create dans la même transaction', () => {
  const { id } = create('Banc 1', 'Mesures');
  assert.deepEqual(getStation(db, id), { id, name: 'Banc 1', description: 'Mesures', created_at: T0 });
  assert.deepEqual(auditRows(), [{ at: T0, user_id: alice, action: 'station.create', entity_id: id, details: { name: 'Banc 1', description: 'Mesures' } }]);
});

test('création : nom en double refusé (casse, NFC/NFD, ß), sans écriture ni audit', () => {
  create('Étuve');
  create('Straße');
  for (const name of ['étuve', 'ÉTUVE', 'E' + ch(0x301) + 'tuve', 'STRASSE', 'strasse']) {
    const before = [count('stations'), count('audit_log')];
    const outcome = createStation(db, alice, valid({ name }), T1);
    assert.ok(outcome.duplicate === 'Étuve' || outcome.duplicate === 'Straße', name);
    assert.deepEqual([count('stations'), count('audit_log')], before, name);
  }
  // Nom déjà stocké hors NFC (autre chemin d'insertion) : reconnu quand même.
  db.prepare('INSERT INTO stations (name, created_at) VALUES (?, ?)').run('Cafe' + ch(0x301), T0);
  assert.deepEqual(createStation(db, alice, valid({ name: 'CAF' + ch(0xC9) }), T1), { duplicate: 'Cafe' + ch(0x301) });
  // Nom stocké hors interface avec une espace insécable, des espaces multiples ou un
  // invisible : comparé avec la même règle que la saisie (cleanLine).
  for (const [stored, typed] of [[`Quai${ch(0xA0)}Nord`, 'quai nord'], ['Banc   Sud', 'BANC SUD'], [`Zone${ch(0x200B)} Est`, 'Zone Est']]) {
    db.prepare('INSERT INTO stations (name, created_at) VALUES (?, ?)').run(stored, T0);
    assert.deepEqual(createStation(db, alice, valid({ name: typed }), T1), { duplicate: stored }, typed);
  }
});

test('création : noms identiques à l\'œil refusés (espaces multiples, insécables U+00A0, U+202F, U+2007)', () => {
  create('Poste E2E');
  for (const name of ['Poste   E2E', `Poste${ch(0xA0)}E2E`, `poste${ch(0x202F)}e2e`, `POSTE${ch(0x2007)}E2E`, `Poste${ch(0xA0, 0x20, 0x202F)}E2E`, `${ch(0xA0)}Poste E2E${ch(0x2007)}`]) {
    const station = valid({ name });
    assert.equal(station.name.toUpperCase(), 'POSTE E2E', `${JSON.stringify(name)} : une seule espace ordinaire`);
    assert.deepEqual(createStation(db, alice, station, T1), { duplicate: 'Poste E2E' }, JSON.stringify(name));
  }
  assert.equal(count('stations'), 1);
  // La description (plusieurs lignes) garde ses espaces.
  assert.equal(valid({ name: 'x', description: 'a   b' }).description, 'a   b');
});

test('numéros de poste jamais réutilisés : après suppression du plus grand, le suivant prend un numéro neuf', () => {
  const a = create('A').id;
  const b = create('B').id;
  assert.equal(deleteStation(db, alice, b, T1), 'ok');
  const c = create('C').id;
  assert.ok(c > b, `${c} > ${b}`);
  assert.deepEqual(db.prepare('SELECT entity_id FROM audit_log WHERE action = ? ORDER BY id').all('station.create').map((r) => r.entity_id), [a, b, c]);
});

// ---------------------------------------------------------------- modification

test('modification : seuls les champs changés sont journalisés (avant/après) ; sans changement, rien n\'est écrit', () => {
  const { id } = create('Banc 1', 'Mesures');
  assert.deepEqual(updateStation(db, alice, id, valid({ name: 'Banc 1', description: 'Mesures' }), T1), { changed: [] });
  assert.equal(count('audit_log'), 1);
  assert.deepEqual(updateStation(db, alice, id, valid({ name: 'Banc principal', description: 'Mesures' }), T1), { changed: ['name'] });
  assert.deepEqual(auditRows().at(-1), { at: T1, user_id: alice, action: 'station.update', entity_id: id, details: { name: { before: 'Banc 1', after: 'Banc principal' } } });
  assert.deepEqual(updateStation(db, alice, id, valid({ name: 'Banc principal', description: '' }), T1), { changed: ['description'] });
  assert.deepEqual(auditRows().at(-1).details, { description: { before: 'Mesures', after: '' } });
  assert.equal(updateStation(db, alice, 999, valid({ name: 'x' }), T1), null);
});

test('modification : changer la casse de son propre nom est permis ; prendre le nom d\'un autre poste est refusé', () => {
  const { id } = create('atelier');
  create('Étuve');
  assert.deepEqual(updateStation(db, alice, id, valid({ name: 'Atelier' }), T1), { changed: ['name'] });
  const before = [JSON.stringify(getStation(db, id)), count('audit_log')];
  assert.deepEqual(updateStation(db, alice, id, valid({ name: 'ÉTUVE' }), T1), { duplicate: 'Étuve' });
  assert.deepEqual([JSON.stringify(getStation(db, id)), count('audit_log')], before);
  // Les accents ne sont pas de la casse : « ETUVE » est un autre nom que « Étuve ».
  assert.deepEqual(updateStation(db, alice, id, valid({ name: 'ETUVE' }), T1), { changed: ['name'] });
});

// ---------------------------------------------------------------- suppression

test('suppression d\'un poste sans historique : réussie, audit station.delete avec l\'instantané complet', () => {
  const { id } = create('Temporaire', 'à retirer');
  assert.deepEqual(stationHistory(db, id), { scans: 0, corrections: 0, readers: 0 });
  assert.equal(stationHasHistory(db, id), false);
  assert.equal(deleteStation(db, alice, id, T1), 'ok');
  assert.equal(getStation(db, id), null);
  assert.deepEqual(auditRows().at(-1), {
    at: T1, user_id: alice, action: 'station.delete', entity_id: id,
    details: { id, name: 'Temporaire', description: 'à retirer', created_at: T0 },
  });
  assert.equal(deleteStation(db, alice, id, T1), 'no_station');
});

test('suppression refusée pour chaque cause d\'historique (scan, correction, lecteur actif ou désactivé), sans écriture', () => {
  const scanned = create('Scanné').id;
  const corrected = create('Corrigé').id;
  const withReader = create('Avec lecteur').id;
  const withInactive = create('Avec lecteur désactivé').id;
  // Scan : le lecteur a ensuite été déplacé ailleurs ; le scan garde le poste.
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, ?, ?, ?)').run(scanned, KEY, T0);
  assert.equal(ingestFrame(db, encodeFrame({ readerId: 1, counter: 1, uid: Buffer.from('DEADBEEF', 'hex'), key: KEY }), T0).ok, true);
  db.prepare('UPDATE readers SET station_id = NULL WHERE id = 1').run();
  const item = Number(db.prepare("INSERT INTO items (name, created_at, updated_at) VALUES ('Objet', ?, ?)").run(T0, T0).lastInsertRowid);
  assert.equal(correctLocation(db, alice, item, BigInt(corrected), T0), 'ok');
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (2, ?, ?, ?)').run(withReader, KEY, T0);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (3, ?, ?, 0, ?)').run(withInactive, KEY, T0);

  const expected = {
    [scanned]: { scans: 1, corrections: 0, readers: 0 },
    [corrected]: { scans: 0, corrections: 1, readers: 0 },
    [withReader]: { scans: 0, corrections: 0, readers: 1 },
    [withInactive]: { scans: 0, corrections: 0, readers: 1 },
  };
  for (const [id, history] of Object.entries(expected)) {
    const before = [count('stations'), count('audit_log'), count('scans'), count('location_corrections'), count('readers')];
    assert.deepEqual(stationHistory(db, Number(id)), history);
    assert.equal(hasHistory(history), true);
    assert.equal(stationHasHistory(db, Number(id)), true);
    assert.deepEqual(deleteStation(db, alice, Number(id), T1), { blocked: history });
    assert.deepEqual([count('stations'), count('audit_log'), count('scans'), count('location_corrections'), count('readers')], before);
    assert.equal(db.isTransaction, false);
  }
});

// ---------------------------------------------------------------- lectures

test('liste : tri français, lecteurs actifs et objets ACTUELLEMENT présents par poste', () => {
  const zone = create('Zone B').id;
  const etuve = create('étuve').id;
  const poste10 = create('Poste 10').id;
  const poste2 = create('Poste 2').id;
  db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (1, ?, ?, 1, ?), (2, ?, ?, 1, ?), (3, ?, ?, 0, ?)')
    .run(zone, KEY, T0, zone, KEY, T0, zone, KEY, T0);
  const item = db.prepare('INSERT INTO items (uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  item.run('AA000001', 'Un', T0, T0);
  item.run('AA000002', 'Deux', T0, T0);
  const scan = (counter, uid, at) => ingestFrame(db, encodeFrame({ readerId: 1, counter, uid: Buffer.from(uid, 'hex'), key: KEY }), at);
  scan(1, 'AA000001', T0);
  scan(2, 'AA000002', T0);
  // « Deux » est ensuite corrigé vers l'étuve : il n'est plus compté en zone B.
  correctLocation(db, alice, 2, BigInt(etuve), T1);
  const rows = listStationSummaries(db);
  assert.deepEqual(rows.map((r) => r.name), ['étuve', 'Poste 2', 'Poste 10', 'Zone B']);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual([byId[zone].active_readers, byId[zone].items_here], [2, 1]);
  assert.deepEqual([byId[etuve].active_readers, byId[etuve].items_here], [0, 1]);
  assert.deepEqual([byId[poste10].items_here, byId[poste2].items_here], [0, 0]);
  assert.deepEqual(stationItems(db, zone).map((i) => i.name), ['Un']);
  assert.deepEqual(stationItems(db, etuve).map((i) => [i.name, i.source]), [['Deux', 'manual']]);
  assert.deepEqual(stationReaders(db, zone).map((r) => [r.id, r.active]), [[1, 1], [2, 1], [3, 0]]);
  assert.ok(!Object.hasOwn(stationReaders(db, zone)[0], 'aead_key'), 'jamais la clé');
});

test('plans : historique d\'un poste lu par l\'index scans_by_station, sans parcourir les scans', () => {
  const plan = db.prepare('EXPLAIN QUERY PLAN SELECT count(*) FROM scans WHERE station_id = ?').all(1).map((r) => r.detail);
  assert.ok(plan.some((d) => /USING COVERING INDEX scans_by_station/.test(d)), plan.join('\n'));
  assert.ok(!plan.some((d) => /^SCAN scans\b/.test(d)), plan.join('\n'));
  // Requête réellement exécutée par stationHasHistory (page du poste, contrôle avant suppression).
  const seen = [];
  stationHasHistory({ prepare: (sql) => { seen.push(sql); return db.prepare(sql); } }, 1);
  assert.equal(seen.length, 1);
  const existsPlan = db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all(1, 1, 1).map((r) => r.detail);
  assert.ok(existsPlan.some((d) => /USING COVERING INDEX scans_by_station/.test(d)), existsPlan.join('\n'));
  assert.ok(!existsPlan.some((d) => /SCAN scans\b/.test(d)), existsPlan.join('\n'));
});
