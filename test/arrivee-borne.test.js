// Étape U0, aller-retour 2 : remontée de « Depuis » bornée à MAX_RUN_SCANS scans par objet
// (revue I1), et mention « (correction) » de la fiche poste selon l'événement d'ARRIVÉE.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { listItems, getItem, MAX_RUN_SCANS } from '../server/inventory.js';
import { stationItems } from '../server/stations.js';
import { inventoryPage, itemPage, stationPage } from '../server/views.js';
import { formatDateTime } from '../server/dates.js';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const A = 1, B = 2;
const USER = { username: 'alice', csrf: 'x' };
let db, counters;

function freshDb() {
  db?.close();
  db = openDb(':memory:');
  counters = [0, 0, 0];
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste A', ?), (2, 'Poste B', ?)").run(at(0), at(0));
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, 2, ?, ?)').run(Buffer.alloc(32, 1), at(0), Buffer.alloc(32, 2), at(0));
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', ?)").run(at(0));
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, '04A1B2C3', 'Multimètre', ?, ?)").run(at(0), at(0));
}
/** n scans d'affilée au lecteur donné, à partir de la seconde start, une par seconde. */
function scans(reader, start, n, uid = '04A1B2C3') {
  const insert = db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let k = 0; k < n; k++) insert.run(reader, reader, uid, ++counters[reader], at(start + k));
  db.exec('COMMIT');
}
const correction = (stationId, seconds) =>
  db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (1, ?, 1, ?)').run(stationId, at(seconds));
function median(fn, runs = 21) {
  fn(); fn();
  const times = [];
  for (let r = 0; r < runs; r++) { const t = performance.now(); fn(); times.push(performance.now() - t); }
  return times.sort((x, y) => x - y)[runs >> 1];
}

before(freshDb);
after(() => db.close());

test('série plus courte que la borne : résultat exact, indicateur à 0', () => {
  freshDb();
  scans(A, 0, 1);
  scans(B, 10, MAX_RUN_SCANS - 1);
  const item = getItem(db, 1n);
  assert.equal(item.arrived_at, at(10));
  assert.equal(item.arrived_at_bounded, 0);
  assert.equal(item.arrival_source, 'scan');
});

test(`puce rescannée ${3 * MAX_RUN_SCANS} fois au même poste : indicateur levé, arrivée = plus ancien scan examiné, affichage « au moins »`, () => {
  freshDb();
  scans(A, 0, 1);
  scans(B, 10, 3 * MAX_RUN_SCANS);
  const oldestExamined = at(10 + 3 * MAX_RUN_SCANS - MAX_RUN_SCANS);
  const item = getItem(db, 1n);
  assert.equal(item.station_id, B);
  assert.equal(item.arrived_at_bounded, 1);
  assert.equal(item.arrived_at, oldestExamined);
  const row = listItems(db, '')[0];
  assert.equal(row.arrived_at_bounded, 1);
  assert.equal(row.arrived_at, oldestExamined);
  const here = stationItems(db, B)[0];
  assert.equal(here.arrived_at_bounded, 1);
  assert.equal(here.arrived_at, oldestExamined);

  const now = T0 + (3 * MAX_RUN_SCANS + 100) * 1000;
  const title = formatDateTime(oldestExamined);
  const list = inventoryPage(USER, { query: '', items: listItems(db, ''), now }).toString();
  assert.ok(list.includes(`<td data-label="Depuis"><time datetime="${oldestExamined}" title="${title}">depuis au moins `), 'liste');
  const post = stationPage(USER, { station: { id: B, name: 'Poste B', description: '', created_at: at(0) }, readers: [], items: stationItems(db, B), deletable: false, now }).toString();
  assert.ok(post.includes(`<td data-label="Depuis"><time datetime="${oldestExamined}" title="${title}">depuis au moins `), 'fiche du poste');
  const sheet = itemPage(USER, { item, scans: [], history: [], now }).toString();
  assert.ok(sheet.includes(`<p class="localisation-detail"><time datetime="${oldestExamined}" title="${title}">depuis au moins `), 'fiche objet');
  assert.ok(sheet.includes(' · dernier scan <time'), 'fiche objet : dernier scan');
});

