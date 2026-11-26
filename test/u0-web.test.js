// Étape U0 (correctifs de l'audit UX) côté web, contre un vrai serveur HTTPS :
//   - page de connexion restée ouverte (jeton de connexion expiré) : formulaire réaffiché,
//     sans calcul argon2 ; toute autre falsification reste refusée en 403 ;
//   - session expirée pendant un envoi : la connexion l'explique (?info=session, liste blanche) ;
//   - pages d'erreur lisibles (404, 405, 400, 413, 500, 403) au lieu de pages blanches ;
//   - POST /api/frames inchangé : réponses toujours sans corps (docs/protocole.md §5, D-008).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { hashPassword, argon2Stats } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { LOGIN_EXPIRED_MESSAGE, SESSION_EXPIRED_MESSAGE } from '../server/views.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-25T10:00:00.000Z';
const READER_KEY = Buffer.alloc(32, 0x5a);
const PASSWORD = 'Un-mot-de-passe-solide-42';
const TOKEN_43 = /^[A-Za-z0-9_-]{43}$/;
let dir, db, server, port, certs, origin, session;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u0-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(READER_KEY, NOW);
  const userId = db.prepare('INSERT INTO users (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)')
    .run('alice', await hashPassword(PASSWORD), NOW).lastInsertRowid;
  db.prepare("INSERT INTO items (id, name, created_at, updated_at) VALUES (1, 'Multimètre', ?, ?)").run(NOW, NOW);
  session = createSession(db, userId);
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

