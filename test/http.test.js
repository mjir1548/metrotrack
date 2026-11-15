// Test d'intégration HTTP en processus : base temporaire sur disque, port éphémère.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { connect } from 'node:net';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';

const KEY = Buffer.alloc(32, 0x5a);
const NOW = '2026-11-15T10:00:00.000Z';
let dir, db, server, baseUrl;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-test-'));
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?), (2, 'Poste 2', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, '04A1B2C3D4E5F6', 'Multimètre démo', ?, ?)").run(NOW, NOW);
  server = createFrameServer(db, { log: (line) => logs.push(line) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const frame = (counter, uid = '04A1B2C3D4E5F6') =>
  encodeFrame({ readerId: 1, counter, uid: Buffer.from(uid, 'hex'), key: KEY });

async function post(body, contentType = 'application/octet-stream', path = '/api/frames') {
  const res = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': contentType }, body });
  return { status: res.status, body: await res.text() };
}
const scanCount = () => db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;

test('204 puis item_locations donne le poste du lecteur ; journal du scan accepté', async () => {
  const res = await post(frame(1));
  assert.deepEqual(res, { status: 204, body: '' });
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 1);
  assert.match(logs.at(-1), /scan accepté : lecteur 1, poste "Poste 1", uid 04A1B2C3D4E5F6, objet "Multimètre démo"/);
});

test('même trame renvoyée : 400 corps vide, aucune nouvelle ligne, cause journalisée', async () => {
  const before = scanCount();
  const res = await post(frame(1));
  assert.deepEqual(res, { status: 400, body: '' });
  assert.equal(scanCount(), before);
  assert.match(logs.at(-1), /trame rejetée : cause=replay, reader_id annoncé=1 \(non authentifié\)/);
});

test('puce inconnue : 204 et journal « puce inconnue »', async () => {
  assert.equal((await post(frame(2, 'DEADBEEF'))).status, 204);
  assert.match(logs.at(-1), /uid DEADBEEF, objet "puce inconnue"/);
});

test('toutes les causes de rejet donnent la même réponse : 400 sans corps', async () => {
  const tampered = frame(10);
  tampered[20] ^= 0x01;
  const cases = [
    () => post(frame(11), 'text/plain'),            // mauvais Content-Type
    () => post(frame(12).subarray(0, 35)),          // taille
    () => post(Buffer.alloc(100)),                  // corps au-delà du plafond
    () => post(tampered),                           // tag
  ];
  const before = scanCount();
  for (const send of cases) {
    assert.deepEqual(await send(), { status: 400, body: '' });
  }
  assert.equal(scanCount(), before);
});

test('corps envoyé en flux (sans Content-Length) au-delà du plafond : 400', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request(`${baseUrl}/api/frames`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(Buffer.alloc(40));
    req.write(Buffer.alloc(40));
    req.end();
  });
  assert.equal(status, 400);
});

test('GET sur /api/frames : 405 ; autre chemin : 404', async () => {
  const get = await fetch(`${baseUrl}/api/frames`);
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await post(frame(13), 'application/octet-stream', '/autre')).status, 404);
});

test('déplacer le lecteur vers un autre poste ne change pas la localisation déjà dérivée', async () => {
  db.exec('UPDATE readers SET station_id = 2 WHERE id = 1');
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 1);
  db.exec('UPDATE readers SET station_id = 1 WHERE id = 1');
});

test('aucune clé dans les journaux', () => {
  const keyHex = KEY.toString('hex');
  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(!line.toLowerCase().includes(keyHex));
});

// Régression (revue sécurité B1) : une cible de requête invalide pour new URL()
// faisait lever une exception non capturée et arrêtait le processus.
test('cible de requête invalide (« //[ ») : réponse 404, le serveur reste disponible', async () => {
  const port = new URL(baseUrl).port;
  const raw = await new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write('POST //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 404 /);
  assert.deepEqual(await post(frame(20)), { status: 204, body: '' });
});
