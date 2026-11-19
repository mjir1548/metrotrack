// Édition des fiches (étape 5) contre un vrai serveur HTTPS en processus : création,
// modification, suppression, correction de localisation, journal audit_log, CSRF, session,
// identifiants invalides, réaffichage échappé des saisies en erreur, « Ajouter des lignes »,
// messages de confirmation constants, plafond du corps, atomicité, aucune ressource externe.
// Les sessions sont créées directement en base (createSession) : pas de calcul argon2 ici.
// Les tests s'enchaînent sur une même base (ordre du fichier).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { MAX_EDIT_FORM_BYTES, MAX_FORM_ROWS } from '../server/web.js';
import { makeTestCerts } from './tls-fixture.js';
import { statusOrCut, CUT } from './coupure.js';

const NOW = '2026-11-17T10:00:00.000Z';
const KEY = Buffer.alloc(32, 0x66);
const UID = '04AABBCCDDEEFF';
let dir, db, server, port, certs, token, csrf, origin, aliceId;
const logs = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-edition-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  // Aucun poste au départ (page de correction sans poste) ; ils sont créés plus loin.
  db.prepare("INSERT INTO items (id, uid_nfc, name, properties, notes, created_at, updated_at) VALUES (1, ?, 'Multimètre', '{\"Marque\":\"Fluke\"}', 'Note', ?, ?)")
    .run(UID, NOW, NOW);
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const cookie = (session = token) => (session ? { Cookie: `__Host-mt_session=${session}` } : {});
const page = (path, session = token) => send({ path, headers: cookie(session) });

/**
 * POST d'un formulaire. fields : objet ou liste de paires (champs répétés). Par défaut : session,
 * Origin et jeton CSRF valides ; chacun peut être retiré (null) ou remplacé.
 */
function post(path, fields = {}, { session = token, originHeader = origin, csrfField = csrf } = {}) {
  const params = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  if (csrfField !== null) params.append('csrf', csrfField);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', ...cookie(session) };
  if (originHeader !== null) headers.Origin = originHeader;
  return send({ method: 'POST', path, headers, body: params.toString() });
}

/** Champs d'un formulaire de fiche : nom, notes et lignes de propriétés [clé, valeur]. */
const itemFields = (name, notes = '', rows = [], extra = []) => [
  ['name', name], ['notes', notes], ...rows.flatMap(([k, v]) => [['prop_key', k], ['prop_value', v]]), ...extra,
];

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
// État complet des données modifiables : sert à prouver qu'une requête n'a rien écrit.
const snapshot = () => JSON.stringify({
  items: db.prepare('SELECT * FROM items ORDER BY id').all(),
  audit: count('audit_log'),
  corrections: count('location_corrections'),
});
const lastAudit = () => {
  const row = db.prepare('SELECT at, user_id, action, entity_id, details FROM audit_log ORDER BY id DESC LIMIT 1').get();
  return { ...row, details: JSON.parse(row.details) };
};
let counter = 0;
const scan = (readerId, uid) => ingestFrame(db, encodeFrame({ readerId, counter: ++counter, uid: Buffer.from(uid, 'hex'), key: KEY }), new Date().toISOString());

// Balises autorisées : celles des gabarits (formulaires compris). Toute autre serait une injection.
const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'link', 'body', 'header', 'div', 'span', 'nav', 'a', 'strong', 'form',
  'input', 'button', 'main', 'h1', 'h2', 'p', 'label', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time', 'section', 'dl', 'dt', 'dd',
  'textarea', 'select', 'option', 'fieldset', 'legend']);
const PAIRED_TAGS = ['div', 'span', 'a', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section', 'dl', 'dt', 'dd', 'time', 'form',
  'h1', 'h2', 'main', 'textarea', 'select', 'option', 'fieldset', 'legend', 'button', 'label'];

