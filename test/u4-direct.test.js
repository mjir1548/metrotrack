// Étape U4 : le direct. GET /api/direct (session, origine, en-têtes, format des événements, aucun
// secret, plafond de flux, fermeture à la déconnexion et à l'expiration, battement de cœur,
// reprise), émission après un scan accepté par POST /api/frames (et PAS après une trame
// rejetée), après une correction et une association ; GET /api/puces-inconnues ; /api/frames
// inchangé sous plusieurs flux ouverts.
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
import { parseEventId, createDirectHub, itemEvent } from '../server/direct.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, certs, db, server, port, origin, alice, token;
const KEY = Buffer.alloc(32, 0x55);
const OTHER_KEY = Buffer.alloc(32, 0x66);
const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const counters = { 1: 0, 2: 0 };
const logs = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u4d-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const now = new Date().toISOString();
  alice = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, now).lastInsertRowid);
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste A', ?), (2, 'Poste B', ?)").run(now, now);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run(KEY, now, KEY, now);
  const id = createItem(db, alice, { name: 'Multimètre <Fluke> "87V"', notes: '', properties: [] }, now);
  db.prepare("UPDATE items SET uid_nfc = '04A1B2C3D4E5F6' WHERE id = ?").run(id);
  token = createSession(db, alice);
  server = createFrameServer(db, {
    tls: { cert: certs.cert, key: certs.key }, log: (l) => logs.push(l), loginFailureDelayMs: 0, maxDirectClients: 12, directHeartbeatMs: 150,
  });
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

const sessionCookie = (t = token) => `__Host-mt_session=${t}`;

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

function frame(readerId, uidHex, { key = KEY, counter } = {}) {
  const c = counter ?? ++counters[readerId];
  return encodeFrame({ readerId, counter: c, uid: Buffer.from(uidHex, 'hex'), key });
}
const postFrame = (bytes) => send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });

/**
 * Flux SSE ouvert : texte brut reçu, événements analysés ({id, event, data}), état « fermé ».
 * waitFor(prédicat) attend qu'une condition sur le flux devienne vraie.
 */
function openStream({ path = '/api/direct', headers = { Cookie: sessionCookie() } } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers, ca: certs.ca, agent: false }, (res) => {
      const stream = { res, req, status: res.statusCode, headers: res.headers, raw: '', events: [], closed: false };
      let pending = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        stream.raw += chunk;
        pending += chunk;
        let cut;
        while ((cut = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, cut);
          pending = pending.slice(cut + 2);
          const event = { id: null, event: 'message', data: null };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) event.id = line.slice(4);
            else if (line.startsWith('event: ')) event.event = line.slice(7);
            else if (line.startsWith('data: ')) event.data = line.slice(6);
          }
          if (event.data !== null) stream.events.push(event);
        }
      });
      res.on('end', () => { stream.closed = true; });
      res.on('close', () => { stream.closed = true; });
      stream.waitFor = (predicate, ms = 3000) => new Promise((ok, ko) => {
        const start = Date.now();
        (function check() {
          if (predicate(stream)) return ok(stream);
          if (Date.now() - start > ms) return ko(new Error(`attente dépassée ; reçu : ${JSON.stringify(stream.raw.slice(-500))}`));
          setTimeout(check, 10);
        })();
      });
      stream.close = () => { req.destroy(); };
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
}
const messages = (stream) => stream.events.filter((e) => e.event === 'message').map((e) => JSON.parse(e.data));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitClients = async (n) => {
  for (let i = 0; i < 300 && server.direct.size !== n; i++) await sleep(10);
  assert.equal(server.direct.size, n);
};

// ---------------------------------------------------------------- accès

test('/api/direct : sans session → 401 JSON ; autre origine → 403 ; plafond de requête refusé sans flux', async () => {
  const none = await send({ path: '/api/direct' });
  assert.equal(none.status, 401);
  assert.deepEqual(JSON.parse(none.body), { erreur: 'session' });
  assert.equal(none.headers['cache-control'], 'no-store');
  const expired = await send({ path: '/api/direct', headers: { Cookie: sessionCookie('A'.repeat(43)) } });
  assert.equal(expired.status, 401);
  for (const site of ['cross-site', 'same-site', 'none']) {
    const res = await send({ path: '/api/direct', headers: { Cookie: sessionCookie(), 'Sec-Fetch-Site': site } });
    assert.equal(res.status, 403, site);
  }
  assert.equal(server.direct.size, 0);
  const post = await send({ method: 'POST', path: '/api/direct', headers: { Cookie: sessionCookie() }, body: '' });
  assert.equal(post.status, 405);
});