function send({ method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
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
const withSession = (headers = {}) => ({ ...headers, Cookie: `__Host-mt_session=${session}` });
function setCookie(res, name) {
  const line = (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
  return line ? { line, value: line.slice(name.length + 1).split(';')[0] } : null;
}
const hiddenCsrf = (html) => /<input type="hidden" name="csrf" value="([^"]*)">/.exec(html)?.[1];

/** En-têtes de sécurité attendus sur toute page de l'interface, pages d'erreur comprises. */
function assertWebHeaders(res, what) {
  assert.equal(res.headers['content-security-policy'], "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", what);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
  assert.equal(res.headers['referrer-policy'], 'same-origin', what);
  assert.equal(res.headers['strict-transport-security'], 'max-age=31536000', what);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', what);
  assert.equal(res.headers['cache-control'], 'no-store', what);
}

/** Page d'erreur : titre, aucun code d'erreur visible, lien selon la session, connexion fermée. */
function assertErrorPage(res, { status, title, connected }) {
  const what = `${status} ${title}`;
  assert.equal(res.status, status, what);
  assertWebHeaders(res, what);
  assert.equal(res.headers.connection, 'close', what);
  assert.ok(res.body.startsWith('<!doctype html>'), what);
  assert.ok(res.body.includes(`<h1>${title}</h1>`), what);
  assert.ok(res.body.includes(`<title>${title} · MetroTrack</title>`), what);
  assert.ok(!res.body.includes(String(status)), `${what} : code d'erreur visible`);
  if (connected) {
    assert.ok(res.body.includes('<a class="bouton" href="/">Revenir à l\'inventaire</a>'), what);
    assert.ok(!res.body.includes('Se connecter'), what);
  } else {
    assert.ok(res.body.includes('<a class="bouton" href="/login">Se connecter</a>'), what);
    assert.ok(!res.body.includes('inventaire'), what);
  }
  assert.doesNotMatch(res.body, /<script|\sstyle\s*=|https?:/i, what);
}

/** POST /login sans cookie de connexion (le navigateur l'a supprimé après 10 min). */
function expiredLogin(fields, headers = {}) {
  return send({ method: 'POST', path: '/login', headers: { ...FORM_TYPE, Origin: origin, ...headers }, body: form(fields) });
}

// ---------------------------------------------------------------- 2. connexion expirée

test('jeton de connexion expiré : page réaffichée (200), message, identifiant pré-rempli, mot de passe vidé, nouveau jeton, AUCUN calcul argon2', async () => {
  const oldToken = (await send({ path: '/login' })).headers['set-cookie'][0].split(';')[0].split('=')[1];
  assert.match(oldToken, TOKEN_43);
  const startedBefore = argon2Stats().started;
  const res = await expiredLogin({ csrf: oldToken, username: 'alice', password: PASSWORD });
  assert.equal(argon2Stats().started, startedBefore, 'aucun calcul argon2');
  assert.equal(res.status, 200);
  assertWebHeaders(res, 'connexion expirée');
  assert.ok(res.body.includes(`<p class="erreur" role="alert">${LOGIN_EXPIRED_MESSAGE.replace(/'/g, '&#39;')}</p>`), res.body);
  assert.ok(res.body.includes('<input id="username" name="username" value="alice"'), 'identifiant pré-rempli');
  assert.match(res.body, /<input id="password" name="password" type="password" autocomplete="current-password" required autofocus>/);
  assert.ok(!res.body.includes(PASSWORD), 'mot de passe jamais réaffiché');
  assert.equal(setCookie(res, '__Host-mt_session'), null, 'aucune session');
  // Nouveau jeton : dans le cookie (mêmes attributs qu'au GET /login) et dans le formulaire.
  const fresh = setCookie(res, '__Host-mt_login_csrf');
  assert.match(fresh.value, TOKEN_43);
  assert.notEqual(fresh.value, oldToken);
  assert.equal(hiddenCsrf(res.body), fresh.value);
  for (const attr of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Max-Age=600']) assert.ok(fresh.line.includes(attr), attr);
  assert.ok(logs.some((l) => l.startsWith('connexion : jeton de connexion expiré, formulaire réaffiché, depuis ')));
  // L'utilisateur ressaisit son mot de passe : connexion normale avec le nouveau jeton.
  const retry = await send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${fresh.value}` },
    body: form({ csrf: fresh.value, username: 'alice', password: PASSWORD }),
  });
  assert.equal(retry.status, 303);
  assert.equal(retry.headers.location, '/');
  assert.match(setCookie(retry, '__Host-mt_session').value, TOKEN_43);
});

test('jeton de connexion expiré : identifiant hors format jamais réaffiché, même échappé ; aucun argon2', async () => {
  const startedBefore = argon2Stats().started;
  for (const username of ['<script>alert(1)</script>', 'a"b', 'é', 'x'.repeat(65), '']) {
    const res = await expiredLogin({ csrf: 'A'.repeat(43), username, password: 'quelconque' });
    assert.equal(res.status, 200, username);
    assert.ok(res.body.includes('<input id="username" name="username" autocomplete="username"'), `${username} : champ vide`);
    // (Pas de recherche de « value="a » dans toute la page : le jeton caché, aléatoire, peut
    // commencer par « a » ; seul le champ identifiant compte, vérifié ci-dessus.)
    assert.ok(!res.body.includes('name="username" value=') && !res.body.includes('a&quot;b') && !res.body.includes('script>') && !res.body.includes('&lt;script'), username);
    assert.ok(!res.body.includes('quelconque'), username);
  }
  assert.equal(argon2Stats().started, startedBefore);
});

test('falsifications de connexion : toujours 403 « Action refusée », sans argon2 ni session (Origin faux, jeton absent, mal formé ou différent)', async () => {
  const good = setCookie(await send({ path: '/login' }), '__Host-mt_login_csrf').value;
  const startedBefore = argon2Stats().started;
  const fields = { username: 'alice', password: PASSWORD };
  const cases = {
    'Origin étranger, sans cookie': { headers: { Origin: 'https://evil.example' }, csrf: good },
    'sans Origin, sans cookie': { headers: { Origin: null }, csrf: good },
    'Origin null, sans cookie': { headers: { Origin: 'null' }, csrf: good },
    'sans cookie, champ absent': { headers: {}, csrf: null },
    'sans cookie, champ mal formé': { headers: {}, csrf: 'pas-un-jeton' },
    'sans cookie, champ trop long': { headers: {}, csrf: `${good}A` },
    'cookie présent mais différent': { headers: { Cookie: `__Host-mt_login_csrf=${'B'.repeat(43)}` }, csrf: good },
    'cookie vide': { headers: { Cookie: '__Host-mt_login_csrf=' }, csrf: good },
  };
  for (const [name, c] of Object.entries(cases)) {
    const headers = { ...FORM_TYPE, Origin: origin, ...c.headers };
    if (headers.Origin === null) delete headers.Origin;
    const body = form(c.csrf === null ? fields : { ...fields, csrf: c.csrf });
    const res = await send({ method: 'POST', path: '/login', headers, body });
    assert.equal(res.status, 403, name);
    assert.ok(res.body.includes('<h1>Action refusée</h1>'), name);
    assert.ok(res.body.includes('<a class="bouton" href="/login">Revenir à la connexion</a>'), name);
    assert.equal(setCookie(res, '__Host-mt_session'), null, name);
    assert.equal(res.headers.connection, 'close', name);
    assertWebHeaders(res, name);
  }
  assert.equal(argon2Stats().started, startedBefore, 'aucun calcul argon2');
});

// ---------------------------------------------------------------- 3. session expirée pendant un envoi

test('session expirée pendant un envoi : 303 vers /login?info=session, puis la connexion affiche le message ; codes inconnus ignorés', async () => {
  const before = db.prepare('SELECT count(*) AS n FROM items').get().n;
  const res = await send({
    method: 'POST', path: '/items/new',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_session=${'Z'.repeat(43)}` },
    body: form({ csrf: csrfTokenFor('Z'.repeat(43)), name: 'Perdu' }),
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/login?info=session');
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, before);

  const loginPage = await send({ path: '/login?info=session' });
  assert.equal(loginPage.status, 200);
  assert.ok(loginPage.body.includes(`<p class="erreur" role="alert">${SESSION_EXPIRED_MESSAGE}</p>`));
  // Liste blanche : tout autre code n'affiche rien, et rien du paramètre n'est reflété.
  for (const code of ['autre', '__proto__', 'toString', 'hasOwnProperty', '<script>x</script>', 'Session', '']) {
    const other = await send({ path: `/login?info=${encodeURIComponent(code)}` });
    assert.equal(other.status, 200, code);
    assert.ok(!other.body.includes('class="erreur"'), code);
    assert.ok(!other.body.includes('script>'), code);
  }
  // Connecté : /login?info=session redirige vers l'inventaire, comme /login.
  const connected = await send({ path: '/login?info=session', headers: withSession() });
  assert.equal(connected.status, 303);
  assert.equal(connected.headers.location, '/');
  // Les pages (GET) sans session gardent leur redirection simple, sans message.
  const getPage = await send({ path: '/items/1' });
  assert.equal(getPage.status, 303);
  assert.equal(getPage.headers.location, '/login');
});

