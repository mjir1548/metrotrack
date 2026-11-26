// Aide intégrée « Comment ça marche ? » (server/aide.js), contre un vrai serveur HTTPS en processus.
// - chaque page de travail a exactement un encadré <details class="aide-page">, fermé, avec le bon
//   texte, placé sous le titre ;
// - aucune aide sur la connexion, la page de la clé, les pages d'erreur ou d'information ;
// - le texte d'aide : constant, sans URL externe, sans style ni script, liens internes valides ;
// - reliquat de l'étape 7 : chipPreviousOwner (lecture de audit_log) n'est appelé que pour une
//   page qui affiche l'avertissement de réutilisation.
// Les tests s'enchaînent sur une même base (ordre du fichier).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { AIDE, AIDE_SUMMARY } from '../server/aide.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-19T08:00:00.000Z';
const KEY = Buffer.alloc(32, 0x5a);
const KNOWN = '04A1B2C3D4E5F6'; // puce de la fiche 1
const LOOSE = 'DEADBEEF'; // puce inconnue, jamais associée
const REUSED = '0B0B0B0B'; // puce inconnue qui a appartenu à une fiche supprimée
const HELP_OPEN = '<details class="aide-page">';
let dir, db, server, port, certs, token, csrf, origin;
let previousOwnerCalls = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-aide-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  // Poste 1 : avec historique ; poste 2 : vide (supprimable).
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?), (2, 'Réserve', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, NULL, ?, ?)').run(KEY, NOW, KEY, NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?), (2, NULL, 'Oscilloscope', ?, ?), (3, ?, 'Ancien', ?, ?)")
    .run(KNOWN, NOW, NOW, NOW, NOW, REUSED, NOW, NOW);
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, NOW).lastInsertRowid);
  token = createSession(db, userId);
  csrf = csrfTokenFor(token);
  // Espion : compte les lectures de chipPreviousOwner (seule requête qui lit
  // details.previous_uid dans audit_log). Le serveur reçoit ce même objet db.
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes("'$.previous_uid'")) previousOwnerCalls++;
    return prepare(sql);
  };
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

// ---------------------------------------------------------------- outils

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
const page = (path, session = token) => send({ path, headers: session ? { Cookie: `__Host-mt_session=${session}` } : {} });
function post(path, fields = [], { csrfField = csrf } = {}) {
  const params = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  if (csrfField !== null) params.append('csrf', csrfField);
  return send({
    method: 'POST', path, body: params.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `__Host-mt_session=${token}`, Origin: origin },
  });
}
let counter = 0;
async function scan(readerId, uid) {
  const res = await send({
    method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
    body: encodeFrame({ readerId, counter: ++counter, uid: Buffer.from(uid, 'hex'), key: KEY }),
  });
  assert.equal(res.status, 204);
}
const helpCount = (html) => html.split(HELP_OPEN).length - 1;
/** Appels à chipPreviousOwner pendant fn. */
async function previousOwnerCallsDuring(fn) {
  const before = previousOwnerCalls;
  const res = await fn();
  return { res, calls: previousOwnerCalls - before };
}

// ---------------------------------------------------------------- préparation

test('préparation : scans, puce réutilisée (fiche supprimée), poste et lecteur témoins', async () => {
  await scan(1, KNOWN);
  await scan(1, LOOSE);
  await scan(1, REUSED);
  // La fiche 3 portait REUSED : supprimée, la puce redevient inconnue avec un ancien propriétaire.
  assert.equal((await post('/items/3/delete')).status, 303);
  const chips = (await page('/chips')).body;
  assert.ok(chips.includes(LOOSE) && chips.includes(REUSED));
});

// ---------------------------------------------------------------- pages avec aide

// Page → encadré attendu (le texte exact de server/aide.js, pour vérifier la bonne variante).
const PAGES_WITH_HELP = [
  ['/', 'inventaire'],
  ['/items/new', 'nouvelleFiche'],
  ['/items/1', 'fiche'],
  ['/items/1/edit', 'modifierFiche'],
  ['/items/1/location', 'localisation'],
  ['/items/1/delete', 'supprimerFiche'],
  ['/stations', 'postes'],
  ['/stations/new', 'nouveauPoste'],
  ['/stations/1', 'poste'],
  ['/stations/1/edit', 'modifierPoste'],
  ['/stations/2/delete', 'supprimerPoste'],
  ['/readers', 'lecteurs'],
  ['/readers/new', 'nouveauLecteur'],
  ['/readers/1', 'lecteur'],
  ['/readers/1/station', 'changerPoste'],
  ['/readers/1/deactivate', 'desactiverLecteur'],
  ['/readers/1/replace', 'remplacerCle'],
  ['/chips', 'puces'],
  [`/chips/${LOOSE}/new`, 'ficheDepuisPuce'],
  [`/chips/${LOOSE}/associate`, 'associerRecherche'],
  [`/chips/${LOOSE}/associate/2`, 'associerConfirmation'],
];

