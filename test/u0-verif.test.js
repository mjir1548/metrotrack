// Vérification de l'étape U0 par le testeur, contre un vrai serveur HTTPS (createFrameServer) :
//   1. « Depuis » de bout en bout : scans reçus par POST /api/frames (trames AEAD réelles),
//      correction et changement de puce par les formulaires ; affichage vérifié dans la liste,
//      la fiche de l'objet et la fiche du poste ;
//   2. erreur interne RÉELLE (base verrouillée par une autre connexion, SQLITE_BUSY) : page 500
//      lisible côté web, réponse vide côté /api/frames, le serveur continue ;
//   3. pages d'erreur : rien de l'URL ni du corps n'est reflété, connecté ou non ;
//   4. connexion expirée : identifiants limites (64 caractères au format : réaffiché ; Origin
//      en http:// : refusé) ;
//   5. remontée bornée (MAX_RUN_SCANS) : « au moins » dans la liste, la fiche et le poste, puis
//      retour au calcul exact après un scan ailleurs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { hashPassword, argon2Stats } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { MAX_RUN_SCANS } from '../server/inventory.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-25T10:00:00.000Z';
const PASSWORD = 'Un-mot-de-passe-solide-42';
const KEYS = { 1: Buffer.alloc(32, 0x11), 2: Buffer.alloc(32, 0x22), 3: Buffer.alloc(32, 0x33) };
const UID = '04A1B2C3D4E5F6';
const NEW_UID = '0A0B0C0D';
const MARK = 'ZQXW'; // marqueur : ne doit jamais réapparaître dans une page d'erreur
let dir, dbPath, db, server, port, certs, origin, session;
const counters = { 1: 0, 2: 0, 3: 0 };
const logs = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u0v-'));
  certs = makeTestCerts(dir);
  dbPath = join(dir, 'test.db');
  db = openDb(dbPath);
  // Attente d'un verrou ramenée de 5 s à 200 ms : le test du verrou reste court.
  db.exec('PRAGMA busy_timeout = 200');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste A', ?), (2, 'Poste B', ?)").run(NOW, NOW);
  // Lecteur 1 → poste A, 2 → poste B, 3 → non affecté.
  for (const [id, station] of [[1, 1], [2, 2], [3, null]]) {
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (?, ?, ?, ?)').run(id, station, KEYS[id], NOW);
  }
  const userId = db.prepare("INSERT INTO users (username, password_hash, active, created_at) VALUES ('alice', ?, 1, ?)")
    .run(await hashPassword(PASSWORD), NOW).lastInsertRowid;
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Oscilloscope', ?, ?)").run(UID, NOW, NOW);
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
const FORM_TYPE = { 'Content-Type': 'application/x-www-form-urlencoded' };
const withSession = (headers = {}) => ({ ...headers, Cookie: `__Host-mt_session=${session}` });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Envoi de formulaire avec session ; attend 3 ms ensuite pour que l'événement suivant ait une heure distincte. */
async function postForm(path, fields) {
  const res = await send({
    method: 'POST', path, headers: withSession({ ...FORM_TYPE, Origin: origin }),
    body: new URLSearchParams({ csrf: csrfTokenFor(session), ...fields }).toString(),
  });
  await sleep(3);
  return res;
}

/** Scan reçu par le vrai point d'entrée des boîtiers ; attend 3 ms pour des heures distinctes. */
async function scan(readerId, uid = UID) {
  const frame = encodeFrame({ readerId, counter: ++counters[readerId], uid: Buffer.from(uid, 'hex'), key: KEYS[readerId] });
  const res = await send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body: frame });
  assert.equal(res.status, 204, `scan lecteur ${readerId}`);
  await sleep(3);
}
const lastScanAt = (uid = UID) => db.prepare('SELECT received_at FROM scans WHERE uid_nfc = ? ORDER BY received_at DESC, id DESC').get(uid).received_at;
const lastCorrectionAt = () => db.prepare('SELECT created_at FROM location_corrections WHERE item_id = 1 ORDER BY id DESC').get().created_at;

