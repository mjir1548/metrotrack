// Vérification indépendante de l'étape U4 (accueil et direct), sur un serveur HTTPS réel avec
// les plafonds PAR DÉFAUT (50 flux, 8 par session) et de vraies trames chiffrées :
// - un lecteur silencieux (> 24 h, jamais, non affecté) qui scanne repasse « fonctionne » sur
//   l'accueil (HTML) et l'événement du direct porte son numéro (utilisé par app.js) ; un lecteur
//   désactivé n'apparaît jamais et sa trame (400) ne change rien ; seuil de 24 h aux bornes ;
// - mouvements : A, A, B, B, A → 3 mouvements (les rescans n'en sont pas) ; compteur plus ancien
//   (désordre) refusé sans événement ni mouvement ;
// - trames rejetées (malformée, vide, trop longue, tronquée, lecteur inconnu ou désactivé, rejeu,
//   compteur plus ancien, mauvaise clé) : rien n'est publié ;
// - aucun numéro de puce, clé ni compteur dans le flux ; un nom d'objet avec sauts de ligne ne
//   fabrique pas de ligne SSE ;
// - 50 flux ouverts (7 sessions) : le 51e reçoit 503 ; /api/frames reste réactif (204, latence
//   comparable) et chaque trame est livrée aux 50 flux ; 9e flux d'une session : le plus ancien
//   est fermé ;
// - un flux survit au-delà de requestTimeout (10 s) et reçoit encore les événements ;
// - Sec-Fetch-Site autre que same-origin → 403 ; /api/puces-inconnues : n invalide → 400 ;
// - /?q= : redirection vers /inventaire, sans injection d'en-tête ni redirection ouverte.
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
import { createItem } from '../server/items.js';
import { encodeFrame } from '../server/protocol.js';
import { recentMovements, readersHealth, SILENT_READER_MS } from '../server/accueil.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, certs, db, server, port, userId, token;
const KEYS = { 1: Buffer.alloc(32, 0x11), 2: Buffer.alloc(32, 0x22), 3: Buffer.alloc(32, 0x33), 4: Buffer.alloc(32, 0x44) };
const counters = { 1: 1, 2: 0, 3: 1, 4: 0, 99: 0 }; // 1 et 3 : compteur 1 déjà pris par un scan ancien
const UID_X = '04A1B2C3D4E5F6';
const UID_OLD = '04000000000001';
const UID_UNKNOWN = '04DEADBEEF0001';
const SECRETS = [UID_X, UID_OLD, UID_UNKNOWN, ...Object.values(KEYS).map((k) => k.toString('hex'))];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u4v-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const now = new Date().toISOString();
  const old = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('claire', DUMMY_HASH, now).lastInsertRowid);
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?), (2, 'Banc', ?)").run(now, now);
  // 1 : affecté, dernier scan il y a 25 h ; 2 : affecté, jamais ; 3 : non affecté, 30 h ; 4 : désactivé.
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?)')
    .run(KEYS[1], old(40), KEYS[2], old(40), KEYS[3], old(40));
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at, active) VALUES (4, 1, ?, ?, 0)').run(KEYS[4], old(40));
  db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, ?, 1, ?), (3, NULL, ?, 1, ?)')
    .run(UID_OLD, old(25), UID_OLD, old(30));
  const x = createItem(db, userId, { name: 'Multimètre', notes: '', properties: [] }, now);
  db.prepare('UPDATE items SET uid_nfc = ? WHERE id = ?').run(UID_X, x);
  token = createSession(db, userId);
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
const cookie = (t = token) => ({ Cookie: `__Host-mt_session=${t}` });
const page = (path) => send({ path, headers: cookie() });
const postBytes = (body) => send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body });
function frameBytes(readerId, uid, { counter, key = KEYS[readerId] ?? Buffer.alloc(32, 0x99) } = {}) {
  const c = counter ?? ++counters[readerId];
  return encodeFrame({ readerId, counter: c, uid: Buffer.from(uid, 'hex'), key });
}
const frame = (readerId, uid, options) => postBytes(frameBytes(readerId, uid, options));

