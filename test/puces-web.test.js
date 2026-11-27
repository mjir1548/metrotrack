// Puces inconnues et association (étape 7) contre un vrai serveur HTTPS en processus. Les scans
// arrivent par POST /api/frames, comme depuis un boîtier.
// - liste : UID, poste et heure du dernier scan, nombre de scans ; puce connue absente ; vide ;
// - « Créer une fiche » : formulaire de l'étape 5 avec l'UID en lecture seule, fiche localisée
//   immédiatement, puce retirée de la liste, audit avec l'UID ;
// - « Associer » : recherche (au plus 50 fiches), confirmation simple ou avec avertissement,
//   ancienne puce détachée et tracée, historique lisible sur la fiche ;
// - journal des scans inchangé ; course entre deux associations (une seule réussite, un 409) ;
// - garde-fous : UID invalide ou jamais scanné (404), déjà connu (409), fiche absente (404),
//   fiche changée de puce (409), session (303), Origin et CSRF (403), méthodes (405) ; aucune
//   écriture dans tous ces cas ;
// - 413 strict sur un envoi annoncé trop gros ;
// - aucune ressource externe, aucun style en ligne, un bouton principal au plus par page.
// Les tests s'enchaînent sur une même base (ordre du fichier).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { encodeFrame } from '../server/protocol.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';
import { withoutAppScript } from './app-script.js';

const NOW = '2026-11-19T08:00:00.000Z';
const KEY = Buffer.alloc(32, 0x5a);
const OLD = '04A1B2C3D4E5F6'; // puce de la fiche 1 au départ
const NEW = '04B7C8D9EAFB0C'; // puce inconnue scannée à l'Atelier
const LOOSE = 'DEADBEEF'; // puce inconnue scannée sur le lecteur 2, non affecté
const NEVER = 'CAFEF00D'; // jamais scannée
let dir, db, server, port, certs, token, csrf, origin, aliceId;
const logs = [];
const served = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-puces-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?), (2, 'Labo', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, NULL, ?, ?), (3, 2, ?, ?)')
    .run(KEY, NOW, KEY, NOW, KEY, NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?), (2, NULL, 'Oscilloscope', ?, ?), (3, NULL, 'Pince', ?, ?)")
    .run(OLD, NOW, NOW, NOW, NOW, NOW, NOW);
  aliceId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, NOW).lastInsertRowid);
  token = createSession(db, aliceId);
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
    if (body !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(body);
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
const cookie = (session = token) => (session ? { Cookie: `__Host-mt_session=${session}` } : {});
const page = (path, session = token) => send({ path, headers: cookie(session) });

/** POST d'un formulaire ; session, Origin et jeton CSRF valides par défaut, chacun retirable (null) ou remplaçable. */
function post(path, fields = {}, { session = token, originHeader = origin, csrfField = csrf } = {}) {
  const params = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  if (csrfField !== null) params.append('csrf', csrfField);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(session) };
  if (originHeader !== null) headers.Origin = originHeader;
  return send({ method: 'POST', path, headers, body: params.toString() });
}