function assertSafePage(html, what) {
  for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `${what} : balise <${tag}>`);
  for (const tag of PAIRED_TAGS) {
    const open = html.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
    const close = html.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
    assert.equal(open, close, `${what} : <${tag}> ${open} ouvertes, ${close} fermées`);
  }
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, what);
  assert.equal((html.match(/"/g)?.length ?? 0) % 2, 0, `${what} : guillemets déséquilibrés`);
  // Aucune ressource externe, aucun script ni style en ligne.
  for (const [, url] of html.matchAll(/\b(?:src|href|action)\s*=\s*"([^"]*)"/gi)) assert.match(url, /^\/(?!\/)/, `${what} : URL ${url}`);
  assert.doesNotMatch(html, /https?:|\/\//i, what);
  assert.doesNotMatch(html, /<script|<style|\sstyle\s*=/i, what);
  // Un seul bouton principal par page (plein, bleu ou rouge).
  assert.equal(html.match(/class="bouton( bouton-danger)?"/g)?.length ?? 0, 1, `${what} : bouton principal unique`);
}

const nameInputs = (html, name) => html.match(new RegExp(`name="${name}"`, 'g'))?.length ?? 0;

// ---------------------------------------------------------------- session, CSRF, identifiants

const GET_ROUTES = ['/items/new', '/items/1/edit', '/items/1/delete', '/items/1/location'];
const POST_ROUTES = ['/items/new', '/items/1/edit', '/items/1/delete', '/items/1/location'];
const VALID_POST = { name: 'Écrasé', notes: 'x', station: '1' };

test('sans session (ou session inconnue) : pages d\'édition et envois → 303 vers /login, aucune écriture', async () => {
  const before = snapshot();
  for (const session of [null, 'A'.repeat(43)]) {
    for (const path of GET_ROUTES) {
      const res = await page(path, session);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/login', path);
    }
    for (const path of POST_ROUTES) {
      const res = await post(path, VALID_POST, { session });
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/login', path);
      assert.equal(res.body, '', path);
    }
  }
  assert.equal(snapshot(), before);
});

test('CSRF : chaque envoi sans jeton, avec un mauvais jeton, sans Origin ou avec une autre Origin → 403, aucune écriture', async () => {
  const before = snapshot();
  const variants = {
    'sans jeton': { csrfField: null },
    'jeton vide': { csrfField: '' },
    'mauvais jeton': { csrfField: csrfTokenFor('B'.repeat(43)) },
    'sans Origin': { originHeader: null },
    'Origin d\'un autre site': { originHeader: 'https://attaquant.example' },
    'Origin en clair': { originHeader: `http://127.0.0.1:${port}` },
    'Origin null': { originHeader: 'null' },
  };
  for (const path of POST_ROUTES) {
    for (const [name, options] of Object.entries(variants)) {
      const res = await post(path, VALID_POST, options);
      assert.equal(res.status, 403, `${path} ${name}`);
      assert.match(res.body, /<h1>Requête refusée<\/h1>/, `${path} ${name}`);
    }
  }
  assert.equal(snapshot(), before);
  assert.ok(logs.some((l) => l.startsWith('requête refusée : csrf')));
  assert.ok(logs.some((l) => l.startsWith('requête refusée : origin')));
});

test('identifiant invalide ou fiche inexistante : 404 « Fiche introuvable » sur chaque page et chaque envoi, sans écriture', async () => {
  const before = snapshot();
  for (const id of ['0', 'abc', '999999', '01', '-1', '1.5', '%31', '__proto__', 'constructor', '', 'new']) {
    for (const action of ['edit', 'delete', 'location']) {
      const path = `/items/${id}/${action}`;
      const get = await page(path);
      assert.equal(get.status, 404, path);
      assert.ok(get.body.includes('<h1>Fiche introuvable</h1>'), path);
      const sent = await post(path, VALID_POST);
      assert.equal(sent.status, 404, `POST ${path}`);
      assert.ok(sent.body.includes('<h1>Fiche introuvable</h1>'), `POST ${path}`);
    }
  }
  // Chemins qui ne sont pas des routes : 404 sans corps.
  for (const path of ['/items/1/', '/items/1/x', '/items/1/edit/', '/items/1/edit/2', '/items/1/__proto__', '/items/1/constructor', '/items']) {
    const res = await page(path);
    assert.equal(res.status, 404, path);
    assert.equal(res.body, '', path);
  }
  assert.equal(snapshot(), before);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.join('\n'));
});

test('méthodes : 405 avec Allow sur les routes d\'édition ; /items/<id> reste en lecture seule', async () => {
  const cases = [['PUT', '/items/new', 'GET, POST'], ['DELETE', '/items/1/delete', 'GET, POST'], ['POST', '/items/1', 'GET'], ['PATCH', '/items/1/edit', 'GET, POST']];
  for (const [method, path, allow] of cases) {
    const res = await send({ method, path, headers: cookie() });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.allow, allow, `${method} ${path}`);
  }
});

// ---------------------------------------------------------------- correction sans poste

test('correction de localisation sans aucun poste : message explicatif et lien vers la création d\'un poste, sans formulaire ; envoi → 400 sans écriture', async () => {
  const res = await page('/items/1/location');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes("Aucun poste n'existe encore."));
  assert.ok(res.body.includes("Il faut d'abord créer un poste pour pouvoir y localiser un objet."));
  assert.ok(!res.body.includes('<select'));
  assert.ok(res.body.includes('<a class="bouton" href="/stations/new">Créer un poste</a>'));
  // Liens : bandeau (Inventaire, Postes et lecteurs), retour à la fiche, création d'un poste (étape 6).
  assert.deepEqual([...res.body.matchAll(/href="([^"]*)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('/static/')).sort(), ['/', '/items/1', '/stations', '/stations/new']);
  const before = snapshot();
  const sent = await post('/items/1/location', { station: '1' });
  assert.equal(sent.status, 400);
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- création

test('liste et fiche : bouton principal « Nouvelle fiche » ; fiche : Modifier, Corriger la localisation, Supprimer', async () => {
  const list = await page('/');
  assert.ok(list.body.includes('<a class="bouton" href="/items/new">Nouvelle fiche</a>'));
  assert.ok(list.body.includes('<button class="bouton bouton-secondaire" type="submit">Rechercher</button>'));
  const sheet = await page('/items/1');
  assert.ok(sheet.body.includes('<a class="bouton" href="/items/1/edit">Modifier</a>'));
  assert.ok(sheet.body.includes('<a class="bouton bouton-secondaire" href="/items/1/location">Corriger la localisation</a>'));
  assert.ok(sheet.body.includes('<a class="lien-danger" href="/items/1/delete">Supprimer</a>'));
  assert.ok(sheet.body.includes('Aucune modification enregistrée.'));
});

test('formulaire de création : champs nom, notes, 3 lignes de propriétés, jeton CSRF, limites indiquées', async () => {
  const res = await page('/items/new');
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('<title>Nouvelle fiche · MetroTrack</title>'));
  assert.ok(res.body.includes('<form class="formulaire-page" method="post" action="/items/new">'));
  assert.ok(res.body.includes(`<input type="hidden" name="csrf" value="${csrf}">`));
  assert.equal(nameInputs(res.body, 'prop_key'), 3);
  assert.equal(nameInputs(res.body, 'prop_value'), 3);
  assert.match(res.body, /<input id="name" name="name" value="" maxlength="200" required/);
  assert.match(res.body, /<textarea id="notes" name="notes" rows="5" maxlength="10000"[^>]*><\/textarea>/);
  assert.ok(res.body.includes('200 caractères au plus.'));
  assert.ok(res.body.includes('<button class="bouton bouton-secondaire" type="submit" name="action" value="lignes" formnovalidate>Ajouter des lignes</button>'));
  // Le bouton d'enregistrement précède « Ajouter des lignes » : c'est lui qu'active la touche Entrée.
  assert.ok(res.body.indexOf('Créer la fiche</button>') < res.body.indexOf('Ajouter des lignes</button>'));
  assert.ok(!res.body.includes('aria-invalid'));
  assertSafePage(res.body, 'création vide');
});

