// Étapes U5 (puces inconnues) et U6 (postes et lecteurs) :
// - U5 : création d'une fiche depuis une puce par le même POST que la création rapide d'app.js
//   (nom seul, jeton CSRF, Origin), scans d'une même puce regroupés, API à 200 puces avec le nombre
//   de scans, avertissements sans numéro en double ;
// - U6 : tuiles des postes (objets présents, dernier arrivé, état du lecteur), ajout d'un poste en
//   ligne (retour à la liste), « Renommer » sur place (description gardée), fiche poste (objets,
//   lecteur, dernières arrivées, phrase d'historique), lecteurs désactivés repliés, actions
//   sensibles expliquées en une phrase et confirmées, poste présélectionné, page de clé qui attend
//   le premier scan (clé jamais dans une URL, no-store), champ « de » du direct.
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
import { createItem } from '../server/items.js';
import { encodeFrame } from '../server/protocol.js';
import { listStationSummaries } from '../server/stations.js';
import { recentMovements, SILENT_READER_MS } from '../server/accueil.js';
import { unknownChipsOverview } from '../server/chips.js';
import { AIDE } from '../server/aide.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, certs, db, server, port, user, token, csrf;
const KEY = Buffer.alloc(32, 0x5a);
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();
const counters = new Map();
const logs = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u5u6-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  user = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('claire.martin', DUMMY_HASH, ago(0)).lastInsertRowid);
  for (const [id, name, description] of [[1, 'Poste A', 'Réception'], [2, 'Poste B', ''], [3, 'Magasin', ''], [4, 'Quai', '']]) {
    db.prepare('INSERT INTO stations (id, name, description, created_at) VALUES (?, ?, ?, ?)').run(id, name, description, ago(10_000));
  }
  // Lecteurs : 1 (A), 2 (B), 3 (Magasin, dernier scan il y a 3 jours), 4 (désactivé, B), 5 (non affecté, jamais).
  for (const [id, station, active] of [[1, 1, 1], [2, 2, 1], [3, 3, 1], [4, 2, 0], [5, null, 1]]) {
    db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (?, ?, ?, ?, ?)').run(id, station, KEY, active, ago(10_000));
  }
  db.prepare("UPDATE readers SET name = 'Boîtier ancien' WHERE id = 4").run();
  token = createSession(db, user);
  csrf = csrfTokenFor(token);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => logs.push(l), loginFailureDelayMs: 0 });
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
const cookie = () => `__Host-mt_session=${token}`;
const page = (path) => send({ path, headers: { Cookie: cookie() } });
// Envoi comme le fait le navigateur (formulaire de la page ou fetch d'app.js : même origine,
// corps application/x-www-form-urlencoded avec le jeton CSRF).
function post(path, fields) {
  const body = new URLSearchParams({ ...fields, csrf }).toString();
  return send({
    method: 'POST', path, body,
    headers: { Cookie: cookie(), Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'Content-Length': Buffer.byteLength(body) },
  });
}
function frame(readerId, uid) {
  const counter = (counters.get(readerId) ?? 0) + 1;
  counters.set(readerId, counter);
  return send({
    method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
    body: encodeFrame({ readerId, counter, uid: Buffer.from(uid, 'hex'), key: KEY }),
  });
}
const scanAt = (readerId, stationId, uid, at) => {
  const counter = (counters.get(readerId) ?? 0) + 1;
  counters.set(readerId, counter);
  db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)').run(readerId, stationId, uid, counter, at);
};

// ---------------------------------------------------------------- U5 : puces inconnues

