// Interface web (étape 3) : cas limites complémentaires de web.test.js, contre un vrai serveur
// HTTPS en processus. Variantes d'Origin, cookies malformés ou multiples, méthodes et chemins
// inattendus, en-têtes démesurés, connexions concurrentes, client qui abandonne pendant le
// délai d'échec, identifiant hors format en base (défense en profondeur).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { hashPassword, verifyPassword, argon2Stats, DUMMY_HASH, MAX_PENDING_ARGON2 } from '../server/password.js';
import { csrfTokenFor, createSession } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-17T10:00:00.000Z';
const PASSWORD = 'Un-mot-de-passe-solide-42';
let dir, db, server, port, certs, origin;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-weblim-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, active, created_at) VALUES (?, ?, ?, ?)');
  insertUser.run('alice', await hashPassword(PASSWORD), 1, NOW);
  insertUser.run('desactive', await hashPassword(PASSWORD), 0, NOW);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => logs.push(l), loginFailureDelayMs: 0 });
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

// ---------------------------------------------------------------- outils

function send({ method = 'GET', path = '/', headers = {}, body, toPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port: toPort, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Requête en octets bruts sur TLS : renvoie la réponse brute (ou '' si la connexion est coupée). */
const raw = (text) => new Promise((resolve) => {
  const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca }, () => socket.end(text));
  let data = '';
  socket.on('data', (d) => { data += d; });
  socket.on('error', () => {});
  socket.on('close', () => resolve(data));
});
const statusOf = (rawResponse) => /^HTTP\/1\.1 (\d{3})/.exec(rawResponse)?.[1] ?? null;

const FORM_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (fields) => new URLSearchParams(fields).toString();
const cookieValue = (res, name) =>
  (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(';')[0];

async function loginCsrf(toPort = port) {
  return cookieValue(await send({ path: '/login', toPort }), '__Host-mt_login_csrf');
}
async function login(username, password, toPort = port) {
  const csrf = await loginCsrf(toPort);
  return send({
    method: 'POST', path: '/login', toPort,
    headers: { ...FORM_TYPE, Origin: `https://127.0.0.1:${toPort}`, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf, username, password }),
  });
}
async function sessionFor(username = 'alice') {
  const res = await login(username, PASSWORD);
  assert.equal(res.status, 303);
  return cookieValue(res, '__Host-mt_session');
}
const home = (cookieHeader) => send({ path: '/', headers: cookieHeader === undefined ? {} : { Cookie: cookieHeader } });

// ---------------------------------------------------------------- CSRF : variantes d'Origin

test('Origin presque correct (majuscules, barre finale, en clair, null, chemin) : 403 sur /login et /logout', async () => {
  const token = await sessionFor();
  const variants = {
    'schéma en majuscules': `HTTPS://127.0.0.1:${port}`,
    'barre finale': `${origin}/`,
    'en clair': `http://127.0.0.1:${port}`,
    'null': 'null',
    'avec chemin': `${origin}/login`,
    'vide': '',
    'deux valeurs': `${origin}, ${origin}`,
  };
  for (const [name, value] of Object.entries(variants)) {
    const csrf = await loginCsrf();
    const l = await send({
      method: 'POST', path: '/login',
      headers: { ...FORM_TYPE, Origin: value, Cookie: `__Host-mt_login_csrf=${csrf}` },
      body: form({ csrf, username: 'alice', password: PASSWORD }),
    });
    assert.equal(l.status, 403, `login ${name}`);
    assert.equal(cookieValue(l, '__Host-mt_session'), undefined, `login ${name}`);
    const o = await send({
      method: 'POST', path: '/logout',
      headers: { ...FORM_TYPE, Origin: value, Cookie: `__Host-mt_session=${token}` },
      body: form({ csrf: csrfTokenFor(token) }),
    });
    assert.equal(o.status, 403, `logout ${name}`);
  }
  assert.equal((await home(`__Host-mt_session=${token}`)).status, 200, 'session intacte');
});

test('Host différent (localhost) : Origin cohérent accepté, Origin de l\'autre nom refusé', async () => {
  const csrf = await loginCsrf();
  const attempt = (host, originHeader) => send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Host: host, Origin: originHeader, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf, username: 'alice', password: PASSWORD }),
  });
  assert.equal((await attempt(`localhost:${port}`, `https://localhost:${port}`)).status, 303);
  assert.equal((await attempt(`localhost:${port}`, origin)).status, 403);
});

// ---------------------------------------------------------------- échecs indiscernables