let counters = { 1: 0, 2: 0, 3: 0 };
/** Trame envoyée à POST /api/frames, comme un boîtier. */
async function scan(readerId, uid) {
  const res = await send({
    method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
    body: encodeFrame({ readerId, counter: ++counters[readerId], uid: Buffer.from(uid, 'hex'), key: KEY }),
  });
  assert.equal(res.status, 204);
}

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const scansDump = () => JSON.stringify(db.prepare('SELECT * FROM scans ORDER BY id').all());
// État complet des tables modifiables : sert à prouver qu'une requête n'a rien écrit.
const snapshot = () => JSON.stringify(['items', 'audit_log', 'scans', 'location_corrections', 'stations', 'readers']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));
const lastAudit = () => {
  const row = db.prepare('SELECT user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return { ...row, details: JSON.parse(row.details) };
};
// Page sans son aide « Comment ça marche ? » : texte constant qui cite des cas absents de la
// page elle-même (puce détachée, « précisez la recherche », « Sa puce »).
const withoutHelp = (html) => html.replace(/<details class="aide-page">[\s\S]*?<\/details>/, '');
// Liste des puces inconnues : une carte par puce depuis l'étape U1 ; numéro affiché groupé par octets.
const chipRows = (html) => /<ul class="carte liste-puces">([\s\S]*?)<\/ul>/.exec(html)?.[1].split('<li class="encart">').slice(1) ?? [];
const listedUids = (html) => chipRows(html).map((row) => /<p class="encart-texte">Puce <span class="uid">([0-9A-F ]+)<\/span><\/p>/.exec(row)[1].replaceAll(' ', ''));
const grouped = (uid) => uid.match(/../g).join(' ');

// Balises autorisées : celles des gabarits. Toute autre serait une injection.
const ALLOWED_TAGS = new Set(['small', 'dialog', 'html', 'head', 'meta', 'title', 'link', 'body', 'header', 'div', 'span', 'nav', 'a', 'strong', 'form',
  'input', 'button', 'main', 'h1', 'h2', 'p', 'label', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time', 'section', 'dl', 'dt', 'dd',
  'textarea', 'select', 'option', 'ul', 'li', 'fieldset', 'legend', 'details', 'summary',
  'ol', 'svg', 'symbol', 'use', 'path', 'circle', 'rect', 'defs', 'clippath', 'g', 'kbd']);
const PAIRED_TAGS = ['small', 'dialog', 'div', 'span', 'a', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section', 'dl', 'dt', 'dd', 'time', 'form',
  'h1', 'h2', 'main', 'textarea', 'select', 'option', 'button', 'label', 'ul', 'li', 'nav', 'fieldset', 'legend', 'details', 'summary', 'ol', 'svg', 'symbol', 'use', 'kbd'];

function assertSafePage(page, what) {
  const html = withoutAppScript(page); // seul script autorisé (D-021)
  for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `${what} : balise <${tag}>`);
  for (const tag of PAIRED_TAGS) {
    const open = html.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
    const close = html.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
    assert.equal(open, close, `${what} : <${tag}> ${open} ouvertes, ${close} fermées`);
  }
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, what);
  assert.equal((html.match(/"/g)?.length ?? 0) % 2, 0, `${what} : guillemets déséquilibrés`);
  for (const [, url] of html.matchAll(/\b(?:src|href|action)\s*=\s*"([^"]*)"/gi)) assert.match(url, /^(?:\/(?!\/)|#[a-z][a-z-]*$)/, `${what} : URL ${url}`);
  assert.doesNotMatch(html, /https?:|\/\//i, `${what} : URL externe`);
  assert.doesNotMatch(html, /<script|<style|\sstyle\s*=/i, `${what} : script ou style`);
  // Le panneau <dialog> de la fiche d'un objet (étape U3) a son propre bouton principal : compté à part.
  const outside = html.replace(/<dialog[\s\S]*?<\/dialog>/g, '');
  assert.ok((outside.match(/class="bouton( bouton-danger)?"/g)?.length ?? 0) <= 1, `${what} : un bouton principal au plus`);
}

const routesFor = (uid, itemId = 2) => ({
  get: ['/chips', `/chips/${uid}/new`, `/chips/${uid}/associate`, `/chips/${uid}/associate/${itemId}`],
  post: [`/chips/${uid}/new`, `/chips/${uid}/associate/${itemId}`],
});
const VALID_POST = { name: 'Écrasé', notes: '', previous: '' };

// ---------------------------------------------------------------- liste

test('liste vide : message clair ; onglet « Puces inconnues » actif dans le bandeau, sans badge', async () => {
  const res = await page('/chips');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<li><a href="/chips" aria-current="page">Puces inconnues</a></li>'));
  assert.ok(res.body.includes('Aucune puce inconnue : toutes les puces scannées sont associées à une fiche.'));
  assert.ok(res.body.includes('0 puce inconnue'));
  assert.ok(!res.body.includes('<table') && !res.body.includes('liste-puces'));
  // Onglet présent (inactif) sur les autres rubriques.
  assert.ok((await page('/')).body.includes('<a href="/chips">Puces inconnues</a>'));
  assert.ok((await page('/stations')).body.includes('<a href="/chips">Puces inconnues</a>'));
});

test('une puce inconnue scannée apparaît avec son poste, l\'heure et le nombre de scans ; une puce connue n\'y apparaît pas', async () => {
  await scan(1, NEW);
  await scan(1, NEW);
  await scan(1, OLD); // connue : fiche 1
  await scan(2, LOOSE); // lecteur non affecté, scanné en dernier
  const res = await page('/chips');
  assert.equal(res.status, 200);
  assert.deepEqual(listedUids(res.body), [LOOSE, NEW]);
  assert.ok(res.body.includes('2 puces inconnues'));
  const [loose, fresh] = chipRows(res.body);
  const last = (uid) => db.prepare('SELECT received_at FROM scans WHERE uid_nfc = ? ORDER BY id DESC LIMIT 1').get(uid).received_at;
  assert.ok(fresh.includes(' · <span class="etat etat-poste">Atelier</span> · 2 scans</p>'));
  assert.ok(fresh.includes(`<time datetime="${last(NEW)}"`));
  assert.ok(fresh.includes(`<a class="bouton bouton-secondaire bouton-petit" href="/chips/${NEW}/new"><svg class="ic" aria-hidden="true"><use href="#i-ajouter"></use></svg>Créer une fiche</a>`));
  assert.ok(fresh.includes(`<a class="bouton bouton-discret bouton-petit" href="/chips/${NEW}/associate"><svg class="ic" aria-hidden="true"><use href="#i-associer"></use></svg>Associer à une fiche existante</a>`));
  assert.ok(loose.includes(' · <a class="lien-etat" href="/readers/2"><span class="etat etat-inconnue">lecteur non affecté</span></a> · 1 scan</p>'));
  assert.ok(!res.body.includes(OLD));
});

// ---------------------------------------------------------------- session, CSRF, format, conflits

test('sans session (ou session inconnue) : pages et envois → 303 vers /login, aucune écriture', async () => {
  const before = snapshot();
  const { get, post: posts } = routesFor(NEW);
  for (const session of [null, 'A'.repeat(43)]) {
    for (const path of [...get, '/chips/deadbeef/new']) {
      const res = await page(path, session);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/login', path);
    }
    // Étape U0 : un envoi avec un cookie de session invalide mène à la connexion avec le message
    // « session expirée » ; sans aucun cookie de session, à /login sans message.
    const expected = session === null ? '/login' : '/login?info=session';
    for (const path of posts) {
      const res = await post(path, VALID_POST, { session });
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, expected, path);
    }
  }
  assert.equal(snapshot(), before);
});

test('CSRF : envoi sans jeton, mauvais jeton, sans Origin ou autre Origin → 403, aucune écriture', async () => {
  const before = snapshot();
  const variants = [
    { csrfField: null }, { csrfField: '' }, { csrfField: csrfTokenFor('B'.repeat(43)) },
    { originHeader: null }, { originHeader: 'https://attaquant.example' }, { originHeader: `http://127.0.0.1:${port}` }, { originHeader: 'null' },
  ];
  for (const path of routesFor(NEW).post) {
    for (const options of variants) {
      const res = await post(path, VALID_POST, options);
      assert.equal(res.status, 403, `${path} ${JSON.stringify(options)}`);
    }
  }
  assert.equal(snapshot(), before);
});

test('UID invalide dans l\'adresse (minuscules, longueur, non hexadécimal, encodages) → 404, aucune écriture', async () => {
  const before = snapshot();
  const invalid = [
    NEW.toLowerCase(), 'DeadBeef', 'DEADBEE', 'DEADBEEF0', NEW.slice(0, 13), `${NEW}A`, 'GEADBEEF', 'DEADBEEFDEADBEEFDEAD0',
    '%44EADBEEF', '%44%45%41%44%42%45%45%46', 'DEADBEEF%00', 'DEADBEEF%20', 'DE%3AAD%3ABE%3AEF', '%2E%2E', '..', '',
    '%EF%BC%A4EADBEEF', // D pleine chasse encodé
  ];
  for (const uid of invalid) {
    for (const path of [`/chips/${uid}/new`, `/chips/${uid}/associate`, `/chips/${uid}/associate/2`]) {
      const res = await page(path);
      assert.equal(res.status, 404, path);
    }
    for (const path of [`/chips/${uid}/new`, `/chips/${uid}/associate/2`]) {
      const res = await post(path, VALID_POST);
      assert.equal(res.status, 404, path);
    }
  }
  const sample = await page('/chips/deadbeef/new');
  assert.ok(sample.body.includes('<h1>Puce introuvable</h1>'));
  // Chemins hors des formes prévues : pas une route.
  for (const path of [`/chips/${NEW}`, `/chips/${NEW}/`, `/chips/${NEW}/new/`, `/chips/${NEW}/associate/`, `/chips/${NEW}/associate/2/x`,
    `/chips/${NEW}/autre`, '/chips/', `/chips//${NEW}/new`, `/chips/${NEW}/__proto__`, `/chips/${NEW}/constructor/2`]) {
    assert.equal((await page(path)).status, 404, path);
  }
  assert.equal(snapshot(), before);
});

test('UID jamais scanné → 404 ; UID déjà connu → 409 avec un lien vers la fiche ; fiche inexistante → 404 ; aucune écriture', async () => {
  const before = snapshot();
  for (const path of routesFor(NEVER).get.slice(1)) assert.equal((await page(path)).status, 404, path);
  for (const path of routesFor(NEVER).post) assert.equal((await post(path, VALID_POST)).status, 404, path);
  for (const path of routesFor(OLD).get.slice(1)) {
    const res = await page(path);
    assert.equal(res.status, 409, path);
    assert.ok(res.body.includes('<h1>Puce déjà associée</h1>'), path);
    assert.ok(res.body.includes('<a class="bouton" href="/items/1">Voir la fiche</a>'), path);
  }
  for (const path of routesFor(OLD).post) assert.equal((await post(path, VALID_POST)).status, 409, path);
  for (const itemId of ['99', '0', '01', '-1', '1.0', 'x', '']) {
    const path = `/chips/${NEW}/associate/${itemId}`;
    assert.equal((await page(path)).status, 404, path);
    assert.equal((await post(path, VALID_POST)).status, 404, path);
  }
  assert.ok((await page(`/chips/${NEW}/associate/99`)).body.includes('<h1>Fiche introuvable</h1>'));
  assert.equal(snapshot(), before);
});

test('méthodes : 405 avec Allow', async () => {
  const list = await send({ method: 'POST', path: '/chips', headers: cookie() });
  assert.equal(list.status, 405);
  assert.equal(list.headers.allow, 'GET');
  const search = await send({ method: 'POST', path: `/chips/${NEW}/associate`, headers: cookie() });
  assert.equal(search.status, 405);
  assert.equal(search.headers.allow, 'GET');
  const confirm = await send({ method: 'DELETE', path: `/chips/${NEW}/associate/2`, headers: cookie() });
  assert.equal(confirm.status, 405);
  assert.equal(confirm.headers.allow, 'GET, POST');
});

// ---------------------------------------------------------------- créer une fiche

test('fiche sans puce : « Donner une puce » depuis la fiche (étape U3) ; fiche avec puce : « Changer de puce » dans le menu', async () => {
  const res = await page('/items/2');
  assert.ok(res.body.includes('<a class="bouton bouton-secondaire bouton-petit" href="/items/2/puce"><svg class="ic" aria-hidden="true"><use href="#i-puce"></use></svg>Donner une puce</a>'));
  assert.ok(!res.body.includes('Changer de puce'));
  const known = (await page('/items/1')).body;
  assert.ok(!known.includes('Donner une puce'));
  assert.ok(known.includes('<a class="menu-item" href="/items/1/puce"><svg class="ic" aria-hidden="true"><use href="#i-puce"></use></svg>Changer de puce</a>'));
});

test('« Créer une fiche » : formulaire de l\'étape 5 avec l\'UID en lecture seule (aucun champ d\'UID)', async () => {
  const res = await page(`/chips/${NEW}/new`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(`<form class="formulaire-page" method="post" action="/chips/${NEW}/new">`));
  assert.ok(res.body.includes(`<p class="puce-lecture"><svg class="ic" aria-hidden="true"><use href="#i-puce"></use></svg><span class="uid">${grouped(NEW)}</span></p>`));
  assert.ok(res.body.includes('Dernier scan : Atelier, <time'));
  assert.ok(res.body.includes('name="name"') && res.body.includes('name="notes"') && res.body.includes('name="prop_key"'));
  assert.ok(res.body.includes('value="lignes"'));
  assert.ok(!/name="uid/.test(res.body));
  assert.ok(res.body.includes('<nav class="fil" aria-label="Fil d\'Ariane">\n<a href="/chips">Puces inconnues</a>'));
  assert.ok(res.body.includes('<li><a href="/chips" aria-current="true">Puces inconnues</a></li>'));
  // Lecteur non affecté : lien vers le lecteur.
  assert.ok((await page(`/chips/${LOOSE}/new`)).body.includes('Dernier scan : <a class="lien-simple" href="/readers/2">lecteur non affecté</a>'));
});

test('« Créer une fiche » : saisie invalide (400) et « Ajouter des lignes » (200) réaffichent le formulaire de la puce, sans écriture', async () => {
  const before = snapshot();
  const invalid = await post(`/chips/${NEW}/new`, { name: '  ', notes: '' });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.body.includes('Le nom est obligatoire.'));
  assert.ok(invalid.body.includes(`action="/chips/${NEW}/new"`));
  assert.ok(invalid.body.includes(`<span class="uid">${grouped(NEW)}</span>`));
  const more = await post(`/chips/${NEW}/new`, [['name', 'Étuve'], ['action', 'lignes']]);
  assert.equal(more.status, 200);
  assert.ok(more.body.includes('value="Étuve"'));
  assert.ok(more.body.includes(`action="/chips/${NEW}/new"`));
  assert.equal((more.body.match(/name="prop_key"/g) ?? []).length, 3); // aucune ligne reçue + 3 vides
  assert.equal(snapshot(), before);
});

test('« Créer une fiche » : 303 vers la fiche, localisée tout de suite au poste du scan ; puce retirée de la liste ; audit avec l\'UID ; journal inchangé', async () => {
  const scans = scansDump();
  const res = await post(`/chips/${NEW}/new`, [['name', 'Étuve'], ['notes', ''], ['prop_key', 'Marque'], ['prop_value', 'Memmert']]);
  assert.equal(res.status, 303);
  const match = /^\/items\/(\d+)\?ok=cree_puce$/.exec(res.headers.location);
  assert.ok(match, res.headers.location);
  const id = Number(match[1]);
  assert.deepEqual(lastAudit(), {
    user_id: aliceId, action: 'item.create', entity_id: id,
    details: { name: 'Étuve', properties: { Marque: 'Memmert' }, notes: '', uid: NEW },
  });
  const sheet = await page(res.headers.location);
  assert.equal(sheet.status, 200);
  assert.ok(sheet.body.includes('Fiche créée avec la puce scannée'));
  assert.ok(sheet.body.includes('<use href="#i-poste"></use></svg><a class="lien-simple lien-discret" href="/stations/1"><span class="etat etat-poste">Atelier</span></a></p>'));
  assert.ok(sheet.body.includes(`<span class="uid">${grouped(NEW)}</span>`));
  // Étape U3 : création en bas de la frise ; la puce figure dans la carte Identification.
  assert.ok(sheet.body.includes('<p class="frise-lieu">Fiche créée par alice</p>'));
  assert.ok(sheet.body.includes(`<p class="numero-puce"><span class="etiquette">Numéro de puce</span><span class="numero-puce-droite"><span class="uid">${grouped(NEW)}</span> <a class="lien-simple" href="/items/${id}/puce">Changer</a></span></p>`));
  assert.deepEqual(listedUids((await page('/chips')).body), [LOOSE]);
  assert.equal(scansDump(), scans);
  assert.ok(logs.includes(`fiche ${id} créée par alice avec la puce ${NEW}`));
  // La puce est désormais connue : tout nouvel envoi est refusé (409) sans écriture.
  const before = snapshot();
  assert.equal((await post(`/chips/${NEW}/new`, { name: 'Doublon' })).status, 409);
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- associer

test('recherche d\'association : toutes les fiches (puce actuelle, localisation) ; filtre par nom et par UID', async () => {
  const res = await page(`/chips/${LOOSE}/associate`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<h1>Associer la puce à une fiche</h1>'));
  assert.ok(res.body.includes(`<form class="recherche recherche--direct" method="get" action="/chips/${LOOSE}/associate" role="search">`));
  assert.ok(res.body.includes('aria-controls="association-resultats"'));
  assert.ok(res.body.includes('4 fiches'));
  assert.ok(res.body.includes(`<a class="bouton bouton-secondaire bouton-petit" href="/chips/${LOOSE}/associate/2"><svg class="ic" aria-hidden="true"><use href="#i-associer"></use></svg>Associer</a>`));
  assert.ok(res.body.includes('<td data-label="Puce actuelle"><span class="texte-doux">aucune puce</span></td>'));
  assert.ok(res.body.includes(`<td data-label="Puce actuelle"><span class="uid">${grouped(OLD)}</span></td>`));
  assert.ok(res.body.includes(`<a href="/chips/${LOOSE}/new">Créer une fiche pour cette puce</a>`));
  const byName = await page(`/chips/${LOOSE}/associate?q=oscillo`);
  assert.ok(byName.body.includes('1 résultat pour «&nbsp;oscillo&nbsp;»'));
  assert.ok(byName.body.includes('Oscilloscope') && !byName.body.includes('Multimètre'));
  const byUid = await page(`/chips/${LOOSE}/associate?q=04a1b2`);
  assert.ok(byUid.body.includes('1 résultat') && byUid.body.includes('Multimètre'));
  const none = await page(`/chips/${LOOSE}/associate?q=${encodeURIComponent('<script>')}`);
  assert.ok(none.body.includes('Aucune fiche ne correspond à «&nbsp;&lt;script&gt;&nbsp;».'));
});

test('confirmation sans puce existante : confirmation simple, bouton principal « Associer la puce »', async () => {
  const res = await page(`/chips/${LOOSE}/associate/2`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<h1>Associer la puce</h1>'));
  assert.ok(res.body.includes('<div class="panneau panneau-info">'));
  assert.ok(res.body.includes(`La puce <span class="uid">${grouped(LOOSE)}</span> sera associée à la fiche`));
  assert.ok(res.body.includes('<input type="hidden" name="previous" value="">'));
  assert.ok(res.body.includes(`<form method="post" action="/chips/${LOOSE}/associate/2">`));
  assert.ok(res.body.includes('<button class="bouton" type="submit">Associer la puce</button>'));
  assert.ok(!withoutHelp(res.body).includes('détachée'));
});

test('association à une fiche sans puce : 303, localisée au dernier scan, historique lisible, puce retirée, journal inchangé', async () => {
  const scans = scansDump();
  const res = await post(`/chips/${LOOSE}/associate/2`, { previous: '' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/items/2?ok=puce_associee');
  assert.deepEqual(lastAudit(), {
    user_id: aliceId, action: 'item.chip_associate', entity_id: 2,
    details: { uid: LOOSE, previous_uid: null, name: 'Oscilloscope' },
  });
  const sheet = await page(res.headers.location);
  assert.ok(sheet.body.includes('Puce associée : l&#39;emplacement de la fiche suit désormais cette puce.'));
  assert.ok(sheet.body.includes('<span class="etat etat-inconnue">lecteur non affecté</span>'));
  assert.ok(sheet.body.includes(`<p class="modification-quoi">Puce associée : <span class="uid">${grouped(LOOSE)}</span></p>`));
  assert.ok(!sheet.body.includes('Donner une puce'));
  assert.deepEqual(listedUids((await page('/chips')).body), []);
  assert.equal(scansDump(), scans);
});

test('confirmation avec une puce existante : avertissement (ancien UID, détachement, nouvelle localisation), bouton rouge', async () => {
  await scan(3, NEVER); // nouvelle puce inconnue, vue au Labo
  const res = await page(`/chips/${NEVER}/associate/1`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<h1>Remplacer la puce de la fiche</h1>'));
  assert.ok(res.body.includes('<div class="panneau panneau-danger">'));
  assert.ok(res.body.includes(`porte déjà une puce</strong> (<span class="uid">${grouped(OLD)}</span>).`));
  assert.ok(res.body.includes('L\'ancienne puce sera détachée de la fiche. Ses scans sont conservés, et elle redevient une puce inconnue.'));
  assert.ok(res.body.includes(`suivra désormais la nouvelle puce (<span class="uid">${grouped(NEVER)}</span>)`));
  assert.ok(res.body.includes(`<input type="hidden" name="previous" value="${OLD}">`));
  assert.ok(res.body.includes('<button class="bouton bouton-danger" type="submit">Remplacer la puce</button>'));
});

test('fiche changée de puce depuis la confirmation : 409, page réaffichée à jour, aucune écriture', async () => {
  const before = snapshot();
  const res = await post(`/chips/${NEVER}/associate/1`, { previous: '' });
  assert.equal(res.status, 409);
  assert.ok(res.body.includes("La fiche a changé de puce depuis l'affichage de la page précédente : rien n'a été modifié."));
  assert.ok(res.body.includes(`<input type="hidden" name="previous" value="${OLD}">`));
  assert.equal((await post(`/chips/${NEVER}/associate/1`, {})).status, 409); // champ absent
  assert.equal(snapshot(), before);
});

test('remplacement : ancienne puce détachée et tracée, de retour dans la liste ; la fiche suit la nouvelle, plus l\'ancienne', async () => {
  const scans = scansDump();
  const res = await post(`/chips/${NEVER}/associate/1`, { previous: OLD });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/items/1?ok=puce_remplacee');
  assert.deepEqual(lastAudit().details, { uid: NEVER, previous_uid: OLD, name: 'Multimètre' });
  assert.equal(scansDump(), scans);
  const sheet = await page(res.headers.location);
  assert.ok(sheet.body.includes('Puce remplacée'));
  assert.ok(sheet.body.includes('<use href="#i-poste"></use></svg><a class="lien-simple lien-discret" href="/stations/2"><span class="etat etat-poste">Labo</span></a></p>'));
  assert.ok(sheet.body.includes(`<p class="modification-quoi">Puce remplacée : <span class="uid">${grouped(NEVER)}</span> (remplace <span class="uid">${grouped(OLD)}</span>)</p>`));
  assert.ok(logs.includes(`puce ${NEVER} associée à la fiche 1 par alice (remplace ${OLD})`));
  // L'ancienne puce a des scans : elle redevient une puce inconnue.
  const list = await page('/chips');
  assert.deepEqual(listedUids(list.body), [OLD]);
  // Un scan ultérieur de l'ancienne puce ne déplace plus la fiche (Atelier) ; il compte pour la puce inconnue.
  await scan(1, OLD);
  assert.ok((await page('/items/1')).body.includes('<use href="#i-poste"></use></svg><a class="lien-simple lien-discret" href="/stations/2"><span class="etat etat-poste">Labo</span></a></p>'));
  assert.ok(chipRows((await page('/chips')).body)[0].includes(' · 2 scans</p>'));
});

test('course : deux associations simultanées du même UID à deux fiches → une réussite, un 409, sans 500 ni double écriture', async () => {
  // OLD est inconnue depuis le test précédent ; les fiches 2 et 3 sont candidates (2 porte LOOSE).
  const audits = count('audit_log');
  const [a, b] = await Promise.all([
    post(`/chips/${OLD}/associate/3`, { previous: '' }),
    post(`/chips/${OLD}/associate/2`, { previous: LOOSE }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [303, 409]);
  assert.equal(count('audit_log'), audits + 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items WHERE uid_nfc = ?').get(OLD).n, 1);
  const winner = a.status === 303 ? 3 : 2;
  assert.equal(db.prepare('SELECT id FROM items WHERE uid_nfc = ?').get(OLD).id, winner);
  const loser = a.status === 303 ? b : a;
  assert.ok(loser.body.includes('<h1>Puce déjà associée</h1>'));
  assert.ok(loser.body.includes(`href="/items/${winner}"`));
  // Création et association simultanées d'une même puce : même règle.
  await scan(1, '0102030405060708090A');
  const items = count('items');
  const [c, d] = await Promise.all([
    post('/chips/0102030405060708090A/new', { name: 'Course' }),
    post('/chips/0102030405060708090A/associate/1', { previous: NEVER }),
  ]);
  assert.deepEqual([c.status, d.status].sort(), [303, 409]);
  assert.equal(count('items'), items + (c.status === 303 ? 1 : 0));
});

test('recherche : au plus 50 fiches affichées, avec une invitation à préciser la recherche', async () => {
  await scan(1, 'ABCDEF01');
  const insert = db.prepare("INSERT INTO items (name, created_at, updated_at) VALUES (?, ?, ?)");
  for (let i = 0; i < 60; i++) insert.run(`Lot ${String(i).padStart(2, '0')}`, NOW, NOW);
  const all = await page('/chips/ABCDEF01/associate');
  assert.equal((all.body.match(/>Associer<\/a>/g) ?? []).length, 50);
  assert.match(all.body, /\d+ fiches · les 50 premières sont affichées : précisez la recherche\./);
  const lots = await page('/chips/ABCDEF01/associate?q=lot');
  assert.ok(lots.body.includes('60 résultats pour «&nbsp;lot&nbsp;» · les 50 premières sont affichées : précisez la recherche.'));
  const few = await page('/chips/ABCDEF01/associate?q=lot%205');
  // Recherche par mots (étape U2) : « lot » ET « 5 », chacun n'importe où dans le nom :
  // Lot 05, 15, 25, 35, 45 et Lot 50 à 59.
  assert.ok(few.body.includes('15 résultats'));
  assert.ok(!withoutHelp(few.body).includes('précisez la recherche'));
});

// ---------------------------------------------------------------- plafond du corps

/** POST qui annonce Content-Length sans envoyer de corps (session, Origin valides). Résout après la réponse. */
function announceOnly(path, length) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, path, method: 'POST', ca: certs.ca, agent: false,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(length), Origin: origin, ...cookie() },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        req.destroy();
      });
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
    req.flushHeaders(); // en-têtes seuls : aucun octet de corps n'est envoyé
  });
}

test('413 strict : envoi annoncé à 300 000 octets sur la création depuis une puce → exactement 413, aucune écriture', async () => {
  await scan(1, '0A0B0C0D');
  const before = snapshot();
  const res = await announceOnly('/chips/0A0B0C0D/new', 300_000);
  assert.equal(res.status, 413);
  assert.equal(res.headers.connection, 'close');
  assert.ok(res.body.includes('<h1>Formulaire trop long</h1>')); // étape U0 : plus de corps vide
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- réutilisation d'une puce, suppression

test('puce jamais associée : aucun avertissement de réutilisation (création, confirmation)', async () => {
  await scan(1, 'B0B0B0B0');
  assert.ok(!(await page('/chips/B0B0B0B0/new')).body.includes('panneau-reutilisation'));
  assert.ok(!(await page('/chips/B0B0B0B0/associate/1')).body.includes('panneau-reutilisation'));
});

test('suppression d\'une fiche avec puce : la confirmation annonce le retour de la puce dans « Puces inconnues »', async () => {
  const created = await post('/chips/B0B0B0B0/new', { name: 'Fiche éphémère' });
  const id = Number(/^\/items\/(\d+)/.exec(created.headers.location)[1]);
  const confirm = await page(`/items/${id}/delete`);
  // Étape U2 : confirmation en une phrase ; le retour de la puce est expliqué par l'aide de la page.
  assert.ok(confirm.body.includes('Fiche éphémère</strong>&nbsp;» sera supprimée ; ses déplacements restent dans l\'historique.</p>'));
  assert.ok(confirm.body.includes('Puces inconnues'));
  assert.equal((await post(`/items/${id}/delete`)).status, 303);
});

test('puce d\'une fiche supprimée : création et confirmation avertissent (nom, numéro, date, scans rattachés)', async () => {
  const deleted = db.prepare("SELECT entity_id, at FROM audit_log WHERE action = 'item.delete' ORDER BY id DESC LIMIT 1").get();
  await scan(3, 'B0B0B0B0'); // deux scans désormais
  for (const path of ['/chips/B0B0B0B0/new', '/chips/B0B0B0B0/associate/1']) {
    const res = await page(path);
    assert.equal(res.status, 200, path);
    assert.ok(res.body.includes('<div class="panneau panneau-alerte panneau-reutilisation" role="note">'), path);
    assert.ok(res.body.includes(`Cette puce a déjà appartenu à la fiche «&nbsp;Fiche éphémère&nbsp;» (n° ${deleted.entity_id}, supprimée depuis)</strong>, jusqu'au `), path);
    assert.ok(res.body.includes('Ses 2 scans enregistrés, y compris ceux de cette époque, seront rattachés à la nouvelle fiche'), path);
    assert.ok(!res.body.includes(`href="/items/${deleted.entity_id}"`), path);
  }
});

test('puce remplacée sur sa fiche : l\'avertissement cite la fiche (lien) ; une saisie refusée le garde', async () => {
  await scan(1, 'C1C1C1C1');
  await scan(1, 'C2C2C2C2');
  const created = await post('/chips/C1C1C1C1/new', { name: 'Porteuse' });
  const id = Number(/^\/items\/(\d+)/.exec(created.headers.location)[1]);
  assert.equal((await post(`/chips/C2C2C2C2/associate/${id}`, { previous: 'C1C1C1C1' })).status, 303);
  const owner = `<a href="/items/${id}">«&nbsp;Porteuse&nbsp;» (n° ${id})</a>`;
  for (const path of ['/chips/C1C1C1C1/new', '/chips/C1C1C1C1/associate/2']) {
    const res = await page(path);
    assert.ok(res.body.includes(`Cette puce a déjà appartenu à la fiche ${owner}</strong>`), path);
    assert.ok(res.body.includes('Son scan enregistré sera rattaché à la nouvelle fiche : il apparaîtra dans son historique.'), path);
  }
  const refused = await post('/chips/C1C1C1C1/new', { name: '' });
  assert.equal(refused.status, 400);
  assert.ok(refused.body.includes(owner));
});

// ---------------------------------------------------------------- toutes les pages servies

test('pages servies : aucune ressource externe, aucun style ni script en ligne, un bouton principal au plus, aucune erreur interne', () => {
  const pages = served.filter((r) => (r.headers['content-type'] ?? '').startsWith('text/html'));
  assert.ok(pages.length > 50, `${pages.length} pages`);
  for (const r of pages) assertSafePage(r.body, `${r.method} ${r.path} (${r.status})`);
  assert.ok(!served.some((r) => r.status >= 500));
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));
});