test('création : 303 vers la fiche avec ?ok=cree, une ligne d\'audit item.create par alice, message et historique affichés', async () => {
  const auditBefore = count('audit_log');
  const res = await post('/items/new', itemFields('Oscilloscope Tek', 'Salle 2\r\nArmoire B', [['Marque', 'Tektronix'], ['', ''], ['Modèle', 'MDO34']]));
  assert.equal(res.status, 303);
  const match = /^\/items\/(\d+)\?ok=cree$/.exec(res.headers.location);
  assert.ok(match, res.headers.location);
  const id = Number(match[1]);
  assert.equal(count('audit_log'), auditBefore + 1);
  assert.deepEqual(lastAudit(), {
    at: lastAudit().at, user_id: aliceId, action: 'item.create', entity_id: id,
    details: { name: 'Oscilloscope Tek', properties: { Marque: 'Tektronix', Modèle: 'MDO34' }, notes: 'Salle 2\nArmoire B' },
  });
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  assert.equal(row.uid_nfc, null);
  assert.equal(row.notes, 'Salle 2\nArmoire B');

  const sheet = await page(res.headers.location);
  assert.equal(sheet.status, 200);
  assert.ok(sheet.body.includes('<p class="succes" role="status">Fiche créée.</p>'));
  assert.ok(sheet.body.includes('<p class="notes">Salle 2\nArmoire B</p>'));
  assert.ok(sheet.body.includes('<h2 id="titre-modifications">Historique des modifications</h2>'));
  assert.match(sheet.body, /<td data-label="Auteur">alice<\/td>\n<td data-label="Modification">Fiche créée<\/td>/);
  assertSafePage(sheet.body, 'fiche créée');
  assert.ok(logs.includes(`fiche ${id} créée par alice`));
});

