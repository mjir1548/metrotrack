// Étape U3 : fiche objet. Frise des déplacements (server/timeline.js : regroupement, corrections,
// ordre, création, limite, pagination, borne), page « Tout l'historique », panneau de correction
// (même formulaire POST que la page), « Donner une puce » / « Changer de puce » (association de
// l'étape 7 réutilisée, remplacement, 409), « Retirer la puce » (audit, CSRF, 409), libellés.
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
import { getItem } from '../server/inventory.js';
import { correctLocation, createItem, itemChanges } from '../server/items.js';
import { chipPreviousOwner, chipPreviousOwners, detachChip, MAX_OFFERED_CHIPS } from '../server/chips.js';
import { itemTimeline, parseCursor, SCAN_WINDOW, TIMELINE_ENTRIES, TIMELINE_PAGE_ENTRIES } from '../server/timeline.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, db, server, port, certs, token, csrf, origin, alice;
const KEY = Buffer.alloc(32, 0x33);
const T = (min) => new Date(Date.parse('2026-11-20T08:00:00.000Z') + min * 60_000).toISOString();
let counter = 0;
const insertScan = () => db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
const scanAt = (readerId, stationId, uid, at) => insertScan().run(readerId, stationId, uid, ++counter, at);

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u3-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  alice = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, T(0)).lastInsertRowid);
  for (const [id, name] of [[1, 'Poste A'], [2, 'Poste B'], [3, 'Magasin']]) {
    db.prepare('INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?)').run(id, name, T(0));
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (?, ?, ?, ?)').run(id, id, KEY, T(0));
  }
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (9, NULL, ?, ?)').run(KEY, T(0));
  token = createSession(db, alice);
  csrf = csrfTokenFor(token);
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
const page = (path) => send({ path, headers: { Cookie: `__Host-mt_session=${token}` } });
function post(path, fields = {}, { csrfField = csrf } = {}) {
  const params = new URLSearchParams(Object.entries(fields));
  if (csrfField !== null) params.append('csrf', csrfField);
  return send({
    method: 'POST', path, body: params.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `__Host-mt_session=${token}`, Origin: origin },
  });
}
const newItem = (name, uid = null, at = T(0)) => {
  const id = createItem(db, alice, { name, notes: '', properties: [] }, at);
  if (uid !== null) db.prepare('UPDATE items SET uid_nfc = ? WHERE id = ?').run(uid, id);
  return id;
};
const auditCount = () => db.prepare('SELECT count(*) AS n FROM audit_log').get().n;
const shape = (entries) => entries.map((e) => (e.type === 'scan' ? `scan:${e.station_name ?? 'non affecté'}x${e.count}` : e.type === 'correction' ? `main:${e.station_name}` : 'création'));
const frise = (html) => /<ol class="frise">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
const steps = (html) => frise(html).split('</li>').filter((s) => s.includes('<li class="frise-etape')).map((s) => s.trimStart());

// ---------------------------------------------------------------- frise : logique

test('frise : scans consécutifs au même poste regroupés, correction à part, création en bas, du plus récent au plus ancien', () => {
  const id = newItem('Multimètre', '0A000001', T(0));
  scanAt(1, 1, '0A000001', T(10));
  scanAt(1, 1, '0A000001', T(11));
  scanAt(2, 2, '0A000001', T(20));
  correctLocation(db, alice, id, 3, T(30));
  scanAt(3, 3, '0A000001', T(40)); // même poste que la correction : entrée distincte
  scanAt(2, 2, '0A000001', T(50));
  scanAt(2, 2, '0A000001', T(51));
  scanAt(2, 2, '0A000001', T(52));
  scanAt(9, null, '0A000001', T(60)); // lecteur non affecté : emplacement à part entière
  const { entries, next } = itemTimeline(db, getItem(db, id));
  assert.equal(next, null);
  assert.deepEqual(shape(entries), ['scan:non affectéx1', 'scan:Poste Bx3', 'scan:Magasinx1', 'main:Magasin', 'scan:Poste Bx1', 'scan:Poste Ax2', 'création']);
  const b = entries[1];
  assert.deepEqual([b.arrived_at, b.last_at, b.bounded], [T(50), T(52), false]);
  assert.equal(entries[3].username, 'alice');
  assert.deepEqual(entries.at(-1), { type: 'creation', at: T(0), username: 'alice', known: true });
});

