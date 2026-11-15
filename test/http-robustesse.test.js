// Robustesse du transport HTTPS face à des requêtes malformées envoyées en octets bruts (dans TLS) :
// cibles invalides, en-têtes invalides, ambiguïtés de longueur, connexions coupées.
// Critère : le processus survit (une exception non capturée ferait échouer ce fichier),
// aucune requête malformée n'ajoute de scan, et une trame valide est acceptée ensuite.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { makeTestCerts } from './tls-fixture.js';

const KEY = Buffer.alloc(32, 0x44);
const NOW = '2026-11-15T10:00:00.000Z';
let dir, db, server, port, certs;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-robustesse-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, NOW);
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

const frame = (counter) => encodeFrame({ readerId: 1, counter, uid: Buffer.from('DEADBEEF', 'hex'), key: KEY });
const scanCount = () => db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;
const maxCounter = () => db.prepare('SELECT COALESCE(MAX(counter), 0) AS c FROM scans').get().c;

/** Envoie des octets bruts ; renvoie le code HTTP de la réponse, ou null si aucune réponse. */
function raw(bytes, { cutAfterMs = null } = {}) {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1', ca: certs.ca });
    let data = '';
    const done = () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
      resolve(m ? Number(m[1]) : null);
    };
    const timer = setTimeout(() => { socket.destroy(); done(); }, 5000);
    socket.on('data', (d) => { data += d.toString('latin1'); });
    socket.on('error', () => {}); // ECONNRESET attendu sur certains rejets du parseur
    socket.on('close', () => { clearTimeout(timer); done(); });
    socket.write(bytes, () => {
      if (cutAfterMs === null) socket.end();
      else setTimeout(() => socket.destroy(), cutAfterMs);
    });
  });
}

const head = (target, extra = '') =>
  `POST ${target} HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 36\r\n${extra}Connection: close\r\n\r\n`;
const withFrame = (h, counter) => Buffer.concat([Buffer.from(h, 'latin1'), frame(counter)]);

// [nom, octets, codes acceptables]. 404 : cible ≠ /api/frames ; 400 : rejet du parseur HTTP
// de Node ou rejet de la trame ; 431 : en-têtes trop grands ; null : connexion fermée sans réponse.
const MALFORMED = [
  ['cible //[', () => withFrame(head('//['), 1), [404]],
  ['cible http://[', () => withFrame(head('http://['), 1), [404]],
  ['cible *', () => withFrame(head('*'), 1), [404]],
  ['cible %', () => withFrame(head('%'), 1), [400, 404]],
  ['cible /api/frames%', () => withFrame(head('/api/frames%'), 1), [404]],
  ['cible absolue http://h/api/frames', () => withFrame(head('http://h/api/frames'), 1), [404]],
  ['cible de 100 Ko', () => withFrame(head('/' + 'a'.repeat(100_000)), 1), [431, null]],
  ['octets non ASCII dans la cible', () => Buffer.from('POST /\xff\x00 HTTP/1.1\r\nHost: x\r\n\r\n', 'latin1'), [400, null]],
  ['en-tête sans deux-points', () => Buffer.from('POST /api/frames HTTP/1.1\r\nHost: x\r\nGarbage\r\n\r\n'), [400]],
  ['en-tête contenant NUL', () => Buffer.from('POST /api/frames HTTP/1.1\r\nHost: x\r\nX-A: a\x00b\r\n\r\n', 'latin1'), [400]],
  ['en-têtes de 100 Ko', () => Buffer.from(`POST /api/frames HTTP/1.1\r\nHost: x\r\nX-Big: ${'b'.repeat(100_000)}\r\n\r\n`), [431, null]],
  ['Content-Length négatif', () => Buffer.from(`POST /api/frames HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: -1\r\n\r\n`), [400]],
  ['Content-Length non numérique', () => Buffer.from(`POST /api/frames HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: abc\r\n\r\n`), [400]],
  ['Content-Length en double (contrebande)', () => withFrame(`POST /api/frames HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 36\r\nContent-Length: 10\r\n\r\n`, 1), [400]],
  ['Content-Length + Transfer-Encoding (contrebande)', () => Buffer.from(`POST /api/frames HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 36\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`), [400]],
  ['Content-Length de 1 Go annoncé', () => Buffer.from(`POST /api/frames HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000000000\r\n\r\n`), [400]],
  ['chunked mal formé', () => Buffer.from(`POST /api/frames HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\nZZ\r\nxx\r\n`), [400]],
  ['méthode inconnue', () => Buffer.from('FOO /api/frames HTTP/1.1\r\nHost: x\r\n\r\n'), [400]],
  ['version HTTP/9.9', () => Buffer.from('POST /api/frames HTTP/9.9\r\nHost: x\r\n\r\n'), [400]],
  ['lignes vides seules', () => Buffer.from('\r\n\r\n'), [400, null]],
  ['déchets binaires', () => Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37) & 0xff)), [400, null]],
  ['corps incomplet (18/36) puis fin de connexion', () => withFrame(head('/api/frames'), 1).subarray(0, Buffer.byteLength(head('/api/frames')) + 18), [400, null]],
];

test('requêtes malformées : réponse sans plantage, aucun scan, puis trame valide acceptée', async () => {
  const before = scanCount();
  for (const [name, build, allowed] of MALFORMED) {
    const status = await raw(build());
    assert.ok(allowed.includes(status), `${name} : code ${status}, attendu ${allowed.join('/')}`);
    assert.ok(server.listening, `${name} : serveur arrêté`);
  }
  assert.equal(scanCount(), before);
  assert.equal(await raw(withFrame(head('/api/frames'), maxCounter() + 1)), 204);
});

test('connexions coupées par le client (en-têtes ou corps incomplets) : le serveur survit', async () => {
  const before = scanCount();
  const h = head('/api/frames');
  assert.equal(await raw(Buffer.from('POST /api/fr'), { cutAfterMs: 50 }), null);
  assert.equal(await raw(Buffer.concat([Buffer.from(h), frame(maxCounter() + 1).subarray(0, 18)]), { cutAfterMs: 50 }), null);
  assert.equal(await raw(Buffer.from(h), { cutAfterMs: 50 }), null);
  // 20 coupures simultanées au milieu du corps.
  await Promise.all(Array.from({ length: 20 }, () =>
    raw(Buffer.concat([Buffer.from(h), frame(maxCounter() + 1).subarray(0, 10)]), { cutAfterMs: 20 })));
  assert.equal(scanCount(), before);
  assert.equal(await raw(withFrame(h, maxCounter() + 1)), 204);
});

test('paramètres de requête ignorés : /api/frames?%% est la route des trames', async () => {
  assert.equal(await raw(withFrame(head('/api/frames?%%'), maxCounter() + 1)), 204);
});

test('Content-Type en double : Node garde le premier (comportement observé, documenté ici)', async () => {
  const c = maxCounter() + 1;
  const dup = (first, second) => withFrame(
    `POST /api/frames HTTP/1.1\r\nHost: x\r\nContent-Type: ${first}\r\nContent-Type: ${second}\r\nContent-Length: 36\r\nConnection: close\r\n\r\n`, c);
  assert.equal(await raw(dup('text/plain', 'application/octet-stream')), 400);
  assert.equal(await raw(dup('application/octet-stream', 'text/plain')), 204);
});

test('aucune erreur interne (500) journalisée pendant ces essais', () => {
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.filter((l) => l.startsWith('erreur interne')).join('\n'));
});
