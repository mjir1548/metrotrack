// Vérification de l'étape 5 (testeur) : cas limites de l'édition des fiches non couverts par
// edition-web.test.js, contre un vrai serveur HTTPS en processus.
// - bornes en caractères non ASCII (accents, emoji hors BMP) après le trajet HTTP complet
//   (encodage du formulaire, décodage UTF-8 côté serveur) ;
// - champs répétés incohérents ;
// - Content-Type invalide sur chaque envoi d'édition ; corps exactement au plafond ; corps
//   au-delà du plafond envoyé en « chunked » (sans Content-Length) ;
// - jeton CSRF valide mais dérivé d'une AUTRE session ;
// - envois concurrents (éditions et suppressions simultanées) : audit cohérent ;
// - numéro de fiche jamais réutilisé (AUTOINCREMENT, D-014) : ni la localisation ni l'historique de la
//   fiche supprimée ne passent à la nouvelle ; chaque entity_id d'audit_log désigne une seule fiche.
// Sessions créées directement en base : aucun calcul argon2.
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
import { MAX_EDIT_FORM_BYTES } from '../server/web.js';
import { MAX_NAME_CHARS, MAX_NOTES_CHARS, MAX_PROPERTY_KEY_CHARS, MAX_PROPERTY_VALUE_CHARS } from '../server/items.js';
import { makeTestCerts } from './tls-fixture.js';
import { statusOrCut, CUT } from './coupure.js';

const NOW = '2026-11-17T10:00:00.000Z';
let dir, db, server, port, certs, origin;
let alice, bob; // { id, token, csrf }
let stationA;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-edition-verif-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const addUser = (name) => {
    const id = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(name, DUMMY_HASH, NOW).lastInsertRowid);
    const token = createSession(db, id);
    return { id, token, csrf: csrfTokenFor(token) };
  };
  alice = addUser('alice');
  bob = addUser('bob');
  stationA = Number(db.prepare("INSERT INTO stations (name, created_at) VALUES ('Poste A', ?)").run(NOW).lastInsertRowid);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
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

function send({ method = 'GET', path = '/', headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (chunked) h['Transfer-Encoding'] = 'chunked';
    else if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // Le serveur peut fermer pendant l'envoi d'un corps refusé : sans effet si la réponse est déjà là.
    req.on('error', reject);
    req.end(body);
  });
}

/** POST de formulaire (paires répétables) avec la session, l'Origin et le jeton de `user`. */
function post(path, pairs, { user = alice, csrf = user.csrf, contentType = 'application/x-www-form-urlencoded' } = {}) {
  const params = new URLSearchParams(pairs);
  if (csrf !== null) params.append('csrf', csrf);
  return send({
    method: 'POST', path, body: params.toString(),
    headers: { 'Content-Type': contentType, Cookie: `__Host-mt_session=${user.token}`, Origin: origin },
  });
}
const page = (path, user = alice) => send({ path, headers: { Cookie: `__Host-mt_session=${user.token}` } });

const itemFields = (name, notes = '', rows = []) => [
  ['name', name], ['notes', notes], ...rows.flatMap(([k, v]) => [['prop_key', k], ['prop_value', v]]),
];
const idFrom = (res) => Number(res.headers.location.match(/^\/items\/(\d+)\?ok=/)[1]);
const create = async (name, notes = '', rows = []) => {
  const res = await post('/items/new', itemFields(name, notes, rows));
  assert.equal(res.status, 303, `création de « ${name.slice(0, 20)} »`);
  return idFrom(res);
};
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const snapshot = () => JSON.stringify({
  items: db.prepare('SELECT * FROM items ORDER BY id').all(),
  audit: count('audit_log'),
  corrections: count('location_corrections'),
});
const auditsFor = (id) => db.prepare('SELECT action, user_id, details FROM audit_log WHERE entity_id = ? ORDER BY id').all(id)
  .map((row) => ({ ...row, details: JSON.parse(row.details) }));

// Emoji hors BMP : 1 point de code, 2 unités UTF-16, 4 octets UTF-8. Construit par son code
// (aucun caractère spécial littéral dans ce fichier).
const EMOJI = String.fromCodePoint(0x1F527);

