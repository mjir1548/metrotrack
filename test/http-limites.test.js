// Cas limites HTTP contre un vrai serveur (port éphémère, base temporaire sur disque) :
// tailles extrêmes, Content-Type, lecteur désactivé, ordre des compteurs, envois concurrents,
// et uniformité des réponses de rejet.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request, Agent } from 'node:http';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';

const KEY = Buffer.alloc(32, 0x11);
const KEY2 = Buffer.alloc(32, 0x22);
const NOW = '2026-11-15T10:00:00.000Z';
const UID = Buffer.from('04A1B2C3D4E5F6', 'hex');
let dir, db, server, port;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-limites-'));
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 1, ?, ?)').run(KEY, NOW, KEY2, NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, '04A1B2C3D4E5F6', 'Multimètre', ?, ?)").run(NOW, NOW);
  server = createFrameServer(db, { log: (line) => logs.push(line) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const frame = (counter, { readerId = 1, key = KEY, uid = UID } = {}) => encodeFrame({ readerId, counter, uid, key });
const scanCount = () => db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;
const maxCounter = (readerId = 1) =>
  db.prepare('SELECT COALESCE(MAX(counter), 0) AS c FROM scans WHERE reader_id = ?').get(readerId).c;

/**
 * POST brut via node:http. headers null = aucun en-tête ajouté (ni Content-Type).
 * Renvoie le code, le corps et les en-têtes (hors Date).
 */
function post(body, { contentType = 'application/octet-stream', agent = false, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (contentType !== null) headers['Content-Type'] = contentType;
    if (!chunked) headers['Content-Length'] = body.length;
    const req = request({ host: '127.0.0.1', port, path: '/api/frames', method: 'POST', headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const { date, ...rest } = res.headers;
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).length, headers: rest });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('trames de 0, 35, 37, 1000 et 100 000 octets : 400 sans corps, aucun scan', async () => {
  const before = scanCount();
  const bodies = [
    Buffer.alloc(0),
    frame(1).subarray(0, 35),
    Buffer.concat([frame(1), Buffer.alloc(1)]),
    Buffer.concat([frame(1), Buffer.alloc(964, 0xab)]),
    Buffer.alloc(100_000, 0xcd),
  ];
  for (const body of bodies) {
    const res = await post(body);
    assert.equal(res.status, 400, `${body.length} octets`);
    assert.equal(res.body, 0, `${body.length} octets`);
  }
  // 1000 octets en flux (chunked, sans Content-Length) : coupé au plafond.
  assert.equal((await post(Buffer.alloc(1000), { chunked: true })).status, 400);
  assert.equal(scanCount(), before);
});

test('Content-Type absent ou faux : 400 ; casse et paramètre tolérés', async () => {
  const c = maxCounter() + 1;
  for (const contentType of [null, 'text/plain', 'application/json', 'application/octet-streamx']) {
    assert.equal((await post(frame(c), { contentType })).status, 400, String(contentType));
  }
  assert.equal((await post(frame(c), { contentType: 'Application/Octet-Stream; foo=bar' })).status, 204);
});

test('lecteur actif accepté, puis désactivé en base : ses trames suivantes donnent 400', async () => {
  assert.equal((await post(frame(1, { readerId: 2, key: KEY2 }))).status, 204);
  db.exec('UPDATE readers SET active = 0 WHERE id = 2');
  const before = scanCount();
  assert.equal((await post(frame(2, { readerId: 2, key: KEY2 }))).status, 400);
  assert.equal(scanCount(), before);
  assert.match(logs.at(-1), /cause=inactive_reader, reader_id annoncé=2/);
  db.exec('UPDATE readers SET active = 1 WHERE id = 2');
});

test('trames dans le désordre : compteur 5 puis 3 → 3 rejeté (limite v0 documentée, protocole.md §5)', async () => {
  const base = maxCounter();
  assert.equal((await post(frame(base + 5))).status, 204);
  assert.equal((await post(frame(base + 3))).status, 400);
  assert.match(logs.at(-1), /cause=replay/);
  // Le compteur suivant reste accepté.
  assert.equal((await post(frame(base + 6))).status, 204);
});

test('20 envois concurrents de compteurs différents : tous acceptés', async () => {
  const base = maxCounter();
  const before = scanCount();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => post(frame(base + 1 + i))));
  assert.deepEqual(results.map((r) => r.status), Array(20).fill(204));
  assert.equal(scanCount(), before + 20);
  // Un seul scan par compteur.
  const counters = db.prepare('SELECT counter FROM scans WHERE reader_id = 1 AND counter > ? ORDER BY counter').all(base);
  assert.deepEqual(counters.map((r) => r.counter), Array.from({ length: 20 }, (_, i) => base + 1 + i));
});

test('20 envois concurrents de la MÊME trame : exactement un 204, dix-neuf 400', async () => {
  const f = frame(maxCounter() + 1);
  const before = scanCount();
  const statuses = (await Promise.all(Array.from({ length: 20 }, () => post(f)))).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === 204).length, 1, statuses.join(','));
  assert.equal(statuses.filter((s) => s === 400).length, 19, statuses.join(','));
  assert.equal(scanCount(), before + 1);
});

test('rejets identiques (code, corps vide, en-têtes hors Date) avec un client sans keep-alive', async () => {
  const c = maxCounter() + 1;
  const tampered = frame(c);
  tampered[25] ^= 0x04;
  const cases = {
    'taille 35': frame(c).subarray(0, 35),
    'taille 1000': Buffer.alloc(1000),
    'lecteur inconnu': frame(1, { readerId: 99 }),
    'tag': tampered,
    'mauvaise clé': frame(c, { key: KEY2 }),
    'rejeu': frame(1),
  };
  const responses = {};
  for (const [name, body] of Object.entries(cases)) responses[name] = await post(body);
  responses['Content-Type faux'] = await post(frame(c), { contentType: 'text/plain' });
  const reference = responses['taille 35'];
  assert.equal(reference.status, 400);
  assert.equal(reference.body, 0);
  for (const [name, res] of Object.entries(responses)) assert.deepEqual(res, reference, name);
});

// Avec une connexion keep-alive, tous les rejets doivent être identiques, en-têtes compris
// (http.js ferme la connexion sur tout rejet ; protocole.md §5, cadrage §4).
test('rejets identiques avec un client keep-alive (en-tête Connection compris)', async () => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const unknownReader = await post(frame(1, { readerId: 99 }), { agent });
    const badType = await post(frame(1), { agent, contentType: 'text/plain' });
    const tooLarge = await post(Buffer.alloc(100), { agent });
    assert.deepEqual(badType, unknownReader);
    assert.deepEqual(tooLarge, unknownReader);
  } finally {
    agent.destroy();
  }
});