/** Flux SSE : texte brut, événements « message » analysés, état fermé. */
function openStream({ t = token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/direct', headers: { ...cookie(t), ...headers }, ca: certs.ca, agent: false }, (res) => {
      const stream = { res, status: res.statusCode, headers: res.headers, raw: '', events: [], closed: false };
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.raw += chunk;
        pending += chunk;
        let cut;
        while ((cut = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          const lines = block.split('\n');
          const data = lines.filter((l) => l.startsWith('data: '));
          const named = lines.some((l) => l.startsWith('event: '));
          if (data.length > 0 && !named) stream.events.push({ lines, data: JSON.parse(data.map((l) => l.slice(6)).join('\n')) });
        }
      });
      res.on('close', () => { stream.closed = true; });
      stream.close = () => req.destroy();
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, ms = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('attente dépassée');
    await sleep(10);
  }
}
const silentIds = (html) => [...html.matchAll(/class="alerte-lecteur" data-lecteur="(\d+)"/g)].map((m) => Number(m[1])).sort();
const workingCount = (html) => Number(/id="lecteurs-ok" data-nombre="(\d+)"/.exec(html)?.[1]);

// ---------------------------------------------------------------- lecteurs silencieux

test('lecteur silencieux qui scanne → repasse « fonctionne » (accueil réel, trames réelles) ; désactivé ignoré, sa trame sans effet', async () => {
  const stream = await openStream();
  let html = (await page('/')).body;
  assert.deepEqual(silentIds(html), [1, 2, 3], 'silencieux : 25 h, jamais, non affecté 30 h ; le désactivé (4) absent');
  assert.equal(workingCount(html), 0);
  assert.match(html, /id="lecteurs-ok" data-nombre="0" hidden/);

  // Lecteur 1 (silencieux depuis 25 h) scanne un objet connu.
  assert.equal((await frame(1, UID_X)).status, 204);
  await until(() => stream.events.length === 1);
  assert.equal(stream.events[0].data.lecteur, 1, 'app.js retire l\'alerte grâce au numéro de lecteur');
  html = (await page('/')).body;
  assert.deepEqual(silentIds(html), [2, 3]);
  assert.equal(workingCount(html), 1);
  assert.match(html, /1 lecteur fonctionne/);

  // Lecteur 3 (non affecté, 30 h) scanne une puce INCONNUE : il fonctionne aussi.
  assert.equal((await frame(3, UID_UNKNOWN)).status, 204);
  await until(() => stream.events.length === 2);
  assert.equal(stream.events[1].data.lecteur, 3);
  assert.equal(stream.events[1].data.inconnu, true);
  html = (await page('/')).body;
  assert.deepEqual(silentIds(html), [2]);
  assert.equal(workingCount(html), 2);
  assert.match(html, /2 lecteurs fonctionnent/);

  // Lecteur désactivé : trame refusée, ni événement ni changement de l'accueil.
  assert.equal((await frame(4, UID_X)).status, 400);
  await sleep(150);
  assert.equal(stream.events.length, 2);
  const again = (await page('/')).body;
  assert.deepEqual(silentIds(again), [2]);
  assert.equal(workingCount(again), 2);
  stream.close();
});

test('seuil de silence : 24 h moins une minute → fonctionne ; 24 h plus une minute → silencieux', () => {
  const last = Date.parse(db.prepare('SELECT max(received_at) AS at FROM scans WHERE reader_id = 1').get().at);
  assert.ok(readersHealth(db, last + SILENT_READER_MS - 60_000).silent.every((r) => r.id !== 1));
  assert.ok(readersHealth(db, last + SILENT_READER_MS + 60_000).silent.some((r) => r.id === 1));
});

// ---------------------------------------------------------------- mouvements

