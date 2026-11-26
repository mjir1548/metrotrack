// Migration 005 (étape 6) : trigger scans_no_replace recréé avec le message propre
// « scans: duplicate », index scans_by_station.
// - passage d'une base en version 4 (avec des données) à la version 5, données intactes ;
// - le trigger garde ses deux conditions (id, et couple lecteur/compteur) ;
// - ingestFrame reconnaît le nouveau message : un doublon atteint par la base est un rejeu
//   (rejet « replay », donc 400 côté HTTP), jamais une exception ;
// - l'ancien message « scans: append-only » n'est plus reconnu comme un rejeu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';

const MIGRATIONS = join(import.meta.dirname, '..', 'server', 'migrations');
const NOW = '2026-11-18T10:00:00.000Z';
const KEY = Buffer.alloc(32, 0x55);
const UID = '04A1B2C3D4E5F6';
const frame = (counter) => encodeFrame({ readerId: 1, counter, uid: Buffer.from(UID, 'hex'), key: KEY });

/** Base en version 4 (migrations 001 à 004 appliquées à la main), avec des données. */
function makeV4(path) {
  const v4 = new DatabaseSync(path);
  v4.exec('PRAGMA foreign_keys = ON');
  for (const file of ['001_init.sql', '002_users_sessions.sql', '003_item_locations_index.sql', '004_edition_audit.sql']) {
    v4.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  v4.exec('PRAGMA user_version = 4');
  v4.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'P1', ?), (2, 'P2', ?)").run(NOW, NOW);
  v4.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
  v4.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', ?)").run(NOW);
  v4.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, NOW, NOW);
  const scan = v4.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, ?, ?, ?, ?)');
  scan.run(1, UID, 1, NOW);
  scan.run(2, UID, 2, NOW);
  v4.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (1, 2, 1, ?)').run('2026-11-18T11:00:00.000Z');
  v4.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, 1, 'item.location_correct', 1, '{}')").run(NOW);
  // Avant migration : l'ancien message.
  assert.throws(() => v4.exec(`INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, '${UID}', 1, 'x')`), /^Error: scans: append-only$/);
  return v4;
}

const dump = (db) => JSON.stringify(['stations', 'readers', 'items', 'scans', 'location_corrections', 'audit_log']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const dumpView = (db) => JSON.stringify(db.prepare('SELECT * FROM item_locations ORDER BY item_id').all());

test('migration 005 : base en version 4 avec des données → version 5, données intactes, trigger et index créés', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-m005-'));
  try {
    const path = join(dir, 'v4.db');
    const v4 = makeV4(path);
    const before = JSON.stringify(['stations', 'readers', 'items', 'scans', 'location_corrections', 'audit_log']
      .map((t) => v4.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
    const locations = dumpView(v4);
    v4.close();

    const db = openDb(path);
    try {
      // openDb applique aussi la migration 006 (index scans_by_uid élargi, étape U0).
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
      // readers : colonnes d'avant la migration 007 (D-019), qui ajoute readers.name.
      assert.equal(JSON.stringify(['stations', 'readers', 'items', 'scans', 'location_corrections', 'audit_log']
        .map((t) => db.prepare(`SELECT ${t === 'readers' ? 'id, station_id, aead_key, active, created_at' : '*'} FROM ${t} ORDER BY rowid`).all())), before);
      assert.equal(dumpView(db), locations);
      const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'scans_no_replace'").get().sql;
      assert.match(trigger, /RAISE\(ABORT, 'scans: duplicate'\)/);
      assert.match(trigger, /WHERE id = NEW\.id/);
      assert.match(trigger, /WHERE reader_id = NEW\.reader_id AND counter = NEW\.counter/);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'trigger' AND name = 'scans_no_replace'").get().n, 1);
      const index = db.prepare("SELECT tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND name = 'scans_by_station'").get();
      assert.equal(index.tbl_name, 'scans');
      assert.match(index.sql, /ON scans \(station_id\)/);
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

      // Les deux conditions du trigger, avec le nouveau message ; les autres triggers inchangés.
      const state = dump(db);
      for (const sql of [
        `INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, '${UID}', 2, 'x')`,
        `INSERT OR REPLACE INTO scans (id, reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 1, '${UID}', 99, 'x')`,
        `INSERT OR IGNORE INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, '${UID}', 1, 'x')`,
        `INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, '${UID}', 1, 'x') ON CONFLICT (reader_id, counter) DO UPDATE SET uid_nfc = 'DEADBEEF'`,
      ]) {
        assert.throws(() => db.exec(sql), (err) => err.errcode === 1811 && err.message === 'scans: duplicate', sql);
      }
      assert.throws(() => db.exec('UPDATE scans SET station_id = 2'), /^Error: scans: append-only$/);
      assert.throws(() => db.exec('DELETE FROM scans'), /^Error: scans: append-only$/);
      assert.equal(dump(db), state, 'journaux intacts');

      // Ingestion normale après migration : compteur suivant accepté, rejeu refusé.
      assert.equal(ingestFrame(db, frame(3), NOW).ok, true);
      assert.deepEqual(ingestFrame(db, frame(3), NOW), { ok: false, reason: 'replay', readerId: 1 });
    } finally {
      db.close();
    }
    const again = openDb(path); // aucune migration rejouée
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 7);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Base dont la lecture du dernier compteur répond 0 : les pré-vérifications d'ingestFrame sont
// contournées, seule la base peut refuser le doublon (trigger, avec son message).
function blind(db) {
  return {
    prepare: (sql) => (sql.includes('MAX(counter)') ? { get: () => ({ c: 0 }) } : db.prepare(sql)),
    exec: (sql) => db.exec(sql),
    get isTransaction() { return db.isTransaction; },
  };
}

test('ingestion : le doublon refusé par le trigger (« scans: duplicate ») est un rejeu, jamais une exception', () => {
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'P1', ?)").run(NOW);
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
    assert.equal(ingestFrame(db, frame(5), NOW).ok, true);
    assert.deepEqual(ingestFrame(blind(db), frame(5), NOW), { ok: false, reason: 'replay', readerId: 1 });
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM scans').get().n, 1);
  } finally {
    db.close();
  }
});

test('ingestion : un autre trigger qui répondrait « scans: append-only » à l\'insertion n\'est PAS pris pour un rejeu (exception relancée)', () => {
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'P1', ?)").run(NOW);
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
    db.exec("CREATE TEMP TRIGGER autre_refus BEFORE INSERT ON scans BEGIN SELECT RAISE(ABORT, 'scans: append-only'); END");
    assert.throws(() => ingestFrame(db, frame(1), NOW), /scans: append-only/);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM scans').get().n, 0);
  } finally {
    db.close();
  }
});
