// Postes et lecteurs (étape 6) contre un vrai serveur HTTPS en processus :
// - session et CSRF sur chaque nouvel envoi, identifiants invalides (404), méthodes (405) ;
// - postes : création, validation (bornes, nom invisible, doublons casse et NFC/NFD),
//   modification, suppression refusée pour chaque cause d'historique, réussie sans historique ;
// - lecteurs : création dans l'interface, clé affichée une fois, acceptée par
//   tools/simulateur.js (204) puis rejeu refusé (400) ; changement de poste sans réécriture de
//   l'historique ; désactivation (400 ensuite) ; remplacement de clé (ancien 400, nouveau 204) ;
//   plage d'identifiants épuisée ; atomicité écriture + audit ;
// - la clé n'apparaît nulle part ailleurs : base (hors readers), journaux du serveur, URL,
//   toutes les autres pages servies ;
// - aucune ressource externe, aucun style en ligne, un bouton principal au plus par page.
// Les sessions sont créées directement en base (createSession). Les tests s'enchaînent sur une
// même base (ordre du fichier).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { execFile } from 'node:child_process';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { MAX_READER_ID } from '../server/readers.js';
import { makeTestCerts } from './tls-fixture.js';

const ROOT = join(import.meta.dirname, '..');
const NOW = '2026-11-18T10:00:00.000Z';
const SEED_KEY = Buffer.alloc(32, 0x5a);
const UID = '04A1B2C3D4E5F6';
let dir, db, server, port, certs, token, csrf, origin, aliceId;
const logs = [];
// Toutes les réponses reçues (pour la recherche de fuite de clé et les contrôles de page).
const served = [];
// Clés affichées par l'interface : {id, hex, page} (page : corps de la page de clé).
const shownKeys = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-postes-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(SEED_KEY, NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, NOW, NOW);
  aliceId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, NOW).lastInsertRowid);
  token = createSession(db, aliceId);
  csrf = csrfTokenFor(token);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => logs.push(l), loginFailureDelayMs: 0 });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    origin = `https://127.0.0.1:${port}`;
    resolve();
  }));
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
      res.on('end', () => {
        const response = { method, path, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') };
        served.push(response);
        resolve(response);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const cookie = (session = token) => (session ? { Cookie: `__Host-mt_session=${session}` } : {});
const page = (path, session = token) => send({ path, headers: cookie(session) });

/** POST d'un formulaire ; session, Origin et jeton CSRF valides par défaut, chacun retirable (null) ou remplaçable. */
function post(path, fields = {}, { session = token, originHeader = origin, csrfField = csrf } = {}) {
  const params = new URLSearchParams(Object.entries(fields));
  if (csrfField !== null) params.append('csrf', csrfField);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(session) };
  if (originHeader !== null) headers.Origin = originHeader;
  return send({ method: 'POST', path, headers, body: params.toString() });
}

/** Corps brut (déjà encodé) d'un formulaire, avec un jeton CSRF valide. */
const postRaw = (path, encoded) => send({
  method: 'POST', path, body: `csrf=${csrf}&${encoded}`,
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...cookie() },
});

/** Trame envoyée à POST /api/frames, comme un boîtier. */
const postFrame = (readerId, counter, key, uid = UID) => send({
  method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
  body: encodeFrame({ readerId, counter, uid: Buffer.from(uid, 'hex'), key }),
});

/** tools/simulateur.js en processus fils (asynchrone : le serveur est dans ce processus). */
function simulate(readerId, keyFile, counter) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(ROOT, 'tools', 'simulateur.js'),
      '--url', `${origin}/api/frames`, '--ca', certs.caPath, '--reader', String(readerId),
      '--key-file', keyFile, '--uid', UID, '--counter', String(counter)], { timeout: 10_000 },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
// État complet des tables modifiables par l'interface : sert à prouver qu'une requête n'a rien écrit.
const snapshot = () => JSON.stringify(['stations', 'readers', 'audit_log', 'scans', 'location_corrections', 'items']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const lastAudit = () => {
  const row = db.prepare('SELECT user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return { ...row, details: JSON.parse(row.details) };
};
const stationId = (name) => db.prepare('SELECT id FROM stations WHERE name = ?').get(name).id;

/** Clé affichée sur une page de clé : 64 caractères hexadécimaux en minuscules dans le bloc à chasse fixe. */
function keyFrom(res) {
  const match = /<pre class="cle">([0-9a-f]{64})<\/pre>/.exec(res.body);
  assert.ok(match, 'clé affichée');
  return match[1];
}

// Balises autorisées : celles des gabarits. Toute autre serait une injection.
const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'body', 'header', 'div', 'span', 'nav', 'a', 'strong', 'form',
  'input', 'button', 'main', 'h1', 'h2', 'p', 'label', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time', 'section', 'dl', 'dt', 'dd',
  'textarea', 'select', 'option', 'ul', 'li', 'pre', 'details', 'summary']);
const PAIRED_TAGS = ['div', 'span', 'a', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section', 'dl', 'dt', 'dd', 'time', 'form',
  'h1', 'h2', 'main', 'textarea', 'select', 'option', 'button', 'label', 'ul', 'li', 'pre', 'nav', 'details', 'summary'];