test('mouvements (trames réelles) : A, A, B, B, A → 3 mouvements ; compteur plus ancien refusé sans effet', async () => {
  const item = db.prepare('SELECT id FROM items WHERE uid_nfc = ?').get(UID_X).id;
  const moves = () => recentMovements(db, 100).filter((m) => m.item_id === item);
  const before = moves().length; // 1 (scan précédent au lecteur 1 : Atelier)
  const stream = await openStream();
  for (const reader of [1, 2, 2, 1]) {
    assert.equal((await frame(reader, UID_X)).status, 204);
    await sleep(3);
  }
  await until(() => stream.events.length === 4);
  assert.deepEqual(stream.events.map((e) => e.data.deplacement), [false, true, false, true], '1er : rescan à l\'Atelier');
  const after = moves();
  assert.equal(after.length, before + 2);
  assert.deepEqual(after.slice(0, 3).map((m) => m.station_name), ['Atelier', 'Banc', 'Atelier']);
  const html = (await page('/')).body;
  assert.equal((html.match(/<li class="mouvement/g) ?? []).length, after.length, 'l\'accueil montre exactement les mouvements, pas les rescans');

  // Désordre : compteur 50 accepté, puis 40 (plus ancien) refusé.
  assert.equal((await frame(2, UID_X, { counter: 50 })).status, 204);
  counters[2] = 50;
  await until(() => stream.events.length === 5);
  assert.equal((await frame(2, UID_X, { counter: 40 })).status, 400);
  await sleep(150);
  assert.equal(stream.events.length, 5);
  assert.equal(moves().length, after.length + 1);
  stream.close();
});

// ---------------------------------------------------------------- trames rejetées

test('trames rejetées : aucune publication (malformée, vide, trop longue, tronquée, lecteur inconnu ou désactivé, rejeu, mauvaise clé)', async () => {
  const stream = await openStream();
  await until(() => stream.raw.includes(': ouvert'));
  const raw = stream.raw;
  const good = frameBytes(2, UID_X);
  counters[2] -= 1; // non envoyée
  const results = [
    await postBytes(Buffer.from('n importe quoi')),
    await postBytes(Buffer.alloc(0)),
    await postBytes(Buffer.alloc(65, 1)),
    await postBytes(good.subarray(0, good.length - 1)),
    await postBytes(Buffer.concat([good, Buffer.from([0])])),
    await frame(99, UID_X),
    await frame(4, UID_X),
    await frame(2, UID_X, { counter: counters[2] }),
    await frame(2, UID_X, { key: KEYS[1] }),
  ];
  for (const r of results) assert.ok(r.status === 400 || r.status === 413, `statut ${r.status}`);
  await sleep(200);
  assert.equal(stream.raw, raw, 'aucun octet publié');
  // Le serveur accepte toujours la trame suivante, et la publie.
  assert.equal((await frame(2, UID_X)).status, 204);
  await until(() => stream.events.length === 1);
  stream.close();
});

// ---------------------------------------------------------------- minimisation

test('flux : ni numéro de puce, ni clé, ni compteur ; nom avec sauts de ligne sans ligne SSE fabriquée', async () => {
  const evil = 'Pince\n\nevent: resynchro\ndata: {"x":1}\r\nid: 999';
  const id = createItem(db, userId, { name: 'tmp', notes: '', properties: [] }, new Date().toISOString());
  db.prepare("UPDATE items SET name = ?, uid_nfc = '04ABABABABAB01' WHERE id = ?").run(evil, id);
  const stream = await openStream();
  assert.equal((await frame(1, '04ABABABABAB01')).status, 204);
  assert.equal((await frame(1, UID_UNKNOWN)).status, 204);
  assert.equal((await frame(2, UID_X)).status, 204);
  await until(() => stream.events.length === 3);
  assert.equal(stream.events[0].data.nom, evil);
  assert.equal(stream.events[0].lines.length, 2, 'un bloc = « id: » + une seule ligne « data: »');
  // Le texte « event: resynchro » reste DANS la chaîne JSON (sauts de ligne échappés) : aucune
  // ligne du flux ne commence par « event: » ni par « id: 999 ».
  assert.ok(stream.raw.split('\n').every((l) => !l.startsWith('event:') && !l.startsWith('id: 999')), 'aucune ligne SSE fabriquée');
  for (const secret of [...SECRETS, '04ABABABABAB01']) assert.ok(!stream.raw.toUpperCase().includes(secret.toUpperCase()), `secret présent : ${secret}`);
  for (const e of stream.events) {
    assert.deepEqual(Object.keys(e.data).sort(), ['deplacement', 'inconnu', 'iso', 'itemId', 'lecteur', 'nom', 'par', 'poste', 'posteId', 'puces', 'type']);
  }
  stream.close();
});

// ---------------------------------------------------------------- plafonds par défaut

test('plafonds par défaut : 9e flux d\'une session → le plus ancien fermé ; 50 flux → 51e en 503 ; /api/frames réactif et livré aux 50 flux', async (t) => {
  // Référence : latence de /api/frames sans flux ouvert.
  await until(() => server.direct.size === 0);
  const timeFrames = async (n) => {
    const times = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      assert.equal((await frame(2, UID_X)).status, 204);
      times.push(performance.now() - t0);
    }
    return times.sort((a, b) => a - b)[Math.floor(n / 2)];
  };
  const baseline = await timeFrames(15);

  // Par session : le 9e ferme le 1er.
  const a = await openStream();
  const sessionA = [a];
  for (let i = 0; i < 8; i++) sessionA.push(await openStream());
  await until(() => a.closed);
  assert.equal(server.direct.size, 8);
  assert.ok(sessionA.slice(1).every((s) => !s.closed));

  // 50 au total (8 + 6 × 7), puis le 51e (nouvelle session) : 503.
  const streams = sessionA.slice(1);
  for (let s = 0; s < 6; s++) {
    const t = createSession(db, userId);
    for (let i = 0; i < 7; i++) streams.push(await openStream({ t }));
  }
  assert.equal(streams.length, 50);
  assert.ok(streams.every((s) => s.status === 200));
  assert.equal(server.direct.size, 50);
  const extra = await openStream({ t: createSession(db, userId) });
  assert.equal(extra.status, 503);
  assert.equal(extra.headers['retry-after'], '30');
  assert.equal(server.direct.size, 50);

  // /api/frames sous 50 flux : toujours 204, latence comparable, chaque trame livrée partout.
  const before = streams.map((s) => s.events.length);
  const loaded = await timeFrames(15);
  await until(() => streams.every((s, i) => s.events.length === before[i] + 15));
  assert.ok(loaded < baseline * 4 + 30, `médiane ${loaded.toFixed(1)} ms sous 50 flux, ${baseline.toFixed(1)} ms sans`);
  t.diagnostic(`/api/frames médiane : ${baseline.toFixed(1)} ms sans flux, ${loaded.toFixed(1)} ms sous 50 flux`);
  // Les pages restent servies.
  assert.equal((await send({ path: '/login' })).status, 200);
  for (const s of streams) s.close();
  await until(() => server.direct.size === 0);
});

// ---------------------------------------------------------------- longévité

test('un flux reste ouvert au-delà de requestTimeout (10 s) et reçoit encore les scans', { timeout: 30_000 }, async () => {
  const stream = await openStream();
  await sleep(12_000);
  assert.equal(stream.closed, false);
  assert.equal((await frame(2, UID_X)).status, 204);
  await until(() => stream.events.length === 1);
  stream.close();
});

// ---------------------------------------------------------------- contrôles d'accès

test('Sec-Fetch-Site : same-site, cross-site, none → 403 ; same-origin → accepté (direct et puces inconnues)', async () => {
  for (const site of ['same-site', 'cross-site', 'none']) {
    const d = await send({ path: '/api/direct', headers: { ...cookie(), 'Sec-Fetch-Site': site } });
    assert.equal(d.status, 403, `direct ${site}`);
    const p = await send({ path: '/api/puces-inconnues', headers: { ...cookie(), 'Sec-Fetch-Site': site } });
    assert.equal(p.status, 403, `puces ${site}`);
  }
  const ok = await openStream({ headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(ok.status, 200);
  ok.close();
  const p = await send({ path: '/api/puces-inconnues?n=1', headers: { ...cookie(), 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(p.status, 200);
  const body = JSON.parse(p.body);
  assert.equal(body.puces.length, 1);
  assert.equal(body.total, 2, 'UID_OLD et UID_UNKNOWN');
  assert.equal(p.headers['cache-control'], 'no-store');
});

test('/api/puces-inconnues : n invalide → 400 ; sans session → 401', async () => {
  for (const n of ['0', '21', 'abc', '-1', '1e1', '3.0', '', '001']) {
    const r = await page(`/api/puces-inconnues?n=${encodeURIComponent(n)}`);
    assert.equal(r.status, 400, `n=${JSON.stringify(n)}`);
  }
  assert.equal((await page('/api/puces-inconnues?n=20')).status, 200);
  assert.equal((await send({ path: '/api/puces-inconnues' })).status, 401);
  assert.equal((await send({ path: '/api/direct' })).status, 401);
});

test('/?q= : chemin fixe /inventaire, saisie encodée, pas d\'injection d\'en-tête ni de redirection ouverte', async () => {
  for (const [q, expected] of [
    ['//evil.example', '/inventaire?q=%2F%2Fevil.example'],
    ['https://evil.example/', '/inventaire?q=https%3A%2F%2Fevil.example%2F'],
    ['a\r\nSet-Cookie: x=1', null],
    ['', '/inventaire'],
    ['   ', '/inventaire'],
  ]) {
    const r = await page(`/?q=${encodeURIComponent(q)}`);
    assert.equal(r.status, 303, q);
    assert.ok(r.headers.location.startsWith('/inventaire'), r.headers.location);
    if (expected !== null) assert.equal(r.headers.location, expected);
    assert.equal(r.headers['set-cookie'], undefined);
  }
});
