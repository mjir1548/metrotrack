// Étape U3 : la fiche et sa frise restent rapides sur un gros journal (300 000 scans).
//   - objet A : 200 000 scans, un changement de poste tous les 4 scans (beaucoup de déplacements) ;
//   - objet B : 100 000 scans au même poste (puce posée sur un lecteur : une seule série).
// Les lectures de la frise sont bornées (server/timeline.js, SCAN_WINDOW) : le temps ne doit pas
// dépendre de la taille du journal. Mesures affichées en diagnostic.
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
import { makeTestCerts } from './tls-fixture.js';

const A_SCANS = 200_000;
const B_SCANS = 100_000;
const MAX_MS = 400;
const CHIPS = 40; // objet C : puces successives
const PER_CHIP = 500; // budget large (machine de test chargée) ; mesure réelle en diagnostic
let dir, db, server, port, certs, token;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u3-charge-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const now = new Date(T0).toISOString();
  const user = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, now).lastInsertRowid);
  token = createSession(db, user);
  db.exec('BEGIN');
  for (let s = 1; s <= 4; s++) {
    db.prepare('INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?)').run(s, `Poste ${s}`, now);
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (?, ?, ?, ?)').run(s, s, Buffer.alloc(32), now);
  }
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, 'AAAA0001', 'Objet A', ?, ?), (2, 'BBBB0002', 'Objet B', ?, ?)").run(now, now, now, now);
  const insert = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const counters = [0, 0, 0, 0, 0];
  for (let i = 0; i < A_SCANS + B_SCANS; i++) {
    const isA = i % 3 !== 2; // entrelacés dans le journal
    const station = isA ? 1 + (Math.floor(i / 4) % 4) : 2;
    insert.run(station, station, isA ? 'AAAA0001' : 'BBBB0002', ++counters[station], new Date(T0 + i * 1000).toISOString());
  }
  // Objet C : ${CHIPS} puces successives (remplacements journalisés), ${PER_CHIP} scans chacune, et
  // des scans de chaque ancienne puce APRÈS son remplacement (à exclure de la frise).
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (3, NULL, 'Objet C', ?, ?)").run(now, now);
  const audit = db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, ?, 'item.chip_associate', 3, ?)");
  let t = T0 + (A_SCANS + B_SCANS) * 1000;
  let previous = null;
  for (let c = 0; c < CHIPS; c++) {
    const uid = (0xC0000000 + c).toString(16).toUpperCase();
    audit.run(new Date(t).toISOString(), user, JSON.stringify({ uid, previous_uid: previous, name: 'Objet C' }));
    for (let k = 0; k < PER_CHIP; k++) insert.run(1 + (Math.floor(k / 50) % 4), 1 + (Math.floor(k / 50) % 4), uid, ++counters[1 + (Math.floor(k / 50) % 4)], new Date(t + 1000 + k * 1000).toISOString());
    t += (PER_CHIP + 2) * 1000;
    previous = uid;
  }
  for (let c = 0; c < CHIPS - 1; c++) insert.run(1, 1, (0xC0000000 + c).toString(16).toUpperCase(), ++counters[1], new Date(t + 1000 + c * 1000).toISOString());
  db.prepare("UPDATE items SET uid_nfc = ? WHERE id = 3").run(previous);
  db.exec('COMMIT');
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

function page(path) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = request({ host: '127.0.0.1', port, path, ca: certs.ca, agent: false, headers: { Cookie: `__Host-mt_session=${token}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), ms: performance.now() - start }));
    });
    req.on('error', reject);
    req.end();
  });
}
async function best(path, runs = 5) {
  let min = Infinity;
  let last;
  for (let i = 0; i < runs; i++) {
    last = await page(path);
    min = Math.min(min, last.ms);
  }
  return { ...last, ms: min };
}

test(`fiche, ${A_SCANS + B_SCANS} scans au journal : objet très déplacé, 30 déplacements et « Voir tout l'historique », sous ${MAX_MS} ms`, async (t) => {
  const res = await best('/items/1');
  t.diagnostic(`GET /items/1 (A) : ${res.ms.toFixed(1)} ms`);
  assert.equal(res.status, 200);
  assert.equal((res.body.match(/<li class="frise-etape/g) ?? []).length, 30);
  assert.ok(res.body.includes('href="/items/1/historique"'));
  assert.ok(res.ms < MAX_MS);
});

test('fiche : puce rescannée 100 000 fois au même poste — une seule étape « au moins », sous le budget', async (t) => {
  const res = await best('/items/2');
  t.diagnostic(`GET /items/2 (B) : ${res.ms.toFixed(1)} ms`);
  assert.equal(res.status, 200);
  assert.match(res.body, /Au moins 2\D?000 scans ici/);
  assert.ok(res.ms < MAX_MS);
});

test(`fiche : objet aux ${CHIPS} puces successives — chaque puce pendant sa période, repères de changement, sous le budget`, async (t) => {
  const res = await best('/items/3');
  const hist = await best('/items/3/historique');
  t.diagnostic(`GET /items/3 (C) : ${res.ms.toFixed(1)} ms ; historique : ${hist.ms.toFixed(1)} ms`);
  // Les scans d'une ancienne puce faits après son remplacement (au Poste 1, en fin de journal)
  // ne figurent pas : la frise commence par la puce actuelle.
  assert.doesNotMatch(res.body, /C0000000/);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('Puce changée'));
  assert.ok(res.ms < MAX_MS && hist.ms < MAX_MS);
});

test('historique : première page et page suivante, sous le budget', async (t) => {
  const first = await best('/items/1/historique');
  const next = /href="(\/items\/1\/historique\?avant=[^"]+)"/.exec(first.body)[1];
  const second = await best(next);
  t.diagnostic(`GET /items/1/historique : ${first.ms.toFixed(1)} ms ; page suivante : ${second.ms.toFixed(1)} ms`);
  assert.equal(second.status, 200);
  assert.equal((second.body.match(/<li class="frise-etape/g) ?? []).length, 50);
  assert.ok(first.ms < MAX_MS && second.ms < MAX_MS);
});

test('objet aux puces successives : en parcourant toutes les pages, chaque scan de chaque période une seule fois, chaque repère une fois', async () => {
  const { itemTimeline, parseCursor, TIMELINE_PAGE_ENTRIES } = await import('../server/timeline.js');
  const { getItem } = await import('../server/inventory.js');
  const item = getItem(db, 3n);
  let cursor = null;
  let scans = 0;
  let marks = 0;
  for (let pages = 0; pages < 10_000; pages++) {
    const page = itemTimeline(db, item, { cursor, limit: TIMELINE_PAGE_ENTRIES });
    for (const e of page.entries) {
      if (e.type === 'scan') scans += e.count;
      if (e.type === 'chip') marks++;
    }
    if (page.next === null) break;
    cursor = parseCursor(page.next);
  }
  assert.equal(scans, CHIPS * PER_CHIP);
  assert.equal(marks, CHIPS);
});