function assertSafePage(html, what) {
  for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `${what} : balise <${tag}>`);
  for (const tag of PAIRED_TAGS) {
    const open = html.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
    const close = html.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
    assert.equal(open, close, `${what} : <${tag}> ${open} ouvertes, ${close} fermées`);
  }
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, what);
  assert.equal((html.match(/"/g)?.length ?? 0) % 2, 0, `${what} : guillemets déséquilibrés`);
  for (const [, url] of html.matchAll(/\b(?:src|href|action)\s*=\s*"([^"]*)"/gi)) assert.match(url, /^\/(?!\/)/, `${what} : URL ${url}`);
  assert.doesNotMatch(html, /https?:|\/\//i, `${what} : URL externe`);
  assert.doesNotMatch(html, /<script|<style|\sstyle\s*=/i, `${what} : script ou style`);
  assert.ok((html.match(/class="bouton( bouton-danger)?"/g)?.length ?? 0) <= 1, `${what} : un bouton principal au plus`);
}

const GET_ROUTES = ['/stations', '/stations/new', '/stations/1', '/stations/1/edit', '/stations/1/delete',
  '/readers', '/readers/new', '/readers/1', '/readers/1/station', '/readers/1/deactivate', '/readers/1/replace'];
const POST_ROUTES = ['/stations/new', '/stations/1/edit', '/stations/1/delete',
  '/readers/new', '/readers/1/station', '/readers/1/deactivate', '/readers/1/replace'];
const VALID_POST = { name: 'Écrasé', description: 'x', station: '' };

// ---------------------------------------------------------------- session, CSRF, identifiants, méthodes

test('sans session (ou session inconnue) : chaque nouvelle page et chaque nouvel envoi → 303 vers /login, aucune écriture', async () => {
  const before = snapshot();
  for (const session of [null, 'A'.repeat(43)]) {
    for (const path of GET_ROUTES) {
      const res = await page(path, session);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/login', path);
    }
    for (const path of POST_ROUTES) {
      const res = await post(path, VALID_POST, { session });
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/login', path);
      assert.equal(res.body, '', path);
    }
  }
  assert.equal(snapshot(), before);
});

test('CSRF : chaque nouvel envoi sans jeton, avec un mauvais jeton, sans Origin ou avec une autre Origin → 403, aucune écriture', async () => {
  const before = snapshot();
  const variants = {
    'sans jeton': { csrfField: null },
    'jeton vide': { csrfField: '' },
    'mauvais jeton': { csrfField: csrfTokenFor('B'.repeat(43)) },
    'sans Origin': { originHeader: null },
    'Origin d\'un autre site': { originHeader: 'https://attaquant.example' },
    'Origin en clair': { originHeader: `http://127.0.0.1:${port}` },
    'Origin null': { originHeader: 'null' },
  };
  for (const path of POST_ROUTES) {
    for (const [name, options] of Object.entries(variants)) {
      const res = await post(path, VALID_POST, options);
      assert.equal(res.status, 403, `${path} ${name}`);
      assert.match(res.body, /<h1>Requête refusée<\/h1>/, `${path} ${name}`);
    }
  }
  assert.equal(snapshot(), before);
});

test('identifiant invalide ou inexistant : 404 propre sur chaque page et chaque envoi, sans écriture', async () => {
  const before = snapshot();
  const ids = ['0', 'abc', '999999', '01', '-1', '1.5', '%31', '1e3', '0x1', '__proto__', 'constructor', '', '4294967296', '99999999999999999'];
  const cases = [
    ['stations', ['', '/edit', '/delete'], 'Poste introuvable'],
    ['readers', ['', '/station', '/deactivate', '/replace'], 'Lecteur introuvable'],
  ];
  for (const [prefix, actions, title] of cases) {
    for (const id of ids) {
      for (const action of actions) {
        const path = `/${prefix}/${id}${action}`;
        if (path === `/${prefix}/`) continue; // vérifié ci-dessous
        const get = await page(path);
        assert.equal(get.status, 404, path);
        assert.ok(get.body.includes(`<h1>${title}</h1>`), path);
        if (action === '') continue; // fiche : lecture seule
        const sent = await post(path, VALID_POST);
        assert.equal(sent.status, 404, `POST ${path}`);
        assert.ok(sent.body.includes(`<h1>${title}</h1>`), `POST ${path}`);
      }
    }
  }
  for (const path of ['/stations/', '/readers/']) {
    const res = await page(path);
    assert.equal(res.status, 404, path);
    assert.ok(res.body.includes('introuvable</h1>'), path);
  }
  // Chemins qui ne sont pas des routes : 404 sans corps.
  for (const path of ['/stations/1/', '/stations/1/x', '/stations/1/edit/2', '/stations/1/location', '/stations/1/station',
    '/readers/1/edit', '/readers/1/delete', '/readers/1/station/', '/readers/1/__proto__', '/station', '/reader', '/readers/new/x']) {
    const res = await page(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.body, '', path);
  }
  assert.equal(snapshot(), before);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));
});

test('méthodes : 405 avec Allow sur les nouvelles routes', async () => {
  const cases = [['POST', '/stations', 'GET'], ['POST', '/readers', 'GET'], ['PUT', '/stations/new', 'GET, POST'], ['POST', '/stations/1', 'GET'],
    ['POST', '/readers/1', 'GET'], ['DELETE', '/readers/1/replace', 'GET, POST'], ['PATCH', '/readers/1/station', 'GET, POST']];
  for (const [method, path, allow] of cases) {
    const res = await send({ method, path, headers: cookie() });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.allow, allow, `${method} ${path}`);
  }
});

// ---------------------------------------------------------------- bandeau et listes

