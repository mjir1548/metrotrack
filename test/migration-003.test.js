// Migration 003 : vue item_locations réécrite sur l'index scans_by_uid.
// - passage d'une base en version 2 à la version 3, données et localisations conservées ;
// - équivalence exacte avec la définition de la migration 001 (row_number()) sur des données
//   variées : ex aequo à la milliseconde, puces sans fiche, fiches sans puce, lecteur non
//   affecté, lecteur réaffecté, données pseudo-aléatoires ;
// - plans de requête des lectures de l'inventaire : index utilisé, aucun parcours de tous les
//   scans, aucune matérialisation pour la fiche.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { getItem, listItems } from '../server/inventory.js';

const MIGRATIONS = join(import.meta.dirname, '..', 'server', 'migrations');
const NOW = '2026-11-17T10:00:00.000Z';
const KEY = Buffer.alloc(32, 7);
// Version la plus récente du schéma : les migrations suivantes (004...) s'appliquent aussi.
const LATEST = Math.max(...readdirSync(MIGRATIONS).filter((f) => /^[0-9]{3}_/.test(f)).map((f) => Number(f.slice(0, 3))));

// Définition de la vue dans la migration 001, recopiée ici comme référence.
const OLD_VIEW = `CREATE TEMP VIEW old_item_locations AS
WITH ranked AS (
  SELECT i.id AS item_id, s.station_id, s.received_at AS at, 'scan' AS source, s.reader_id,
         row_number() OVER (PARTITION BY i.id ORDER BY s.received_at DESC, s.id DESC) AS rn
    FROM items i JOIN scans s ON s.uid_nfc = i.uid_nfc
)
SELECT item_id, station_id, at, source, reader_id FROM ranked WHERE rn = 1`;

const rowsOf = (db, view) => db.prepare(`SELECT item_id, station_id, at, source, reader_id FROM ${view} ORDER BY item_id`).all()
  .map((r) => ({ ...r }));

function assertSameAsOld(db, what) {
  db.exec('DROP VIEW IF EXISTS temp.old_item_locations');
  db.exec(OLD_VIEW);
  const expected = rowsOf(db, 'old_item_locations');
  assert.deepEqual(rowsOf(db, 'item_locations'), expected, what);
  return expected;
}

// Données variées. Scans insérés directement (les colonnes sont celles du journal).
function seed(db) {
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?), (2, 'Poste 2', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?)')
    .run(KEY, NOW, KEY, NOW, KEY, NOW);
  const item = db.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  item.run(1, 'AAAA0001', 'Un scan', NOW, NOW);
  item.run(2, 'AAAA0002', 'Ex aequo à la milliseconde', NOW, NOW);
  item.run(3, 'AAAA0003', 'Dernier scan sur lecteur non affecté', NOW, NOW);
  item.run(4, 'AAAA0004', 'Puce jamais scannée', NOW, NOW);
  item.run(5, null, 'Sans puce', NOW, NOW);
  item.run(6, 'AAAA0006', 'Ex aequo, id inférieur plus récent', NOW, NOW);
  item.run(7, 'AAAA0007', 'Ordre d\'insertion différent de l\'ordre chronologique', NOW, NOW);
  const scan = db.prepare('INSERT INTO scans (id, reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?, ?)');
  let id = 0;
  const counters = [0, 0, 0, 0];
  const add = (reader, uid, at) => scan.run(++id, reader, reader === 3 ? null : reader, uid, ++counters[reader], at);
  add(1, 'AAAA0001', '2026-11-17T10:00:00.000Z');
  add(1, 'AAAA0002', '2026-11-17T10:01:00.000Z');
  add(2, 'AAAA0002', '2026-11-17T10:01:00.000Z'); // même milliseconde : id le plus grand gagne
  add(1, 'AAAA0003', '2026-11-17T10:02:00.000Z');
  add(3, 'AAAA0003', '2026-11-17T10:03:00.000Z'); // lecteur non affecté : station_id NULL
  add(2, 'FFFF0000', '2026-11-17T10:04:00.000Z'); // puce sans fiche
  add(3, 'FFFF0001', '2026-11-17T10:04:00.000Z'); // puce sans fiche, lecteur non affecté
  add(2, 'AAAA0007', '2026-11-17T10:09:00.000Z');
  add(1, 'AAAA0007', '2026-11-17T10:05:00.000Z'); // id plus grand mais plus ancien : perd
  add(2, 'AAAA0006', '2026-11-17T10:06:00.000Z');
  add(1, 'AAAA0006', '2026-11-17T10:06:00.000Z');
  add(3, 'AAAA0006', '2026-11-17T10:06:00.000Z'); // triple ex aequo : le dernier inséré gagne
  return id;
}

