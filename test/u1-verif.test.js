// Vérification indépendante de l'étape U1 (design system B, logo, vocabulaire) et du lanceur.
// - feuille de style : le contrôle de contraste ne peut pas être contourné (un troisième bloc
//   :root ignoré, une variable du thème sombre écrite autrement qu'en #RRGGBB et qui retomberait
//   silencieusement sur la valeur claire) ;
// - toutes les pages réellement rendues, avec des données (scans, puce inconnue, lecteur
//   remplacé, fiche corrigée) : aucune ressource externe, un seul h1, « Aller au contenu »,
//   rubrique signalée, champs étiquetés, identifiants uniques, vocabulaire du client ;
// - route statique : variantes de traversée (antislash, encodages, casse) et méthodes ;
// - lanceur en ligne de commande sur une configuration temporaire, sans ouvrir Edge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { spawn, spawnSync } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { encodeFrame } from '../server/protocol.js';
import { makeTestCerts } from './tls-fixture.js';
import { withoutAppScript } from './app-script.js';

const ROOT = join(import.meta.dirname, '..');
const CSS = readFileSync(join(ROOT, 'web', 'static', 'style.css'), 'utf8');
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------- feuille de style

// Variables utilisées par les couples de contraste de test/design-system.test.js.
const CONTRAST_VARS = ['fond', 'carte', 'zone', 'texte', 'texte-doux', 'bordure-champ', 'accent', 'accent-fort', 'accent-doux',
  'sur-accent', 'attention-texte', 'attention-doux', 'danger', 'danger-fort', 'danger-doux', 'sur-danger', 'focus'];

test('style.css : exactement deux blocs :root (clair, puis sombre sous prefers-color-scheme) — un bloc de plus échapperait au contrôle de contraste', () => {
  const css = withoutComments(CSS);
  const roots = css.match(/:root\s*\{/g) ?? [];
  assert.equal(roots.length, 2);
  assert.match(css, /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{/);
  // Aucune variable de couleur redéfinie ailleurs que dans :root (ex. « .carte { --texte: … } »).
  const outside = css.replace(/:root\s*\{[^}]*\}/g, '');
  const redefined = [...outside.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]).filter((n) => CONTRAST_VARS.includes(n));
  assert.deepEqual(redefined, []);
});

test('style.css : chaque couleur des couples de contraste est en #RRGGBB dans les DEUX thèmes (pas de repli silencieux sur le thème clair)', () => {
  const [light, dark] = withoutComments(CSS).match(/:root\s*\{[^}]*\}/g);
  for (const [theme, block] of [['clair', light], ['sombre', dark]]) {
    for (const name of CONTRAST_VARS) {
      const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(block);
      assert.ok(m, `thème ${theme} : --${name} absent`);
      assert.match(m[1].trim(), /^#[0-9A-Fa-f]{6}$/, `thème ${theme} : --${name} = ${m[1]}`);
    }
  }
});

// ---------------------------------------------------------------- serveur réel, pages rendues

const UID_KNOWN = '04A1B2C3D4E5F6';
const UID_UNKNOWN = '04FFEEDDCCBBAA';
let dir, db, server, port, certs, token, csrf, key1;
const pages = new Map(); // nom → { status, body }

