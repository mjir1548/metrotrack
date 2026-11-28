// Étape U2, aller-retour 2 (priorité UX, D-022) : contre un vrai serveur HTTPS.
// - inventaire sans résultat : bouton « Créer la fiche « … » » (sans JS aussi), adresse encodée ;
// - indice Ctrl K dans le champ de l'inventaire, phrase d'aide ;
// - association : fiches sans puce d'abord (page et API), puce actuelle dans l'API ;
// - pages introuvables : une phrase, « Chercher un objet » et « Retour à l'inventaire » ;
// - fiche poste : colonne « Dernier scan », description sous le titre ;
// - correction d'emplacement : radios jusqu'à 12 postes, liste au-delà ;
// - formatDay : « aujourd'hui à », « hier à ».
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
import { formatDay } from '../server/dates.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-26T08:00:00.000Z';
const KEY = Buffer.alloc(32, 0x4e);
let dir, db, server, port, certs, token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u2-ux-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO stations (id, name, description, created_at) VALUES (1, 'Poste 1', 'Établi près de la fenêtre', ?), (2, 'Atelier', '', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run(KEY, NOW, KEY, NOW);
  const insert = db.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  insert.run(1, 'A1B2C3D4', 'Sonde avec puce', NOW, NOW);
  insert.run(2, null, 'Sonde sans puce', NOW, NOW);
  insert.run(3, 'A1B2C3D5', 'Autre sonde avec puce', NOW, NOW);
  assert.equal(ingestFrame(db, encodeFrame({ readerId: 1, counter: 1, uid: Buffer.from('A1B2C3D4', 'hex'), key: KEY }), new Date().toISOString()).ok, true);
  // Puce inconnue, pour la page d'association.
  assert.equal(ingestFrame(db, encodeFrame({ readerId: 1, counter: 2, uid: Buffer.from('0BADF00D', 'hex'), key: KEY }), new Date().toISOString()).ok, true);
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

function page(path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, ca: certs.ca, agent: false, headers: { Cookie: `__Host-mt_session=${token}` } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('inventaire sans résultat (sans JS) : « Créer la fiche « … » », nom encodé dans l\'adresse et échappé', async () => {
  const query = 'Pied & "coulisse" <b>';
  const res = await page(`/inventaire?q=${encodeURIComponent(query)}`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes('Aucun objet ne correspond à «&nbsp;Pied &amp; &quot;coulisse&quot; &lt;b&gt;&nbsp;».'));
  const link = /<a class="bouton bouton-secondaire" href="([^"]*)">[\s\S]*?Créer la fiche «&nbsp;([^<]*)&nbsp;»<\/a>/.exec(res.body);
  assert.ok(link, 'bouton de création');
  assert.equal(link[1], `/items/new?nom=${encodeURIComponent(query).replaceAll('&', '&amp;')}`);
  assert.equal(link[2], 'Pied &amp; &quot;coulisse&quot; &lt;b&gt;');
  // Le lien mène au formulaire, nom pré-rempli.
  const form = await page(`/items/new?nom=${encodeURIComponent(query)}`);
  assert.ok(form.body.includes('value="Pied &amp; &quot;coulisse&quot; &lt;b&gt;"'));
});

