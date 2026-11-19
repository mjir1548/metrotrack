// Interface web (étape 3) contre un vrai serveur HTTPS : connexion, déconnexion, sessions,
// CSRF (Origin + jeton), en-têtes de sécurité, absence de ressource externe, robustesse.
// Le délai après échec est mis à 0 sur le serveur principal ; le vrai délai (1 s) est testé
// sur un second serveur.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { createHash } from 'node:crypto';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { hashPassword } from '../server/password.js';
import { csrfTokenFor } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';
import { statusOrCut, CUT } from './coupure.js';

const NOW = '2026-11-17T10:00:00.000Z';
const READER_KEY = Buffer.alloc(32, 0x33);
const PASSWORD = 'Un-mot-de-passe-solide-42';
const GENERIC = 'Identifiant ou mot de passe incorrect.';
let dir, db, server, port, certs, origin;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-web-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(READER_KEY, NOW);
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, active, created_at) VALUES (?, ?, ?, ?)');
  insertUser.run('alice', await hashPassword(PASSWORD), 1, NOW);
  insertUser.run('bob', await hashPassword(PASSWORD), 1, NOW);
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

/** Requête HTTPS (CA de test). headers : en-têtes ajoutés ; body : chaîne ou Buffer. */
function send({ method = 'GET', path = '/', headers = {}, body, toPort = port } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port: toPort, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const form = (fields) => new URLSearchParams(fields).toString();
const FORM_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };

/** Valeur d'un cookie dans les en-têtes Set-Cookie, et la ligne complète. */
function setCookie(res, name) {
  const line = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return line ? { line, value: line.slice(name.length + 1).split(';')[0] } : null;
}
const hiddenCsrf = (html) => /<input type="hidden" name="csrf" value="([^"]*)">/.exec(html)?.[1];

/** GET /login : renvoie le jeton CSRF de connexion (cookie et champ caché, égaux). */
async function loginCsrf(toPort = port) {
  const res = await send({ path: '/login', toPort });
  assert.equal(res.status, 200);
  const cookie = setCookie(res, '__Host-mt_login_csrf').value;
  assert.equal(hiddenCsrf(res.body), cookie);
  return cookie;
}

/** POST /login complet (Origin correct, jeton CSRF valide), sauf surcharge. */
async function login(username, password, { extraCookie = '', toPort = port } = {}) {
  const csrf = await loginCsrf(toPort);
  return send({
    method: 'POST', path: '/login', toPort,
    headers: { ...FORM_TYPE, Origin: `https://127.0.0.1:${toPort}`, Cookie: `__Host-mt_login_csrf=${csrf}${extraCookie}` },
    body: form({ csrf, username, password }),
  });
}

/** Connexion réussie : jeton de session (valeur du cookie). */
async function sessionFor(username = 'alice') {
  const res = await login(username, PASSWORD);
  assert.equal(res.status, 303, res.body);
  return setCookie(res, '__Host-mt_session').value;
}

const home = (token) => send({ path: '/', headers: token ? { Cookie: `__Host-mt_session=${token}` } : {} });
const sessionRows = (token) =>
  db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(createHash('sha256').update(token).digest()).n;

function logout(token, { csrf = csrfTokenFor(token), originHeader = origin } = {}) {
  const headers = { ...FORM_TYPE, Cookie: `__Host-mt_session=${token}` };
  if (originHeader !== null) headers.Origin = originHeader;
  return send({ method: 'POST', path: '/logout', headers, body: form(csrf === null ? {} : { csrf }) });
}

function assertSecurityHeaders(res, what) {
  assert.equal(res.headers['content-security-policy'], "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", what);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
  assert.equal(res.headers['referrer-policy'], 'same-origin', what);
  assert.equal(res.headers['strict-transport-security'], 'max-age=31536000', what);
}

// ---------------------------------------------------------------- pages et en-têtes

test('GET / sans session : 303 vers /login', async () => {
  const res = await home();
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/login');
  assert.equal(res.body, '');
  assertSecurityHeaders(res, 'GET /');
});

