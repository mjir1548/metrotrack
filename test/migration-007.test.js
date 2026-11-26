// Migration 007 (D-019) : colonne readers.name.
// - base en version 6 avec des lecteurs et des scans → version 7 ;
// - données existantes intactes, nom vide pour les lecteurs existants ;
// - triggers, vues et index inchangés (même SQL), clés étrangères toujours vérifiées ;
// - CHECK de longueur (100) et NOT NULL ; migration non rejouée à la réouverture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';

const MIGRATIONS = join(import.meta.dirname, '..', 'server', 'migrations');
const T0 = '2026-11-26T08:00:00.000Z';
const OLD_READER_COLUMNS = 'id, station_id, aead_key, active, created_at';
const TABLES = ['stations', 'items', 'scans', 'location_corrections', 'audit_log', 'users'];

function makeV6(path) {
  const v6 = new DatabaseSync(path);
  v6.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(MIGRATIONS).filter((f) => /^00[1-6]_/.test(f)).sort()) {
    v6.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  v6.exec('PRAGMA user_version = 6');
  v6.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?)").run(T0);
  v6.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (1, 1, ?, 1, ?), (2, NULL, ?, 0, ?)')
    .run(Buffer.alloc(32, 1), T0, Buffer.alloc(32, 2), T0);
  v6.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, '04A1B2C3', 'Multimètre', ?, ?)").run(T0, T0);
  v6.prepare("INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, '04A1B2C3', 1, ?)").run(T0);
  return v6;
}

const schemaOf = (db, type) => db.prepare('SELECT name, sql FROM sqlite_schema WHERE type = ? ORDER BY name').all(type).map((r) => ({ ...r }));
const dump = (db) => JSON.stringify([
  db.prepare(`SELECT ${OLD_READER_COLUMNS} FROM readers ORDER BY id`).all(),
  ...TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()),
  db.prepare('SELECT * FROM item_locations ORDER BY item_id').all(),
]);

test('migration 007 : version 6 → 7, colonne name vide par défaut, données, triggers, vues et index intacts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-m007-'));
  try {
    const path = join(dir, 'v6.db');
    const v6 = makeV6(path);
    const before = dump(v6);
    const triggers = schemaOf(v6, 'trigger');
    const views = schemaOf(v6, 'view');
    const indexes = schemaOf(v6, 'index');
    v6.close();

    const db = openDb(path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
      assert.equal(dump(db), before, 'aucune donnée modifiée');
      assert.deepEqual(db.prepare('SELECT id, name FROM readers ORDER BY id').all().map((r) => ({ ...r })), [{ id: 1, name: '' }, { id: 2, name: '' }]);
      assert.deepEqual(schemaOf(db, 'trigger'), triggers);
      assert.deepEqual(schemaOf(db, 'view'), views);
      assert.deepEqual(schemaOf(db, 'index'), indexes);
      const column = db.prepare("SELECT * FROM pragma_table_info('readers') WHERE name = 'name'").get();
      assert.equal(column.type, 'TEXT');
      assert.equal(column.notnull, 1);
      assert.equal(column.dflt_value, "''");
      // CHECK : 100 caractères (points de code) au plus.
      db.prepare('UPDATE readers SET name = ? WHERE id = 1').run('ß'.repeat(100));
      assert.throws(() => db.prepare('UPDATE readers SET name = ? WHERE id = 1').run('ß'.repeat(101)), /CHECK constraint failed/);
      // Clés étrangères toujours actives sur readers.
      assert.throws(() => db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (3, 99, ?, ?)').run(Buffer.alloc(32), T0), /FOREIGN KEY/);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
      db.close();
    }
    // Réouverture : rien n'est rejoué (ADD COLUMN échouerait sur une colonne existante).
    const again = openDb(path);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 7);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
