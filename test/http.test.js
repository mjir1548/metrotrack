// Test d'intégration HTTPS en processus : base temporaire sur disque, port éphémère,
// certificats générés à l'exécution (test/tls-fixture.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { makeTestCerts } from './tls-fixture.js';

const KEY = Buffer.alloc(32, 0x5a);
const NOW = '2026-11-15T10:00:00.000Z';
let dir, db, server, port, certs;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-test-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?), (2, 'Poste 2', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, '04A1B2C3D4E5F6', 'Multimètre démo', ?, ?)").run(NOW, NOW);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (line) => logs.push(line) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const frame = (counter, uid = '04A1B2C3D4E5F6') =>
  encodeFrame({ readerId: 1, counter, uid: Buffer.from(uid, 'hex'), key: KEY });
const scanCount = () => db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;

/** Requête HTTPS vérifiant le certificat avec la CA de test. Renvoie code, corps et en-têtes. */
function send({ method = 'POST', path = '/api/frames', body, contentType = 'application/octet-stream', ca = certs.ca, tls = {} } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (method === 'POST') {
      headers['Content-Type'] = contentType;
      headers['Content-Length'] = body.length;
    }
    const req = request({ host: '127.0.0.1', port, path, method, headers, ca, agent: false, ...tls }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const post = async (body, contentType, path) => {
  const { status, body: text } = await send({ body, contentType, path });
  return { status, body: text };
};

test('createFrameServer refuse de créer un serveur sans certificat ni clé TLS', () => {
  assert.throws(() => createFrameServer(db), /TLS obligatoires/);
  assert.throws(() => createFrameServer(db, { tls: { cert: certs.cert } }), /TLS obligatoires/);
});

test('bonne CA : 204 puis item_locations donne le poste du lecteur ; journal du scan accepté', async () => {
  const res = await post(frame(1));
  assert.deepEqual(res, { status: 204, body: '' });
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 1);
  assert.match(logs.at(-1), /scan accepté : lecteur 1, poste "Poste 1", uid 04A1B2C3D4E5F6, objet "Multimètre démo"/);
});

test('en-tête HSTS présent sur 204, 400, 404 et 405', async () => {
  const expected = 'max-age=31536000';
  const ok = await send({ body: frame(30) });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['strict-transport-security'], expected);
  const rejected = await send({ body: frame(30) }); // rejeu
  assert.equal(rejected.status, 400);
  assert.equal(rejected.headers['strict-transport-security'], expected);
  assert.equal((await send({ method: 'GET' })).headers['strict-transport-security'], expected);
  assert.equal((await send({ body: frame(31), path: '/x' })).headers['strict-transport-security'], expected);
});

test('mauvaise CA : échec de la vérification TLS, aucune trame traitée', async () => {
  const before = scanCount();
  await assert.rejects(send({ body: frame(40), ca: certs.otherCa }), (err) => {
    assert.match(err.code, /UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED|UNABLE_TO_GET_ISSUER/);
    return true;
  });
  assert.equal(scanCount(), before);
});

test('client limité à TLS 1.1 : poignée de main refusée par le serveur', async () => {
  // SECLEVEL=0 côté client : sinon c'est l'OpenSSL du CLIENT qui refuserait TLS 1.1
  // localement, et le test ne prouverait rien sur le serveur.
  const err = await new Promise((resolve) => {
    const socket = tlsConnect({
      host: '127.0.0.1', port, ca: certs.ca, minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0',
    }, () => { socket.destroy(); resolve(null); });
    socket.on('error', resolve);
  });
  assert.ok(err, 'la connexion TLS 1.1 aurait dû échouer');
  // Alerte « protocol_version » envoyée par le serveur (le client, lui, sait négocier TLS 1.1).
  assert.equal(err.code, 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION');
});

test('TLS 1.2 avec une suite non ECDHE/AEAD (CBC) : refusée ; TLS 1.2 ECDHE-GCM et TLS 1.3 : acceptés', async () => {
  const handshake = (opts) => new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca, ...opts }, () => {
      const info = { ok: true, protocol: socket.getProtocol(), cipher: socket.getCipher().name };
      socket.destroy();
      resolve(info);
    });
    socket.on('error', (e) => resolve({ ok: false, code: e.code }));
  });
  const cbc = await handshake({ maxVersion: 'TLSv1.2', ciphers: 'ECDHE-ECDSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA' });
  assert.equal(cbc.ok, false);
  const gcm = await handshake({ maxVersion: 'TLSv1.2' });
  assert.equal(gcm.ok, true);
  assert.equal(gcm.protocol, 'TLSv1.2');
  assert.match(gcm.cipher, /^ECDHE-.*(GCM|CHACHA20)/);
  const v13 = await handshake({});
  assert.deepEqual({ ok: v13.ok, protocol: v13.protocol }, { ok: true, protocol: 'TLSv1.3' });
});

test('requête HTTP en clair sur le port TLS : aucune réponse HTTP', async () => {
  const data = await new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => {
      socket.write('POST /api/frames HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: 36\r\n\r\n');
      socket.write(frame(50));
    });
    let received = '';
    const timer = setTimeout(() => { socket.destroy(); resolve(received); }, 3000);
    socket.on('data', (d) => { received += d.toString('latin1'); });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); resolve(received); });
  });
  assert.doesNotMatch(data, /^HTTP\//);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scans WHERE counter = 50').get().n, 0);
});

