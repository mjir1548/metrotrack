// Vérifications complémentaires de l'étape 6 (testeur), contre un vrai serveur HTTPS en processus :
// - nom et description de poste piégés (XSS STOCKÉ) : réaffichés échappés partout où le poste
//   apparaît (listes, fiches, formulaires, listes déroulantes, inventaire, page de clé) ;
// - bornes du nom (100) et de la description (1 000) comptées en unités UTF-16, emoji compris ;
// - concurrence : créations de lecteurs simultanées (numéros distincts, clé affichée = clé
//   stockée) ; trames envoyées pendant un remplacement de clé (aucun 500, état cohérent, aucun
//   scan de l'ancien lecteur après sa désactivation) ;
// - poste supprimé : seconde suppression → 404, numéro non réutilisé, poste supprimé forgé
//   dans « nouveau lecteur », « changer de poste » et « corriger la localisation » → 400 sans
//   écriture.
// Les sessions sont créées directement en base. Les tests s'enchaînent sur une même base.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-18T10:00:00.000Z';
const UID = '04A1B2C3D4E5F6';
const EMOJI = String.fromCodePoint(0x1f600); // 2 unités UTF-16
let dir, db, server, port, certs, token, csrf, origin;
const logs = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-verif6-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?)").run(NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, NOW, NOW);
  const alice = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, NOW).lastInsertRowid);
  token = createSession(db, alice);
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
    if (body !== undefined) h['Content-Length'] = Buffer.byteLength(body);
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ path, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const page = (path) => send({ path, headers: { Cookie: `__Host-mt_session=${token}` } });
function post(path, fields = {}) {
  const params = new URLSearchParams(Object.entries(fields));
  params.append('csrf', csrf);
  return send({
    method: 'POST', path, body: params.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, Cookie: `__Host-mt_session=${token}` },
  });
}
const postFrame = (readerId, counter, key, uid = UID) => send({
  method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
  body: encodeFrame({ readerId, counter, uid: Buffer.from(uid, 'hex'), key }),
});
function keyFrom(res) {
  const match = /<pre class="cle">([0-9a-f]{64})<\/pre>/.exec(res.body);
  return match ? match[1] : null;
}
const storedKeyHex = (id) => Buffer.from(db.prepare('SELECT aead_key FROM readers WHERE id = ?').get(id).aead_key).toString('hex');
const maxReaderId = () => db.prepare('SELECT coalesce(max(id), 0) AS m FROM readers').get().m;
const snapshot = () => JSON.stringify(['stations', 'readers', 'audit_log', 'scans', 'location_corrections', 'items']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const noInternalError = () => assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));

/** Crée un poste par l'interface ; renvoie son numéro. */
async function createStation(name, description = '') {
  const res = await post('/stations/new', { name, description });
  assert.equal(res.status, 303, `création de « ${name} »`);
  return Number(/^\/stations\/(\d+)\?ok=cree$/.exec(res.headers.location)[1]);
}

/** Crée un lecteur par l'interface ; renvoie {id, key (Buffer), res}. */
async function createReader(stationId) {
  const res = await post('/readers/new', { station: String(stationId) });
  assert.equal(res.status, 200);
  const hex = keyFrom(res);
  assert.ok(hex, 'clé affichée');
  const id = maxReaderId();
  assert.equal(storedKeyHex(id), hex, 'clé affichée = clé stockée');
  return { id, key: Buffer.from(hex, 'hex'), res };
}

// ---------------------------------------------------------------- XSS stocké

