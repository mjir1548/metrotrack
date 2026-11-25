// Exactitude de l'aide « Comment ça marche ? » (testeur) : les affirmations dont la valeur
// n'est PAS importée par server/aide.js sont confrontées au comportement réel.
// - « Ajouter des lignes » : « trois lignes » écrit en toutes lettres (BLANK_ROWS de web.js
//   n'est pas importé) ;
// - recherche : « au moins 4 caractères du numéro de puce » (règle réelle : uidFragment).
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
import { uidFragment } from '../server/inventory.js';
import { AIDE } from '../server/aide.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, db, server, port, certs, token, csrf;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-aide-exact-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('carol', DUMMY_HASH, '2026-11-20T08:00:00.000Z').lastInsertRowid);
  token = createSession(db, userId);
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

function send(method, path, body) {
  return new Promise((resolve, reject) => {
    const headers = { Cookie: `__Host-mt_session=${token}` };
    if (body !== undefined) {
      Object.assign(headers, { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body), Origin: `https://127.0.0.1:${port}` });
    }
    const req = request({ host: '127.0.0.1', port, path, method, headers, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const rows = (html) => (html.match(/name="prop_key"/g) ?? []).length;

test('« Ajouter des lignes » ajoute exactement trois lignes, comme l\'annonce l\'aide', async () => {
  const help = ['nouvelleFiche', 'ficheDepuisPuce', 'modifierFiche'];
  for (const name of help) assert.ok(String(AIDE[name]).includes('trois lignes de propriétés de plus'), name);
  const empty = await send('GET', '/items/new');
  assert.equal(empty.status, 200);
  const shown = rows(empty.body);
  // Le navigateur renvoie toutes les lignes affichées (ici vides), puis le serveur en ajoute.
  const fields = new URLSearchParams([['csrf', csrf], ['name', 'Étuve'], ['action', 'lignes']]);
  for (let i = 0; i < shown; i++) { fields.append('prop_key', ''); fields.append('prop_value', ''); }
  const more = await send('POST', '/items/new', fields.toString());
  assert.equal(more.status, 200);
  assert.equal(rows(more.body), shown + 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM items').get().n, 0, 'rien n\'est enregistré');
});

// Règle réelle (inventory.js, uidFragment) : au moins 4 caractères dont un chiffre, ou un numéro
// complet. Un fragment fait uniquement de lettres (« BEEF ») ne cherche pas dans les puces :
// l'aide (inventaire et recherche d'association) le dit.
test('aide « au moins 4 caractères du numéro de puce, dont un chiffre (ou le numéro complet) » : conforme à la règle', () => {
  assert.ok(String(AIDE.inventaire).includes('au moins 4 caractères du numéro de puce, dont un chiffre (ou le numéro complet)'));
  assert.ok(String(AIDE.associerRecherche).includes('dont un chiffre (ou le numéro complet)'));
  for (const fragment of ['BEEF', 'DEAD', 'ABCDEF']) assert.equal(uidFragment(fragment), null, fragment);
  assert.equal(uidFragment('BEE0'), 'BEE0');
  assert.equal(uidFragment('DEADBEEF'), 'DEADBEEF');
});

test('recherche par puce : 4 caractères avec un chiffre, avec ou sans séparateurs ; 3 caractères ne suffisent pas', () => {
  assert.equal(uidFragment('04:A1'), '04A1');
  assert.equal(uidFragment('04a1'), '04A1');
  assert.equal(uidFragment('04A'), null);
});
