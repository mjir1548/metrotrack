// Vérification de l'étape 7 (testeur) contre un vrai serveur HTTPS en processus, scans reçus
// par POST /api/frames comme depuis un boîtier. Complète puces-web.test.js :
// - parcours complet sur deux postes : création depuis une puce, remplacement de la puce d'une
//   fiche déjà localisée, ancienne puce de retour dans la liste avec son poste, scan ultérieur
//   de l'ancienne puce sans effet sur la fiche, journal des scans identique octet pour octet,
//   lignes d'audit exactes (auteur, fiche, détails) ;
// - lecteur non affecté : libellé et lien dans la liste, emplacement « lecteur non affecté » (avant l'étape U1 : « inconnue (lecteur n° X
//   non affecté) » après création ;
// - noms de fiche, de poste et saisies hostiles : échappés dans toutes les pages de l'étape ;
// - UID très long, identifiants de fiche hors format : 404 sans écriture ;
// - suppression d'une fiche pendant / avant une association : 404 propre, puce de retour ;
// - rafale de 10 associations simultanées d'une même puce : une seule réussite ;
// - correction manuelle plus récente ou plus ancienne que le dernier scan : avertissement de
//   la page de confirmation et localisation qui en résulte.
// Les tests s'enchaînent sur une même base (ordre du fichier).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-20T08:00:00.000Z';
const KEY = Buffer.alloc(32, 0x3c);
const HOSTILE = '<img src=x onerror=alert(1)>"\'&amp;';
const OLD = '04A1B2C3D4E5F6'; // puce de la fiche 1 au départ, scannée à l'Atelier
let dir, db, server, port, certs, token, csrf, origin, userId;
const served = [];
const logs = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-puces-verif-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  // Poste 3 : nom hostile (posé directement en base, l'échappement doit suffire).
  db.prepare('INSERT INTO stations (id, name, created_at) VALUES (1, \'Atelier\', ?), (2, \'Labo\', ?), (3, ?, ?)').run(NOW, NOW, `P${HOSTILE}`, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?), (4, 3, ?, ?)')
    .run(KEY, NOW, KEY, NOW, KEY, NOW, KEY, NOW);
  db.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, \'Multimètre\', ?, ?), (2, NULL, ?, ?, ?)')
    .run(OLD, NOW, NOW, `Objet ${HOSTILE}`, NOW, NOW);
  userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('bob', DUMMY_HASH, NOW).lastInsertRowid);
  token = createSession(db, userId);
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
const page = (path) => send({ path, headers: { Cookie: `__Host-mt_session=${token}` } });
function post(path, fields = []) {
  const params = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  params.append('csrf', csrf);
  return send({
    method: 'POST', path, body: params.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `__Host-mt_session=${token}`, Origin: origin },
  });
}

const counters = { 1: 0, 2: 0, 3: 0, 4: 0 };
async function scan(readerId, uid) {
  const res = await send({
    method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
    body: encodeFrame({ readerId, counter: ++counters[readerId], uid: Buffer.from(uid, 'hex'), key: KEY }),
  });
  assert.equal(res.status, 204);
  await sleep(3); // heures de réception strictement croissantes
}

