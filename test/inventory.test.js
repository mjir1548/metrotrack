// Inventaire (server/inventory.js) et pages (server/views.js) : unité, sur une base en mémoire.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import {
  parseItemId, normalizeQuery, uidFragment, fold, listItems, getItem, recentScans, MAX_QUERY_CHARS,
} from '../server/inventory.js';
import { inventoryPage, itemPage, loginPage, BUSY_MESSAGE } from '../server/views.js';
import { withoutAppScript } from './app-script.js';

const NOW = '2026-11-17T10:00:00.000Z';
const KEY = Buffer.alloc(32, 0x44);
let db;

before(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?), (2, 'Poste 2', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, NULL, ?, ?)').run(KEY, NOW, KEY, NOW);
  const insert = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, '04A1B2C3D4E5F6', 'Multimètre démo', '{"Marque":"Fluke","Calibre":10,"Tags":["a"]}', NOW, NOW);
  insert.run(2, 'A1B2C3D4', 'oscilloscope', '{}', NOW, NOW);
  insert.run(3, null, '100% coton_bleu', '{}', NOW, NOW);
  insert.run(4, null, '100 coton bleu', '{}', NOW, NOW);
  insert.run(5, null, 'Étuve', '{}', NOW, NOW);
  insert.run(6, null, 'Poste 10', '{}', NOW, NOW);
  insert.run(7, null, 'Poste 2', '{}', NOW, NOW);
  insert.run(8, null, 'chemin\\réseau', '{}', NOW, NOW);
  insert.run(9, null, 'Zèbre', '{}', NOW, NOW);
});

after(() => db.close());

const names = (rows) => rows.map((r) => r.name);

test('parseItemId : entier strictement positif, 16 chiffres au plus, format strict', () => {
  assert.equal(parseItemId('1'), 1n);
  assert.equal(parseItemId('42'), 42n);
  assert.equal(parseItemId('9999999999999999'), 9999999999999999n); // exact (au-delà de 2^53)
  for (const bad of ['0', '01', '-1', '+1', '1.5', '1e3', '0x1', 'abc', '', ' 1', '1 ', '%31', '99999999999999999',
    '99999999999999999999', '１', '1/', null, undefined, 1]) {
    assert.equal(parseItemId(bad), null, String(bad));
  }
});

test('normalizeQuery : suites de blancs (espaces multiples, insécables) réduites à une espace ; « Poste  2 » trouve « Poste 2 »', () => {
  const ch = (...codes) => String.fromCodePoint(...codes);
  assert.equal(normalizeQuery('Poste  2'), 'Poste 2');
  assert.equal(normalizeQuery(`Poste${ch(0xA0)}2`), 'Poste 2');
  assert.equal(normalizeQuery(`a${ch(0x202F, 0x20, 0x2007)}b`), 'a b');
  const db = openDb(':memory:');
  try {
    db.prepare("INSERT INTO items (name, created_at, updated_at) VALUES ('Poste 2 : multimètre', 'x', 'x'), ('Poste 3', 'x', 'x')").run();
    assert.deepEqual(listItems(db, normalizeQuery('poste   2')).map((i) => i.name), ['Poste 2 : multimètre']);
  } finally {
    db.close();
  }
});

test('normalizeQuery : espaces de bord retirés, 100 caractères au plus (points de code), non-chaîne → vide', () => {
  assert.equal(normalizeQuery('  multi  '), 'multi');
  assert.equal(normalizeQuery(null), '');
  assert.equal(normalizeQuery(undefined), '');
  assert.equal(normalizeQuery('x'.repeat(300)), 'x'.repeat(MAX_QUERY_CHARS));
  const emoji = '😀'.repeat(150);
  assert.equal([...normalizeQuery(emoji)].length, MAX_QUERY_CHARS);
  assert.ok(normalizeQuery(emoji).isWellFormed());
});