test('bandeau : « Postes et lecteurs » actif sur la rubrique, « Inventaire » actif sur l\'inventaire ; onglets', async () => {
  const stations = await page('/stations');
  assert.equal(stations.status, 200);
  assert.ok(stations.body.includes('<a href="/">Inventaire</a>'));
  assert.ok(stations.body.includes('<a class="actif" href="/stations" aria-current="page">Postes et lecteurs</a>'));
  assert.ok(stations.body.includes('<a class="actif" aria-current="page" href="/stations">Postes</a>'));
  assert.ok(stations.body.includes('<a href="/readers">Lecteurs</a>'));
  assert.ok(stations.body.includes('<a class="bouton" href="/stations/new">Nouveau poste</a>'));
  const readers = await page('/readers');
  assert.ok(readers.body.includes('<a class="actif" href="/stations">Postes et lecteurs</a>'));
  assert.ok(readers.body.includes('<a class="actif" aria-current="page" href="/readers">Lecteurs</a>'));
  assert.ok(readers.body.includes('<a class="bouton" href="/readers/new">Nouveau lecteur</a>'));
  const list = await page('/');
  assert.ok(list.body.includes('<a class="actif" href="/" aria-current="page">Inventaire</a>'));
  assert.ok(list.body.includes('<a href="/stations">Postes et lecteurs</a>'));
  const sheet = await page('/items/1');
  assert.ok(sheet.body.includes('<a class="actif" href="/">Inventaire</a>'));
});

// ---------------------------------------------------------------- postes

test('création d\'un poste : 303 vers sa fiche avec ?ok=cree, audit station.create, journal, fiche affichée', async () => {
  const form = await page('/stations/new');
  assert.equal(form.status, 200);
  assert.ok(form.body.includes('<form class="formulaire-page" method="post" action="/stations/new">'));
  assert.match(form.body, /<input id="name" name="name" value="" maxlength="100" required/);
  assert.match(form.body, /<textarea id="description" name="description" rows="4" maxlength="1000"/);

  const res = await post('/stations/new', { name: '  Banc 2 ', description: 'Mesures\r\nélectriques' });
  assert.equal(res.status, 303);
  const id = stationId('Banc 2');
  assert.equal(res.headers.location, `/stations/${id}?ok=cree`);
  assert.deepEqual(lastAudit(), { user_id: aliceId, action: 'station.create', entity_id: id, details: { name: 'Banc 2', description: 'Mesures\nélectriques' } });
  assert.ok(logs.includes(`poste ${id} créé par alice`));
  const sheet = await page(res.headers.location);
  assert.equal(sheet.status, 200);
  assert.ok(sheet.body.includes('<p class="succes" role="status">Poste créé.</p>'));
  assert.ok(sheet.body.includes('<h1>Banc 2</h1>'));
  assert.ok(sheet.body.includes('<p class="notes">Mesures\nélectriques</p>'));
  assert.ok(sheet.body.includes(`<a class="lien-danger" href="/stations/${id}/delete">Supprimer</a>`), 'sans historique : supprimable');
  const list = await page('/stations');
  assert.match(list.body, new RegExp(`href="/stations/${id}">Banc 2</a><span class="description-courte">Mesures\nélectriques</span>`));
});

test('création d\'un poste invalide : 400, saisie réaffichée échappée, aucune écriture (vide, invisible, trop long, doublons casse et NFC/NFD)', async () => {
  const before = snapshot();
  const evil = '"><script>alert(1)</script>';
  const empty = await post('/stations/new', { name: '   ', description: evil });
  assert.equal(empty.status, 400);
  assert.ok(empty.body.includes('<p class="erreur-champ" id="name-erreur">Le nom est obligatoire.</p>'));
  assert.ok(empty.body.includes('>&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</textarea>'));
  assert.ok(!empty.body.includes('<script'));
  for (const encoded of ['%E2%80%8B', '%EF%BB%BF%C2%AD', '%E3%85%A4', '%E2%A0%80']) {
    const res = await postRaw('/stations/new', `name=${encoded}&description=`);
    assert.equal(res.status, 400, encoded);
    assert.ok(res.body.includes('Le nom est obligatoire.'), encoded);
  }
  const long = await post('/stations/new', { name: 'n'.repeat(101), description: '' });
  assert.equal(long.status, 400);
  assert.ok(long.body.includes('Le nom ne doit pas dépasser 100 caractères (101 saisis).'));
  assert.ok(long.body.includes(`value="${'n'.repeat(101)}"`), 'saisie conservée');
  const longDesc = await post('/stations/new', { name: 'Neuf', description: 'd'.repeat(1001) });
  assert.equal(longDesc.status, 400);
  assert.ok(longDesc.body.includes('<p class="erreur-champ" id="description-erreur">La description ne doit pas dépasser'));
  for (const name of ['banc 2', 'BANC 2', 'Atelier', 'ATELIER']) {
    const res = await post('/stations/new', { name });
    assert.equal(res.status, 400, name);
    assert.match(res.body, /Un poste porte déjà ce nom : « (Banc 2|Atelier) » \(majuscules et minuscules confondues\)/, name);
  }
  // Même nom en NFD (« É » décomposé) et en NFC.
  assert.equal((await post('/stations/new', { name: 'Étuve' })).status, 303);
  const nfd = await postRaw('/stations/new', 'name=E%CC%81TUVE');
  assert.equal(nfd.status, 400);
  assert.ok(nfd.body.includes('Un poste porte déjà ce nom : « Étuve »'));
  // Noms identiques à l'œil : espaces multiples, insécables (U+00A0, U+202F, U+2007), encodés.
  for (const encoded of ['Banc%20%20%202', 'BANC%C2%A02', 'banc%E2%80%AF2', 'Banc%E2%80%87%C2%A0%202', '%C2%A0Banc%202%E2%80%AF']) {
    const res = await postRaw('/stations/new', `name=${encoded}&description=`);
    assert.equal(res.status, 400, encoded);
    assert.ok(res.body.includes('Un poste porte déjà ce nom : « Banc 2 »'), encoded);
  }
  assert.equal(count('stations'), JSON.parse(before)[0].length + 1);
  // Bornes exactes acceptées.
  assert.equal((await post('/stations/new', { name: 'm'.repeat(100), description: 'd'.repeat(1000) })).status, 303);
  assertSafePage(nfd.body, 'formulaire de poste en erreur');
});

