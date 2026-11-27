// Vérification de l'étape U2 « Où est cet objet ? » par le testeur, contre un vrai serveur HTTPS.
// Complète test/recherche.test.js et test/recherche-web.test.js :
// - page Inventaire SANS JavaScript (GET /?q=) : multi-mots, accents, numéro de série, puce avec
//   ou sans séparateurs, morceaux de mots, classement ; même ordre que GET /api/recherche&tout=1 ;
// - /api/recherche : longueur comptée en caractères (et non en octets ou en unités UTF-16),
//   paramètre q répété, caractères de contrôle, 403 calculé avant la session, en-têtes de
//   sécurité sur les erreurs, chemins voisins ;
// - « depuis » = heure d'arrivée au poste, pas heure du dernier scan (plan U2) ;
// - /items/new?nom= : caractères de contrôle et bidirectionnels retirés, caractères hors BMP
//   jamais coupés en deux, premier paramètre retenu.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession } from '../server/sessions.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-26T08:00:00.000Z';
const KEY = Buffer.alloc(32, 0x3d);
const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const ch = (...codes) => String.fromCodePoint(...codes);
const EMOJI = ch(0x1F600); // hors BMP : 1 caractère, 2 unités UTF-16, 4 octets
let dir, db, server, port, certs, token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-recherche-verif-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste A', ?), (2, 'Poste B', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run(KEY, NOW, KEY, NOW);
  const insert = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, '04A1B2C3D4E5F6', 'Multimètre Fluke 87V n° 7', JSON.stringify({ 'N° de série': 'SN-41230987', Marque: 'Fluke' }), NOW, NOW);
  insert.run(2, null, 'Étuve électrique', JSON.stringify({ Fabricant: 'Mémmert' }), NOW, NOW);
  insert.run(3, null, 'Pied à coulisse', '{}', NOW, NOW);
  insert.run(4, null, 'Coulisse secondaire', '{}', NOW, NOW);
  insert.run(5, null, 'Grand pied à coulisse', '{}', NOW, NOW);
  insert.run(6, null, 'Recoulissement', '{}', NOW, NOW);
  insert.run(7, 'C0FFEE12', 'Banc de mesure', JSON.stringify({ Lieu: 'Coulisse nord' }), NOW, NOW);
  // Multimètre : arrivé au Poste A il y a 3 h, rescanné au même poste il y a 5 min.
  const scan = (reader, counter, minutesAgo, uid) => assert.equal(ingestFrame(db, encodeFrame({
    readerId: reader, counter, uid: Buffer.from(uid, 'hex'), key: KEY,
  }), new Date(Date.now() - minutesAgo * 60_000).toISOString()).ok, true);
  scan(1, 1, 180, '04A1B2C3D4E5F6');
  scan(1, 2, 5, '04A1B2C3D4E5F6');
  // Banc : au Poste A puis déplacé au Poste B il y a 10 min.
  scan(1, 3, 120, 'C0FFEE12');
  scan(2, 1, 10, 'C0FFEE12');
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('verif', DUMMY_HASH, NOW).lastInsertRowid);
  token = createSession(db, userId);
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