// ---------------------------------------------------------------- bornes non ASCII

test('bornes en caractères après le trajet HTTP : limite exacte acceptée, limite + 1 refusée sans écriture (accents, emoji)', async () => {
  const cases = [
    ['nom', (s) => itemFields(s), MAX_NAME_CHARS],
    ['notes', (s) => itemFields('n', s), MAX_NOTES_CHARS],
    ['clé', (s) => itemFields('k', '', [[s, 'v']]), MAX_PROPERTY_KEY_CHARS],
    ['valeur', (s) => itemFields('v', '', [['k', s]]), MAX_PROPERTY_VALUE_CHARS],
  ];
  // Bornes en unités UTF-16, comme maxlength : « é » compte pour 1, un emoji hors plan de base
  // pour 2. Limite exacte = max « é », ou max/2 emojis ; limite + 1 = un caractère de plus.
  for (const [field, fields, max] of cases) {
    for (const unit of ['é', EMOJI]) {
      const atLimit = unit.repeat(max / unit.length);
      const ok = await post('/items/new', fields(atLimit));
      assert.equal(ok.status, 303, `${field} : ${max} unités en ${unit === 'é' ? 'é' : 'emoji'}`);
      const stored = db.prepare('SELECT name, notes, properties FROM items WHERE id = ?').get(idFrom(ok));
      assert.ok(JSON.stringify(stored).includes(atLimit), `${field} : stocké intact`);

      const before = snapshot();
      const ko = await post('/items/new', fields(`${atLimit}a`));
      assert.equal(ko.status, 400, `${field} : ${max + 1} caractères`);
      assert.equal(snapshot(), before, `${field} : aucune écriture`);
    }
  }
});

test('notes : CRLF envoyés par le navigateur comptés comme un seul caractère (10 000 avec retours à la ligne acceptés)', async () => {
  const notes = `${'a\r\n'.repeat(3333)}a`; // 10 000 caractères une fois CRLF → LF
  const id = await create('Notes multilignes', notes);
  assert.equal(db.prepare('SELECT notes FROM items WHERE id = ?').get(id).notes, notes.replace(/\r\n/g, '\n'));
  const html = (await page(`/items/${id}`)).body;
  assert.ok(html.includes(`<p class="notes">${'a\n'.repeat(3333)}a</p>`), 'retours à la ligne conservés à l\'affichage');
});

// ---------------------------------------------------------------- champs répétés