test('création invalide : 400, saisie réaffichée échappée (y compris <script>), messages près des champs, aucune écriture', async () => {
  const before = snapshot();
  const evil = '"><script>alert(1)</script>';
  const res = await post('/items/new', itemFields('   ', `Notes ${evil}\r\nligne 2`, [
    [`<b>clé</b>`, evil], ['', 'valeur orpheline'], ['Marque', 'A'], ['MARQUE', 'B'], ['', ''],
  ]));
  assert.equal(res.status, 400);
  assert.equal(snapshot(), before);
  const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;';
  assert.ok(!res.body.includes('<script'));
  assert.ok(!res.body.includes('<b>'));
  assert.ok(res.body.includes(`<p class="erreur" role="alert">La fiche n'a pas été enregistrée.`));
  assert.ok(res.body.includes('<p class="erreur-champ" id="name-erreur">Le nom est obligatoire.</p>'));
  assert.match(res.body, /<input id="name" name="name" value="" [^>]*aria-describedby="name-aide name-erreur" aria-invalid="true">/);
  assert.ok(res.body.includes(`>Notes ${escaped}\nligne 2</textarea>`));
  assert.ok(res.body.includes(`value="&lt;b&gt;clé&lt;/b&gt;"`));
  assert.ok(res.body.includes(`value="${escaped}"`));
  assert.ok(res.body.includes('value="valeur orpheline"'));
  assert.ok(res.body.includes('Indiquez le nom de la propriété : une valeur seule ne suffit pas.'));
  assert.ok(res.body.includes('Propriété en double : « Marque » existe déjà (majuscules et minuscules confondues).'));
  assert.ok(res.body.includes('value="MARQUE"'));
  // 4 lignes non vides conservées, plus 3 lignes vides.
  assert.equal(nameInputs(res.body, 'prop_key'), 7);
  assertSafePage(res.body, 'création en erreur');
});

test('création : nom de 201 caractères et propriété de 1 001 caractères refusés (400) ; 200 et 1 000 acceptés', async () => {
  const before = snapshot();
  const tooLong = await post('/items/new', itemFields('n'.repeat(201), '', [['k', 'v'.repeat(1001)]]));
  assert.equal(tooLong.status, 400);
  assert.ok(tooLong.body.includes('(201 saisis)'));
  assert.ok(tooLong.body.includes(`value="${'n'.repeat(201)}"`), 'saisie conservée');
  assert.equal(snapshot(), before);
  const ok = await post('/items/new', itemFields('n'.repeat(200), '', [['k'.repeat(100), 'v'.repeat(1000)]]));
  assert.equal(ok.status, 303);
});

test('« Ajouter des lignes » : saisie conservée, 3 lignes vides de plus, aucune écriture, même avec un nom vide', async () => {
  const before = snapshot();
  const res = await post('/items/new', itemFields('', 'a\r\nb <i>', [['Marque', 'Fluke'], ['', ''], ['', ''], ['', '']], [['action', 'lignes']]));
  assert.equal(res.status, 200);
  assert.equal(snapshot(), before);
  assert.ok(res.body.includes('value="Marque"') && res.body.includes('value="Fluke"'));
  assert.ok(res.body.includes('>a\nb &lt;i&gt;</textarea>'));
  assert.equal(nameInputs(res.body, 'prop_key'), 1 + 6);
  assert.ok(!res.body.includes('aria-invalid') && !res.body.includes('class="erreur"'), 'pas d\'erreur affichée');
  assertSafePage(res.body, 'ajouter des lignes');
  assert.equal(snapshot(), before);
});