test('frise : à heure égale, la correction est plus récente que le scan (ordre de la vue) ; deux scans même ms : id le plus grand en tête', () => {
  const id = newItem('Ex aequo', '0A000002');
  scanAt(1, 1, '0A000002', T(10));
  correctLocation(db, alice, id, 2, T(10));
  scanAt(3, 3, '0A000002', T(20));
  scanAt(1, 1, '0A000002', T(20));
  assert.deepEqual(shape(itemTimeline(db, getItem(db, id)).entries), ['scan:Poste Ax1', 'scan:Magasinx1', 'main:Poste B', 'scan:Poste Ax1', 'création']);
  // La tête de la frise est l'emplacement actuel (vue item_locations).
  assert.equal(getItem(db, id).station_name, 'Poste A');
});

test('frise : fiche sans puce (corrections seules), fiche importée sans audit (création « inconnue »)', () => {
  const id = newItem('Sans puce');
  correctLocation(db, alice, id, 1, T(5));
  assert.deepEqual(shape(itemTimeline(db, getItem(db, id)).entries), ['main:Poste A', 'création']);
  db.prepare("INSERT INTO items (id, name, created_at, updated_at) VALUES (900, 'Importée', ?, ?)").run(T(0), T(0));
  assert.deepEqual(itemTimeline(db, getItem(db, 900n)).entries, [{ type: 'creation', at: T(0), username: null, known: false }]);
});

test('frise : limite de déplacements, curseur de la page suivante, pages qui se suivent sans trou ni doublon', () => {
  const id = newItem('Voyageur', '0A000003');
  for (let i = 0; i < 75; i++) {
    scanAt(1 + (i % 2), 1 + (i % 2), '0A000003', T(100 + 2 * i));
    scanAt(1 + (i % 2), 1 + (i % 2), '0A000003', T(101 + 2 * i)); // rescan au même poste
  }
  const item = getItem(db, id);
  const first = itemTimeline(db, item);
  assert.equal(first.entries.length, TIMELINE_ENTRIES);
  assert.ok(first.entries.every((e) => e.type === 'scan' && e.count === 2));
  assert.notEqual(first.next, null);
  const seen = [...first.entries];
  let cursor = parseCursor(first.next);
  let pages = 0;
  for (;;) {
    const p = itemTimeline(db, item, { cursor, limit: TIMELINE_PAGE_ENTRIES });
    seen.push(...p.entries);
    pages++;
    if (p.next === null) break;
    cursor = parseCursor(p.next);
  }
  assert.equal(pages, 1);
  assert.equal(seen.filter((e) => e.type === 'scan').length, 75);
  assert.equal(seen.at(-1).type, 'creation');
  const arrivals = seen.filter((e) => e.type === 'scan').map((e) => e.arrived_at);
  assert.deepEqual(arrivals, [...arrivals].sort().reverse());
  assert.equal(new Set(arrivals).size, 75);
});

test('frise : borne de lecture (SCAN_WINDOW) — une très longue série au même poste donne « au moins », sans tout lire', () => {
  const id = newItem('Posée sur le lecteur', '0A000004');
  scanAt(2, 2, '0A000004', T(0));
  db.exec('BEGIN');
  for (let i = 0; i < SCAN_WINDOW + 500; i++) scanAt(1, 1, '0A000004', new Date(Date.parse(T(10)) + i * 1000).toISOString());
  db.exec('COMMIT');
  const item = getItem(db, id);
  const first = itemTimeline(db, item);
  assert.equal(first.entries.length, 1);
  assert.equal(first.entries[0].bounded, true);
  assert.equal(first.entries[0].count, SCAN_WINDOW);
  assert.notEqual(first.next, null);
  // Page suivante : la suite de la série, puis Poste B et la création.
  const second = itemTimeline(db, item, { cursor: parseCursor(first.next), limit: TIMELINE_PAGE_ENTRIES });
  assert.deepEqual(shape(second.entries), ['scan:Poste Ax500', 'scan:Poste Bx1', 'création']);
});

