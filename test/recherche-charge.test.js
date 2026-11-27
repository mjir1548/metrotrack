// Charge de la recherche (étape U2) : 5 000 objets avec 5 propriétés chacun et 100 000 scans.
// Critère du plan (docs/ux/plan.md, U2) : réponse en moins de 100 ms côté serveur.
// node:sqlite est synchrone : ce temps est aussi celui pendant lequel le serveur ne traite rien
// d'autre (réception des trames comprise). Seuil absolu : MAX_MS sur la médiane, pour la fonction
// de recherche et pour la requête HTTPS complète (sur 127.0.0.1, TLS compris).
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
import { searchItems, normalizeQuery } from '../server/inventory.js';
import { makeTestCerts } from './tls-fixture.js';

const ITEMS = 5000;
const SCANS = 100_000;
const MAX_MS = 100;
const ROUNDS = 7;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const KINDS = ['Multimètre Fluke 87V', 'Oscilloscope Tektronix', 'Étuve Memmert', 'Pied à coulisse Mitutoyo', 'Alimentation Keysight'];
const uidOf = (i) => (0x30000000 + i).toString(16).toUpperCase();
// Saisies variées : peu de résultats, beaucoup, aucun (le pire cas : chaque fiche lit ses
// propriétés), numéro de série, numéro de puce, plusieurs mots.
const QUERIES = ['fluke 7', 'multi', 'e', 'zzzz', '41234567', '3000 1388', 'electronique revise', 'mitutoyo 4999'];

let dir, db, server, port, certs, token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-recherche-charge-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const at = new Date(T0).toISOString();
  db.exec('BEGIN');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste A', ?), (2, 'Poste B', ?)").run(at, at);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run(Buffer.alloc(32, 1), at, Buffer.alloc(32, 2), at);
  const item = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= ITEMS; i++) {
    const kind = KINDS[i % KINDS.length];
    item.run(i, uidOf(i), `${kind} n° ${i}`, JSON.stringify({
      'N° de série': String(41230000 + i), Marque: kind.split(' ')[1], Service: 'Électronique', Calibre: `Gamme étendue ${i}`, Note: 'Révisé en atelier',
    }), at, at);
  }
  const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const counters = [0, 0, 0];
  for (let i = 0; i < SCANS; i++) {
    const reader = (i % 2) + 1;
    scan.run(reader, reader, uidOf(1 + ((i * 7919) % ITEMS)), ++counters[reader], new Date(T0 + i * 60_000).toISOString());
  }
  db.exec('COMMIT');
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('charge', DUMMY_HASH, at).lastInsertRowid);
  token = createSession(db, userId);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function get(path) {
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

test(`searchItems sur ${ITEMS} objets avec propriétés : médiane < ${MAX_MS} ms pour chaque saisie`, (t) => {
  for (const q of QUERIES) {
    const query = normalizeQuery(q);
    searchItems(db, query); // échauffement
    const times = [];
    let result;
    for (let r = 0; r < ROUNDS; r++) {
      const start = performance.now();
      result = searchItems(db, query);
      times.push(performance.now() - start);
    }
    const ms = median(times);
    t.diagnostic(`« ${q} » : ${ms.toFixed(1)} ms (médiane de ${ROUNDS}), ${result.total} résultats`);
    assert.ok(ms < MAX_MS, `« ${q} » : ${ms.toFixed(1)} ms`);
    assert.ok(result.items.length <= 8);
  }
  // Résultats attendus sur cette base.
  assert.equal(searchItems(db, '41234567').total, 1);
  assert.equal(searchItems(db, '41234567').items[0].id, 4567);
  assert.equal(searchItems(db, 'zzzz').total, 0);
  assert.equal(searchItems(db, 'e').total, ITEMS);
});

test(`GET /api/recherche (HTTPS complet) : médiane < ${MAX_MS} ms`, async (t) => {
  for (const q of ['fluke 7', 'zzzz', 'e']) {
    const path = `/api/recherche?q=${encodeURIComponent(q)}`;
    await get(path);
    const times = [];
    for (let r = 0; r < ROUNDS; r++) {
      const res = await get(path);
      assert.equal(res.status, 200);
      times.push(res.ms);
    }
    const ms = median(times);
    t.diagnostic(`GET ${path} : ${ms.toFixed(1)} ms (médiane de ${ROUNDS})`);
    assert.ok(ms < MAX_MS, `${path} : ${ms.toFixed(1)} ms`);
  }
});