test('inventaire : indice Ctrl K dans le champ, champ filtré pendant la frappe ; aide « Ctrl K ou / »', async () => {
  const res = await page('/inventaire');
  assert.ok(res.body.includes('aria-controls="inventaire-resultats">\n<kbd class="raccourci" aria-hidden="true"><kbd>Ctrl</kbd><kbd>K</kbd></kbd>\n<button class="bouton bouton-secondaire" type="submit">Rechercher</button>'));
  assert.ok(res.body.includes('depuis n\'importe quel écran, <kbd><kbd>Ctrl</kbd><kbd>K</kbd></kbd> ou <kbd><kbd>/</kbd></kbd> ouvre la recherche «&nbsp;Où est…&nbsp;?&nbsp;».'));
  // Colonne « Depuis » : « depuis … », plus « il y a ».
  assert.match(res.body, /<td data-label="Depuis"><time datetime="[^"]+" title="[^"]+">depuis moins d&#39;une minute<\/time><\/td>/);
  assert.ok(!/<td data-label="Depuis">[^\n]*il y a/.test(res.body));
});

test('association : fiches sans puce d\'abord (page et API), puce actuelle dans l\'API', async () => {
  const res = await page('/chips/0BADF00D/associate?q=sonde');
  assert.equal(res.status, 200);
  const names = [...res.body.matchAll(/<a class="lien-objet" href="\/items\/\d+">([^<]*)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(names, ['Sonde sans puce', 'Sonde avec puce', 'Autre sonde avec puce']); // puis l'ordre de la recherche
  assert.ok(res.body.includes('<div id="association-resultats">'));
  const api = JSON.parse((await page('/api/recherche?q=sonde&pour=association')).body);
  assert.equal(api.total, 3);
  assert.deepEqual(api.resultats.map((r) => [r.nom, r.puce]), [['Sonde sans puce', null], ['Sonde avec puce', 'A1 B2 C3 D4'], ['Autre sonde avec puce', 'A1 B2 C3 D5']]);
  assert.deepEqual(Object.keys(api.resultats[0]).sort(), ['arrivee', 'emplacement', 'id', 'nom', 'puce']);
});

test('pages introuvables : une phrase claire, « Chercher un objet » (palette si JS) et « Retour à l\'inventaire »', async () => {
  for (const [path, text] of [['/items/999', 'Cette fiche n\'existe pas ou a été supprimée.'], ['/stations/999', 'Ce poste n\'existe pas ou a été supprimé.'],
    ['/readers/999', 'Ce lecteur n\'existe pas ou a été supprimé.']]) {
    const res = await page(path);
    assert.equal(res.status, 404, path);
    assert.ok(res.body.includes(`<p>${text.replaceAll("'", '&#39;')}</p>`), path);
    assert.ok(res.body.includes('<a class="bouton" href="/inventaire" data-palette="ouvrir"><svg class="ic" aria-hidden="true"><use href="#i-recherche"></use></svg>Chercher un objet</a>'), path);
    assert.ok(res.body.includes('<a class="bouton bouton-secondaire" href="/inventaire">Retour à l\'inventaire</a>'), path);
  }
});

test('fiche poste : description sous le titre, colonne « Dernier scan » des lecteurs', async () => {
  const res = await page('/stations/1');
  assert.ok(res.body.includes('<p class="description-page">Établi près de la fenêtre</p>'));
  assert.ok(res.body.includes('<th scope="col">Dernier scan</th>'));
  assert.match(res.body, /<td data-label="Dernier scan"><time datetime="[^"]+" title="[^"]+" data-age>à l&#39;instant<\/time><\/td>/);
  assert.ok(res.body.includes('>Lecteur du Poste 1</a>'));
  assert.ok((await page('/stations/2')).body.includes('>Lecteur · Atelier</a>'));
});

test('correction d\'emplacement : boutons radio jusqu\'à 12 postes, liste déroulante au-delà', async () => {
  const radios = await page('/items/1/location');
  assert.equal((radios.body.match(/<input type="radio" name="station"/g) ?? []).length, 2);
  assert.ok(radios.body.includes('<label class="choix-poste" for="station-2">'));
  const insert = db.prepare('INSERT INTO stations (name, created_at) VALUES (?, ?)');
  for (let i = 1; i <= 11; i++) insert.run(`Banc ${i}`, NOW);
  const select = await page('/items/1/location');
  assert.ok(select.body.includes('<select id="station" name="station" required'));
  assert.ok(!select.body.includes('type="radio"'));
});

test('formatDay : « aujourd\'hui à », « hier à », sinon la date', () => {
  const now = Date.parse('2026-11-26T15:00:00.000Z');
  assert.equal(formatDay('2026-11-26T14:06:00.000Z', now, 'UTC'), 'aujourd\'hui à 14:06');
  assert.equal(formatDay('2026-11-25T17:40:00.000Z', now, 'UTC'), 'hier à 17:40');
  assert.equal(formatDay('2026-11-12T09:48:00.000Z', now, 'UTC'), '12 nov. 2026 à 09:48');
  assert.equal(formatDay('x', now), 'date inconnue');
});