// Lignes de propriété : n lignes [clé, valeur].
const rowsOf = (n, fill = (i) => [`k${i}`, `v${i}`]) => Array.from({ length: n }, (_, i) => fill(i));

test('« Ajouter des lignes » répété : jamais plus de 53 lignes (50 propriétés + 3 vides) ; le formulaire affiché peut toujours être renvoyé', async () => {
  const before = snapshot();
  assert.equal(MAX_FORM_ROWS, 53);
  // On renvoie à chaque fois exactement les lignes affichées (remplies ou vides).
  let filled = rowsOf(10);
  let blanks = 3;
  for (let click = 0; click < 30; click++) {
    const res = await post('/items/new', itemFields('x', '', [...filled, ...rowsOf(blanks, () => ['', ''])], [['action', 'lignes']]));
    assert.equal(res.status, 200, `clic ${click}`);
    const shown = nameInputs(res.body, 'prop_key');
    assert.ok(shown <= MAX_FORM_ROWS, `clic ${click} : ${shown} lignes`);
    blanks = shown - filled.length;
  }
  assert.equal(blanks, MAX_FORM_ROWS - 10, 'plafond atteint, sans le dépasser');
  // 53 lignes remplies (refus : plus de 50 propriétés) : réaffiché avec 53 lignes, sans ligne vide.
  filled = rowsOf(MAX_FORM_ROWS);
  const refused = await post('/items/new', itemFields('x', '', filled));
  assert.equal(refused.status, 400);
  assert.equal(nameInputs(refused.body, 'prop_key'), MAX_FORM_ROWS);
  assert.ok(refused.body.includes('50 propriétés au plus : 53 saisies. Retirez-en 3.'));
  const again = await post('/items/new', itemFields('x', '', filled, [['action', 'lignes']]));
  assert.equal(again.status, 200);
  assert.equal(nameInputs(again.body, 'prop_key'), MAX_FORM_ROWS);
  assert.equal(snapshot(), before);
});

test('plus de 53 lignes de propriétés (prop_key ou prop_value) → 400 sans corps, connexion fermée, sans réaffichage ni écriture', async () => {
  const before = snapshot();
  const bodies = {
    '54 lignes remplies': itemFields('x', '', rowsOf(MAX_FORM_ROWS + 1)),
    '54 lignes vides + Ajouter des lignes': itemFields('x', '', rowsOf(MAX_FORM_ROWS + 1, () => ['', '']), [['action', 'lignes']]),
    '54 prop_key seules': [['name', 'x'], ...rowsOf(MAX_FORM_ROWS + 1).map(([k]) => ['prop_key', k])],
    '54 prop_value seules': [['name', 'x'], ...rowsOf(MAX_FORM_ROWS + 1).map(([, v]) => ['prop_value', v])],
  };
  for (const [what, fields] of Object.entries(bodies)) {
    for (const path of ['/items/new', '/items/1/edit']) {
      const res = await post(path, fields);
      assert.equal(res.status, 400, `${path} ${what}`);
      assert.equal(res.body, '', `${path} ${what}`);
      assert.equal(res.headers.connection, 'close', `${path} ${what}`);
    }
  }
  // Corps de 256 Kio rempli de « prop_key=a& » (environ 24 000 lignes) : même refus, réponse vide.
  const flood = `csrf=${csrf}&name=x&${'prop_key=a&'.repeat(Math.floor((MAX_EDIT_FORM_BYTES - 200) / 11))}`;
  assert.ok(flood.length <= MAX_EDIT_FORM_BYTES);
  const res = await send({ method: 'POST', path: '/items/new', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...cookie() }, body: flood });
  assert.equal(res.status, 400);
  assert.equal(res.body, '');
  assert.equal(snapshot(), before);
  assert.ok(logs.some((l) => /^formulaire de fiche refusé : \d+ lignes de propriétés \(plafond 53\)$/.test(l)));
});

