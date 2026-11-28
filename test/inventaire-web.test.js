// Inventaire en lecture (étape 4) contre un vrai serveur HTTPS en processus : liste, recherche,
// fiche, localisation après un scan accepté, échappement de toutes les données affichées,
// fiches invalides, sessions obligatoires, en-têtes de sécurité, aucune ressource externe.
// Les sessions sont créées directement en base (createSession) : pas de calcul argon2 ici,
// la connexion elle-même est couverte par web.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';
import { withoutAppScript } from './app-script.js';

const NOW = '2026-11-17T10:00:00.000Z';
const KEY = Buffer.alloc(32, 0x55);
const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
// Données hostiles : tout ce qui pourrait casser le HTML s'il n'était pas échappé.
const EVIL_NAME = '<script>alert("nom")</script> & \'co\'';
const EVIL_STATION = 'Atelier <b>"A"</b> & Cie';
const EVIL_PROPS = { '<img src=x onerror=alert(1)>': '"><script>alert("prop")</script>', 'Clé & co': 'val\'eur <i>' };
const EVIL_NOTES = 'ligne 1\n<script>alert("note")</script>\n"ligne" 3 & fin';
let dir, db, server, port, certs, token;
const logs = [];

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-inventaire-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare('INSERT INTO stations (id, name, created_at) VALUES (1, ?, ?), (2, ?, ?)').run('Poste 1', NOW, EVIL_STATION, NOW);
  // Lecteur 1 → Poste 1 ; lecteur 7 non affecté ; lecteur 3 → poste au nom hostile.
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (7, NULL, ?, ?), (3, 2, ?, ?)')
    .run(KEY, NOW, KEY, NOW, KEY, NOW);
  const insert = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run(1, '04A1B2C3D4E5F6', 'Multimètre démo', '{"Marque":"Fluke"}', '', NOW, NOW);
  insert.run(2, 'A1B2C3D4', EVIL_NAME, JSON.stringify(EVIL_PROPS), EVIL_NOTES, NOW, NOW);
  insert.run(3, null, '100% coton_bleu', '{}', '', NOW, NOW);
  insert.run(4, null, '100 coton bleu', '{}', '', NOW, NOW);
  insert.run(5, '04112233445566', 'Jamais scanné', '{}', '', NOW, NOW);
  insert.run(6, '0A0B0C0D', 'Sur lecteur libre', '{}', '', NOW, NOW);
  const userId = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('alice', DUMMY_HASH, NOW).lastInsertRowid;
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
const search = (q) => page(`/inventaire?q=${encodeURIComponent(q)}`);

/** Lignes du tableau de l'inventaire : [{id, html}] dans l'ordre affiché. */
function rows(html) {
  const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1] ?? '';
  return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) => ({ id: Number(/href="\/items\/(\d+)"/.exec(row)[1]), html: row }));
}
const rowOf = (html, id) => rows(html).find((r) => r.id === id)?.html;
const ids = (html) => rows(html).map((r) => r.id);
// Page sans son aide « Comment ça marche ? » (texte constant qui cite le lien « Effacer »).
const withoutHelp = (html) => html.replace(/<details class="aide-page">[\s\S]*?<\/details>/, '');

// Balises autorisées dans les pages : toute autre balise (script, img, i, b...) serait une injection.
const ALLOWED_TAGS = new Set(['small', 'dialog', 'fieldset', 'legend', 'select', 'option', 'html', 'head', 'meta', 'title', 'link', 'body', 'header', 'div', 'span', 'nav', 'a', 'strong', 'form',
  'input', 'button', 'main', 'h1', 'h2', 'p', 'label', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time', 'section', 'dl', 'dt', 'dd',
  'ul', 'li', 'details', 'summary',
  'ol', 'svg', 'symbol', 'use', 'path', 'circle', 'rect', 'defs', 'clippath', 'g', 'kbd']); // ul, li, details, summary : aide « Comment ça marche ? »
const PAIRED_TAGS = ['small', 'dialog', 'fieldset', 'legend', 'div', 'span', 'a', 'p', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'section', 'dl', 'dt', 'dd', 'time', 'form', 'h1', 'h2', 'main',
  'ul', 'li', 'details', 'summary', 'ol', 'svg', 'symbol', 'use', 'kbd'];

