// GET /api/recherche (étape U2), contre un vrai serveur HTTPS :
// - session obligatoire (401 JSON minimal, sans redirection), même origine (Sec-Fetch-Site) ;
// - en-têtes : JSON UTF-8, no-store, nosniff, CSP inchangée ;
// - limites : q vide, q trop long (400), 8 résultats au plus avec le total, &tout=1 ;
// - pas de fuite : ni clé, ni compteur, ni numéro de puce sauf s'il est la correspondance ;
// - échappement JSON d'un nom piégé ; POST /api/frames inchangé ;
// - /items/new?nom= (bouton « Créer la fiche » de la palette) ; pages sans script en ligne.
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
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import { makeTestCerts } from './tls-fixture.js';
import { APP_SCRIPT_TAG } from './app-script.js';

const NOW = '2026-11-26T08:00:00.000Z';
const KEY = Buffer.alloc(32, 0x5c);
const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const ch = (...codes) => String.fromCodePoint(...codes);
// Nom piégé : balises, guillemets, esperluette, séparateurs de ligne U+2028 / U+2029.
const TRAP = `</script><img src=x onerror=alert(1)>"'&amp;${ch(0x2028)}x${ch(0x2029)}`;
let dir, db, server, port, certs, token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-recherche-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste B · Banc d''essais', ?)").run(NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, NULL, ?, ?)').run(KEY, NOW, KEY, NOW);
  const insert = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, '04A1B2C3D4E5F6', 'Multimètre Fluke 87V n° 7', JSON.stringify({ 'N° de série': '41230987' }), NOW, NOW);
  insert.run(2, 'A1B2C3D4', 'Oscilloscope', '{}', NOW, NOW);
  insert.run(3, null, TRAP, '{}', NOW, NOW);
  for (let i = 1; i <= 12; i++) insert.run(100 + i, null, `Sonde ${i}`, '{}', NOW, NOW);
  // Multimètre : scanné au Poste B il y a peu ; oscilloscope : scanné par un lecteur non affecté.
  const recent = new Date(Date.now() - 4 * 60_000).toISOString();
  assert.equal(ingestFrame(db, encodeFrame({ readerId: 1, counter: 1, uid: Buffer.from('04A1B2C3D4E5F6', 'hex'), key: KEY }), recent).ok, true);
  assert.equal(ingestFrame(db, encodeFrame({ readerId: 2, counter: 1, uid: Buffer.from('A1B2C3D4', 'hex'), key: KEY }), recent).ok, true);
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('claire', DUMMY_HASH, NOW).lastInsertRowid);
  token = createSession(db, userId);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function send({ method = 'GET', path, session = token, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (session) h.Cookie = `__Host-mt_session=${session}`;
    const req = request({ host: '127.0.0.1', port, path, method, headers: h, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const api = (q, extra = '', options = {}) => send({ path: `/api/recherche?q=${encodeURIComponent(q)}${extra}`, ...options });

function assertJsonHeaders(res, what) {
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8', what);
  assert.equal(res.headers['cache-control'], 'no-store', what);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
  assert.equal(res.headers['content-security-policy'], CSP, what);
  assert.equal(res.headers['access-control-allow-origin'], undefined, what); // aucune ouverture CORS
  assert.equal(res.headers.location, undefined, what);
  assert.equal(res.headers['set-cookie'], undefined, what);
}

test('sans session (ou session invalide) : 401 JSON minimal, sans redirection ni donnée', async () => {
  for (const session of [null, 'A'.repeat(43), 'pas-un-jeton']) {
    const res = await api('multi', '', { session });
    assert.equal(res.status, 401, String(session));
    assertJsonHeaders(res, String(session));
    assert.equal(res.body, '{"erreur":"session"}');
  }
});

test('même origine : Sec-Fetch-Site autre que same-origin → 403 ; same-origin ou absent → 200', async () => {
  for (const site of ['cross-site', 'same-site', 'none', '']) {
    const res = await api('multi', '', { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(res.status, 403, site);
    assertJsonHeaders(res, site);
    assert.equal(res.body, '{"erreur":"origine"}');
  }
  assert.equal((await api('multi', '', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  assert.equal((await api('multi')).status, 200);
  // Requête d'un autre site : le cookie SameSite=Strict n'est pas envoyé, donc 401 de toute façon.
  assert.equal((await api('multi', '', { session: null, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 401);
});

test('résultat : emplacement, arrivée en texte humain, où le mot a été trouvé ; en-têtes JSON', async () => {
  const res = await api('fluke 7');
  assert.equal(res.status, 200);
  assertJsonHeaders(res, 'fluke 7');
  const data = JSON.parse(res.body);
  assert.equal(data.total, 1);
  const [first] = data.resultats;
  assert.deepEqual(Object.keys(first).sort(), ['arrivee', 'emplacement', 'id', 'nom', 'trouve']);
  assert.equal(first.id, 1);
  assert.equal(first.nom, 'Multimètre Fluke 87V n° 7');
  assert.deepEqual(first.emplacement, { etat: 'poste', libelle: 'Poste B · Banc d\'essais' });
  assert.match(first.arrivee.texte, /^depuis [345] min$/);
  assert.match(first.arrivee.iso, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(first.arrivee.auMoins, false);
  assert.equal(first.arrivee.par, 'scan');
  assert.deepEqual(first.trouve, { type: 'nom' });
  // Propriété : la clé et la valeur sont signalées.
  const serial = JSON.parse((await api('41230987')).body).resultats[0];
  assert.deepEqual(serial.trouve, { type: 'propriete', cle: 'N° de série', valeur: '41230987' });
  // Lecteur non affecté : numéro du lecteur (lien vers sa fiche), pas de poste.
  const osc = JSON.parse((await api('oscillo')).body).resultats[0];
  assert.deepEqual(osc.emplacement, { etat: 'inconnue', libelle: 'lecteur non affecté', lecteur: 2 });
  // Jamais localisé : arrivee null.
  const probe = JSON.parse((await api('sonde 12')).body).resultats[0];
  assert.deepEqual(probe.emplacement, { etat: 'jamais', libelle: 'jamais localisé' });
  assert.equal(probe.arrivee, null);
});

test('aucune fuite : ni clé, ni compteur, ni numéro de puce, sauf la puce qui correspond (groupée par 2)', async () => {
  const byName = (await api('multi')).body;
  for (const secret of ['04A1', '04 A1', KEY.toString('hex'), KEY.toString('base64'), 'counter', 'compteur', 'aead', 'uid', 'reader_id', 'properties']) {
    assert.ok(!byName.includes(secret), secret);
  }
  const byChip = JSON.parse((await api('d4e5')).body);
  assert.equal(byChip.total, 1);
  assert.deepEqual(byChip.resultats[0].trouve, { type: 'puce', puce: '04 A1 B2 C3 D4 E5 F6' });
  assert.ok(!JSON.stringify(byChip).includes('04A1B2'), 'jamais sous sa forme brute');
});

test('nom piégé : JSON échappé (< > & U+2028 U+2029 en \\uXXXX), relu à l\'identique', async () => {
  const res = await api('onerror');
  assert.equal(res.status, 200);
  for (const raw of ['<', '>', '&', ch(0x2028), ch(0x2029)]) assert.ok(!res.body.includes(raw), `caractère brut ${raw.codePointAt(0)}`);
  assert.ok(res.body.includes('\\u003c/script\\u003e\\u003cimg'));
  const data = JSON.parse(res.body);
  assert.equal(data.resultats[0].nom, TRAP);
});

test('limites : q absent ou vide → aucun résultat ; plus de 200 caractères → 400 ; 8 résultats au plus avec le total', async () => {
  for (const path of ['/api/recherche', '/api/recherche?q=', '/api/recherche?q=%20%20', '/api/recherche?x=1']) {
    const res = await send({ path });
    assert.equal(res.status, 200, path);
    assert.equal(res.body, '{"total":0,"resultats":[]}', path);
  }
  const tooLong = await api('a'.repeat(201));
  assert.equal(tooLong.status, 400);
  assertJsonHeaders(tooLong, 'trop long');
  assert.equal(tooLong.body, '{"erreur":"requete"}');
  assert.equal((await api('a'.repeat(200))).status, 200);
  // 200 caractères = 200 points de code (emoji : 2 unités UTF-16 chacun).
  assert.equal((await api('😀'.repeat(200))).status, 200);
  assert.equal((await api('😀'.repeat(201))).status, 400);
  const many = JSON.parse((await api('sonde')).body);
  assert.equal(many.total, 12);
  assert.deepEqual(many.resultats.map((r) => r.nom), ['Sonde 1', 'Sonde 2', 'Sonde 3', 'Sonde 4', 'Sonde 5', 'Sonde 6', 'Sonde 7', 'Sonde 8']);
});

test('&tout=1 : toutes les fiches qui correspondent (filtre de la page Inventaire) ; q vide → tout l\'inventaire', async () => {
  const sondes = JSON.parse((await api('sonde', '&tout=1')).body);
  assert.equal(sondes.total, 12);
  assert.equal(sondes.resultats.length, 12);
  // Lignes allégées (étape U2) : seulement ce qu'affiche une ligne du tableau.
  assert.deepEqual(Object.keys(sondes.resultats[0]).sort(), ['arrivee', 'emplacement', 'id', 'nom']);
  const multi = JSON.parse((await api('multi', '&tout=1')).body).resultats[0];
  assert.deepEqual(Object.keys(multi.arrivee).sort(), ['auMoins', 'exacte', 'iso', 'texte']);
  const all = JSON.parse((await api('', '&tout=1')).body);
  assert.equal(all.total, 15);
  assert.equal(all.resultats.length, 15);
});

test('méthodes : seul GET ; la route des boîtiers (/api/frames) est inchangée', async () => {
  const post = await send({ method: 'POST', path: '/api/recherche?q=x' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');
  const frames = await send({ path: '/api/frames' });
  assert.equal(frames.status, 405);
  assert.equal(frames.body, '');
  assert.equal(frames.headers['content-type'], undefined);
  assert.equal((await send({ path: '/api/recherche/' })).status, 404);
});

test('/items/new?nom= : nom pré-rempli, nettoyé, borné et échappé ; rien n\'est enregistré', async () => {
  const items = db.prepare('SELECT count(*) AS n FROM items').get().n;
  const page = await send({ path: `/items/new?nom=${encodeURIComponent(`  Sonde "x" <b>${ch(0x202E)}\tfin `)}` });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('<input id="name" name="name" value="Sonde &quot;x&quot; &lt;b&gt; fin" maxlength="200"'));
  const long = await send({ path: `/items/new?nom=${encodeURIComponent('é'.repeat(300))}` });
  assert.ok(long.body.includes(`value="${'é'.repeat(200)}"`));
  assert.ok((await send({ path: '/items/new' })).body.includes('<input id="name" name="name" value="" maxlength="200"'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, items);
});

test('pages de l\'application : seule la balise du script local, aucun script en ligne ni gestionnaire on…=', async () => {
  for (const path of ['/', '/?q=multi', '/stations', '/readers', '/chips', '/items/1', '/items/new']) {
    const res = await send({ path });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['content-security-policy'], CSP, path);
    const scripts = res.body.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
    assert.deepEqual(scripts, [APP_SCRIPT_TAG], path);
    assert.doesNotMatch(res.body.replace(/"[^"]*"/g, '""'), /<[^>]*\son[a-z]+\s*=/i, path);
    assert.doesNotMatch(res.body, /javascript:/i, path);
  }
  // La page Inventaire désigne la zone mise à jour pendant la frappe.
  const home = (await send({ path: '/' })).body;
  assert.ok(home.includes('aria-controls="inventaire-resultats"'));
  assert.ok(home.includes('<div id="inventaire-resultats">'));
});
