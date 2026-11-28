// Charge de la recherche (étape U2) : 5 000 objets avec 5 propriétés chacun et 100 000 scans.
// Critère du plan (docs/ux/plan.md, U2) : réponse en moins de 100 ms côté serveur.
// node:sqlite est synchrone : ce temps est aussi celui pendant lequel le serveur ne traite rien
// d'autre (réception des trames comprise).
//
// Stabilité sous charge (node --test lance les fichiers en parallèle) : le temps MURAL d'un appel
// gonfle quand le processus attend un cœur libre, sans que le code soit plus lent. Le seuil de
// 100 ms porte donc sur le temps CPU du fil principal (process.threadCpuUsage : recherche, SQLite,
// TLS et HTTP s'y exécutent tous), additionné sur une série puis divisé (l'horloge CPU de Windows
// avance par pas de ~15,6 ms : une mesure par appel serait trop grossière). Une série au-dessus du
// seuil est refaite jusqu'à SERIES fois et la meilleure est retenue : une vraie régression échoue
// à chaque série. Garde-fous complémentaires :
// - temps mural médian sous WALL_MS (attente bloquante, disque, verrou) ;
// - test structurel : l'emplacement (requête la plus coûteuse, sur le journal des scans) n'est
//   calculé que pour les fiches affichées (au plus MAX_SEARCH_RESULTS), jamais pour tous les
//   résultats, quel que soit leur nombre.
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
import { searchItems, normalizeQuery, MAX_SEARCH_RESULTS } from '../server/inventory.js';
import { makeTestCerts } from './tls-fixture.js';

const ITEMS = 5000;
const SCANS = 100_000;
const MAX_MS = 100;
const ROUNDS = 7;
const SERIES = 3;
const WALL_MS = 4 * MAX_MS;
const T0 = Date.parse('2026-11-01T00:00:00.000Z');
const KINDS = ['Multimètre Fluke 87V', 'Oscilloscope Tektronix', 'Étuve Memmert', 'Pied à coulisse Mitutoyo', 'Alimentation Keysight'];
const uidOf = (i) => (0x30000000 + i).toString(16).toUpperCase();
// Saisies variées : peu de résultats, beaucoup, aucun (le pire cas : chaque fiche lit ses
// propriétés), numéro de série, numéro de puce, plusieurs mots.
const QUERIES = ['fluke 7', 'multi', 'e', 'zzzz', '41234567', '3000 1388', 'electronique revise', 'mitutoyo 4999'];

let dir, db, server, port, certs, token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-recherche-charge-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const at = new Date(T0).toISOString();
  db.exec('BEGIN');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste A', ?), (2, 'Poste B', ?)").run(at, at);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run(Buffer.alloc(32, 1), at, Buffer.alloc(32, 2), at);
  const item = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 1; i <= ITEMS; i++) {
    const kind = KINDS[i % KINDS.length];
    item.run(i, uidOf(i), `${kind} n° ${i}`, JSON.stringify({
      'N° de série': String(41230000 + i), Marque: kind.split(' ')[1], Service: 'Électronique', Calibre: `Gamme étendue ${i}`, Note: 'Révisé en atelier',
    }), at, at);
  }
  const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const counters = [0, 0, 0];
  for (let i = 0; i < SCANS; i++) {
    const reader = (i % 2) + 1;
    scan.run(reader, reader, uidOf(1 + ((i * 7919) % ITEMS)), ++counters[reader], new Date(T0 + i * 60_000).toISOString());
  }
  db.exec('COMMIT');
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('charge', DUMMY_HASH, at).lastInsertRowid);
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

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const cpuNow = () => {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
};

/**
 * Mesure une opération (synchrone ou non) : {cpu, wall, result}. cpu : temps CPU moyen par appel
 * sur ROUNDS appels ; wall : médiane du temps mural. Série refaite tant que cpu ≥ MAX_MS, au plus
 * SERIES fois ; la meilleure série est rendue.
 */
