// Migration 004 : location_corrections, audit_log, triggers d'ajout seul, vue item_locations
// avec corrections manuelles (forme D-013).
// - passage d'une base en version 3 (avec des données) à la version 4 ;
// - équivalence exacte avec la définition de référence de docs/cadrage.md §3 (row_number() sur
//   scans + corrections) sur des données variées, ex aequo compris ;
// - plans de requête : lectures d'index seulement, jamais de parcours de scans ni de
//   matérialisation de tous les scans ;
// - triggers : scans et audit_log refusent UPDATE et DELETE, location_corrections refuse
//   UPDATE, la suppression d'une fiche emporte ses corrections et garde l'audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { getItem, listItems } from '../server/inventory.js';
import { itemHistory } from '../server/items.js';

const MIGRATIONS = join(import.meta.dirname, '..', 'server', 'migrations');
const NOW = '2026-11-17T10:00:00.000Z';
const KEY = Buffer.alloc(32, 9);
// Refus des journaux. Depuis la migration 005, le trigger anti-REPLACE de scans répond
// « scans: duplicate » (message propre, reconnu par ingest.js) ; les autres « append-only ».
const DUPLICATE_OR_APPEND_ONLY = /append-only|scans: duplicate/;

// Définition de référence de docs/cadrage.md §3, recopiée telle quelle (vue temporaire).
const REFERENCE_VIEW = `CREATE TEMP VIEW reference_item_locations AS
WITH events AS (
  SELECT i.id AS item_id, s.station_id, s.received_at AS at, 'scan' AS source, s.reader_id, s.id AS event_id
    FROM items i JOIN scans s ON s.uid_nfc = i.uid_nfc
  UNION ALL
  SELECT c.item_id, c.station_id, c.created_at, 'manual', NULL, c.id
    FROM location_corrections c
), ranked AS (
  SELECT *, row_number() OVER (
           PARTITION BY item_id
           ORDER BY at DESC, (source = 'manual') DESC, event_id DESC) AS rn
    FROM events
)
SELECT item_id, station_id, at, source, reader_id FROM ranked WHERE rn = 1`;

const rowsOf = (db, view) => db.prepare(`SELECT item_id, station_id, at, source, reader_id FROM ${view} ORDER BY item_id`).all()
  .map((r) => ({ ...r }));

function assertSameAsReference(db, what) {
  db.exec('DROP VIEW IF EXISTS temp.reference_item_locations');
  db.exec(REFERENCE_VIEW);
  const expected = rowsOf(db, 'reference_item_locations');
  assert.deepEqual(rowsOf(db, 'item_locations'), expected, what);
  return expected;
}

const at = (minutes, ms = 0) => new Date(Date.parse(NOW) + minutes * 60_000 + ms).toISOString();