test('U5 : scans d\'une même puce regroupés en une carte « Nouvelle puce · poste », numéro en petit', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await frame(2, 'AA000001')).status, 204);
  assert.equal((await frame(1, 'AA000002')).status, 204);
  const res = await page('/chips');
  assert.equal(res.status, 200);
  const cards = res.body.split('<li class="encart puce-carte"').slice(1);
  assert.equal(cards.length, 2, 'une carte par puce');
  assert.ok(cards[0].startsWith(' data-uid="AA000002" data-poste="Poste A"'), 'la plus récente en tête');
  assert.ok(cards[1].includes('<p class="encart-texte">Nouvelle puce · <strong>Poste B</strong></p>'));
  assert.ok(cards[1].includes('<span data-scans>3 scans · dernier </span><time'));
  assert.ok(cards[1].includes('<span class="puce-numero">N°&nbsp;<span class="uid">AA 00 00 01</span></span>'));
  assert.ok(res.body.includes('<p class="resultats" id="puces-resume">2 nouvelles puces</p>'));
  assert.ok(res.body.includes('<div class="vide" id="puces-vide" hidden>'), 'état vide présent, caché');
  assert.ok(res.body.includes('id="direct-etat"'), 'indicateur « En direct »');
});

test('U5 : /api/puces-inconnues donne jusqu\'à 200 puces, avec leur nombre de scans', async () => {
  const res = await page('/api/puces-inconnues?n=200');
  assert.equal(res.status, 200);
  const data = JSON.parse(res.body);
  assert.equal(data.total, 2);
  assert.deepEqual(data.puces.map((p) => [p.uid, p.scans, p.poste]), [['AA000002', 1, 'Poste A'], ['AA000001', 3, 'Poste B']]);
  assert.equal((await page('/api/puces-inconnues?n=201')).status, 400);
  assert.deepEqual(unknownChipsOverview(db, 1).chips.map((c) => c.scan_count), [1]);
});

test('U5 : création en une étape depuis la carte (nom seul, même POST) : fiche localisée au poste, carte retirée, événement « puce »', async () => {
  const res = await post('/chips/AA000001/new', { name: 'Multimètre n° 8' });
  assert.equal(res.status, 303);
  const id = Number(/^\/items\/(\d+)\?ok=cree_puce$/.exec(res.headers.location)[1]);
  const sheet = await page(`/items/${id}`);
  assert.ok(sheet.body.includes('<span class="etat etat-poste">Poste B</span>'));
  const list = await page('/chips');
  assert.ok(!list.body.includes('data-uid="AA000001"'));
  assert.ok(list.body.includes('1 nouvelle puce'));
  // La page complète garde l'autofocus sur le nom, seul champ obligatoire.
  const full = await page('/chips/AA000002/new');
  assert.match(full.body, /<input id="name" name="name" value="" maxlength="200" required autocomplete="off"[^>]* autofocus>/);
  assert.equal((full.body.match(/required/g) ?? []).length, 1);
  // Nom vide : refusé (400), rien n'est créé ; puce déjà traitée : 409 (app.js retire la carte).
  assert.equal((await post('/chips/AA000002/new', { name: '   ' })).status, 400);
  assert.equal((await post('/chips/AA000001/new', { name: 'Doublon' })).status, 409);
});

test('U5 : liste vide → « Aucune nouvelle puce. Quand une puce inconnue est scannée, elle apparaît ici. »', async () => {
  assert.equal((await post('/chips/AA000002/new', { name: 'Oscilloscope' })).status, 303);
  const res = await page('/chips');
  assert.ok(res.body.includes('<div class="vide" id="puces-vide">'));
  assert.ok(res.body.includes('<p>Aucune nouvelle puce.</p>\n<p class="texte-doux">Quand une puce inconnue est scannée, elle apparaît ici.</p>'));
  assert.ok(res.body.includes('id="puces-inconnues" data-plus="0" hidden>'));
});

