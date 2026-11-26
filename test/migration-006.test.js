// Migration 006 (étape U0) : index scans_by_uid remplacé par (uid_nfc, received_at, id, station_id).
// - base en version 5 (migrations 001 à 005 appliquées à la main) avec des historiques variés
//   (allers-retours, lecteur non affecté, corrections, puce changée, égalités à la
//   milliseconde) → version 6 ;
// - aucune donnée modifiée, vue item_locations identique ligne à ligne ;
// - heure d'arrivée (withLocations) égale à une référence en JS, par la liste, la fiche et le poste ;
// - un seul index par uid (l'ancien est remplacé, pas doublé), aucune migration rejouée ;
// - la remontée de la série et le dernier scan lisent l'index sans toucher la table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openDb } from '../server/db.js';
import { listItems, getItem } from '../server/inventory.js';
import { stationItems } from '../server/stations.js';

const MIGRATIONS = join(import.meta.dirname, '..', 'server', 'migrations');
const T0 = Date.parse('2026-11-02T08:00:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const TABLES = ['stations', 'readers', 'items', 'scans', 'location_corrections', 'audit_log', 'users'];
const uidOf = (i) => (0x0A000000 + i).toString(16).toUpperCase().padStart(8, '0');

/** Base en version 5 avec 40 objets aux historiques pseudo-aléatoires (graine fixe). */
function makeV5(path) {
  const v5 = new DatabaseSync(path);
  v5.exec('PRAGMA foreign_keys = ON');
  for (const file of ['001_init.sql', '002_users_sessions.sql', '003_item_locations_index.sql', '004_edition_audit.sql', '005_postes_lecteurs.sql']) {
    v5.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
  }
  v5.exec('PRAGMA user_version = 5');
  v5.exec('BEGIN'); // une seule écriture disque pour tout le jeu de données
  for (let s = 1; s <= 3; s++) v5.prepare('INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?)').run(s, `Poste ${s}`, at(0));
  // Lecteurs 1 à 3 → postes 1 à 3 ; lecteur 4 non affecté.
  for (const [id, station] of [[1, 1], [2, 2], [3, 3], [4, null]]) {
    v5.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (?, ?, ?, ?)').run(id, station, Buffer.alloc(32, id), at(0));
  }
  v5.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', ?)").run(at(0));
  for (let i = 1; i <= 40; i++) {
    v5.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(i, i === 40 ? null : uidOf(i), `Objet ${i}`, at(0), at(0));
  }
  let seed = 2026;
  const rnd = (n) => { seed = (seed * 48271) % 2147483647; return seed % n; };
  const counters = [0, 0, 0, 0, 0];
  const scan = v5.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) SELECT id, station_id, ?, ?, ? FROM readers WHERE id = ?');
  const correction = v5.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, 1, ?)');
  let minute = 1;
  for (let k = 0; k < 1500; k++) {
    // Égalités à la milliseconde fréquentes : une fois sur quatre, même heure que l'événement précédent.
    if (rnd(4) !== 0) minute += 1 + rnd(30);
    const item = 1 + rnd(40);
    if (rnd(10) === 0) {
      correction.run(item, 1 + rnd(3), at(minute));
    } else if (item !== 40) {
      const reader = 1 + rnd(4);
      scan.run(rnd(15) === 0 ? 'FFFFFF00' : uidOf(item), ++counters[reader], at(minute), reader);
    }
  }
  // Puce changée : l'objet 1 porte désormais une puce qui n'a qu'un scan, au poste 2 ; les
  // scans de son ancienne puce ne comptent plus.
  v5.prepare("UPDATE items SET uid_nfc = 'ABCDEF01' WHERE id = 1").run();
  scan.run('ABCDEF01', ++counters[2], at(minute + 1), 2);
  // Un objet immobile : 300 scans au même poste après un seul départ.
  scan.run(uidOf(2), ++counters[1], at(minute + 2), 1);
  for (let k = 0; k < 300; k++) scan.run(uidOf(2), ++counters[3], at(minute + 3 + k), 3);
  v5.exec('COMMIT');
  return v5;
}

/** Référence en JS, sans SQL : dernière série ininterrompue au même emplacement. */
function reference(db, itemId) {
  const item = db.prepare('SELECT uid_nfc FROM items WHERE id = ?').get(itemId);
  const events = [
    ...db.prepare('SELECT received_at AS t, 0 AS kind, id, station_id FROM scans WHERE uid_nfc = ?').all(item.uid_nfc ?? ''),
    ...db.prepare('SELECT created_at AS t, 1 AS kind, id, station_id FROM location_corrections WHERE item_id = ?').all(itemId),
  ].sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.kind - y.kind || x.id - y.id));
  if (events.length === 0) return { at: null, arrived: null, station: null };
  const last = events.at(-1);
  let first = events.length - 1;
  while (first > 0 && events[first - 1].station_id === last.station_id) first -= 1;
  return { at: last.t, arrived: events[first].t, station: last.station_id };
}