// ---------------------------------------------------------------- 4. pages d'erreur

test('404 : « Page introuvable », lien selon la session ; un non-connecté qui demande /items/<n> garde la redirection vers /login', async () => {
  for (const path of ['/inconnu', '/items/1/x', '/static/', '/chips/0A0B0C0D']) {
    assertErrorPage(await send({ path }), { status: 404, title: 'Page introuvable', connected: false });
    assertErrorPage(await send({ path, headers: withSession() }), { status: 404, title: 'Page introuvable', connected: true });
  }
  // Session invalide : traitée comme non connectée.
  assertErrorPage(await send({ path: '/inconnu', headers: { Cookie: `__Host-mt_session=${'Q'.repeat(43)}` } }),
    { status: 404, title: 'Page introuvable', connected: false });
  // Ressource existante ou non : même réponse pour un non-connecté (aucune révélation).
  for (const path of ['/items/1', '/items/999999', '/items/abc', '/stations/1', '/readers/999']) {
    const res = await send({ path });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.location, '/login', path);
    assert.equal(res.body, '', path);
  }
});

test('405 et 400 : « Action impossible » ; Allow conservé ; rien de la saisie reflété', async () => {
  const put = await send({ method: 'PUT', path: '/login', body: '' });
  assertErrorPage(put, { status: 405, title: 'Action impossible', connected: false });
  assert.equal(put.headers.allow, 'GET, POST');
  const del = await send({ method: 'DELETE', path: '/items/1', headers: withSession(), body: '' });
  assertErrorPage(del, { status: 405, title: 'Action impossible', connected: true });
  assert.equal(del.headers.allow, 'GET');
  assert.ok(del.body.includes('Revenez en arrière et réessayez.'));

  // 400 : type de contenu ou jeu de caractères refusés (connexion, puis formulaire d'une session).
  const badType = await send({ method: 'POST', path: '/login', headers: { 'Content-Type': 'text/plain', Origin: origin }, body: 'username=<b>moi</b>' });
  assertErrorPage(badType, { status: 400, title: 'Action impossible', connected: false });
  assert.ok(!badType.body.includes('moi'));
  const badCharset = await send({
    method: 'POST', path: '/items/new',
    headers: withSession({ 'Content-Type': 'application/x-www-form-urlencoded; charset=iso-8859-1', Origin: origin }),
    body: form({ csrf: csrfTokenFor(session), name: 'Reflet<i>' }),
  });
  assertErrorPage(badCharset, { status: 400, title: 'Action impossible', connected: true });
  assert.ok(!badCharset.body.includes('Reflet'));
});

