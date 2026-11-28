// Étapes U5/U6, aller-retour 2 (retours revue UX et testeur) :
// barre (pastille de compte seule, menu sans <details>), page de clé (numéro et clé d'abord, texte
// du remplacement), état « en attente du premier scan » neutre partout, lecteurs à surveiller en
// tête, états vides avec leur bouton, formulations neutres, reprise du direct depuis le numéro
// indiqué dans la page, message du serveur pour un nom refusé, contrôles statiques d'app.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { encodeFrame } from '../server/protocol.js';
import { stationsPage, readersPage, readerKeyPage } from '../server/views.js';
import { AIDE } from '../server/aide.js';
import { makeTestCerts } from './tls-fixture.js';

const APP = readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'app.js'), 'utf8');
const KEY = Buffer.alloc(32, 0x33);
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
let dir, certs, db, server, port, token, csrf;
let counter = 0;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u56r-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const user = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('claire.martin', DUMMY_HASH, iso(NOW)).lastInsertRowid);
  db.prepare('INSERT INTO stations (id, name, created_at) VALUES (1, ?, ?), (2, ?, ?)').run('Poste A', iso(NOW), 'Magasin', iso(NOW));
  // 1 : fonctionne ; 2 : silencieux (3 jours) ; 3 : jamais utilisé.
  for (const [id, station] of [[1, 1], [2, 2], [3, 1]]) db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (?, ?, ?, 1, ?)').run(id, station, KEY, iso(NOW));
  db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (2, 2, ?, 1, ?)').run('AB000001', iso(NOW - 3 * 864e5));
  token = createSession(db, user);
  csrf = csrfTokenFor(token);
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