test('chaque page de travail : exactement une aide, fermée, avec le bon texte, juste sous le titre', async () => {
  for (const [path, key] of PAGES_WITH_HELP) {
    const res = await page(path);
    assert.equal(res.status, 200, path);
    assert.equal(helpCount(res.body), 1, `${path} : une aide`);
    assert.ok(res.body.includes(String(AIDE[key])), `${path} : aide « ${key} »`);
    assert.ok(res.body.includes(`${HELP_OPEN}\n<summary>${AIDE_SUMMARY}</summary>`), path);
    assert.doesNotMatch(res.body, /<details[^>]*\sopen/, `${path} : fermée par défaut`);
    // Sous le titre : après </h1>, avant tout contenu de la page (formulaire, tableau, cartes, panneau).
    const between = res.body.slice(res.body.indexOf('</h1>'), res.body.indexOf(HELP_OPEN));
    assert.ok(res.body.indexOf('</h1>') > 0 && between.length > 0, path);
    assert.doesNotMatch(between, /<form|<table|class="fiche"|class="panneau|class="erreur"/, `${path} : aide sous le titre`);
  }
});

test('le résumé « Comment ça marche ? » est exactement celui demandé', () => {
  assert.equal(AIDE_SUMMARY, 'Comment ça marche ?');
});

test('formulaire réaffiché (saisie invalide, « Ajouter des lignes ») : toujours une aide, la bonne variante', async () => {
  const invalid = await post('/items/new', { name: '' });
  assert.equal(invalid.status, 400);
  assert.equal(helpCount(invalid.body), 1);
  assert.ok(invalid.body.includes(String(AIDE.nouvelleFiche)));
  const rows = await post('/items/1/edit', { name: 'Multimètre', action: 'lignes' });
  assert.equal(rows.status, 200);
  assert.ok(rows.body.includes(String(AIDE.modifierFiche)));
  const chip = await post(`/chips/${LOOSE}/new`, { name: '' });
  assert.equal(chip.status, 400);
  assert.ok(chip.body.includes(String(AIDE.ficheDepuisPuce)));
  const station = await post('/stations/new', { name: '' });
  assert.equal(station.status, 400);
  assert.ok(station.body.includes(String(AIDE.nouveauPoste)));
  for (const res of [invalid, rows, chip, station]) assert.equal(helpCount(res.body), 1);
});

// ---------------------------------------------------------------- pages sans aide

test('pas d\'aide : connexion, refus, pages introuvables, puce déjà associée, suppression de poste impossible', async () => {
  const cases = [
    [await page('/login', null), 200],
    [await post('/items/new', { name: 'x' }, { csrfField: null }), 403],
    [await page('/items/999'), 404],
    [await page('/stations/999'), 404],
    [await page('/readers/999'), 404],
    [await page('/chips/CAFEF00D/new'), 404],
    [await page(`/chips/${KNOWN}/new`), 409],
    [await page('/stations/1/delete'), 200], // poste avec historique : page d'explication
  ];
  for (const [res, status] of cases) {
    assert.equal(res.status, status);
    assert.equal(helpCount(res.body), 0, `statut ${status}`);
    assert.ok(!res.body.includes('<details'), `statut ${status}`);
  }
});

test('pas d\'aide sur la page de la clé (création et remplacement), ni sur la page « lecteur désactivé »', async () => {
  const created = await post('/readers/new', { station: '' });
  assert.equal(created.status, 200);
  assert.ok(created.body.includes('<pre class="cle">'));
  assert.equal(helpCount(created.body), 0);
  const id = Number(/<p class="numero-lecteur">(\d+)<\/p>/.exec(created.body)[1]);
  const replaced = await post(`/readers/${id}/replace`);
  assert.equal(replaced.status, 200);
  assert.ok(replaced.body.includes('<pre class="cle">'));
  assert.equal(helpCount(replaced.body), 0);
  const inactive = await page(`/readers/${id}/station`); // l'ancien lecteur est désactivé
  assert.equal(inactive.status, 200);
  assert.ok(inactive.body.includes('<h1>Lecteur désactivé</h1>'));
  assert.equal(helpCount(inactive.body), 0);
});

// ---------------------------------------------------------------- contenu de l'aide

test('texte d\'aide : balises simples, sans URL externe, sans style ni script, sans attribut open', () => {
  for (const [key, fragment] of Object.entries(AIDE)) {
    const text = String(fragment);
    assert.ok(text.startsWith(`${HELP_OPEN}\n<summary>${AIDE_SUMMARY}</summary>\n<div class="aide-contenu">`), key);
    assert.ok(text.trimEnd().endsWith('</div>\n</details>'), key);
    assert.equal(helpCount(text), 1, key);
    for (const [, tag] of text.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) {
      assert.ok(['details', 'summary', 'div', 'p', 'ul', 'li', 'span', 'a', 'strong'].includes(tag), `${key} : <${tag}>`);
    }
    assert.doesNotMatch(text, /https?:|\/\/|<script|<style|\sstyle\s*=|\son[a-z]+\s*=|\sopen[\s>=]/i, key);
    // Aucune donnée variable : ni caractère de gabarit oublié, ni « undefined » / « null ».
    assert.doesNotMatch(text, /\$\{|undefined|\bnull\b|NaN/, key);
  }
});

test('liens internes de l\'aide (s\'il y en a) : chemins du site qui répondent 200', async () => {
  const hrefs = new Set();
  for (const fragment of Object.values(AIDE)) {
    for (const [, href] of String(fragment).matchAll(/href="([^"]*)"/g)) hrefs.add(href);
  }
  for (const href of hrefs) {
    assert.match(href, /^\/(?!\/)/, href);
    assert.equal((await page(href)).status, 200, href);
  }
});

test('feuille de style : aide sobre, focus clavier visible, aucun marqueur natif ni ressource externe', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'style.css'), 'utf8');
  // Étape U1 (direction B) : anneau de focus du design system, marqueur natif remplacé par une
  // icône et un chevron dessinés en CSS, texte d'aide sur le fond de la page.
  assert.match(css, /details\.aide-page > summary:focus-visible \{\s*outline: 2px solid var\(--focus\);/);
  assert.match(css, /details\.aide-page > summary \{[^}]*list-style: none;/);
  assert.match(css, /details\.aide-page > summary::-webkit-details-marker \{ display: none; \}/);
  assert.match(css, /\.aide-contenu \{[^}]*color: var\(--texte-doux\);/);
  assert.doesNotMatch(css, /url\(|@import/);
});

// ---------------------------------------------------------------- reliquat de l'étape 7

test('chipPreviousOwner : lu seulement pour les pages qui affichent l\'avertissement (création, réaffichage, confirmation, 409)', async () => {
  const warned = (res) => res.body.includes('panneau-reutilisation');

  // Pages qui affichent l'avertissement : une lecture chacune, avertissement présent.
  for (const fn of [
    () => page(`/chips/${REUSED}/new`),
    () => post(`/chips/${REUSED}/new`, { name: '' }), // saisie invalide, réaffichée en 400
    () => post(`/chips/${REUSED}/new`, { name: 'x', action: 'lignes' }), // « Ajouter des lignes »
    () => page(`/chips/${REUSED}/associate/2`),
    () => post(`/chips/${REUSED}/associate/2`, { previous: KNOWN }), // fiche changée de puce : 409
  ]) {
    const { res, calls } = await previousOwnerCallsDuring(fn);
    assert.ok([200, 400, 409].includes(res.status), String(res.status));
    assert.equal(calls, 1, `${res.status} : une lecture`);
    assert.ok(warned(res), `${res.status} : avertissement affiché`);
  }

  // Recherche d'association : aucune lecture.
  for (const path of [`/chips/${REUSED}/associate`, `/chips/${REUSED}/associate?q=multi`]) {
    const { res, calls } = await previousOwnerCallsDuring(() => page(path));
    assert.equal(res.status, 200, path);
    assert.equal(calls, 0, path);
    assert.ok(!warned(res), path);
  }

  // Liste des puces inconnues : aucune lecture.
  assert.equal((await previousOwnerCallsDuring(() => page('/chips'))).calls, 0);

  // Formulaire refusé avant tout réaffichage (trop de lignes) : aucune lecture.
  const tooMany = Array.from({ length: 60 }, () => [['prop_key', 'k'], ['prop_value', 'v']]).flat();
  const refused = await previousOwnerCallsDuring(() => post(`/chips/${REUSED}/new`, [['name', 'x'], ...tooMany]));
  assert.equal(refused.res.status, 400);
  assert.equal(refused.calls, 0);

  // Création réussie : aucune lecture (redirection, rien n'est affiché).
  const created = await previousOwnerCallsDuring(() => post(`/chips/${REUSED}/new`, { name: 'Nouveau propriétaire' }));
  assert.equal(created.res.status, 303);
  assert.equal(created.calls, 0);
  assert.match(created.res.headers.location, /^\/items\/\d+\?ok=cree_puce$/);
});

test('association réussie : aucune lecture de chipPreviousOwner', async () => {
  const { res, calls } = await previousOwnerCallsDuring(() => post(`/chips/${LOOSE}/associate/2`, { previous: '' }));
  assert.equal(res.status, 303);
  assert.equal(calls, 0);
});
