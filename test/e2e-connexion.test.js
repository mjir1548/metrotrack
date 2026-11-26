// Étape 3 de bout en bout avec les VRAIS processus : « node server/main.js serve » démarré
// sur une configuration temporaire (METROTRACK_CONFIG), compte créé par « user-add » via un
// tube (stdin), puis navigation HTTPS avec la CA de test : GET /login → POST /login → GET /
// → POST /logout → ancien cookie refusé. Vérifie aussi : aucun compte par défaut au démarrage,
// aucun secret dans les sorties des processus, mot de passe à caractères spéciaux (encodage
// de formulaire), et que POST /api/frames (simulateur) n'est pas affecté.
// Certificats de test générés à l'exécution (test/tls-fixture.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { makeTestCerts } from './tls-fixture.js';

const ROOT = join(import.meta.dirname, '..');
const PASSWORD = 'Mot-de-passe-bout-en-bout-1';
// Espaces en tête et en fin, +, &, =, %, guillemets, chevrons, accents, émoji : tout ce que
// l'encodage application/x-www-form-urlencoded doit transporter sans altération.
const SPECIAL_PASSWORD = ' p@ss w+rd&=%25é€😀 "<>\'; ';
let dir, configPath, port, origin, certs, serverProcess;
let serverOutput = '';

async function freePort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port: p } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return p;
}

const env = () => ({ ...process.env, METROTRACK_CONFIG: configPath });
const runMain = (args, input) => spawnSync(process.execPath, [join(ROOT, 'server', 'main.js'), ...args], {
  env: env(), input, encoding: 'utf8', timeout: 15_000,
});
const readDb = (sql, ...params) => {
  const db = new DatabaseSync(join(dir, 'data', 'mt.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
};

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
const cookieLine = (res, name) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${name}=`));
const cookieValue = (res, name) => cookieLine(res, name)?.slice(name.length + 1).split(';')[0];
const hiddenCsrf = (html) => /<input type="hidden" name="csrf" value="([^"]*)">/.exec(html)?.[1];
const FORM_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };

async function login(username, password) {
  const page = await send({ path: '/login' });
  const csrf = cookieValue(page, '__Host-mt_login_csrf');
  assert.equal(hiddenCsrf(page.body), csrf);
  return send({
    method: 'POST', path: '/login',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_login_csrf=${csrf}` },
    body: new URLSearchParams({ csrf, username, password }).toString(),
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-e2e-'));
  mkdirSync(join(dir, 'tls'));
  certs = makeTestCerts(join(dir, 'tls'));
  port = await freePort();
  origin = `https://127.0.0.1:${port}`;
  configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1', port, dbPath: 'data/mt.db', tls: { certPath: 'tls/server.crt', keyPath: 'tls/server.key' },
  }));
  serverProcess = spawn(process.execPath, [join(ROOT, 'server', 'main.js'), 'serve'], { env: env() });
  serverProcess.stdout.on('data', (d) => { serverOutput += d; });
  serverProcess.stderr.on('data', (d) => { serverOutput += d; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serve n'a pas démarré : ${serverOutput}`)), 10_000);
    serverProcess.stdout.on('data', () => { if (serverOutput.includes('écoute sur')) { clearTimeout(timer); resolve(); } });
    serverProcess.once('exit', (code) => reject(new Error(`serve arrêté (${code}) : ${serverOutput}`)));
  });
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null && serverProcess.signalCode === null) {
    const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
    serverProcess.kill();
    await exited;
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('démarrage sur une base neuve : aucun compte par défaut ; la connexion est refusée', async () => {
  assert.equal(readDb('SELECT username FROM users').length, 0);
  const res = await login('admin', 'admin');
  assert.equal(res.status, 401);
  assert.equal(cookieLine(res, '__Host-mt_session'), undefined);
});

test('user-add par tube pendant que le serveur tourne, puis parcours complet connexion → accueil → déconnexion', async () => {
  const created = runMain(['user-add', 'testeur'], `${PASSWORD}\n`);
  assert.equal(created.status, 0, created.stderr);
  assert.ok(!created.stdout.includes(PASSWORD) && !created.stderr.includes(PASSWORD));
  const [row] = readDb("SELECT password_hash FROM users WHERE username = 'testeur'");
  assert.ok(row.password_hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'));

  const ok = await login('testeur', PASSWORD);
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, '/');
  const attrs = cookieLine(ok, '__Host-mt_session').split(';').map((a) => a.trim());
  for (const a of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(attrs.includes(a), a);
  const token = cookieValue(ok, '__Host-mt_session');

  const homePage = await send({ path: '/', headers: { Cookie: `__Host-mt_session=${token}` } });
  assert.equal(homePage.status, 200);
  assert.match(homePage.body, /<span class="visuellement-cache">Connecté en tant que <\/span><strong>testeur<\/strong>/);

  const out = await send({
    method: 'POST', path: '/logout',
    headers: { ...FORM_TYPE, Origin: origin, Cookie: `__Host-mt_session=${token}` },
    body: new URLSearchParams({ csrf: hiddenCsrf(homePage.body) }).toString(),
  });
  assert.equal(out.status, 303);
  assert.equal(out.headers.location, '/login');
  const afterLogout = await send({ path: '/', headers: { Cookie: `__Host-mt_session=${token}` } });
  assert.equal(afterLogout.status, 303);
  assert.equal(afterLogout.headers.location, '/login');
  assert.equal(readDb('SELECT COUNT(*) AS n FROM sessions')[0].n, 0);

  // Aucun secret dans la sortie du serveur.
  assert.ok(!serverOutput.includes(PASSWORD));
  assert.ok(!serverOutput.includes(token));
  assert.ok(!serverOutput.includes('$argon2id$'));
});

test('mot de passe à caractères spéciaux : créé par user-add, accepté tel quel via le formulaire', async () => {
  const created = runMain(['user-add', 'special'], `${SPECIAL_PASSWORD}\n`);
  assert.equal(created.status, 0, created.stderr);
  assert.equal((await login('special', SPECIAL_PASSWORD)).status, 303);
  // Ni espace rogné, ni normalisation silencieuse.
  assert.equal((await login('special', SPECIAL_PASSWORD.trim())).status, 401);
});

test('POST /api/frames inchangé : simulateur → 204 sans session ni CSRF, rejeu → 400', () => {
  const seeded = runMain(['dev-seed']);
  assert.equal(seeded.status, 0, seeded.stderr);
  const simulate = (counter) => spawnSync(process.execPath, [join(ROOT, 'tools', 'simulateur.js'),
    '--url', `${origin}/api/frames`, '--ca', certs.caPath, '--reader', '1',
    '--key-file', join(dir, 'dev', 'reader-1.key'), '--uid', '04A1B2C3D4E5F6', '--counter', String(counter)],
  { encoding: 'utf8', timeout: 10_000 });
  const first = simulate(1);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /HTTP 204/);
  const replay = simulate(1);
  assert.notEqual(replay.status, 0);
  assert.match(replay.stdout + replay.stderr, /HTTP 400/);
});
