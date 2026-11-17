// Scénario d'attaque de la revue de l'étape 3 (B1), contre un vrai serveur HTTPS en processus :
// rafale de POST /login coupés aussitôt, requêtes enchaînées sur une seule connexion
// (pipelining), avec ou sans coupure. Vérifie que le nombre de calculs argon2 reste borné
// (argon2Stats), que la mémoire du processus reste bornée, que les refus sont des 503 propres
// journalisés avec l'adresse, et qu'une connexion légitime réussit juste après.
// Fichier séparé : compteur argon2 propre à ce processus de test.
// Inclut aussi la normalisation NFC vue à travers le formulaire HTTP (S2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { hashPassword, argon2Stats, MAX_PENDING_ARGON2 } from '../server/password.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-17T10:00:00.000Z';
const PASSWORD = 'Un-mot-de-passe-solide-42';
let dir, db, server, port, certs, origin;
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-attaque-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const insertUser = db.prepare('INSERT INTO users (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)');
  insertUser.run('alice', await hashPassword(PASSWORD), NOW);
  insertUser.run('compose', await hashPassword('Café-mot-de-passe-1'), NOW); // « é » précomposé
  insertUser.run('decompose', await hashPassword('Café-mot-de-passe-2'), NOW); // « e » + accent combinant
  // Délai réel d'1 s : c'est la configuration de production, et il allonge la durée de vie
  // des requêtes en attente (pire cas pour la mémoire).
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

// ---------------------------------------------------------------- outils

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
const FORM_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (fields) => new URLSearchParams(fields).toString();
const cookieValue = (res, name) =>
  (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1).split(';')[0];
const loginCsrf = async () => cookieValue(await send({ path: '/login' }), '__Host-mt_login_csrf');
async function login(username, password) {
  const csrf = await loginCsrf();
  return send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: form({ csrf, username, password }),
  });
}

/** Requête POST /login brute (mauvais mot de passe, CSRF valide), pour TLS direct. */
function rawLogin(csrf) {
  const body = form({ csrf, username: 'alice', password: 'mauvais-mot-de-passe' });
  return `POST /login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nCookie: __Host-mt_login_csrf=${csrf}\r\n`
    + `Content-Type: application/x-www-form-urlencoded\r\nContent-Length: ${body.length}\r\n\r\n${body}`;
}

/** Ouvre une connexion TLS, écrit `payload`, puis coupe aussitôt (cut) ou lit jusqu'à la fermeture. */
function tlsSend(payload, { cut }) {
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca }, () => {
      socket.write(payload, () => { if (cut) setImmediate(() => socket.destroy()); });
    });
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('error', () => {});
    socket.on('close', () => resolve(data));
  });
}