function send(path, { session = token, headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (session) h.Cookie = `__Host-mt_session=${session}`;
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const qs = (params) => new URLSearchParams(params).toString();
const apiNames = async (q, extra = {}) => JSON.parse((await send(`/api/recherche?${qs({ q, ...extra })}`)).body).resultats.map((r) => r.nom);
/** Noms des objets de la page Inventaire (liens de la colonne « Objet »), dans l'ordre. */
async function pageNames(q) {
  const res = await send(`/?${qs({ q })}`);
  assert.equal(res.status, 200, q);
  return [...res.body.matchAll(/<a class="lien-objet" href="\/items\/\d+">([^<]*)<\/a>/g)].map((m) => m[1]
    .replaceAll('&#39;', '\'').replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'));
}

test('page Inventaire sans JavaScript : multi-mots, accents, série, puce, morceaux de mots', async () => {
  assert.deepEqual(await pageNames('fluke 7'), ['Multimètre Fluke 87V n° 7']);
  assert.deepEqual(await pageNames('MULTIMETRE'), ['Multimètre Fluke 87V n° 7']);
  assert.deepEqual(await pageNames('etuve ELECTRIQUE'), ['Étuve électrique']);
  assert.deepEqual(await pageNames('memmert'), ['Étuve électrique']); // valeur de propriété, accent ignoré
  assert.deepEqual(await pageNames('41230987'), ['Multimètre Fluke 87V n° 7']); // morceau du n° de série
  assert.deepEqual(await pageNames('sn-41230987'), ['Multimètre Fluke 87V n° 7']);
  for (const chip of ['04A1B2', '04 a1 b2 c3', '04:A1:B2', 'a1-b2-c3', 'b2c3d4e5f6']) {
    assert.deepEqual(await pageNames(chip), ['Multimètre Fluke 87V n° 7'], chip);
  }
  assert.deepEqual(await pageNames('ulti luk'), ['Multimètre Fluke 87V n° 7']); // morceaux de mots
  assert.deepEqual(await pageNames('marque'), [], 'les clés de propriété ne sont pas cherchées');
  assert.deepEqual(await pageNames('fluke zzzz'), [], 'tous les mots sont exigés');
  // Aucun résultat : état vide, saisie rappelée échappée.
  const empty = await send(`/?${qs({ q: '<b>"zz\'' })}`);
  assert.match(empty.body, /Aucun objet ne correspond à «&nbsp;&lt;b&gt;&quot;zz&#39;&nbsp;»/);
  assert.doesNotMatch(empty.body, /<b>"zz/);
});

test('classement identique dans la page sans JavaScript et dans l\'API (&tout=1, palette)', async () => {
  // « coulisse » : début du nom, puis mot entier (alphabétique), puis morceau de mot, puis propriété.
  const expected = ['Coulisse secondaire', 'Grand pied à coulisse', 'Pied à coulisse', 'Recoulissement', 'Banc de mesure'];
  assert.deepEqual(await pageNames('coulisse'), expected);
  assert.deepEqual(await apiNames('coulisse', { tout: '1' }), expected);
  assert.deepEqual(await apiNames('coulisse'), expected);
  assert.deepEqual(await pageNames('pied coulisse'), ['Pied à coulisse', 'Grand pied à coulisse']);
  // Liste complète (q vide) : même ordre alphabétique dans la page et dans l'API.
  assert.deepEqual(await pageNames(''), await apiNames('', { tout: '1' }));
});

test('« depuis » = arrivée au poste (pas le dernier scan au même poste) ; déplacement = nouvelle arrivée', async () => {
  const [multi] = JSON.parse((await send(`/api/recherche?${qs({ q: 'multimetre' })}`)).body).resultats;
  assert.equal(multi.emplacement.libelle, 'Poste A');
  assert.match(multi.arrivee.texte, /^depuis [23] h$|^depuis le /); // 3 h plus tôt (veille si autour de minuit)
  assert.ok(Date.now() - Date.parse(multi.arrivee.iso) > 170 * 60_000, multi.arrivee.iso);
  const [bench] = JSON.parse((await send(`/api/recherche?${qs({ q: 'banc' })}`)).body).resultats;
  assert.equal(bench.emplacement.libelle, 'Poste B');
  assert.match(bench.arrivee.texte, /^depuis (9|10|11) min$/);
  assert.equal(bench.trouve.type, 'nom');
  assert.equal(bench.trouve.puce, undefined, 'puce non renvoyée si elle ne correspond pas');
});

test('/api/recherche : 200 caractères comptés en points de code (hors BMP compris), 201 → 400', async () => {
  for (const [q, status] of [[EMOJI.repeat(200), 200], [EMOJI.repeat(201), 400], ['é'.repeat(200), 200], ['é'.repeat(201), 400]]) {
    const res = await send(`/api/recherche?${qs({ q })}`);
    assert.equal(res.status, status, `${[...q].length} caractères`);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  }
});

test('/api/recherche : q répété → le premier ; contrôles retirés ; %-encodage invalide sans plantage', async () => {
  assert.deepEqual(await apiNames('banc'), ['Banc de mesure']);
  const first = JSON.parse((await send('/api/recherche?q=banc&q=etuve')).body).resultats.map((r) => r.nom);
  assert.deepEqual(first, ['Banc de mesure']);
  assert.deepEqual(await apiNames(`ba${ch(0)}nc`), ['Banc de mesure']);
  // Caractères invisibles (espace sans chasse, marque bidirectionnelle) retirés comme à la saisie.
  assert.deepEqual(await apiNames(`ba${ch(0x200B)}n${ch(0x202E)}c`), ['Banc de mesure']);
  const bad = await send('/api/recherche?q=%ZZ%');
  assert.equal(bad.status, 200);
  assert.equal(JSON.parse(bad.body).total, 0);
});

test('/api/recherche : origine refusée (403) avant même la session ; erreurs avec en-têtes de sécurité', async () => {
  for (const site of ['cross-site', 'same-site', 'none']) {
    const res = await send('/api/recherche?q=banc', { session: null, headers: { 'Sec-Fetch-Site': site } });
    assert.equal(res.status, 403, site);
    assert.equal(res.body, '{"erreur":"origine"}');
  }
  for (const res of [
    await send('/api/recherche?q=banc', { session: null }),
    await send(`/api/recherche?${qs({ q: 'x'.repeat(201) })}`),
    await send('/api/recherche?q=banc', { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
  ]) {
    assert.equal(res.headers['content-security-policy'], CSP);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.match(res.headers['strict-transport-security'] ?? '', /max-age=\d+/);
    assert.equal(res.headers['access-control-allow-origin'], undefined);
  }
  for (const path of ['/api/recherche/', '/API/recherche', '/api/recherche.json', '/api//recherche']) {
    assert.equal((await send(`${path}?q=banc`)).status, 404, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    assert.equal((await send('/api/recherche?q=banc', { method })).status, 405, method);
  }
});

test('/items/new?nom= : contrôles et caractères bidirectionnels retirés, hors BMP non coupé, premier paramètre', async () => {
  const valueOf = async (query) => {
    const res = await send(`/items/new?${query}`);
    assert.equal(res.status, 200, query);
    return res.body.match(/<input id="name" name="name" value="([^"]*)"/)[1];
  };
  assert.equal(await valueOf(qs({ nom: `a${ch(0)}b${ch(7)}c${ch(0x202E)}d` })), 'abcd');
  const emoji = await valueOf(qs({ nom: EMOJI.repeat(300) }));
  assert.equal([...emoji].length, 200);
  assert.equal(emoji, EMOJI.repeat(200), 'aucune moitié de paire de substitution');
  assert.equal(await valueOf(qs({ nom: `x' autofocus onfocus='alert(1)` })), 'x&#39; autofocus onfocus=&#39;alert(1)');
  assert.equal(await valueOf('nom=premier&nom=second'), 'premier');
  assert.equal(await valueOf('nom='), '');
  assert.equal(await valueOf('autre=1'), '');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 7, 'rien n\'est enregistré');
});