// Données variées : scans et corrections insérés directement (colonnes des journaux).
function seed(db) {
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'P1', ?), (2, 'P2', ?), (3, 'P3', ?)").run(NOW, NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?)')
    .run(KEY, NOW, KEY, NOW, KEY, NOW);
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', ?), (2, 'bob', 'x', ?)").run(NOW, NOW);
  const item = db.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const names = {
    1: 'Scan seul', 2: 'Correction plus récente que le scan', 3: 'Scan plus récent que la correction',
    4: 'Scan et correction à la même milliseconde', 5: 'Correction seule, sans puce', 6: 'Correction seule, puce jamais scannée',
    7: 'Deux corrections à la même milliseconde', 8: 'Rien', 9: 'Sans puce et sans rien',
    10: 'Ex aequo scan/scan/correction, correction gagne', 11: 'Correction puis scan sur lecteur non affecté',
  };
  const uids = { 1: 'C0000001', 2: 'C0000002', 3: 'C0000003', 4: 'C0000004', 6: 'C0000006', 8: 'C0000008', 10: 'C000000A', 11: 'C000000B' };
  for (const [id, name] of Object.entries(names)) item.run(Number(id), uids[id] ?? null, name, NOW, NOW);

  const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const counters = [0, 0, 0, 0];
  const addScan = (reader, uid, when) => scan.run(reader, reader === 3 ? null : reader, uid, ++counters[reader], when);
  const correction = db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, ?, ?)');

  addScan(1, 'C0000001', at(1));
  addScan(1, 'C0000002', at(1)); correction.run(2, 3, 1, at(2));
  correction.run(3, 3, 1, at(1)); addScan(2, 'C0000003', at(2));
  addScan(1, 'C0000004', at(3)); correction.run(4, 2, 2, at(3)); addScan(2, 'C0000004', at(3)); // correction gagne malgré le scan inséré après
  correction.run(5, 1, 1, at(4));
  correction.run(6, 2, 1, at(4));
  correction.run(7, 1, 1, at(5)); correction.run(7, 3, 2, at(5)); // la dernière insérée gagne
  correction.run(7, 2, 1, at(4)); // plus ancienne, insérée après : perd
  addScan(1, 'C000000A', at(6, 7)); addScan(2, 'C000000A', at(6, 7)); correction.run(10, 1, 2, at(6, 7));
  correction.run(11, 1, 1, at(7)); addScan(3, 'C000000B', at(7, 1)); // lecteur non affecté, 1 ms plus tard
  addScan(2, 'FFFF0000', at(8)); // puce sans fiche
}

test('vue 004 ≡ définition de référence du cadrage : cas limites (ex aequo, correction seule, lecteur non affecté...)', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const rows = assertSameAsReference(db, 'cas limites');
    const byItem = Object.fromEntries(rows.map((r) => [r.item_id, r]));
    assert.deepEqual(Object.keys(byItem).map(Number), [1, 2, 3, 4, 5, 6, 7, 10, 11], '8 et 9 (rien) absents');
    assert.deepEqual(byItem[1], { item_id: 1, station_id: 1, at: at(1), source: 'scan', reader_id: 1 });
    assert.deepEqual(byItem[2], { item_id: 2, station_id: 3, at: at(2), source: 'manual', reader_id: null });
    assert.deepEqual(byItem[3], { item_id: 3, station_id: 2, at: at(2), source: 'scan', reader_id: 2 });
    assert.deepEqual(byItem[4], { item_id: 4, station_id: 2, at: at(3), source: 'manual', reader_id: null });
    assert.equal(byItem[5].source, 'manual');
    assert.equal(byItem[7].station_id, 3);
    assert.deepEqual(byItem[10], { item_id: 10, station_id: 1, at: at(6, 7), source: 'manual', reader_id: null });
    assert.deepEqual(byItem[11], { item_id: 11, station_id: null, at: at(7, 1), source: 'scan', reader_id: 3 });

    // Puce associée après coup à une fiche qui n'avait qu'une correction : le scan plus récent gagne.
    db.prepare("UPDATE items SET uid_nfc = 'FFFF0000' WHERE id = 5").run();
    assert.equal(assertSameAsReference(db, 'puce associée après coup').find((r) => r.item_id === 5).source, 'scan');
    // Fiche supprimée : ses corrections partent avec elle, elle disparaît de la vue.
    db.prepare('DELETE FROM items WHERE id = 2').run();
    assert.ok(!assertSameAsReference(db, 'fiche supprimée').some((r) => r.item_id === 2));
  } finally {
    db.close();
  }
});