/** HTML bien formé au sens utile ici : seulement des balises attendues, ouvrantes et fermantes équilibrées, aucun gestionnaire d'événement. */
function assertWellFormed(page, what) {
  const html = withoutAppScript(page); // seul script autorisé (D-021)
  for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `${what} : balise <${tag}>`);
  for (const tag of PAIRED_TAGS) {
    const open = html.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
    const close = html.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
    assert.equal(open, close, `${what} : <${tag}> ${open} ouvertes, ${close} fermées`);
  }
  // Attribut d'événement dans une balise (le texte échappé, lui, ne contient aucun « < »).
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, what);
  // Chaque guillemet double est dans un attribut du gabarit : nombre pair.
  assert.equal((html.match(/"/g)?.length ?? 0) % 2, 0, `${what} : guillemets déséquilibrés`);
}

function assertNoExternalResource(page, what) {
  const html = withoutAppScript(page); // seul script autorisé (D-021)
  for (const [, url] of html.matchAll(/\b(?:src|href|action)\s*=\s*"([^"]*)"/gi)) {
    assert.match(url, /^(?:\/(?!\/)|#[a-z][a-z-]*$)/, `${what} : URL non locale ${url}`);
  }
  assert.doesNotMatch(html, /https?:|\/\//i, what);
  assert.doesNotMatch(html, /<script|<style|\sstyle\s*=/i, what);
}

function assertWebHeaders(res, what) {
  assert.equal(res.headers['content-security-policy'], CSP, what);
  assert.equal(res.headers['cache-control'], 'no-store', what);
  assert.equal(res.headers['x-content-type-options'], 'nosniff', what);
  assert.equal(res.headers['referrer-policy'], 'same-origin', what);
  assert.equal(res.headers['strict-transport-security'], 'max-age=31536000', what);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8', what);
}

let counter = 0;
const scan = (readerId, uidHex) => ingestFrame(db, encodeFrame({ readerId, counter: ++counter, uid: Buffer.from(uidHex, 'hex'), key: KEY }), new Date().toISOString());

// ---------------------------------------------------------------- session obligatoire

test('sans session (ou session invalide) : toutes les pages d\'inventaire redirigent vers /login (303, sans corps)', async () => {
  for (const path of ['/', '/inventaire?q=multi', '/items/1', '/items/2', '/items/0', '/items/abc', '/items/999999', '/items/']) {
    for (const session of [null, 'A'.repeat(43)]) {
      const res = await page(path, session);
      assert.equal(res.status, 303, path);
      assert.equal(res.headers.location, '/login', path);
      assert.equal(res.body, '', path);
      assert.equal(res.headers['content-security-policy'], CSP, path);
    }
  }
});

// ---------------------------------------------------------------- liste

test('liste : en-têtes de sécurité, bandeau (Inventaire actif, compte, déconnexion avec jeton CSRF), titre', async () => {
  const res = await page('/inventaire');
  assert.equal(res.status, 200);
  assertWebHeaders(res, 'liste');
  assert.match(res.body, /<title>Inventaire · MetroTrack<\/title>/);
  assert.ok(res.body.includes('<li><a href="/inventaire" aria-current="page">Inventaire</a></li>'));
  assert.match(res.body, /<span class="visuellement-cache">Connecté en tant que <\/span><strong>alice<\/strong>/);
  assert.ok(res.body.includes(`<input type="hidden" name="csrf" value="${csrfTokenFor(token)}">`));
  assert.ok(res.body.includes('<form method="post" action="/logout">'));
  assert.ok(res.body.includes('<form class="recherche recherche--direct" method="get" action="/inventaire" role="search">'));
  assert.ok(res.body.includes('6 objets'));
});

test('liste : tri par nom insensible à la casse, une ligne par objet avec lien vers sa fiche', async () => {
  const { body } = await page('/inventaire');
  // EVIL_NAME commence par « < » : avant les chiffres et les lettres.
  assert.deepEqual(ids(body), [2, 4, 3, 5, 1, 6]);
  assert.ok(rowOf(body, 1).includes('<a class="lien-objet" href="/items/1">Multimètre démo</a>'));
  // Étape U1 : le numéro de puce n'est plus affiché sous chaque nom (seulement sur la fiche).
  assert.ok(!rowOf(body, 1).includes('class="uid"'), 'numéro de puce absent de la liste');
  assert.ok(!rowOf(body, 3).includes('class="uid"'), 'objet sans puce : pas d\'UID affiché');
});

test('objet jamais scanné : « jamais localisé » (style atténué) dans la liste et la fiche', async () => {
  const list = await page('/inventaire');
  assert.ok(rowOf(list.body, 5).includes('<span class="etat etat-jamais">jamais localisé</span>'));
  assert.ok(rowOf(list.body, 3).includes('<span class="etat etat-jamais">jamais localisé</span>'), 'objet sans puce');
  const sheet = await page('/items/5');
  assert.ok(sheet.body.includes('<span class="etat etat-jamais">jamais localisé</span>'));
  assert.ok(sheet.body.includes('Cette puce n\'a encore été scannée sur aucun poste.'));
  // Étape U3 : frise sans déplacement, avec une phrase utile.
  assert.ok(sheet.body.includes('Aucun déplacement pour l&#39;instant : la puce n&#39;a encore été scannée sur aucun lecteur.'));
});

test('après un scan accepté (POST /api/frames), la nouvelle localisation apparaît au rechargement de la liste et de la fiche', async () => {
  const before = await page('/inventaire');
  assert.ok(rowOf(before.body, 1).includes('jamais localisé'));
  const frame = encodeFrame({ readerId: 1, counter: ++counter, uid: Buffer.from('04A1B2C3D4E5F6', 'hex'), key: KEY });
  const accepted = await send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body: frame });
  assert.equal(accepted.status, 204);

  const list = await page('/inventaire');
  const row = rowOf(list.body, 1);
  assert.ok(row.includes('<span class="etat etat-poste">Poste 1</span>'), row);
  assert.match(row, /<time datetime="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z" title="[^"]+">depuis moins d&#39;une minute<\/time>/);
  const sheet = await page('/items/1');
  assert.equal(sheet.status, 200);
  assertWebHeaders(sheet, 'fiche');
  assert.ok(sheet.body.includes('<span class="etat etat-poste">Poste 1</span>'));
  assert.ok(sheet.body.includes('<span class="badge badge--ok"><svg class="ic" aria-hidden="true"><use href="#i-lecteur"></use></svg>Scanné <time '));
  assert.ok(sheet.body.includes('<p class="frise-lieu"><a class="lien-simple lien-discret" href="/stations/1">Poste 1</a></p>'));

  // Second scan, ailleurs (via ingestFrame) : la localisation suit le dernier scan.
  assert.equal(scan(3, '04A1B2C3D4E5F6').ok, true);
  const moved = await page('/inventaire');
  assert.ok(rowOf(moved.body, 1).includes('<span class="etat etat-poste">Atelier &lt;b&gt;&quot;A&quot;&lt;/b&gt; &amp; Cie</span>'));
  const movedSheet = await page('/items/1');
  assert.ok(movedSheet.body.includes('<span class="badge badge--ok"><svg class="ic" aria-hidden="true"><use href="#i-lecteur"></use></svg>Scanné <time '));
  // Historique : le plus récent d'abord.
  const history = /<ol class="frise">([\s\S]*?)<\/ol>/.exec(movedSheet.body)[1];
  assert.deepEqual([...history.matchAll(/<p class="frise-lieu">([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, '')),
    ['Atelier &lt;b&gt;&quot;A&quot;&lt;/b&gt; &amp; Cie', 'Poste 1', 'Fiche créée']); // étape U3 : création en bas (fiche insérée sans audit)
  assertWellFormed(moved.body, 'liste après déplacement');
  assertWellFormed(movedSheet.body, 'fiche après déplacement');
});

test('scan sur un lecteur non affecté : « lecteur non affecté » dans la liste, la fiche et l\'historique, avec lien vers le lecteur', async () => {
  assert.equal(scan(7, '0A0B0C0D').ok, true);
  const list = await page('/inventaire');
  assert.ok(rowOf(list.body, 6).includes('<a class="lien-etat" href="/readers/7"><span class="etat etat-inconnue">lecteur non affecté</span></a>'));
  const sheet = await page('/items/6');
  assert.ok(sheet.body.includes('<a class="lien-etat" href="/readers/7"><span class="etat etat-inconnue">lecteur non affecté</span></a>'));
  assert.ok(sheet.body.includes('<p class="frise-lieu"><a class="lien-simple lien-discret" href="/readers/7">Lecteur non affecté</a></p>'));
});

// ---------------------------------------------------------------- échappement

test('nom, propriétés, notes et nom de poste hostiles : affichés échappés, HTML bien formé, aucune balise injectée', async () => {
  assert.equal(scan(3, 'A1B2C3D4').ok, true);
  const list = await page('/inventaire');
  const escapedName = '&lt;script&gt;alert(&quot;nom&quot;)&lt;/script&gt; &amp; &#39;co&#39;';
  assert.ok(rowOf(list.body, 2).includes(`<a class="lien-objet" href="/items/2">${escapedName}</a>`));
  assert.ok(!withoutAppScript(list.body).includes('<script'));
  assertWellFormed(list.body, 'liste');

  const sheet = await page('/items/2');
  assert.equal(sheet.status, 200);
  assert.ok(sheet.body.includes(`<title>${escapedName} · MetroTrack</title>`));
  assert.ok(sheet.body.includes(`<h1>${escapedName}</h1>`));
  assert.ok(sheet.body.includes('<dt>&lt;img src=x onerror=alert(1)&gt;</dt><dd>&quot;&gt;&lt;script&gt;alert(&quot;prop&quot;)&lt;/script&gt;</dd>'));
  assert.ok(sheet.body.includes('<dt>Clé &amp; co</dt><dd>val&#39;eur &lt;i&gt;</dd>'));
  // Notes : retours à la ligne conservés tels quels (mis en forme par CSS, pre-wrap).
  assert.ok(sheet.body.includes('<p class="notes">ligne 1\n&lt;script&gt;alert(&quot;note&quot;)&lt;/script&gt;\n&quot;ligne&quot; 3 &amp; fin</p>'));
  assert.ok(sheet.body.includes('<span class="etat etat-poste">Atelier &lt;b&gt;&quot;A&quot;&lt;/b&gt; &amp; Cie</span>'));
  assert.ok(!withoutAppScript(sheet.body).includes('<script') && !sheet.body.includes('<img') && !sheet.body.includes('<b>') && !sheet.body.includes('<i>'));
  assertWellFormed(sheet.body, 'fiche');
});

test('recherche : la valeur de q est réaffichée échappée (champ et résumé), sans balise injectée', async () => {
  const q = '"><script>alert(\'q\')</script>&amp;';
  const res = await search(q);
  assert.equal(res.status, 200);
  const escaped = '&quot;&gt;&lt;script&gt;alert(&#39;q&#39;)&lt;/script&gt;&amp;amp;';
  assert.ok(res.body.includes(`value="${escaped}"`));
  assert.ok(res.body.includes(`Aucun objet ne correspond à «&nbsp;${escaped}&nbsp;».`));
  assert.ok(!withoutAppScript(res.body).includes('<script'));
  assertWellFormed(res.body, 'recherche hostile');
});

// ---------------------------------------------------------------- recherche

test('recherche par nom : sous-chaîne, insensible à la casse ; nombre de résultats et lien Effacer', async () => {
  const res = await search('MULTI');
  assert.deepEqual(ids(res.body), [1]);
  assert.ok(res.body.includes('1 résultat pour «&nbsp;MULTI&nbsp;» · <a href="/inventaire">Effacer</a>'));
  assert.ok(res.body.includes('value="MULTI"'));
  const two = await search('coton');
  assert.deepEqual(ids(two.body), [4, 3]);
  assert.ok(two.body.includes('2 résultats pour «&nbsp;coton&nbsp;»'));
});

test('recherche par nom : accents et casse ignorés au-delà de l\'ASCII', async () => {
  for (const q of ['multimetre', 'MULTIMÈTRE', 'Multimetre DEMO', 'jamais scanne']) {
    assert.equal(ids((await search(q)).body).length, 1, q);
  }
  assert.deepEqual(ids((await search('MULTIMETRE')).body), [1]);
});

test('recherche par UID : moins de 4 caractères hexadécimaux, ou sans chiffre → nom seulement', async () => {
  // « 0c0d » (avec chiffre) trouve l'UID 0A0B0C0D ; « C0D » (3 caractères) ne cherche que dans les noms.
  assert.deepEqual(ids((await search('0c0d')).body), [6]);
  assert.deepEqual(ids((await search('C0D')).body), []);
  // « dead » : mot hexadécimal sans chiffre, aucun UID cherché.
  assert.deepEqual(ids((await search('dead')).body), []);
});

test('recherche par UID : partiel, en minuscules, avec deux-points, tirets ou espaces', async () => {
  for (const q of ['D4E5', 'd4e5', 'd4:e5', 'D4-E5', 'd4 e5', '04:a1:b2:c3:d4:e5:f6']) {
    assert.deepEqual(ids((await search(q)).body), [1], q);
  }
  assert.deepEqual(ids((await search('b2c3')).body), [2, 1]);
});

test('recherche : %, _ et \\ traités littéralement', async () => {
  assert.deepEqual(ids((await search('%')).body), [3]);
  assert.deepEqual(ids((await search('_')).body), [3]);
  assert.deepEqual(ids((await search('100%')).body), [3]);
  assert.deepEqual(ids((await search('coton_bleu')).body), [3]);
  assert.deepEqual(ids((await search('\\')).body), []);
  // Encodage brut dans l'URL (un « % » seul, séquence invalide) : pas d'erreur.
  for (const raw of ['/inventaire?q=%', '/inventaire?q=%25', '/inventaire?q=%E0%A', '/inventaire?q=%00', '/inventaire?q=&q=multi', '/inventaire?q']) {
    const res = await page(raw);
    assert.equal(res.status, 200, raw);
  }
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')));
});

test('recherche : accent combinant isolé (?q=%CC%81) → tout l\'inventaire, champ vide, sans « Effacer »', async () => {
  const all = await page('/inventaire');
  for (const path of ['/inventaire?q=%CC%81', '/inventaire?q=%20%CC%81%CC%81%20']) {
    const res = await page(path);
    assert.equal(res.status, 200, path);
    assert.deepEqual(ids(res.body), ids(all.body), path);
    assert.ok(res.body.includes('id="q" name="q" type="search" value=""'), path);
    assert.ok(!withoutHelp(res.body).includes('Effacer'), path);
    assert.match(res.body, /<p class="resultats">\d+ objets<\/p>/, path);
  }
});

test('recherche : aucun résultat → message clair ; q vide ou blanc → tout l\'inventaire ; q limité à 100 caractères', async () => {
  const none = await search('zzz-introuvable');
  assert.ok(none.body.includes('Aucun objet ne correspond à «&nbsp;zzz-introuvable&nbsp;».'));
  assert.ok(none.body.includes('0 résultat pour'));
  assert.ok(!none.body.includes('<table'));
  assert.equal(ids((await search('   ')).body).length, 6);
  const long = await search('m'.repeat(300));
  assert.equal(long.status, 200);
  assert.ok(long.body.includes(`value="${'m'.repeat(100)}"`));
  assert.ok(!long.body.includes('m'.repeat(101)));
  assert.ok(long.body.includes('maxlength="100"'));
});

// ---------------------------------------------------------------- fiche

test('fiche : UID groupé en chasse fixe, propriétés en <dl>, dates, fil d\'Ariane ; objet sans puce', async () => {
  const sheet = await page('/items/1');
  assert.ok(sheet.body.includes('<span class="uid">04 A1 B2 C3 D4 E5 F6</span>'));
  assert.ok(sheet.body.includes('<dl class="proprietes">\n<div><dt>Marque</dt><dd>Fluke</dd></div>'));
  assert.ok(sheet.body.includes('<nav class="fil" aria-label="Fil d\'Ariane">\n<a href="/inventaire">Inventaire</a>'));
  // Étape U3 : carte « Identification » avec le seul numéro de puce ; la création est dans la frise.
  assert.ok(sheet.body.includes('<p class="numero-puce"><span class="etiquette">Numéro de puce</span><span class="numero-puce-droite"><span class="uid">04 A1 B2 C3 D4 E5 F6</span> <a class="lien-simple" href="/items/1/puce">Changer</a></span></p>'));
  assert.match(sheet.body, /<li class="frise-etape frise-etape--creation">\n<p class="frise-quand"><time datetime="2026-11-17T/);
  assert.ok(sheet.body.includes('<li><a href="/inventaire" aria-current="true">Inventaire</a></li>'), 'Inventaire courant (sous-page : aria-current="true")');

  const noChip = await page('/items/3');
  assert.equal(noChip.status, 200);
  assert.ok(noChip.body.includes('<p class="texte-doux">Aucune puce. <a class="lien-simple" href="/items/3/puce">Donner une puce</a></p>'));
  assert.ok(noChip.body.includes('Aucune propriété'));
  assert.ok(noChip.body.includes('Aucune note'));
  assert.ok(noChip.body.includes('Aucune puce : l\'objet ne peut pas être localisé par un scan.'));
});

test('fiche : 25 scans de suite au même poste = un seul déplacement « rescanné 24 fois », puis la création', async () => {
  for (let i = 0; i < 25; i++) assert.equal(scan(1, '04112233445566').ok, true);
  const sheet = await page('/items/5');
  const history = /<ol class="frise">([\s\S]*?)<\/ol>/.exec(sheet.body)[1];
  assert.equal(history.match(/<li class="frise-etape/g).length, 2);
  assert.match(history, /<p class="frise-suite">25 scans ici · le dernier <time /);
  assert.ok(history.includes('frise-etape--creation'));
});

test('fiches invalides ou inexistantes : 404 propre dans le gabarit, sans plantage', async () => {
  for (const id of ['0', 'abc', '1.5', '99999999999999999999', '9999999999999999', '123456', '-1', '01', '%31', '1%00', '',
    '1e3', '0x1', '%201', '1%20', '%2e%2e', '__proto__', 'constructor']) {
    const res = await page(`/items/${id}`);
    assert.equal(res.status, 404, id);
    assertWebHeaders(res, id);
    assert.ok(res.body.includes('<h1>Fiche introuvable</h1>'), id);
    assert.ok(res.body.includes('<title>Fiche introuvable · MetroTrack</title>'), id);
    assert.match(res.body, /<span class="visuellement-cache">Connecté en tant que <\/span><strong>alice<\/strong>/, id);
    assertWellFormed(res.body, id);
  }
  // Chemin plus profond : pas une route (404, page « Page introuvable » depuis l'étape U0).
  for (const path of ['/items/1/x', '/items//1', '/items']) {
    const res = await page(path);
    assert.equal(res.status, 404, path);
    assert.ok(res.body.includes('<h1>Page introuvable</h1>'), path);
    assertWebHeaders(res, path);
    assertWellFormed(res.body, path);
  }
  assert.ok(server.listening);
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')), logs.filter((l) => l.startsWith('erreur interne')).join('\n'));
});

test('méthodes autres que GET sur / et /items/<id> : 405 avec Allow: GET', async () => {
  for (const path of ['/', '/items/1', '/items/abc']) {
    const res = await send({ method: 'POST', path, headers: { Cookie: `__Host-mt_session=${token}` }, body: '' });
    assert.equal(res.status, 405, path);
    assert.equal(res.headers.allow, 'GET', path);
  }
});

// ---------------------------------------------------------------- ressources

test('aucune URL externe, aucun script ni style en ligne, sur la liste, la recherche, la fiche et le 404', async () => {
  const pages = {
    liste: (await page('/inventaire')).body,
    recherche: (await search('multi')).body,
    'sans résultat': (await search('zzz')).body,
    fiche: (await page('/items/2')).body,
    'fiche sans puce': (await page('/items/3')).body,
    introuvable: (await page('/items/0')).body,
  };
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(html.length > 500, name);
    assertNoExternalResource(html, name);
    assertWellFormed(html, name);
  }
});

test('feuille de style : notes en pre-wrap, sans URL ni import, lignes empilées sur petit écran', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'style.css'), 'utf8');
  assert.match(css, /\.notes \{[^}]*white-space: pre-wrap/);
  assert.match(css, /@media \(max-width: 40rem\)/);
  assert.doesNotMatch(css, /@import|url\(|https?:|\/\//i);
});