test('parseCursor : format exact seulement', () => {
  assert.deepEqual(parseCursor('2026-11-20T08:00:00.000Z|0|0000000000000000042'), { at: '2026-11-20T08:00:00.000Z', kind: 0, id: 42 });
  assert.deepEqual(parseCursor('2026-11-20T08:00:00.000Z|2|0000000000000000007'), { at: '2026-11-20T08:00:00.000Z', kind: 2, id: 7 }); // repère de puce
  for (const bad of [null, '', 'x', '2026-11-20T08:00:00.000Z|3|0000000000000000042', '2026-11-20T08:00:00.000Z|0|42',
    '2026-11-20 08:00:00|0|0000000000000000042', '2026-11-20T08:00:00.000Z|0|9999999999999999999', "2026-11-20T08:00:00.000Z|0|0000000000000000042'"]) {
    assert.equal(parseCursor(bad), null, String(bad));
  }
});

// ---------------------------------------------------------------- fiche et historique : pages

test('fiche : en-tête (emplacement, badge, actions, menu), frise avec « Emplacement actuel », « Voir tout l\'historique » au-delà de 30', async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'Voyageur'").get().id;
  const res = await page(`/items/${id}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<p class="etiquette">Emplacement actuel</p>'));
  assert.ok(res.body.includes(`<a class="bouton" href="/items/${id}/location" data-dialogue="corriger">`));
  assert.ok(res.body.includes('<details class="menu">'));
  assert.ok(res.body.includes(`href="/items/${id}/retirer-puce"`) && res.body.includes(`href="/items/${id}/puce"`) && res.body.includes(`href="/items/${id}/delete"`));
  assert.equal(steps(res.body).length, TIMELINE_ENTRIES);
  assert.ok(steps(res.body)[0].includes('<span class="badge badge--ok"><svg class="ic" aria-hidden="true"><use href="#i-poste"></use></svg>Emplacement actuel</span>'));
  assert.equal(steps(res.body).filter((s) => s.includes('Emplacement actuel')).length, 1);
  assert.match(steps(res.body)[0], /<p class="frise-suite">2 scans ici · le dernier <time /);
  assert.ok(res.body.includes(`<a class="bouton bouton-discret bouton-petit" href="/items/${id}/historique">`));
});

test('page historique : 50 par page, lien vers les plus anciens (curseur encodé), retour aux plus récents ; curseur invalide → 404', async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'Voyageur'").get().id;
  const first = await page(`/items/${id}/historique`);
  assert.equal(first.status, 200);
  assert.ok(first.body.includes('<h1>Historique des déplacements</h1>'));
  assert.equal(steps(first.body).length, TIMELINE_PAGE_ENTRIES);
  const link = /href="(\/items\/\d+\/historique\?avant=[^"]+)"/.exec(first.body)[1];
  assert.match(link, /avant=2026-11-20T\d\d%3A\d\d%3A\d\d\.\d{3}Z%7C0%7C\d{19}$/);
  const second = await page(link.replaceAll('&amp;', '&'));
  assert.equal(second.status, 200);
  assert.equal(steps(second.body).length, 75 - TIMELINE_PAGE_ENTRIES + 1); // + la création
  assert.ok(second.body.includes(`href="/items/${id}/historique">Revenir aux plus récents</a>`));
  assert.ok(!second.body.includes('Emplacement actuel</span>'), 'pas de badge hors de la première page');
  assert.ok(!/historique\?avant=/.test(second.body));
  for (const bad of ['x', '%3Cscript%3E', '2026-11-20T08%3A00%3A00.000Z%7C0%7C42']) {
    assert.equal((await page(`/items/${id}/historique?avant=${bad}`)).status, 404, bad);
  }
  assert.equal((await page('/items/99999/historique')).status, 404);
});

test('fiche après correction : message nommant le poste, nouvelle étape en tête marquée « nouveau » (icône main ET texte)', async () => {
  const id = newItem('À corriger', '0A000005');
  scanAt(1, 1, '0A000005', T(1));
  const res = await post(`/items/${id}/location`, { station: '3' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/items/${id}?ok=corrige`);
  const sheet = await page(res.headers.location);
  assert.ok(sheet.body.includes('<p class="succes" role="status">Emplacement corrigé : Magasin</p>'));
  const top = steps(sheet.body)[0];
  assert.ok(top.startsWith('<li class="frise-etape frise-etape--actuel frise-etape--main nouveau">'), top);
  assert.ok(top.includes('<use href="#i-main"></use>') && top.includes('<strong>Corrigé à la main</strong> par alice'));
  // Sans ?ok=corrige : pas de mise en évidence.
  assert.ok(!(await page(`/items/${id}`)).body.includes(' nouveau"'));
});