async function waitArgon2Idle() {
  const deadline = Date.now() + 15_000;
  while (argon2Stats().pending > 0) {
    assert.ok(Date.now() < deadline, 'file argon2 jamais vidée');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const statusesOf = (rawResponse) => [...rawResponse.matchAll(/^HTTP\/1\.1 (\d{3})/gm)].map((m) => m[1]);
const rssMiB = () => process.memoryUsage().rss / 2 ** 20;

// ---------------------------------------------------------------- pipelining

// Étape 4 : le 503 porte la page de connexion (environ 1,3 Kio). Le serveur n'envoie qu'UN
// 503 par connexion (web.js, closingConnections) ; les requêtes enchaînées après lui ne
// reçoivent aucune réponse, et la connexion est fermée après le 503. Sans cela, chaque requête
// ajoutait une page 503 au tampon d'écriture, derrière les 401 retardés d'1 s ; Node
// suspendait alors l'analyse et coupait la connexion par son propre « 400 Bad Request »
// (HPE_PAUSED), écrit avant les 401.
// Séquence attendue : 16 × 401 dans l'ordre, puis 503, puis fermeture. Tolérance gardée pour
// une coupure par Node : au moins un 401 d'abord, et rien après le 400.
test(`100 POST /login enchaînés sur une connexion : ${MAX_PENDING_ARGON2} × 401 dans l'ordre, puis un 503 et fermeture`, async () => {
  await waitArgon2Idle();
  const startedBefore = argon2Stats().started;
  const logsBefore = logs.length;
  const response = await tlsSend(rawLogin(await loginCsrf()).repeat(100), { cut: false });
  const statuses = statusesOf(response);
  const exact = [...Array(MAX_PENDING_ARGON2).fill('401'), '503'];
  const node400 = response.indexOf('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n');
  const cutByNode = statuses.at(-1) === '400' && statuses.length >= 2
    && statuses.slice(0, -1).every((s) => s === '401')
    && node400 >= 0 && !/^HTTP\/1\.1 /m.test(response.slice(node400 + 1)); // aucune réponse après le 400
  assert.ok(JSON.stringify(statuses) === JSON.stringify(exact) || cutByNode, `statuts : ${statuses.join(',')}`);
  assert.ok(statuses.filter((s) => s === '401').length <= MAX_PENDING_ARGON2);
  assert.ok(argon2Stats().started - startedBefore <= MAX_PENDING_ARGON2);
  const newLogs = logs.slice(logsBefore);
  assert.ok(newLogs.some((l) => /^connexion refusée : file argon2 pleine, depuis [0-9a-f.:]+$/.test(l)));
  // Chaque refus est journalisé avec l'adresse. Si Node coupe la connexion, les requêtes dont
  // le corps était en cours de lecture ajoutent « requête interrompue : aborted » (readForm).
  for (const l of newLogs) {
    if (l === 'requête interrompue : aborted') continue;
    assert.match(l, /^connexion refusée.* depuis [0-9a-f.:]+$/, l);
  }
  assert.ok(!newLogs.some((l) => l.startsWith('erreur interne')));
  // Connexion coupée par Node : la file argon2 finit de se vider (calculs sautés, client parti).
  await waitArgon2Idle();
  assert.equal((await login('alice', PASSWORD)).status, 303);
});

// ---------------------------------------------------------------- scénario complet de la revue

test('rafale de 200 POST coupés + 100 enchaînés coupés : argon2 et mémoire bornés, connexion légitime aussitôt', async () => {
  await waitArgon2Idle();
  global.gc?.();
  const rssBefore = rssMiB();
  let rssPeak = rssBefore;
  const sampler = setInterval(() => { rssPeak = Math.max(rssPeak, rssMiB()); }, 10);
  const startedBefore = argon2Stats().started;
  const logsBefore = logs.length;
  let maxPending = 0;
  const pendingSampler = setInterval(() => { maxPending = Math.max(maxPending, argon2Stats().pending); }, 5);
  try {
    const csrf = await loginCsrf();
    const one = rawLogin(csrf);
    await Promise.all([
      ...Array.from({ length: 200 }, () => tlsSend(one, { cut: true })),
      tlsSend(one.repeat(100), { cut: true }),
    ]);
    // Connexion légitime dans les secondes qui suivent (file bornée : < 1 s d'attente au pire).
    const t0 = performance.now();
    let legit;
    for (let i = 0; i < 20; i++) {
      legit = await login('alice', PASSWORD);
      if (legit.status === 303) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(legit.status, 303);
    assert.ok(performance.now() - t0 < 3000, `connexion légitime après ${performance.now() - t0} ms`);
    await waitArgon2Idle();
  } finally {
    clearInterval(sampler);
    clearInterval(pendingSampler);
  }
  // Invariant de B1 : jamais plus de 16 calculs en attente ou en cours.
  assert.ok(maxPending <= MAX_PENDING_ARGON2, `file à ${maxPending}`);
  // Le TOTAL n'est pas borné à 16 par conception : la file se vide pendant la rafale, et une
  // requête dont la coupure n'est pas encore parvenue au serveur est calculée. Mesuré : 5 à 21
  // calculs pour 300 tentatives. On vérifie que la grande majorité n'a coûté aucun calcul.
  const computed = argon2Stats().started - startedBefore;
  assert.ok(computed <= 3 * MAX_PENDING_ARGON2, `${computed} calculs argon2 lancés pour 300 tentatives`);
  // Mémoire : un calcul argon2 à la fois (~19 Mio). Mesuré : RSS 50 → pic 92 à 102 Mio.
  // Marge large pour le bruit du ramasse-miettes.
  assert.ok(rssPeak - rssBefore < 150, `RSS ${rssBefore.toFixed(0)} → pic ${rssPeak.toFixed(0)} Mio`);
  // Chaque tentative journalisée l'est avec son adresse (jamais « depuis - »).
  for (const l of logs.slice(logsBefore)) assert.doesNotMatch(l, /depuis -$/, l);
  assert.ok(server.listening);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')));
});

// ---------------------------------------------------------------- NFC à travers le formulaire

test('NFC : compte précomposé accepte la saisie décomposée, et inversement (formulaire HTTP)', async () => {
  await waitArgon2Idle();
  for (const [username, nfc, nfd] of [
    ['compose', 'Café-mot-de-passe-1', 'Café-mot-de-passe-1'],
    ['decompose', 'Café-mot-de-passe-2', 'Café-mot-de-passe-2'],
  ]) {
    assert.equal((await login(username, nfc)).status, 303, `${username} saisi précomposé`);
    assert.equal((await login(username, nfd)).status, 303, `${username} saisi décomposé`);
  }
});