test('nom fait seulement d\'un caractère invisible (name=%E2%80%8B) → 400 « Le nom est obligatoire », sans écriture', async () => {
  const before = snapshot();
  for (const encoded of ['%E2%80%8B', '%EF%BB%BF%C2%AD', '%E2%80%A8%20%E2%80%8E']) {
    const body = `csrf=${csrf}&name=${encoded}&notes=`;
    const res = await send({ method: 'POST', path: '/items/new', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin, ...cookie() }, body });
    assert.equal(res.status, 400, encoded);
    assert.ok(res.body.includes('<p class="erreur-champ" id="name-erreur">Le nom est obligatoire.</p>'), encoded);
    assert.ok(res.body.includes('<input id="name" name="name" value=""'), encoded);
  }
  assert.equal(snapshot(), before);
});

test('corps de formulaire plafonné : au-delà de 256 Kio → 413 sans écriture ; juste en dessous → traité (400 de validation)', async () => {
  const before = snapshot();
  // 413, ou connexion coupée si le serveur ferme pendant que le client écrit encore (coupure.js).
  const big = await statusOrCut(post('/items/new', itemFields('x', 'a'.repeat(MAX_EDIT_FORM_BYTES))));
  assert.ok([413, CUT].includes(big), String(big));
  const under = await post('/items/new', itemFields('x', 'a'.repeat(MAX_EDIT_FORM_BYTES - 200)));
  assert.equal(under.status, 400);
  assert.ok(under.body.includes('Les notes ne doivent pas dépasser'));
  assert.equal(snapshot(), before);
  assert.ok(server.listening);
});

// ---------------------------------------------------------------- modification

test('modification : formulaire prérempli ; envoi → 303 ?ok=modifie, audit avant/après des seuls champs changés, updated_at mis à jour', async () => {
  const form = await page('/items/1/edit');
  assert.equal(form.status, 200);
  assert.ok(form.body.includes('<form class="formulaire-page" method="post" action="/items/1/edit">'));
  assert.ok(form.body.includes('<input id="name" name="name" value="Multimètre"'));
  assert.ok(form.body.includes('>Note</textarea>'));
  assert.ok(form.body.includes('value="Marque"') && form.body.includes('value="Fluke"'));
  assert.equal(nameInputs(form.body, 'prop_key'), 1 + 3);
  assert.ok(form.body.includes('<p class="sous-titre-page">Multimètre</p>'));
  assertSafePage(form.body, 'modification');

  const auditBefore = count('audit_log');
  const res = await post('/items/1/edit', itemFields('Multimètre Fluke 87V', 'Note', [['Marque', 'Fluke'], ['Série', '1234']]));
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/items/1?ok=modifie');
  assert.equal(count('audit_log'), auditBefore + 1);
  const audit = lastAudit();
  assert.deepEqual([audit.user_id, audit.action, audit.entity_id], [aliceId, 'item.update', 1]);
  assert.deepEqual(audit.details, {
    name: { before: 'Multimètre', after: 'Multimètre Fluke 87V' },
    properties: { before: { Marque: 'Fluke' }, after: { Marque: 'Fluke', Série: '1234' } },
  });
  const row = db.prepare('SELECT updated_at, created_at FROM items WHERE id = 1').get();
  assert.notEqual(row.updated_at, NOW);
  assert.equal(row.created_at, NOW);
  const sheet = await page('/items/1?ok=modifie');
  assert.ok(sheet.body.includes('<p class="succes" role="status">Modifications enregistrées.</p>'));
  assert.ok(sheet.body.includes('<td data-label="Modification">Fiche modifiée : nom, propriétés</td>'));
});

test('modification sans changement : 303 ?ok=inchange, aucune ligne d\'audit, updated_at inchangé', async () => {
  const before = snapshot();
  const res = await post('/items/1/edit', itemFields(' Multimètre Fluke 87V ', 'Note\r\n', [['Marque', 'Fluke'], ['Série', '1234'], ['', '']]));
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/items/1?ok=inchange');
  assert.equal(snapshot(), before);
  const sheet = await page(res.headers.location);
  assert.ok(sheet.body.includes('<p class="succes" role="status">Aucune modification : la fiche était déjà à jour.</p>'));
});

