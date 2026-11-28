// Recherche (étape U2) : unité, sur une base en mémoire.
// - règle multi-mots : chaque mot dans le nom, une valeur de propriété ou le numéro de puce ;
// - classement : début du nom, mots entiers, morceaux de mots, puis le reste ; alphabétique ;
// - où la saisie a été trouvée (nom, propriété, puce) ;
// - searchItems (palette) : 8 résultats au plus et le total ; searchResult : contenu minimal ;
// - formatSince : « depuis 4 min ».
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { listItems, searchItems, matchItem, searchTerms, normalizeQuery, MAX_SEARCH_RESULTS } from '../server/inventory.js';
import { searchResult } from '../server/views.js';
import { formatSince } from '../server/dates.js';

const NOW = '2026-11-26T10:00:00.000Z';
let db;

before(() => {
  db = openDb(':memory:');
  const insert = db.prepare('INSERT INTO items (id, uid_nfc, name, properties, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, '04A1B2C3D4E5F6', 'Multimètre Fluke 87V n° 7', JSON.stringify({ 'N° de série': '41230987', Marque: 'Fluke' }), NOW, NOW);
  insert.run(2, 'A1B2C3D4', 'Multimètre Fluke 87V n° 3', JSON.stringify({ 'N° de série': '41230555' }), NOW, NOW);
  insert.run(3, null, 'Oscilloscope Tektronix', JSON.stringify({ Service: 'Électronique', Calibre: 10 }), NOW, NOW);
  insert.run(4, null, 'Pince multifonction', '{}', NOW, NOW);
  insert.run(5, null, 'Étuve de séchage', JSON.stringify({ Emplacement: 'Salle blanche' }), NOW, NOW);
  insert.run(6, null, 'Banc multi-postes', '{}', NOW, NOW);
  insert.run(7, null, 'Câble multi', '{}', NOW, NOW);
});

after(() => db.close());

const names = (rows) => rows.map((r) => r.name);
const search = (q) => listItems(db, normalizeQuery(q));

test('multi-mots : « fluke 7 » trouve « Multimètre Fluke 87V n° 7 » (mots non contigus) ; tous les mots sont exigés', () => {
  // « 7 » est aussi dans « 87V » : les deux Fluke correspondent ; le n° 7 (mot entier) vient d'abord.
  assert.deepEqual(names(search('fluke 7')), ['Multimètre Fluke 87V n° 7', 'Multimètre Fluke 87V n° 3']);
  // « 3 » est aussi dans le n° de série du n° 7 (41230987) : trouvé par propriété, donc classé après.
  assert.deepEqual(names(search('fluke n° 3')), ['Multimètre Fluke 87V n° 3', 'Multimètre Fluke 87V n° 7']);
  assert.deepEqual(names(search('tektronix oscillo')), ['Oscilloscope Tektronix']);
  assert.deepEqual(names(search('7 fluke')), ['Multimètre Fluke 87V n° 7', 'Multimètre Fluke 87V n° 3']);
  assert.deepEqual(names(search('fluke tektronix')), []);
  // Mots en double, ordre libre, espaces multiples : sans effet.
  assert.deepEqual(names(search('  87v   FLUKE fluke ')), ['Multimètre Fluke 87V n° 3', 'Multimètre Fluke 87V n° 7']);
});

test('propriétés : une valeur trouve sa fiche ; les clés ne sont pas cherchées ; valeur non textuelle en JSON', () => {
  assert.deepEqual(names(search('41230987')), ['Multimètre Fluke 87V n° 7']);
  assert.deepEqual(names(search('4123')), ['Multimètre Fluke 87V n° 3', 'Multimètre Fluke 87V n° 7']);
  assert.deepEqual(names(search('electronique')), ['Oscilloscope Tektronix']); // accents ignorés dans les valeurs
  assert.deepEqual(names(search('oscillo ÉLECTRO')), ['Oscilloscope Tektronix']); // un mot dans le nom, un dans une propriété
  assert.deepEqual(names(search('série')), []); // clé « N° de série » : non cherchée
  assert.deepEqual(names(search('marque')), []);
  assert.deepEqual(names(search('10')), ['Oscilloscope Tektronix']); // Calibre: 10 (nombre importé)
});

test('accents et casse ignorés dans le nom (fold) ; caractères spéciaux pris littéralement', () => {
  for (const q of ['etuve', 'ÉTUVE', 'étu', 'sechage etuve']) assert.deepEqual(names(search(q)), ['Étuve de séchage'], q);
  assert.deepEqual(names(search('salle BLANCHE')), ['Étuve de séchage']);
  assert.deepEqual(names(search('%')), []);
  assert.deepEqual(names(search('multi%')), []);
});

test('numéro de puce : fragment hexadécimal d\'un mot, ou saisie entière groupée par 2 (règle d\'avant U2)', () => {
  assert.deepEqual(names(search('D4E5')), ['Multimètre Fluke 87V n° 7']);
  assert.deepEqual(names(search('04 a1 b2')), ['Multimètre Fluke 87V n° 7']); // aucun mot de 4 caractères
  assert.deepEqual(names(search('04:A1:B2:C3:D4:E5:F6')), ['Multimètre Fluke 87V n° 7']);
  assert.deepEqual(names(search('fluke c3d4')), ['Multimètre Fluke 87V n° 3', 'Multimètre Fluke 87V n° 7']);
  assert.deepEqual(names(search('oscillo c3d4')), []); // tous les mots exigés
  assert.deepEqual(names(search('dead')), []); // mot sans chiffre : pas cherché dans les puces
});

test('classement : mots entiers, puis débuts de mots, puis morceaux de mots, puis propriétés ; alphabétique à rang égal', () => {
  // « multi » : mot entier (Banc multi-postes, Câble multi), puis début de mot avec le nom qui
  // commence par le premier mot (Multimètre x2), puis simple début de mot (Pince multifonction).
  assert.deepEqual(names(search('multi')), [
    'Banc multi-postes', 'Câble multi', // rang 1 : mot entier
    'Multimètre Fluke 87V n° 3', 'Multimètre Fluke 87V n° 7', // rang 2 : début de mot, nom qui commence par « multi »
    'Pince multifonction', // rang 3 : début de mot
  ]);
  assert.deepEqual(names(search('ltif')), ['Pince multifonction']); // rang 4 : morceau de mot
  // Propriété après le nom : « fluke » est dans le nom des deux multimètres (rang 1).
  const rows = searchItems(db, normalizeQuery('fluke')).items;
  assert.deepEqual(rows.map((r) => r.found.type), ['nom', 'nom']);
});

test('classement : « fluke 87 » met « 87V » (87 mot entier, coupé avant la lettre) avant « 870 » (début de mot)', () => {
  const local = openDb(':memory:');
  try {
    const insert = local.prepare('INSERT INTO items (name, created_at, updated_at) VALUES (?, ?, ?)');
    for (const name of ['Fluke modèle 870', 'Multimètre Fluke 87V', 'Fluke 1587 isolement']) insert.run(name, NOW, NOW);
    // 87V : mots entiers (rang 1) ; Fluke modèle 870 : début de mot, nom qui commence par « fluke »
    // (rang 2) ; Fluke 1587 : « 87 » seulement en morceau de mot (rang 4).
    assert.deepEqual(names(listItems(local, 'fluke 87')), ['Multimètre Fluke 87V', 'Fluke modèle 870', 'Fluke 1587 isolement']);
  } finally {
    local.close();
  }
});

test('où la saisie a été trouvée : nom, propriété (clé et valeur), puce', () => {
  const terms = (q) => searchTerms(normalizeQuery(q));
  const row = { name: 'Multimètre Fluke 87V n° 7', uid_nfc: '04A1B2C3D4E5F6', properties: JSON.stringify({ Marque: 'Fluke', 'N° de série': '41230987' }) };
  assert.deepEqual(matchItem(row, terms('multimetre fluke')), { rank: 0, found: { type: 'nom' } });
  assert.deepEqual(matchItem(row, terms('fluke 7')), { rank: 1, found: { type: 'nom' } });
  assert.deepEqual(matchItem(row, terms('multi')), { rank: 2, found: { type: 'nom' } });
  assert.deepEqual(matchItem(row, terms('fluk 8')), { rank: 3, found: { type: 'nom' } });
  assert.deepEqual(matchItem(row, terms('ultim')), { rank: 4, found: { type: 'nom' } });
  assert.deepEqual(matchItem(row, terms('41230987')), { rank: 5, found: { type: 'propriete', key: 'N° de série', value: '41230987' } });
  assert.deepEqual(matchItem(row, terms('d4e5')), { rank: 5, found: { type: 'puce' } });
  assert.deepEqual(matchItem(row, terms('04 a1')), { rank: 5, found: { type: 'puce' } });
  assert.equal(matchItem(row, terms('tektronix')), null);
  assert.equal(matchItem({ ...row, uid_nfc: null }, terms('d4e5')), null);
  assert.equal(matchItem(row, terms('')), null); // saisie vide : aucune correspondance par cette fonction
});

test('searchItems : saisie vide → rien ; au plus MAX_SEARCH_RESULTS lignes, total exact, ordre du classement', () => {
  assert.deepEqual(searchItems(db, ''), { total: 0, items: [] });
  const local = openDb(':memory:');
  try {
    const insert = local.prepare('INSERT INTO items (name, created_at, updated_at) VALUES (?, ?, ?)');
    for (let i = 1; i <= 20; i++) insert.run(`Sonde ${i}`, NOW, NOW);
    const { total, items } = searchItems(local, 'sonde');
    assert.equal(MAX_SEARCH_RESULTS, 8);
    assert.equal(total, 20);
    assert.deepEqual(names(items), ['Sonde 1', 'Sonde 2', 'Sonde 3', 'Sonde 4', 'Sonde 5', 'Sonde 6', 'Sonde 7', 'Sonde 8']);
    assert.ok(items.every((row) => row.at === null && row.found.type === 'nom'));
    assert.equal(listItems(local, 'sonde').length, 20); // la liste, elle, n'est pas limitée
  } finally {
    local.close();
  }
});

test('searchResult : emplacement, arrivée en texte humain, sans numéro de puce sauf s\'il est la correspondance', () => {
  const now = Date.parse(NOW);
  const base = { id: 7, name: 'Fluke <b>', uid_nfc: '04A1B2C3D4E5F6', reader_id: 3, source: 'scan', arrival_source: 'scan' };
  const never = searchResult({ ...base, at: null, arrived_at: null, arrived_at_bounded: null, station_id: null, station_name: null, found: { type: 'nom' } }, now);
  assert.deepEqual(never, { id: 7, nom: 'Fluke <b>', emplacement: { etat: 'jamais', libelle: 'jamais localisé' }, arrivee: null, trouve: { type: 'nom' } });

  const located = searchResult({
    ...base, at: '2026-11-26T09:58:00.000Z', arrived_at: '2026-11-26T09:56:00.000Z', arrived_at_bounded: 0, station_id: 2, station_name: 'Poste B',
    found: { type: 'propriete', key: 'N° de série', value: '41230987' },
  }, now);
  assert.equal(located.emplacement.libelle, 'Poste B');
  assert.equal(located.emplacement.lecteur, undefined); // numéro de lecteur seulement si non affecté
  assert.equal(located.arrivee.iso, '2026-11-26T09:56:00.000Z');
  assert.equal(located.arrivee.texte, 'depuis 4 min');
  assert.equal(located.arrivee.auMoins, false);
  assert.equal(located.arrivee.par, 'scan');
  assert.deepEqual(located.trouve, { type: 'propriete', cle: 'N° de série', valeur: '41230987' });
  assert.ok(!JSON.stringify(located).includes('04A1'), 'pas de numéro de puce');

  const unassigned = searchResult({ ...base, at: NOW, arrived_at: '2026-11-25T10:00:00.000Z', arrived_at_bounded: 1, station_id: null, station_name: null, arrival_source: 'manual', found: { type: 'puce' } }, now);
  assert.deepEqual(unassigned.emplacement, { etat: 'inconnue', libelle: 'lecteur non affecté', lecteur: 3 });
  assert.match(unassigned.arrivee.texte, /^depuis au moins hier à \d\d:\d\d$/);
  assert.equal(unassigned.arrivee.par, 'correction');
  assert.deepEqual(unassigned.trouve, { type: 'puce', puce: '04 A1 B2 C3 D4 E5 F6' });
  // Liste de l'inventaire (sans found) : pas de champ trouve.
  assert.equal(searchResult({ ...base, at: null, arrived_at: null, station_id: null }, now).trouve, undefined);
  // Lignes de tableau (compact) : seulement ce qu'affiche une ligne ; puce actuelle pour l'association.
  const row = { ...base, at: NOW, arrived_at: '2026-11-26T09:56:00.000Z', arrived_at_bounded: 0, station_id: 2, station_name: 'Poste B', found: { type: 'nom' } };
  assert.deepEqual(searchResult(row, now, { compact: true }), {
    id: 7, nom: 'Fluke <b>', emplacement: { etat: 'poste', libelle: 'Poste B' },
    arrivee: { iso: '2026-11-26T09:56:00.000Z', texte: 'depuis 4 min', exacte: located.arrivee.exacte, auMoins: false },
  });
  // Étape U5 : l'association dit seulement si la fiche a déjà une puce (sans son numéro).
  assert.equal(searchResult(row, now, { compact: true, withChip: true }).puce, true);
  assert.equal(searchResult({ ...row, uid_nfc: null }, now, { compact: true, withChip: true }).puce, false);
});

test('formatSince : « depuis … », « au moins » si borné', () => {
  const now = Date.parse('2026-11-26T15:00:00.000Z');
  const tz = 'UTC';
  assert.equal(formatSince('2026-11-26T14:59:30.000Z', now, false, tz), 'depuis moins d\'une minute');
  assert.equal(formatSince('2026-11-26T14:56:00.000Z', now, false, tz), 'depuis 4 min');
  assert.equal(formatSince('2026-11-26T12:00:00.000Z', now, false, tz), 'depuis 3 h');
  assert.equal(formatSince('2026-11-25T17:40:00.000Z', now, false, tz), 'depuis hier à 17:40');
  assert.equal(formatSince('2026-11-12T09:48:00.000Z', now, false, tz), 'depuis le 12 nov. 2026 à 09:48');
  assert.equal(formatSince('2026-11-26T14:56:00.000Z', now, true, tz), 'depuis au moins 4 min');
  assert.equal(formatSince('2026-11-26T16:00:00.000Z', now, false, tz), 'depuis le 26 nov. 2026 à 16:00'); // horloge en avance
  assert.equal(formatSince('pas une date', now), 'date inconnue');
});
