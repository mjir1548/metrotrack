// Vérification indépendante de l'étape U3 (fiche objet).
// - frise alimentée par de VRAIES trames chiffrées reçues en HTTPS (POST /api/frames) : A→B→B→A,
//   correction puis scans, lecteur non affecté ; une trame rejetée (rejeu, lecteur inconnu ou
//   désactivé, trame tronquée, mauvaise clé) ne change ni la frise ni l'emplacement ;
// - pagination exhaustive par-delà la borne de lecture (SCAN_WINDOW) : scans et corrections
//   mêlés, y compris à la même milliseconde ; en parcourant toutes les pages, chaque scan et
//   chaque correction est compté exactement une fois, dans l'ordre, sans boucle infinie ;
// - routes : méthodes refusées, fiches inexistantes, retrait sur fiche sans puce (409) ;
// - coût : fiche sans puce à 5 000 corrections, « Donner une puce » avec 5 000 puces inconnues
//   et un journal des modifications de 20 000 lignes.
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
import { getItem } from '../server/inventory.js';
import { createItem } from '../server/items.js';
import { itemTimeline, parseCursor, SCAN_WINDOW } from '../server/timeline.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, db, server, port, certs, token, csrf, origin, userId;
const KEYS = { 1: Buffer.alloc(32, 0x11), 2: Buffer.alloc(32, 0x22), 3: Buffer.alloc(32, 0x33), 4: Buffer.alloc(32, 0x44) };
const counters = { 1: 0, 2: 0, 3: 0, 4: 0, 99: 0 };
const T0 = Date.parse('2026-11-20T08:00:00.000Z');
const iso = (ms) => new Date(T0 + ms).toISOString();

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u3v-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const now = iso(0);
  userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('claire', DUMMY_HASH, now).lastInsertRowid);
  for (const [id, name] of [[1, 'Atelier'], [2, 'Banc'], [3, 'Magasin']]) {
    db.prepare('INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?)').run(id, name, now);
  }
  // Lecteurs 1 et 2 affectés ; 3 non affecté ; 4 désactivé.
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?)')
    .run(KEYS[1], now, KEYS[2], now, KEYS[3], now);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at, active) VALUES (4, 1, ?, ?, 0)').run(KEYS[4], now);
  token = createSession(db, userId);
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
const cookie = () => ({ Cookie: `__Host-mt_session=${token}` });
const page = (path) => send({ path, headers: cookie() });
const post = (path, fields = {}) => send({
  method: 'POST', path, body: new URLSearchParams({ csrf, ...fields }).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...cookie() },
});
/** Trame v0 chiffrée envoyée comme un boîtier (compteur suivant du lecteur, sauf counter imposé). */
function frame(readerId, uid, { counter, key = KEYS[readerId] ?? Buffer.alloc(32), mutate } = {}) {
  const c = counter ?? ++counters[readerId];
  let body = encodeFrame({ readerId, counter: c, uid: Buffer.from(uid, 'hex'), key });
  if (mutate) body = mutate(body);
  return send({ method: 'POST', path: '/api/frames', body, headers: { 'Content-Type': 'application/octet-stream' } });
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 3)); // heures de réception distinctes
const visible = (s) => s.replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ').trim();
const steps = (html) => (/<ol class="frise[^"]*">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '')
  .split('</li>').filter((s) => s.includes('<li')).map(visible);