test('modification invalide et « Ajouter des lignes » : saisie conservée, rien écrit', async () => {
  const before = snapshot();
  const bad = await post('/items/1/edit', itemFields('Nouveau nom', '', [['a', '1'], ['A', '2']]));
  assert.equal(bad.status, 400);
  assert.ok(bad.body.includes('value="Nouveau nom"'));
  assert.ok(bad.body.includes('<p class="sous-titre-page">Multimètre Fluke 87V</p>'), 'nom enregistré rappelé');
  const more = await post('/items/1/edit', itemFields('Nouveau nom', 'n', [['a', '1']], [['action', 'lignes']]));
  assert.equal(more.status, 200);
  assert.ok(more.body.includes('value="Nouveau nom"'));
  assert.equal(nameInputs(more.body, 'prop_key'), 1 + 3);
  assert.equal(snapshot(), before);
});

// ---------------------------------------------------------------- correction de localisation

test('correction : postes triés par nom ; poste inexistant, vide ou forgé → 400 sans écriture', async () => {
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Zone B', ?), (2, 'Atelier <b>\"A\"</b>', ?), (3, 'étuve', ?)").run(NOW, NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, NULL, ?, ?)').run(KEY, NOW, KEY, NOW);
  const form = await page('/items/1/location');
  assert.equal(form.status, 200);
  const options = [...form.body.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options, [['', 'Choisir un poste…'], ['2', 'Atelier &lt;b&gt;&quot;A&quot;&lt;/b&gt;'], ['3', 'étuve'], ['1', 'Zone B']]);
  assert.ok(form.body.includes('<span class="etat etat-jamais">jamais localisé</span>'));
  assertSafePage(form.body, 'correction');

  const before = snapshot();
  for (const station of ['999', '', 'abc', '0', '-1', '1 OR 1=1', '01', '1.0', '99999999999999999999']) {
    const res = await post('/items/1/location', { station });
    assert.equal(res.status, 400, station);
    assert.ok(res.body.includes('<p class="erreur-champ" id="station-erreur">'), station);
    assert.ok(res.body.includes('aria-invalid="true"'), station);
  }
  const missing = await post('/items/1/location', {});
  assert.equal(missing.status, 400);
  assert.ok(missing.body.includes('Choisissez un poste dans la liste.'));
  assert.equal(snapshot(), before);
  assertSafePage(missing.body, 'correction en erreur');
});