test('GET /login : page HTML, en-têtes de sécurité, cookie CSRF de connexion __Host- court', async () => {
  const res = await send({ path: '/login' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'no-store');
  assertSecurityHeaders(res, 'GET /login');
  assert.match(res.body, /^<!doctype html>\n<html lang="fr">/);
  const { line, value } = setCookie(res, '__Host-mt_login_csrf');
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  const attrs = line.split(';').map((a) => a.trim());
  for (const a of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=600']) assert.ok(attrs.includes(a), `${a} dans ${line}`);
  assert.ok(!/domain=/i.test(line));
  // Deux visites : le jeton présenté en cookie est réutilisé (plusieurs onglets restent valides).
  const again = await send({ path: '/login', headers: { Cookie: `__Host-mt_login_csrf=${value}` } });
  assert.equal(hiddenCsrf(again.body), value);
});

test('pages sans aucune ressource externe ni script ou style inline', async () => {
  const token = await sessionFor('bob');
  const pages = {
    login: (await send({ path: '/login' })).body,
    accueil: (await home(token)).body,
    echec: (await login('alice', 'mauvais-mot-de-passe')).body,
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(html.length > 100, name);
    for (const [, url] of html.matchAll(/\b(?:src|href|action)\s*=\s*"([^"]*)"/gi)) {
      // Chemin local : commence par une seule « / » (« / » seul accepté : lien vers l'inventaire).
      assert.match(url, /^\/(?!\/)/, `${name} : URL non locale ${url}`);
    }
    assert.doesNotMatch(html, /https?:|\/\//i, name);
    assert.doesNotMatch(html, /<script|<style|\sstyle\s*=|\son[a-z]+\s*=/i, name);
  }
});

test('GET /static/style.css : CSS servi localement, sans import ni URL distante', async () => {
  const res = await send({ path: '/static/style.css' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
  assertSecurityHeaders(res, 'CSS');
  assert.equal(res.body, readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'style.css'), 'utf8'));
  assert.doesNotMatch(res.body, /@import|url\(|https?:|\/\//i);
});

test('routes inconnues : 404 (aucun accès aux fichiers par l\'URL) ; méthode inadaptée : 405 avec Allow', async () => {
  for (const path of ['/inconnu', '/static/', '/static/../server/main.js', '/static/%2e%2e/config.json', '/__proto__', '/constructor', '/login/']) {
    const res = await send({ path });
    assert.equal(res.status, 404, path);
    assert.equal(res.body, '', path);
  }
  const put = await send({ method: 'PUT', path: '/login', body: '' });
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET, POST');
  const postHome = await send({ method: 'POST', path: '/', body: '' });
  assert.equal(postHome.status, 405);
  assert.equal(postHome.headers.allow, 'GET');
  assert.equal((await send({ path: '/logout' })).status, 405);
});

// ---------------------------------------------------------------- connexion

test('connexion réussie : 303 vers /, cookie de session __Host- HttpOnly Secure SameSite=Strict Path=/', async () => {
  const res = await login('alice', PASSWORD);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
  const { line, value } = setCookie(res, '__Host-mt_session');
  assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  const attrs = line.split(';').map((a) => a.trim());
  for (const a of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert.ok(attrs.includes(a), `${a} dans ${line}`);
  assert.ok(!/domain=/i.test(line));
  // Le cookie CSRF de connexion, devenu inutile, est effacé.
  assert.match(setCookie(res, '__Host-mt_login_csrf').line, /Max-Age=0/);
  // Page protégée accessible avec ce cookie.
  const page = await home(value);
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body, /Connecté en tant que <strong>alice<\/strong>/);
  assert.equal(hiddenCsrf(page.body), csrfTokenFor(value));
  assert.ok(logs.some((l) => /^connexion réussie : compte alice depuis /.test(l)));
});

test('identifiant insensible à la casse à la connexion', async () => {
  assert.equal((await login('ALICE', PASSWORD)).status, 303);
});

test('en base : seulement le SHA-256 du jeton ; le jeton brut n\'apparaît ni en base ni dans le fichier', async () => {
  const token = await sessionFor();
  assert.equal(sessionRows(token), 1);
  for (const row of db.prepare('SELECT * FROM sessions').all()) {
    for (const v of Object.values(row)) assert.ok(!String(v).includes(token));
  }
  db.exec('PRAGMA wal_checkpoint(FULL)');
  for (const f of ['test.db', 'test.db-wal']) {
    const path = join(dir, f);
    if (existsSync(path)) assert.ok(!readFileSync(path).includes(Buffer.from(token)), f);
  }
});

test('mauvais mot de passe et compte inconnu : 401, même page au message générique, identifiant non réaffiché', async () => {
  const csrf = await loginCsrf();
  const attempt = (username, password) => send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf, username, password }),
  });
  const before = db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n;
  const wrong = await attempt('alice', 'pas-le-bon-mot-de-passe');
  const unknown = await attempt('zz-compte-inconnu', 'pas-le-bon-mot-de-passe');
  const malformed = await attempt('<b>x</b>', 'pas-le-bon-mot-de-passe');
  for (const res of [wrong, unknown, malformed]) {
    assert.equal(res.status, 401);
    assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(setCookie(res, '__Host-mt_session'), null);
    assert.ok(res.body.includes(GENERIC));
    assertSecurityHeaders(res, 'échec');
  }
  assert.equal(unknown.body, wrong.body);
  assert.equal(malformed.body, wrong.body);
  assert.ok(!unknown.body.includes('zz-compte-inconnu'));
  assert.ok(!wrong.body.includes('alice'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, before);
  // Le formulaire réaffiché reste utilisable : même jeton CSRF.
  assert.equal(hiddenCsrf(wrong.body), csrf);
});

test('journal : échec sans identifiant ni mot de passe ; aucun jeton ni mot de passe dans le journal', async () => {
  await login('zz-identifiant-tape', 'zz-mot-de-passe-tape');
  const failure = logs.filter((l) => l.startsWith('connexion refusée'));
  assert.ok(failure.length > 0);
  for (const l of failure) assert.match(l, /^connexion refusée depuis [0-9a-f.:]+$/);
  const token = await sessionFor();
  for (const l of logs) {
    assert.ok(!l.includes('zz-identifiant-tape') && !l.includes('zz-mot-de-passe-tape'), l);
    assert.ok(!l.includes(PASSWORD) && !l.includes(token) && !l.includes('$argon2id$'), l);
  }
});

test('compte désactivé : connexion refusée (401 générique) et sessions existantes refusées', async () => {
  const refused = await login('desactive', PASSWORD);
  assert.equal(refused.status, 401);
  assert.ok(refused.body.includes(GENERIC));
  const token = await sessionFor('bob');
  assert.equal((await home(token)).status, 200);
  db.exec("UPDATE users SET active = 0 WHERE username = 'bob'");
  try {
    const res = await home(token);
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, '/login');
  } finally {
    db.exec("UPDATE users SET active = 1 WHERE username = 'bob'");
  }
});

