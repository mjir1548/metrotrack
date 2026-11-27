// Étape U0 : « Depuis » = heure d'ARRIVÉE à l'emplacement actuel (server/inventory.js,
// withLocations), et non plus l'heure du dernier événement. Unité, sur une base en mémoire.
// L'heure d'arrivée est le premier événement (scan de la puce actuelle ou correction manuelle)
// de la dernière série ininterrompue au même emplacement ; « lecteur non affecté » (NULL) est
// un emplacement à part entière.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { listItems, getItem } from '../server/inventory.js';
import { stationItems } from '../server/stations.js';
import { inventoryPage, itemPage, stationPage } from '../server/views.js';

const T0 = Date.parse('2026-11-23T08:00:00.000Z'); // lundi
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const DAY = 24 * 60;
const UID = '04A1B2C3';
const OTHER_UID = '0BADC0DE';
// Lecteurs : 1 → poste A (1), 2 → poste B (2), 3 → poste C (3), 4 → non affecté.
const A = 1, B = 2, C = 3, NONE = 4;
let db, counter;

beforeEach(() => {
  db = openDb(':memory:');
  counter = 0;
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste A', ?), (2, 'Poste B', ?), (3, 'Poste C', ?)").run(at(0), at(0), at(0));
  const reader = db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (?, ?, ?, ?)');
  for (const [id, station] of [[1, 1], [2, 2], [3, 3], [4, null]]) reader.run(id, station, Buffer.alloc(32, id), at(0));
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', ?)").run(at(0));
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, at(0), at(0));
});
afterEach(() => db.close());

/** Scan accepté (inséré tel que le ferait ingestFrame : poste du lecteur figé au moment du scan). */
function scan(readerId, minutes, uid = UID) {
  db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) SELECT id, station_id, ?, ?, ? FROM readers WHERE id = ?')
    .run(uid, ++counter, at(minutes), readerId);
}
function correction(stationId, minutes, itemId = 1) {
  db.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (?, ?, 1, ?)').run(itemId, stationId, at(minutes));
}

/** Heure d'arrivée lue par les trois chemins (liste, fiche, poste), qui doivent concorder. */
function arrival(itemId = 1) {
  const fromList = listItems(db, '').find((row) => row.id === itemId);
  const fromItem = getItem(db, BigInt(itemId));
  assert.equal(fromItem.arrived_at, fromList.arrived_at, 'liste et fiche');
  assert.equal(fromItem.at, fromList.at, 'dernier événement : liste et fiche');
  if (fromItem.station_id !== null) {
    const fromStation = stationItems(db, fromItem.station_id).find((row) => row.id === itemId);
    assert.equal(fromStation.arrived_at, fromItem.arrived_at, 'fiche du poste');
  }
  return fromItem.arrived_at;
}
const station = () => getItem(db, 1n).station_id;

test('objet jamais localisé : arrived_at NULL partout', () => {
  assert.equal(arrival(), null);
  assert.equal(getItem(db, 1n).at, null);
});

test('une seule série : arrivée = premier scan de la série, même si l\'objet est rescanné ensuite', () => {
  scan(B, 0);
  assert.equal(arrival(), at(0));
  scan(B, 3 * DAY);
  scan(B, 3 * DAY + 20);
  assert.equal(arrival(), at(0), 'au poste B depuis 3 jours, rescanné il y a peu');
  assert.equal(getItem(db, 1n).at, at(3 * DAY + 20), 'le dernier événement reste le dernier scan');
});

test('exemple du cahier : B (lundi), A (mardi), B (mercredi 9 h), B (mercredi 14 h) → arrivée mercredi 9 h', () => {
  scan(B, 0);
  scan(A, DAY);
  scan(B, 2 * DAY + 60);
  scan(B, 2 * DAY + 6 * 60);
  assert.equal(station(), B);
  assert.equal(arrival(), at(2 * DAY + 60));
});

test('aller-retour A → B → A : l\'arrivée est le retour en A, pas le premier passage', () => {
  scan(A, 0);
  scan(A, 10);
  scan(B, 20);
  scan(A, 30);
  scan(A, 40);
  assert.equal(station(), A);
  assert.equal(arrival(), at(30));
});

test('correction manuelle puis scans au même poste : arrivée = l\'heure de la correction', () => {
  scan(A, 0);
  correction(B, 10);
  assert.equal(arrival(), at(10));
  scan(B, 20);
  scan(B, 30);
  assert.equal(station(), B);
  assert.equal(arrival(), at(10));
  assert.equal(getItem(db, 1n).source, 'scan');
});

