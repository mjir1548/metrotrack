// Nom libre des lecteurs (D-019), par le serveur HTTPS réel :
// - création avec ou sans nom, nom nettoyé, nom invalide → 400 sans écriture, saisie conservée ;
// - « Renommer » : formulaire, CSRF et Origin exigés, audit reader.rename avant/après, sans
//   changement rien n'est écrit, nom vidé → désignation par le poste ;
// - « Remplacer la clé » : le nouveau lecteur reprend le nom ;
// - affichage par readerLabel partout (liste, fiche, fiche poste, page de clé, confirmations,
//   frise des scans d'un objet), toujours échappé ; numéro en information secondaire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { encodeFrame } from '../server/protocol.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-26T08:00:00.000Z';
const UID = '04A1B2C3D4E5F6';
const XSS = '<img src=x onerror=alert(1)>"\'&';
const XSS_ESCAPED = '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;';
// Construits par leur code : aucun caractère invisible littéral dans les sources
// (test/sources-invisibles.test.js).
const ZWSP = String.fromCodePoint(0x200B); // espace sans chasse, retirée par cleanLine
const HANGUL_FILLER = String.fromCodePoint(0x3164); // gardé par cleanLine, mais sans glyphe
let dir, db, server, port, certs, token, csrf, aliceId;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-lecteurs-nom-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  aliceId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, NOW).lastInsertRowid);
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?)").run(NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, NOW, NOW);
  token = createSession(db, aliceId);
  csrf = csrfTokenFor(token);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function send({ method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { Cookie: `__Host-mt_session=${token}`, ...headers };
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
const page = (path) => send({ path });
const post = (path, fields, { origin = `https://127.0.0.1:${port}`, withCsrf = true } = {}) => send({
  method: 'POST', path,
  body: new URLSearchParams(withCsrf ? { csrf, ...fields } : fields).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin === null ? {} : { Origin: origin }) },
});
const keyFrom = (res) => Buffer.from(/<pre class="cle">([0-9a-f]{64})<\/pre>/.exec(res.body)[1], 'hex');
const snapshot = () => JSON.stringify(['readers', 'audit_log'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const lastAudit = () => {
  const row = db.prepare('SELECT user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return { ...row, details: JSON.parse(row.details) };
};

let key1;

test('création avec un nom : nom nettoyé, enregistré et journalisé ; page de clé avec le nom et le numéro à configurer', async () => {
  const form = await page('/readers/new');
  assert.ok(form.body.includes('<label for="name">Nom <span class="obligatoire">(facultatif)</span></label>'));
  assert.match(form.body, /<input id="name" name="name" value="" maxlength="100" autocomplete="off"/);
  assert.doesNotMatch(form.body, /<input id="name"[^>]*required/);

  const res = await post('/readers/new', { name: `  Boîtier ${ZWSP}établi   gauche `, station: '1' });
  assert.equal(res.status, 200);
  key1 = keyFrom(res);
  assert.equal(db.prepare('SELECT name FROM readers WHERE id = 1').get().name, 'Boîtier établi gauche');
  assert.deepEqual(lastAudit(), { user_id: aliceId, action: 'reader.create', entity_id: 1, details: { id: 1, name: 'Boîtier établi gauche', station: { id: 1, name: 'Atelier' } } });
  assert.ok(res.body.includes('<p class="succes" role="status">Lecteur créé : Boîtier établi gauche.</p>'));
  assert.ok(res.body.includes('<p class="sous-titre-page">Boîtier établi gauche · Atelier</p>'));
  assert.ok(res.body.includes('<h2 id="titre-numero" class="etiquette">Numéro à configurer dans le boîtier</h2>\n<p class="numero-lecteur">1</p>'));
});

test('création : nom invalide → 400, rien n\'est écrit, saisie (nettoyée) et poste conservés', async () => {
  const before = snapshot();
  const long = await post('/readers/new', { name: 'x'.repeat(101), station: '1' });
  assert.equal(long.status, 400);
  assert.ok(long.body.includes('Le lecteur n\'a pas été créé.'));
  assert.ok(long.body.includes('Le nom ne doit pas dépasser 100 caractères (101 saisis).'));
  assert.ok(long.body.includes(`value="${'x'.repeat(101)}"`));
  assert.ok(long.body.includes('<option value="1" selected>Atelier</option>'));
  assert.match(long.body, /<input id="name"[^>]*aria-describedby="name-aide name-erreur" aria-invalid="true">/);
  const invisible = await post('/readers/new', { name: HANGUL_FILLER, station: '' });
  assert.equal(invisible.status, 400);
  assert.ok(invisible.body.includes('Le nom doit contenir au moins une lettre'));
  // Nom invalide ET poste hors format : les deux erreurs sont signalées. (Un poste au bon
  // format mais inexistant n'est détecté qu'à l'écriture, une fois le nom valide.)
  const both = await post('/readers/new', { name: HANGUL_FILLER, station: 'abc' });
  assert.equal(both.status, 400);
  assert.ok(both.body.includes('Le nom doit contenir au moins une lettre') && both.body.includes('Ce poste n&#39;existe pas ou plus.'));
  assert.equal(snapshot(), before);
});

test('affichage : liste, fiche, fiche du poste, frise des scans de l\'objet ; numéro en information secondaire', async () => {
  assert.equal((await send({
    method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream', Cookie: '' },
    body: encodeFrame({ readerId: 1, counter: 1, uid: Buffer.from(UID, 'hex'), key: key1 }),
  })).status, 204);
  const list = await page('/readers');
  assert.ok(list.body.includes('<a class="lien-objet" href="/readers/1">Boîtier établi gauche</a>'));
  const sheet = await page('/readers/1');
  assert.ok(sheet.body.includes('<h1>Boîtier établi gauche</h1>'));
  assert.ok(sheet.body.includes('<title>Boîtier établi gauche · MetroTrack</title>'));
  assert.ok(sheet.body.includes('<div><dt>Nom</dt><dd>Boîtier établi gauche</dd></div>'));
  assert.ok(sheet.body.includes('<div><dt>Numéro à configurer dans le boîtier</dt><dd><span class="numero-boitier">1</span></dd></div>'));
  assert.ok(sheet.body.includes('href="/readers/1/rename">'));
  const station = await page('/stations/1');
  assert.ok(station.body.includes('<a class="lien-objet" href="/readers/1">Boîtier établi gauche</a>'));
  const item = await page('/items/1');
  assert.match(item.body, /<p class="frise-detail">Scanné par Boîtier établi gauche <span class="badge badge--ok">Emplacement actuel<\/span><\/p>/);
  for (const path of ['/readers/1/station', '/readers/1/replace', '/readers/1/deactivate', '/readers/1/rename']) {
    const res = await page(path);
    assert.ok(res.body.includes('<p class="sous-titre-page">Boîtier établi gauche · Atelier</p>'), path);
    assert.ok(res.body.includes('<a href="/readers/1">Boîtier établi gauche</a>'), `${path} : fil d'Ariane`);
  }
  assert.ok((await page('/readers/1/replace')).body.includes('au même poste (Atelier), sous le même nom.'));
});

test('renommer : CSRF et Origin exigés (403, rien n\'est écrit)', async () => {
  const before = snapshot();
  assert.equal((await post('/readers/1/rename', { name: 'Pirate' }, { withCsrf: false })).status, 403);
  assert.equal((await post('/readers/1/rename', { name: 'Pirate', csrf: 'x'.repeat(43) }, { withCsrf: false })).status, 403);
  assert.equal((await post('/readers/1/rename', { name: 'Pirate' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/readers/1/rename', { name: 'Pirate' }, { origin: null })).status, 403);
  assert.equal(snapshot(), before);
});

test('renommer : 303 ?ok=renomme et audit avant/après ; même nom → ?ok=nom_inchange sans écriture ; invalide → 400 ; lecteur inconnu → 404', async () => {
  const form = await page('/readers/1/rename');
  assert.equal(form.status, 200);
  assert.ok(form.body.includes('<form class="formulaire-page" method="post" action="/readers/1/rename">'));
  assert.ok(form.body.includes('value="Boîtier établi gauche"'));

  const res = await post('/readers/1/rename', { name: XSS });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/readers/1?ok=renomme');
  assert.deepEqual(lastAudit(), { user_id: aliceId, action: 'reader.rename', entity_id: 1, details: { name: { before: 'Boîtier établi gauche', after: XSS } } });
  // Nom échappé partout où il est affiché.
  for (const path of ['/readers', '/readers/1?ok=renomme', '/stations/1', '/items/1', '/readers/1/rename']) {
    const body = (await page(path)).body;
    assert.ok(body.includes(XSS_ESCAPED), path);
    assert.ok(!body.includes('<img src=x'), path);
  }
  assert.ok((await page('/readers/1?ok=renomme')).body.includes('Nom du lecteur enregistré.'));

  const before = snapshot();
  const same = await post('/readers/1/rename', { name: `  ${XSS}  ` });
  assert.equal(same.headers.location, '/readers/1?ok=nom_inchange');
  const bad = await post('/readers/1/rename', { name: 'y'.repeat(101) });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.includes('Le nom n\'a pas été enregistré.'));
  assert.ok(bad.body.includes(`value="${'y'.repeat(101)}"`));
  assert.equal((await post('/readers/999/rename', { name: 'X' })).status, 404);
  assert.equal((await page('/readers/999/rename')).status, 404);
  assert.equal(snapshot(), before);
  assert.ok((await page('/readers/1?ok=nom_inchange')).body.includes('Aucune modification : le lecteur portait déjà ce nom.'));
});

test('nom vidé : le lecteur est de nouveau désigné par son poste ; remplacement : le nouveau lecteur reprend le nom', async () => {
  assert.equal((await post('/readers/1/rename', { name: '   ' })).headers.location, '/readers/1?ok=renomme');
  assert.deepEqual(lastAudit().details, { name: { before: XSS, after: '' } });
  assert.ok((await page('/readers')).body.includes('<a class="lien-objet" href="/readers/1">Lecteur · Atelier</a>'));
  // Frise de l'objet : sans nom, pas de « Scanné par ».
  assert.ok(!(await page('/items/1')).body.includes('Scanné par'));

  assert.equal((await post('/readers/1/rename', { name: 'Boîtier établi gauche' })).status, 303);
  const replaced = await post('/readers/1/replace', {});
  assert.equal(replaced.status, 200);
  assert.deepEqual({ ...db.prepare('SELECT name, station_id, active FROM readers WHERE id = 2').get() }, { name: 'Boîtier établi gauche', station_id: 1, active: 1 });
  assert.ok(replaced.body.includes('<p class="sous-titre-page">Boîtier établi gauche · Atelier</p>'));
  assert.ok(replaced.body.includes('Clé remplacée : nouveau numéro 2. L&#39;ancien numéro (1) est désactivé.'));
  // Homonymes (le remplaçant reprend le nom) : le numéro les distingue, dans la liste comme sur
  // la fiche du poste, sans la formule « Lecteur n° ».
  for (const path of ['/readers', '/stations/1']) {
    const body = (await page(path)).body;
    assert.ok(body.includes('<th scope="col">N° boîtier</th>'), path);
    for (const id of [1, 2]) {
      assert.ok(body.includes(`<a class="lien-objet" href="/readers/${id}">Boîtier établi gauche</a></td>\n<td data-label="N° boîtier"><span class="numero-boitier">${id}</span></td>`), `${path} : ${id}`);
    }
    assert.ok(!/lecteur n°/i.test(body), path);
  }
  // Le lecteur désactivé reste renommable.
  const sheet = await page('/readers/1');
  assert.ok(sheet.body.includes('href="/readers/1/rename">') && !sheet.body.includes('href="/readers/1/station"'));
  assert.equal((await post('/readers/1/rename', { name: 'Ancien boîtier' })).headers.location, '/readers/1?ok=renomme');
  assert.ok((await page('/readers')).body.includes('<a class="lien-objet" href="/readers/1">Ancien boîtier</a>'));
});