test('405 sur un GET (adresse tapée, ex. /logout) : « Cette adresse ne s\'ouvre pas directement. », sans parler de formulaire ; POST garde le texte « formulaire »', async () => {
  for (const [path, allow] of [['/logout', 'POST']]) {
    for (const connected of [false, true]) {
      const res = await send({ path, headers: connected ? withSession() : {} });
      assertErrorPage(res, { status: 405, title: 'Action impossible', connected });
      assert.equal(res.headers.allow, allow);
      assert.ok(res.body.includes('Cette adresse ne s&#39;ouvre pas directement.'), `${path} ${connected}`);
      assert.ok(!res.body.includes('formulaire'), `${path} ${connected}`);
    }
  }
  // HEAD : même choix de texte (aucun corps n'est envoyé, seul le code compte).
  assert.equal((await send({ method: 'HEAD', path: '/logout' })).status, 405);
  // POST sur une route en lecture seule : texte « formulaire » inchangé.
  const post = await send({ method: 'POST', path: '/', headers: withSession(FORM_TYPE), body: '' });
  assertErrorPage(post, { status: 405, title: 'Action impossible', connected: true });
  assert.ok(post.body.includes('Le formulaire envoyé n&#39;a pas pu être lu.'));
});

test('envoi sans AUCUN cookie de session (jamais connecté) : /login sans message ; cookie présent mais invalide : /login?info=session', async () => {
  const body = form({ csrf: 'x', name: 'Perdu' });
  const none = await send({ method: 'POST', path: '/items/new', headers: { ...FORM_TYPE, Origin: origin }, body });
  assert.equal(none.status, 303);
  assert.equal(none.headers.location, '/login');
  // Autres cookies présents (ex. jeton de connexion), mais pas de session : toujours sans message.
  const other = await send({ method: 'POST', path: '/items/new', headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${'A'.repeat(43)}` }, body });
  assert.equal(other.headers.location, '/login');
  // Cookie de session vide : traité comme absent.
  const empty = await send({ method: 'POST', path: '/items/new', headers: { ...FORM_TYPE, Origin: origin, Cookie: '__Host-mt_session=' }, body });
  assert.equal(empty.headers.location, '/login');
  // Cookie de session présent mais inconnu, expiré ou mal formé : message « session expirée ».
  for (const value of ['Z'.repeat(43), 'mal-forme']) {
    const res = await send({ method: 'POST', path: '/items/new', headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_session=${value}` }, body });
    assert.equal(res.status, 303, value);
    assert.equal(res.headers.location, '/login?info=session', value);
  }
  assert.ok(!(await send({ path: '/login' })).body.includes('class="erreur"'));
});