test('modification d\'un poste : sans changement → ?ok=inchange sans audit ; changement → avant/après ; doublon → 400', async () => {
  const id = stationId('Banc 2');
  const form = await page(`/stations/${id}/edit`);
  assert.ok(form.body.includes('<input id="name" name="name" value="Banc 2"'));
  assert.ok(form.body.includes('>Mesures\nélectriques</textarea>'));
  const audits = count('audit_log');
  const same = await post(`/stations/${id}/edit`, { name: 'Banc 2 ', description: 'Mesures\r\nélectriques' });
  assert.equal(same.headers.location, `/stations/${id}?ok=inchange`);
  assert.equal(count('audit_log'), audits);
  const changed = await post(`/stations/${id}/edit`, { name: 'Banc 2', description: 'Mesures' });
  assert.equal(changed.headers.location, `/stations/${id}?ok=modifie`);
  assert.deepEqual(lastAudit().details, { description: { before: 'Mesures\nélectriques', after: 'Mesures' } });
  const before = snapshot();
  const dup = await post(`/stations/${id}/edit`, { name: 'étuve', description: '' });
  assert.equal(dup.status, 400);
  assert.ok(dup.body.includes('<p class="sous-titre-page">Banc 2</p>'), 'nom enregistré rappelé');
  assert.equal(snapshot(), before);
});

test('poste inséré hors interface avec une espace insécable : la création du même nom avec une espace ordinaire est refusée (400)', async () => {
  const stored = `Quai${String.fromCodePoint(0xA0)}Nord`;
  db.prepare('INSERT INTO stations (name, created_at) VALUES (?, ?)').run(stored, NOW);
  const before = snapshot();
  for (const name of ['Quai Nord', 'quai  nord']) {
    const res = await post('/stations/new', { name });
    assert.equal(res.status, 400, name);
    assert.ok(res.body.includes('Un poste porte déjà ce nom'), name);
  }
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- lecteurs : création, clé, simulateur

let reader2, key2;

test('création d\'un lecteur : page de clé unique (200, no-store, sans redirection), numéro MAX+1, audit sans clé', async () => {
  const banc = stationId('Banc 2');
  const form = await page('/readers/new');
  assert.equal(form.status, 200);
  assert.ok(form.body.includes('<option value="" selected>Non affecté</option>'));
  assert.ok(form.body.includes(`<option value="${banc}">Banc 2</option>`));
  assertSafePage(form.body, 'nouveau lecteur');

  const res = await post('/readers/new', { station: String(banc) });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.location, undefined);
  reader2 = 2;
  key2 = keyFrom(res);
  shownKeys.push({ id: reader2, hex: key2, page: res.body });
  assert.ok(Buffer.from(db.prepare('SELECT aead_key FROM readers WHERE id = 2').get().aead_key).equals(Buffer.from(key2, 'hex')));
  assert.ok(res.body.includes('<p class="succes" role="status">Lecteur n° 2 créé.</p>'));
  assert.ok(res.body.includes('<h1>Clé du lecteur n° 2</h1>'));
  assert.ok(res.body.includes('<p class="numero-lecteur">2</p>'));
  assert.ok(res.body.includes('Cette clé ne sera plus jamais affichée.'));
  assert.ok(res.body.includes('Injectez-la maintenant dans le boîtier'));
  assert.ok(res.body.includes('Si elle est perdue, remplacez la clé'));
  assert.ok(res.body.includes('Ne rechargez pas cette page : le navigateur proposerait de renvoyer le formulaire, ce qui créerait un autre lecteur.'));
  assert.ok(res.body.includes('<p>Fermez cet onglet une fois la clé injectée dans le boîtier.</p>'));
  assert.ok(res.body.includes('<section class="fiche-carte fiche-large" aria-labelledby="titre-numero">\n<h2 id="titre-numero">Numéro du lecteur</h2>'));
  assert.ok(res.body.includes('<h2 id="titre-cle">Clé AES-256 (64 caractères hexadécimaux)</h2>'));
  // Page de production : aucune procédure de développement (simulateur, fichier de clé, chemins dev/).
  for (const absent of ['simulateur', '--key-file', '.key', 'dev/', 'fichier']) assert.ok(!res.body.includes(absent), absent);
  assert.ok(res.body.includes('<a class="bouton" href="/readers">Retour aux lecteurs</a>'));
  assert.equal(res.body.split(key2).length - 1, 1, 'clé affichée une seule fois dans la page');
  assertSafePage(res.body, 'page de clé');
  assert.deepEqual(lastAudit(), { user_id: aliceId, action: 'reader.create', entity_id: 2, details: { id: 2, station: { id: banc, name: 'Banc 2' } } });
  assert.ok(logs.includes('lecteur 2 créé par alice'));
});

test('bout en bout : le simulateur, avec la clé affichée, est accepté (204) ; la même trame → 400 ; POST /api/frames direct → 204', async () => {
  const keyFile = join(dir, 'lecteur-2.key');
  writeFileSync(keyFile, `${key2}\n`); // format du fichier : comme dev/reader-1.key (dev-seed)
  const first = await simulate(reader2, keyFile, 1);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /HTTP 204/);
  const replay = await simulate(reader2, keyFile, 1);
  assert.equal(replay.code, 1);
  assert.match(replay.stdout, /HTTP 400/);
  rmSync(keyFile);
  assert.equal((await postFrame(reader2, 2, Buffer.from(key2, 'hex'))).status, 204);
  assert.deepEqual(db.prepare('SELECT reader_id, station_id, counter FROM scans ORDER BY id').all().map((r) => ({ ...r })),
    [{ reader_id: 2, station_id: stationId('Banc 2'), counter: 1 }, { reader_id: 2, station_id: stationId('Banc 2'), counter: 2 }]);
  const sheet = await page('/items/1');
  assert.ok(sheet.body.includes('<span class="etat etat-poste">Banc 2</span>'));
});