test('mauvais mot de passe, compte inconnu, compte désactivé : statut, corps et en-têtes identiques', async () => {
  const csrf = await loginCsrf();
  const attempt = (username, password) => send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf, username, password }),
  });
  const responses = [
    await attempt('alice', 'pas-le-bon-mot-de-passe'),
    await attempt('zz-inconnu', 'pas-le-bon-mot-de-passe'),
    await attempt('desactive', PASSWORD),
    await attempt('x'.repeat(65), PASSWORD),
    await attempt('', ''),
  ];
  const normalized = responses.map(({ status, headers, body }) => {
    const { date, ...rest } = headers;
    return { status, headers: rest, body };
  });
  for (const r of normalized.slice(1)) assert.deepEqual(r, normalized[0]);
  assert.equal(normalized[0].status, 401);
});

// ---------------------------------------------------------------- cookies malformés

test('cookies multiples, entre guillemets, nom à la casse différente, encodés : jamais de session par erreur', async () => {
  const token = await sessionFor();
  const cases = {
    [`__Host-mt_session=bidon; __Host-mt_session=${token}`]: 303, // première occurrence retenue
    [`__Host-mt_session=${token}; __Host-mt_session=bidon`]: 200,
    [`__Host-mt_session="${token}"`]: 303,
    [`__HOST-MT_SESSION=${token}`]: 303,
    [`__Host-mt_session=${token}%3D`]: 303,
    [`__Host-mt_session=${token}x`]: 303,
    [`mt_session=${token}`]: 303,
    [`  __Host-mt_session  =  ${token}  `]: 200, // espaces autour : tolérés (RFC 6265)
    '=;=;=;;': 303,
    'é=é': 303,
  };
  for (const [cookie, expected] of Object.entries(cases)) {
    let res;
    try {
      res = await home(cookie);
    } catch {
      continue; // en-tête refusé par le client HTTP lui-même : rien à vérifier côté serveur
    }
    assert.equal(res.status, expected, cookie.slice(0, 40));
  }
});

test('en-tête Cookie démesuré (20 Kio) : 431, serveur toujours disponible', async () => {
  const response = await raw(`GET / HTTP/1.1\r\nHost: x\r\nCookie: ${'a=b; '.repeat(4000)}\r\nConnection: close\r\n\r\n`);
  assert.equal(statusOf(response), '431');
  assert.equal((await send({ path: '/login' })).status, 200);
});

// ---------------------------------------------------------------- méthodes et chemins