test('uidFragment : majuscules, sans espaces, deux-points ni tirets ; null si non hexadécimal, trop court ou sans chiffre', () => {
  assert.equal(uidFragment('04:a1:b2'), '04A1B2');
  assert.equal(uidFragment('04-a1 b2'), '04A1B2');
  assert.equal(uidFragment('d4e5'), 'D4E5');
  assert.equal(uidFragment('04:a1'), '04A1');
  assert.equal(uidFragment('multi'), null);
  assert.equal(uidFragment('%'), null);
  assert.equal(uidFragment(''), null);
  assert.equal(uidFragment(' : - '), null);
  // Moins de 4 caractères hexadécimaux : pas de recherche dans les UID.
  for (const q of ['a', 'de', 'D4E', '04:a', '1']) assert.equal(uidFragment(q), null, q);
  // Mots entièrement hexadécimaux, sans chiffre : pas de recherche dans les UID.
  for (const q of ['face', 'FACE', 'cafe', 'dead', 'decade', 'abba']) assert.equal(uidFragment(q), null, q);
});

test('fold : minuscules, sans diacritiques', () => {
  assert.equal(fold('Étuve'), 'etuve');
  assert.equal(fold('ÉTUVE'), 'etuve');
  assert.equal(fold('Multimètre à cœur Ñ Ç'), 'multimetre a cœur n c');
  assert.equal(fold('İstanbul'), 'istanbul');
  assert.equal(fold('étuve'), 'etuve'); // déjà décomposé
});

test('normalizeQuery : caractères de contrôle C0, DEL, C1 et de mise en forme bidi retirés', () => {
  assert.equal(normalizeQuery('moin\u0000zzz'), 'moinzzz');
  assert.equal(normalizeQuery('a\tb\nc\rd\u007Fe\u0085f'), 'abcdef');
  assert.equal(normalizeQuery('RTL \u202Egnp.exe\u202C fin'), 'RTL gnp.exe fin');
  for (const c of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069']) {
    assert.equal(normalizeQuery(`x${c}y`), 'xy', c.codePointAt(0).toString(16));
  }
  assert.equal(normalizeQuery('\u0000 \u202E '), '');
  // Ce qui n'est pas un caractère de contrôle est conservé (émoji, accents, ZWJ des émojis composés).
  assert.equal(normalizeQuery('é 👩\u200D🔬'), 'é 👩\u200D🔬');
});

test('listItems : accents et casse ignorés au-delà de l\'ASCII', () => {
  for (const q of ['etuve', 'ÉTUVE', 'Étuve', 'ETUVE', 'étu', 'étuve']) assert.deepEqual(names(listItems(db, q)), ['Étuve'], q);
  assert.deepEqual(names(listItems(db, 'zebre')), ['Zèbre']);
  assert.deepEqual(names(listItems(db, 'MULTIMETRE')), ['Multimètre démo']);
  assert.deepEqual(names(listItems(db, 'chemin\\reseau')), ['chemin\\réseau']);
});

test('listItems : un caractère NUL (retiré de la saisie) n\'élargit pas les résultats', () => {
  assert.deepEqual(names(listItems(db, normalizeQuery('mètre\u0000zzz'))), []);
  assert.deepEqual(names(listItems(db, 'mètre\u0000zzz')), []); // même sans normalisation
});

test('listItems : tout l\'inventaire trié par nom (français, casse et accents ignorés, nombres naturels)', () => {
  assert.deepEqual(names(listItems(db, '')), [
    '100 coton bleu', '100% coton_bleu', 'chemin\\réseau', 'Étuve', 'Multimètre démo', 'oscilloscope', 'Poste 2', 'Poste 10', 'Zèbre',
  ]);
});

test('listItems : recherche dans le nom, sous-chaîne insensible à la casse', () => {
  assert.deepEqual(names(listItems(db, 'MULTI')), ['Multimètre démo']);
  assert.deepEqual(names(listItems(db, 'scope')), ['oscilloscope']);
  assert.deepEqual(names(listItems(db, 'aucun-objet')), []);
});

