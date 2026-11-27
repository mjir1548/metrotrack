// Vérification de l'étape 4 (testeur) : compléments à inventaire-web.test.js, contre un vrai
// serveur HTTPS en processus.
// - données hostiles exactes de la recette (balises, guillemets, entités, </textarea>,
//   javascript:, RTL, NUL, emoji) dans les noms, les propriétés (clés et valeurs), les notes,
//   le nom de poste et la recherche ;
// - recherche : encodage invalide, q répété, messages « aucun résultat » et « Effacer » ;
// - localisation (D-006) : puce scannée avant la création de sa fiche, lecteur déplacé après
//   un scan, scans à la même milliseconde, trames rejetées sans effet sur l'affichage ;
// - deux défauts trouvés à la vérification (NUL dans la recherche, puce d'état qui déborde),
//   d'abord marqués todo, corrigés depuis : tests ordinaires.
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
import { createSession } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';
import { withoutAppScript } from './app-script.js';

const NOW = '2026-11-17T10:00:00.000Z';
const KEY = Buffer.alloc(32, 0x66);
const OTHER_KEY = Buffer.alloc(32, 0x67);

// Charges de la recette (critère 4). Chacune est placée dans un nom, une clé et une valeur de
// propriété, des notes sur plusieurs lignes, et la recherche.
const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "'",
  '&amp;',
  '</textarea><svg onload=alert(1)>',
  'javascript:alert(1)',
  'RTL \u202Egnp.exe\u202C fin',
  'NUL[\u0000]',
  'emoji 🔧🧪 👩\u200D🔬 é',
];
const EVIL_STATION = '</td><script>alert("poste")</script>';

let dir, db, server, port, certs, token;
const logs = [];
const itemIds = [];