test('poste au nom et à la description piégés : réaffiché échappé sur toutes les pages où il apparaît', async () => {
  const name = '<script>alert(1)</script>"\'&amp;<b>x';
  const description = '<img src=x onerror=alert(2)>\n"><svg/onload=alert(3)>';
  const escapedName = '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;amp;&lt;b&gt;x';
  const st = await createStation(name, description);
  const { id: reader, key, res: keyPage } = await createReader(st);
  assert.equal((await postFrame(reader, 1, key)).status, 204);

  const pages = [keyPage];
  for (const path of ['/', '/items/1', '/items/1/location', '/stations', `/stations/${st}`, `/stations/${st}/edit`, `/stations/${st}/delete`,
    '/readers', '/readers/new', `/readers/${reader}`, `/readers/${reader}/station`, `/readers/${reader}/replace`, `/readers/${reader}/deactivate`]) {
    const res = await page(path);
    assert.equal(res.status, 200, path);
    pages.push(res);
  }
  for (const res of pages) {
    const where = res.path ?? 'page de clé';
    assert.ok(res.body.includes(escapedName), `${where} : nom affiché échappé`);
    // Icônes du gabarit retirées d'abord (sprite et <svg><use> décoratifs, étape U1) : tout autre
    // <svg> serait une injection.
    const body = res.body
      .replace(/^<svg class="sprite" aria-hidden="true">\n(?:<symbol id="i-[a-z]+" [^\n]*<\/symbol>\n)*<\/svg>$/m, '')
      .replace(/<svg class="ic" aria-hidden="true"><use href="#i-[a-z]+"><\/use><\/svg>/g, '')
      .replace(/<svg class="logo-image" viewBox="0 0 900 900" aria-hidden="true">[\s\S]*?<\/svg>/g, '');
    for (const raw of ['<script', '<img', '<svg', '<b>']) {
      assert.ok(!body.includes(raw), `${where} : « ${raw} » non échappé`);
    }
    // Attribut d'événement dans une vraie balise (le texte échappé « onerror= » est inoffensif).
    assert.doesNotMatch(res.body, /<[^>]*\son[a-z]+\s*=/i, `${where} : attribut d'événement injecté`);
  }
  // Description : sur la fiche du poste, sur son formulaire et dans la liste.
  for (const res of pages.filter((r) => r.path === `/stations/${st}` || r.path === `/stations/${st}/edit` || r.path === '/stations')) {
    assert.ok(res.body.includes('&lt;img src=x onerror=alert(2)&gt;'), `${res.path} : description échappée`);
  }
  // Listes déroulantes : l'option du poste porte son numéro et son nom échappé.
  for (const path of ['/items/1/location', '/readers/new', `/readers/${reader}/station`]) {
    const res = pages.slice(1).find((r) => r.path === path); // pages[0] : page de clé (POST /readers/new)
    assert.match(res.body, new RegExp(`<option value="${st}"[^>]*>${escapedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</option>`), path);
  }
  noInternalError();
});

// ---------------------------------------------------------------- bornes UTF-16

test('bornes en unités UTF-16, emoji compris : nom 100, description 1 000', async () => {
  const before = snapshot();
  const tooLongName = await post('/stations/new', { name: EMOJI.repeat(50) + 'x' });
  assert.equal(tooLongName.status, 400);
  assert.ok(tooLongName.body.includes('Le nom ne doit pas dépasser 100 caractères (101 saisis).'));
  const tooLongDesc = await post('/stations/new', { name: 'Desc emoji', description: EMOJI.repeat(500) + 'x' });
  assert.equal(tooLongDesc.status, 400);
  assert.ok(tooLongDesc.body.includes('id="description-erreur"'));
  assert.equal(snapshot(), before, 'aucune écriture');
  const st = await createStation(EMOJI.repeat(50), EMOJI.repeat(500));
  const row = db.prepare('SELECT name, description FROM stations WHERE id = ?').get(st);
  assert.equal(row.name.length, 100);
  assert.equal(row.description.length, 1000);
  // Renommage au-delà de la borne : refusé, poste inchangé.
  const edit = await post(`/stations/${st}/edit`, { name: EMOJI.repeat(51), description: '' });
  assert.equal(edit.status, 400);
  assert.equal(db.prepare('SELECT name FROM stations WHERE id = ?').get(st).name, EMOJI.repeat(50));
});

// ---------------------------------------------------------------- concurrence

test('créations de lecteurs simultanées : numéros distincts et consécutifs, chaque clé affichée = clé stockée, un audit chacun', async () => {
  const first = maxReaderId() + 1;
  const auditsBefore = db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'reader.create'").get().n;
  const responses = await Promise.all(Array.from({ length: 8 }, () => post('/readers/new', { station: '1' })));
  assert.deepEqual(responses.map((r) => r.status), Array(8).fill(200));
  const keys = responses.map(keyFrom);
  assert.equal(new Set(keys).size, 8, 'clés distinctes');
  const rows = db.prepare('SELECT id, active, station_id FROM readers WHERE id >= ? ORDER BY id').all(first);
  assert.deepEqual(rows.map((r) => r.id), Array.from({ length: 8 }, (_, i) => first + i));
  assert.ok(rows.every((r) => r.active === 1 && r.station_id === 1));
  const stored = new Set(rows.map((r) => storedKeyHex(r.id)));
  for (const k of keys) assert.ok(stored.has(k), 'clé affichée présente en base');
  assert.equal(db.prepare("SELECT count(*) AS n FROM audit_log WHERE action = 'reader.create'").get().n, auditsBefore + 8);
  noInternalError();
});

