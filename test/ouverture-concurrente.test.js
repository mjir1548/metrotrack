// Ouverture concurrente d'une base NEUVE (server/db.js) : deux « serve » (ou un « serve » et un
// « dev-seed ») lancés en même temps sur un fichier qui n'existe pas encore.
// Défaut corrigé : PRAGMA journal_mode = WAL était exécuté avant PRAGMA busy_timeout, et
// user_version était lu hors du BEGIN IMMEDIATE des migrations. Les deux ouvertures pouvaient
// échouer (« database is locked »), ou l'une rejouer une migration déjà faite par l'autre.
// Attendu : toutes les ouvertures réussissent, schéma à la dernière version, migrations
// appliquées une seule fois (une migration rejouée échouerait : CREATE TABLE sur une table
// existante, ADD COLUMN sur une colonne existante).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDb } from '../server/db.js';

const MIGRATIONS = join(import.meta.dirname, '..', 'server', 'migrations');
const LATEST = Math.max(...readdirSync(MIGRATIONS).filter((f) => /^[0-9]{3}_/.test(f)).map((f) => Number(f.slice(0, 3))));
const DB_MODULE = join(import.meta.dirname, '..', 'server', 'db.js');
const WORKERS = 4;
const ROUNDS = 5;

// Chaque thread a sa propre connexion. Top départ commun (Atomics) : toutes les ouvertures
// commencent au même instant sur le fichier absent.
const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { pathToFileURL } = require('node:url');
  (async () => {
    const { openDb } = await import(pathToFileURL(workerData.dbModule));
    const gate = new Int32Array(workerData.gate);
    Atomics.add(gate, 1, 1);
    Atomics.wait(gate, 0, 0);
    try {
      const db = openDb(workerData.dbPath);
      const version = db.prepare('PRAGMA user_version').get().user_version;
      db.close();
      parentPort.postMessage({ ok: true, version });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: err.message });
    }
  })().catch((err) => parentPort.postMessage({ ok: false, error: err.stack }));
`;

async function openConcurrently(dbPath) {
  const gate = new SharedArrayBuffer(8);
  const view = new Int32Array(gate);
  const results = [];
  const workers = Array.from({ length: WORKERS }, () => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { dbPath, gate, dbModule: DB_MODULE } });
    results.push(new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
    }));
    return worker;
  });
  while (Atomics.load(view, 1) < WORKERS) await new Promise((resolve) => setTimeout(resolve, 5));
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
  const out = await Promise.all(results);
  await Promise.all(workers.map((w) => w.terminate()));
  return out;
}

test(`ouverture concurrente d'une base neuve (${WORKERS} threads, ${ROUNDS} essais) : toutes réussissent, schéma à jour, migrations appliquées une fois`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-ouverture-'));
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const dbPath = join(dir, `neuve-${round}.db`);
      const results = await openConcurrently(dbPath);
      assert.deepEqual(results, Array(WORKERS).fill({ ok: true, version: LATEST }), `essai ${round}`);
      const db = openDb(dbPath);
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
        // Schéma complet et sans doublon : une table de chaque migration est là, une seule fois.
        const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
        for (const table of ['stations', 'readers', 'items', 'scans', 'users', 'sessions', 'audit_log', 'location_corrections']) {
          assert.equal(tables.filter((t) => t === table).length, 1, table);
        }
        assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('readers') WHERE name = 'name'").get(), 'migration 007 appliquée');
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Passage en WAL refusé sans erreur par SQLite (il renvoie alors le mode resté en place, par
// exemple sur un système de fichiers sans mémoire partagée) : simulé par une fausse connexion.
test('enableWal : mode renvoyé autre que « wal » → erreur claire au démarrage ; « memory » accepté pour :memory: seulement', async () => {
  const { enableWal } = await import('../server/db.js');
  const fake = (mode) => ({ prepare: () => ({ get: () => ({ journal_mode: mode }) }) });
  assert.throws(() => enableWal(fake('delete'), 'C:/partage/base.db'), /passage en mode WAL impossible \(mode « delete »\)/);
  assert.throws(() => enableWal(fake('memory'), 'C:/partage/base.db'), /mode « memory »/);
  assert.doesNotThrow(() => enableWal(fake('wal'), 'C:/data/base.db'));
  assert.doesNotThrow(() => enableWal(fake('memory'), ':memory:'));
});