test('correction vers le poste où l\'objet est déjà : la série continue (arrivée inchangée)', () => {
  scan(B, 0);
  scan(B, 10);
  correction(B, 20);
  assert.equal(getItem(db, 1n).source, 'manual');
  assert.equal(arrival(), at(0));
});

test('correction vers un autre poste au milieu, puis scan au poste d\'origine : nouvelle arrivée au scan', () => {
  scan(B, 0);
  correction(A, 10);
  scan(B, 20);
  assert.equal(station(), B);
  assert.equal(arrival(), at(20));
});

test('scans sur un lecteur non affecté : « non affecté » est un emplacement à part entière', () => {
  scan(NONE, 0);
  scan(NONE, 10);
  assert.equal(station(), null);
  assert.equal(arrival(), at(0));
  scan(B, 20);
  assert.equal(arrival(), at(20), 'non affecté → B');
  scan(NONE, 30);
  scan(NONE, 40);
  assert.equal(station(), null);
  assert.equal(arrival(), at(30), 'B → non affecté');
  correction(A, 50);
  scan(A, 60);
  assert.equal(arrival(), at(50), 'non affecté → correction A → scan A');
});

test('objet sans puce mais avec corrections : arrivée = première correction de la dernière série', () => {
  db.prepare('UPDATE items SET uid_nfc = NULL WHERE id = 1').run();
  correction(A, 0);
  assert.equal(arrival(), at(0));
  correction(A, 10);
  assert.equal(arrival(), at(0));
  correction(B, 20);
  correction(B, 30);
  assert.equal(station(), B);
  assert.equal(arrival(), at(20));
});

test('puce changée : seuls les scans de la puce ACTUELLE comptent (comme la vue)', () => {
  scan(B, 0); // ancienne puce, au poste B depuis le début
  db.prepare('UPDATE items SET uid_nfc = ? WHERE id = 1').run(OTHER_UID);
  assert.equal(arrival(), null, 'nouvelle puce jamais scannée : jamais localisé');
  scan(B, 30, OTHER_UID);
  scan(B, 40, OTHER_UID);
  assert.equal(arrival(), at(30), 'l\'historique de l\'ancienne puce est ignoré');
  scan(A, 50); // l'ancienne puce, scannée ailleurs : sans effet sur la fiche
  assert.equal(station(), B);
  assert.equal(arrival(), at(30));
});

test('égalités à la milliseconde : même ordre que la vue (heure, puis scan avant correction, puis id)', () => {
  // Scan A et correction B à la même heure : la correction l'emporte (vue), l'arrivée est cette heure.
  scan(A, 0);
  correction(B, 10);
  scan(A, 10);
  assert.equal(station(), B);
  assert.equal(arrival(), at(10));
  scan(B, 20);
  assert.equal(arrival(), at(10));
  // Deux scans à la même heure sur deux postes : le dernier reçu (id le plus grand) l'emporte.
  scan(C, 30);
  scan(A, 30);
  assert.equal(station(), A);
  assert.equal(arrival(), at(30));
  scan(A, 40);
  assert.equal(arrival(), at(30));
});

test('fiche du poste : chaque objet présent porte sa propre heure d\'arrivée', () => {
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (2, ?, 'Oscilloscope', ?, ?)").run(OTHER_UID, at(0), at(0));
  scan(B, 0);
  scan(B, 100);
  scan(A, 10, OTHER_UID);
  scan(B, 50, OTHER_UID);
  scan(B, 60, OTHER_UID);
  const here = stationItems(db, B).map((row) => [row.name, row.arrived_at, row.at]);
  assert.deepEqual(here, [['Multimètre', at(0), at(100)], ['Oscilloscope', at(50), at(60)]]);
});

