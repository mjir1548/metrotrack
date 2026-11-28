// Étape U4 : coût de l'écran d'accueil sur une base chargée (5 000 objets, 300 000 scans, 5 000
// puces inconnues, 2 000 corrections). Cible : moins de ~100 ms côté serveur ; la borne du test
// est plus large pour ne pas dépendre de la machine (la mesure est écrite dans le journal du test).
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
import { homeData, HOME_MOVEMENTS } from '../server/accueil.js';
import { makeTestCerts } from './tls-fixture.js';

const ITEMS = 5000;
const SCANS = 300_000;
const UNKNOWN = 5000;
const BOUND_MS = 300;
let dir, db, server, port, certs, token;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u4c-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'charge.db'));
  const t0 = Date.parse('2026-11-01T00:00:00.000Z');
  const user = Number(db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('alice', ?, '2026-11-01T00:00:00.000Z')").run(DUMMY_HASH).lastInsertRowid);
  db.exec('BEGIN');
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
           INSERT INTO stations (id, name, created_at) SELECT i, 'Poste ' || i, '2026-11-01T00:00:00.000Z' FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
           INSERT INTO readers (id, station_id, aead_key, created_at) SELECT i, i, zeroblob(32), '2026-11-01T00:00:00.000Z' FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ITEMS})
           INSERT INTO items (uid_nfc, name, created_at, updated_at)
           SELECT printf('A%07X', i), 'Objet ' || i, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z' FROM n`);
  // Scans : chaque objet passe de poste en poste ; une puce inconnue de temps en temps.
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SCANS})
              INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at)
              SELECT 1 + (i % 10), 1 + (i % 10),
                     CASE WHEN i % 60 = 0 THEN printf('B%07X', (i / 60) % ${UNKNOWN}) ELSE printf('A%07X', 1 + (i * 7) % ${ITEMS}) END,
                     i, strftime('%Y-%m-%dT%H:%M:%fZ', (? + i * 1000) / 1000.0, 'unixepoch') FROM n`).run(t0);
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
              INSERT INTO location_corrections (item_id, station_id, user_id, created_at)
              SELECT 1 + (i * 13) % ${ITEMS}, 1 + (i % 10), ?, strftime('%Y-%m-%dT%H:%M:%fZ', (? + i * 150000) / 1000.0, 'unixepoch') FROM n`).run(user, t0);
  db.exec('COMMIT');
  token = createSession(db, user);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {} });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve();
  }));
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function get(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Cookie: `__Host-mt_session=${token}` }, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test(`accueil sur base chargée (${ITEMS} objets, ${SCANS} scans, ${UNKNOWN} puces inconnues) : contenu complet, sous ${BOUND_MS} ms`, async (t) => {
  homeData(db); // échauffement
  const server_ms = [];
  let data;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    data = homeData(db);
    server_ms.push(performance.now() - start);
  }
  assert.equal(data.movements.length, HOME_MOVEMENTS);
  assert.equal(data.chips.total, UNKNOWN);
  assert.equal(data.chips.chips.length, 3);
  assert.equal(data.counts.items, ITEMS);
  const http_ms = [];
  let res;
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    res = await get('/');
    http_ms.push(performance.now() - start);
  }
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(`Voir les ${(UNKNOWN).toLocaleString('fr-FR')} puces inconnues`));
  t.diagnostic(`homeData : médiane ${median(server_ms).toFixed(1)} ms ; GET / (HTTPS complet) : médiane ${median(http_ms).toFixed(1)} ms`);
  assert.ok(median(server_ms) < BOUND_MS, `homeData ${median(server_ms)} ms`);
  assert.ok(median(http_ms) < BOUND_MS, `GET / ${median(http_ms)} ms`);
});