async function measure(op) {
  await op(); // échauffement
  let best = null;
  for (let s = 0; s < SERIES && (best === null || best.cpu >= MAX_MS); s++) {
    const walls = [];
    let result;
    const cpu0 = cpuNow();
    for (let r = 0; r < ROUNDS; r++) {
      const start = performance.now();
      result = await op();
      walls.push(performance.now() - start);
    }
    const series = { cpu: (cpuNow() - cpu0) / ROUNDS, wall: median(walls), result, series: s + 1 };
    if (best === null || series.cpu < best.cpu) best = series;
  }
  return best;
}

function get(path) {
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

test(`searchItems sur ${ITEMS} objets avec propriétés : CPU < ${MAX_MS} ms par saisie (mural < ${WALL_MS} ms)`, async (t) => {
  for (const q of QUERIES) {
    const query = normalizeQuery(q);
    const m = await measure(() => searchItems(db, query));
    t.diagnostic(`« ${q} » : CPU ${m.cpu.toFixed(1)} ms, mural ${m.wall.toFixed(1)} ms (série ${m.series}), ${m.result.total} résultats`);
    assert.ok(m.cpu < MAX_MS, `« ${q} » : CPU ${m.cpu.toFixed(1)} ms`);
    assert.ok(m.wall < WALL_MS, `« ${q} » : mural ${m.wall.toFixed(1)} ms`);
    assert.ok(m.result.items.length <= MAX_SEARCH_RESULTS);
  }
  // Résultats attendus sur cette base.
  assert.equal(searchItems(db, '41234567').total, 1);
  assert.equal(searchItems(db, '41234567').items[0].id, 4567);
  assert.equal(searchItems(db, 'zzzz').total, 0);
  assert.equal(searchItems(db, 'e').total, ITEMS);
});

test('structure : l\'emplacement n\'est calculé que pour les fiches affichées, jamais pour tous les résultats', () => {
  // Base espionnée : chaque requête préparée et ses paramètres. searchItems n'utilise que prepare().all().
  for (const q of ['e', 'multi', 'zzzz']) {
    const calls = [];
    const spy = {
      prepare(sql) {
        const statement = db.prepare(sql);
        return { all: (...args) => { calls.push({ sql, args }); return statement.all(...args); } };
      },
    };
    const result = searchItems(spy, normalizeQuery(q));
    const located = calls.filter((c) => /\bscans\b/.test(c.sql));
    if (result.total === 0) {
      assert.equal(located.length, 0, `« ${q} » : aucun résultat, aucune lecture du journal des scans`);
      continue;
    }
    assert.equal(located.length, 1, `« ${q} » : une seule requête de localisation`);
    for (const arg of located[0].args) {
      const ids = JSON.parse(arg);
      assert.ok(Array.isArray(ids) && ids.length <= MAX_SEARCH_RESULTS, `« ${q} » : ${ids.length} fiches localisées pour ${result.total} résultats`);
    }
    // Les autres requêtes ne touchent pas au journal des scans (lecture des fiches seulement).
    assert.ok(calls.filter((c) => !/\bscans\b/.test(c.sql)).every((c) => /\bFROM items\b/.test(c.sql)), `« ${q} »`);
  }
});

test(`GET /api/recherche (HTTPS complet) : CPU < ${MAX_MS} ms par requête (mural < ${WALL_MS} ms)`, async (t) => {
  for (const q of ['fluke 7', 'zzzz', 'e']) {
    const path = `/api/recherche?q=${encodeURIComponent(q)}`;
    const m = await measure(async () => {
      const res = await get(path);
      assert.equal(res.status, 200);
      return res;
    });
    t.diagnostic(`GET ${path} : CPU ${m.cpu.toFixed(1)} ms, mural ${m.wall.toFixed(1)} ms (série ${m.series})`);
    assert.ok(m.cpu < MAX_MS, `${path} : CPU ${m.cpu.toFixed(1)} ms`);
    assert.ok(m.wall < WALL_MS, `${path} : mural ${m.wall.toFixed(1)} ms`);
  }
});
