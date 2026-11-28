// Vérification des étapes U5 (puces inconnues) et U6 (postes et lecteurs) par le testeur :
// cas limites côté serveur de ce que l'interface envoie réellement (création en ligne depuis une
// carte, ajout et renommage de poste en ligne, suppression, lecteurs, page de clé), en HTTPS réel.
// Le comportement dans le navigateur (direct, focus, panneaux) est vérifié à part dans Edge.
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
import { listStationSummaries } from '../server/stations.js';
import { SILENT_READER_MS } from '../server/accueil.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, certs, db, server, port, token, csrf;
const KEY = Buffer.alloc(32, 0x3c);
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const counters = new Map();
const ZW = String.fromCodePoint(0x200b); // espace sans chasse (invisible)

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u5u6v-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const user = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('testeur', DUMMY_HASH, iso(0)).lastInsertRowid);
  // Postes : 1 Réception, 2 Banc, 3 Magasin (description), 4 Vierge (aucun historique).
  for (const [id, name, description] of [[1, 'Réception', ''], [2, 'Banc', ''], [3, 'Magasin', 'Étagère du fond'], [4, 'Vierge', '']]) {
    db.prepare('INSERT INTO stations (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(id, name, description, iso(86_400_000 * 10));
  }
  // Lecteurs : 1 (Réception), 2 (Banc), 3 (non affecté), 4 (Banc, désactivé).
  for (const [id, station, active] of [[1, 1, 1], [2, 2, 1], [3, null, 1], [4, 2, 0]]) {
    db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (?, ?, ?, ?, ?)').run(id, station, KEY, active, iso(86_400_000 * 10));
  }
  token = createSession(db, user);
  csrf = csrfTokenFor(token);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve();
  }));
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function send({ method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const page = (path, session = token) => send({ path, headers: { Cookie: `__Host-mt_session=${session}` } });
// Envoi comme le navigateur (formulaire ou fetch d'app.js : même origine, jeton CSRF de la page).
function post(path, fields, { session = token, withCsrf = true } = {}) {
  const body = new URLSearchParams(withCsrf ? { ...fields, csrf } : fields).toString();
  const headers = { Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) };
  if (session !== null) headers.Cookie = `__Host-mt_session=${session}`;
  return send({ method: 'POST', path, body, headers });
}
function frame(readerId, uid) {
  const counter = (counters.get(readerId) ?? 0) + 1;
  counters.set(readerId, counter);
  return send({
    method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
    body: encodeFrame({ readerId, counter, uid: Buffer.from(uid, 'hex'), key: KEY }),
  });
}
const itemsNamed = (name) => db.prepare('SELECT count(*) AS n FROM items WHERE name = ?').get(name).n;
const auditCount = () => db.prepare('SELECT count(*) AS n FROM audit_log').get().n;
/** Événements du direct publiés pendant fn. */
async function captureEvents(fn) {
  const events = [];
  const hub = server.direct;
  const publish = hub.publish.bind(hub);
  hub.publish = (event) => { events.push(event); publish(event); };
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 30)); // publication après la réponse 204 au boîtier
  } finally {
    hub.publish = publish;
  }
  return events;
}

// ---------------------------------------------------------------- U5 : création en ligne