test('panneau de correction : même formulaire POST que la page (adresse, jeton CSRF, champ station, mêmes postes), poste actuel signalé', async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'À corriger'").get().id;
  const sheet = (await page(`/items/${id}`)).body;
  const dialog = /<dialog class="dialogue" id="dialogue-corriger"[\s\S]*?<\/dialog>/.exec(sheet)[0];
  const form = (await page(`/items/${id}/location`)).body;
  const radios = (html) => [...html.matchAll(/<input type="radio" name="station" value="(\d+)" required/g)].map((m) => m[1]);
  assert.ok(dialog.includes(`<form method="post" action="/items/${id}/location">`));
  assert.ok(form.includes(`method="post" action="/items/${id}/location">`));
  assert.ok(dialog.includes(`<input type="hidden" name="csrf" value="${csrf}">`));
  assert.deepEqual(radios(dialog), radios(form));
  assert.deepEqual(radios(dialog), ['3', '1', '2']); // ordre alphabétique : Magasin, Poste A, Poste B
  assert.ok(dialog.includes('<span>Magasin</span> <span class="choix-actuel">actuel</span>'));
  assert.ok(!/<dialog[^>]*\sopen/.test(sheet), 'fermé sans script');
  assert.ok(dialog.includes('data-fermer'));
  // Sans jeton CSRF ou avec un mauvais jeton : refusé, rien n'est écrit.
  const before = auditCount();
  assert.equal((await post(`/items/${id}/location`, { station: '1' }, { csrfField: null })).status, 403);
  assert.equal((await post(`/items/${id}/location`, { station: '1' }, { csrfField: 'x'.repeat(43) })).status, 403);
  assert.equal(auditCount(), before);
});

test('modifications de la fiche : carte repliable fermée, libellés simples, sans les corrections d\'emplacement', async () => {
  const id = newItem('Four', null, T(0));
  await post(`/items/${id}/edit`, { name: 'Four Memmert', notes: 'Porte dure', prop_key: 'Marque', prop_value: 'Memmert' });
  correctLocation(db, alice, id, 1, T(3));
  const sheet = (await page(`/items/${id}`)).body;
  const card = /<details class="carte modifications">[\s\S]*?<\/details>/.exec(sheet)[0];
  assert.ok(card.includes('Modifications de la fiche <span class="compte-titre">1</span>'));
  assert.ok(card.includes('<p class="modification-quoi">Nom modifié · Propriété « Marque » ajoutée · Notes ajoutées</p>'));
  assert.ok(!card.includes('Corrigé') && !card.includes('Emplacement'));
});

// ---------------------------------------------------------------- donner, changer, retirer la puce