test('même trame renvoyée : 400 corps vide, aucune nouvelle ligne, cause journalisée', async () => {
  const before = scanCount();
  const res = await post(frame(1));
  assert.deepEqual(res, { status: 400, body: '' });
  assert.equal(scanCount(), before);
  assert.match(logs.at(-1), /trame rejetée : cause=replay, reader_id annoncé=1 \(non authentifié\)/);
});

test('puce inconnue : 204 et journal « puce inconnue »', async () => {
  assert.equal((await post(frame(60, 'DEADBEEF'))).status, 204);
  assert.match(logs.at(-1), /uid DEADBEEF, objet "puce inconnue"/);
});

test('toutes les causes de rejet donnent la même réponse : 400 sans corps', async () => {
  const tampered = frame(70);
  tampered[20] ^= 0x01;
  const cases = [
    () => post(frame(71), 'text/plain'),            // mauvais Content-Type
    () => post(frame(72).subarray(0, 35)),          // taille
    () => post(Buffer.alloc(100)),                  // corps au-delà du plafond
    () => post(tampered),                           // tag
  ];
  const before = scanCount();
  for (const sendCase of cases) {
    assert.deepEqual(await sendCase(), { status: 400, body: '' });
  }
  assert.equal(scanCount(), before);
});

test('corps envoyé en flux (sans Content-Length) au-delà du plafond : 400', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/api/frames', method: 'POST', ca: certs.ca, agent: false,
      headers: { 'Content-Type': 'application/octet-stream' },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(Buffer.alloc(40));
    req.write(Buffer.alloc(40));
    req.end();
  });
  assert.equal(status, 400);
});

test('GET sur /api/frames : 405 ; autre chemin : 404', async () => {
  const get = await send({ method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, 'POST');
  assert.equal((await post(frame(80), 'application/octet-stream', '/autre')).status, 404);
});

test('déplacer le lecteur vers un autre poste ne change pas la localisation déjà dérivée', async () => {
  db.exec('UPDATE readers SET station_id = 2 WHERE id = 1');
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 1);
  db.exec('UPDATE readers SET station_id = 1 WHERE id = 1');
});

// Régression (revue sécurité étape 1, B1) : une cible de requête invalide pour new URL()
// faisait lever une exception non capturée et arrêtait le processus.
test('cible de requête invalide (« //[ ») : réponse 404, le serveur reste disponible', async () => {
  const raw = await new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca }, () => {
      socket.write('POST //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/octet-stream\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  assert.match(raw, /^HTTP\/1\.1 404 /);
  assert.deepEqual(await post(frame(90)), { status: 204, body: '' });
});

test('aucune clé dans les journaux', () => {
  const keyHex = KEY.toString('hex');
  assert.ok(logs.length > 0);
  for (const line of logs) assert.ok(!line.toLowerCase().includes(keyHex));
});

test('renégociation TLS 1.2 initiée par le client : refusée', async () => {
  const result = await new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca, maxVersion: 'TLSv1.2' }, () => {
      const accepted = socket.renegotiate({}, (err) => {
        socket.destroy();
        resolve(err ? 'refusée' : 'acceptée');
      });
      if (!accepted) { socket.destroy(); resolve('refusée'); }
    });
    socket.on('error', () => resolve('refusée'));
    socket.on('close', () => resolve('refusée'));
    setTimeout(() => { socket.destroy(); resolve('sans réponse'); }, 3000);
  });
  assert.equal(result, 'refusée');
  // Le serveur reste disponible.
  assert.equal((await post(frame(100))).status, 204);
});

test('au-delà de maxConnections : connexions supplémentaires fermées, serveur vivant ensuite', async () => {
  const small = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (line) => logs.push(line), maxConnections: 2 });
  await new Promise((resolve) => small.listen(0, '127.0.0.1', resolve));
  const smallPort = small.address().port;
  const open = () => new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port: smallPort, ca: certs.ca }, () => resolve({ ok: true, socket }));
    socket.on('error', (err) => resolve({ ok: false, code: err.code }));
    socket.on('close', () => resolve({ ok: false, code: 'close' }));
  });
  try {
    const held = [await open(), await open()];
    assert.deepEqual(held.map((h) => h.ok), [true, true]);
    const extra = await open();
    assert.equal(extra.ok, false, 'la 3e connexion aurait dû être refusée');
    assert.ok(logs.some((l) => l.includes('plafond de 2 connexions')));
    for (const h of held) h.socket.destroy();
    await new Promise((r) => setTimeout(r, 100));
    // Une connexion libérée : une trame valide est acceptée.
    const status = await new Promise((resolve, reject) => {
      const body = frame(110);
      const req = request({
        host: '127.0.0.1', port: smallPort, path: '/api/frames', method: 'POST', ca: certs.ca, agent: false,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(status, 204);
  } finally {
    small.closeAllConnections();
    small.close();
  }
});

test('poignée de main refusée : journal « TLS refusé » avec le code seul', () => {
  assert.ok(logs.some((l) => /^TLS refusé : [A-Z0-9_]+$/.test(l)), logs.filter((l) => l.startsWith('TLS')).join('\n'));
});