test('vue 004 ≡ référence : données pseudo-aléatoires, nombreux ex aequo entre scans et corrections', () => {
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'P1', ?), (2, 'P2', ?), (3, 'P3', ?)").run(NOW, NOW, NOW);
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?)')
      .run(KEY, NOW, KEY, NOW, KEY, NOW);
    db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', ?)").run(NOW);
    const uid = (n) => (0xD0000000 + n).toString(16).toUpperCase();
    const item = db.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 1; i <= 400; i++) item.run(i, i % 9 === 0 ? null : uid(i), `Objet ${i}`, NOW, NOW);
    // Générateur congruentiel déterministe : même jeu de données à chaque exécution.
    let state = 4242;
    const rand = (n) => { state = (state * 1103515245 + 12345) % 2 ** 31; return Math.floor(state / 65536) % n; };
    const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
    const correction = db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, 1, ?)');
    const counters = [0, 0, 0, 0];
    db.exec('BEGIN');
    for (let k = 0; k < 6000; k++) {
      // Horodatages dans une fenêtre de 30 ms : beaucoup d'ex aequo, dans le désordre.
      const when = new Date(Date.parse(NOW) + rand(30)).toISOString();
      if (rand(4) === 0) {
        correction.run(rand(400) + 1, rand(3) + 1, when);
      } else {
        const reader = rand(3) + 1;
        scan.run(reader, reader === 3 ? null : reader, uid(rand(450) + 1), ++counters[reader], when); // > 400 : puces sans fiche
      }
    }
    db.exec('COMMIT');
    const rows = assertSameAsReference(db, 'aléatoire');
    assert.ok(rows.length > 300, `${rows.length} objets localisés`);
    assert.ok(rows.some((r) => r.source === 'manual') && rows.some((r) => r.source === 'scan'));
    assert.ok(rows.some((r) => r.station_id === null));
  } finally {
    db.close();
  }
});