const dumpTables = (db) => JSON.stringify(TABLES.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const dumpView = (db) => JSON.stringify(db.prepare('SELECT * FROM item_locations ORDER BY item_id').all());
const indexesOnScans = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'scans' AND sql IS NOT NULL ORDER BY name").all()
  .map((r) => ({ ...r }));

test('migration 006 : base en version 5 avec des données → version 6, données et localisations identiques, arrivée exacte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-m006-'));
  try {
    const path = join(dir, 'v5.db');
    const v5 = makeV5(path);
    assert.deepEqual(indexesOnScans(v5).find((r) => r.name === 'scans_by_uid').sql, 'CREATE INDEX scans_by_uid ON scans (uid_nfc, received_at)');
    const tablesBefore = dumpTables(v5);
    const viewBefore = dumpView(v5);
    v5.close();

    const db = openDb(path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 6);
      assert.equal(dumpTables(db), tablesBefore, 'aucune donnée modifiée');
      assert.equal(dumpView(db), viewBefore, 'vue item_locations identique');
      assert.deepEqual(indexesOnScans(db), [
        { name: 'scans_by_station', sql: 'CREATE INDEX scans_by_station ON scans (station_id)' },
        { name: 'scans_by_uid', sql: 'CREATE INDEX scans_by_uid ON scans (uid_nfc, received_at, id, station_id)' },
      ], 'l\'ancien index est remplacé, pas doublé');
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

      // Arrivée : liste, fiche et poste concordent avec la référence, pour chaque objet.
      const list = new Map(listItems(db, '').map((row) => [row.id, row]));
      let moved = 0;
      for (let id = 1; id <= 40; id++) {
        const ref = reference(db, id);
        const row = list.get(id);
        const item = getItem(db, BigInt(id));
        assert.equal(row.at, ref.at, `objet ${id} : dernier événement (liste)`);
        assert.equal(row.arrived_at, ref.arrived, `objet ${id} : arrivée (liste)`);
        assert.equal(item.arrived_at, ref.arrived, `objet ${id} : arrivée (fiche)`);
        assert.equal(item.station_id, ref.at === null ? null : ref.station, `objet ${id} : emplacement`);
        if (ref.station !== null && ref.at !== null) {
          const onStation = stationItems(db, ref.station).find((r) => r.id === id);
          assert.equal(onStation?.arrived_at, ref.arrived, `objet ${id} : arrivée (poste)`);
        }
        if (ref.arrived !== ref.at) moved += 1;
      }
      assert.ok(moved >= 5, `jeu de données assez varié : ${moved} objets rescannés au même endroit`);
      // Cas construits : puce changée, objet immobile.
      assert.equal(getItem(db, 1n).arrived_at, getItem(db, 1n).at, 'objet 1 : seule la nouvelle puce compte');
      const immobile = getItem(db, 2n);
      assert.equal(immobile.station_id, 3);
      assert.notEqual(immobile.arrived_at, immobile.at);
      assert.equal(immobile.arrived_at, db.prepare("SELECT min(received_at) AS t FROM scans WHERE uid_nfc = ? AND station_id = 3 AND received_at > (SELECT max(received_at) FROM scans WHERE uid_nfc = ? AND station_id IS NOT 3)").get(uidOf(2), uidOf(2)).t);

      // Remontée de la série et dernier scan : index seul (covering), jamais la table scans.
      const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT s.received_at FROM scans s
         WHERE s.uid_nfc = ? AND s.station_id IS NOT ? ORDER BY s.received_at DESC, s.id DESC LIMIT 1`).all(uidOf(2), 3).map((r) => r.detail);
      assert.ok(plan.some((d) => /USING COVERING INDEX scans_by_uid/.test(d)), plan.join('\n'));
      assert.ok(!plan.some((d) => /TEMP B-TREE/.test(d)), `aucun tri : ${plan.join('\n')}`);
    } finally {
      db.close();
    }
    const again = openDb(path); // aucune migration rejouée
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 6);
    assert.equal(indexesOnScans(again).length, 2);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migration 006 : échec au milieu (index absent) → base laissée en version 5, rien de modifié', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-m006b-'));
  try {
    const path = join(dir, 'v5.db');
    const v5 = makeV5(path);
    // Base abîmée : l'index attendu n'existe plus, le DROP INDEX de la migration échoue.
    v5.exec('DROP INDEX scans_by_uid');
    const before = dumpTables(v5);
    v5.close();
    // Dans un processus à part : openDb ne referme pas la base quand une migration échoue (sans
    // effet en production, où le processus s'arrête alors ; mais sous Windows le fichier resterait
    // verrouillé et le dossier temporaire ne pourrait pas être supprimé).
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { openDb } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'server', 'db.js')).href)};
       try { openDb(${JSON.stringify(path)}); } catch (err) { console.error(err.message); process.exit(3); }`], { encoding: 'utf8' });
    assert.equal(child.status, 3, child.stderr);
    assert.match(child.stderr, /migration 006_scans_by_uid_station\.sql échouée/);
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(after.prepare('PRAGMA user_version').get().user_version, 5, 'transaction annulée');
      assert.equal(dumpTables(after), before);
      assert.equal(indexesOnScans(after).find((r) => r.name === 'scans_by_uid'), undefined, 'aucun index à moitié créé');
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