test('U5 création en ligne : nom fait seulement de caractères invisibles → 400, aucune fiche, puce toujours inconnue', async () => {
  assert.equal((await frame(1, 'D0000001')).status, 204);
  const before = auditCount();
  const res = await post('/chips/D0000001/new', { name: `${ZW}${ZW} ${ZW}` });
  assert.equal(res.status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM items WHERE uid_nfc = 'D0000001'").get().n, 0);
  assert.equal(auditCount(), before);
  assert.ok((await page('/chips')).body.includes('data-uid="D0000001"'));
});

test('U5 création en ligne : session absente ou expirée → /login (app.js : « Votre session a expiré »), rien n\'est créé', async () => {
  const none = await post('/chips/D0000001/new', { name: 'Sans session' }, { session: null });
  assert.equal(none.status, 303);
  assert.equal(new URL(none.headers.location, 'https://x').pathname, '/login');
  const expired = createSession(db, 1, NOW - 9 * 3_600_000); // au-delà des 8 h
  const late = await post('/chips/D0000001/new', { name: 'Session expirée' }, { session: expired });
  assert.equal(late.status, 303);
  assert.equal(new URL(late.headers.location, 'https://x').pathname, '/login', 'app.js compare le chemin seul');
  assert.equal(itemsNamed('Sans session') + itemsNamed('Session expirée'), 0);
});

test('U5 création en ligne : jeton CSRF absent ou faux → 403 (app.js : « La page a expiré »), rien n\'est créé', async () => {
  assert.equal((await post('/chips/D0000001/new', { name: 'Sans jeton' }, { withCsrf: false })).status, 403);
  const forged = await post('/chips/D0000001/new', { name: 'Faux jeton', csrf: 'x'.repeat(43) }, { withCsrf: false });
  assert.equal(forged.status, 403);
  assert.equal(itemsNamed('Sans jeton') + itemsNamed('Faux jeton'), 0);
});

test('U5 création en ligne : 6 envois simultanés pour la même puce (double Entrée, deux écrans) → une seule fiche, les autres 409', async () => {
  assert.equal((await frame(2, 'D0000002')).status, 204);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post('/chips/D0000002/new', { name: `Rafale ${i}` })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [303, 409, 409, 409, 409, 409]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM items WHERE uid_nfc = 'D0000002'").get().n, 1);
  // La fiche créée est localisée au poste du scan (Banc).
  const id = Number(/^\/items\/(\d+)/.exec(results.find((r) => r.status === 303).headers.location)[1]);
  assert.ok((await page(`/items/${id}`)).body.includes('<span class="etat etat-poste">Banc</span>'));
});

test('U5 création en ligne : puce lue par un lecteur non affecté → fiche créée, sans poste ; carte « lecteur non affecté »', async () => {
  assert.equal((await frame(3, 'D0000003')).status, 204);
  const list = (await page('/chips')).body;
  const card = list.split('<li class="encart puce-carte"').find((c) => c.startsWith(' data-uid="D0000003"'));
  assert.ok(card.includes('data-poste="lecteur non affecté"'));
  assert.ok(card.includes('<a class="lien-simple" href="/readers/3">lecteur non affecté</a>'));
  const res = await post('/chips/D0000003/new', { name: 'Sonde sans poste' });
  assert.equal(res.status, 303);
  const location = db.prepare('SELECT station_id FROM item_locations WHERE item_id = (SELECT id FROM items WHERE uid_nfc = ?)').get('D0000003');
  assert.equal(location?.station_id ?? null, null);
});

test('U5 API /api/puces-inconnues : n strict (1 à 200, sans zéro en tête), sinon 400 ; sans session 401', async () => {
  for (const n of ['0', '007', '201', '1000', 'abc', '-1', '1.5', '']) assert.equal((await page(`/api/puces-inconnues?n=${n}`)).status, 400, `n=${n}`);
  for (const n of ['1', '200']) assert.equal((await page(`/api/puces-inconnues?n=${n}`)).status, 200, `n=${n}`);
  const anonymous = await send({ path: '/api/puces-inconnues?n=3' });
  assert.equal(anonymous.status, 401);
});

// ---------------------------------------------------------------- U6 : postes

test('U6 ajout en ligne : nom vide, invisible ou déjà pris (casse ignorée) → 400, rien n\'est créé ; retour=postes ne change pas la validation', async () => {
  const count = () => db.prepare('SELECT count(*) AS n FROM stations').get().n;
  const before = count();
  for (const name of ['', '   ', `${ZW}${ZW}`, 'magasin', ' MAGASIN ']) {
    const res = await post('/stations/new', { name, description: '', retour: 'postes' });
    assert.equal(res.status, 400, JSON.stringify(name));
  }
  assert.equal(count(), before);
  // retour inconnu : création normale, redirection vers la fiche du poste (pas de redirection ouverte).
  const other = await post('/stations/new', { name: 'Quai', description: '', retour: 'https://exemple.invalid/' });
  assert.equal(other.status, 303);
  assert.match(other.headers.location, /^\/stations\/\d+(\?ok=cree)?$|^\/\?ok=poste$/);
});

test('U6 liste des postes : ?ok=ajoute&poste= forgé ou inexistant → aucune mise en évidence, aucun nom injecté', async () => {
  for (const q of ['poste=999999', 'poste=abc', 'poste=1%3Cscript%3E', 'poste=']) {
    const res = await page(`/stations?ok=ajoute&${q}`);
    assert.equal(res.status, 200, q);
    assert.ok(!res.body.includes('tuile--nouvelle'), q);
    assert.ok(!res.body.includes('<script>'), q);
  }
  const real = await page('/stations?ok=ajoute&poste=3');
  assert.ok(real.body.includes('<p class="succes" role="status">Poste «&nbsp;Magasin&nbsp;» ajouté.</p>'));
  assert.equal((real.body.match(/tuile--nouvelle/g) ?? []).length, 1);
});

test('U6 renommer sur place : description gardée ; nom vide ou déjà pris → 400 et rien ne change', async () => {
  assert.equal((await post('/stations/3/edit', { name: 'Magasin central' })).status, 303);
  assert.deepEqual({ ...db.prepare('SELECT name, description FROM stations WHERE id = 3').get() }, { name: 'Magasin central', description: 'Étagère du fond' });
  for (const name of ['', '  ', 'banc', 'RÉCEPTION']) assert.equal((await post('/stations/3/edit', { name })).status, 400, JSON.stringify(name));
  assert.equal(db.prepare('SELECT name FROM stations WHERE id = 3').get().name, 'Magasin central');
  // Renommer avec le même nom (casse changée) : accepté, ce n'est pas un doublon de lui-même.
  assert.equal((await post('/stations/3/edit', { name: 'MAGASIN CENTRAL' })).status, 303);
});

test('U6 suppression : interdite (409) dès qu\'un poste a un historique — scan, correction ou lecteur affecté —, permise sinon', async () => {
  const mk = (name) => Number(db.prepare('INSERT INTO stations (name, description, created_at) VALUES (?, \'\', ?)').run(name, iso(0)).lastInsertRowid);
  // Historique par correction seulement.
  const corrected = mk('Corrigé');
  const item = Number(db.prepare("INSERT INTO items (name, created_at, updated_at) VALUES ('Témoin', ?, ?)").run(iso(0), iso(0)).lastInsertRowid);
  assert.equal((await post(`/items/${item}/location`, { station: String(corrected) })).status, 303);
  // Lecteur affecté (aucun scan) : bloque aussi. Un lecteur affecté puis retiré ne bloque plus
  // (définition de stationHistory : lecteurs affectés actuellement, actifs ou désactivés).
  const withReader = mk('Avec lecteur');
  assert.equal((await post('/readers/3/station', { station: String(withReader) })).status, 303);
  // Historique par scan (Réception, poste 1).
  for (const id of [1, corrected, withReader]) {
    const sheet = (await page(`/stations/${id}`)).body;
    assert.ok(!sheet.includes(`href="/stations/${id}/delete"`), `poste ${id} : pas de lien Supprimer`);
    // Retour UX (aller-retour 2) : la phrase n'est plus sur la fiche, seulement sur la page de suppression.
    assert.ok((await page(`/stations/${id}/delete`)).body.includes('Ce poste a un historique ; vous pouvez le renommer.'), `poste ${id}`);
    const res = await post(`/stations/${id}/delete`, {});
    assert.equal(res.status, 409, `poste ${id}`);
    assert.ok(db.prepare('SELECT 1 FROM stations WHERE id = ?').get(id), `poste ${id} conservé`);
  }
  assert.equal((await post('/readers/3/station', { station: '' })).status, 303);
  assert.equal((await post(`/stations/${withReader}/delete`, {})).status, 303, 'lecteur retiré, aucun scan : supprimable');
  // Sans historique : lien présent, suppression acceptée.
  assert.ok((await page('/stations/4')).body.includes('href="/stations/4/delete"'));
  assert.equal((await post('/stations/4/delete', {})).status, 303);
  assert.equal(db.prepare('SELECT 1 FROM stations WHERE id = 4').get(), undefined);
});

test('U6 tuiles : seuil « silencieux » à 24 h exactement ; lecteur désactivé jamais compté ; poste sans lecteur actif → « Aucun lecteur »', async () => {
  const mk = (name) => Number(db.prepare('INSERT INTO stations (name, description, created_at) VALUES (?, \'\', ?)').run(name, iso(0)).lastInsertRowid);
  const fresh = mk('Juste avant 24 h');
  const stale = mk('Juste après 24 h');
  const onlyInactive = mk('Lecteur retiré');
  const addReader = (id, station, active, lastScanMsAgo) => {
    db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (?, ?, ?, ?, ?)').run(id, station, KEY, active, iso(86_400_000 * 5));
    if (lastScanMsAgo !== null) db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, 1, ?)').run(id, station, 'E0000001', iso(lastScanMsAgo));
  };
  addReader(101, fresh, 1, SILENT_READER_MS - 60_000);
  addReader(102, stale, 1, SILENT_READER_MS + 60_000);
  addReader(103, onlyInactive, 0, 1_000);
  const summaries = new Map(listStationSummaries(db).map((s) => [s.id, s]));
  assert.deepEqual(summaries.get(onlyInactive).readers, []);
  const body = (await page('/stations')).body;
  const tile = (id) => body.split(`<li class="tuile" data-poste="${id}">`)[1].split('</li>')[0];
  assert.ok(tile(fresh).includes('tuile-lecteur--ok'), 'moins de 24 h : OK');
  assert.ok(tile(stale).includes('tuile-lecteur--attention" data-silencieux="102"'), 'plus de 24 h : silencieux');
  assert.ok(tile(stale).includes('Aucun scan depuis'), tile(stale));
  assert.ok(tile(onlyInactive).includes('<span>Aucun lecteur · '), 'désactivé : comme aucun lecteur');
});

