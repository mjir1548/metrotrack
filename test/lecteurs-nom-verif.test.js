// Vérification complémentaire du nom libre des lecteurs (D-019), serveur HTTPS réel :
// - caractères bidi et invisibles retirés à l'enregistrement ; nom fait seulement de ces
//   caractères = nom vidé (pas d'erreur) ;
// - borne de 100 comptée APRÈS normalisation NFC (100 « é » décomposés = 200 unités envoyées) ;
// - Origin en clair (http://) refusé sur /rename ;
// - lecteur non affecté et sans nom : « Lecteur n° X » ; page « Lecteur désactivé » (409) avec
//   le nom ;
// - remplacement de clé : le simulateur (tools/simulateur.js, processus réel) est accepté avec
//   le nouveau numéro et la nouvelle clé, refusé avec l'ancienne ; frise de l'objet avec les
//   noms ACTUELS des deux lecteurs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { makeTestCerts } from './tls-fixture.js';

const ROOT = join(import.meta.dirname, '..');
const NOW = '2026-11-26T08:00:00.000Z';
const UID = '04A1B2C3D4E5F6';
// Construits par leur code : aucun caractère invisible littéral dans les sources.
const RLO = String.fromCodePoint(0x202E);
const LRI = String.fromCodePoint(0x2066);
const ZWSP = String.fromCodePoint(0x200B);
let dir, db, server, port, certs, token, csrf;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-lecteurs-nom-verif-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('alice', DUMMY_HASH, NOW).lastInsertRowid);
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Atelier', ?)").run(NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, NOW, NOW);
  token = createSession(db, userId);
  csrf = csrfTokenFor(token);
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

function send({ method = 'GET', path, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { Cookie: `__Host-mt_session=${token}`, ...headers };
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
const page = (path) => send({ path });
const post = (path, fields, origin = `https://127.0.0.1:${port}`) => send({
  method: 'POST', path, body: new URLSearchParams({ csrf, ...fields }).toString(),
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
});
const nameOf = (id) => db.prepare('SELECT name FROM readers WHERE id = ?').get(id).name;
const keyHexFrom = (res) => /<pre class="cle">([0-9a-f]{64})<\/pre>/.exec(res.body)[1];

/** Lance le vrai simulateur ; renvoie {code, output}. */
function simulate(readerId, keyHex, counter) {
  const keyFile = join(dir, `reader-${readerId}.key`);
  writeFileSync(keyFile, keyHex);
  return new Promise((resolve) => {
    execFile(process.execPath, ['tools/simulateur.js', '--reader', String(readerId), '--key-file', keyFile, '--uid', UID,
      '--counter', String(counter), '--ca', certs.caPath, '--url', `https://127.0.0.1:${port}/api/frames`],
    { cwd: ROOT }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, output: stdout + stderr }));
  });
}

let key1;

test('création sans nom et non affecté : « Lecteur n° 1 » ; bidi et invisibles retirés au renommage', async () => {
  const created = await post('/readers/new', { name: '', station: '' });
  assert.equal(created.status, 200);
  key1 = keyHexFrom(created);
  assert.equal(nameOf(1), '');
  assert.ok((await page('/readers/1')).body.includes('<h1>Lecteur n° 1</h1>'));

  assert.equal((await post('/readers/1/rename', { name: `Boîtier ${RLO}gauche${ZWSP}${LRI}` })).status, 303);
  assert.equal(nameOf(1), 'Boîtier gauche');
  // Seulement des caractères retirés : nom vidé, pas d'erreur.
  assert.equal((await post('/readers/1/rename', { name: `${ZWSP}${RLO}` })).headers.location, '/readers/1?ok=renomme');
  assert.equal(nameOf(1), '');
});

test('borne de 100 après NFC ; Origin en clair refusé', async () => {
  const decomposed = 'é'.normalize('NFD').repeat(100); // 200 unités UTF-16 envoyées
  assert.equal((await post('/readers/1/rename', { name: decomposed })).status, 303);
  assert.equal(nameOf(1), 'é'.repeat(100));
  assert.equal((await post('/readers/1/rename', { name: 'é'.repeat(101) })).status, 400);
  assert.equal((await post('/readers/1/rename', { name: 'Pirate' }, `http://127.0.0.1:${port}`)).status, 403);
  assert.equal(nameOf(1), 'é'.repeat(100));
});

test('remplacement de clé : nom repris, simulateur accepté avec la nouvelle clé, refusé avec l\'ancienne ; frise et page « désactivé »', async () => {
  assert.equal((await post('/readers/1/station', { station: '1' })).status, 303);
  assert.equal((await post('/readers/1/rename', { name: 'Boîtier établi' })).status, 303);
  const before = await simulate(1, key1, 1);
  assert.equal(before.code, 0, before.output);

  const replaced = await post('/readers/1/replace', {});
  assert.equal(replaced.status, 200);
  assert.equal(nameOf(2), 'Boîtier établi');
  const key2 = keyHexFrom(replaced);
  const ok = await simulate(2, key2, 1);
  assert.equal(ok.code, 0, ok.output);
  assert.notEqual((await simulate(1, key1, 2)).code, 0, 'ancienne clé : trame refusée');

  // Action impossible sur le lecteur désactivé : la page 409 le désigne par son nom.
  const inactive = await post('/readers/1/replace', {});
  assert.equal(inactive.status, 409);
  assert.ok(inactive.body.includes('Boîtier établi est désactivé définitivement'));

  // Frise de l'objet : nom ACTUEL de chaque lecteur.
  assert.equal((await post('/readers/1/rename', { name: 'Ancien boîtier' })).status, 303);
  const item = (await page('/items/1')).body;
  assert.ok(item.includes('Scanné par Boîtier établi'));
  assert.ok(item.includes('Scanné par Ancien boîtier'));
});
