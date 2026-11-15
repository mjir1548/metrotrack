// Concurrence au niveau base : plusieurs connexions SQLite (threads distincts) sur le même
// fichier traitent des trames en même temps. Vérifie que BEGIN IMMEDIATE + re-vérification
// du compteur garantissent un seul enregistrement par (lecteur, compteur).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDb } from '../server/db.js';
import { encodeFrame } from '../server/protocol.js';

const KEY = Buffer.alloc(32, 0x33);
const NOW = '2026-11-15T10:00:00.000Z';
const WORKERS = 4;
let dir, dbPath, db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-concurrence-'));
  dbPath = join(dir, 'test.db');
  db = openDb(dbPath);
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// Chaque thread ouvre sa propre connexion, attend le top départ commun (Atomics), puis
// traite la liste de trames reçue. Renvoie la liste des résultats.
const WORKER_SOURCE = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { pathToFileURL } = require('node:url');
  (async () => {
    const { openDb } = await import(pathToFileURL(workerData.dbModule));
    const { ingestFrame } = await import(pathToFileURL(workerData.ingestModule));
    const db = openDb(workerData.dbPath);
    const gate = new Int32Array(workerData.gate);
    Atomics.add(gate, 1, 1);
    Atomics.wait(gate, 0, 0);
    const results = workerData.frames.map((hex) => {
      const r = ingestFrame(db, Buffer.from(hex, 'hex'));
      return r.ok ? 'ok' : r.reason;
    });
    db.close();
    parentPort.postMessage(results);
  })().catch((err) => parentPort.postMessage({ error: err.stack }));
`;

async function runConcurrently(framesPerWorker) {
  const gate = new SharedArrayBuffer(8);
  const view = new Int32Array(gate);
  const workerData = (frames) => ({
    dbPath,
    frames,
    gate,
    dbModule: join(import.meta.dirname, '..', 'server', 'db.js'),
    ingestModule: join(import.meta.dirname, '..', 'server', 'ingest.js'),
  });
  const workers = framesPerWorker.map((frames) => new Worker(WORKER_SOURCE, { eval: true, workerData: workerData(frames) }));
  const done = workers.map((w) => new Promise((resolve, reject) => {
    w.once('message', (msg) => (msg.error ? reject(new Error(msg.error)) : resolve(msg)));
    w.once('error', reject);
  }));
  // Top départ quand tous les threads sont prêts.
  while (Atomics.load(view, 1) < workers.length) await new Promise((r) => setTimeout(r, 5));
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
  return (await Promise.all(done)).flat();
}

const hex = (counter) => encodeFrame({ readerId: 1, counter, uid: Buffer.from('DEADBEEF', 'hex'), key: KEY }).toString('hex');
const scanCount = () => db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;

test(`même trame traitée en même temps par ${WORKERS} connexions : un seul scan`, async () => {
  const before = scanCount();
  const results = await runConcurrently(Array.from({ length: WORKERS }, () => [hex(1)]));
  assert.equal(results.filter((r) => r === 'ok').length, 1, results.join(','));
  assert.ok(results.every((r) => r === 'ok' || r === 'replay'), results.join(','));
  assert.equal(scanCount(), before + 1);
});

test(`compteurs croissants répartis sur ${WORKERS} connexions : aucun doublon, aucune erreur SQLite`, async () => {
  // Chaque thread envoie une suite croissante entrelacée (thread k : 100+k, 100+k+4, ...).
  // Selon l'entrelacement, certaines peuvent être rejetées comme « replay » (compteur dépassé),
  // mais jamais enregistrées deux fois ni provoquer d'exception (SQLITE_BUSY, contrainte).
  const per = Array.from({ length: WORKERS }, (_, k) => Array.from({ length: 10 }, (_, i) => hex(100 + k + i * WORKERS)));
  const before = scanCount();
  const results = await runConcurrently(per);
  assert.ok(results.every((r) => r === 'ok' || r === 'replay'), results.join(','));
  const accepted = results.filter((r) => r === 'ok').length;
  assert.equal(scanCount(), before + accepted);
  // Le plus grand compteur ne peut être dépassé par aucun autre : il est toujours accepté.
  assert.equal(db.prepare('SELECT MAX(counter) AS c FROM scans').get().c, 100 + (WORKERS - 1) + 9 * WORKERS);
  const dup = db.prepare('SELECT counter, COUNT(*) n FROM scans GROUP BY reader_id, counter HAVING n > 1').all();
  assert.deepEqual(dup, []);
});