test('champs répétés incohérents : premier name et premières notes retenus ; clés en trop → valeurs vides ; valeurs en trop → refus', async () => {
  let res = await post('/items/new', [['name', 'Premier'], ['name', 'Second'], ['notes', 'a'], ['notes', 'b'],
    ['prop_key', 'A'], ['prop_key', 'B'], ['prop_key', 'C'], ['prop_value', '1']]);
  assert.equal(res.status, 303);
  const row = db.prepare('SELECT name, notes, properties FROM items WHERE id = ?').get(idFrom(res));
  assert.deepEqual({ ...row }, { name: 'Premier', notes: 'a', properties: '{"A":"1","B":"","C":""}' });

  const before = snapshot();
  res = await post('/items/new', [['name', 'Valeurs en trop'], ['prop_key', 'A'], ['prop_value', '1'], ['prop_value', '2']]);
  assert.equal(res.status, 400);
  assert.match(res.body, /une valeur seule ne suffit pas/);
  res = await post('/items/new', [['notes', 'sans nom']]);
  assert.equal(res.status, 400);
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- corps et Content-Type

test('Content-Type invalide sur chaque envoi d\'édition → 400 sans écriture ; casse et guillemets du charset UTF-8 tolérés', async () => {
  const id = await create('Cible Content-Type');
  const routes = [['/items/new', itemFields('x')], [`/items/${id}/edit`, itemFields('x')], [`/items/${id}/delete`, []], [`/items/${id}/location`, [['station', String(stationA)]]]];
  const before = snapshot();
  for (const [path, fields] of routes) {
    for (const contentType of ['text/plain', 'application/json', 'multipart/form-data; boundary=x', 'application/x-www-form-urlencoded; charset=iso-8859-1', '']) {
      const res = await post(path, fields, { contentType });
      assert.equal(res.status, 400, `${path} avec « ${contentType} »`);
    }
  }
  assert.equal(snapshot(), before);
  const res = await post(`/items/${id}/edit`, itemFields('Cible renommée'), { contentType: 'Application/X-WWW-Form-URLEncoded; Charset="UTF-8"' });
  assert.equal(res.status, 303);
});

test('corps exactement au plafond : traité ; plafond + 1 octet envoyé en chunked (sans Content-Length) → 413 sans écriture', async () => {
  const body = (size) => {
    const head = `csrf=${alice.csrf}&name=x&notes=`;
    return head + 'a'.repeat(size - head.length);
  };
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `__Host-mt_session=${alice.token}`, Origin: origin };
  const before = snapshot();
  let res = await send({ method: 'POST', path: '/items/new', headers, body: body(MAX_EDIT_FORM_BYTES) });
  assert.equal(res.status, 400, 'lu et validé (notes trop longues), pas 413');
  assert.match(res.body, /Les notes ne doivent pas dépasser/);
  // 413, ou connexion coupée si le serveur ferme pendant que le client écrit encore (coupure.js).
  const over = await statusOrCut(send({ method: 'POST', path: '/items/new', headers, body: body(MAX_EDIT_FORM_BYTES + 1), chunked: true }));
  assert.ok([413, CUT].includes(over), String(over));
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- CSRF entre sessions

test('jeton CSRF valide mais dérivé d\'une autre session → 403 sur chaque envoi, sans écriture ni ligne d\'audit', async () => {
  const id = await create('Cible CSRF croisé');
  const before = snapshot();
  for (const [path, fields] of [['/items/new', itemFields('x')], [`/items/${id}/edit`, itemFields('x')], [`/items/${id}/delete`, []], [`/items/${id}/location`, [['station', String(stationA)]]]]) {
    const res = await post(path, fields, { user: alice, csrf: bob.csrf });
    assert.equal(res.status, 403, path);
  }
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- concurrence

test('10 modifications simultanées de la même fiche : toutes traitées, audit chaîné (avant = après précédent), état final = dernière ligne', async () => {
  const id = await create('Concurrente', '', [['N', '0']]);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    post(`/items/${id}/edit`, itemFields(`Concurrente ${i}`, `note ${i}`, [['N', String(i + 1)]]), { user: i % 2 ? bob : alice })));
  assert.deepEqual(results.map((r) => r.status), Array(10).fill(303));
  const updates = auditsFor(id).filter((a) => a.action === 'item.update');
  assert.equal(updates.length, 10);
  for (let i = 1; i < updates.length; i++) {
    assert.deepEqual(updates[i].details.name.before, updates[i - 1].details.name.after);
    assert.deepEqual(updates[i].details.properties.before, updates[i - 1].details.properties.after);
  }
  const final = db.prepare('SELECT name, notes, properties FROM items WHERE id = ?').get(id);
  const last = updates.at(-1).details;
  assert.equal(final.name, last.name.after);
  assert.equal(final.notes, last.notes.after);
  assert.deepEqual(JSON.parse(final.properties), last.properties.after);
});

test('deux suppressions simultanées : une 303, une 404, une seule ligne item.delete', async () => {
  const id = await create('Suppression concurrente');
  const results = await Promise.all([post(`/items/${id}/delete`, []), post(`/items/${id}/delete`, [], { user: bob })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [303, 404]);
  assert.equal(auditsFor(id).filter((a) => a.action === 'item.delete').length, 1);
});

test('suppression et modification simultanées : jamais de modification sans fiche ; audit terminé par la suppression', async () => {
  const id = await create('Course suppression');
  const [edit, del] = await Promise.all([post(`/items/${id}/edit`, itemFields('Course modifiée')), post(`/items/${id}/delete`, [])]);
  assert.equal(del.status, 303);
  assert.ok([303, 404].includes(edit.status));
  const actions = auditsFor(id).map((a) => a.action);
  assert.equal(actions.at(-1), 'item.delete');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(id).n, 0);
});

// ---------------------------------------------------------------- réutilisation des numéros

test('numéro de fiche jamais réutilisé (AUTOINCREMENT, D-014), même pour la plus récente : historique et audit propres à chaque fiche', async () => {
  const oldId = await create('Ancienne fiche');
  assert.equal(oldId, db.prepare('SELECT max(id) AS m FROM items').get().m);
  assert.equal((await post(`/items/${oldId}/edit`, itemFields('Ancienne fiche renommée'))).status, 303);
  assert.equal((await post(`/items/${oldId}/location`, [['station', String(stationA)]])).status, 303);
  assert.equal((await post(`/items/${oldId}/delete`, [])).status, 303);
  assert.equal((await page(`/items/${oldId}`)).status, 404, 'l\'ancien numéro reste introuvable');

  const newId = await create('Nouvelle fiche');
  assert.equal(newId, oldId + 1, 'numéro suivant, l\'ancien n\'est pas réattribué');
  assert.equal((await page(`/items/${oldId}`)).status, 404);
  const html = (await page(`/items/${newId}`)).body;
  assert.match(html, /etat-jamais">jamais localisé</);
  const history = html.slice(html.indexOf('titre-modifications'));
  assert.match(history, /Fiche créée/);
  assert.doesNotMatch(history, /renommée|Fiche modifiée|Emplacement corrigé|Fiche supprimée/);

  // Chaque entity_id désigne une seule fiche : la vie complète de l'ancienne, la création de la nouvelle.
  assert.deepEqual(auditsFor(oldId).map((a) => a.action), ['item.create', 'item.update', 'item.location_correct', 'item.delete']);
  assert.equal(auditsFor(oldId).at(-1).details.name, 'Ancienne fiche renommée', 'la ligne de suppression garde la fiche complète');
  assert.deepEqual(auditsFor(newId).map((a) => a.action), ['item.create']);
});

// ---------------------------------------------------------------- resoumission équivalente

test('resoumission équivalente après nettoyage (NFD, CRLF, invisibles, espaces de bord) : ?ok=inchange, aucune ligne d\'audit', async () => {
  const id = await create('Modèle étalon', 'Ligne 1\nLigne 2', [['Référence', 'Été']]);
  const nfd = (text) => text.normalize('NFD');
  const zwsp = String.fromCodePoint(0x200B);
  const before = snapshot();
  const res = await post(`/items/${id}/edit`, itemFields(
    ` ${nfd('Modèle')}${zwsp} étalon `, 'Ligne 1\r\nLigne 2', [[nfd('Référence'), `${nfd('Été')}${String.fromCodePoint(0xAD)}`]],
  ));
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/items/${id}?ok=inchange`);
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- ajout seul : variantes UPDATE OR ...

test('ajout seul : openDb active recursive_triggers ; UPDATE OR REPLACE et UPDATE OR IGNORE refusés sur scans, audit_log et location_corrections', async () => {
  assert.equal(db.prepare('PRAGMA recursive_triggers').get().recursive_triggers, 1);
  db.prepare("INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (77, ?, ?, ?)").run(stationA, Buffer.alloc(32, 7), NOW);
  db.prepare("INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (77, ?, 'C0FFEE01', 1, ?)").run(stationA, NOW);
  const id = await create('Ajout seul');
  assert.equal((await post(`/items/${id}/location`, [['station', String(stationA)]])).status, 303);
  const state = () => JSON.stringify(['scans', 'audit_log', 'location_corrections'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()));
  const before = state();
  for (const verb of ['UPDATE OR REPLACE', 'UPDATE OR IGNORE', 'UPDATE OR FAIL', 'UPDATE OR ROLLBACK']) {
    for (const [table, set] of [['scans', 'counter = 2'], ['audit_log', "action = 'falsifié'"], ['location_corrections', 'station_id = station_id']]) {
      assert.throws(() => db.exec(`${verb} ${table} SET ${set} WHERE id = (SELECT max(id) FROM ${table})`), /append-only/, `${verb} ${table}`);
    }
  }
  assert.equal(state(), before);
});