test('U5 : avertissements d\'association en deux phrases au plus, numéro de puce une seule fois', async () => {
  assert.equal((await frame(1, 'AA000003')).status, 204);
  const item = db.prepare("SELECT id FROM items WHERE name = 'Oscilloscope'").get().id;
  const res = await page(`/chips/AA000003/associate/${item}`);
  assert.equal(res.status, 200);
  const panel = /<div class="panneau panneau-danger">\n<p>([\s\S]*?)<\/p>\n<p>([\s\S]*?)<\/p>/.exec(res.body);
  assert.ok(panel, 'deux paragraphes');
  assert.equal(panel[1].replace(/<[^>]+>/g, ''), '«&nbsp;Oscilloscope&nbsp;» a déjà une puce. La nouvelle la remplacera, et l\'ancienne redeviendra une puce inconnue.');
  assert.match(panel[2], /^L'objet sera localisé à Poste A, où la puce a été scannée <time/);
  assert.equal(res.body.split('AA 00 00 03').length - 1, 1, 'numéro de la nouvelle puce une seule fois');
  assert.ok(!res.body.includes('AA 00 00 02'), 'aucun numéro de l\'ancienne puce');
});

test('U5 : aide « Comment ça marche ? » en trois phrases', () => {
  assert.equal((String(AIDE.puces).match(/<p>/g) ?? []).length, 3);
});

// ---------------------------------------------------------------- U6 : postes en tuiles

test('U6 : tuiles — objets présents, dernier arrivé, lecteur OK / silencieux / aucun', async () => {
  scanAt(3, 3, 'BB000001', new Date(NOW - 3 * 24 * 3_600_000).toISOString()); // lecteur du Magasin muet depuis 3 jours
  const tiles = listStationSummaries(db);
  const byName = Object.fromEntries(tiles.map((t) => [t.name, t]));
  assert.deepEqual(tiles.map((t) => t.name), ['Magasin', 'Poste A', 'Poste B', 'Quai']);
  assert.equal(byName['Poste B'].items_here, 1);
  assert.equal(byName['Poste B'].last_arrival.item_name, 'Multimètre n° 8');
  assert.equal(byName['Poste A'].items_here, 1);
  assert.deepEqual(byName['Poste B'].readers.map((r) => r.id), [2], 'lecteurs désactivés exclus');
  assert.deepEqual(byName.Quai.readers, []);

  const res = await page('/stations');
  assert.equal(res.status, 200);
  const tile = (id) => res.body.split(`<li class="tuile" data-poste="${id}">`)[1].split('</li>')[0];
  assert.ok(tile(2).includes('<h2 class="tuile-nom"><a href="/stations/2">Poste B</a></h2>'));
  assert.ok(tile(2).includes('<p class="tuile-nombre"><strong data-nombre="1">1</strong> <span>objet présent</span></p>'));
  assert.match(tile(2), /<p class="tuile-dernier" data-objet="\d+">Dernière arrivée : <a class="tuile-lien" href="\/items\/\d+">Multimètre n° 8<\/a> · <time/);
  assert.match(tile(2), /<p class="tuile-lecteur tuile-lecteur--ok" data-silencieux="">[\s\S]*Lecteur OK · dernier scan <time/);
  assert.ok(tile(3).includes('tuile-lecteur--attention" data-silencieux="3">'));
  assert.ok(tile(3).includes('<span>Aucun scan depuis 3 jours</span>'));
  assert.ok(tile(4).includes('<p class="tuile-nombre"><span class="tuile-aucun" data-nombre="0">Aucun objet ici</span></p>'));
  assert.ok(tile(4).includes('Aucun lecteur · <a class="tuile-lien" href="/readers/new?poste=4">Ajouter un lecteur</a>'));
  assert.ok(tile(1).includes('<p class="tuile-description">Réception</p>'));
  assert.ok(res.body.includes('id="direct-etat"'));
  assert.ok(SILENT_READER_MS === 24 * 3_600_000);
});

test('U6 : « Ajouter un poste » en ligne (un nom suffit) : retour à la liste, poste nommé et mis en évidence', async () => {
  const list = await page('/stations');
  assert.ok(list.body.includes('<form class="carte ajout-en-ligne" id="ajout-poste" method="post" action="/stations/new" hidden>'));
  assert.ok(list.body.includes('<input type="hidden" name="retour" value="postes">'));
  const res = await post('/stations/new', { name: 'Banc d\'essais', description: '', retour: 'postes' });
  assert.equal(res.status, 303);
  const id = db.prepare("SELECT id FROM stations WHERE name = 'Banc d''essais'").get().id;
  assert.equal(res.headers.location, `/stations?ok=ajoute&poste=${id}`);
  const after = await page(res.headers.location);
  assert.ok(after.body.includes('<p class="succes" role="status">Poste «&nbsp;Banc d&#39;essais&nbsp;» ajouté.</p>'));
  assert.ok(after.body.includes(`<li class="tuile tuile--nouvelle" data-poste="${id}">`));
  // Sans retour=postes, la création mène toujours à la fiche du poste (hors démarrage guidé).
  assert.equal((await post('/stations/new', { name: 'Zone D', description: '' })).headers.location.startsWith('/stations/'), true);
  // Code ou numéro inconnu : aucun message inventé.
  assert.ok(!(await page('/stations?ok=ajoute&poste=999')).body.includes('ajouté.'));
});

test('U6 : fiche poste — objets d\'abord, lecteur et son état, dernières arrivées, « Renommer » sur place', async () => {
  const res = await page('/stations/2');
  const body = res.body;
  const order = ['id="titre-objets"', 'id="titre-lecteurs"', 'id="titre-arrivees"'].map((s) => body.indexOf(s));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), 'objets, puis lecteur, puis arrivées');
  assert.ok(body.includes('<form class="renommer-sur-place" id="renommer-poste" data-titre="titre-poste" method="post" action="/stations/2/edit" hidden>'));
  assert.ok(body.includes('<a class="bouton bouton-secondaire" href="/stations/2/edit" data-sur-place="renommer-poste">'));
  assert.match(body, /<li class="arrivee">[\s\S]*?Multimètre n° 8<\/a> <span class="texte-doux">· scan<\/span>/);
  assert.ok(!body.includes('href="/readers/4"'), 'lecteur désactivé non listé');
  assert.ok(!body.includes('Ce poste a un historique'), 'phrase seulement sur la page de suppression');
  assert.ok(!body.includes('/stations/2/delete'));
  // Renommer sur place : seul le nom est envoyé, la description est gardée.
  const renamed = await post('/stations/1/edit', { name: 'Poste A · Accueil' });
  assert.equal(renamed.headers.location, '/stations/1?ok=modifie');
  assert.deepEqual({ ...db.prepare('SELECT name, description FROM stations WHERE id = 1').get() }, { name: 'Poste A · Accueil', description: 'Réception' });
  assert.deepEqual(recentMovements(db, 10, 2).map((m) => m.item_name), ['Multimètre n° 8']);
  // Poste sans historique : « Supprimer » proposé.
  assert.ok((await page('/stations/4')).body.includes('href="/stations/4/delete"'));
});

