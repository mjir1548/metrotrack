// Étape U0 : coût de l'heure d'arrivée (« Depuis ») sur une base chargée : 5 000 objets,
// 300 000 scans, 2 000 corrections. Comparaison, dans la même base, avec la liste telle
// qu'elle était calculée avant l'étape U0 (vue item_locations seule, D-013).
// Bornes larges (machine de test lente ou chargée) : on détecte une dégradation grossière
// (parcours du journal, index non couvrant), pas une performance fine. Les mesures fines,
// avant / après en alternance dans un même processus, sont dans le rapport de l'étape U0.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { listItems, getItem } from '../server/inventory.js';
import { stationItems } from '../server/stations.js';

const ITEMS = 5000;
const SCANS = 300_000;
const STATIONS = 20;
const CORRECTIONS = 2000;
const IMMOBILE = 1000; // objets 0 à 999 : toujours scannés au même poste (longues séries, pire cas)
const MAX_MS = 2000;
// Base en mémoire (calcul seul, sans lecture disque) : rapport mesuré d'environ 2,5 à 3,5 avec
// la remontée bornée (MAX_RUN_SCANS), qui ajoute un petit coût fixe par objet ; sur fichier,
// environ 1,7 pour la liste et 1,3 pour la page complète. Un index non couvrant ou une
// remontée sans borne donnerait bien plus (×39 mesuré). Le rapport retenu est la médiane des
// rapports de plusieurs tours alternés (avant, après, avant, après...) : un pic de charge passager
// (tests lancés en parallèle) touche les deux mesures d'un même tour ou n'affecte qu'un tour
// isolé. Un seuil fixe de 6 sur deux médianes séparées a échoué une fois sous charge (6,99) ;
// 12 garde une marge de plus de 3 fois sous le ×39 d'une régression réelle.
const MAX_RATIO = 12;
const ROUNDS = 9;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const uidOf = (i) => (0x30000000 + i).toString(16).toUpperCase();
let db;

before(() => {
  db = openDb(':memory:');
  const at = new Date(T0).toISOString();
  let seed = 42; // mulberry32 : tirages reproductibles
  const rnd = (n) => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
  db.exec('BEGIN');
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'charge', 'x', ?)").run(at);
  const station = db.prepare('INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?)');
  const reader = db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (?, ?, ?, ?)');
  for (let s = 1; s <= STATIONS; s++) {
    station.run(s, `Poste ${s}`, at);
    reader.run(s, s, Buffer.alloc(32, s), at);
  }
  reader.run(STATIONS + 1, null, Buffer.alloc(32, 99), at); // lecteur non affecté
  const item = db.prepare('INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < ITEMS; i++) item.run(i + 1, uidOf(i), `Objet ${i}`, at, at);
  const scan = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  const counters = new Array(STATIONS + 2).fill(0);
  for (let k = 0; k < SCANS; k++) {
    const i = rnd(ITEMS);
    const home = (i % (STATIONS + 1)) + 1;
    // 70 % des scans au poste habituel de l'objet, 30 % ailleurs ; objets immobiles : toujours chez eux.
    const r = i < IMMOBILE || rnd(10) < 7 ? home : rnd(STATIONS + 1) + 1;
    scan.run(r, r > STATIONS ? null : r, uidOf(i), ++counters[r], new Date(T0 + k * 10_000).toISOString());
  }
  const correction = db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, 1, ?)');
  for (let k = 0; k < CORRECTIONS; k++) {
    correction.run(IMMOBILE + 1 + rnd(ITEMS - IMMOBILE), 1 + rnd(STATIONS), new Date(T0 + rnd(SCANS) * 10_000 + 5).toISOString());
  }
  db.exec('COMMIT');
});

after(() => db.close());

/** Médiane de 5 mesures (après 2 tours d'échauffement), en ms. */
function median(fn) {
  fn(); fn();
  const times = [];
  for (let r = 0; r < 5; r++) {
    const t = performance.now();
    fn();
    times.push(performance.now() - t);
  }
  return times.sort((a, b) => a - b)[2];
}

// La liste telle qu'elle était lue avant l'étape U0 (même requête que listItems en 3091a8a).
const BEFORE_U0 = `SELECT i.id, i.name, i.uid_nfc, l.at, l.source, l.reader_id, l.station_id, st.name AS station_name
                     FROM items i
                     LEFT JOIN item_locations l ON l.item_id = i.id
                     LEFT JOIN stations st ON st.id = l.station_id`;

test(`liste de ${ITEMS} objets, ${SCANS} scans : heure d'arrivée calculée pour tous, en moins de ${MAX_MS} ms et moins de ${MAX_RATIO} fois la liste d'avant`, (t) => {
  const old = db.prepare(BEFORE_U0);
  const timed = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  old.all(); listItems(db, ''); old.all(); listItems(db, ''); // échauffement
  const afters = [];
  const ratios = [];
  for (let r = 0; r < ROUNDS; r++) {
    const b = timed(() => old.all());
    const a = timed(() => listItems(db, ''));
    afters.push(a);
    ratios.push(a / b);
  }
  const mid = (xs) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)];
  const afterMs = mid(afters);
  const ratio = mid(ratios);
  t.diagnostic(`liste avec heure d'arrivée : ${afterMs.toFixed(1)} ms (médiane) ; rapport à la liste d'avant U0 : ${ratio.toFixed(2)} (médiane de ${ROUNDS} tours alternés)`);
  const rows = listItems(db, '');
  assert.equal(rows.length, ITEMS);
  assert.ok(rows.every((row) => row.at !== null && row.arrived_at !== null && row.arrived_at <= row.at));
  assert.ok(afterMs < MAX_MS, `${afterMs.toFixed(1)} ms`);
  assert.ok(ratio < MAX_RATIO, `rapport ${ratio.toFixed(2)}`);
});

test('objet immobile : arrivée = son tout premier scan ; la remontée de la série ne lit que l\'index (covering)', () => {
  const first = db.prepare('SELECT min(received_at) AS t FROM scans WHERE uid_nfc = ?').get(uidOf(0)).t;
  assert.equal(getItem(db, 1n).arrived_at, first);
  // La remontée des scans (s.station_id IS NOT ...) doit lire station_id dans l'index
  // scans_by_uid (migration 006), sans relire chaque ligne de la table (1,8 s sinon, mesuré).
  const seen = [];
  listItems({ prepare: (sql) => { seen.push(sql); return db.prepare(sql); } }, '');
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all().map((r) => r.detail);
  assert.ok(!plan.some((d) => /USING INDEX scans_by_uid/.test(d)), plan.join('\n'));
  assert.ok(plan.filter((d) => /USING COVERING INDEX scans_by_uid/.test(d)).length >= 3, plan.join('\n'));
  assert.ok(!plan.some((d) => /SCAN (s|s2|scans)\b|TEMP B-TREE/.test(d)), plan.join('\n'));
});

test('fiche d\'un objet et objets d\'un poste sur la base chargée : rapides', (t) => {
  const itemMs = median(() => getItem(db, 1n));
  const stationMs = median(() => stationItems(db, 1));
  t.diagnostic(`getItem : ${itemMs.toFixed(2)} ms ; stationItems : ${stationMs.toFixed(1)} ms`);
  assert.ok(itemMs < 50, `${itemMs} ms`);
  assert.ok(stationMs < MAX_MS, `${stationMs} ms`);
});