test('session expirée (expires_at dans le passé) : refusée', async () => {
  const token = await sessionFor();
  db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?")
    .run(createHash('sha256').update(token).digest());
  const res = await home(token);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/login');
});

test('cookie de session inventé ou malformé : 303 vers /login', async () => {
  for (const t of ['A'.repeat(43), 'abc', '', '%00', 'x'.repeat(5000)]) {
    assert.equal((await home(t)).status, 303, t.slice(0, 10));
  }
});

test('GET /login déjà connecté : 303 vers /', async () => {
  const token = await sessionFor();
  const res = await send({ path: '/login', headers: { Cookie: `__Host-mt_session=${token}` } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/');
});

test('anti-fixation : une connexion avec un cookie de session existant émet un nouveau jeton et supprime l\'ancien', async () => {
  const old = await sessionFor();
  const res = await login('alice', PASSWORD, { extraCookie: `; __Host-mt_session=${old}` });
  assert.equal(res.status, 303);
  const fresh = setCookie(res, '__Host-mt_session').value;
  assert.notEqual(fresh, old);
  assert.equal(sessionRows(old), 0);
  assert.equal((await home(old)).status, 303);
  assert.equal((await home(fresh)).status, 200);
});

test('connexion : Content-Type autre que formulaire → 400 ; corps trop gros → 413, serveur vivant', async () => {
  const csrf = await loginCsrf();
  const headers = { Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` };
  const json = await send({ method: 'POST', path: '/login', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(json.status, 400);
  const big = await send({ method: 'POST', path: '/login', headers: { ...headers, ...FORM_TYPE }, body: 'a='.padEnd(5000, 'b') });
  assert.equal(big.status, 413);
  assert.equal(big.headers.connection, 'close');
  // Corps en flux (sans Content-Length) au-delà du plafond : 413, ou connexion coupée si le
  // serveur ferme pendant que le client écrit encore (coupure.js).
  const streamed = await statusOrCut(new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/login', method: 'POST', ca: certs.ca, agent: false, headers: { ...headers, ...FORM_TYPE },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    for (let i = 0; i < 10; i++) req.write(Buffer.alloc(1000, 0x61));
    req.end();
  }));
  assert.ok([413, CUT].includes(streamed), String(streamed));
  assert.ok(server.listening);
  assert.equal((await login('alice', PASSWORD)).status, 303);
});

// ---------------------------------------------------------------- CSRF

test('POST /login : sans jeton, mauvais jeton, sans cookie, sans Origin, Origin étranger ou en clair → 403', async () => {
  const csrf = await loginCsrf();
  const other = await loginCsrf();
  const cases = {
    'sans champ csrf': { origin, cookie: csrf, field: null },
    'champ csrf vide': { origin, cookie: csrf, field: '' },
    'mauvais jeton': { origin, cookie: csrf, field: other },
    'sans cookie': { origin, cookie: null, field: csrf },
    'cookie et champ vides': { origin, cookie: '', field: '' },
    'sans Origin': { origin: null, cookie: csrf, field: csrf },
    'Origin étranger': { origin: 'https://evil.example', cookie: csrf, field: csrf },
    'Origin en clair': { origin: `http://127.0.0.1:${port}`, cookie: csrf, field: csrf },
    'Origin null': { origin: 'null', cookie: csrf, field: csrf },
    'Origin autre port': { origin: `https://127.0.0.1:${port + 1}`, cookie: csrf, field: csrf },
  };
  for (const [name, c] of Object.entries(cases)) {
    const headers = { ...FORM_TYPE };
    if (c.origin !== null) headers.Origin = c.origin;
    if (c.cookie !== null) headers.Cookie = `__Host-mt_login_csrf=${c.cookie}`;
    const fields = { username: 'alice', password: PASSWORD };
    if (c.field !== null) fields.csrf = c.field;
    const res = await send({ method: 'POST', path: '/login', headers, body: form(fields) });
    assert.equal(res.status, 403, name);
    assert.equal(setCookie(res, '__Host-mt_session'), null, name);
    assertSecurityHeaders(res, name);
  }
});

test('POST /logout : sans jeton, mauvais jeton, jeton d\'une autre session, sans Origin, Origin étranger → 403, session intacte', async () => {
  const token = await sessionFor();
  const otherToken = await sessionFor('bob');
  const cases = {
    'sans jeton': { csrf: null },
    'mauvais jeton': { csrf: 'A'.repeat(43) },
    'jeton de session brut': { csrf: token },
    'jeton d\'une autre session': { csrf: csrfTokenFor(otherToken) },
    'sans Origin': { originHeader: null },
    'Origin étranger': { originHeader: 'https://evil.example' },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const res = await logout(token, opts);
    assert.equal(res.status, 403, name);
    assert.equal(sessionRows(token), 1, name);
  }
  assert.equal((await home(token)).status, 200);
  // Sans session du tout : 403 également.
  const anonymous = await send({ method: 'POST', path: '/logout', headers: { ...FORM_TYPE, Origin: origin }, body: form({ csrf: 'x' }) });
  assert.equal(anonymous.status, 403);
});

// ---------------------------------------------------------------- déconnexion

test('déconnexion : 303 vers /login, cookie effacé, session supprimée en base, ancien cookie refusé', async () => {
  const token = await sessionFor();
  const res = await logout(token);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/login');
  assert.match(setCookie(res, '__Host-mt_session').line, /^__Host-mt_session=; .*Max-Age=0/);
  assert.equal(sessionRows(token), 0);
  const after = await home(token);
  assert.equal(after.status, 303);
  assert.equal(after.headers.location, '/login');
  // Une seconde déconnexion avec le même cookie : plus de session, donc 403.
  assert.equal((await logout(token)).status, 403);
});

// ---------------------------------------------------------------- boîtiers et robustesse

test('POST /api/frames fonctionne toujours sans session ni CSRF (204), en-têtes web absents', async () => {
  const body = encodeFrame({ readerId: 1, counter: 1, uid: Buffer.from('DEADBEEF', 'hex'), key: READER_KEY });
  const res = await send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body });
  assert.equal(res.status, 204);
  assert.equal(res.headers['content-security-policy'], undefined);
  const replay = await send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body });
  assert.equal(replay.status, 400);
  assert.equal(replay.headers.connection, 'close');
});