test('U6 direct : scan d\'un objet par un lecteur non affecté → « de » = poste quitté, posteId null (la tuile quittée se vide)', async () => {
  assert.equal((await frame(1, 'D0000004')).status, 204);
  assert.equal((await post('/chips/D0000004/new', { name: 'Voyageur' })).status, 303); // à la Réception
  const events = await captureEvents(async () => assert.equal((await frame(3, 'D0000004')).status, 204));
  const scan = events.find((e) => e.type === 'scan');
  assert.deepEqual([scan.de, scan.posteId, scan.deplacement], [1, null, true]);
  // Second lecteur du même poste que l'objet : pas un déplacement, de = posteId (tuiles inchangées).
  db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (5, 1, ?, 1, ?)').run(KEY, iso(0));
  assert.equal((await frame(1, 'D0000004')).status, 204); // retour à la Réception
  const same = await captureEvents(async () => assert.equal((await frame(5, 'D0000004')).status, 204));
  assert.deepEqual([same[0].de, same[0].posteId, same[0].deplacement], [1, 1, false]);
});

// ---------------------------------------------------------------- U6 : lecteurs

test('U6 lecteur désactivé : aucune action sensible proposée ; POST forcés refusés sans écriture ; scans refusés sans événement', async () => {
  const sheet = (await page('/readers/4')).body;
  assert.ok(!sheet.includes('<dialog'));
  assert.ok(!sheet.includes('href="/readers/4/replace"') && !sheet.includes('href="/readers/4/deactivate"') && !sheet.includes('href="/readers/4/station"'));
  const before = auditCount();
  for (const [path, fields] of [['/readers/4/replace', {}], ['/readers/4/deactivate', {}], ['/readers/4/station', { station: '1' }]]) {
    const res = await post(path, fields);
    assert.ok(res.status >= 400 && res.status < 500, `${path} : ${res.status}`);
  }
  assert.equal(auditCount(), before);
  const events = await captureEvents(async () => assert.equal((await frame(4, 'D0000005')).status, 400));
  assert.deepEqual(events, []);
});