test('migration 003 : base en version 2 → dernière version, données conservées, localisations identiques, aucune migration rejouée', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-m003-'));
  try {
    const path = join(dir, 'v2.db');
    const v2 = new DatabaseSync(path);
    v2.exec('PRAGMA foreign_keys = ON');
    for (const file of ['001_init.sql', '002_users_sessions.sql']) v2.exec(readFileSync(join(MIGRATIONS, file), 'utf8'));
    v2.exec('PRAGMA user_version = 2');
    const scans = seed(v2);
    v2.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('alice', 'x', ?)").run(NOW);
    const before = rowsOf(v2, 'item_locations'); // vue de la migration 001
    v2.close();

    const db = openDb(path);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST);
      assert.deepEqual(rowsOf(db, 'item_locations'), before);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, scans);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 7);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
      // La vue est bien la nouvelle définition (sous-requête corrélée, sans row_number()).
      const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'view' AND name = 'item_locations'").get().sql;
      assert.doesNotMatch(sql, /row_number/i);
      assert.match(sql, /ORDER BY s2\.received_at DESC, s2\.id DESC/);
      // Journal toujours en ajout seul.
      assert.throws(() => db.exec('DELETE FROM scans'), /append-only/);
    } finally {
      db.close();
    }
    const again = openDb(path);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, LATEST);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vue 003 ≡ vue 001 : cas limites (ex aequo, puces sans fiche, fiches sans puce, lecteur non affecté)', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    const rows = assertSameAsOld(db, 'cas limites');
    const byItem = Object.fromEntries(rows.map((r) => [r.item_id, r]));
    assert.deepEqual(Object.keys(byItem).map(Number), [1, 2, 3, 6, 7]); // 4 (jamais scannée) et 5 (sans puce) absents
    assert.equal(byItem[2].reader_id, 2); // ex aequo : dernier reçu
    assert.equal(byItem[3].station_id, null); // lecteur non affecté
    assert.equal(byItem[3].reader_id, 3);
    assert.equal(byItem[6].reader_id, 3); // triple ex aequo
    assert.equal(byItem[7].at, '2026-11-17T10:09:00.000Z'); // le plus récent, pas le dernier inséré

    // Puce associée après coup à une fiche existante : localisée aussitôt, mêmes résultats.
    db.prepare("UPDATE items SET uid_nfc = 'FFFF0000' WHERE id = 5").run();
    assert.equal(assertSameAsOld(db, 'puce associée après coup').find((r) => r.item_id === 5).reader_id, 2);
    // Lecteur réaffecté : le poste figé dans le scan ne change pas.
    db.prepare('UPDATE readers SET station_id = 2 WHERE id = 1').run();
    assertSameAsOld(db, 'lecteur réaffecté');
  } finally {
    db.close();
  }
});

test('vue 003 ≡ vue 001 : données pseudo-aléatoires avec de nombreux ex aequo', () => {
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'P1', ?), (2, 'P2', ?), (3, 'P3', ?)").run(NOW, NOW, NOW);
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, 3, ?, ?), (4, NULL, ?, ?)')
      .run(KEY, NOW, KEY, NOW, KEY, NOW, KEY, NOW);
    const uid = (n) => (0xB0000000 + n).toString(16).toUpperCase();
    const item = db.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (let i = 1; i <= 300; i++) item.run(i, i % 7 === 0 ? null : uid(i), `Objet ${i}`, NOW, NOW);
    // Générateur congruentiel déterministe : même jeu de données à chaque exécution.
    let state = 12345;
    const rand = (n) => { state = (state * 1103515245 + 12345) % 2 ** 31; return Math.floor(state / 65536) % n; };
    const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
    const counters = [0, 0, 0, 0, 0];
    db.exec('BEGIN');
    for (let k = 0; k < 5000; k++) {
      const reader = rand(4) + 1;
      // Horodatages dans une fenêtre de 40 ms : beaucoup d'ex aequo à la milliseconde, dans le désordre.
      const at = new Date(Date.parse(NOW) + rand(40)).toISOString();
      scan.run(reader, reader === 4 ? null : reader, uid(rand(340) + 1), ++counters[reader], at); // > 300 : puces sans fiche
    }
    db.exec('COMMIT');
    const rows = assertSameAsOld(db, 'aléatoire');
    assert.ok(rows.length > 200, `${rows.length} objets localisés`);
    assert.ok(rows.some((r) => r.station_id === null));
  } finally {
    db.close();
  }
});

// Enregistre les requêtes réellement exécutées par une fonction de server/inventory.js, puis
// renvoie leurs plans (EXPLAIN QUERY PLAN), sans recopier leur texte.
function plansOf(db, fn) {
  const seen = [];
  fn({ prepare: (sql) => { seen.push(sql); return db.prepare(sql); } });
  return seen.map((sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(sql.split('?').length - 1).fill(1))
    .map((r) => r.detail));
}

test('plans : la fiche lit la localisation par l\'index, sans matérialiser la vue ; la liste ne parcourt jamais tous les scans', () => {
  const db = openDb(':memory:');
  try {
    seed(db);
    db.exec('ANALYZE');
    const [itemPlan, locationPlan] = plansOf(db, (spy) => getItem(spy, 1n));
    assert.ok(itemPlan.some((d) => /SEARCH items USING INTEGER PRIMARY KEY/.test(d)), itemPlan.join('\n'));
    assert.ok(locationPlan.some((d) => /USING (COVERING )?INDEX scans_by_uid/.test(d)), locationPlan.join('\n'));
    assert.ok(!locationPlan.some((d) => /MATERIALIZE|SCAN s\b|SCAN s2\b|SCAN scans|TEMP B-TREE/.test(d)), locationPlan.join('\n'));

    const [listPlan] = plansOf(db, (spy) => listItems(spy, ''));
    assert.ok(listPlan.some((d) => /USING (COVERING )?INDEX scans_by_uid/.test(d)), listPlan.join('\n'));
    // La liste calcule une localisation par objet (une lecture d'index chacune) : jamais un
    // parcours complet des scans, ni le row_number() de l'ancienne vue.
    assert.ok(!listPlan.some((d) => /SCAN s\b|SCAN s2\b|SCAN scans|ranked|TEMP B-TREE/.test(d)), listPlan.join('\n'));
  } finally {
    db.close();
  }
});