test('méthodes inattendues sur /login, / et /logout : 405 ; CONNECT : connexion fermée sans plantage', async () => {
  for (const method of ['HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'TRACE']) {
    for (const path of ['/login', '/', '/logout', '/static/style.css']) {
      const response = await raw(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      assert.equal(statusOf(response), '405', `${method} ${path}`);
    }
  }
  await raw('CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n');
  assert.ok(server.listening);
  assert.equal((await send({ path: '/login' })).status, 200);
});

test('chemins tordus : 404 sans corps ; requête ignorée pour le routage ; aucune redirection ouverte', async () => {
  for (const path of ['//', '/static//style.css', '/STATIC/style.css', '/static/style.css%00', '/./login', '/login;x',
    '/%2e%2e/config.json', '/static/..%2f..%2fserver/main.js', '/\\..\\config.json', '*', 'https://evil.example/login']) {
    const response = await raw(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    assert.equal(statusOf(response), '404', path);
    assert.ok(response.endsWith('\r\n\r\n') || /\r\n\r\n0\r\n\r\n$/.test(response), `${path} : corps inattendu`);
  }
  assert.equal((await send({ path: '/static/style.css?x=1' })).status, 200);
  const withNext = await send({ path: '/login?next=https://evil.example/' });
  assert.equal(withNext.status, 200);
  assert.ok(!withNext.body.includes('evil'));
  // Connexion réussie depuis une URL avec paramètre : redirection toujours vers « / ».
  const csrf = cookieValue(withNext, '__Host-mt_login_csrf');
  const res = await send({
    method: 'POST', path: '/login?next=https://evil.example/',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf, username: 'alice', password: PASSWORD, next: 'https://evil.example/' }),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
});

test('Content-Type multipart, liste de types ou absent : 400', async () => {
  const csrf = await loginCsrf();
  for (const type of ['multipart/form-data; boundary=x', 'application/x-www-form-urlencoded, text/plain', 'text/plain', null]) {
    const headers = { Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` };
    if (type !== null) headers['Content-Type'] = type;
    const res = await send({ method: 'POST', path: '/login', headers, body: form({ csrf, username: 'alice', password: PASSWORD }) });
    assert.equal(res.status, 400, String(type));
  }
});

// ---------------------------------------------------------------- concurrence

// MAX_PENDING_ARGON2 (16) connexions simultanées : toutes tiennent dans la file argon2.
// (Au-delà, le serveur répond 503 par conception : voir le test « file argon2 pleine ».)
test(`${MAX_PENDING_ARGON2} connexions simultanées (succès et échecs mêlés) : toutes traitées, jetons distincts, serveur disponible`, async () => {
  const n = MAX_PENDING_ARGON2;
  const results = await Promise.all(Array.from({ length: n }, (_, i) => login('alice', i % 2 ? PASSWORD : 'mauvais-mot-de-passe')));
  const ok = results.filter((r) => r.status === 303);
  assert.equal(ok.length, n / 2);
  assert.equal(results.filter((r) => r.status === 401).length, n / 2);
  const tokens = new Set(ok.map((r) => cookieValue(r, '__Host-mt_session')));
  assert.equal(tokens.size, n / 2);
  for (const token of tokens) assert.equal((await home(`__Host-mt_session=${token}`)).status, 200);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')));
});

// ---------------------------------------------------------------- client qui abandonne

/** POST /login dont le client coupe la connexion dès que la requête est envoyée. */
function abandonedLogin(toPort, csrf) {
  return new Promise((resolve) => {
    const body = form({ csrf, username: 'alice', password: 'mauvais-mot-de-passe' });
    const req = request({
      host: '127.0.0.1', port: toPort, path: '/login', method: 'POST', ca: certs.ca, agent: false,
      headers: { ...FORM_TYPE, Origin: `https://127.0.0.1:${toPort}`, Cookie: `__Host-mt_login_csrf=${csrf}`, 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', () => {});
    req.on('close', resolve);
    req.end(body, () => setImmediate(() => req.destroy()));
  });
}

test('clients qui coupent pendant le calcul ou le délai d\'échec : aucun plantage, serveur disponible', async () => {
  const slowLogs = [];
  const slow = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => slowLogs.push(l), loginFailureDelayMs: 300 });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slowPort = slow.address().port;
  try {
    const csrf = await loginCsrf(slowPort);
    await Promise.all(Array.from({ length: 10 }, () => abandonedLogin(slowPort, csrf)));
    await new Promise((r) => setTimeout(r, 1500)); // file argon2 vidée et délais écoulés
    assert.ok(slow.listening);
    assert.ok(!slowLogs.some((l) => l.startsWith('erreur interne')), slowLogs.join('\n'));
    assert.equal((await send({ path: '/login', toPort: slowPort })).status, 200);
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});

// Régression (revue étape 3, I1) : l'adresse était lue APRÈS le calcul argon2 ; un client qui
// coupait aussitôt effaçait sa source du journal des échecs (« depuis - »).
test('journal des échecs : l\'adresse source est conservée même si le client coupe aussitôt', async () => {
  const slowLogs = [];
  const slow = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => slowLogs.push(l), loginFailureDelayMs: 0 });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slowPort = slow.address().port;
  try {
    const csrf = await loginCsrf(slowPort);
    await Promise.all(Array.from({ length: 5 }, () => abandonedLogin(slowPort, csrf)));
    await new Promise((r) => setTimeout(r, 1000));
    const refused = slowLogs.filter((l) => l.startsWith('connexion refusée'));
    assert.equal(refused.length, 5);
    for (const l of refused) assert.match(l, /^connexion refusée depuis [0-9a-f.:]+$/);
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});

// ---------------------------------------------------------------- file argon2 bornée (revue étape 3, B1)

async function waitArgon2Idle() {
  const deadline = Date.now() + 10_000;
  while (argon2Stats().pending > 0) {
    assert.ok(Date.now() < deadline, 'file argon2 jamais vidée');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('50 POST /login abandonnés aussitôt : au plus 16 calculs argon2, puis serveur disponible et connexion légitime réussie', async () => {
  await waitArgon2Idle();
  const startedBefore = argon2Stats().started;
  const csrf = await loginCsrf();
  await Promise.all(Array.from({ length: 50 }, () => abandonedLogin(port, csrf)));
  await waitArgon2Idle();
  const computed = argon2Stats().started - startedBefore;
  assert.ok(computed <= MAX_PENDING_ARGON2, `${computed} calculs argon2 lancés`);
  assert.ok(server.listening);
  assert.equal((await send({ path: '/login' })).status, 200);
  assert.equal((await login('alice', PASSWORD)).status, 303);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')));
});

test('file argon2 pleine : 503 sans corps, Connection: close, aucun calcul, journal avec la seule adresse', async () => {
  await waitArgon2Idle();
  const csrf = await loginCsrf();
  // Remplit la file depuis le test (même module que le serveur) : un premier calcul lent
  // (64 Mio, 16 passes, ~0,5 s) garde les 16 places occupées pendant la requête.
  const b64 = (b) => b.toString('base64').replace(/=+$/, '');
  const slowHash = `$argon2id$v=19$m=65536,t=16,p=1$${b64(Buffer.alloc(16, 1))}$${b64(Buffer.alloc(32))}`;
  const fillers = [verifyPassword('x', slowHash)];
  while (argon2Stats().pending < MAX_PENDING_ARGON2) fillers.push(verifyPassword('x', DUMMY_HASH));
  const startedBefore = argon2Stats().started;
  try {
    const res = await send({
      method: 'POST', path: '/login',
      headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
      body: form({ csrf, username: 'alice', password: PASSWORD }),
    });
    assert.equal(res.status, 503);
    assert.equal(res.body, '');
    assert.equal(res.headers.connection, 'close');
    assert.equal(cookieValue(res, '__Host-mt_session'), undefined);
    assert.match(logs.at(-1), /^connexion refusée : file argon2 pleine, depuis [0-9a-f.:]+$/);
    // Aucun calcul lancé pour la requête refusée (seuls les calculs de remplissage avancent).
    assert.ok(argon2Stats().started - startedBefore <= fillers.length);
  } finally {
    await Promise.all(fillers);
  }
  // File vidée : la connexion fonctionne de nouveau.
  assert.equal((await login('alice', PASSWORD)).status, 303);
});

// ---------------------------------------------------------------- journal des refus CSRF (S1) et charset (S3)

test('refus CSRF journalisés avec la seule cause et l\'adresse, jamais les valeurs reçues', async () => {
  const csrf = await loginCsrf();
  const marker = 'zz-valeur-attaquant';
  await send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: `https://${marker}.example`, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf, username: marker, password: marker }),
  });
  assert.match(logs.at(-1), /^requête refusée : origin, depuis [0-9a-f.:]+$/);
  await send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf: marker, username: marker, password: marker }),
  });
  assert.match(logs.at(-1), /^requête refusée : csrf, depuis [0-9a-f.:]+$/);
  await send({
    method: 'POST', path: '/logout',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_session=${marker}` },
    body: form({ csrf: marker }),
  });
  assert.match(logs.at(-1), /^requête refusée : csrf, depuis [0-9a-f.:]+$/);
  assert.ok(!logs.some((l) => l.includes(marker)));
});

test('Content-Type avec charset autre qu\'UTF-8 : 400 ; charset=UTF-8 (toute casse, guillemets) accepté', async () => {
  const attempt = async (contentType) => {
    const csrf = await loginCsrf();
    return send({
      method: 'POST', path: '/login',
      headers: { 'Content-Type': contentType, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
      body: form({ csrf, username: 'alice', password: PASSWORD }),
    });
  };
  for (const type of ['application/x-www-form-urlencoded; charset=ISO-8859-1', 'application/x-www-form-urlencoded; charset=utf-16',
    'application/x-www-form-urlencoded; charset=', 'application/x-www-form-urlencoded; charset',
    'application/x-www-form-urlencoded; charset=utf-8; charset=latin1']) {
    assert.equal((await attempt(type)).status, 400, type);
  }
  for (const type of ['application/x-www-form-urlencoded; charset=UTF-8', 'application/x-www-form-urlencoded;charset="utf-8"',
    'Application/X-WWW-Form-Urlencoded; Charset=Utf-8']) {
    assert.equal((await attempt(type)).status, 303, type);
  }
});

// ---------------------------------------------------------------- défense en profondeur

test('identifiant hors format présent en base (contrainte contournée) : 500 sans corps, jamais affiché', async () => {
  db.exec('PRAGMA ignore_check_constraints = ON');
  let userId;
  try {
    userId = db.prepare('INSERT INTO users (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)')
      .run('<script>x</script>', await hashPassword(PASSWORD), NOW).lastInsertRowid;
  } finally {
    db.exec('PRAGMA ignore_check_constraints = OFF');
  }
  try {
    const token = createSession(db, userId);
    const res = await home(`__Host-mt_session=${token}`);
    assert.equal(res.status, 500);
    assert.ok(!res.body.includes('<script>'));
    assert.equal((await send({ path: '/login' })).status, 200);
  } finally {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }
});