test('liste et fiche du lecteur : poste, état, dernier scan, dernier compteur, derniers scans avec l\'objet ; pas de clé', async () => {
  const list = await page('/readers');
  assert.match(list.body, /<a class="lien-objet" href="\/readers\/2">Lecteur n° 2<\/a><\/td>\n<td data-label="Poste"><a class="lien-simple" href="\/stations\/\d+">Banc 2<\/a><\/td>\n<td data-label="État"><span class="etat etat-actif">actif<\/span><\/td>\n<td data-label="Dernier scan"><time [^>]*>à l&#39;instant<\/time><\/td>\n<td data-label="Dernier compteur">2<\/td>/);
  assert.match(list.body, /href="\/readers\/1">Lecteur n° 1<\/a>[\s\S]*?<td data-label="Dernier scan"><span class="texte-doux">aucun<\/span>/);
  assertSafePage(list.body, 'liste des lecteurs');
  const sheet = await page('/readers/2');
  assert.equal(sheet.status, 200);
  assert.ok(sheet.body.includes('<h1>Lecteur n° 2</h1>'));
  assert.ok(sheet.body.includes('<a class="bouton" href="/readers/2/station">Changer de poste</a>'));
  assert.ok(sheet.body.includes('<a class="bouton bouton-secondaire" href="/readers/2/replace">Remplacer la clé</a>'));
  assert.ok(sheet.body.includes('<a class="lien-danger" href="/readers/2/deactivate">Désactiver</a>'));
  assert.match(sheet.body, /<td><span class="uid">04A1B2C3D4E5F6<\/span><\/td>\n<td data-label="Objet"><a class="lien-simple" href="\/items\/1">Multimètre<\/a><\/td>/);
  assertSafePage(sheet.body, 'fiche du lecteur');
  const station = await page(`/stations/${stationId('Banc 2')}`);
  assert.ok(station.body.includes('<a class="lien-objet" href="/readers/2">Lecteur n° 2</a>'));
  assert.ok(station.body.includes('<a class="lien-objet" href="/items/1">Multimètre</a>'), 'objet présent au poste');
  assert.ok(!station.body.includes('class="lien-danger"'), 'poste avec historique : pas de lien Supprimer');
  assert.ok(station.body.includes('Ce poste a un historique'));
  assertSafePage(station.body, 'fiche de poste');
});

test('changer un lecteur de poste : ni scans.station_id ni la localisation actuelle ne changent ; le scan suivant suit le nouveau poste', async () => {
  const banc = stationId('Banc 2');
  const scansBefore = JSON.stringify(db.prepare('SELECT * FROM scans ORDER BY id').all());
  const locationBefore = JSON.stringify(db.prepare('SELECT * FROM item_locations').all());
  const form = await page('/readers/2/station');
  assert.ok(form.body.includes(`<option value="${banc}" selected>Banc 2</option>`));
  assertSafePage(form.body, 'changer de poste');

  const audits = count('audit_log');
  const same = await post('/readers/2/station', { station: String(banc) });
  assert.equal(same.headers.location, '/readers/2?ok=inchange');
  assert.equal(count('audit_log'), audits);

  const before = snapshot();
  for (const station of ['999', 'abc', '0', '01', '1 OR 1=1']) {
    const res = await post('/readers/2/station', { station });
    assert.equal(res.status, 400, station);
    assert.ok(res.body.includes('Ce poste n&#39;existe pas ou plus.'), station);
  }
  const missing = await post('/readers/2/station', {});
  assert.equal(missing.status, 400, 'champ absent');
  assert.equal(snapshot(), before);

  const moved = await post('/readers/2/station', { station: '1' });
  assert.equal(moved.status, 303);
  assert.equal(moved.headers.location, '/readers/2?ok=affecte');
  assert.deepEqual(lastAudit(), { user_id: aliceId, action: 'reader.assign', entity_id: 2, details: { before: { id: banc, name: 'Banc 2' }, after: { id: 1, name: 'Atelier' } } });
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM scans ORDER BY id').all()), scansBefore, 'scans.station_id figé');
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM item_locations').all()), locationBefore, 'localisation inchangée');
  assert.ok((await page('/readers/2?ok=affecte')).body.includes('Poste du lecteur modifié.'));
  assert.equal((await postFrame(2, 3, Buffer.from(key2, 'hex'))).status, 204);
  assert.equal(db.prepare('SELECT station_id FROM scans WHERE reader_id = 2 AND counter = 3').get().station_id, 1);
});

let reader3, key3;

test('remplacement de clé : confirmation, puis page de la nouvelle clé ; ancien lecteur → 400, nouveau → 204, même poste', async () => {
  const confirm = await page('/readers/2/replace');
  assert.equal(confirm.status, 200);
  assert.ok(confirm.body.includes('<form method="post" action="/readers/2/replace">'));
  assert.ok(confirm.body.includes('<button class="bouton bouton-danger" type="submit">Remplacer la clé</button>'));
  assert.ok(confirm.body.includes('désactivé définitivement'));
  assert.ok(!confirm.body.includes(key2));
  assertSafePage(confirm.body, 'confirmation de remplacement');

  const res = await post('/readers/2/replace');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.location, undefined);
  reader3 = 3;
  key3 = keyFrom(res);
  shownKeys.push({ id: reader3, hex: key3, page: res.body });
  assert.notEqual(key3, key2);
  assert.ok(res.body.includes('Clé remplacée : lecteur n° 3 créé, lecteur n° 2 désactivé.'));
  assert.ok(res.body.includes('<p class="sous-titre-page">Poste : Atelier</p>'));
  assert.ok(!res.body.includes('simulateur'), 'aucune procédure de développement sur la page de clé');
  assertSafePage(res.body, 'page de clé (remplacement)');
  const lines = db.prepare('SELECT user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 2').all()
    .reverse().map((r) => ({ ...r, details: JSON.parse(r.details) }));
  assert.deepEqual(lines, [
    { user_id: aliceId, action: 'reader.replace', entity_id: 2, details: { old_id: 2, new_id: 3, station: { id: 1, name: 'Atelier' } } },
    { user_id: aliceId, action: 'reader.create', entity_id: 3, details: { replaces: 2, station: { id: 1, name: 'Atelier' } } },
  ]);
  assert.deepEqual(db.prepare('SELECT id, station_id, active FROM readers WHERE id IN (2, 3) ORDER BY id').all().map((r) => ({ ...r })),
    [{ id: 2, station_id: 1, active: 0 }, { id: 3, station_id: 1, active: 1 }]);
  assert.ok(logs.includes('clé du lecteur 2 remplacée par alice : nouveau lecteur 3, lecteur 2 désactivé'));

  assert.equal((await postFrame(2, 10, Buffer.from(key2, 'hex'))).status, 400, 'ancien lecteur');
  assert.equal((await postFrame(3, 1, Buffer.from(key3, 'hex'))).status, 204, 'nouveau lecteur');
  assert.equal((await postFrame(3, 2, Buffer.from(key2, 'hex'))).status, 400, 'ancienne clé sur le nouveau numéro');
});