test('trames réelles : A→B→B→A, correction puis scan, lecteur non affecté ; trames rejetées sans effet sur la frise', async () => {
  const UID = '04A1B2C3D4E5F6';
  const id = createItem(db, userId, { name: 'Multimètre', notes: '', properties: [] }, iso(0));
  db.prepare('UPDATE items SET uid_nfc = ? WHERE id = ?').run(UID, id);

  for (const reader of [1, 2, 2, 1]) {
    assert.equal((await frame(reader, UID)).status, 204);
    await pause();
  }
  let s = steps((await page(`/items/${id}`)).body);
  assert.equal(s.length, 4, s.join(' | '));
  assert.match(s[0], /Atelier Scanné Emplacement actuel/);
  assert.match(s[1], /Banc Scanné 2 scans ici/);
  assert.match(s[2], /Atelier Scanné/);
  assert.match(s[3], /Fiche créée par claire/);

  // Trames rejetées (toutes 400) : rejeu du dernier compteur, lecteur inconnu, lecteur désactivé,
  // mauvaise clé, trame tronquée, octet du tag modifié. Rien ne change.
  const before = (await page(`/items/${id}`)).body;
  const scansBefore = db.prepare('SELECT count(*) AS n FROM scans').get().n;
  const rejected = [
    await frame(1, UID, { counter: counters[1] }),
    await frame(99, UID, { key: Buffer.alloc(32, 0x99) }),
    await frame(4, UID),
    await frame(2, UID, { key: Buffer.alloc(32, 0x01) }),
    await frame(2, UID, { mutate: (b) => b.subarray(0, b.length - 1) }),
    await frame(2, UID, { mutate: (b) => { const c = Buffer.from(b); c[c.length - 1] ^= 1; return c; } }),
    await frame(2, UID, { mutate: (b) => Buffer.concat([b, Buffer.alloc(1)]) }),
  ];
  assert.deepEqual(rejected.map((r) => r.status), [400, 400, 400, 400, 400, 400, 400]);
  assert.equal(db.prepare('SELECT count(*) AS n FROM scans').get().n, scansBefore);
  assert.deepEqual(steps((await page(`/items/${id}`)).body), steps(before));

  // Correction (formulaire, même POST que le panneau), puis un scan : nouvelle arrivée en tête.
  await pause();
  const corrected = await post(`/items/${id}/location`, { station: '3' });
  assert.equal(corrected.status, 303);
  s = steps((await page(corrected.headers.location)).body);
  assert.match(s[0], /Magasin Corrigé à la main par claire Emplacement actuel/);
  await pause();
  assert.equal((await frame(1, UID)).status, 204);
  s = steps((await page(`/items/${id}`)).body);
  assert.match(s[0], /Atelier Scanné Emplacement actuel/);
  assert.match(s[1], /Magasin Corrigé à la main/);
  assert.doesNotMatch(s[1], /Emplacement actuel/);

  // Lecteur non affecté : un emplacement à part, en tête et dans l'en-tête.
  await pause();
  assert.equal((await frame(3, UID)).status, 204);
  const body = (await page(`/items/${id}`)).body;
  s = steps(body);
  assert.match(s[0], /non affecté/i);
  assert.match(s[1], /Atelier Scanné/);
  assert.equal(s.length, 7, s.join(' | '));
});

test('trames réelles dans le désordre d\'arrivée et rapprochées : la frise suit l\'heure de RÉCEPTION, compteurs croissants exigés', async () => {
  const UID = '04B1B2C3D4E5F6';
  const id = createItem(db, userId, { name: 'Oscilloscope', notes: '', properties: [] }, iso(0));
  db.prepare('UPDATE items SET uid_nfc = ? WHERE id = ?').run(UID, id);
  // Lecteur 2 : compteur 1000 reçu, puis 999 (plus ancien, arrivé en retard) → refusé (anti-rejeu).
  counters[2] = 999;
  assert.equal((await frame(2, UID, { counter: 1000 })).status, 204);
  assert.equal((await frame(2, UID, { counter: 999 })).status, 400);
  counters[2] = 1000;
  // Rafale de 10 trames en parallèle sur deux lecteurs : toutes acceptées, regroupées par poste.
  const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => frame(i % 2 === 0 ? 1 : 2, UID)));
  assert.ok(burst.every((r) => r.status === 204), burst.map((r) => r.status).join(','));
  const timeline = itemTimeline(db, getItem(db, id));
  const total = timeline.entries.filter((e) => e.type === 'scan').reduce((n, e) => n + e.count, 0);
  assert.equal(total, 11);
  assert.equal(timeline.entries.at(-1).type, 'creation');
});

test('pagination exhaustive par-delà SCAN_WINDOW : scans et corrections mêlés (mêmes millisecondes), chaque événement une seule fois, ordre strict', () => {
  const UID = '0A0B0C0D';
  const id = createItem(db, userId, { name: 'Voyageur', notes: '', properties: [] }, iso(0));
  db.prepare('UPDATE items SET uid_nfc = ? WHERE id = ?').run(UID, id);
  const insertScan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const insertCorr = db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, ?, ?)');
  // Pseudo-aléatoire déterministe.
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const SCANS = SCAN_WINDOW * 2 + 777;
  const CORRS = SCAN_WINDOW + 333;
  let station = 1;
  let t = 1000;
  let corrLeft = CORRS;
  db.exec('BEGIN');
  for (let i = 0; i < SCANS; i++) {
    if (rnd(4) === 0) station = 1 + rnd(3); // changements de poste fréquents
    if (rnd(3) !== 0) t += 1; // une partie des scans partage la même milliseconde
    insertScan.run(station, station === 3 ? null : station, UID, 100_000 + i, iso(t));
    if (corrLeft > 0 && rnd(2) === 0) {
      insertCorr.run(id, 1 + rnd(3), userId, iso(t)); // même milliseconde que le scan
      corrLeft--;
    }
  }
  for (; corrLeft > 0; corrLeft--) insertCorr.run(id, 1, userId, iso(++t));
  db.exec('COMMIT');

  const item = getItem(db, id);
  for (const limit of [7, 50]) {
    let cursor = null;
    let scans = 0;
    let corrections = 0;
    let previous = null;
    let lastKeyTime = '~';
    let pages = 0;
    for (;;) {
      const p = itemTimeline(db, item, { cursor, limit });
      assert.ok(p.entries.length > 0, 'page vide');
      for (const e of p.entries) {
        if (e.type === 'scan') {
          scans += e.count;
          // Deux étapes consécutives de scans au même endroit : seulement après une étape bornée.
          if (previous?.type === 'scan' && previous.station_id === e.station_id) assert.ok(previous.bounded, `doublon de poste à la page ${pages}`);
          assert.ok(e.arrived_at <= lastKeyTime, 'ordre');
          lastKeyTime = e.arrived_at;
        } else if (e.type === 'correction') {
          corrections++;
          assert.ok(e.at <= lastKeyTime, 'ordre');
          lastKeyTime = e.at;
        }
        previous = e;
      }
      pages++;
      assert.ok(pages < 10_000, 'boucle infinie de pagination');
      if (p.next === null) break;
      const next = parseCursor(p.next);
      assert.notEqual(next, null, 'curseur produit illisible');
      cursor = next;
    }
    assert.equal(scans, SCANS, `limite ${limit} : scans comptés`);
    assert.equal(corrections, CORRS, `limite ${limit} : corrections comptées`);
    assert.equal(previous.type, 'creation');
  }
});