test('remontée bornée, mais correction vers un autre poste plus récente que la borne : résultat exact', () => {
  freshDb();
  scans(B, 0, 3 * MAX_RUN_SCANS);
  correction(A, 3 * MAX_RUN_SCANS - 100);
  scans(B, 3 * MAX_RUN_SCANS, 3);
  const item = getItem(db, 1n);
  assert.equal(item.arrived_at_bounded, 0);
  assert.equal(item.arrived_at, at(3 * MAX_RUN_SCANS - 99), 'premier scan au poste B après la correction vers A');
});

test('remontée bornée, puis départ et retour : de nouveau exact', () => {
  freshDb();
  scans(B, 0, 2 * MAX_RUN_SCANS);
  scans(A, 2 * MAX_RUN_SCANS, 1);
  scans(B, 2 * MAX_RUN_SCANS + 1, 5);
  const item = getItem(db, 1n);
  assert.equal(item.arrived_at_bounded, 0);
  assert.equal(item.arrived_at, at(2 * MAX_RUN_SCANS + 1));
});

test('temps borné : 50 000 puis 300 000 scans d\'affilée, la fiche et la liste ne ralentissent plus avec la longueur', (t) => {
  freshDb();
  scans(A, 0, 1);
  scans(B, 1, 50_000);
  const item50 = median(() => getItem(db, 1n));
  const list50 = median(() => listItems(db, ''));
  assert.equal(getItem(db, 1n).arrived_at_bounded, 1);
  scans(B, 50_001, 250_000);
  const item300 = median(() => getItem(db, 1n));
  const list300 = median(() => listItems(db, ''));
  assert.equal(getItem(db, 1n).arrived_at_bounded, 1);
  assert.equal(getItem(db, 1n).arrived_at, at(300_001 - MAX_RUN_SCANS));
  t.diagnostic(`fiche : ${item50.toFixed(2)} ms à 50 000 scans, ${item300.toFixed(2)} ms à 300 000 ; liste : ${list50.toFixed(2)} → ${list300.toFixed(2)} ms`);
  // Sans borne, le coût était proportionnel à la série (×6 entre 50 000 et 300 000). Marge
  // large pour une machine chargée ; 5 ms absolus couvrent le bruit des mesures très courtes.
  assert.ok(item300 < 2 * item50 + 5, `${item50.toFixed(2)} → ${item300.toFixed(2)} ms`);
  assert.ok(list300 < 2 * list50 + 5, `${list50.toFixed(2)} → ${list300.toFixed(2)} ms`);
});

// ---------------------------------------------------------------- mention « (correction) »

test('fiche poste : « (correction) » si l\'objet est ARRIVÉ par une correction, rien s\'il est arrivé par un scan', () => {
  freshDb();
  const now = T0 + 1_000_000;
  const mention = () => {
    const html = stationPage(USER, { station: { id: B, name: 'Poste B', description: '', created_at: at(0) }, readers: [], items: stationItems(db, B), deletable: false, now }).toString();
    return /<td data-label="Depuis">[\s\S]*?<\/td>/.exec(html)[0].includes('(correction)');
  };
  // Arrivé par une correction, puis scanné au même poste : la mention reste (avant : disparaissait).
  scans(A, 0, 1);
  correction(B, 10);
  assert.equal(stationItems(db, B)[0].arrival_source, 'manual');
  assert.equal(mention(), true);
  scans(B, 20, 2);
  assert.equal(stationItems(db, B)[0].arrival_source, 'manual');
  assert.equal(stationItems(db, B)[0].source, 'scan');
  assert.equal(mention(), true);

  // Arrivé par un scan, puis corrigé vers le même poste : pas de mention (avant : affichée).
  freshDb();
  scans(A, 0, 1);
  scans(B, 10, 2);
  correction(B, 20);
  assert.equal(stationItems(db, B)[0].source, 'manual');
  assert.equal(stationItems(db, B)[0].arrival_source, 'scan');
  assert.equal(mention(), false);

  // Scan et correction à la même milliseconde, au même poste : le scan précède (ordre de la vue).
  freshDb();
  scans(A, 0, 1);
  scans(B, 10, 1);
  correction(B, 10);
  assert.equal(stationItems(db, B)[0].arrival_source, 'scan');
});