test('lecteur désactivé : plus de changement de poste, de remplacement ni de désactivation (409 sans écriture) ; pages explicatives', async () => {
  const sheet = await page('/readers/2');
  assert.ok(sheet.body.includes('<span class="etat etat-desactive">désactivé</span>'));
  assert.ok(!sheet.body.includes('href="/readers/2/station"') && !sheet.body.includes('href="/readers/2/replace"'));
  assertSafePage(sheet.body, 'fiche d\'un lecteur désactivé');
  for (const action of ['station', 'replace', 'deactivate']) {
    const get = await page(`/readers/2/${action}`);
    assert.equal(get.status, 200, action);
    assert.ok(get.body.includes('<h1>Lecteur désactivé</h1>'), action);
    assert.ok(!get.body.includes('action="/readers/2/'), action);
  }
  const before = snapshot();
  for (const action of ['station', 'replace', 'deactivate']) {
    const res = await post(`/readers/2/${action}`, { station: '1' });
    assert.equal(res.status, 409, action);
    assert.ok(res.body.includes('<h1>Lecteur désactivé</h1>'), action);
    assert.ok(!/[0-9a-f]{64}/.test(res.body), `${action} : aucune clé`);
  }
  assert.equal(snapshot(), before);
});

test('désactivation : confirmation, 303 ?ok=desactive, audit ; ses trames sont ensuite refusées (400)', async () => {
  const confirm = await page('/readers/3/deactivate');
  assert.ok(confirm.body.includes('<button class="bouton bouton-danger" type="submit">Désactiver définitivement</button>'));
  assert.ok(confirm.body.includes('La désactivation est définitive'));
  assertSafePage(confirm.body, 'confirmation de désactivation');
  const res = await post('/readers/3/deactivate');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/readers/3?ok=desactive');
  assert.deepEqual(lastAudit(), { user_id: aliceId, action: 'reader.deactivate', entity_id: 3, details: { station: { id: 1, name: 'Atelier' } } });
  assert.ok((await page(res.headers.location)).body.includes('Lecteur désactivé. Ses trames sont désormais refusées.'));
  assert.equal((await postFrame(3, 5, Buffer.from(key3, 'hex'))).status, 400);
  const again = await post('/readers/3/deactivate');
  assert.equal(again.status, 409);
});