const scansDump = () => JSON.stringify(db.prepare('SELECT * FROM scans ORDER BY id').all());
const snapshot = () => JSON.stringify(['items', 'audit_log', 'scans', 'location_corrections', 'stations', 'readers']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const auditSince = (id) => db.prepare('SELECT user_id, action, entity_id, details FROM audit_log WHERE id > ? ORDER BY id').all(id)
  .map((row) => ({ ...row, details: JSON.parse(row.details) }));
const lastAuditId = () => db.prepare('SELECT coalesce(max(id), 0) AS n FROM audit_log').get().n;
const location = (itemId) => ({ ...db.prepare('SELECT station_id, source, reader_id FROM item_locations WHERE item_id = ?').get(itemId) });
// Une carte par puce depuis l'étape U1, numéro groupé par octets.
const grouped = (uid) => uid.match(/../g).join(' ');
const chipRow = (html, uid) => (/<ul class="carte liste-puces">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '')
  .split('<li class="encart">').find((row) => row.includes(`<p class="encart-texte">Puce <span class="uid">${grouped(uid)}</span></p>`)) ?? null;
const createdId = (res) => Number(/^\/items\/(\d+)\?ok=/.exec(res.headers.location)?.[1]);

// ---------------------------------------------------------------- parcours complet

test('parcours : puce inconnue → fiche créée, localisée tout de suite ; puce retirée de la liste ; audit exact', async () => {
  const uid = 'AABBCCDD';
  await scan(1, uid);
  await scan(1, uid);
  const row = chipRow((await page('/chips')).body, uid);
  assert.ok(row, 'puce listée');
  assert.match(row, /<span class="etat etat-poste">Atelier<\/span>/);
  assert.match(row, / · 2 scans<\/p>/);
  assert.match(row, /<time datetime="\d{4}-\d\d-\d\dT[\d:.]+Z"/);

  const dump = scansDump();
  const auditId = lastAuditId();
  const res = await post(`/chips/${uid}/new`, [['name', 'Oscilloscope'], ['notes', 'n'], ['prop_key', 'Marque'], ['prop_value', 'Tek']]);
  assert.equal(res.status, 303);
  const id = createdId(res);
  assert.equal(res.headers.location, `/items/${id}?ok=cree_puce`);
  assert.deepEqual(location(id), { station_id: 1, source: 'scan', reader_id: 1 });
  assert.equal(scansDump(), dump);
  assert.deepEqual(auditSince(auditId), [{
    user_id: userId, action: 'item.create', entity_id: id,
    details: { name: 'Oscilloscope', properties: { Marque: 'Tek' }, notes: 'n', uid },
  }]);
  const item = await page(`/items/${id}?ok=cree_puce`);
  assert.ok(item.body.includes(`Fiche créée avec la puce <span class="uid">${grouped(uid)}</span>`));
  assert.equal(chipRow((await page('/chips')).body, uid), null);
});

test('parcours : remplacement de la puce d\'une fiche localisée ; la fiche suit la nouvelle ; l\'ancienne revient avec son poste ; journal intact', async () => {
  const NEW = '04112233445566';
  await scan(1, OLD); // fiche 1 à l'Atelier par son ancienne puce
  await scan(2, NEW); // nouvelle puce au Labo
  assert.deepEqual(location(1), { station_id: 1, source: 'scan', reader_id: 1 });

  const confirm = await page(`/chips/${NEW}/associate/1`);
  assert.equal(confirm.status, 200);
  assert.ok(confirm.body.includes('panneau-danger'));
  assert.ok(confirm.body.includes(`porte déjà une puce</strong> (<span class="uid">${grouped(OLD)}</span>)`));
  assert.ok(confirm.body.includes(`<input type="hidden" name="previous" value="${OLD}">`));
  assert.ok(confirm.body.includes('Labo'));

  const dump = scansDump();
  const auditId = lastAuditId();
  const res = await post(`/chips/${NEW}/associate/1`, { previous: OLD });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/items/1?ok=puce_remplacee');
  assert.equal(scansDump(), dump, 'journal des scans identique octet pour octet');
  assert.deepEqual(auditSince(auditId), [{
    user_id: userId, action: 'item.chip_associate', entity_id: 1,
    details: { uid: NEW, previous_uid: OLD, name: 'Multimètre' },
  }]);
  assert.deepEqual(location(1), { station_id: 2, source: 'scan', reader_id: 2 });
  const item = await page('/items/1');
  assert.ok(item.body.includes(`Puce associée : <span class="uid">${grouped(NEW)}</span> (remplace <span class="uid">${grouped(OLD)}</span>)`));

  const list = (await page('/chips')).body;
  assert.equal(chipRow(list, NEW), null);
  const oldRow = chipRow(list, OLD);
  assert.ok(oldRow, 'ancienne puce de retour');
  assert.match(oldRow, /<span class="etat etat-poste">Atelier<\/span>/);
  assert.match(oldRow, / · 1 scan<\/p>/);

  // Un scan ultérieur de l'ancienne puce ne déplace plus la fiche.
  await scan(1, OLD);
  assert.deepEqual(location(1), { station_id: 2, source: 'scan', reader_id: 2 });
  assert.match(chipRow((await page('/chips')).body, OLD), / · 2 scans<\/p>/);
});

test('lecteur non affecté : libellé et lien dans la liste et le formulaire ; fiche créée « lecteur non affecté »', async () => {
  const uid = 'DEADBEEF';
  await scan(3, uid);
  const row = chipRow((await page('/chips')).body, uid);
  assert.ok(row.includes('<a class="lien-etat" href="/readers/3"><span class="etat etat-inconnue">lecteur non affecté</span></a>'), row);
  const form = await page(`/chips/${uid}/new`);
  assert.ok(form.body.includes('<a class="lien-simple" href="/readers/3">lecteur non affecté</a>'));
  const res = await post(`/chips/${uid}/new`, { name: 'Pince' });
  const id = createdId(res);
  assert.deepEqual(location(id), { station_id: null, source: 'scan', reader_id: 3 });
  assert.ok((await page(`/items/${id}`)).body.includes('<a class="lien-etat" href="/readers/3"><span class="etat etat-inconnue">lecteur non affecté</span></a>'));
  assert.equal((await page('/readers/3')).status, 200);
});

// ---------------------------------------------------------------- échappement

test('noms de fiche et de poste hostiles, saisie hostile en erreur : échappés dans toutes les pages de l\'étape', async () => {
  const uid = 'FEEDFACE';
  await scan(4, uid); // poste au nom hostile
  const pages = [
    await page('/chips'),
    await page(`/chips/${uid}/new`),
    await page(`/chips/${uid}/associate`),
    await page(`/chips/${uid}/associate?q=${encodeURIComponent('<img')}`),
    await page(`/chips/${uid}/associate/2`),
    await post(`/chips/${uid}/new`, [['name', ''], ['notes', `note ${HOSTILE}`], ['prop_key', `k${HOSTILE}`], ['prop_value', `v${HOSTILE}`]]),
    await post(`/chips/${uid}/associate/2`, { previous: OLD }), // 409 : page réaffichée
  ];
  assert.deepEqual(pages.map((r) => r.status), [200, 200, 200, 200, 200, 400, 409]);
  for (const r of pages) {
    assert.doesNotMatch(r.body, /<img|onerror=alert\(1\)>/, `${r.method} ${r.path}`);
    assert.ok(r.body.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;amp;'), `${r.method} ${r.path}`);
  }
  // Formulaire en erreur : saisie conservée (échappée) et UID toujours affiché, en lecture seule.
  const failed = pages[5].body;
  assert.ok(failed.includes(`<span class="uid">${grouped(uid)}</span>`));
  assert.ok(failed.includes(`action="/chips/${uid}/new"`));
  assert.ok(failed.includes('note &lt;img'));
  assert.ok(failed.includes('value="k&lt;img'));
  assert.ok(failed.includes('value="v&lt;img'));
  // Puce déjà associée : la page 409 n'affiche que des valeurs sûres.
  await post(`/chips/${uid}/associate/2`, { previous: '' });
  const known = await page(`/chips/${uid}/new`);
  assert.equal(known.status, 409);
  assert.ok(known.body.includes('href="/items/2"'));
});

// ---------------------------------------------------------------- garde-fous

test('UID très long et identifiants de fiche hors format → 404, aucune écriture', async () => {
  const uid = '0A0A0A0A';
  await scan(1, uid);
  const before = snapshot();
  for (const bad of ['A'.repeat(8000), 'A'.repeat(21), `${uid}%2F`, `${uid}/`]) {
    for (const path of [`/chips/${bad}/new`, `/chips/${bad}/associate`, `/chips/${bad}/associate/2`]) {
      assert.equal((await page(path)).status, 404, path.slice(0, 40));
    }
    assert.equal((await post(`/chips/${bad}/new`, { name: 'x' })).status, 404);
  }
  for (const id of ['9'.repeat(17), '9223372036854775808', '1e3', '+1', '0x1', '%31', '1%00', '2%2F']) {
    assert.equal((await page(`/chips/${uid}/associate/${id}`)).status, 404, id);
    assert.equal((await post(`/chips/${uid}/associate/${id}`, { previous: '' })).status, 404, id);
  }
  assert.equal(snapshot(), before);
});

test('suppression : association pendant la suppression sans 500 ; après suppression 404 sans écriture ; la puce revient', async () => {
  const uid = '99AABBCC';
  await scan(2, uid);
  const victim = createdId(await post('/items/new', { name: 'Victime' }));
  const [del, asso] = await Promise.all([
    post(`/items/${victim}/delete`),
    post(`/chips/${uid}/associate/${victim}`, { previous: '' }),
  ]);
  assert.equal(del.status, 303);
  assert.ok([303, 404].includes(asso.status), String(asso.status));
  const before = snapshot();
  const again = await post(`/chips/${uid}/associate/${victim}`, { previous: '' });
  assert.equal(again.status, 404);
  assert.ok(again.body.includes('<h1>Fiche introuvable</h1>'));
  assert.equal((await page(`/chips/${uid}/associate/${victim}`)).status, 404);
  assert.equal(snapshot(), before);
  assert.ok(chipRow((await page('/chips')).body, uid), 'puce de nouveau inconnue');

  // Fiche créée depuis une puce, puis supprimée : la puce revient dans la liste, ses scans restent.
  const uid2 = '0F0F0F0F';
  await scan(1, uid2);
  const dump = scansDump();
  const id = createdId(await post(`/chips/${uid2}/new`, { name: 'Éphémère' }));
  assert.equal(chipRow((await page('/chips')).body, uid2), null);
  assert.equal((await post(`/items/${id}/delete`)).status, 303);
  assert.match(chipRow((await page('/chips')).body, uid2), / · 1 scan<\/p>/);
  assert.equal(scansDump(), dump);
});

test('rafale : 10 associations simultanées d\'une même puce vers 10 fiches → une seule réussite, 9 × 409, une ligne d\'audit', async () => {
  const uid = '55667788';
  await scan(1, uid);
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(createdId(await post('/items/new', { name: `Rafale ${i}` })));
  const auditId = lastAuditId();
  const results = await Promise.all(ids.map((id) => post(`/chips/${uid}/associate/${id}`, { previous: '' })));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [303, ...Array(9).fill(409)]);
  const rows = auditSince(auditId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'item.chip_associate');
  assert.equal(db.prepare('SELECT id FROM items WHERE uid_nfc = ?').get(uid).id, rows[0].entity_id);
});

// ---------------------------------------------------------------- correction manuelle

test('correction manuelle plus récente que le scan : signalée à la confirmation, garde la priorité, puis le scan suivant l\'emporte', async () => {
  const uid = '0B0B0B0B';
  await scan(1, uid);
  const id = createdId(await post('/items/new', { name: 'Corrigé' }));
  await sleep(3);
  assert.equal((await post(`/items/${id}/location`, { station: '2' })).status, 303);
  const confirm = await page(`/chips/${uid}/associate/${id}`);
  assert.ok(confirm.body.includes('Une correction manuelle d\'emplacement plus récente que ce scan existe'));
  assert.equal((await post(`/chips/${uid}/associate/${id}`, { previous: '' })).status, 303);
  assert.deepEqual(location(id), { station_id: 2, source: 'manual', reader_id: null });
  await scan(1, uid);
  assert.deepEqual(location(id), { station_id: 1, source: 'scan', reader_id: 1 });
});

test('correction manuelle plus ancienne que le scan : aucun avertissement, le scan de la puce l\'emporte', async () => {
  const uid = '0C0C0C0C';
  const id = createdId(await post('/items/new', { name: 'Corrigé avant' }));
  assert.equal((await post(`/items/${id}/location`, { station: '2' })).status, 303);
  await sleep(3);
  await scan(1, uid);
  const confirm = await page(`/chips/${uid}/associate/${id}`);
  assert.ok(!confirm.body.includes('Une correction manuelle de localisation plus récente'));
  assert.equal((await post(`/chips/${uid}/associate/${id}`, { previous: '' })).status, 303);
  assert.deepEqual(location(id), { station_id: 1, source: 'scan', reader_id: 1 });
});

// ---------------------------------------------------------------- réutilisation (aller-retour 2)

test('réutilisation : nom hostile échappé ; après plusieurs propriétaires, le plus récent est indiqué ; suppression sans puce : aucune mention', async () => {
  const uid = '0E0E0E0E';
  await scan(1, uid);
  const first = createdId(await post(`/chips/${uid}/new`, { name: `Ancienne ${HOSTILE}` }));
  assert.equal((await post(`/items/${first}/delete`)).status, 303);
  const warned = await page(`/chips/${uid}/new`);
  const block = /<div class="panneau panneau-alerte panneau-reutilisation"[\s\S]*?<\/div>/.exec(warned.body)?.[0] ?? '';
  assert.ok(block.includes(`«&nbsp;Ancienne &lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;amp;&nbsp;» (n° ${first}, supprimée depuis)`), block);
  assert.doesNotMatch(warned.body, /<img/);

  // La puce passe sur une 2e fiche, puis en est détachée par une autre puce : c'est elle qui est citée.
  const second = createdId(await post('/items/new', { name: 'Seconde' }));
  assert.equal((await post(`/chips/${uid}/associate/${second}`, { previous: '' })).status, 303);
  await scan(2, '0E0E0E0F');
  assert.equal((await post(`/chips/0E0E0E0F/associate/${second}`, { previous: uid })).status, 303);
  const latest = await page(`/chips/${uid}/associate/${first + 1000}`); // fiche absente : 404, avertissement non concerné
  assert.equal(latest.status, 404);
  const again = await page(`/chips/${uid}/new`);
  assert.ok(again.body.includes(`<a href="/items/${second}">«&nbsp;Seconde&nbsp;» (n° ${second})</a>`));
  assert.ok(again.body.includes('Son scan enregistré sera rattaché à la nouvelle fiche')); // un seul scan de cette puce
  assert.ok(!again.body.includes(`(n° ${first}, supprimée depuis)`));

  const bare = createdId(await post('/items/new', { name: 'Sans puce' }));
  const del = await page(`/items/${bare}/delete`);
  assert.equal(del.status, 200);
  assert.ok(!del.body.includes('sera détachée'));
});

// ---------------------------------------------------------------- bilan

test('aucune réponse 500, aucune erreur interne, aucune URL externe dans les pages servies', () => {
  assert.ok(!served.some((r) => r.status >= 500), served.filter((r) => r.status >= 500).map((r) => r.path).join(', '));
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));
  for (const r of served.filter((x) => (x.headers['content-type'] ?? '').startsWith('text/html'))) {
    assert.doesNotMatch(r.body, /https?:|(?:src|href|action)="\/\//i, `${r.method} ${r.path}`);
  }
});