test('/api/direct : flux text/event-stream, no-store, CSP inchangée, délai de reconnexion annoncé', async () => {
  const stream = await openStream({ headers: { Cookie: sessionCookie(), 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(stream.headers['cache-control'], 'no-store');
  assert.equal(stream.headers['content-security-policy'], CSP);
  assert.equal(stream.headers['x-content-type-options'], 'nosniff');
  assert.equal(stream.headers['access-control-allow-origin'], undefined);
  await stream.waitFor((s) => s.raw.startsWith('retry: 3000\n'));
  stream.close();
  await waitClients(0);
});

// ---------------------------------------------------------------- événements

test('scan accepté → événement léger (objet, poste, heure, déplacement), sans clé ni numéro de puce ; réponse 204 inchangée', async () => {
  const stream = await openStream();
  await waitClients(1);
  const res = await postFrame(frame(2, '04A1B2C3D4E5F6'));
  assert.equal(res.status, 204);
  assert.equal(res.body, '');
  await stream.waitFor((s) => messages(s).length === 1);
  const [event] = messages(stream);
  const item = db.prepare("SELECT id FROM items WHERE uid_nfc = '04A1B2C3D4E5F6'").get().id;
  assert.deepEqual(Object.keys(event).sort(), ['deplacement', 'inconnu', 'iso', 'itemId', 'lecteur', 'nom', 'par', 'poste', 'posteId', 'type']);
  assert.equal(event.type, 'scan');
  assert.equal(event.itemId, item);
  assert.equal(event.nom, 'Multimètre <Fluke> "87V"');
  assert.equal(event.poste, 'Poste B');
  assert.equal(event.posteId, 2);
  assert.equal(event.lecteur, 2);
  assert.equal(event.inconnu, false);
  assert.equal(event.deplacement, true);
  assert.equal(event.iso, db.prepare('SELECT received_at FROM scans ORDER BY id DESC LIMIT 1').get().received_at);
  // Aucun secret, aucun UID, JSON échappé (< > & en \\u), aucune ligne SSE injectée par le nom.
  assert.ok(!stream.raw.includes('04A1B2C3D4E5F6') && !stream.raw.includes('04 A1'));
  assert.ok(!stream.raw.includes(KEY.toString('hex')) && !stream.raw.includes('5555'));
  assert.ok(!stream.raw.includes('<Fluke>'));
  assert.ok(stream.raw.includes('\\u003cFluke\\u003e'));
  assert.match(stream.events[0].id, /^\d+$/);
  // Rescan au même poste : événement, mais pas un déplacement.
  await postFrame(frame(2, '04A1B2C3D4E5F6'));
  await stream.waitFor((s) => messages(s).length === 2);
  assert.equal(messages(stream)[1].deplacement, false);
  stream.close();
  await waitClients(0);
});

test('puce inconnue → « inconnu », sans nom ni numéro de puce', async () => {
  const stream = await openStream();
  await waitClients(1);
  assert.equal((await postFrame(frame(1, 'DEADBEEF'))).status, 204);
  await stream.waitFor((s) => messages(s).length === 1);
  const [event] = messages(stream);
  assert.equal(event.inconnu, true);
  assert.equal(event.itemId, null);
  assert.equal(event.nom, null);
  assert.equal(event.poste, 'Poste A');
  assert.equal(event.deplacement, false);
  assert.ok(!/DEADBEEF|DE AD/i.test(stream.raw));
  stream.close();
  await waitClients(0);
});

test('trame rejetée (rejeu, mauvaise clé, lecteur inconnu, taille) → 400 et AUCUN événement', async () => {
  const stream = await openStream();
  await waitClients(1);
  const replay = frame(1, '04A1B2C3D4E5F6', { counter: 1 });
  for (const bytes of [replay, frame(1, '04A1B2C3D4E5F6', { key: OTHER_KEY, counter: 999 }), frame(1, '04A1B2C3D4E5F6', { counter: 0x7fff }).subarray(0, 30)]) {
    assert.equal((await postFrame(bytes)).status, 400);
  }
  const unknownReader = encodeFrame({ readerId: 77, counter: 1, uid: Buffer.from('0A0B0C0D', 'hex'), key: KEY });
  assert.equal((await postFrame(unknownReader)).status, 400);
  await sleep(300);
  assert.deepEqual(messages(stream), []);
  stream.close();
  await waitClients(0);
});

test('correction manuelle et association → événements « correction » et « puce », avec l\'auteur', async () => {
  const stream = await openStream();
  await waitClients(1);
  const item = db.prepare("SELECT id FROM items WHERE uid_nfc = '04A1B2C3D4E5F6'").get().id;
  const form = (fields) => {
    const params = new URLSearchParams({ ...fields, csrf: csrfTokenFor(token) });
    return { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie(), Origin: origin, body: params.toString() };
  };
  const { body, ...headers } = form({ station: '1' });
  assert.equal((await send({ method: 'POST', path: `/items/${item}/location`, headers, body })).status, 303);
  await stream.waitFor((s) => messages(s).length === 1);
  assert.deepEqual({ ...messages(stream)[0], iso: 'x' }, {
    type: 'correction', itemId: item, nom: 'Multimètre <Fluke> "87V"', poste: 'Poste A', posteId: 1, lecteur: null, iso: 'x', inconnu: false, deplacement: true, par: 'alice',
  });
  // Fiche créée depuis la puce inconnue DEADBEEF.
  const created = form({ name: 'Caméra' });
  const { body: b2, ...h2 } = created;
  const res = await send({ method: 'POST', path: '/chips/DEADBEEF/new', headers: h2, body: b2 });
  assert.equal(res.status, 303);
  await stream.waitFor((s) => messages(s).length === 2);
  const puce = messages(stream)[1];
  assert.equal(puce.type, 'puce');
  assert.equal(puce.nom, 'Caméra');
  assert.equal(puce.poste, 'Poste A');
  assert.ok(!stream.raw.includes('DEADBEEF'));
  // Refus CSRF : rien n'est publié.
  const { body: b3, ...h3 } = form({ station: '2' });
  h3.Origin = 'https://attaquant.example';
  assert.equal((await send({ method: 'POST', path: `/items/${item}/location`, headers: h3, body: b3 })).status, 403);
  await sleep(200);
  assert.equal(messages(stream).length, 2);
  stream.close();
  await waitClients(0);
});

// ---------------------------------------------------------------- vie du flux

test('battement de cœur : commentaire SSE périodique (ignoré par EventSource)', async () => {
  const stream = await openStream();
  await stream.waitFor((s) => (s.raw.match(/: battement\n\n/g) ?? []).length >= 2, 2000);
  assert.deepEqual(messages(stream), []);
  stream.close();
  await waitClients(0);
});

test('déconnexion : les flux de la session sont fermés aussitôt, ceux des autres sessions restent', async () => {
  const bob = Number(db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES ('bob', ?, ?)").run(DUMMY_HASH, new Date().toISOString()).lastInsertRowid);
  const bobToken = createSession(db, bob);
  const mine = await openStream({ headers: { Cookie: sessionCookie(bobToken) } });
  const other = await openStream();
  await waitClients(2);
  const res = await send({
    method: 'POST', path: '/logout', body: `csrf=${csrfTokenFor(bobToken)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sessionCookie(bobToken), Origin: origin },
  });
  assert.equal(res.status, 303);
  await mine.waitFor((s) => s.closed, 1000);
  await waitClients(1);
  assert.equal(other.closed, false);
  other.close();
  await waitClients(0);
});

test('session expirée ou supprimée : le flux est fermé au battement suivant', async () => {
  const short = createSession(db, alice);
  const stream = await openStream({ headers: { Cookie: sessionCookie(short) } });
  await waitClients(1);
  db.prepare('UPDATE sessions SET expires_at = ? WHERE expires_at = (SELECT max(expires_at) FROM sessions)').run(new Date(Date.now() - 1000).toISOString());
  await stream.waitFor((s) => s.closed, 2000);
  await waitClients(0);
});

test('plafond de flux : au-delà, 503 JSON sans flux ; /api/frames continue de répondre', async () => {
  const streams = [];
  const sessions = [];
  for (let i = 0; i < 12; i++) sessions.push(createSession(db, alice));
  for (let i = 0; i < 12; i++) streams.push(await openStream({ headers: { Cookie: sessionCookie(sessions[i]) } }));
  await waitClients(12);
  const refused = await send({ path: '/api/direct', headers: { Cookie: sessionCookie() } });
  assert.equal(refused.status, 503);
  assert.deepEqual(JSON.parse(refused.body), { erreur: 'plein' });
  assert.equal(refused.headers['retry-after'], '30');
  assert.ok(logs.includes('direct : plafond de flux atteint, connexion refusée'));
  assert.equal((await postFrame(frame(1, '04A1B2C3D4E5F6'))).status, 204);
  await Promise.all(streams.map((s) => s.waitFor((x) => messages(x).length === 1)));
  for (const s of streams) s.close();
  await waitClients(0);
});

test('plafond par session : le flux le plus ancien de la session est fermé', () => {
  const hub = createDirectHub({ db, maxClients: 10, maxPerSession: 2, heartbeatMs: 60_000 });
  const fake = () => {
    const listeners = {};
    return {
      ended: false, written: '',
      on(name, fn) { listeners[name] = fn; },
      writeHead() {}, write(t) { this.written += t; }, end() { this.ended = true; listeners.close?.(); },
    };
  };
  const req = { socket: { setTimeout() {}, setNoDelay() {} } };
  const [a, b, c] = [fake(), fake(), fake()];
  assert.ok(hub.open(req, a, token, null));
  assert.ok(hub.open(req, b, token, null));
  assert.ok(hub.open(req, c, token, null));
  assert.equal(a.ended, true);
  assert.equal(hub.size, 2);
  hub.publish(itemEvent('puce', { id: 1, name: 'x', at: null, station_id: null, station_name: null }, 'alice', '2026-01-01T00:00:00.000Z'));
  assert.ok(b.written.includes('"type":"puce"') && !a.written.includes('"type":"puce"'));
  hub.closeAll();
  assert.equal(hub.size, 0);
});

test('reprise : Last-Event-ID ou ?depuis= renvoient les événements manqués ; numéro trop ancien → « resynchro »', async () => {
  const first = await openStream();
  await waitClients(1);
  await postFrame(frame(1, '04A1B2C3D4E5F6'));
  await postFrame(frame(2, '04A1B2C3D4E5F6'));
  await first.waitFor((s) => messages(s).length === 2);
  const [e1, e2] = first.events;
  first.close();
  await waitClients(0);
  await postFrame(frame(1, '04A1B2C3D4E5F6')); // manqué
  const viaHeader = await openStream({ headers: { Cookie: sessionCookie(), 'Last-Event-ID': e2.id } });
  await viaHeader.waitFor((s) => s.events.length === 1);
  assert.equal(JSON.parse(viaHeader.events[0].data).poste, 'Poste A');
  const viaQuery = await openStream({ path: `/api/direct?depuis=${e1.id}` });
  await viaQuery.waitFor((s) => s.events.length === 2);
  assert.ok(viaQuery.events.every((e) => e.event === 'message' && Number(e.id) > Number(e1.id)));
  const stale = await openStream({ path: '/api/direct?depuis=5' });
  await stale.waitFor((s) => s.events.length >= 1);
  assert.equal(stale.events[0].event, 'resynchro');
  for (const s of [viaHeader, viaQuery, stale]) s.close();
  await waitClients(0);
  assert.equal(parseEventId('12'), 12);
  for (const bad of ['', '-1', '1e3', 'abc', '1'.repeat(17), null, undefined]) assert.equal(parseEventId(bad), null, String(bad));
});

test('non-régression /api/frames sous 10 flux ouverts : 30 trames concurrentes (chaque 204 a son événement dans chaque flux), puis 10 en série toutes acceptées', async () => {
  const streams = [];
  for (let i = 0; i < 10; i++) streams.push(await openStream({ headers: { Cookie: sessionCookie(createSession(db, alice)) } }));
  await waitClients(10);
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => postFrame(frame(1 + (i % 2), i % 3 === 0 ? 'CAFE0001' : '04A1B2C3D4E5F6'))));
  // Les trames concurrentes d'un même lecteur peuvent arriver dans le désordre : un compteur
  // dépassé est alors un rejeu (400), comme avant U4. On vérifie que chaque 204 a son événement.
  const accepted = results.filter((r) => r.status === 204).length;
  assert.ok(accepted >= 2 && results.every((r) => r.status === 204 || r.status === 400));
  await Promise.all(streams.map((s) => s.waitFor((x) => messages(x).length === accepted)));
  for (const s of streams) s.close();
  await waitClients(0);
  // En série, toutes acceptées.
  for (let i = 0; i < 10; i++) assert.equal((await postFrame(frame(1, '04A1B2C3D4E5F6'))).status, 204);
});

// ---------------------------------------------------------------- puces inconnues (API)

test('/api/puces-inconnues : session, origine, n borné ; numéros et poste des plus récentes', async () => {
  assert.equal((await send({ path: '/api/puces-inconnues' })).status, 401);
  assert.equal((await send({ path: '/api/puces-inconnues', headers: { Cookie: sessionCookie(), 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  for (const n of ['0', '21', 'abc', '-1', '1.5', '999']) {
    assert.equal((await send({ path: `/api/puces-inconnues?n=${n}`, headers: { Cookie: sessionCookie() } })).status, 400, n);
  }
  const res = await send({ path: '/api/puces-inconnues?n=1', headers: { Cookie: sessionCookie() } });
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const data = JSON.parse(res.body);
  assert.equal(data.total, 1); // CAFE0001 (DEADBEEF a reçu une fiche)
  assert.deepEqual(Object.keys(data.puces[0]).sort(), ['exacte', 'iso', 'lecteur', 'numero', 'poste', 'texte', 'uid']);
  assert.equal(data.puces[0].uid, 'CAFE0001');
  assert.equal(data.puces[0].numero, 'CA FE 00 01');
  assert.ok(['Poste A', 'Poste B'].includes(data.puces[0].poste));
  assert.equal(data.puces[0].texte, 'à l\'instant');
});
