// Charge raisonnable (étape 4) : 1 000 objets et 20 000 scans en base, serveur HTTPS en processus.
// Bornes larges (machine de CI lente) : on vérifie l'absence de dégradation grossière
// (requête par ligne, historique non borné), pas une performance fine.
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

const ITEMS = 1000;
const SCANS = 20_000;
const HOT_SCANS = 5_000; // scans concentrés sur le premier objet
const MAX_MS = 2_000;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');

let dir, db, server, port, certs, token;
const logs = [];
const uidOf = (i) => (0x20000000 + i).toString(16).toUpperCase();

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-charge-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const at = new Date(T0).toISOString();
  db.exec('BEGIN');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?), (2, 'Poste 2', ?)").run(at, at);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?), (3, NULL, ?, ?)')
    .run(Buffer.alloc(32, 1), at, Buffer.alloc(32, 2), at, Buffer.alloc(32, 3), at);
  const item = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < ITEMS; i++) item.run(i + 1, uidOf(i), `Objet ${i}`, JSON.stringify({ série: `S${i}` }), at, at);
  const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const counters = [0, 0, 0, 0];
  for (let i = 0; i < SCANS; i++) {
    const reader = (i % 3) + 1;
    const uid = i < HOT_SCANS ? uidOf(0) : uidOf((i * 7919) % ITEMS);
    scan.run(reader, reader === 3 ? null : reader, uid, ++counters[reader], new Date(T0 + i * 60_000).toISOString());
  }
  db.exec('COMMIT');
  const userId = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('charge', DUMMY_HASH, at).lastInsertRowid;
  token = createSession(db, userId);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: (l) => logs.push(l), loginFailureDelayMs: 0 });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
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
// Page sans son aide « Comment ça marche ? » (texte constant qui cite les pastilles, dont « jamais localisé »).
const withoutHelp = (html) => html.replace(/<details class="aide-page">[\s\S]*?<\/details>/, '');
// Derniers scans de la fiche : frise verticale depuis l'étape U1 (une étape par scan).
const historyRows = (html) => /<ol class="frise">([\s\S]*?)<\/ol>/.exec(html)?.[1].match(/<li class="frise-etape/g)?.length ?? 0;

test(`liste de ${ITEMS} objets avec ${SCANS} scans : toutes les lignes, en moins de ${MAX_MS} ms`, async (t) => {
  await page('/'); // échauffement
  const res = await page('/');
  t.diagnostic(`GET / : ${Math.round(res.ms)} ms, ${Math.round(res.body.length / 1024)} Kio`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(`${ITEMS} objets`));
  assert.equal(res.body.match(/class="lien-objet"/g).length, ITEMS);
  assert.ok(res.ms < MAX_MS, `${Math.round(res.ms)} ms`);
  // Chaque objet a été scanné au moins une fois : aucun « jamais localisé ».
  assert.ok(!withoutHelp(res.body).includes('jamais localisé'));
});

test('recherche sur la base chargée : résultats corrects, en moins de la borne', async (t) => {
  const res = await page('/?q=Objet%2099');
  t.diagnostic(`GET /?q=Objet 99 : ${Math.round(res.ms)} ms`);
  assert.equal(res.status, 200);
  // Recherche par mots (étape U2) : « objet » ET « 99 », chacun n'importe où dans le nom (ou une
  // propriété) : 99, 199, 299... 899 (9) et 990 à 999 (10).
  assert.ok(res.body.includes('19 résultats pour «&nbsp;Objet 99&nbsp;»'));
  // Classement : nom commençant par le premier mot, puis ordre alphabétique (nombres naturels).
  assert.ok(res.body.indexOf('>Objet 99<') < res.body.indexOf('>Objet 199<'));
  assert.ok(res.ms < MAX_MS);
});

test(`fiche d'un objet à ${HOT_SCANS} scans : 20 scans affichés au plus, le plus récent d'abord, localisation = dernier scan`, async (t) => {
  const res = await page('/items/1');
  t.diagnostic(`GET /items/1 : ${Math.round(res.ms)} ms`);
  assert.equal(res.status, 200);
  assert.equal(historyRows(res.body), 20);
  const last = db.prepare('SELECT received_at, station_id, reader_id FROM scans WHERE uid_nfc = ? ORDER BY received_at DESC, id DESC LIMIT 1').get(uidOf(0));
  const datetimes = [...res.body.matchAll(/<p class="frise-quand"><time datetime="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(datetimes[0], last.received_at);
  assert.deepEqual(datetimes, [...datetimes].sort().reverse());
  // Emplacement en grand dans l'en-tête de la fiche (étape U1).
  const expected = last.station_id === null
    ? `<a class="lien-etat" href="/readers/${last.reader_id}"><span class="etat etat-inconnue">lecteur non affecté</span></a></p>`
    : `<span class="etat etat-poste">Poste ${last.station_id}</span></p>`;
  assert.ok(res.body.includes('<p class="emplacement') && res.body.includes(expected));
  assert.ok(res.ms < MAX_MS);
});

test('aucune erreur interne pendant la charge', () => {
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));
});