// ---------------------------------------------------------------- U6 : lecteurs

test('U6 : liste des lecteurs — état en mots, désactivés repliés dans « Lecteurs désactivés (N) »', async () => {
  const res = await page('/readers');
  const [active, folded] = res.body.split('<details class="lecteurs-desactives">');
  assert.ok(folded.startsWith('\n<summary>Lecteurs désactivés (1)</summary>'));
  assert.ok(folded.includes('href="/readers/4">Boîtier ancien</a>') && !active.includes('href="/readers/4"'));
  assert.ok(active.includes('etat-lecteur--ok') && active.includes('fonctionne</span>'));
  assert.ok(active.includes('silencieux depuis 3 jours</span>'));
  assert.ok(active.includes('en attente du premier scan</span>'));
  assert.ok(active.indexOf('silencieux depuis') < active.indexOf('fonctionne</span>'), 'à surveiller en tête');
  assert.ok(folded.includes('désactivé</span>'));
  assert.ok(res.body.includes('3 lecteurs en service') === false && res.body.includes('4 lecteurs en service'));
  assert.ok(!/<details[^>]*\sopen/.test(res.body), 'replié par défaut');
});

test('U6 : actions sensibles expliquées en une phrase et confirmées (panneaux et pages sans script)', async () => {
  const sheet = (await page('/readers/2')).body;
  const deactivate = 'Ce lecteur n&#39;enverra plus de scans. Les scans passés restent dans l&#39;historique. C&#39;est définitif.';
  const replace = 'Une nouvelle clé et un nouveau numéro vont être créés. L&#39;ancien cessera de fonctionner tout de suite : mettez à jour les deux dans le boîtier.';
  assert.ok(sheet.includes(`<p class="dialogue-intro">${deactivate}</p>`));
  assert.ok(sheet.includes(`<p class="dialogue-intro">${replace}</p>`));
  assert.ok(sheet.includes('<dialog class="dialogue" id="dialogue-poste"'));
  assert.match(sheet, /id="panneau-station-2" checked><span>Poste B<\/span> <span class="choix-actuel">actuel<\/span>/);
  assert.equal((sheet.match(/data-fermer data-focus/g) ?? []).length, 2, '« Annuler » reçoit le focus des actions irréversibles');
  assert.ok((await page('/readers/2/deactivate')).body.includes(`<p>${deactivate}</p>`));
  assert.ok((await page('/readers/2/replace')).body.includes(`<p>${replace}</p>`));
  // Boutons radio jusqu'à 12 postes, comme la correction d'emplacement.
  assert.equal(((await page('/readers/2/station')).body.match(/<input type="radio" name="station"/g) ?? []).length, 7);
  // Désactivé : aucun panneau d'action.
  assert.ok(!(await page('/readers/4')).body.includes('<dialog'));
});