test('trames envoyées pendant un remplacement de clé : aucun 500, un seul remplacement, aucun scan de l\'ancien lecteur après sa désactivation', async () => {
  const { id: old, key } = await createReader(1);
  const jobs = Array.from({ length: 30 }, (_, i) => postFrame(old, i + 1, key));
  jobs.splice(10, 0, post(`/readers/${old}/replace`));
  jobs.splice(20, 0, post(`/readers/${old}/replace`));
  const out = await Promise.all(jobs);
  const statuses = out.map((r) => r.status);
  assert.ok(statuses.every((s) => [200, 204, 400, 409].includes(s)), statuses.join(' '));
  const replaces = out.filter((r) => r.path === `/readers/${old}/replace`);
  assert.deepEqual(replaces.map((r) => r.status).sort(), [200, 409], 'un remplacement réussi, le second refusé');
  assert.equal(replaces.filter((r) => keyFrom(r)).length, 1, 'une seule clé affichée');

  const audit = db.prepare("SELECT at, details FROM audit_log WHERE action = 'reader.replace' AND entity_id = ?").all(old);
  assert.equal(audit.length, 1);
  const { new_id: newId } = JSON.parse(audit[0].details);
  assert.equal(db.prepare('SELECT active FROM readers WHERE id = ?').get(old).active, 0);
  assert.deepEqual({ ...db.prepare('SELECT active, station_id FROM readers WHERE id = ?').get(newId) }, { active: 1, station_id: 1 });
  assert.equal(storedKeyHex(newId), keyFrom(replaces.find((r) => r.status === 200)));

  const scans = db.prepare('SELECT counter, received_at FROM scans WHERE reader_id = ? ORDER BY counter').all(old);
  const accepted = out.filter((r) => r.path === '/api/frames' && r.status === 204).length;
  assert.equal(scans.length, accepted, 'un scan par trame acceptée');
  assert.ok(scans.every((s) => s.received_at <= audit[0].at), 'aucun scan reçu après le remplacement');
  // Après coup : ancien lecteur refusé, même avec un compteur neuf ; nouveau lecteur accepté avec la nouvelle clé seulement.
  assert.equal((await postFrame(old, 1000, key)).status, 400);
  assert.equal((await postFrame(newId, 1, key)).status, 400, 'ancienne clé refusée sous le nouveau numéro');
  const newKey = Buffer.from(storedKeyHex(newId), 'hex');
  assert.equal((await postFrame(newId, 1, newKey)).status, 204);
  noInternalError();
});

// ---------------------------------------------------------------- poste supprimé

test('poste supprimé : seconde suppression → 404, numéro non réutilisé, numéro forgé refusé (400) sans écriture', async () => {
  const st = await createStation('Éphémère');
  assert.equal((await post(`/stations/${st}/delete`)).status, 303);
  assert.equal((await post(`/stations/${st}/delete`)).status, 404, 'seconde suppression');
  assert.equal((await page(`/stations/${st}`)).status, 404);
  assert.equal((await page(`/stations/${st}/edit`)).status, 404);
  assert.equal((await post(`/stations/${st}/edit`, { name: 'Résurrection', description: '' })).status, 404);

  const before = snapshot();
  const forged = await post('/readers/new', { station: String(st) });
  assert.equal(forged.status, 400);
  assert.equal(keyFrom(forged), null, 'aucune clé');
  const reader = maxReaderId();
  assert.equal((await post(`/readers/${reader}/station`, { station: String(st) })).status, 400);
  assert.equal((await post('/items/1/location', { station: String(st) })).status, 400);
  assert.equal(snapshot(), before, 'aucune écriture');

  const next = await createStation('Suivant');
  assert.equal(next, st + 1, 'numéro du poste supprimé non réutilisé');
  noInternalError();
});