test('affichage : « Depuis » de la liste et de la fiche du poste = arrivée ; la fiche montre l\'arrivée puis le dernier scan', () => {
  scan(B, 0);
  scan(A, DAY);
  scan(B, 2 * DAY);
  scan(B, 3 * DAY);
  const user = { username: 'alice', csrf: 'x' };
  const now = T0 + 3 * DAY * 60_000 + 60_000;
  const list = inventoryPage(user, { query: '', items: listItems(db, ''), now }).toString();
  assert.match(list, new RegExp(`<td data-label="Depuis"><time datetime="${at(2 * DAY)}"`));
  const post = stationPage(user, { station: { id: B, name: 'Poste B', description: '', created_at: at(0) }, readers: [], items: stationItems(db, B), deletable: false, now }).toString();
  assert.match(post, new RegExp(`<td data-label="Depuis"><time datetime="${at(2 * DAY)}"`));
  const item = getItem(db, 1n);
  const sheet = itemPage(user, { item, scans: [], history: [], now }).toString();
  // Étape U2 : « depuis … » (et l'heure exacte en clair à côté), plus de numéro de lecteur affiché.
  // Étape U3 : « depuis … · jour » dans un <span>, puis UN badge avec l'heure du dernier scan.
  assert.match(sheet, new RegExp(`<p class="localisation-detail"><span><time datetime="${at(2 * DAY)}"[^>]*>depuis [^<]*</time>(?: · [^<]*)?</span><span class="badge badge--ok"><svg[^>]*><use href="#i-lecteur"></use></svg>Scanné <time datetime="${at(3 * DAY)}"[^>]*>il y a 1 min</time></span></p>`));
  // Arrivée = dernier événement : ligne sans second horodatage (« depuis <heure> — <jour> · scanné »).
  scan(A, 3 * DAY + 1);
  const moved = itemPage(user, { item: getItem(db, 1n), scans: [], history: [], now }).toString();
  assert.match(moved, new RegExp(`<p class="localisation-detail"><span><time datetime="${at(3 * DAY + 1)}"[^>]*>à l&#39;instant</time>(?: · [^<]*)?</span><span class="badge badge--ok"><svg[^>]*><use href="#i-lecteur"></use></svg>Scanné <time [^>]*>à l&#39;instant</time></span></p>`));
  // Correction manuelle au même poste après des scans : arrivée au premier scan, puis la correction.
  correction(A, 3 * DAY + 1);
  const corrected = itemPage(user, { item: getItem(db, 1n), scans: [], history: [], now }).toString();
  assert.match(corrected, /<p class="localisation-detail"><span><time [^>]*>à l&#39;instant<\/time>(?: · [^<]*)?<\/span><span class="badge badge--main">[\s\S]*?Corrigé à la main par alice<\/span><\/p>/);
});

// ---------------------------------------------------------------- référence par force brute

/** Référence écrite en JS, sans SQL : tous les événements de l'objet, triés, dernière série. */
function referenceArrival(itemId) {
  const item = db.prepare('SELECT uid_nfc FROM items WHERE id = ?').get(itemId);
  const events = [
    ...db.prepare('SELECT received_at AS t, 0 AS kind, id, station_id FROM scans WHERE uid_nfc = ?').all(item.uid_nfc ?? ''),
    ...db.prepare('SELECT created_at AS t, 1 AS kind, id, station_id FROM location_corrections WHERE item_id = ?').all(itemId),
  ].sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.kind - y.kind || x.id - y.id));
  if (events.length === 0) return { station: undefined, at: null, arrived: null };
  const last = events.at(-1);
  let first = events.length - 1;
  while (first > 0 && events[first - 1].station_id === last.station_id) first -= 1;
  return { station: last.station_id, at: last.t, arrived: events[first].t };
}

test('équivalence avec une référence en JS : 300 historiques aléatoires (scans, corrections, non affecté, puces changées, égalités)', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * n); };
  const uids = ['0A0B0C0D', '1A1B1C1D', '2A2B2C2D', '3A3B3C3D'];
  db.prepare('UPDATE items SET uid_nfc = ? WHERE id = 1').run(uids[0]);
  for (let id = 2; id <= 3; id++) {
    db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, 'x', 'x')").run(id, uids[id - 1], `Objet ${id}`);
  }
  for (let round = 0; round < 300; round++) {
    const action = rnd(10);
    const minutes = rnd(40); // heures proches : nombreuses égalités, et des événements « dans le passé »
    if (action < 6) scan(1 + rnd(4), minutes, uids[rnd(4)]);
    else if (action < 9) correction(1 + rnd(3), minutes, 1 + rnd(3));
    else {
      // Changement de puce d'une fiche (ou retrait) : une puce libre au hasard, ou aucune.
      const itemId = 1 + rnd(3);
      const used = db.prepare('SELECT uid_nfc FROM items WHERE uid_nfc IS NOT NULL').all().map((r) => r.uid_nfc);
      const free = uids.filter((u) => !used.includes(u));
      const next = rnd(3) === 0 || free.length === 0 ? null : free[rnd(free.length)];
      db.prepare('UPDATE items SET uid_nfc = ? WHERE id = ?').run(next, itemId);
    }
    for (let itemId = 1; itemId <= 3; itemId++) {
      const expected = referenceArrival(itemId);
      const item = getItem(db, BigInt(itemId));
      const what = `tour ${round}, fiche ${itemId}`;
      assert.equal(item.at, expected.at, `${what} : dernier événement`);
      if (expected.at !== null) assert.equal(item.station_id, expected.station, `${what} : emplacement`);
      assert.equal(arrival(itemId), expected.arrived, `${what} : arrivée`);
    }
  }
});