test('U6 remplacer la clé : nouvelle page de clé (no-store) qui attend le NOUVEAU numéro ; l\'ancien est désactivé et refusé', async () => {
  const res = await post('/readers/2/replace', {});
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const newId = Number(/<p class="numero-lecteur">(\d+)<\/p>/.exec(res.body)[1]);
  assert.ok(newId !== 2);
  assert.ok(res.body.includes(`id="attente-lecteur" data-lecteur="${newId}"`));
  assert.equal(db.prepare('SELECT active FROM readers WHERE id = 2').get().active, 0);
  assert.equal(db.prepare('SELECT station_id FROM readers WHERE id = ?').get(newId).station_id, 2, 'même poste');
  const key = Buffer.from(/<pre class="cle">([0-9a-f]{64})<\/pre>/.exec(res.body)[1], 'hex');
  // L'ancien numéro, même avec sa clé, est refusé ; le nouveau numéro avec la nouvelle clé produit
  // l'événement que la page de clé attend (lecteur = nouveau numéro).
  assert.equal((await frame(2, 'D0000006')).status, 400);
  const events = await captureEvents(async () => {
    const accepted = await send({
      method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
      body: encodeFrame({ readerId: newId, counter: 1, uid: Buffer.from('D0000006', 'hex'), key }),
    });
    assert.equal(accepted.status, 204);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].lecteur, newId);
  // Recharger la page de clé n'est pas possible : aucune adresse ne la réaffiche.
  assert.ok(!(await page(`/readers/${newId}`)).body.includes(key.toString('hex')));
});

test('U6 « Ajouter un lecteur » : ?poste= valide coché ; illisible → « Pas de poste » coché', async () => {
  assert.match((await page('/readers/new?poste=1')).body, /value="1" id="station-1" checked>/);
  for (const q of ['abc', '', '0', '-1', '1e3']) {
    const body = (await page(`/readers/new?poste=${q}`)).body;
    assert.ok(body.includes('id="station-aucun" checked'), `?poste=${q}`);
  }
});

// BUG constaté (rapport du testeur) : un numéro bien formé mais sans poste (poste supprimé depuis,
// lien ancien) ne coche rien, alors qu'un numéro illisible coche « Pas de poste ». Attendu : le
// même repli que pour un numéro illisible.
test('U6 « Ajouter un lecteur » : ?poste= d\'un poste inexistant → « Pas de poste » coché (repli)', async () => {
  const body = (await page('/readers/new?poste=999999')).body;
  assert.ok(body.includes('id="station-aucun" checked'));
});