function send({ method = 'GET', path, session = token, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (session) h.Cookie = `__Host-mt_session=${session}`;
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
const post = (path, fields) => send({
  method: 'POST', path, body: new URLSearchParams({ csrf, ...fields }).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `https://127.0.0.1:${port}` },
});
const scan = (readerId, key, uid, counter) => send({
  method: 'POST', path: '/api/frames', session: null,
  body: encodeFrame({ readerId, counter, uid: Buffer.from(uid, 'hex'), key }),
  headers: { 'Content-Type': 'application/octet-stream' },
});
const readerKey = (body) => Buffer.from(/<pre class="cle">([0-9a-f]{64})<\/pre>/.exec(body)[1], 'hex');

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u1-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('claire.martin', DUMMY_HASH, '2026-11-26T08:00:00.000Z').lastInsertRowid);
  token = createSession(db, userId);
  csrf = csrfTokenFor(token);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  // Données réalistes, créées par l'interface et par de vrais scans chiffrés.
  assert.equal((await post('/stations/new', { name: 'Atelier', description: 'Établi principal' })).status, 303);
  assert.equal((await post('/stations/new', { name: 'Banc de mesure', description: '' })).status, 303);
  const created = await post('/readers/new', { station: '1' });
  pages.set('POST /readers/new (clé)', created);
  key1 = readerKey(created.body);
  assert.equal((await post('/items/new', { name: 'Multimètre', notes: 'Sacoche grise', prop_key: 'Marque', prop_value: 'Fluke' })).status, 303);
  assert.equal((await post('/items/new', { name: 'Pied à coulisse', notes: '' })).status, 303);
  db.prepare('UPDATE items SET uid_nfc = ? WHERE id = 1').run(UID_KNOWN);
  assert.equal((await scan(1, key1, UID_KNOWN, 1)).status, 204);
  assert.equal((await scan(1, key1, UID_UNKNOWN, 2)).status, 204);
  assert.equal((await post('/items/2/location', { station: '2' })).status, 303);
  // Lecteur 2 non affecté, puis remplacé (lecteur 3) : page de la nouvelle clé, lecteur désactivé.
  await post('/readers/new', { station: '' });
  pages.set('POST /readers/2/replace (clé)', await post('/readers/2/replace', {}));
  // Lecteur 4 nommé et non affecté (D-019).
  pages.set('POST /readers/new (clé, nommé)', await post('/readers/new', { name: 'Boîtier mobile', station: '' }));
  pages.set('POST /items/new (erreurs)', await post('/items/new', { name: '' }));

  const connected = ['/', '/?q=Multi', '/?q=introuvable', '/items/new', '/items/1', '/items/1/edit', '/items/1/delete', '/items/1/location',
    '/items/2', '/items/999', '/items/abc', '/stations', '/stations/new', '/stations/1', '/stations/1/edit', '/stations/1/delete', '/stations/2',
    '/readers', '/readers/new', '/readers/1', '/readers/1/station', '/readers/1/replace', '/readers/1/deactivate', '/readers/1/rename', '/readers/2', '/readers/3', '/readers/4', '/readers/4/rename',
    '/chips', `/chips/${UID_UNKNOWN}/new`, `/chips/${UID_UNKNOWN}/associate`, `/chips/${UID_UNKNOWN}/associate?q=pied`,
    `/chips/${UID_UNKNOWN}/associate/2`, '/inconnu', '/logout', '/static/inconnu.css'];
  for (const path of connected) pages.set(path, await send({ path }));
  for (const path of ['/login', '/login?info=session', '/inconnu']) pages.set(`${path} (anonyme)`, await send({ path, session: null }));
  pages.set('PUT / (405)', await send({ method: 'PUT', path: '/' }));
  pages.set('POST sans Origin (403)', await send({ method: 'POST', path: '/items/new', body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }));
  pages.set('POST text/plain (400)', await send({ method: 'POST', path: '/items/new', body: 'a', headers: { 'Content-Type': 'text/plain', Origin: `https://127.0.0.1:${port}` } }));
  pages.set('POST trop long (413)', await send({ method: 'POST', path: '/items/new', body: `name=${'a'.repeat(300_000)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: `https://127.0.0.1:${port}` } }));
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('parcours de préparation : toutes les pages répondent avec le code attendu', () => {
  const expected = { '/items/999': 404, '/items/abc': 404, '/inconnu': 404, '/logout': 405, '/static/inconnu.css': 404, '/inconnu (anonyme)': 404,
    'PUT / (405)': 405, 'POST sans Origin (403)': 403, 'POST text/plain (400)': 400, 'POST trop long (413)': 413, 'POST /items/new (erreurs)': 400 };
  for (const [name, { status }] of pages) assert.equal(status, expected[name] ?? 200, name);
});

// Texte visible : sans balises, sans feuille de style ni sprite, avec les attributs lus à l'écran
// ou par un lecteur d'écran (title, placeholder, aria-label, alt).
function visibleText(body) {
  const attrs = [...body.matchAll(/\s(?:title|placeholder|aria-label|alt)="([^"]*)"/g)].map((m) => m[1]).join(' ');
  return body.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') + ' ' + attrs;
}

test('aucune ressource externe : href, src, action ne visent que ce serveur (chemin absolu) ou une ancre ; ni script, ni style, ni gestionnaire inline', () => {
  for (const [name, { body }] of pages) {
    for (const [, attr, value] of body.matchAll(/\s(href|src|srcset|action|formaction|poster|data|xlink:href)="([^"]*)"/g)) {
      assert.ok(value.startsWith('#') || (value.startsWith('/') && !value.startsWith('//')), `${name} : ${attr}="${value}"`);
    }
    assert.doesNotMatch(withoutAppScript(body), /<script|<iframe|<object|<embed|\son[a-z]+\s*=|\sstyle\s*=|@import/i, name);
    // Seule adresse tolérée : aucune (le logo est intégré sans xmlns, comme le sprite).
    assert.doesNotMatch(body, /https?:\/\//i, name);
    assert.doesNotMatch(body.replace(/url\(#[a-z-]+\)/g, ''), /url\(/i, name);
  }
});

test('accessibilité de chaque page : lang, titre, « Aller au contenu », un seul h1, identifiants uniques, champs étiquetés', () => {
  for (const [name, { body }] of pages) {
    assert.match(body, /<html lang="fr">/, name);
    assert.match(body, /<title>[^<]+ · MetroTrack<\/title>|<title>MetroTrack<\/title>|<title>[^<]+<\/title>/, name);
    assert.ok(body.includes('<a class="lien-evitement" href="#contenu">Aller au contenu</a>'), name);
    assert.match(body, /<main id="contenu"/, name);
    assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1, `${name} : nombre de h1`);
    const ids = [...body.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${name} : identifiants en double`);
    for (const [field, tag, attrs] of body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      if (/\stype="(hidden|submit|button)"/.test(attrs)) continue;
      const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
      const labelled = /\saria-label(?:ledby)?="[^"]+"/.test(attrs) || (id !== undefined && body.includes(`<label for="${id}"`)) ||
        (id !== undefined && new RegExp(`<label[^>]*\\sfor="${id}"`).test(body));
      assert.ok(labelled, `${name} : champ sans étiquette ${field.slice(0, 80)} (${tag})`);
    }
  }
});

test('rubrique courante : exactement un aria-current sur les pages connectées avec bandeau, et sur la bonne rubrique', () => {
  const section = (path) => (path.startsWith('/stations') ? '/stations' : path.startsWith('/readers') ? '/readers' : path.startsWith('/chips') ? '/chips' : '/');
  for (const [name, { body }] of pages) {
    if (!body.includes('<nav class="nav"') && !/class="nav"/.test(body)) continue;
    const marks = [...body.matchAll(/<a href="([^"]*)" aria-current="(page|true)">/g)];
    assert.equal(marks.length, 1, name);
    const path = (name.startsWith('POST /') ? name.split(' ')[1] : name).split('?')[0];
    assert.equal(marks[0][1], section(path), name);
    assert.equal(marks[0][2], ['/', '/stations', '/readers', '/chips'].includes(path) ? 'page' : 'true', name);
  }
});

// Termes que l'audit (docs/ux/audit-existant.md) et le plan U1 bannissent de l'écran.
const FORBIDDEN = [/trame/i, /compteur/i, /\bAES\b/, /hexad[ée]cimal/i, /inject/i, /locali[sz]ation/i, /ligne de commande/i];

test('vocabulaire du client : aucun terme technique banni dans le texte rendu (trame, compteur, AES, hexadécimal, injecter, localisation…)', () => {
  const found = [];
  for (const [name, { body }] of pages) {
    const text = visibleText(body);
    for (const term of FORBIDDEN) {
      const m = new RegExp(`.{0,40}${term.source}.{0,40}`, term.flags).exec(text);
      if (m) found.push(`${name} : « ${m[0].trim()} »`);
    }
  }
  assert.deepEqual(found, []);
});

// Plan U1 : « plus de “lecteur n°” », résolu par D-019 (nom libre des lecteurs). Un lecteur est
// désigné par son nom, sinon par son poste ; « Lecteur n° X » ne reste permis que pour un
// lecteur ni nommé ni affecté (ici les lecteurs 2 et 3). Le numéro, lui, reste affiché comme
// « Numéro à configurer dans le boîtier ».
test('vocabulaire du client : plus de « lecteur n° » pour un lecteur nommé ou affecté (plan U1, D-019)', () => {
  const readers = db.prepare('SELECT id, name, station_id FROM readers').all();
  const allowed = new Set(readers.filter((r) => r.name === '' && r.station_id === null).map((r) => r.id));
  // Le jeu de données couvre les trois cas : affecté sans nom, nommé, ni l'un ni l'autre.
  assert.ok(readers.some((r) => r.name === '' && r.station_id !== null));
  assert.ok(readers.some((r) => r.name !== ''));
  assert.ok(allowed.size > 0);
  const found = [];
  for (const [name, { body }] of pages) {
    const text = visibleText(body);
    for (const m of text.matchAll(/lecteur n°\s*(\d+)/gi)) {
      if (!allowed.has(Number(m[1]))) found.push(`${name} : « ${text.slice(Math.max(0, m.index - 30), m.index + 40).trim()} »`);
    }
  }
  assert.deepEqual(found, []);
  // Lecteur nommé : son nom est affiché, sur sa fiche comme dans la liste.
  assert.ok(pages.get('/readers/4').body.includes('<h1>Boîtier mobile</h1>'));
  assert.ok(pages.get('/readers').body.includes('<a class="lien-objet" href="/readers/4">Boîtier mobile</a>'));
});

// ---------------------------------------------------------------- route statique

test('route statique : variantes de traversée et de casse refusées en 404 par une page lisible, connecté ou non', async () => {
  const paths = ['/static', '/static/', '/STATIC/style.css', '/static/STYLE.CSS', '/static/Style.css', '/static/style.css/', '/static//style.css',
    '/static/./style.css', '/static/../server/web.js', '/static/%2e%2e/server/web.js', '/static/%2E%2E/server/web.js', '/static/..%2fserver/web.js',
    '/static/..%2Fserver%2Fweb.js', '/static/..%5cserver%5cweb.js', '/static/..\\server\\web.js', '/static\\style.css', '/static/%73tyle.css',
    '/static/style.css;x', '/static/style.css%20', '/static/logo.svg.bak', '/web/static/style.css', '/config.json', '/package.json', '/../config.json',
    '/static/fonts/OFL-Inter.txt', '/static/fonts/../../server/web.js'];
  for (const session of [token, null]) {
    for (const path of paths) {
      const res = await send({ path, session });
      assert.equal(res.status, 404, path);
      assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', path);
      assert.match(res.body, /<h1>Page introuvable<\/h1>/, path);
      assert.doesNotMatch(res.body, /import |export |readFileSync/, path);
    }
  }
});

test('route statique : chaîne de requête tolérée (même fichier) ; toute méthode autre que GET → 405 avec Allow: GET et page lisible', async () => {
  const plain = await send({ path: '/static/logo.svg', session: null });
  const withQuery = await send({ path: '/static/logo.svg?v=2', session: null });
  assert.equal(withQuery.status, 200);
  assert.equal(withQuery.body, plain.body);
  // HEAD est refusé comme sur toutes les adresses de l'interface (choix existant, voir web-limites).
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    for (const path of ['/static/style.css', '/static/logo.svg', '/static/fonts/Inter-Variable.ttf']) {
      const res = await send({ method, path, session: null, body: method === 'HEAD' ? undefined : '' });
      assert.equal(res.status, 405, `${method} ${path}`);
      assert.equal(res.headers.allow, 'GET', `${method} ${path}`);
      if (method !== 'HEAD') assert.match(res.body, /<h1>[^<]+<\/h1>/, `${method} ${path}`);
    }
  }
});

test('/api/frames inchangé : scan d\'une puce connue → 204, rejeu → 400, sans en-têtes de l\'interface ; GET → 405', async () => {
  const res = await send({ path: '/api/frames', session: null });
  assert.equal(res.status, 405);
  const empty = await send({ method: 'POST', path: '/api/frames', session: null, body: 'abc', headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body, '');
  assert.equal(empty.headers['content-security-policy'], undefined);
  const ok = await scan(1, key1, UID_KNOWN, 10);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['content-security-policy'], undefined);
  assert.equal((await scan(1, key1, UID_KNOWN, 10)).status, 400); // rejeu
});

// ---------------------------------------------------------------- lanceur en ligne de commande

const hasSh = spawnSync('sh', ['-c', 'command -v openssl'], { stdio: 'ignore' }).status === 0;
const isWindows = process.platform === 'win32';
const freePort = () => new Promise((resolve) => {
  const s = createTcpServer().listen(0, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => resolve(p));
  });
});
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('lanceur (CLI) : démarre, détecte « déjà lancé », --arreter n\'arrête que SON serveur ; sans Edge, aucune fenêtre ouverte', { skip: (!hasSh && 'openssl absent') || (!isWindows && 'Windows uniquement'), timeout: 60_000 }, async () => {
  const ldir = mkdtempSync(join(tmpdir(), 'metrotrack-u1-lanceur-'));
  let pid = null;
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => decoy.once('spawn', r));
  try {
    const lcerts = makeTestCerts(ldir);
    mkdirSync(join(ldir, 'tls'));
    writeFileSync(join(ldir, 'tls', 'server.crt'), lcerts.cert);
    writeFileSync(join(ldir, 'tls', 'server.key'), lcerts.key);
    const configPath = join(ldir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port: await freePort(), dbPath: 'data/l.db', tls: { certPath: 'tls/server.crt', keyPath: 'tls/server.key' } }));
    // Edge rendu introuvable : le lanceur doit s'arrêter à un message, sans rien ouvrir.
    const env = { ...process.env, ProgramFiles: join(ldir, 'aucun'), 'ProgramFiles(x86)': join(ldir, 'aucun') };
    // Sorties vers des fichiers plutôt que des tubes : le serveur détaché survit au lanceur,
    // aucune attente ne dépend ainsi de la fermeture d'un tube qu'il pourrait garder.
    let n = 0;
    const run = (...args) => {
      const outPath = join(ldir, `sortie-${++n}.txt`);
      const fd = openSync(outPath, 'w');
      let result;
      try {
        result = spawnSync(process.execPath, [join(ROOT, 'tools', 'lanceur.mjs'), '--config', configPath, ...args], { env, stdio: ['ignore', fd, fd], timeout: 30_000 });
      } finally {
        closeSync(fd);
      }
      const output = readFileSync(outPath, 'utf8');
      return { status: result.status, stdout: output, stderr: output };
    };

    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /serveur démarré \(PID (\d+)\)/);
    pid = Number(/PID (\d+)/.exec(first.stdout)[1]);
    assert.match(first.stdout, /Microsoft Edge est introuvable/);
    assert.equal(readFileSync(join(ldir, 'lanceur.pid'), 'utf8').trim(), String(pid));

    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /déjà en cours d'exécution/);

    // lanceur.pid falsifié vers un autre processus node : refus, le processus survit, le fichier reste.
    writeFileSync(join(ldir, 'lanceur.pid'), `${decoy.pid}\n`);
    const refused = run('--arreter');
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /n'est pas le serveur MetroTrack/);
    assert.ok(alive(decoy.pid));
    assert.ok(alive(pid));

    writeFileSync(join(ldir, 'lanceur.pid'), `${pid}\n`);
    const stopped = run('--arreter');
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    assert.match(stopped.stdout, new RegExp(`serveur MetroTrack arrêté \\(PID ${pid}\\)`));
    assert.equal(existsSync(join(ldir, 'lanceur.pid')), false);
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(alive(pid), false);
    pid = null;

    // Plus rien à arrêter ; option inconnue refusée (code 2).
    assert.match(run('--arreter').stdout, /pas de lanceur\.pid/);
    const bad = run('--ignore-certificate-errors');
    assert.equal(bad.status, 2);
  } finally {
    if (pid !== null && alive(pid)) process.kill(pid);
    if (alive(decoy.pid)) decoy.kill();
    rmSync(ldir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