test('requêtes web malformées en octets bruts : pas de plantage', async () => {
  const raw = (text) => new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca }, () => socket.end(text));
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('error', () => {});
    socket.on('close', () => resolve(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? null));
  });
  const statuses = [
    await raw('POST /login HTTP/1.1\r\nHost: x\r\nOrigin: https://x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 10\r\n\r\ncsrf=%E0%A'),
    await raw('POST /login HTTP/1.1\r\nHost: x\r\nOrigin: https://x\r\nOrigin: https://x\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 0\r\n\r\n'),
    await raw('GET / HTTP/1.1\r\nHost: x\r\nCookie: ;;==;__Host-mt_session\r\nConnection: close\r\n\r\n'),
    await raw('POST /logout HTTP/1.1\r\nHost: x\r\nOrigin: https://x\r\nCookie: __Host-mt_session=%%%\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: 0\r\n\r\n'),
  ];
  assert.deepEqual(statuses, ['403', '403', '303', '403']);
  assert.ok(server.listening);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.filter((l) => l.startsWith('erreur interne')).join('\n'));
});

// ---------------------------------------------------------------- vrai délai

test('délai réel d\'1 s après un échec (compte inconnu comme mauvais mot de passe), sans bloquer le serveur', async () => {
  const slow = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {} });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const slowPort = slow.address().port;
  try {
    const timed = async (fn) => { const t = performance.now(); const res = await fn(); return { res, ms: performance.now() - t }; };
    // Le jeton CSRF est obtenu avant de chronométrer.
    const attempt = async (username, password) => {
      const csrf = await loginCsrf(slowPort);
      return timed(() => send({
        method: 'POST', path: '/login', toPort: slowPort,
        headers: { ...FORM_TYPE, Origin: `https://127.0.0.1:${slowPort}`, Cookie: `__Host-mt_login_csrf=${csrf}` },
        body: form({ csrf, username, password }),
      }));
    };
    const pending = attempt('alice', 'mauvais-mot-de-passe');
    // Pendant le délai, le serveur répond normalement.
    await new Promise((r) => setTimeout(r, 200));
    const during = await timed(() => send({ path: '/login', toPort: slowPort }));
    assert.equal(during.res.status, 200);
    assert.ok(during.ms < 800, `GET /login pendant le délai : ${during.ms} ms`);
    const wrong = await pending;
    const unknown = await attempt('zz-inconnu', 'mauvais-mot-de-passe');
    for (const { res, ms } of [wrong, unknown]) {
      assert.equal(res.status, 401);
      assert.ok(ms >= 990, `réponse en ${ms} ms`);
    }
    // Succès : pas de délai imposé.
    const ok = await attempt('alice', PASSWORD);
    assert.equal(ok.res.status, 303);
    assert.ok(ok.ms < 900, `succès en ${ok.ms} ms`);
  } finally {
    slow.closeAllConnections();
    slow.close();
  }
});