test('routes U3 : méthodes refusées (405), fiches inexistantes (404), retrait sur fiche sans puce → 409 sans écriture', async () => {
  const id = createItem(db, userId, { name: 'Sans puce', notes: '', properties: [] }, iso(0));
  assert.equal((await post(`/items/${id}/puce`, {})).status, 405);
  assert.equal((await post(`/items/${id}/historique`, {})).status, 405);
  for (const path of ['/items/999999/puce', '/items/999999/retirer-puce', '/items/999999/historique', '/items/0/puce', '/items/abc/historique']) {
    assert.equal((await page(path)).status, 404, path);
  }
  assert.equal((await post('/items/999999/retirer-puce', { previous: '04A1B2C3D4E5F6' })).status, 404);
  const audits = db.prepare('SELECT count(*) AS n FROM audit_log').get().n;
  const r = await post(`/items/${id}/retirer-puce`, { previous: '' });
  assert.equal(r.status, 409);
  const r2 = await post(`/items/${id}/retirer-puce`, {});
  assert.equal(r2.status, 409);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit_log').get().n, audits);
  assert.match(visible((await page(`/items/${id}/retirer-puce`)).body), /rien à retirer/);
  // Curseur dupliqué : seul le premier compte (URLSearchParams.get) ; un second invalide n'y change rien.
  const ok = await page(`/items/${id}/historique?avant=2026-11-20T08:00:00.000Z%7C0%7C0000000000000000001&avant=x`);
  assert.equal(ok.status, 200);
});

test('coût : fiche sans puce à 5 000 corrections, et « Donner une puce » avec 5 000 puces inconnues et 20 000 lignes d\'audit', async (t) => {
  const id = createItem(db, userId, { name: 'Très corrigé', notes: '', properties: [] }, iso(0));
  const insertCorr = db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, ?, ?)');
  const insertScan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const insertAudit = db.prepare('INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < 5000; i++) insertCorr.run(id, 1 + (i % 3), userId, iso(10_000_000 + i));
  for (let i = 0; i < 5000; i++) insertScan.run(1, 1, `F${String(i).padStart(7, '0')}`, 500_000 + i, iso(20_000_000 + i));
  for (let i = 0; i < 20_000; i++) {
    insertAudit.run(iso(i), userId, 'item.chip_associate', id, JSON.stringify({ uid: `E${String(i).padStart(7, '0')}`, previous_uid: `D${String(i).padStart(7, '0')}` }));
  }
  db.exec('COMMIT');
  const timed = async (path) => {
    let best = Infinity;
    let res;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      res = await page(path);
      best = Math.min(best, performance.now() - start);
    }
    return { res, ms: best };
  };
  const fiche = await timed(`/items/${id}`);
  assert.equal(fiche.res.status, 200);
  assert.equal(steps(fiche.res.body).length, 30);
  const puce = await timed(`/items/${id}/puce`);
  assert.equal(puce.res.status, 200);
  const hist = await timed(`/items/${id}/historique`);
  t.diagnostic(`fiche ${fiche.ms.toFixed(1)} ms ; donner une puce ${puce.ms.toFixed(1)} ms ; historique ${hist.ms.toFixed(1)} ms`);
  for (const [name, { ms }] of [['fiche', fiche], ['puce', puce], ['historique', hist]]) assert.ok(ms < 1000, `${name} : ${ms} ms`);
});
