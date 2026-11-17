// Un seul 503 par connexion (web.js, closingConnections), vérifié avec PLUSIEURS connexions
// saturées en même temps et le délai d'échec réel (1 s) : chaque connexion reçoit au plus un
// 503, en dernier ; rien n'est répondu après lui (pas même un GET enchaîné) ; le serveur ferme
// chaque connexion lui-même ; il reste ensuite disponible (connexion légitime, liste).
// Complète web-attaque.test.js (une seule connexion).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { hashPassword, argon2Stats } from '../server/password.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-17T10:00:00.000Z';
const PASSWORD = 'mot-de-passe-de-test-503';
const CONNECTIONS = 4;
const PER_CONNECTION = 30;
let dir, db, server, port, certs, origin;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-pipe503-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', await hashPassword(PASSWORD), NOW);
  // Délai d'échec par défaut (1 s), comme en production.
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => logs.push(l) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  origin = `https://127.0.0.1:${port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function send({ method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const loginCsrf = async () => (await send({ path: '/login' })).headers['set-cookie'][0].split(';')[0].split('=')[1];
const rawLogin = (csrf) => {
  const body = new URLSearchParams({ csrf, username: 'alice', password: 'mauvais-mot-de-passe' }).toString();
  return `POST /login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: __Host-mt_login_csrf=${csrf}\r\n`
    + `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
};

/** Écrit payload sur une connexion TLS et lit jusqu'à la fermeture PAR LE SERVEUR (closedBy). */
function pipeline(payload, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca }, () => socket.write(payload));
    let data = '';
    let closedBy = 'serveur';
    socket.on('data', (d) => { data += d; });
    socket.on('error', () => {});
    socket.setTimeout(timeoutMs, () => { closedBy = 'délai'; socket.destroy(); });
    socket.on('close', () => resolve({ statuses: [...data.matchAll(/^HTTP\/1\.1 (\d{3})/gm)].map((m) => m[1]), data, closedBy }));
  });
}

test(`${CONNECTIONS} connexions × ${PER_CONNECTION} POST /login + GET enchaînés : au plus un 503 par connexion, en dernier, puis fermeture ; serveur disponible ensuite`, async () => {
  const csrf = await loginCsrf();
  const payload = rawLogin(csrf).repeat(PER_CONNECTION) + `GET /login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`;
  const results = await Promise.all(Array.from({ length: CONNECTIONS }, () => pipeline(payload)));
  for (const [i, { statuses, data, closedBy }] of results.entries()) {
    const what = `connexion ${i} : ${statuses.join(',')}`;
    assert.equal(closedBy, 'serveur', what);
    // 401 éventuels (calculs obtenus), puis exactement un 503 ; jamais le 200 du GET enchaîné.
    assert.match(statuses.join(','), /^(401,)*503$/, what);
    const busy = data.slice(data.indexOf('HTTP/1.1 503'));
    const busyHeaders = busy.slice(0, busy.indexOf('\r\n\r\n'));
    assert.match(busyHeaders, /\r\nconnection: close/i, what);
    assert.doesNotMatch(busyHeaders, /\r\nset-cookie:/i, what);
    assert.ok(busy.includes('Trop de connexions en cours. Réessayez dans un instant.'), what);
  }
  // Au moins une connexion a été servie (401) : la file a bien travaillé, sans dépasser sa borne.
  assert.ok(results.some((r) => r.statuses.includes('401')));
  assert.ok(argon2Stats().pending <= 16);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.filter((l) => l.startsWith('erreur interne')).join('\n'));

  // Disponible ensuite : connexion légitime puis liste avec la session obtenue.
  const deadline = Date.now() + 10_000;
  let ok;
  while (Date.now() < deadline) {
    const fresh = await loginCsrf();
    ok = await send({
      method: 'POST', path: '/login', body: new URLSearchParams({ csrf: fresh, username: 'alice', password: PASSWORD }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: `__Host-mt_login_csrf=${fresh}` },
    });
    if (ok.status === 303) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(ok.status, 303);
  const session = ok.headers['set-cookie'].find((c) => c.startsWith('__Host-mt_session=')).split(';')[0];
  assert.equal((await send({ path: '/', headers: { Cookie: session } })).status, 200);
});