/** « Depuis » affiché dans une ligne de tableau (liste ou fiche du poste), ou null si l'objet n'y est pas. */
function depuisIn(html, name) {
  const row = html.split('<tr>').find((r) => r.includes(`>${name}</a>`));
  if (row === undefined) return null;
  return /<td data-label="Depuis"><time datetime="([^"]+)"/.exec(row)?.[1] ?? 'sans heure';
}
// Ligne « depuis » de la fiche (étape U3 : « depuis … · jour », puis UN badge « Scanné <heure> »
// ou « Corrigé à la main par … »), ramenée à la forme texte qu'attendent ces tests :
// « <arrivée> · scanné » (le dernier scan est l'arrivée), « <arrivée> · dernier scan <heure> »,
// ou « <arrivée> · correction manuelle par … ».
function detailText(inner) {
  const m = /^<span>(<time datetime="([^"]+)"[^>]*>[^<]*<\/time>)(?: · [^<]*)?<\/span>([\s\S]*)$/.exec(inner);
  if (!m) return inner;
  const [, arrival, arrivedAt, badge] = m;
  const scanned = /^<span class="badge badge--ok">[\s\S]*?Scanné (<time datetime="([^"]+)"[^>]*>[^<]*<\/time>)<\/span>$/.exec(badge);
  if (scanned) return scanned[2] === arrivedAt ? `${arrival} · scanné` : `${arrival} · dernier scan ${scanned[1]}`;
  const manual = /Corrigé à la main (par [^<]*)<\/span>$/.exec(badge);
  return manual ? `${arrival} · correction manuelle ${manual[1]}` : inner;
}
async function shown() {
  const list = (await send({ path: '/', headers: withSession() })).body;
  const sheet = (await send({ path: '/items/1', headers: withSession() })).body;
  const stationA = (await send({ path: '/stations/1', headers: withSession() })).body;
  const stationB = (await send({ path: '/stations/2', headers: withSession() })).body;
  const detail = /<p class="localisation-detail">(.*?)<\/p>/s.exec(sheet)?.[1] === undefined ? null : detailText(/<p class="localisation-detail">(.*?)<\/p>/s.exec(sheet)[1]).replace(/ title="[^"]*"/g, '').replace(/^Depuis : /, '').replace(/<\/time> — [^<·]*?(?= · |$)/, '</time>') ?? null; // « Depuis : » : étape U1 ; « — aujourd'hui à … » : étape U2
  return { list: depuisIn(list, 'Oscilloscope'), A: depuisIn(stationA, 'Oscilloscope'), B: depuisIn(stationB, 'Oscilloscope'), detail };
}
const t = (iso) => `<time datetime="${iso}">`;

// ---------------------------------------------------------------- 1. « Depuis » de bout en bout

test('« Depuis » de bout en bout : A → B → B, A → B → A, correction puis scans, non affecté, changement de puce', async () => {
  // A → B → B : arrivée = premier scan en B ; la fiche ajoute l'heure du dernier scan.
  await scan(1);
  await scan(2);
  const firstB = lastScanAt();
  await scan(2);
  let s = await shown();
  assert.equal(s.list, firstB, 'liste');
  assert.equal(s.B, firstB, 'fiche du poste B');
  assert.equal(s.A, null, 'absent du poste A');
  assert.ok(s.detail.startsWith(t(firstB)), s.detail);
  assert.ok(s.detail.includes(` · dernier scan ${t(lastScanAt())}`), s.detail); // étape U1 : sans numéro de lecteur

  // A → B → A : arrivée = retour en A (pas le premier passage).
  await scan(1);
  s = await shown();
  assert.equal(s.list, lastScanAt());
  assert.equal(s.A, lastScanAt());
  assert.equal(s.B, null);
  assert.match(s.detail, /^<time datetime="[^"]+">[^<]*<\/time> · scanné$/);

  // Correction vers B par le formulaire, puis scans au poste B : arrivée = correction.
  assert.equal((await postForm('/items/1/location', { station: '2' })).status, 303);
  const corrected = lastCorrectionAt();
  s = await shown();
  assert.equal(s.list, corrected);
  assert.equal(s.B, corrected);
  assert.match(s.detail, /^<time datetime="[^"]+">[^<]*<\/time> · correction manuelle par alice$/);
  await scan(2);
  await scan(2);
  s = await shown();
  assert.equal(s.list, corrected, 'scans après la correction, même poste : arrivée inchangée');
  assert.equal(s.B, corrected);
  assert.ok(s.detail.startsWith(t(corrected)) && s.detail.includes(`dernier scan ${t(lastScanAt())}`), s.detail);
  // Nouvelle correction vers le même poste : la série continue ; la fiche le dit.
  assert.equal((await postForm('/items/1/location', { station: '2' })).status, 303);
  s = await shown();
  assert.equal(s.list, corrected);
  // Étape U3 : l'en-tête ne donne plus l'heure de la dernière correction, seulement son auteur.
  assert.ok(s.detail.startsWith(t(corrected)) && s.detail.endsWith(' · correction manuelle par alice'), s.detail);

  // Lecteur non affecté : emplacement à part entière.
  await scan(3);
  const firstNone = lastScanAt();
  await scan(3);
  s = await shown();
  assert.equal(s.list, firstNone);
  assert.equal(s.A, null);
  assert.equal(s.B, null);
  await scan(2);
  s = await shown();
  assert.equal(s.list, lastScanAt(), 'retour en B : nouvelle arrivée');
  assert.equal(s.B, lastScanAt());

  // Changement de puce : la nouvelle puce (scannée en A puis B) remplace l'ancienne ; seuls
  // ses scans et les corrections comptent.
  await scan(1, NEW_UID);
  await scan(2, NEW_UID);
  const res = await postForm(`/chips/${NEW_UID}/associate/1`, { previous: UID });
  assert.equal(res.status, 303, res.body);
  assert.equal(res.headers.location, '/items/1?ok=puce_remplacee');
  s = await shown();
  // Événements restants : corrections vers B (anciennes), scan A puis scan B de la nouvelle puce.
  assert.equal(s.list, lastScanAt(NEW_UID));
  assert.equal(s.B, lastScanAt(NEW_UID));
  assert.match(s.detail, /^<time datetime="[^"]+">[^<]*<\/time> · scanné$/);
  // L'ancienne puce, scannée ailleurs, ne déplace plus l'objet (elle devient une puce inconnue).
  await scan(1, UID);
  s = await shown();
  assert.equal(s.B, lastScanAt(NEW_UID));
  assert.equal(s.A, null);
});