test('U6 : « Ajouter un lecteur » depuis un poste : poste présélectionné ; page de clé qui attend le premier scan', async () => {
  const form = await page('/readers/new?poste=4');
  assert.ok(form.body.includes('<input type="radio" name="station" value="4" id="station-4" checked><span>Quai</span>'));
  assert.ok((await page('/readers/new?poste=abc')).body.includes('id="station-aucun" checked'));
  const res = await post('/readers/new', { name: 'Boîtier quai', station: '4' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers.location, undefined, 'clé jamais dans une URL');
  const id = db.prepare("SELECT id FROM readers WHERE name = 'Boîtier quai'").get().id;
  assert.ok(res.body.includes(`<p>Configurez le numéro ${id} et la clé dans le boîtier, puis scannez un objet pour vérifier.</p>`));
  assert.ok(res.body.includes(`<p class="attente-lecteur" id="attente-lecteur" data-lecteur="${id}" role="status" hidden><span class="direct-point" aria-hidden="true"></span><span>En attente du premier scan de ce lecteur…</span></p>`));
  assert.ok(res.body.includes(`<p class="texte-doux sans-script">Le premier scan apparaîtra sur <a href="/readers/${id}">la fiche du lecteur</a>.</p>`));
  const key = /<pre class="cle">([0-9a-f]{64})<\/pre>/.exec(res.body)[1];
  // Pages consultables ensuite : jamais la clé.
  for (const path of ['/readers', `/readers/${id}`, '/stations', '/stations/4']) assert.ok(!(await page(path)).body.includes(key), path);
  assert.ok(!logs.some((l) => l.includes(key)));
});

test('U6 : direct — champ « de » (poste quitté) pour un scan qui déplace un objet et pour une correction', async () => {
  const events = [];
  const hub = server.direct;
  const publish = hub.publish.bind(hub);
  hub.publish = (event) => { events.push(event); publish(event); };
  try {
    const uid = db.prepare("SELECT uid_nfc FROM items WHERE name = 'Multimètre n° 8'").get().uid_nfc; // à Poste B
    assert.equal((await frame(1, uid)).status, 204); // vers Poste A
    await new Promise((r) => setTimeout(r, 20));
    const move = events.find((e) => e.type === 'scan');
    assert.deepEqual([move.de, move.posteId, move.deplacement], [2, 1, true]);
    const item = db.prepare("SELECT id FROM items WHERE name = 'Multimètre n° 8'").get().id;
    assert.equal((await post(`/items/${item}/location`, { station: '3' })).status, 303);
    const correction = events.find((e) => e.type === 'correction');
    assert.deepEqual([correction.de, correction.posteId], [1, 3]);
    // Puce inconnue : aucun « de ».
    assert.equal((await frame(1, 'CC000001')).status, 204);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(events.at(-1).de, null);
  } finally {
    hub.publish = publish;
  }
});

test('U6 : aides « Comment ça marche ? » des postes et lecteurs en trois phrases', () => {
  for (const key of ['postes', 'poste', 'lecteurs', 'lecteur']) assert.equal((String(AIDE[key]).match(/<p>/g) ?? []).length, 3, key);
  assert.ok(createItem); // module chargé (aucune écriture ici)
});