test('413 : « Formulaire trop long » (connexion sans session, édition avec session), connexion fermée', async () => {
  const big = await send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: origin, 'Content-Length': '5000' },
    body: 'a'.repeat(5000),
  }).catch((err) => ({ cut: err.code }));
  if (!big.cut) {
    assertErrorPage(big, { status: 413, title: 'Formulaire trop long', connected: false });
    assert.ok(big.body.includes('votre saisie est peut-être encore dans la page précédente'));
  }
  // Déterministe : longueur annoncée seule, sans corps (aucune coupure possible pendant l'envoi).
  const announced = await new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path: '/items/new', method: 'POST', ca: certs.ca, agent: false,
      headers: withSession({ ...FORM_TYPE, 'Content-Length': '300000', Origin: origin }),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }); req.destroy(); });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
    req.flushHeaders();
  });
  assertErrorPage(announced, { status: 413, title: 'Formulaire trop long', connected: true });
});

test('500 : « Un problème est survenu », sans aucun détail technique ; le serveur continue', async () => {
  db.exec("CREATE TEMP TRIGGER audit_casse BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'panne-secrete-de-test'); END");
  try {
    const res = await send({
      method: 'POST', path: '/items/new',
      headers: withSession({ ...FORM_TYPE, Origin: origin }),
      body: form({ csrf: csrfTokenFor(session), name: 'Nouvelle' }),
    });
    assertErrorPage(res, { status: 500, title: 'Un problème est survenu', connected: true });
    assert.ok(res.body.includes('L&#39;opération n&#39;a pas abouti. Réessayez dans un instant.'));
    assert.ok(!res.body.includes('panne-secrete-de-test') && !res.body.includes('Nouvelle'));
    assert.equal(setCookie(res, '__Host-mt_session'), null);
  } finally {
    db.exec('DROP TRIGGER temp.audit_casse');
  }
  assert.ok(logs.some((l) => l.includes('erreur interne') && l.includes('panne-secrete-de-test')), 'la cause reste au journal');
  assert.equal((await send({ path: '/', headers: withSession() })).status, 200);
});

test('403 avec session valide : « Action refusée » et lien vers l\'inventaire (plus « Revenir à la connexion »)', async () => {
  const res = await send({
    method: 'POST', path: '/items/new',
    headers: withSession({ ...FORM_TYPE, Origin: origin }),
    body: form({ csrf: 'faux', name: 'x' }),
  });
  assert.equal(res.status, 403);
  assertWebHeaders(res, '403');
  assert.equal(res.headers.connection, 'close');
  assert.ok(res.body.includes('<h1>Action refusée</h1>'));
  assert.ok(res.body.includes('<a class="bouton" href="/">Revenir à l\'inventaire</a>'));
  assert.ok(!res.body.includes('Revenir à la connexion') && !res.body.includes('Requête refusée'));
});

// ---------------------------------------------------------------- 5. /api/frames inchangé

test('POST /api/frames inchangé : 405, 400 et 500 toujours SANS corps (contrat boîtiers, D-008)', async () => {
  const get = await send({ path: '/api/frames' });
  assert.equal(get.status, 405);
  assert.equal(get.body, '');
  assert.equal(get.headers.allow, 'POST');
  assert.equal(get.headers['content-security-policy'], undefined, 'pas d\'en-têtes de l\'interface web');

  const bad = await send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(10) });
  assert.equal(bad.status, 400);
  assert.equal(bad.body, '');
  assert.equal(bad.headers.connection, 'close');

  // 500 : exception dans l'enregistrement du scan (trigger en panne) → réponse vide, connexion fermée.
  db.exec("CREATE TEMP TRIGGER scans_casse BEFORE INSERT ON scans BEGIN SELECT RAISE(ABORT, 'panne scans (test)'); END");
  try {
    const frame = encodeFrame({ readerId: 1, counter: 1, uid: Buffer.from('0A0B0C0D', 'hex'), key: READER_KEY });
    const res = await send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body: frame });
    assert.equal(res.status, 500);
    assert.equal(res.body, '');
    assert.equal(res.headers.connection, 'close');
    assert.equal(res.headers['content-type'], undefined);
  } finally {
    db.exec('DROP TRIGGER temp.scans_casse');
  }
  // Une trame valide reste acceptée (204, sans corps).
  const ok = await send({
    method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
    body: encodeFrame({ readerId: 1, counter: 2, uid: Buffer.from('0A0B0C0D', 'hex'), key: READER_KEY }),
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.body, '');
});