// ---------------------------------------------------------------- 2. erreur interne réelle

test('base verrouillée par une autre connexion (SQLITE_BUSY) : page 500 lisible côté web, 500 vide côté boîtiers, le serveur continue', async () => {
  const other = new DatabaseSync(dbPath);
  other.exec('PRAGMA busy_timeout = 2000');
  other.exec('BEGIN IMMEDIATE');
  other.exec(`INSERT INTO stations (name, created_at) VALUES ('${MARK}-verrou', '${NOW}')`);
  try {
    const web = await postForm('/items/new', { name: `${MARK}-fiche` });
    assert.equal(web.status, 500);
    assert.equal(web.headers.connection, 'close');
    assert.equal(web.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(web.headers['content-security-policy'], "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    assert.equal(web.headers['set-cookie'], undefined);
    assert.equal(web.headers.location, undefined);
    assert.ok(web.body.includes('<h1>Un problème est survenu</h1>'));
    assert.ok(web.body.includes('Revenir à l\'inventaire'));
    assert.ok(!web.body.includes(MARK) && !/locked|busy|sqlite/i.test(web.body), 'aucun détail technique ni donnée reçue');

    const frame = encodeFrame({ readerId: 1, counter: ++counters[1], uid: Buffer.from(UID, 'hex'), key: KEYS[1] });
    const box = await send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body: frame });
    assert.equal(box.status, 500);
    assert.equal(box.body, '');
    assert.equal(box.headers['content-type'], undefined);
    assert.equal(box.headers.connection, 'close');
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
  assert.ok(logs.some((l) => l.includes('erreur interne')), 'la cause est au journal');
  // Verrou levé : tout refonctionne, la trame refusée peut être renvoyée avec un compteur neuf.
  assert.equal((await postForm('/items/new', { name: 'Après le verrou' })).status, 303);
  await scan(1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items WHERE name LIKE ?').get(`${MARK}%`).n, 0, 'rien écrit pendant le verrou');
});

// ---------------------------------------------------------------- 3. aucun reflet

test('pages d\'erreur : ni l\'URL, ni la requête, ni le corps ne sont reflétés (connecté ou non)', async () => {
  const cases = [
    [404, { path: `/${MARK}%3Cb%3E?q=${MARK}` }],
    [404, { path: `/items/1/${MARK}` }],
    [405, { method: 'PUT', path: `/?${MARK}=1`, body: MARK }],
    [405, { path: `/logout?${MARK}` }],
    [400, { method: 'POST', path: `/login?${MARK}`, headers: { 'Content-Type': `text/${MARK}`, Origin: origin }, body: `username=${MARK}` }],
    [400, { method: 'POST', path: '/login', headers: { 'Content-Type': `application/x-www-form-urlencoded; charset=${MARK}`, Origin: origin }, body: `username=${MARK}` }],
  ];
  for (const connected of [false, true]) {
    for (const [status, req] of cases) {
      const res = await send({ ...req, headers: connected ? withSession(req.headers) : req.headers });
      const what = `${status} ${req.method ?? 'GET'} ${req.path} (${connected ? 'connecté' : 'anonyme'})`;
      assert.equal(res.status, status, what);
      assert.ok(res.body.startsWith('<!doctype html>'), what);
      assert.ok(!res.body.includes(MARK), `${what} : reflet`);
      assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
      assert.equal(res.headers['cache-control'], 'no-store', what);
      assert.ok(res.body.includes(connected ? 'href="/">Revenir à l\'inventaire' : 'href="/login">Se connecter'), what);
    }
  }
});

// ---------------------------------------------------------------- 4. connexion expirée : limites

test('connexion expirée : identifiant de 64 caractères au format réaffiché ; Origin en http:// ou d\'un autre port refusé (403)', async () => {
  const startedBefore = argon2Stats().started;
  const long = `a.b_c-${'x'.repeat(58)}`;
  const res = await send({
    method: 'POST', path: '/login', headers: { ...FORM_TYPE, Origin: origin },
    body: new URLSearchParams({ csrf: 'A'.repeat(43), username: long, password: 'quelconque' }).toString(),
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(`<input id="username" name="username" value="${long}"`));
  for (const bad of [`http://127.0.0.1:${port}`, 'https://127.0.0.1:1', `https://localhost:${port}`]) {
    const refused = await send({
      method: 'POST', path: '/login', headers: { ...FORM_TYPE, Origin: bad },
      body: new URLSearchParams({ csrf: 'A'.repeat(43), username: 'alice', password: PASSWORD }).toString(),
    });
    assert.equal(refused.status, 403, bad);
    assert.ok(refused.body.includes('<h1>Action refusée</h1>'), bad);
  }
  assert.equal(argon2Stats().started, startedBefore, 'aucun calcul argon2');
});

// ---------------------------------------------------------------- 5. remontée bornée (aller-retour 2)

test('puce rescannée plus de MAX_RUN_SCANS fois au même poste : « au moins » (liste, poste) et « depuis au moins » (fiche), date exacte au survol ; un scan ailleurs redonne l\'heure exacte', async () => {
  const uid = 'BB000001';
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (100, ?, 'Sonde fixe', ?, ?)").run(uid, NOW, NOW);
  await scan(2, uid); // départ : poste B
  // MAX_RUN_SCANS + 50 scans au poste A, insérés comme le fait ingestFrame (poste du lecteur figé).
  const insert = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, ?, ?, ?)');
  const base = Date.now();
  db.exec('BEGIN');
  for (let k = 0; k < MAX_RUN_SCANS + 50; k++) insert.run(uid, ++counters[1], new Date(base + 1 + k).toISOString());
  db.exec('COMMIT');
  await sleep(Math.max(0, base + MAX_RUN_SCANS + 60 - Date.now())); // attendre que ces heures (futures) soient passées
  const oldestExamined = db.prepare('SELECT received_at FROM scans WHERE uid_nfc = ? ORDER BY received_at DESC, id DESC LIMIT 1 OFFSET ?').get(uid, MAX_RUN_SCANS - 1).received_at;
  const cell = (html) => /<td data-label="Depuis">(.*?)<\/td>/s.exec(html.split('<tr>').find((r) => r.includes('>Sonde fixe</a>')) ?? '')?.[1] ?? null;
  const pages = async () => ({
    list: cell((await send({ path: '/', headers: withSession() })).body),
    post: cell((await send({ path: '/stations/1', headers: withSession() })).body),
    sheet: detailText(/<p class="localisation-detail">(.*?)<\/p>/s.exec((await send({ path: '/items/100', headers: withSession() })).body)?.[1] ?? ''),
  });
  // Étape U2 : « depuis au moins … » dans la balise <time>.
  const bounded = () => new RegExp(`^<time datetime="${oldestExamined}" title="[^"]+">depuis au moins `);
  let p = await pages();
  assert.match(p.list, bounded('au moins'), p.list);
  assert.match(p.post, bounded('au moins'), p.post);
  assert.ok(!p.post.includes('(correction)'), p.post);
  assert.match(p.sheet, bounded(), p.sheet);
  assert.ok(p.sheet.includes(' · dernier scan <time'), p.sheet);
  // Correction vers le poste où l'objet est déjà : toujours « au moins », sans « (correction) ».
  assert.equal((await postForm('/items/100/location', { station: '1' })).status, 303);
  p = await pages();
  assert.match(p.list, bounded('au moins'), p.list);
  assert.ok(!p.post.includes('(correction)'), p.post);
  assert.ok(p.sheet.includes('correction manuelle par alice'), p.sheet);
  // Un scan ailleurs (par le vrai point d'entrée) : calcul exact.
  await scan(2, uid);
  const elsewhere = lastScanAt(uid);
  const listB = cell((await send({ path: '/', headers: withSession() })).body);
  assert.match(listB, new RegExp(`^<time datetime="${elsewhere}"`), listB);
  assert.equal(cell((await send({ path: '/stations/1', headers: withSession() })).body), null, 'plus au poste A');
  // Retour en A : exact (le scan en B est dans la fenêtre examinée).
  await scan(1, uid);
  const back = lastScanAt(uid);
  await scan(1, uid);
  p = await pages();
  assert.match(p.list, new RegExp(`^<time datetime="${back}"`), p.list);
  assert.match(p.sheet, new RegExp(`^<time datetime="${back}"[^>]*>(?:depuis [^<]*|à l&#39;instant)</time> · dernier scan `), p.sheet); // étape U3 : « à l'instant » sous une minute
});