test('lecteur non affecté : création sans poste ; un scan donne « inconnue (lecteur n° X non affecté) », lien vers le lecteur', async () => {
  const res = await post('/readers/new', { station: '' });
  assert.equal(res.status, 200);
  const hex = keyFrom(res);
  shownKeys.push({ id: 4, hex, page: res.body });
  assert.ok(res.body.includes('<p class="sous-titre-page">Poste : non affecté</p>'));
  assert.deepEqual(lastAudit().details, { id: 4, station: null });
  assert.equal((await postFrame(4, 1, Buffer.from(hex, 'hex'))).status, 204);
  const list = await page('/');
  assert.ok(list.body.includes('<a class="lien-etat" href="/readers/4"><span class="etat etat-inconnue">inconnue (lecteur n° 4 non affecté)</span></a>'));
  assertSafePage(list.body, 'inventaire avec lecteur non affecté');
  const sheet = await page('/items/1');
  assert.ok(sheet.body.includes('<a class="lien-etat" href="/readers/4"><span class="etat etat-inconnue">'));
  const readers = await page('/readers');
  assert.match(readers.body, /href="\/readers\/4">Lecteur n° 4<\/a><\/td>\n<td data-label="Poste"><span class="texte-doux">non affecté<\/span>/);
  // Champ « station » forgé : refusé, aucun lecteur créé.
  const before = snapshot();
  for (const station of ['abc', '999', '-1']) {
    const bad = await post('/readers/new', { station });
    assert.equal(bad.status, 400, station);
    assert.ok(bad.body.includes('Ce poste n&#39;existe pas ou plus.'), station);
  }
  assert.equal((await post('/readers/new', {})).status, 400, 'champ absent');
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- suppression des postes

test('suppression d\'un poste refusée pour chaque cause (scan, correction, lecteur actif, lecteur désactivé) : explication, 409, aucune écriture', async () => {
  // Scan : Banc 2 a reçu les scans du lecteur 2, déplacé depuis vers l'Atelier.
  const banc = stationId('Banc 2');
  // Correction : poste créé puis utilisé pour une correction de localisation.
  assert.equal((await post('/stations/new', { name: 'Zone C' })).status, 303);
  const zone = stationId('Zone C');
  assert.equal((await post('/items/1/location', { station: String(zone) })).status, 303);
  // Lecteur affecté, actif puis désactivé.
  assert.equal((await post('/stations/new', { name: 'Quai' })).status, 303);
  const quai = stationId('Quai');
  const created = await post('/readers/new', { station: String(quai) });
  assert.equal(created.status, 200);
  shownKeys.push({ id: 5, hex: keyFrom(created), page: created.body });

  const expect = async (id, cause) => {
    const confirm = await page(`/stations/${id}/delete`);
    assert.equal(confirm.status, 200, cause);
    assert.ok(confirm.body.includes('<h1>Suppression impossible</h1>'), cause);
    assert.ok(confirm.body.includes(cause), cause);
    assert.ok(confirm.body.includes(`<a class="bouton" href="/stations/${id}/edit">Renommer le poste</a>`), cause);
    assert.ok(!confirm.body.includes(`action="/stations/${id}/delete"`), cause);
    assertSafePage(confirm.body, `suppression impossible (${cause})`);
    const before = snapshot();
    const res = await post(`/stations/${id}/delete`);
    assert.equal(res.status, 409, cause);
    assert.ok(res.body.includes('<h1>Suppression impossible</h1>'), cause);
    assert.equal(snapshot(), before, cause);
  };
  await expect(banc, '<li>2 scans enregistrés à ce poste</li>');
  await expect(zone, '<li>1 correction manuelle de localisation vers ce poste</li>');
  await expect(quai, '<li>1 lecteur affecté à ce poste (actifs ou désactivés)</li>');
  assert.equal((await post('/readers/5/deactivate')).status, 303);
  await expect(quai, '<li>1 lecteur affecté à ce poste (actifs ou désactivés)</li>');
  assert.ok(logs.some((l) => l === `suppression du poste ${quai} refusée : le poste a un historique`));
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));
});