function send({ method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const page = (path) => send({ path, headers: { Cookie: `__Host-mt_session=${token}` } });
function post(path, fields) {
  const body = new URLSearchParams({ ...fields, csrf }).toString();
  return send({ method: 'POST', path, body, headers: { Cookie: `__Host-mt_session=${token}`, Origin: `https://127.0.0.1:${port}`, 'Content-Type': 'application/x-www-form-urlencoded' } });
}
const frame = (readerId, uid) => send({
  method: 'POST', path: '/api/frames', headers: { 'Content-Type': 'application/octet-stream' },
  body: encodeFrame({ readerId, counter: 1000 + ++counter, uid: Buffer.from(uid, 'hex'), key: KEY }),
});
const user = { username: 'claire.martin', csrf: 'x', chips: 0 };

test('barre : pastille de compte seule, nom et « Se déconnecter » dans un menu, sans <details> ni nom visible dans la barre', async () => {
  const body = (await page('/readers')).body;
  const bar = body.split('<main')[0];
  assert.ok(bar.includes('<button class="compte-bouton" type="button" title="claire.martin" aria-label="Compte : claire.martin"><span class="avatar" aria-hidden="true">CM</span></button>'));
  assert.ok(bar.includes('<p class="compte-nom"><span class="visuellement-cache">Connecté en tant que </span><strong>claire.martin</strong></p>'));
  assert.ok(bar.includes('<form method="post" action="/logout">'));
  assert.ok(!bar.includes('<details'));
  const css = readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'style.css'), 'utf8');
  // Fermé par défaut (spécificité supérieure à .menu-panneau), ouvert au focus, sans script.
  assert.match(css, /\.compte \.compte-panneau \{ display: none; \}\n\.compte:focus-within \.compte-panneau \{ display: grid; \}/);
  assert.match(css, /@media \(max-width: 1500px\) \{\n {2}\.js \.recherche-barre \.raccourci \{ display: none; \}/);
});

test('page de clé : numéro et clé d\'abord, puis « Étape suivante » avec le numéro à configurer', () => {
  const body = String(readerKeyPage(user, { id: 8, name: '', station: { id: 1, name: 'Poste A' }, keyHex: 'a'.repeat(64), oldId: 7 }));
  const key = body.indexOf('<pre class="cle">');
  assert.ok(key > 0 && key < body.indexOf('class="carte carte-corps etape-suivante"'));
  assert.ok(body.includes('<p>Configurez le numéro 8 et la clé dans le boîtier, puis scannez un objet pour vérifier.</p>'));
  assert.ok(body.includes('Copiez cette clé dans le boîtier maintenant : elle ne sera plus affichée.'));
  assert.ok(APP.includes('Rien ne vient ? Vérifiez le numéro, la clé, l\\\'alimentation et le réseau du boîtier.') || APP.includes("Rien ne vient ? Vérifiez le numéro, la clé, l\\'alimentation et le réseau du boîtier."));
  assert.match(APP, /const WAITING_HINT_MS = 60_000;/);
  assert.ok(APP.includes("isId(e.posteId) ? 'Voir le poste' : 'Voir le lecteur'"));
});

test('remplacer la clé : le numéro change aussi (panneau, page, aide)', async () => {
  const text = 'Une nouvelle clé et un nouveau numéro vont être créés. L&#39;ancien cessera de fonctionner tout de suite : mettez à jour les deux dans le boîtier.';
  assert.ok((await page('/readers/1')).body.includes(`<p class="dialogue-intro">${text}</p>`));
  assert.ok((await page('/readers/1/replace')).body.includes(`<p>${text}</p>`));
  assert.ok(String(AIDE.remplacerCle).includes('Un nouveau numéro et une nouvelle clé sont créés'));
});

test('lecteur jamais utilisé : « en attente du premier scan », neutre, partout ; silencieux en orange et en tête', async () => {
  const list = (await page('/readers')).body;
  assert.ok(list.includes('<span class="etat-lecteur etat-lecteur--jamais"><svg class="ic" aria-hidden="true"><use href="#i-lecteur"></use></svg>en attente du premier scan</span>'));
  assert.ok(!list.includes('jamais utilisé'));
  const order = ['/readers/2"', '/readers/3"', '/readers/1"'].map((href) => list.indexOf(`<a class="lien-objet" href="${href}`));
  assert.ok(order[0] < order[1] && order[0] < order[2], 'le silencieux en tête');
  const home = (await page('/')).body;
  assert.ok(home.includes('<div class="alerte-lecteur alerte-lecteur--attente" data-lecteur="3">'));
  assert.ok(home.includes('<div class="alerte-lecteur" data-lecteur="2">'));
  const sheet = (await page('/readers/2')).body;
  assert.ok(sheet.includes('Vérifiez qu&#39;il est allumé, branché et à portée du réseau.'));
  assert.ok(!sheet.includes('Sa clé n&#39;est jamais réaffichée'));
  const tiles = (await page('/stations')).body;
  assert.ok(tiles.includes('tuile-lecteur--attention" data-silencieux="2">'), 'Magasin : silencieux en orange');
  assert.ok(String(AIDE.postes).includes('en attente du premier scan'));
  for (const key of ['postes', 'lecteurs', 'nouveauLecteur', 'remplacerCle', 'desactiverLecteur', 'changerPoste', 'nouveauPoste', 'lecteur']) {
    assert.ok((String(AIDE[key]).match(/<p>/g) ?? []).length <= 3 && !String(AIDE[key]).includes('<li>'), key);
  }
  assert.ok(String(AIDE.nouveauLecteur).includes('«&nbsp;Ajouter le lecteur&nbsp;»'));
});

test('formulations neutres : « Dernière arrivée : … » sur la tuile, « Fiche créée : … » après la création rapide', async () => {
  assert.equal((await frame(1, 'AB000002')).status, 204);
  assert.equal((await post('/chips/AB000002/new', { name: 'Clé dynamométrique' })).status, 303);
  const tiles = (await page('/stations')).body;
  assert.match(tiles, /<p class="tuile-dernier" data-objet="\d+">Dernière arrivée : <a class="tuile-lien" href="\/items\/\d+">Clé dynamométrique<\/a> · <time/);
  assert.ok(!/ arrivé /.test(tiles));
  assert.ok(APP.includes("toast(['Fiche créée : ', link, ` · ${place}`]"));
  assert.ok(!(await page('/stations/1')).body.includes('Ce poste a un historique'));
});

test('états vides de Postes et de Lecteurs : leur propre bouton ; Postes vide sans « 0 poste » ni « En direct »', () => {
  const stations = String(stationsPage(user, { stations: [] }));
  assert.ok(stations.includes('Ajouter le premier poste</a>'));
  assert.ok(!stations.includes('0 poste') && !stations.includes('id="direct-etat"'));
  const readers = String(readersPage(user, { readers: [], now: NOW }));
  assert.ok(readers.includes('<a class="bouton bouton-secondaire" href="/readers/new">'));
  assert.ok(readers.includes('Ajouter le premier lecteur</a>'));
});

test('direct : la page indique le numéro du dernier événement ; app.js reprend de là, et recharge les pages chiffrées sur « resynchro »', async () => {
  assert.equal((await frame(1, 'AB000003')).status, 204);
  const body = (await page('/stations')).body;
  const shown = Number(/<span hidden id="direct-depuis" data-depuis="(\d+)"><\/span>/.exec(body)?.[1]);
  assert.equal(shown, server.direct.lastId);
  assert.match(APP, /let lastId = EVENT_ID\.test\(pageEventId\) \? pageEventId : null;/);
  assert.match(APP, /else if \(\(tiles \|\| moves \|\| guideScan\) && pageIdle\(\)\) window\.location\.reload\(\);/);
  // Hors session : aucun numéro (page de connexion).
  assert.ok(!(await send({ path: '/login' })).body.includes('direct-depuis'));
});

test('création rapide : nom refusé → la page renvoyée porte le message du serveur, repris par app.js', async () => {
  assert.equal((await frame(1, 'AB000004')).status, 204);
  const res = await post('/chips/AB000004/new', { name: 'x'.repeat(201) });
  assert.equal(res.status, 400);
  assert.match(res.body, /id="name-erreur">[^<]+</);
  assert.ok(APP.includes("Ce nom n'est pas accepté : "));
  assert.ok(APP.includes("/id=\"name-erreur\">([^<]*)</"));
});

test('puces inconnues : pas de nouvelle carte sous le curseur pendant une saisie (bandeau « Afficher »)', () => {
  assert.match(APP, /if \(!force && fresh\.length > 0 && chipsTyping\(\)\) \{/);
  assert.ok(APP.includes("count > 1 ? `${count} nouvelles puces` : '1 nouvelle puce'"));
});