test('listItems : recherche par UID partiel, avec séparateurs ou en minuscules', () => {
  assert.deepEqual(names(listItems(db, 'D4E5')), ['Multimètre démo']);
  assert.deepEqual(names(listItems(db, 'd4:e5')), ['Multimètre démo']);
  assert.deepEqual(names(listItems(db, 'D4-E5')), ['Multimètre démo']);
  assert.deepEqual(names(listItems(db, 'd4 e5')), ['Multimètre démo']);
  assert.deepEqual(names(listItems(db, 'b2c3')), ['Multimètre démo', 'oscilloscope']);
  assert.deepEqual(names(listItems(db, '04:A1:B2:C3:D4:E5:F6')), ['Multimètre démo']);
});

test('listItems : %, _ et \\ pris littéralement', () => {
  assert.deepEqual(names(listItems(db, '%')), ['100% coton_bleu']);
  assert.deepEqual(names(listItems(db, '_')), ['100% coton_bleu']);
  assert.deepEqual(names(listItems(db, '100%')), ['100% coton_bleu']);
  assert.deepEqual(names(listItems(db, 'coton_bleu')), ['100% coton_bleu']);
  assert.deepEqual(names(listItems(db, '0%_c')), []);
  assert.deepEqual(names(listItems(db, '\\')), ['chemin\\réseau']);
  assert.deepEqual(names(listItems(db, '\\%')), []);
  assert.deepEqual(names(listItems(db, "'; DROP TABLE items; --")), []);
  assert.equal(listItems(db, '').length, 9);
});

test('localisation dérivée : jamais localisé, poste, lecteur non affecté ; derniers scans', () => {
  const uid = Buffer.from('04A1B2C3D4E5F6', 'hex');
  const row = () => listItems(db, 'Multimètre')[0];
  assert.equal(row().at, null);
  assert.equal(ingestFrame(db, encodeFrame({ readerId: 1, counter: 1, uid, key: KEY }), '2026-11-17T10:01:00.000Z').ok, true);
  assert.deepEqual({ ...row() }, {
    id: 1, name: 'Multimètre démo', uid_nfc: '04A1B2C3D4E5F6', at: '2026-11-17T10:01:00.000Z',
    arrived_at: '2026-11-17T10:01:00.000Z', arrived_at_bounded: 0, arrival_source: 'scan',
    source: 'scan', reader_id: 1, station_id: 1, station_name: 'Poste 1',
  });
  assert.equal(ingestFrame(db, encodeFrame({ readerId: 2, counter: 1, uid, key: KEY }), '2026-11-17T10:02:00.000Z').ok, true);
  assert.equal(row().station_id, null);
  assert.equal(row().reader_id, 2);

  const item = getItem(db, 1n);
  assert.equal(item.reader_id, 2);
  // Propriétés : paires dans l'ordre stocké ; valeurs non textuelles affichées en JSON.
  assert.deepEqual(item.properties, [['Marque', 'Fluke'], ['Calibre', '10'], ['Tags', '["a"]']]);
  assert.equal(getItem(db, 999n), null);
  assert.equal(getItem(db, 9999999999999999n), null);

  const scans = recentScans(db, '04A1B2C3D4E5F6');
  assert.deepEqual(scans.map((s) => [s.reader_id, s.station_name]), [[2, null], [1, 'Poste 1']]);
  assert.deepEqual(recentScans(db, 'A1B2C3D4'), []);
});

test('recentScans : 20 au plus, du plus récent au plus ancien', () => {
  const uid = Buffer.from('A1B2C3D4', 'hex');
  for (let i = 1; i <= 25; i++) {
    const at = `2026-11-17T11:${String(i).padStart(2, '0')}:00.000Z`;
    assert.equal(ingestFrame(db, encodeFrame({ readerId: 1, counter: 100 + i, uid, key: KEY }), at).ok, true);
  }
  const scans = recentScans(db, 'A1B2C3D4');
  assert.equal(scans.length, 20);
  assert.equal(scans[0].received_at, '2026-11-17T11:25:00.000Z');
  assert.equal(scans[19].received_at, '2026-11-17T11:06:00.000Z');
});

