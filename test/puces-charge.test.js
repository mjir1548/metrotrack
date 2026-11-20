// Charge (étape 7, revue B1) : 50 000 puces inconnues distinctes, comme un journal rempli de
// faux UID par un lecteur compromis, plus 1 000 objets scannés. Serveur HTTPS en processus.
// La page /chips ne montre que les MAX_UNKNOWN_CHIPS puces les plus récentes et répond vite :
// la réception des trames (même processus, node:sqlite synchrone) n'est pas bloquée longtemps.
// Borne large (machine lente) : on vérifie l'absence de dégradation grossière.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession } from '../server/sessions.js';
import { MAX_UNKNOWN_CHIPS } from '../server/chips.js';
import { makeTestCerts } from './tls-fixture.js';

const UNKNOWN = 50_000;
const ITEMS = 1000;
const KNOWN_SCANS = 20_000;
const MAX_MS = 2_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

let dir, db, server, port, certs, token;
const logs = [];
const unknownUid = (i) => (0x40000000 + i).toString(16).toUpperCase();
const knownUid = (i) => (0x10000000 + i).toString(16).toUpperCase();

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-puces-charge-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const at = new Date(T0).toISOString();
  db.exec('BEGIN');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?)").run(at);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(Buffer.alloc(32, 1), at);
  const item = db.prepare('INSERT INTO items (uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
  for (let i = 0; i < ITEMS; i++) item.run(knownUid(i), `Objet ${i}`, at, at);
  const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, ?, ?, ?)');
  let counter = 0;
  for (let i = 0; i < KNOWN_SCANS; i++) scan.run(knownUid(i % ITEMS), ++counter, new Date(T0 + counter * 1000).toISOString());
  for (let i = 0; i < UNKNOWN; i++) scan.run(unknownUid(i), ++counter, new Date(T0 + counter * 1000).toISOString());
  db.exec('COMMIT');
  const userId = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('charge', DUMMY_HASH, at).lastInsertRowid;
  token = createSession(db, userId);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => logs.push(l), loginFailureDelayMs: 0 });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function page(path) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = request({ host: '127.0.0.1', port, path, ca: certs.ca, agent: false, headers: { Cookie: `__Host-mt_session=${token}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), ms: performance.now() - start }));
    });
    req.on('error', reject);
    req.end();
  });
}

test(`${UNKNOWN} puces inconnues : /chips n'affiche que les ${MAX_UNKNOWN_CHIPS} plus récentes, en moins de ${MAX_MS} ms`, async (t) => {
  await page('/chips'); // échauffement
  const res = await page('/chips');
  t.diagnostic(`GET /chips : ${Math.round(res.ms)} ms, ${Math.round(res.body.length / 1024)} Kio`);
  assert.equal(res.status, 200);
  const uids = [...res.body.matchAll(/<span class="uid uid-puce">([0-9A-F]+)<\/span>/g)].map((m) => m[1]);
  assert.equal(uids.length, MAX_UNKNOWN_CHIPS);
  // Les plus récentes : les derniers UID scannés, dans l'ordre inverse.
  assert.deepEqual(uids, Array.from({ length: MAX_UNKNOWN_CHIPS }, (_, i) => unknownUid(UNKNOWN - 1 - i)));
  assert.ok(res.body.includes(`Plus de ${MAX_UNKNOWN_CHIPS} puces inconnues · les ${MAX_UNKNOWN_CHIPS} plus récentes sont affichées.`));
  assert.ok(res.body.length < 200 * 1024, `${res.body.length} octets`);
  assert.ok(res.ms < MAX_MS, `${Math.round(res.ms)} ms`);
});

test('aucune erreur interne pendant la charge', () => {
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));
});
