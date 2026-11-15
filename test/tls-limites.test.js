// Cas limites TLS complémentaires : nom d'hôte, versions et suites refusées,
// poignée de main laissée ouverte, robustesse face aux connexions TLS avortées.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { makeTestCerts } from './tls-fixture.js';

const KEY = Buffer.alloc(32, 0x55);
const NOW = '2026-11-15T10:00:00.000Z';
let dir, db, server, port, certs;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-tls-limites-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const frame = (counter) => encodeFrame({ readerId: 1, counter, uid: Buffer.from('DEADBEEF', 'hex'), key: KEY });
const maxCounter = () => db.prepare('SELECT COALESCE(MAX(counter), 0) AS c FROM scans').get().c;

function handshake(opts) {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca, ...opts }, () => {
      const info = { ok: true, protocol: socket.getProtocol(), cipher: socket.getCipher().name };
      socket.destroy();
      resolve(info);
    });
    socket.on('error', (e) => resolve({ ok: false, code: e.code }));
  });
}

function postFrame(counter, extra = {}) {
  return new Promise((resolve, reject) => {
    const body = frame(counter);
    const req = request({
      host: '127.0.0.1', port, path: '/api/frames', method: 'POST', ca: certs.ca, agent: false,
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }, ...extra,
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

test('vérification du nom d\'hôte : servername hors SAN refusé ; localhost, 127.0.0.1 et SAN accepté', async () => {
  const evil = await handshake({ servername: 'evil.example' });
  assert.deepEqual(evil, { ok: false, code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal((await handshake({ servername: 'localhost' })).ok, true);
  assert.equal((await handshake({})).ok, true); // vérification par IP 127.0.0.1 (SAN IP)
  // Même échec par la pile HTTPS (celle du simulateur) : aucune trame traitée.
  const before = maxCounter();
  await assert.rejects(postFrame(before + 1, { servername: 'evil.example' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  assert.equal(maxCounter(), before);
});

test('TLS 1.0 refusé par le serveur (alerte protocol_version)', async () => {
  const res = await handshake({ minVersion: 'TLSv1', maxVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' });
  assert.deepEqual(res, { ok: false, code: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION' });
});

test('TLS 1.2 : échange RSA statique, DHE et CBC refusés ; ECDHE-ECDSA-CHACHA20 accepté', async () => {
  for (const ciphers of [
    'AES128-GCM-SHA256:AES256-GCM-SHA384',          // RSA statique (sans confidentialité persistante)
    'DHE-RSA-AES128-GCM-SHA256',                    // DHE (hors liste)
    'ECDHE-ECDSA-AES256-SHA384:ECDHE-ECDSA-AES256-SHA', // CBC
  ]) {
    const res = await handshake({ maxVersion: 'TLSv1.2', ciphers });
    assert.equal(res.ok, false, ciphers);
  }
  const chacha = await handshake({ maxVersion: 'TLSv1.2', ciphers: 'ECDHE-ECDSA-CHACHA20-POLY1305' });
  assert.deepEqual(chacha, { ok: true, protocol: 'TLSv1.2', cipher: 'ECDHE-ECDSA-CHACHA20-POLY1305' });
});

test('TLS 1.3 : suite AEAD négociée', async () => {
  const res = await handshake({ minVersion: 'TLSv1.3' });
  assert.equal(res.protocol, 'TLSv1.3');
  assert.match(res.cipher, /^TLS_(AES_(128|256)_GCM|CHACHA20_POLY1305)_SHA(256|384)$/);
});

test('poignée de main laissée ouverte (TCP muet, ClientHello partiel) : coupée en ~5 s, serveur vivant', async () => {
  const hold = (bytes) => new Promise((resolve) => {
    const start = Date.now();
    const socket = netConnect(port, '127.0.0.1', () => { if (bytes) socket.write(bytes); });
    socket.on('error', () => {});
    const guard = setTimeout(() => { socket.destroy(); resolve(Infinity); }, 12_000);
    socket.on('close', () => { clearTimeout(guard); resolve(Date.now() - start); });
  });
  const [silent, partial] = await Promise.all([hold(null), hold(Buffer.from('16030100c8010000c40303', 'hex'))]);
  for (const [name, ms] of [['TCP muet', silent], ['ClientHello partiel', partial]]) {
    assert.ok(ms >= 4_000 && ms <= 8_000, `${name} : fermée après ${ms} ms (attendu ~5000)`);
  }
  assert.equal(await postFrame(maxCounter() + 1), 204);
});

test('connexions TLS avortées en masse (pendant et après la poignée de main) : serveur vivant', async () => {
  const abort = (afterSecure) => new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca });
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
    if (afterSecure) socket.on('secureConnect', () => { socket.write('POST /api/frames HTTP/1.1\r\nHost: x\r\n'); socket.destroy(); });
    else setImmediate(() => socket.destroy());
  });
  await Promise.all(Array.from({ length: 30 }, (_, i) => abort(i % 2 === 0)));
  // Déchets non TLS sur le port.
  await new Promise((resolve) => {
    const socket = netConnect(port, '127.0.0.1', () => socket.end(Buffer.alloc(300, 0x41)));
    socket.on('error', () => resolve());
    socket.on('close', () => resolve());
  });
  assert.ok(server.listening);
  assert.equal(await postFrame(maxCounter() + 1), 204);
});
