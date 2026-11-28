// Étape U6 : coût des pages Postes (tuiles) et Lecteurs sur une base chargée : 200 postes,
// 300 lecteurs (dont 50 désactivés), 5 000 objets, 300 000 scans. Cible : moins de ~100 ms ;
// la borne du test est plus large pour ne pas dépendre de la machine (mesures dans le journal).
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
import { listStationSummaries } from '../server/stations.js';
import { withLocations } from '../server/inventory.js';
import { listReaders } from '../server/readers.js';
import { makeTestCerts } from './tls-fixture.js';

const STATIONS = 200;
const READERS = 300;
const ITEMS = 5000;
const SCANS = 300_000;
const BOUND_MS = 300;
let dir, db, server, port, certs, token;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u6c-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'charge.db'));
  const t0 = Date.parse('2026-11-01T00:00:00.000Z');
  const user = Number(db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('alice', ?, '2026-11-01T00:00:00.000Z')").run(DUMMY_HASH).lastInsertRowid);
  db.exec('BEGIN');
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${STATIONS})
           INSERT INTO stations (id, name, created_at) SELECT i, 'Poste ' || i, '2026-11-01T00:00:00.000Z' FROM n`);
  // Lecteurs 1 à 300 : affectés aux postes 1 à 200 (puis 1 à 100 une seconde fois) ; 251 à 300 désactivés.
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${READERS})
           INSERT INTO readers (id, station_id, aead_key, active, created_at)
           SELECT i, 1 + ((i - 1) % ${STATIONS}), zeroblob(32), CASE WHEN i > 250 THEN 0 ELSE 1 END, '2026-11-01T00:00:00.000Z' FROM n`);
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ITEMS})
           INSERT INTO items (uid_nfc, name, created_at, updated_at)
           SELECT printf('A%07X', i), 'Objet ' || i, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z' FROM n`);
  db.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${SCANS})
              INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at)
              SELECT 1 + (i % 250), 1 + (i % 250) % ${STATIONS}, printf('A%07X', 1 + (i * 7) % ${ITEMS}),
                     i, strftime('%Y-%m-%dT%H:%M:%fZ', (? + i * 1000) / 1000.0, 'unixepoch') FROM n`).run(t0);
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
    const start = performance.now();
    const req = request({ host: '127.0.0.1', port, path, headers: { Cookie: `__Host-mt_session=${token}` }, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), ms: performance.now() - start }));
    });
    req.on('error', reject);
    req.end();
  });
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

test(`/stations : ${STATIONS} tuiles (${ITEMS} objets, ${SCANS} scans), sous ${BOUND_MS} ms`, async (t) => {
  listStationSummaries(db); // échauffement
  const data = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now();
    listStationSummaries(db);
    data.push(performance.now() - start);
  }
  await get('/stations');
  const http = [];
  let res;
  for (let i = 0; i < 5; i++) {
    res = await get('/stations');
    http.push(res.ms);
  }
  t.diagnostic(`données des tuiles : ${median(data).toFixed(1)} ms ; GET /stations complet (HTTPS) : ${median(http).toFixed(1)} ms, ${Math.round(res.body.length / 1024)} Kio`);
  assert.equal(res.status, 200);
  assert.equal((res.body.match(/<li class="tuile[^"]*" data-poste=/g) ?? []).length, STATIONS);
  const total = [...res.body.matchAll(/<strong data-nombre>(\d[\d  ]*)<\/strong>/g)].reduce((sum, m) => sum + Number(m[1].replace(/\D/g, '')), 0);
  assert.equal(total, ITEMS, 'chaque objet compté une fois');
  assert.ok(median(http) < BOUND_MS, `${median(http)} ms`);
});

test('dernier arrivé de chaque poste : identique au calcul complet des arrivées de tous les objets', () => {
  // Référence : l'heure d'arrivée de TOUS les objets localisés (withLocations), maximum par poste.
  const expected = new Map();
  for (const row of db.prepare(`${withLocations('l.station_id IS NOT NULL')} SELECT station_id, item_id, arrived_at FROM locations`).all()) {
    const top = expected.get(row.station_id);
    if (!top || row.arrived_at > top.arrived_at || (row.arrived_at === top.arrived_at && row.item_id > top.item_id)) expected.set(row.station_id, row);
  }
  // Rescans fréquents d'objets arrivés depuis longtemps (le piège de la sélection par dernier événement).
  for (const station of listStationSummaries(db)) {
    const ref = expected.get(station.id);
    assert.deepEqual([station.last_arrival?.item_id ?? null, station.last_arrival?.arrived_at ?? null], [ref?.item_id ?? null, ref?.arrived_at ?? null], station.name);
  }
});

test(`/readers : ${READERS} lecteurs (50 désactivés repliés), sous ${BOUND_MS} ms`, async (t) => {
  listReaders(db);
  await get('/readers');
  const http = [];
  let res;
  for (let i = 0; i < 5; i++) {
    res = await get('/readers');
    http.push(res.ms);
  }
  t.diagnostic(`GET /readers complet (HTTPS) : ${median(http).toFixed(1)} ms, ${Math.round(res.body.length / 1024)} Kio`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<summary>Lecteurs désactivés (50)</summary>'));
  assert.ok(res.body.includes('250 lecteurs en service'));
  assert.ok(median(http) < BOUND_MS, `${median(http)} ms`);
});