test('suppression d\'un poste sans historique : confirmation, 303 /stations?ok=supprime, audit avec l\'instantané', async () => {
  assert.equal((await post('/stations/new', { name: 'Temporaire', description: 'à retirer' })).status, 303);
  const id = stationId('Temporaire');
  const confirm = await page(`/stations/${id}/delete`);
  assert.ok(confirm.body.includes('<strong class="nom-confirme">Temporaire</strong>'));
  assert.ok(confirm.body.includes('<button class="bouton bouton-danger" type="submit">Supprimer définitivement</button>'));
  assertSafePage(confirm.body, 'confirmation de suppression de poste');
  const res = await post(`/stations/${id}/delete`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/stations?ok=supprime');
  const audit = lastAudit();
  assert.deepEqual([audit.action, audit.entity_id, audit.user_id], ['station.delete', id, aliceId]);
  assert.deepEqual([audit.details.name, audit.details.description], ['Temporaire', 'à retirer']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM stations WHERE id = ?').get(id).n, 0);
  assert.ok((await page('/stations?ok=supprime')).body.includes('<p class="succes" role="status">Poste supprimé.</p>'));
  assert.equal((await page(`/stations/${id}`)).status, 404);
  assert.equal((await post(`/stations/${id}/delete`)).status, 404, 'deuxième suppression');
  // Numéro jamais redonné.
  assert.equal((await post('/stations/new', { name: 'Après' })).status, 303);
  assert.ok(stationId('Après') > id);
});

test('?ok= : seul un code connu affiche un message constant', async () => {
  for (const ok of ['inconnu', '<script>alert(1)</script>', '__proto__', 'constructor', 'supprime', 'CREE', '']) {
    const sheet = await page(`/stations/1?ok=${encodeURIComponent(ok)}`);
    assert.equal(sheet.status, 200, ok);
    assert.ok(!sheet.body.includes('class="succes"'), ok);
    assert.ok(!sheet.body.includes('<script'), ok);
  }
  for (const ok of ['cree', 'affecte', '__proto__']) assert.ok(!(await page(`/stations?ok=${ok}`)).body.includes('class="succes"'), ok);
  for (const ok of ['cree', 'supprime', 'toString']) assert.ok(!(await page(`/readers/1?ok=${ok}`)).body.includes('class="succes"'), ok);
});

// ---------------------------------------------------------------- atomicité, limites

test('atomicité : si l\'écriture d\'audit échoue, rien n\'est écrit (500), aucune clé n\'est envoyée, le serveur continue', async () => {
  const before = snapshot();
  const logCount = logs.length;
  db.exec("CREATE TEMP TRIGGER audit_en_panne BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit en panne (test)'); END");
  try {
    for (const [path, fields] of [['/stations/new', { name: 'Panne' }], ['/stations/1/edit', { name: 'Atelier modifié' }],
      ['/readers/new', { station: '1' }], ['/readers/1/station', { station: '' }], ['/readers/1/replace', {}], ['/readers/1/deactivate', {}]]) {
      const res = await post(path, fields);
      assert.equal(res.status, 500, path);
      assert.equal(res.body, '', path);
    }
  } finally {
    db.exec('DROP TRIGGER temp.audit_en_panne');
  }
  assert.equal(snapshot(), before);
  assert.equal(db.isTransaction, false);
  assert.ok(logs.slice(logCount).every((l) => l.includes('audit en panne (test)')), logs.slice(logCount).join('\n'));
  assert.equal((await page('/readers')).status, 200);
});

test('plage d\'identifiants épuisée : lecteur 4294967295 présent → création et remplacement refusés proprement (409), sans écriture', async () => {
  db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (?, NULL, ?, 0, ?)').run(MAX_READER_ID, Buffer.alloc(32, 7), NOW);
  const before = snapshot();
  const created = await post('/readers/new', { station: '' });
  assert.equal(created.status, 409);
  assert.ok(created.body.includes('<h1>Aucun numéro de lecteur disponible</h1>'));
  assert.ok(created.body.includes('4 294 967 295') || created.body.includes(MAX_READER_ID.toLocaleString('fr-FR')));
  assertSafePage(created.body, 'numéros épuisés');
  const replaced = await post('/readers/1/replace');
  assert.equal(replaced.status, 409);
  assert.equal(snapshot(), before);
  assert.equal(db.prepare('SELECT active FROM readers WHERE id = 1').get().active, 1, 'lecteur 1 toujours actif');
  assert.ok(logs.includes('création de lecteur refusée : plus aucun numéro de lecteur disponible'));
  const sheet = await page(`/readers/${MAX_READER_ID}`);
  assert.equal(sheet.status, 200);
  assert.ok(sheet.body.includes(`<h1>Lecteur n° ${MAX_READER_ID}</h1>`));
});

// ---------------------------------------------------------------- fuite de clé, pages

test('les clés affichées n\'apparaissent NULLE PART ailleurs : base hors readers, journaux, URL, autres pages servies', async () => {
  // Quelques pages consultées après coup, en plus de toutes celles déjà servies.
  for (const path of ['/readers', '/readers/2', '/readers/3', '/readers/4', '/readers/5', '/stations', '/stations/1', '/', '/items/1', '/readers/2/replace', '/readers/1/replace']) {
    assert.equal((await page(path)).status, 200, path);
  }
  assert.equal(shownKeys.length, 4);
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'readers'").all().map((r) => r.name);
  assert.ok(tables.includes('audit_log') && tables.includes('scans') && tables.includes('stations'));
  for (const { id, hex, page: keyPage } of shownKeys) {
    const raw = Buffer.from(hex, 'hex');
    const variants = [hex, hex.toUpperCase(), raw.toString('base64'), raw.toString('latin1')];
    // Base : toutes les valeurs de toutes les tables (hors readers), en texte et en octets.
    for (const table of tables) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
        for (const value of Object.values(row)) {
          if (value instanceof Uint8Array) assert.ok(!Buffer.from(value).includes(raw), `${table} : octets de la clé ${id}`);
          else if (typeof value === 'string') {
            for (const v of variants) assert.ok(!value.includes(v), `${table} : clé ${id}`);
            assert.ok(!Buffer.from(value, 'latin1').includes(raw), `${table} : octets de la clé ${id}`);
          }
        }
      }
    }
    // Journaux du serveur.
    for (const line of logs) for (const v of variants) assert.ok(!line.includes(v), `journal : clé ${id} dans « ${line} »`);
    // Toutes les réponses : la clé n'est que dans SA page de clé (une seule), jamais dans une URL ni un en-tête.
    const pagesWithKey = served.filter((res) => variants.some((v) => res.body.includes(v)));
    assert.deepEqual(pagesWithKey.map((res) => res.body), [keyPage], `clé ${id} dans une autre page`);
    for (const res of served) {
      assert.ok(!res.path.toLowerCase().includes(hex), `URL : clé ${id}`);
      assert.ok(!JSON.stringify(res.headers).toLowerCase().includes(hex), `en-têtes : clé ${id}`);
    }
  }
});

test('toutes les pages HTML servies : aucune ressource externe, aucun style ou script, balises équilibrées, un bouton principal au plus', () => {
  const pages = served.filter((res) => (res.headers['content-type'] ?? '').startsWith('text/html'));
  assert.ok(pages.length > 100, `${pages.length} pages`);
  for (const res of pages) {
    assert.equal(res.headers['cache-control'], 'no-store', res.path);
    assertSafePage(res.body, `${res.method} ${res.path} (${res.status})`);
  }
  assert.ok(!logs.some((l) => l.startsWith('erreur interne') && !l.includes('audit en panne')), logs.join('\n'));
});