test('donner une puce : état vide utile, puis puces inconnues récentes (la plus récente en premier), choix direct → associée, audit, journal intact', async () => {
  const id = newItem('Alimentation');
  // Aucune puce inconnue : toutes les puces scannées jusqu'ici sont portées par des fiches,
  // sauf celles des tests qui n'existent pas encore.
  const empty = await page(`/items/${id}/puce`);
  assert.equal(empty.status, 200);
  assert.ok(empty.body.includes('<h1>Donner une puce</h1>'));
  assert.ok(empty.body.includes('Scannez la puce sur n\'importe quel lecteur, puis choisissez-la ici. <a href="/items/'));
  assert.ok(empty.body.includes('Aucune puce inconnue pour l\'instant. Scannez la nouvelle puce sur un lecteur, puis actualisez cette page.'));
  scanAt(2, 2, '0B000001', T(500));
  scanAt(1, 1, '0B000002', T(510));
  const list = (await page(`/items/${id}/puce`)).body;
  assert.ok(list.indexOf('0B 00 00 02') < list.indexOf('0B 00 00 01'), 'la plus récente en premier');
  assert.ok(list.includes(`<form method="post" action="/chips/0B000002/associate/${id}">`));
  assert.ok(list.includes('<input type="hidden" name="previous" value="">'));
  const scans = db.prepare('SELECT count(*) AS n FROM scans').get().n;
  const res = await post(`/chips/0B000002/associate/${id}`, { previous: '' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/items/${id}?ok=puce_associee`);
  assert.equal(getItem(db, id).uid_nfc, '0B000002');
  assert.equal(getItem(db, id).station_name, 'Poste A', 'localisée au dernier scan de la puce');
  assert.equal(db.prepare('SELECT count(*) AS n FROM scans').get().n, scans);
  assert.deepEqual(itemChanges(db, id)[0].labels, [['Puce associée : ', { uid: '0B000002' }]]);
});

test('changer de puce : avertissement de remplacement, puis confirmation de l\'étape 7 (depuis la fiche) ; fiche changée entre-temps → 409 sans écriture', async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'Alimentation'").get().id;
  const list = (await page(`/items/${id}/puce`)).body;
  assert.ok(list.includes('<h1>Changer de puce</h1>'));
  assert.ok(list.includes('Puce actuelle : <span class="uid">0B 00 00 02</span>. L\'historique est conservé ; les prochains scans viendront de la nouvelle puce.'));
  assert.ok(list.includes(`href="/chips/0B000001/associate/${id}?depuis=fiche"`));
  assert.ok(!list.includes('<form method="post" action="/chips/'), 'pas de remplacement sans confirmation');
  const confirm = (await page(`/chips/0B000001/associate/${id}?depuis=fiche`)).body;
  assert.ok(confirm.includes('<h1>Remplacer la puce de la fiche</h1>'));
  assert.ok(confirm.includes(`<a class="lien-annuler" href="/items/${id}/puce">Annuler</a>`));
  assert.ok(confirm.includes('<input type="hidden" name="depuis" value="fiche">'));
  assert.ok(confirm.includes(`<a href="/items/${id}">Alimentation</a>`), 'fil d\'Ariane vers la fiche');
  // 409 : la page de confirmation portait une autre puce que la puce actuelle.
  const before = auditCount();
  const stale = await post(`/chips/0B000001/associate/${id}`, { previous: '', depuis: 'fiche' });
  assert.equal(stale.status, 409);
  assert.ok(stale.body.includes(`<a class="lien-annuler" href="/items/${id}/puce">Annuler</a>`));
  assert.equal(auditCount(), before);
  const ok = await post(`/chips/0B000001/associate/${id}`, { previous: '0B000002', depuis: 'fiche' });
  assert.equal(ok.headers.location, `/items/${id}?ok=puce_remplacee`);
  assert.equal(getItem(db, id).uid_nfc, '0B000001');
});

test('donner une puce : une puce qui a déjà servi passe par la confirmation (avertissement de réutilisation)', async () => {
  const id = newItem('Clé dynamométrique');
  const list = (await page(`/items/${id}/puce`)).body;
  // 0B000002 a été remplacée sur « Alimentation » : elle a un ancien propriétaire.
  assert.ok(list.includes(`href="/chips/0B000002/associate/${id}?depuis=fiche"`));
  assert.ok(list.includes('a déjà servi pour une autre fiche'));
  assert.ok(chipPreviousOwners(db, ['0B000002', 'FFFFFFFF']).has('0B000002'));
  assert.ok(!chipPreviousOwners(db, ['0B000002', 'FFFFFFFF']).has('FFFFFFFF'));
  assert.ok(chipPreviousOwners(db, []).size === 0);
});

test(`donner une puce : au plus ${MAX_OFFERED_CHIPS} puces proposées, avec la mention`, async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'Clé dynamométrique'").get().id;
  for (let i = 0; i < MAX_OFFERED_CHIPS + 3; i++) scanAt(3, 3, (0x1C000000 + i).toString(16).toUpperCase(), T(600 + i));
  const list = (await page(`/items/${id}/puce`)).body;
  assert.equal((list.match(/Choisir cette puce/g) ?? []).length, MAX_OFFERED_CHIPS);
  assert.ok(list.includes(`Seules les ${MAX_OFFERED_CHIPS} puces scannées le plus récemment sont affichées.`));
});

test('retirer la puce : confirmation en une phrase, retrait audité, puce redevenue inconnue ; 409 si la puce a changé ; CSRF exigé', async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'Alimentation'").get().id;
  const confirm = await page(`/items/${id}/retirer-puce`);
  assert.equal(confirm.status, 200);
  assert.ok(confirm.body.includes('<p>La puce <span class="uid">0B 00 00 01</span> sera détachée de cette fiche et redeviendra inconnue.</p>'));
  assert.ok(confirm.body.includes(`<form method="post" action="/items/${id}/retirer-puce">`));
  assert.ok(confirm.body.includes('<input type="hidden" name="previous" value="0B000001">'));
  // Emplacement donné par un scan, à un poste : case « Garder … » cochée par défaut.
  assert.ok(confirm.body.includes('<input type="checkbox" id="garder" name="garder" value="1" checked aria-describedby="garder-aide"><span>Garder «&nbsp;Poste B&nbsp;» comme emplacement</span>'));
  assert.ok(confirm.body.includes('<input type="hidden" name="poste" value="2">'));
  assert.ok(confirm.body.includes('Sinon, l\'emplacement deviendra «&nbsp;jamais localisé&nbsp;».'));
  const before = auditCount();
  assert.equal((await post(`/items/${id}/retirer-puce`, { previous: '0B000001' }, { csrfField: null })).status, 403);
  const stale = await post(`/items/${id}/retirer-puce`, { previous: '0B000002' });
  assert.equal(stale.status, 409);
  assert.ok(stale.body.includes('La puce de la fiche a changé'));
  assert.equal(auditCount(), before);
  // Case décochée (champ garder absent) : l'objet perd l'emplacement donné par la puce.
  const res = await post(`/items/${id}/retirer-puce`, { previous: '0B000001', poste: '2' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/items/${id}?ok=puce_retiree`);
  assert.equal(getItem(db, id).uid_nfc, null);
  const last = db.prepare('SELECT user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual({ ...last, details: JSON.parse(last.details) }, {
    user_id: alice, action: 'item.chip_detach', entity_id: id, details: { previous_uid: '0B000001', name: 'Alimentation' },
  });
  assert.deepEqual(chipPreviousOwner(db, '0B000001'), { itemId: id, name: 'Alimentation', until: chipPreviousOwner(db, '0B000001').until, exists: true });
  const sheet = (await page(res.headers.location)).body;
  assert.ok(sheet.includes('<p class="succes" role="status">Puce retirée. Emplacement : jamais localisé.</p>'));
  // Frise : repère « Puce retirée », et les scans de la puce pendant sa période restent.
  assert.ok(frise(sheet).includes('<p class="frise-lieu">Puce retirée : <span class="uid">0B 00 00 01</span></p>'));
  assert.ok(!frise(sheet).includes('Emplacement actuel</span>'), 'plus d\'emplacement actuel');
  assert.ok(sheet.includes('<p class="modification-quoi">Puce retirée : <span class="uid">0B 00 00 01</span></p>'));
  assert.ok(sheet.includes(`href="/items/${id}/puce"`), '« Donner une puce » proposé');
  assert.ok((await page('/chips')).body.includes('0B 00 00 01'), 'de retour dans les puces inconnues');
  // Fiche sans puce : la page le dit, sans formulaire.
  const none = (await page(`/items/${id}/retirer-puce`)).body;
  assert.ok(none.includes('Cette fiche n\'a pas de puce : il n\'y a rien à retirer.'));
  assert.ok(!none.includes('action="/items/'));
  assert.deepEqual(detachChip(db, alice, id, null), { changed: true });
  assert.equal(detachChip(db, alice, 99999, 'AAAAAAAA'), 'no_item');
  assert.equal((await post('/items/99999/retirer-puce', { previous: 'AAAAAAAA' })).status, 404);
});