test('migration 004 : base en version 3 avec des données → version 4, localisations identiques, tables et triggers créés', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-m004-'));
  try {
    const path = join(dir, 'v3.db');
    const v3 = new DatabaseSync(path);
    v3.exec('PRAGMA foreign_keys = ON');
    for (const file of ['001_init.sql', '002_users_sessions.sql', '003_item_locations_index.sql']) v3.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    v3.exec('PRAGMA user_version = 3');
    v3.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'P1', ?), (2, 'P2', ?)").run(NOW, NOW);
    v3.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, NULL, ?, ?)').run(KEY, NOW, KEY, NOW);
    v3.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('alice', 'x', ?)").run(NOW);
    const item = v3.prepare('INSERT INTO items (id, uid_nfc, name, properties, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    item.run(1, 'E0000001', 'Un', '{"Marque":"Fluke"}', 'note\nsur deux lignes', NOW, at(5));
    item.run(2, 'E0000002', 'Deux', '{}', '', NOW, NOW);
    item.run(3, null, 'Trois', '{"n": 42}', '', NOW, NOW);
    item.run(7, 'E0000007', 'Sept (numéros non contigus)', '{}', '', NOW, NOW);
    const scan = v3.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
    scan.run(1, 1, 'E0000001', 1, at(1));
    scan.run(2, null, 'E0000001', 1, at(2));
    scan.run(1, 1, 'E0000002', 2, at(1));
    scan.run(1, 1, 'E0000007', 3, at(3));
    const before = rowsOf(v3, 'item_locations');
    const itemsBefore = v3.prepare('SELECT * FROM items ORDER BY id').all().map((r) => ({ ...r }));
    v3.close();

    const db = openDb(path);
    try {
      // openDb applique aussi les migrations suivantes (005 : postes et lecteurs ; 006 : index
      // scans_by_uid élargi, étape U0).
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
      // Reconstruction de items (AUTOINCREMENT) : données et localisations identiques.
      assert.deepEqual(db.prepare('SELECT * FROM items ORDER BY id').all().map((r) => ({ ...r })), itemsBefore);
      assert.deepEqual(rowsOf(db, 'item_locations'), before);
      assert.equal(before.length, 3);
      const itemsSql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'items'").get().sql;
      assert.match(itemsSql, /id\s+INTEGER PRIMARY KEY AUTOINCREMENT/);
      assert.match(itemsSql, /uid_nfc\s+TEXT\s+UNIQUE/);
      assert.match(itemsSql, /CHECK \(json_valid\(properties\) AND json_type\(properties\) = 'object'\)/);
      assert.ok(!db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'items_new'").get(), 'table temporaire supprimée');
      assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'items'").get().seq, 7, 'séquence = plus grand id');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      // Contraintes reprises de 001 : UID unique et bien formé, nom non vide, propriétés objet.
      for (const sql of [
        "INSERT INTO items (uid_nfc, name, created_at, updated_at) VALUES ('E0000001', 'doublon', 'x', 'x')",
        "INSERT INTO items (uid_nfc, name, created_at, updated_at) VALUES ('e0000009', 'minuscules', 'x', 'x')",
        "INSERT INTO items (name, created_at, updated_at) VALUES ('  ', 'x', 'x')",
        "INSERT INTO items (name, properties, created_at, updated_at) VALUES ('x', '[]', 'x', 'x')",
      ]) assert.throws(() => db.exec(sql), /constraint/i, sql);
      // Nouvelle fiche : numéro suivant le plus grand existant, jamais un trou ni un numéro libéré.
      const next = db.prepare("INSERT INTO items (name, created_at, updated_at) VALUES ('Huit', ?, ?)").run(NOW, NOW).lastInsertRowid;
      assert.equal(Number(next), 8);
      db.prepare('DELETE FROM items WHERE id = 8').run();
      assert.equal(Number(db.prepare("INSERT INTO items (name, created_at, updated_at) VALUES ('Neuf', ?, ?)").run(NOW, NOW).lastInsertRowid), 9);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 4);
      assert.equal(getItem(db, 1n).properties[0][1], 'Fluke');
      const names = db.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => `${r.type}:${r.name}`);
      for (const expected of ['table:location_corrections', 'table:audit_log', 'index:corrections_by_item', 'index:audit_by_entity',
        'trigger:audit_log_no_update', 'trigger:audit_log_no_delete', 'trigger:location_corrections_no_update',
        'trigger:scans_no_update', 'trigger:scans_no_delete', 'view:item_locations']) {
        assert.ok(names.includes(expected), expected);
      }
      // Les corrections s'appliquent aussitôt aux données migrées.
      db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (2, 2, 1, ?)').run(at(3));
      assert.deepEqual({ ...db.prepare('SELECT station_id, source FROM item_locations WHERE item_id = 2').get() }, { station_id: 2, source: 'manual' });
      assertSameAsReference(db, 'après migration');
    } finally {
      db.close();
    }
    const again = openDb(path); // aucune migration rejouée
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 6);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ajout seul sans PRAGMA recursive_triggers : une connexion brute (new DatabaseSync) ne peut ni REPLACE ni UPSERT sur les trois journaux', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-m004-brut-'));
  try {
    const path = join(dir, 'brut.db');
    const prepared = openDb(path);
    seed(prepared);
    prepared.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, 1, 'item.update', 2, '{}')").run(NOW);
    prepared.close();

    const raw = new DatabaseSync(path); // aucun PRAGMA : ni foreign_keys ni recursive_triggers
    try {
      assert.equal(raw.prepare('PRAGMA recursive_triggers').get().recursive_triggers, 0);
      const state = () => JSON.stringify(['scans', 'audit_log', 'location_corrections'].map((t) => raw.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
      const before = state();
      for (const sql of [
        "INSERT OR REPLACE INTO scans (id, reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 2, 2, 'C0000001', 99, 'x')",
        "REPLACE INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 'DEADBEEF', 1, 'x')",
        "INSERT OR REPLACE INTO audit_log (id, at, user_id, action, entity_id, details) VALUES (1, 'x', 2, 'item.create', 2, '{}')",
        `INSERT OR REPLACE INTO location_corrections (id, item_id, station_id, user_id, created_at) VALUES (1, 2, 1, 2, '${NOW}')`,
        "INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 'DEADBEEF', 1, 'x') ON CONFLICT (reader_id, counter) DO UPDATE SET uid_nfc = 'DEADBEEF'",
        "INSERT INTO audit_log (id, at, action, details) VALUES (1, 'x', 'y', '{}') ON CONFLICT (id) DO UPDATE SET action = 'falsifié'",
        "INSERT OR IGNORE INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 'DEADBEEF', 1, 'x')",
      ]) assert.throws(() => raw.exec(sql), DUPLICATE_OR_APPEND_ONLY, sql);
      assert.equal(state(), before, 'journaux intacts');
      // Les insertions normales restent possibles.
      raw.exec("INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 'DEADBEEF', 1000, 'x')");
      raw.exec("INSERT INTO audit_log (at, action, details) VALUES ('x', 'y', '{}')");
    } finally {
      raw.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('triggers : UPDATE, DELETE, REPLACE, UPSERT refusés sur scans et audit_log ; UPDATE, REPLACE, UPSERT refusés sur location_corrections ; la suppression d\'une fiche emporte ses corrections et garde l\'audit', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, 1, 'item.update', 2, '{}')").run(NOW);
    for (const sql of ['UPDATE scans SET station_id = 2', 'DELETE FROM scans', 'DELETE FROM scans WHERE id = 1']) {
      assert.throws(() => db.exec(sql), /scans: append-only/, sql);
    }
    for (const sql of ["UPDATE audit_log SET action = 'x'", 'UPDATE audit_log SET user_id = NULL', 'DELETE FROM audit_log']) {
      assert.throws(() => db.exec(sql), /audit_log: append-only/, sql);
    }
    for (const sql of ['UPDATE location_corrections SET station_id = 1', "UPDATE location_corrections SET created_at = '2030-01-01T00:00:00.000Z'"]) {
      assert.throws(() => db.exec(sql), /location_corrections: append-only/, sql);
    }
    assert.throws(() => db.exec("INSERT INTO audit_log (at, action, details) VALUES ('x', 'y', 'pas du json')"), /CHECK constraint/);

    // Contournements par résolution de conflit : REPLACE (suppression implicite), IGNORE, UPSERT.
    const state = () => JSON.stringify(['scans', 'audit_log', 'location_corrections']
      .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
    const before = state();
    const replaces = {
      'scans (id)': "INSERT OR REPLACE INTO scans (id, reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 2, 2, 'C0000001', 99, 'x')",
      'scans (lecteur, compteur)': "REPLACE INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 'DEADBEEF', 1, 'x')",
      'audit_log': "INSERT OR REPLACE INTO audit_log (id, at, user_id, action, entity_id, details) VALUES (1, 'x', 2, 'item.create', 2, '{}')",
      'location_corrections': `INSERT OR REPLACE INTO location_corrections (id, item_id, station_id, user_id, created_at) VALUES (1, 2, 1, 2, '${NOW}')`,
    };
    for (const [what, sql] of Object.entries(replaces)) assert.throws(() => db.exec(sql), DUPLICATE_OR_APPEND_ONLY, what);
    const upserts = {
      scans: "INSERT INTO scans (id, reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 2, 2, 'C0000001', 99, 'x') ON CONFLICT (id) DO UPDATE SET station_id = 3",
      audit_log: "INSERT INTO audit_log (id, at, action, details) VALUES (1, 'x', 'y', '{}') ON CONFLICT (id) DO UPDATE SET action = 'falsifié'",
      location_corrections: `INSERT INTO location_corrections (id, item_id, station_id, user_id, created_at) VALUES (1, 2, 1, 2, '${NOW}') ON CONFLICT (id) DO UPDATE SET station_id = 1`,
    };
    for (const [what, sql] of Object.entries(upserts)) assert.throws(() => db.exec(sql), DUPLICATE_OR_APPEND_ONLY, `UPSERT ${what}`);
    // INSERT OR IGNORE sur une clé existante : refusé lui aussi par les triggers anti-REPLACE.
    assert.throws(() => db.exec("INSERT OR IGNORE INTO scans (id, reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 2, 2, 'C0000001', 99, 'x')"), /scans: duplicate/);
    assert.throws(() => db.exec("INSERT OR IGNORE INTO audit_log (id, at, action, details) VALUES (1, 'x', 'y', '{}')"), /append-only/);
    assert.throws(() => db.exec(`INSERT OR IGNORE INTO location_corrections (id, item_id, station_id, user_id, created_at) VALUES (1, 2, 1, 2, '${NOW}')`), /append-only/);
    assert.equal(state(), before, 'journaux intacts');
    // Une correction sans id imposé reste possible.
    db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (2, 1, 1, ?)').run(NOW);
    // Correction vers un poste ou par un compte inexistant : refusée par les clés étrangères.
    assert.throws(() => db.exec(`INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (1, 99, 1, '${NOW}')`), /FOREIGN KEY/);
    assert.throws(() => db.exec(`INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (1, 1, 99, '${NOW}')`), /FOREIGN KEY/);

    const corrections = (id) => db.prepare('SELECT COUNT(*) AS n FROM location_corrections WHERE item_id = ?').get(id).n;
    assert.equal(corrections(7), 3);
    db.prepare('DELETE FROM items WHERE id = 7').run();
    assert.equal(corrections(7), 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 9, 'journal des scans intact');
  } finally {
    db.close();
  }
});

// Requêtes réellement exécutées par une fonction (via un faux db.prepare), puis leurs plans.
function plansOf(db, fn) {
  const seen = [];
  fn({ prepare: (sql) => { seen.push(sql); return db.prepare(sql); } });
  return seen.map((sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split('?').length - 1).fill(1))
    .map((r) => r.detail));
}