test('correction : 303 ?ok=corrige, localisation changée (liste et fiche, « correction manuelle par alice ») ; un scan ultérieur reprend la main', async () => {
  assert.equal(scan(1, UID).ok, true);
  assert.ok((await page('/items/1')).body.includes('· scan, lecteur n° 1</p>'));

  const auditBefore = count('audit_log');
  const res = await post('/items/1/location', { station: '3' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/items/1?ok=corrige');
  assert.equal(count('audit_log'), auditBefore + 1);
  assert.deepEqual(lastAudit().details, { station: { id: 3, name: 'étuve' } });
  assert.equal(lastAudit().action, 'item.location_correct');
  assert.deepEqual({ ...db.prepare('SELECT item_id, station_id, user_id FROM location_corrections').get() }, { item_id: 1, station_id: 3, user_id: aliceId });

  const sheet = await page(res.headers.location);
  assert.ok(sheet.body.includes('<p class="succes" role="status">Localisation corrigée.</p>'));
  assert.ok(sheet.body.includes('<span class="etat etat-poste">étuve</span>'));
  assert.match(sheet.body, /<p class="localisation-detail"><time [^>]*>à l&#39;instant<\/time> · correction manuelle par alice<\/p>/);
  assert.ok(sheet.body.includes('<td data-label="Modification">Localisation corrigée : étuve</td>'));
  const list = await page('/');
  assert.match(list.body, /href="\/items\/1">Multimètre Fluke 87V<\/a>[\s\S]*?<span class="etat etat-poste">étuve<\/span>/);

  // Scan ultérieur (lecteur 2, non affecté) : la localisation suit de nouveau les scans.
  assert.equal(scan(2, UID).ok, true);
  const after = await page('/items/1');
  assert.ok(after.body.includes('<span class="etat etat-inconnue">inconnue (lecteur n° 2 non affecté)</span>'));
  assert.ok(after.body.includes('· scan, lecteur n° 2</p>'));
});

// ---------------------------------------------------------------- messages de confirmation

test('?ok= : seul un code connu affiche un message constant ; code inconnu ou hostile ignoré', async () => {
  for (const ok of ['inconnu', '<script>alert(1)</script>', '__proto__', 'constructor', 'toString', 'supprime', 'CREE', '']) {
    const sheet = await page(`/items/1?ok=${encodeURIComponent(ok)}`);
    assert.equal(sheet.status, 200, ok);
    assert.ok(!sheet.body.includes('class="succes"'), ok);
    assert.ok(!sheet.body.includes('<script'), ok);
  }
  for (const ok of ['cree', 'modifie', 'xyz', '__proto__']) {
    const list = await page(`/?ok=${ok}`);
    assert.ok(!list.body.includes('class="succes"'), ok);
  }
  assert.ok((await page('/?ok=supprime')).body.includes('<p class="succes" role="status">Fiche supprimée.</p>'));
});

// ---------------------------------------------------------------- atomicité

test('atomicité : si l\'écriture d\'audit échoue, la modification est annulée (500), le serveur continue', async () => {
  const before = snapshot();
  db.exec("CREATE TEMP TRIGGER audit_en_panne BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit en panne (test)'); END");
  try {
    for (const [path, fields] of [['/items/1/edit', itemFields('Autre nom')], ['/items/1/location', { station: '1' }], ['/items/1/delete', {}], ['/items/new', itemFields('Neuve')]]) {
      const res = await post(path, fields);
      assert.equal(res.status, 500, path);
    }
  } finally {
    db.exec('DROP TRIGGER temp.audit_en_panne');
  }
  assert.equal(snapshot(), before);
  assert.equal(db.isTransaction, false);
  assert.ok(logs.some((l) => l.includes('audit en panne (test)')));
  assert.equal((await page('/items/1')).status, 200);
});

// ---------------------------------------------------------------- suppression

test('suppression : confirmation rappelant le nom et ce qui part ; envoi → 303 /?ok=supprime, corrections parties, audit et scans gardés', async () => {
  db.prepare("UPDATE items SET name = ? WHERE id = 1").run('Multi <script>"x"</script>');
  const confirm = await page('/items/1/delete');
  assert.equal(confirm.status, 200);
  assert.ok(confirm.body.includes('<strong class="nom-confirme">Multi &lt;script&gt;&quot;x&quot;&lt;/script&gt;</strong>'));
  assert.ok(confirm.body.includes("l'historique de ses corrections manuelles de localisation seront supprimés avec elle"));
  assert.ok(confirm.body.includes('Le journal des scans de sa puce et le journal des modifications sont conservés.'));
  assert.ok(confirm.body.includes('<form method="post" action="/items/1/delete">'));
  assert.ok(confirm.body.includes('<button class="bouton bouton-danger" type="submit">Supprimer définitivement</button>'));
  assertSafePage(confirm.body, 'confirmation de suppression');

  const scans = count('scans');
  const audit = count('audit_log');
  assert.equal(count('location_corrections'), 1);
  const res = await post('/items/1/delete');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/?ok=supprime');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = 1').get().n, 0);
  assert.equal(count('location_corrections'), 0);
  assert.equal(count('scans'), scans);
  assert.equal(count('audit_log'), audit + 1);
  const deleted = lastAudit();
  assert.deepEqual([deleted.action, deleted.entity_id, deleted.user_id], ['item.delete', 1, aliceId]);
  assert.equal(deleted.details.name, 'Multi <script>"x"</script>');
  assert.equal(deleted.details.uid_nfc, UID);

  const list = await page('/?ok=supprime');
  assert.ok(list.body.includes('<p class="succes" role="status">Fiche supprimée.</p>'));
  assert.ok(!list.body.includes('href="/items/1"'));
  assertSafePage(list.body, 'liste après suppression');
  assert.equal((await page('/items/1')).status, 404);
  assert.equal((await post('/items/1/delete')).status, 404, 'deuxième suppression');
  assert.equal(count('audit_log'), audit + 1);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne') && !l.includes('audit en panne')), logs.join('\n'));
});