// ---------------------------------------------------------------- pages (sans serveur)

const USER = { username: 'alice', csrf: 'A'.repeat(43) };

test('inventoryPage : inventaire vide, message clair sans tableau', () => {
  const page = String(inventoryPage(USER, { query: '', items: [], now: Date.now() }));
  assert.ok(page.includes('Aucun objet dans l\'inventaire pour le moment.'));
  assert.ok(!page.includes('<table'));
  assert.ok(page.includes('0 objet<'));
});

test('inventoryPage : aucun résultat de recherche, saisie réaffichée échappée, lien Effacer', () => {
  const query = '"><script>alert(1)</script>&';
  const page = String(inventoryPage(USER, { query, items: [], now: Date.now() }));
  const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;';
  assert.ok(page.includes(`value="${escaped}"`));
  assert.ok(page.includes(`Aucun objet ne correspond à «&nbsp;${escaped}&nbsp;».`));
  assert.ok(page.includes('0 résultat pour'));
  assert.ok(page.includes('<a href="/">Effacer</a>'));
  assert.ok(!withoutAppScript(page).includes('<script'));
});

test('itemPage : objet sans puce, sans propriété ni note', () => {
  const item = { ...getItem(db, 3n) };
  const page = String(itemPage(USER, { item, scans: [], now: Date.now() }));
  assert.ok(page.includes('aucune puce associée'));
  assert.ok(page.includes('Aucune propriété'));
  assert.ok(page.includes('Aucune note'));
  assert.ok(page.includes('jamais localisé'));
  assert.ok(page.includes('<nav class="fil" aria-label="Fil d\'Ariane">\n<a href="/">Inventaire</a>')); // étape U1
});

test('loginPage : message de surcharge affiché, jeton CSRF repris', () => {
  const page = String(loginPage('B'.repeat(43), BUSY_MESSAGE));
  assert.ok(page.includes('<p class="erreur" role="alert">Trop de connexions en cours. Réessayez dans un instant.</p>'));
  assert.ok(page.includes(`<input type="hidden" name="csrf" value="${'B'.repeat(43)}">`));
  assert.ok(!String(loginPage('x', null)).includes('class="erreur"'));
});

test('UID complet sans chiffre (8, 14 ou 20 caractères) : recherché dans les UID', () => {
  for (const [q, expected] of [['DEADBEEF', 'DEADBEEF'], ['deadbeef', 'DEADBEEF'], ['de:ad:be:ef', 'DEADBEEF'],
    ['ABCDEFABCDEFAB', 'ABCDEFABCDEFAB'], ['ABCDEFABCDEFABCDEFAB', 'ABCDEFABCDEFABCDEFAB']]) {
    assert.equal(uidFragment(q), expected, q);
  }
  // Sans chiffre et d'une autre longueur : nom seulement.
  for (const q of ['DEADBEE', 'DEADBEEFA', 'FACE', 'ABCDEFABCDEFA']) assert.equal(uidFragment(q), null, q);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (100, 'DEADBEEF', 'Sonde', ?, ?)").run(NOW, NOW);
  try {
    assert.deepEqual(names(listItems(db, 'DEADBEEF')), ['Sonde']);
    assert.deepEqual(names(listItems(db, 'de-ad-be-ef')), ['Sonde']);
    assert.deepEqual(names(listItems(db, 'DEAD')), []); // 4 lettres sans chiffre : nom seulement
  } finally {
    db.prepare('DELETE FROM items WHERE id = 100').run();
  }
});

test('normalizeQuery : saisie dont la forme de comparaison est vide (accent combinant isolé) → recherche vide', () => {
  const acute = String.fromCharCode(0x301);
  assert.equal(normalizeQuery(acute), '');
  assert.equal(normalizeQuery(` ${acute}${acute} `), '');
  assert.equal(normalizeQuery(`e${acute}tuve`), `e${acute}tuve`); // accent rattaché à une lettre : conservé
});