// Aucun parcours complet des journaux, aucune matérialisation de tous les scans (ancienne vue).
const FULL_SCAN = /SCAN (s|s2|scans|c|c2|location_corrections|a|audit_log)\b|ranked|events|TEMP B-TREE/;

test('plans : fiche et liste lisent scans et corrections par leurs index, sans parcours ni matérialisation des journaux', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    db.exec('ANALYZE');
    // Fiche localisée par une correction : localisation, puis auteur de la correction.
    const [itemPlan, locationPlan, authorPlan] = plansOf(db, (spy) => getItem(spy, 2n));
    assert.ok(itemPlan.some((d) => /SEARCH items USING INTEGER PRIMARY KEY/.test(d)), itemPlan.join('\n'));
    for (const index of ['scans_by_uid', 'corrections_by_item']) {
      assert.ok(locationPlan.some((d) => new RegExp(`USING (COVERING )?INDEX ${index}`).test(d)), locationPlan.join('\n'));
    }
    // Étape U0 : « MATERIALIZE locations » est attendu (table d'une seule ligne, filtrée par
    // l'id de la fiche, inventory.js, withLocations) ; la vue item_locations, elle, n'est jamais
    // matérialisée pour tous les objets.
    assert.ok(!locationPlan.some((d) => /MATERIALIZE item_locations/.test(d) || FULL_SCAN.test(d)), locationPlan.join('\n'));
    assert.ok(locationPlan.some((d) => /SEARCH i USING INTEGER PRIMARY KEY/.test(d)), locationPlan.join('\n'));
    assert.ok(!locationPlan.some((d) => /SCAN i\b/.test(d)), locationPlan.join('\n'));
    assert.ok(authorPlan.some((d) => /INDEX corrections_by_item/.test(d)), authorPlan.join('\n'));
    assert.ok(!authorPlan.some((d) => FULL_SCAN.test(d)), authorPlan.join('\n'));

    const [listPlan] = plansOf(db, (spy) => listItems(spy, ''));
    for (const index of ['scans_by_uid', 'corrections_by_item']) {
      assert.ok(listPlan.some((d) => new RegExp(`USING (COVERING )?INDEX ${index}`).test(d)), listPlan.join('\n'));
    }
    // La liste calcule la localisation de chaque objet (deux lectures d'index par objet) ; elle
    // ne parcourt jamais les scans ni les corrections.
    assert.ok(!listPlan.some((d) => FULL_SCAN.test(d)), listPlan.join('\n'));

    const [historyPlan] = plansOf(db, (spy) => itemHistory(spy, 1));
    assert.ok(historyPlan.some((d) => /INDEX audit_by_entity/.test(d)), historyPlan.join('\n'));
    assert.ok(!historyPlan.some((d) => FULL_SCAN.test(d)), historyPlan.join('\n'));
  } finally {
    db.close();
  }
});