// Référence d'échappement écrite indépendamment de server/html.js.
const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-verif-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare('INSERT INTO stations (id, name, created_at) VALUES (1, ?, ?), (2, ?, ?), (3, ?, ?)')
    .run('Poste 1', NOW, 'Poste 2', NOW, EVIL_STATION, NOW);
  // 1 → Poste 1 ; 2 → Poste 2 ; 3 → poste hostile ; 4 → Poste 1 (sera déplacé) ; 5 désactivé.
  db.prepare(`INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES
    (1, 1, ?, 1, ?), (2, 2, ?, 1, ?), (3, 3, ?, 1, ?), (4, 1, ?, 1, ?), (5, 1, ?, 0, ?)`)
    .run(KEY, NOW, KEY, NOW, KEY, NOW, KEY, NOW, KEY, NOW);
  const insert = db.prepare('INSERT INTO items (uid_nfc, name, properties, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  PAYLOADS.forEach((p, i) => {
    const uid = (0x0E000000 + i).toString(16).toUpperCase().padStart(8, '0');
    const id = insert.run(uid, `P${i} ${p}`, JSON.stringify({ [p]: p, [`k${i}`]: `v ${p}` }), `ligne 1 ${p}\nligne 2 ${p}\n\n  ligne 4`, NOW, NOW).lastInsertRowid;
    itemIds.push(Number(id));
  });
  insert.run('0B0B0B0B', 'Objet déplacé', '{}', '', NOW, NOW);
  insert.run('0C0C0C0C', 'Objet ex aequo', '{}', '', NOW, NOW);
  insert.run('0A0A0A0A', 'Objet témoin', '{}', '', NOW, NOW);
  const userId = db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('verif', DUMMY_HASH, NOW).lastInsertRowid;
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
const page = (path) => send({ path, headers: { Cookie: `__Host-mt_session=${token}` } });
const postFrame = (frame) => send({ method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' }, body: frame });
const frameOf = (readerId, counter, uidHex, key = KEY) => encodeFrame({ readerId, counter, uid: Buffer.from(uidHex, 'hex'), key });
const idOf = (name) => db.prepare('SELECT id FROM items WHERE name = ?').get(name).id;
// Page sans son aide « Comment ça marche ? » (texte constant qui cite le lien « Effacer »).
const withoutHelp = (html) => html.replace(/<details class="aide-page">[\s\S]*?<\/details>/, '');
const rowOf = (html, id) => /<tbody>([\s\S]*?)<\/tbody>/.exec(html)?.[1]
  .split('</tr>').find((r) => r.includes(`href="/items/${id}"`));
// Frise des déplacements de la fiche (étape U3) : un lieu par déplacement (scans consécutifs au
// même poste regroupés), sans l'étape « Fiche créée » du bas.
const historySteps = (html) => (/<ol class="frise">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '')
  .split('</li>').filter((step) => step.includes('<li class="frise-etape') && !step.includes('frise-etape--creation'));
// Lieu : texte du lien vers le poste (étape U3, lien discret), sans les balises.
const historyStations = (html) => historySteps(html).map((step) => /<p class="frise-lieu">([\s\S]*?)<\/p>/.exec(step)[1].replace(/<[^>]+>/g, ''));
// Nombre de scans représentés : « N scans ici » pour un déplacement rescanné, sinon un.
const historyScans = (html) => historySteps(html).reduce((n, step) => n + Number(/(\d+) scans ici/.exec(step)?.[1] ?? 1), 0);
// Page sans les icônes du gabarit (sprite constant et <svg><use> décoratifs, server/icones.js) :
// tout autre <svg> serait une injection.
const SPRITE_BLOCK = /^<svg class="sprite" aria-hidden="true">\n(?:<symbol id="i-[a-z]+" [^\n]*<\/symbol>\n)*<\/svg>$/m;
const ICON_TAG = /<svg class="ic" aria-hidden="true"><use href="#i-[a-z]+"><\/use><\/svg>/g;
const LOGO_TAG = /<svg class="logo-image" viewBox="0 0 900 900" aria-hidden="true">[\s\S]*?<\/svg>/g;
const withoutIcons = (html) => html.replace(SPRITE_BLOCK, '').replace(ICON_TAG, '').replace(LOGO_TAG, '');

const ALLOWED_TAGS = new Set(['small', 'dialog', 'fieldset', 'legend', 'select', 'option', 'html', 'head', 'meta', 'title', 'link', 'body', 'header', 'div', 'span', 'nav', 'a', 'strong', 'form',
  'input', 'button', 'main', 'h1', 'h2', 'p', 'label', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'time', 'section', 'dl', 'dt', 'dd',
  'ul', 'li', 'details', 'summary',
  'ol', 'svg', 'symbol', 'use', 'path', 'circle', 'rect', 'defs', 'clippath', 'g', 'kbd']); // ul, li, details, summary : aide « Comment ça marche ? »

/**
 * Aucune balise ni aucun attribut injecté. Les valeurs d'attribut (toutes entre guillemets
 * doubles, un « " » échappé n'y figurant jamais) sont d'abord vidées : un texte comme
 * « onerror= » correctement échappé DANS une valeur n'est pas un attribut.
 */
function assertNoInjection(page, what) {
  const html = withoutAppScript(page); // seul script autorisé (D-021)
  assert.equal((html.match(/"/g)?.length ?? 0) % 2, 0, `${what} : guillemets déséquilibrés`);
  const skeleton = html.replace(/"[^"]*"/g, '""');
  for (const [, tag] of skeleton.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)) assert.ok(ALLOWED_TAGS.has(tag.toLowerCase()), `${what} : balise <${tag}>`);
  assert.doesNotMatch(skeleton, /<[^>]*\s(on[a-z]+|style|src|srcdoc|formaction)\s*=/i, `${what} : attribut injecté`);
  for (const [, url] of html.matchAll(/\b(?:href|action)="([^"]*)"/g)) assert.match(url, /^(?:\/(?!\/)|#[a-z][a-z-]*$)/, `${what} : URL ${url}`);
  for (const tag of ['td', 'tr', 'table', 'dl', 'dd', 'dt', 'p', 'section', 'h1', 'a']) {
    const open = skeleton.match(new RegExp(`<${tag}[\\s>]`, 'g'))?.length ?? 0;
    const close = skeleton.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0;
    assert.equal(open, close, `${what} : <${tag}> ${open} ouvertes, ${close} fermées`);
  }
}

// ---------------------------------------------------------------- échappement

test('recette XSS : chaque charge est affichée échappée dans la liste (nom) et la fiche (titre, h1, propriétés, notes)', async () => {
  const list = await page('/');
  assert.equal(list.status, 200);
  assertNoInjection(list.body, 'liste');
  for (const [i, p] of PAYLOADS.entries()) {
    const id = itemIds[i];
    assert.ok(rowOf(list.body, id).includes(`<a class="lien-objet" href="/items/${id}">${esc(`P${i} ${p}`)}</a>`), `liste ${i}`);

    const sheet = await page(`/items/${id}`);
    assert.equal(sheet.status, 200, `fiche ${i}`);
    assertNoInjection(sheet.body, `fiche ${i}`);
    assert.ok(sheet.body.includes(`<title>${esc(`P${i} ${p}`)} · MetroTrack</title>`), `titre ${i}`);
    assert.ok(sheet.body.includes(`<h1>${esc(`P${i} ${p}`)}</h1>`), `h1 ${i}`);
    assert.ok(sheet.body.includes(`<div><dt>${esc(p)}</dt><dd>${esc(p)}</dd></div>`), `propriété (clé et valeur) ${i}`);
    assert.ok(sheet.body.includes(`<div><dt>k${i}</dt><dd>v ${esc(p)}</dd></div>`), `propriété ${i}`);
    // Notes : sauts de ligne, ligne vide et indentation conservés tels quels (CSS pre-wrap).
    assert.ok(sheet.body.includes(`<p class="notes">ligne 1 ${esc(p)}\nligne 2 ${esc(p)}\n\n  ligne 4</p>`), `notes ${i}`);
  }
  // Rien d'exécutable n'apparaît en clair, quelle que soit la page.
  assert.doesNotMatch(withoutIcons(withoutAppScript(list.body)), /<script|<img|<svg|<\/textarea|href="javascript/i);
});

test('recette XSS : « &amp; » est ré-échappé (&amp;amp;), jamais interprété ; « \' » devient &#39;', async () => {
  const amp = await page(`/items/${itemIds[PAYLOADS.indexOf('&amp;')]}`);
  assert.ok(amp.body.includes('<h1>P3 &amp;amp;</h1>'));
  const quote = await page(`/items/${itemIds[PAYLOADS.indexOf("'")]}`);
  assert.ok(quote.body.includes('<h1>P2 &#39;</h1>'));
});

test('recette XSS : nom de poste hostile échappé dans la liste, la fiche et l\'historique', async () => {
  assert.equal(ingestFrame(db, frameOf(3, 1, '0E000000'), '2026-11-17T10:05:00.000Z').ok, true);
  const escaped = esc(EVIL_STATION);
  const list = await page('/');
  assert.ok(rowOf(list.body, itemIds[0]).includes(`<span class="etat etat-poste">${escaped}</span>`));
  assertNoInjection(list.body, 'liste');
  const sheet = await page(`/items/${itemIds[0]}`);
  assert.deepEqual(historyStations(sheet.body), [escaped]);
  assertNoInjection(sheet.body, 'fiche');
});

// Correction 2 de l'étape 4 : les caractères de contrôle (C0 dont NUL, DEL, C1) et de mise en
// forme bidirectionnelle (U+202A à U+202E, U+2066 à U+2069) sont retirés de q avant la
// recherche et le réaffichage. La valeur attendue est donc la charge sans ces caractères.
const withoutControls = (s) => s.replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '').trim();

test('recette XSS : chaque charge en recherche (q) est réaffichée échappée dans le champ et le résumé', async () => {
  for (const p of PAYLOADS) {
    const res = await page(`/?q=${encodeURIComponent(p)}`);
    assert.equal(res.status, 200, p);
    assertNoInjection(res.body, `q=${JSON.stringify(p)}`);
    const shown = esc(withoutControls(p));
    assert.ok(res.body.includes(`id="q" name="q" type="search" value="${shown}"`), `champ ${JSON.stringify(p)}`);
    assert.match(res.body, new RegExp(`\\d+ résultats? pour «&nbsp;${RegExp.escape(shown)}&nbsp;» · <a href="/">Effacer</a>`), `résumé ${JSON.stringify(p)}`);
  }
});

// ---------------------------------------------------------------- recherche

test('recherche : encodage invalide (%E9, %ZZ, %C3, %) → 200, message « aucun résultat », lien Effacer, aucune erreur interne', async () => {
  const cases = { '%E9': '�', '%ZZ': '%ZZ', '%C3': '�', '%ED%A0%80': '���', 'zz%': 'zz%' };
  for (const [raw, shown] of Object.entries(cases)) {
    const res = await page(`/?q=${raw}`);
    assert.equal(res.status, 200, raw);
    assert.ok(res.body.includes(`0 résultat pour «&nbsp;${esc(shown)}&nbsp;» · <a href="/">Effacer</a>`), raw);
    assert.ok(res.body.includes(`Aucun objet ne correspond à «&nbsp;${esc(shown)}&nbsp;».`), raw);
    assert.ok(!res.body.includes('<table'), raw);
  }
  assert.ok(!logs.some((l) => l.startsWith('erreur interne')));
});

test('recherche : q répété → seule la première valeur compte ; q vide ou absent → tout l\'inventaire sans « Effacer »', async () => {
  const twice = await page('/?q=Objet%20t%C3%A9moin&q=zzz');
  assert.ok(twice.body.includes('value="Objet témoin"'));
  assert.ok(twice.body.includes('1 résultat pour «&nbsp;Objet témoin&nbsp;» · <a href="/">Effacer</a>'));
  const firstEmpty = await page('/?q=&q=zzz');
  const all = await page('/');
  const count = /<p class="resultats">(\d+) objets<\/p>/.exec(all.body)[1];
  for (const res of [firstEmpty, all, await page('/?q'), await page('/?x=1')]) {
    assert.ok(res.body.includes(`<p class="resultats">${count} objets</p>`));
    assert.ok(!withoutHelp(res.body).includes('Effacer'));
  }
});

test('recherche : 101 caractères et plus → tronquée à 100 points de code (emoji non coupé), sans erreur', async () => {
  const q = '🔧'.repeat(150);
  const res = await page(`/?q=${encodeURIComponent(q)}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(`value="${'🔧'.repeat(100)}"`));
  assert.ok(!res.body.includes('�'));
});

test('recherche par HTTP : casse et accents ignorés, y compris saisie décomposée (NFD) ou en majuscules accentuées', async () => {
  const id = idOf('Objet témoin');
  for (const q of ['témoin', 'TÉMOIN', 'temoin', 'TEMOIN', 'témoin', 'TÉMOIN', 'oBjEt TéMoIn']) {
    const res = await page(`/?q=${encodeURIComponent(q)}`);
    assert.equal(res.status, 200, q);
    assert.ok(rowOf(res.body, id), `« ${q} » doit trouver « Objet témoin »`);
  }
});

test('recherche par HTTP : contrôles C1 (NEL) et bidi retirés de la saisie ; saisie faite uniquement de contrôles → tout l\'inventaire', async () => {
  const nel = await page('/?q=t%C3%A9moin%C2%85');
  assert.ok(nel.body.includes('1 résultat pour «&nbsp;témoin&nbsp;» · <a href="/">Effacer</a>'));
  assert.ok(nel.body.includes('value="témoin"'));
  const only = await page('/?q=%00%C2%85%E2%80%AE%E2%81%A6%7F%20');
  const all = await page('/');
  const count = /<p class="resultats">(\d+) objets<\/p>/.exec(all.body)[1];
  assert.ok(only.body.includes(`<p class="resultats">${count} objets</p>`));
  assert.ok(!withoutHelp(only.body).includes('Effacer'));
  assert.ok(only.body.includes('id="q" name="q" type="search" value=""'));
});

// ---------------------------------------------------------------- localisation (D-006)

test('puce scannée AVANT la création de sa fiche : la fiche est localisée dès sa création', async () => {
  assert.equal(ingestFrame(db, frameOf(2, 1, '0D0D0D0D'), '2026-11-17T10:10:00.000Z').ok, true);
  db.prepare("INSERT INTO items (uid_nfc, name, created_at, updated_at) VALUES ('0D0D0D0D', 'Fiche créée après le scan', ?, ?)").run(NOW, NOW);
  const id = idOf('Fiche créée après le scan');
  const list = await page('/');
  assert.ok(rowOf(list.body, id).includes('<span class="etat etat-poste">Poste 2</span>'));
  const sheet = await page(`/items/${id}`);
  assert.deepEqual(historyStations(sheet.body), ['Poste 2']);
});

test('lecteur réaffecté après un scan : le scan passé garde son poste ; le scan suivant donne le nouveau poste', async () => {
  const id = idOf('Objet déplacé');
  assert.equal(ingestFrame(db, frameOf(4, 1, '0B0B0B0B'), '2026-11-17T10:20:00.000Z').ok, true);
  db.prepare('UPDATE readers SET station_id = 2 WHERE id = 4').run();
  let sheet = await page(`/items/${id}`);
  assert.ok(sheet.body.includes('<span class="etat etat-poste">Poste 1</span>'), 'localisation figée au moment du scan');
  assert.deepEqual(historyStations(sheet.body), ['Poste 1']);
  assert.equal(ingestFrame(db, frameOf(4, 2, '0B0B0B0B'), '2026-11-17T10:21:00.000Z').ok, true);
  sheet = await page(`/items/${id}`);
  assert.ok(sheet.body.includes('<span class="etat etat-poste">Poste 2</span>'));
  assert.deepEqual(historyStations(sheet.body), ['Poste 2', 'Poste 1']);
  // Lecteur ensuite désaffecté : l'historique reste intact.
  db.prepare('UPDATE readers SET station_id = NULL WHERE id = 4').run();
  sheet = await page(`/items/${id}`);
  assert.deepEqual(historyStations(sheet.body), ['Poste 2', 'Poste 1']);
});

test('deux scans à la même milliseconde : le dernier reçu (id le plus grand) donne la localisation, et vient en tête de l\'historique', async () => {
  const id = idOf('Objet ex aequo');
  const at = '2026-11-17T10:30:00.000Z';
  assert.equal(ingestFrame(db, frameOf(2, 10, '0C0C0C0C'), at).ok, true);
  assert.equal(ingestFrame(db, frameOf(1, 10, '0C0C0C0C'), at).ok, true);
  const list = await page('/');
  assert.ok(rowOf(list.body, id).includes('<span class="etat etat-poste">Poste 1</span>'));
  const sheet = await page(`/items/${id}`);
  assert.deepEqual(historyStations(sheet.body), ['Poste 1', 'Poste 2']);
});

test('trames rejetées (rejeu, compteur ancien, lecteur inconnu ou désactivé, mauvaise clé, tronquée, trop longue) : 400 et localisation inchangée', async () => {
  const id = idOf('Objet témoin');
  assert.equal((await postFrame(frameOf(1, 50, '0A0A0A0A'))).status, 204);
  const before = await page(`/items/${id}`);
  assert.ok(before.body.includes('<span class="etat etat-poste">Poste 1</span>'));
  const scansBefore = db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;

  const valid = frameOf(2, 50, '0A0A0A0A');
  const rejected = {
    rejeu: frameOf(1, 50, '0A0A0A0A'),
    'compteur ancien': frameOf(1, 49, '0A0A0A0A'),
    'lecteur inconnu': frameOf(99, 1, '0A0A0A0A'),
    'lecteur désactivé': frameOf(5, 1, '0A0A0A0A'),
    'mauvaise clé': frameOf(2, 51, '0A0A0A0A', OTHER_KEY),
    tronquée: valid.subarray(0, valid.length - 1),
    'trop longue': Buffer.concat([valid, Buffer.alloc(1)]),
    vide: Buffer.alloc(0),
  };
  for (const [what, frame] of Object.entries(rejected)) {
    assert.equal((await postFrame(frame)).status, 400, what);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, scansBefore);
  const after = await page(`/items/${id}`);
  assert.ok(after.body.includes('<span class="etat etat-poste">Poste 1</span>'));
  assert.deepEqual(historyStations(after.body), ['Poste 1']);
});

test('scans rapprochés en parallèle sur deux lecteurs : tous acceptés, historique complet et cohérent', async () => {
  const id = idOf('Objet témoin');
  const frames = [];
  for (let c = 100; c < 110; c++) frames.push(frameOf(1, c, '0A0A0A0A'), frameOf(2, c, '0A0A0A0A'));
  const statuses = await Promise.all(frames.map(postFrame));
  assert.deepEqual([...new Set(statuses.map((r) => r.status))], [204]);
  const last = db.prepare("SELECT station_id FROM scans WHERE uid_nfc = '0A0A0A0A' ORDER BY received_at DESC, id DESC LIMIT 1").get();
  const sheet = await page(`/items/${id}`);
  assert.ok(sheet.body.includes(`<span class="etat etat-poste">Poste ${last.station_id}</span>`));
  // Tous les scans de la puce (les 20 nouveaux et celui du test précédent) sont représentés.
  assert.equal(historyScans(sheet.body), db.prepare("SELECT count(*) AS n FROM scans WHERE uid_nfc = '0A0A0A0A'").get().n);
});

// ---------------------------------------------------------------- défauts corrigés (ex-todo)

test('recherche contenant un caractère NUL : ne doit pas élargir les résultats', async () => {
  // « Objet témoin » se termine par « moin » : il ne doit pas sortir pour « moin\0zzz ».
  const res = await page('/?q=moin%00zzz');
  assert.ok(res.body.includes('Aucun objet ne correspond'), 'aucun nom ne contient « moin\\0zzz »');
});

test('puce d\'état (.etat) : un nom de poste sans espace très long passe à la ligne au lieu de déborder', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'style.css'), 'utf8');
  assert.match(/\.etat \{([^}]*)\}/.exec(css)[1], /overflow-wrap:\s*anywhere|word-break:\s*break-word/);
});