test('retirer la puce en gardant l\'emplacement : correction au même poste, à la même heure, dans la même transaction ; message', async () => {
  const id = newItem('Oscilloscope', '0D000001');
  scanAt(1, 1, '0D000001', T(700));
  const before = auditCount();
  const res = await post(`/items/${id}/retirer-puce`, { previous: '0D000001', garder: '1', poste: '1' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, `/items/${id}?ok=puce_retiree_gardee`);
  const rows = db.prepare('SELECT at, action, details FROM audit_log ORDER BY id DESC LIMIT 2').all().reverse();
  assert.deepEqual(rows.map((r) => r.action), ['item.location_correct', 'item.chip_detach']);
  assert.equal(rows[0].at, rows[1].at, 'même heure');
  assert.equal(auditCount(), before + 2);
  const item = getItem(db, id);
  assert.deepEqual([item.uid_nfc, item.station_name, item.source], [null, 'Poste A', 'manual']);
  const sheet = (await page(res.headers.location)).body;
  assert.ok(sheet.includes('<p class="succes" role="status">Puce retirée. Emplacement conservé : Poste A.</p>'));
  // Poste inexistant : rien n'est écrit (409, page réaffichée).
  const id2 = newItem('Sonde', '0D000002');
  scanAt(1, 1, '0D000002', T(710));
  const n = auditCount();
  assert.equal((await post(`/items/${id2}/retirer-puce`, { previous: '0D000002', garder: '1', poste: '999' })).status, 409);
  assert.equal((await post(`/items/${id2}/retirer-puce`, { previous: '0D000002', garder: '1', poste: 'x' })).status, 400);
  assert.equal(auditCount(), n);
  assert.equal(getItem(db, id2).uid_nfc, '0D000002');
});

test('retirer la puce : lecteur non affecté → pas de case, la phrase dit l\'emplacement qui restera ; corrigé à la main → inchangé', async () => {
  const id = newItem('Perceuse', '0D000003');
  scanAt(9, null, '0D000003', T(720));
  const unassigned = (await page(`/items/${id}/retirer-puce`)).body;
  assert.ok(!unassigned.includes('name="garder"'));
  assert.ok(unassigned.includes('L\'emplacement affiché deviendra «&nbsp;jamais localisé&nbsp;».'));
  correctLocation(db, alice, id, 3, new Date().toISOString());
  const manual = (await page(`/items/${id}/retirer-puce`)).body;
  assert.ok(!manual.includes('name="garder"'));
  assert.ok(manual.includes('L\'emplacement «&nbsp;Magasin&nbsp;», corrigé à la main, ne change pas.'));
});

test('frise : toutes les puces successives, chacune pendant sa période ; repères « Puce donnée », « Puce changée », « Puce retirée »', async () => {
  const id = newItem('Chariot', null, T(800));
  scanAt(1, 1, '0E000001', T(801)); // puce neuve, scannée avant d'être donnée
  assert.equal((await post(`/chips/0E000001/associate/${id}`, { previous: '' })).status, 303);
  scanAt(2, 2, '0E000001', new Date(Date.now() + 1000).toISOString());
  scanAt(2, 2, '0E000002', new Date(Date.now() + 2000).toISOString()); // nouvelle puce, vue avant d'être donnée
  await new Promise((r) => setTimeout(r, 2100));
  assert.equal((await post(`/chips/0E000002/associate/${id}`, { previous: '0E000001' })).status, 303);
  // L'ancienne puce, scannée ailleurs APRÈS le changement : n'apparaît plus dans la frise.
  scanAt(3, 3, '0E000001', new Date(Date.now() + 1000).toISOString());
  const { entries } = itemTimeline(db, getItem(db, id));
  const kinds = entries.map((e) => (e.type === 'chip' ? `puce:${e.change}` : e.type === 'scan' ? `scan:${e.station_name}:${e.uid}` : e.type));
  assert.deepEqual(kinds, ['puce:changee', 'scan:Poste B:0E000002', 'scan:Poste B:0E000001', 'puce:donnee', 'scan:Poste A:0E000001', 'creation']);
  assert.ok(entries.find((e) => e.uid === '0E000002' && e.type === 'scan').current, 'emplacement actuel : dernier scan de la puce actuelle');
  const html = (await page(`/items/${id}`)).body;
  assert.ok(frise(html).includes('<p class="frise-lieu">Puce changée : <span class="uid">0E 00 00 02</span> (remplace <span class="uid">0E 00 00 01</span>)</p>'));
  assert.ok(frise(html).includes('<span class="frise-noeud"><svg class="ic" aria-hidden="true"><use href="#i-puce"></use></svg></span>'));
  assert.ok(!frise(html).includes('Magasin'));
});

test('détails de présentation : en-tête « Scanné il y a … » ; panneau sans puce ; « Changer » à côté de la puce ; puce scannée à l\'instant', async () => {
  const id = newItem('Tournevis', '0F000001');
  scanAt(1, 1, '0F000001', new Date(Date.now() - 4 * 60_000).toISOString());
  const sheet = (await page(`/items/${id}`)).body;
  assert.match(sheet, /<span class="badge badge--ok"><svg[^>]*><use href="#i-lecteur"><\/use><\/svg>Scanné <time [^>]*>il y a 4 min<\/time><\/span>/);
  assert.ok(sheet.includes(`<a class="lien-simple lien-discret" href="/stations/1"><span class="etat etat-poste">Poste A</span></a>`));
  assert.ok(sheet.includes(`<a class="lien-simple" href="/items/${id}/puce">Changer</a>`));
  assert.ok(sheet.includes('Le prochain scan de l&#39;objet la remplacera.'));
  const noChip = newItem('Sans puce 2');
  const other = (await page(`/items/${noChip}`)).body;
  const dialog = /<dialog[\s\S]*?<\/dialog>/.exec(other)[0];
  assert.ok(dialog.includes('>La correction s&#39;applique tout de suite.</p>'));
  scanAt(1, 1, '0F000002', new Date().toISOString());
  assert.ok((await page(`/items/${noChip}/puce`)).body.includes('<span class="badge badge--ok">Scannée à l\'instant</span>'));
});

test('sans session : les nouvelles pages redirigent vers la connexion', async () => {
  for (const path of ['/items/1/historique', '/items/1/puce', '/items/1/retirer-puce']) {
    const res = await send({ path });
    assert.equal(res.status, 303, path);
    assert.equal(res.headers.location, '/login', path);
  }
});
