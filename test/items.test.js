// Édition des fiches (étape 5), logique métier sans HTTP : nettoyage et validation des
// saisies, création, modification, suppression, correction de localisation, journal
// audit_log (une ligne par modification, avec auteur et détails), atomicité écriture + audit,
// localisation après correction puis scan, historique d'une fiche.
// Les caractères de contrôle et bidi sont construits par String.fromCodePoint : aucun n'est
// écrit tel quel dans ce fichier (voir sources-invisibles.test.js).
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { getItem, listItems, normalizeQuery } from '../server/inventory.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';
import {
  cleanLine, cleanNotes, validateItemInput, createItem, updateItem, deleteItem, correctLocation, listStations,
  itemChanges, changeLabels,
  MAX_NAME_CHARS, MAX_NOTES_CHARS, MAX_PROPERTIES, MAX_PROPERTY_KEY_CHARS, MAX_PROPERTY_VALUE_CHARS,
} from '../server/items.js';

const T0 = '2026-11-17T10:00:00.000Z';
const T1 = '2026-11-17T11:00:00.000Z';
const T2 = '2026-11-17T12:00:00.000Z';
const KEY = Buffer.alloc(32, 0x42);
const UID = '04A1B2C3D4E5F6';
const ch = (...codes) => String.fromCodePoint(...codes);
const BIDI = ch(0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069);
const C0 = ch(...Array.from({ length: 32 }, (_, i) => i)); // U+0000 à U+001F
const C1_DEL = ch(0x7F, ...Array.from({ length: 32 }, (_, i) => 0x80 + i)); // DEL, U+0080 à U+009F

let db, alice, bob;

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Zone B', ?), (2, 'atelier', ?), (3, 'Étuve', ?), (4, 'Poste 10', ?), (5, 'Poste 2', ?)")
    .run(T0, T0, T0, T0, T0);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?), (2, NULL, ?, ?)').run(KEY, T0, KEY, T0);
  const user = db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', ?)");
  alice = Number(user.run('alice', T0).lastInsertRowid);
  bob = Number(user.run('bob', T0).lastInsertRowid);
});

afterEach(() => db.close());

const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const auditRows = () => db.prepare('SELECT at, user_id, action, entity_id, details FROM audit_log ORDER BY id').all()
  .map((r) => ({ ...r, details: JSON.parse(r.details) }));
const itemRow = (id) => db.prepare('SELECT * FROM items WHERE id = ?').get(id);
const valid = (fields) => {
  const result = validateItemInput(fields);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result.item;
};
let counter = 0;
const scanAt = (readerId, uid, at) => ingestFrame(db, encodeFrame({ readerId, counter: ++counter, uid: Buffer.from(uid, 'hex'), key: KEY }), at);

// ---------------------------------------------------------------- nettoyage

test('cleanLine : contrôles C0, DEL, C1 et bidi retirés, espaces de bord retirés', () => {
  // C0 contient tabulation et sauts de ligne, C1 contient NEL (U+0085) : changés en espace
  // (réduite à une seule), les autres contrôles retirés.
  assert.equal(cleanLine(`  a${C0}b${C1_DEL}c${BIDI}d  `), 'a b cd');
  const breaks = [0x9, 0xA, 0xB, 0xC, 0xD, 0x85, 0x2028, 0x2029];
  const others = [...Array.from({ length: 32 }, (_, i) => i), 0x7F, ...Array.from({ length: 32 }, (_, i) => 0x80 + i)].filter((c) => !breaks.includes(c));
  assert.equal(cleanLine(`a${ch(...others)}b`), 'ab');
  for (const c of breaks) assert.equal(cleanLine(`mot1${ch(c)}mot2`), 'mot1 mot2', c.toString(16));
  assert.equal(cleanLine(`${ch(0x202E)}evil.exe`), 'evil.exe');
  // Copier-coller sur plusieurs lignes : les mots ne sont plus collés.
  assert.equal(cleanLine('ligne 1\nligne 2\ttab'), 'ligne 1 ligne 2 tab');
  assert.equal(cleanLine('line1\r\nline2'), 'line1 line2');
  assert.equal(cleanLine(null), '');
  assert.equal(cleanLine(undefined), '');
  assert.equal(cleanLine(42), '');
  assert.equal(cleanLine('Étuve n° 3 — été'), 'Étuve n° 3 — été');
});

test('cleanLine : toute suite de blancs (espaces multiples, U+00A0, U+2007, U+202F, U+3000) → une espace ordinaire ; cleanNotes inchangé', () => {
  assert.equal(cleanLine('Poste   E2E'), 'Poste E2E');
  assert.equal(cleanLine(`a${ch(0xA0)}b${ch(0x2007)}c${ch(0x202F)}d${ch(0x3000)}e${ch(0x20, 0xA0, 0x20)}f`), 'a b c d e f');
  assert.equal(cleanLine(`${ch(0xA0)} x ${ch(0x202F)}`), 'x');
  assert.equal(cleanNotes(`a   b${ch(0xA0)}c\n\td`), `a   b${ch(0xA0)}c\n\td`, 'notes : espaces gardés');
});

test('propriétés : clés identiques à l\'œil (espaces insécables ou multiples) → doublon refusé', () => {
  for (const second of [`N${ch(0xB0)}${ch(0xA0)}de série`, `n${ch(0xB0)}${ch(0x202F)}DE   série`, `N${ch(0xB0)}${ch(0x2007)}de série`]) {
    const result = validateItemInput({ name: 'x', keys: [`N${ch(0xB0)} de série`, second], values: ['1', '2'] });
    assert.equal(result.ok, false, JSON.stringify(second));
    assert.equal(result.form.rows[1].error, `Propriété en double : « N${ch(0xB0)} de série » existe déjà (majuscules et minuscules confondues).`);
  }
  assert.deepEqual(validateItemInput({ name: `Fiche${ch(0xA0, 0xA0)}A`, keys: [`Marque${ch(0x202F)}`], values: [`Fluke${ch(0xA0)}87V`] }).item,
    { name: 'Fiche A', notes: '', properties: [['Marque', 'Fluke 87V']] });
});

test('cleanLine et cleanNotes : invisibles retirés (U+200B, U+200E, U+200F, U+061C, U+FEFF, U+2028, U+2029, U+00AD) ; U+200C et U+200D gardés', () => {
  const invisible = ch(0x200B, 0x200E, 0x200F, 0x061C, 0xFEFF, 0x2028, 0x2029, 0x00AD);
  // cleanLine : U+2028 et U+2029 sont des coupures de ligne, changées en espace (comme \n).
  assert.equal(cleanLine(`Mul${ch(0x200B, 0x200E, 0x200F, 0x061C, 0xFEFF, 0x00AD)}ti`), 'Multi');
  assert.equal(cleanLine(`Mul${invisible}ti`), 'Mul ti');
  assert.equal(cleanNotes(`a${invisible}\nb`), 'a\nb');
  for (const joiner of [0x200C, 0x200D]) {
    assert.equal(cleanLine(`a${ch(joiner)}b`), `a${ch(joiner)}b`, joiner.toString(16));
    assert.equal(cleanNotes(`a${ch(joiner)}b`), `a${ch(joiner)}b`, joiner.toString(16));
  }
  // Emoji composé (famille) : les liants U+200D sont conservés, il reste intact.
  const family = ch(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467);
  assert.equal(cleanLine(family), family);
  for (const name of [ch(0x200B), ch(0xFEFF, 0x00AD), ` ${ch(0x2028)} `]) {
    assert.equal(validateItemInput({ name }).errors.name, 'Le nom est obligatoire.');
  }
});

test('nom et clé : au moins un caractère visible, sinon même erreur qu\'un champ vide ; emoji seul et « ½ » acceptés', () => {
  const invisibles = {
    'U+2060': ch(0x2060), 'U+3164': ch(0x3164), 'U+2800': ch(0x2800), 'U+200D': ch(0x200D), 'U+FE0F': ch(0xFE0F),
    'espaces insécables': ch(0xA0, 0x202F, 0xA0), 'U+115F U+1160 U+FFA0': ch(0x115F, 0x1160, 0xFFA0), 'mélange': ch(0x2060, 0x200D, 0x3164, 0xA0),
  };
  for (const [what, text] of Object.entries(invisibles)) {
    assert.equal(validateItemInput({ name: text }).errors.name, 'Le nom est obligatoire.', `nom ${what}`);
    assert.equal(validateItemInput({ name: 'x', keys: [text], values: ['v'] }).form.rows[0].error,
      'Indiquez le nom de la propriété : une valeur seule ne suffit pas.', `clé ${what}`);
    // Sans valeur : ligne vide ignorée si le nettoyage la vide (espaces retirés au bord),
    // sinon refusée comme une clé vide.
    assert.equal(validateItemInput({ name: 'x', keys: [text], values: [''] }).ok, cleanLine(text) === '', `clé ${what} sans valeur`);
  }
  for (const text of [ch(0x1F527), ch(0x2764, 0xFE0F), '½', '#', '-', ch(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467)]) {
    assert.equal(validateItemInput({ name: text }).ok, true, `nom ${text}`);
    assert.equal(validateItemInput({ name: 'x', keys: [text], values: ['v'] }).ok, true, `clé ${text}`);
  }
  // Une valeur faite seulement d'invisibles reste permise (la valeur peut être vide).
  assert.equal(validateItemInput({ name: 'x', keys: ['k'], values: [ch(0x2060)] }).ok, true);
});

test('recherche (q) : mêmes invisibles retirés ; une saisie faite seulement d\'invisibles est une recherche vide', () => {
  assert.equal(normalizeQuery(`Mul${ch(0x200B)}ti${ch(0x00AD)}${ch(0xFEFF)}`), 'Multi');
  assert.equal(normalizeQuery(ch(0x200B, 0x2028, 0x061C)), '');
  assert.equal(normalizeQuery(`a${ch(0x200D)}b`), `a${ch(0x200D)}b`);
});

test('NFC : un texte saisi décomposé (NFD) est stocké et comparé sous sa forme composée', () => {
  const nfd = 'E'.concat(ch(0x301), 'tuve te', ch(0x301), 'le', ch(0x301), 'phone'); // « Étuve téléphone » décomposé
  assert.notEqual(nfd, nfd.normalize('NFC'));
  const item = valid({ name: nfd, notes: nfd, keys: [nfd], values: [nfd] });
  const nfc = nfd.normalize('NFC');
  assert.deepEqual(item, { name: nfc, notes: nfc, properties: [[nfc, nfc]] });
  // Longueur comptée après NFC : 200 « é » décomposés (400 unités) sont acceptés.
  assert.equal(validateItemInput({ name: 'e'.concat(ch(0x301)).repeat(200) }).ok, true);
});

test('cleanNotes : retours à la ligne et tabulations gardés, CRLF → LF, autres contrôles et bidi retirés', () => {
  assert.equal(cleanNotes('ligne 1\r\nligne 2\r\n\tindentée'), 'ligne 1\nligne 2\n\tindentée');
  assert.equal(cleanNotes(`a${ch(0)}b${ch(0x0D)}c${ch(0x0B)}d${ch(0x1B)}e${ch(0x85)}f${BIDI}g`), 'abcdefg');
  assert.equal(cleanNotes('\n\n  texte  \n\n'), 'texte');
  assert.equal(cleanNotes(null), '');
});

// ---------------------------------------------------------------- validation

test('nom : obligatoire après nettoyage, 200 caractères acceptés, 201 refusés', () => {
  for (const name of ['', '   ', `${BIDI}${C0}`, null, undefined]) {
    const r = validateItemInput({ name });
    assert.equal(r.ok, false, String(name));
    assert.equal(r.errors.name, 'Le nom est obligatoire.');
    assert.equal(r.item, null);
  }
  assert.equal(validateItemInput({ name: 'n'.repeat(MAX_NAME_CHARS) }).ok, true);
  const tooLong = validateItemInput({ name: 'n'.repeat(MAX_NAME_CHARS + 1) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.errors.name, /200 caractères \(201 saisis\)/);
  assert.equal(tooLong.form.name, 'n'.repeat(201), 'saisie conservée pour le réaffichage');
  // Comptage en unités UTF-16, comme maxlength : un emoji hors plan de base compte pour deux.
  assert.equal(validateItemInput({ name: ch(0x1F527).repeat(100) }).ok, true);
  assert.match(validateItemInput({ name: ch(0x1F527).repeat(100) + 'x' }).errors.name, /\(201 saisis\)/);
  assert.match(validateItemInput({ name: ch(0x1F527).repeat(101) }).errors.name, /\(202 saisis\)/);
  // Les caractères retirés ne comptent pas.
  assert.equal(validateItemInput({ name: `${'n'.repeat(200)}${BIDI}` }).ok, true);
});

test('notes : 10 000 caractères acceptés, 10 001 refusés ; multilignes conservées', () => {
  assert.equal(validateItemInput({ name: 'x', notes: 'a'.repeat(MAX_NOTES_CHARS) }).ok, true);
  const r = validateItemInput({ name: 'x', notes: 'a'.repeat(MAX_NOTES_CHARS + 1) });
  assert.equal(r.ok, false);
  assert.ok(r.errors.notes.startsWith('Les notes ne doivent pas dépasser 10'), r.errors.notes);
  // CRLF compte pour un caractère (converti en LF avant le comptage).
  assert.equal(validateItemInput({ name: 'x', notes: `${'a'.repeat(MAX_NOTES_CHARS - 2)}\r\nb` }).ok, true);
  const item = valid({ name: 'x', notes: 'Première ligne\r\n\r\n- point 1\r\n- point 2' });
  assert.equal(item.notes, 'Première ligne\n\n- point 1\n- point 2');
});

test('propriétés : 50 paires acceptées, 51 refusées ; lignes vides ignorées et comptées', () => {
  const keys = Array.from({ length: MAX_PROPERTIES }, (_, i) => `clé ${i}`);
  const values = keys.map((k) => `valeur de ${k}`);
  const ok = valid({ name: 'x', keys: [...keys, '', ' '], values: [...values, '', ''] });
  assert.equal(ok.properties.length, 50);
  const r = validateItemInput({ name: 'x', keys: [...keys, 'une de trop'], values: [...values, 'v'] });
  assert.equal(r.ok, false);
  assert.equal(r.errors.properties, '50 propriétés au plus : 51 saisies. Retirez-en 1.');
  assert.equal(r.form.rows.length, 51, 'aucune ligne perdue');
  const blanks = validateItemInput({ name: 'x', keys: ['', 'a', ''], values: ['', '1', ''] });
  assert.equal(blanks.form.blankRows, 2);
  assert.deepEqual(blanks.item.properties, [['a', '1']]);
});

test('propriétés : clé de 1 à 100 caractères, valeur jusqu\'à 1 000 ; clé seule acceptée (valeur vide)', () => {
  assert.equal(validateItemInput({ name: 'x', keys: ['k'.repeat(MAX_PROPERTY_KEY_CHARS)], values: ['v'] }).ok, true);
  const longKey = validateItemInput({ name: 'x', keys: ['k'.repeat(MAX_PROPERTY_KEY_CHARS + 1)], values: ['v'] });
  assert.equal(longKey.ok, false);
  assert.match(longKey.form.rows[0].error, /100 caractères \(101 saisis\)/);
  assert.equal(validateItemInput({ name: 'x', keys: ['k'], values: ['v'.repeat(MAX_PROPERTY_VALUE_CHARS)] }).ok, true);
  const longValue = validateItemInput({ name: 'x', keys: ['k'], values: ['v'.repeat(MAX_PROPERTY_VALUE_CHARS + 1)] });
  assert.equal(longValue.ok, false);
  assert.match(longValue.form.rows[0].error, /^La valeur ne doit pas dépasser 1.000 caractères \(1.001 saisis\)\.$/u);
  assert.deepEqual(valid({ name: 'x', keys: ['Étalon'], values: [''] }).properties, [['Étalon', '']]);
});

test('propriétés : valeur sans clé refusée, avec message sur la ligne', () => {
  const r = validateItemInput({ name: 'x', keys: ['a', '  ', 'c'], values: ['1', 'orpheline', '3'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.form.rows.map((row) => row.error === null), [true, false, true]);
  assert.equal(r.form.rows[1].error, 'Indiquez le nom de la propriété : une valeur seule ne suffit pas.');
  assert.equal(r.form.rows[1].value, 'orpheline');
  // Clé faite seulement de caractères retirés : traitée comme vide.
  assert.equal(validateItemInput({ name: 'x', keys: [BIDI], values: ['v'] }).ok, false);
});

test('propriétés : clés en double sans tenir compte de la casse → refus sur la seconde occurrence', () => {
  const r = validateItemInput({ name: 'x', keys: ['Marque', 'Modèle', 'MARQUE', 'marque'], values: ['Fluke', '87V', 'Keysight', 'autre'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.form.rows.map((row) => row.error), [
    null, null,
    'Propriété en double : « Marque » existe déjà (majuscules et minuscules confondues).',
    'Propriété en double : « Marque » existe déjà (majuscules et minuscules confondues).',
  ]);
  assert.equal(validateItemInput({ name: 'x', keys: ['Été', 'ÉTÉ'], values: ['1', '2'] }).ok, false);
  // Après nettoyage : « Marque » et « Mar<bidi>que » sont la même clé.
  assert.equal(validateItemInput({ name: 'x', keys: ['Marque', `Mar${ch(0x202E)}que `], values: ['1', '2'] }).ok, false);
});

test('propriétés : doublons repérés après NFC, casse « pliée » (Straße = STRASSE) et retrait des invisibles', () => {
  const dup = (a, b) => validateItemInput({ name: 'x', keys: [a, b], values: ['1', '2'] }).form.rows[1].error;
  assert.match(dup('Étuve', 'E'.concat(ch(0x301), 'TUVE')), /Propriété en double : « Étuve »/); // NFC contre NFD
  assert.match(dup('Straße', 'STRASSE'), /Propriété en double : « Straße »/);
  assert.match(dup('strasse', 'Straße'), /Propriété en double/);
  assert.match(dup('Marque', `Mar${ch(0x200B)}que`), /Propriété en double/);
  assert.match(dup('Marque', `${ch(0xFEFF)}MARQUE${ch(0x00AD)}`), /Propriété en double/);
  assert.equal(dup('Marque', 'Marques'), null);
  assert.equal(dup('a', `a${ch(0x200D)}`), null, 'le liant est gardé : clés différentes');
});

test('bornes en unités UTF-16 (comme maxlength) pour les clés, les valeurs et les notes', () => {
  const emoji = ch(0x1F527);
  assert.equal(validateItemInput({ name: 'x', keys: [emoji.repeat(50)], values: [''] }).ok, true);
  assert.match(validateItemInput({ name: 'x', keys: [`${emoji.repeat(50)}a`], values: [''] }).form.rows[0].error, /\(101 saisis\)/);
  assert.equal(validateItemInput({ name: 'x', keys: ['k'], values: [emoji.repeat(500)] }).ok, true);
  assert.equal(validateItemInput({ name: 'x', keys: ['k'], values: [`${emoji.repeat(500)}a`] }).ok, false);
  assert.equal(validateItemInput({ name: 'x', notes: emoji.repeat(5000) }).ok, true);
  assert.equal(validateItemInput({ name: 'x', notes: `${emoji.repeat(5000)}a` }).ok, false);
});

test('propriétés : nom, clés et valeurs nettoyés (contrôles et bidi retirés)', () => {
  const item = valid({ name: ` Multi${ch(0x202E)}mètre${ch(7)} `, keys: [`Mar${ch(0x2066)}que`], values: [`Fl${ch(0)}uke${ch(0x9B)}\t`] });
  assert.deepEqual(item, { name: 'Multimètre', notes: '', properties: [['Marque', 'Fluke']] });
});

test('propriétés : clés et valeurs appariées par position, même si les listes reçues ont des longueurs différentes', () => {
  assert.deepEqual(valid({ name: 'x', keys: ['a', 'b'], values: ['1'] }).properties, [['a', '1'], ['b', '']]);
  assert.equal(validateItemInput({ name: 'x', keys: ['a'], values: ['1', '2'] }).ok, false); // « 2 » sans clé
});

// ---------------------------------------------------------------- écritures et audit

test('création : une ligne d\'audit item.create avec l\'auteur et les valeurs créées ; fiche sans puce', () => {
  const id = createItem(db, alice, valid({ name: 'Oscilloscope', notes: 'Fragile\nSalle 2', keys: ['Marque', '__proto__'], values: ['Tek', 'p'] }), T1);
  const row = itemRow(id);
  assert.equal(row.name, 'Oscilloscope');
  assert.equal(row.uid_nfc, null);
  assert.equal(row.notes, 'Fragile\nSalle 2');
  assert.deepEqual(Object.entries(JSON.parse(row.properties)), [['Marque', 'Tek'], ['__proto__', 'p']]);
  assert.equal(row.created_at, T1);
  assert.equal(row.updated_at, T1);
  assert.deepEqual(auditRows(), [{
    at: T1, user_id: alice, action: 'item.create', entity_id: id,
    details: JSON.parse('{"name":"Oscilloscope","properties":{"Marque":"Tek","__proto__":"p"},"notes":"Fragile\\nSalle 2"}'),
  }]);
  assert.equal(Object.getPrototypeOf(getItem(db, id)), Object.prototype);
});

test('modification : une ligne item.update avec seulement les champs changés (avant/après) ; updated_at mis à jour', () => {
  const id = createItem(db, alice, valid({ name: 'Four', notes: 'n', keys: ['Marque'], values: ['A'] }), T0);
  assert.deepEqual(updateItem(db, bob, id, valid({ name: 'Four 2', notes: 'n', keys: ['Marque'], values: ['A'] }), T1), ['name']);
  assert.deepEqual(updateItem(db, alice, id, valid({ name: 'Four 2', notes: 'n2', keys: ['Marque', 'Série'], values: ['B', 'S1'] }), T2), ['properties', 'notes']);
  const [, first, second] = auditRows();
  assert.deepEqual(first, { at: T1, user_id: bob, action: 'item.update', entity_id: id, details: { name: { before: 'Four', after: 'Four 2' } } });
  assert.deepEqual(second, {
    at: T2, user_id: alice, action: 'item.update', entity_id: id,
    details: { properties: { before: { Marque: 'A' }, after: { Marque: 'B', Série: 'S1' } }, notes: { before: 'n', after: 'n2' } },
  });
  const row = itemRow(id);
  assert.equal(row.updated_at, T2);
  assert.equal(row.created_at, T0);
});

test('modification sans changement : aucune écriture, aucune ligne d\'audit, updated_at inchangé', () => {
  const id = createItem(db, alice, valid({ name: 'Four', notes: 'a\nb', keys: ['Marque', 'Série'], values: ['A', '1'] }), T0);
  // Même contenu, saisi avec CRLF, espaces de bord et lignes vides : pas un changement.
  assert.deepEqual(updateItem(db, bob, id, valid({ name: ' Four ', notes: 'a\r\nb', keys: ['', 'Marque', 'Série'], values: ['', 'A', '1'] }), T1), []);
  assert.equal(count('audit_log'), 1);
  assert.equal(itemRow(id).updated_at, T0);
  // Ordre des propriétés changé : c'est un changement (l'ordre est affiché).
  assert.deepEqual(updateItem(db, bob, id, valid({ name: 'Four', notes: 'a\nb', keys: ['Série', 'Marque'], values: ['1', 'A'] }), T1), ['properties']);
});

test('modification : valeur non textuelle importée (nombre) resoumise sous forme de texte → aucun changement, stockage intact', () => {
  db.prepare("INSERT INTO items (id, name, properties, created_at, updated_at) VALUES (9, 'Importé', '{\"n\": 42, \"ok\": true}', ?, ?)").run(T0, T0);
  assert.deepEqual(updateItem(db, alice, 9, valid({ name: 'Importé', keys: ['n', 'ok'], values: ['42', 'true'] }), T1), []);
  assert.equal(itemRow(9).properties, '{"n": 42, "ok": true}');
  assert.equal(count('audit_log'), 0);
});

test('modification ou suppression d\'une fiche inexistante : null / false, aucune écriture', () => {
  assert.equal(updateItem(db, alice, 999, valid({ name: 'x' }), T1), null);
  assert.equal(deleteItem(db, alice, 999, T1), false);
  assert.equal(correctLocation(db, alice, 999, 1, T1), 'no_item');
  assert.equal(count('audit_log'), 0);
  assert.equal(count('location_corrections'), 0);
});

test('suppression : une ligne item.delete avec la fiche complète ; corrections supprimées en cascade ; audit et scans conservés', () => {
  db.prepare("INSERT INTO items (id, uid_nfc, name, properties, notes, created_at, updated_at) VALUES (5, ?, 'Pied à coulisse', '{\"Marque\":\"Mitutoyo\"}', 'note', ?, ?)")
    .run(UID, T0, T0);
  assert.equal(scanAt(1, UID, T0).ok, true);
  assert.equal(correctLocation(db, alice, 5, 3, T1), 'ok');
  assert.equal(count('location_corrections'), 1);
  assert.equal(deleteItem(db, bob, 5, T2), true);
  assert.equal(itemRow(5), undefined);
  assert.equal(count('location_corrections'), 0);
  assert.equal(count('scans'), 1);
  const audit = auditRows();
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[1], {
    at: T2, user_id: bob, action: 'item.delete', entity_id: 5,
    details: { id: 5, uid_nfc: UID, name: 'Pied à coulisse', properties: { Marque: 'Mitutoyo' }, notes: 'note', created_at: T0, updated_at: T0 },
  });
});

test('correction : une ligne location_corrections (auteur, heure serveur) et une ligne item.location_correct (poste id et nom)', () => {
  const id = createItem(db, alice, valid({ name: 'Balance' }), T0);
  assert.equal(correctLocation(db, bob, id, 3n, T1), 'ok');
  assert.deepEqual({ ...db.prepare('SELECT item_id, station_id, user_id, created_at FROM location_corrections').get() },
    { item_id: id, station_id: 3, user_id: bob, created_at: T1 });
  assert.deepEqual(auditRows()[1], { at: T1, user_id: bob, action: 'item.location_correct', entity_id: id, details: { station: { id: 3, name: 'Étuve' } } });
  assert.equal(itemRow(id).updated_at, T0, 'la fiche elle-même n\'est pas modifiée');
});

test('correction : poste inexistant ou identifiant invalide → no_station, aucune écriture', () => {
  const id = createItem(db, alice, valid({ name: 'Balance' }), T0);
  for (const station of [999, 999n, null]) assert.equal(correctLocation(db, alice, id, station, T1), 'no_station', String(station));
  assert.equal(count('location_corrections'), 0);
  assert.equal(count('audit_log'), 1);
});

test('postes : triés par nom (ordre français, casse et accents ignorés, nombres dans l\'ordre naturel)', () => {
  assert.deepEqual(listStations(db).map((s) => s.name), ['atelier', 'Étuve', 'Poste 2', 'Poste 10', 'Zone B']);
});

// ---------------------------------------------------------------- localisation

test('une correction change la localisation (liste et fiche) ; un scan ultérieur reprend la main', () => {
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, T0, T0);
  assert.equal(scanAt(1, UID, T0).ok, true);
  assert.equal(getItem(db, 1).station_name, 'Zone B');

  correctLocation(db, alice, 1, 3, T1);
  let item = getItem(db, 1);
  assert.deepEqual([item.station_name, item.source, item.at, item.reader_id, item.corrected_by], ['Étuve', 'manual', T1, null, 'alice']);
  assert.equal(listItems(db, '').find((r) => r.id === 1).station_name, 'Étuve');

  assert.equal(scanAt(2, UID, T2).ok, true); // lecteur non affecté
  item = getItem(db, 1);
  assert.deepEqual([item.station_id, item.source, item.at, item.reader_id, item.corrected_by], [null, 'scan', T2, 2, null]);
  assert.equal(listItems(db, '').find((r) => r.id === 1).station_id, null);
});

test('à égalité d\'heure (même milliseconde), la correction manuelle l\'emporte sur le scan', () => {
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, ?, 'Multimètre', ?, ?)").run(UID, T0, T0);
  // Correction puis scan à la même milliseconde, puis scan puis correction : la correction gagne.
  correctLocation(db, alice, 1, 3, T1);
  assert.equal(scanAt(1, UID, T1).ok, true);
  assert.equal(getItem(db, 1).source, 'manual');
  assert.equal(scanAt(1, UID, T2).ok, true);
  correctLocation(db, bob, 1, 2, T2);
  const item = getItem(db, 1);
  assert.deepEqual([item.source, item.station_name, item.corrected_by], ['manual', 'atelier', 'bob']);
});

test('deux corrections à la même milliseconde : la dernière enregistrée l\'emporte, son auteur est affiché', () => {
  db.prepare("INSERT INTO items (id, name, created_at, updated_at) VALUES (1, 'Sans puce', ?, ?)").run(T0, T0);
  assert.equal(getItem(db, 1).at, null);
  correctLocation(db, alice, 1, 3, T1);
  correctLocation(db, bob, 1, 4, T1);
  const item = getItem(db, 1);
  assert.deepEqual([item.station_name, item.corrected_by, item.source], ['Poste 10', 'bob', 'manual']);
});

// ---------------------------------------------------------------- atomicité

test('atomicité : si l\'écriture d\'audit échoue, la création, la modification, la suppression et la correction sont annulées', () => {
  const id = createItem(db, alice, valid({ name: 'Avant' }), T0);
  db.exec("CREATE TEMP TRIGGER audit_en_panne BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'audit en panne (test)'); END");
  try {
    assert.throws(() => createItem(db, alice, valid({ name: 'Nouvelle' }), T1), /audit en panne/);
    assert.throws(() => updateItem(db, alice, id, valid({ name: 'Après' }), T1), /audit en panne/);
    assert.throws(() => correctLocation(db, alice, id, 1, T1), /audit en panne/);
    assert.throws(() => deleteItem(db, alice, id, T1), /audit en panne/);
    assert.equal(db.isTransaction, false, 'aucune transaction laissée ouverte');
  } finally {
    db.exec('DROP TRIGGER temp.audit_en_panne');
  }
  assert.equal(count('items'), 1);
  assert.deepEqual([itemRow(id).name, itemRow(id).updated_at], ['Avant', T0]);
  assert.equal(count('location_corrections'), 0);
  assert.equal(count('audit_log'), 1);
  // La base reste utilisable.
  assert.deepEqual(updateItem(db, alice, id, valid({ name: 'Après' }), T2), ['name']);
});

// ---------------------------------------------------------------- historique

test('modifications de la fiche : du plus récent au plus ancien, langage simple, sans emplacement ni création, 20 lignes au plus', () => {
  const id = createItem(db, alice, valid({ name: 'Four' }), T0);
  updateItem(db, bob, id, valid({ name: 'Four 2', notes: 'n' }), T1);
  correctLocation(db, alice, id, 3, T2); // dans la frise des déplacements, pas ici
  db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id, details) VALUES (?, NULL, 'item.update', ?, '{\"properties\":{}}')").run(T2, id);
  // Ligne d'une autre entité portant le même numéro : ignorée.
  db.prepare("INSERT INTO audit_log (at, user_id, action, entity_id) VALUES (?, ?, 'station.create', ?)").run(T2, alice, id);
  assert.deepEqual(itemChanges(db, id), [
    { at: T2, username: null, labels: ['Ordre des propriétés modifié'] },
    { at: T1, username: 'bob', labels: ['Nom modifié', 'Notes ajoutées'] },
  ]);
  for (let i = 0; i < 30; i++) updateItem(db, alice, id, valid({ name: `Four ${i + 3}` }), T2);
  const changes = itemChanges(db, id);
  assert.equal(changes.length, 20);
  assert.deepEqual(changes[0].labels, ['Nom modifié']);
});

test('modifications : propriété ajoutée, modifiée, retirée ; notes modifiées puis effacées', () => {
  const id = createItem(db, alice, valid({ name: 'Four', keys: ['Marque', 'Couleur'], values: ['Memmert', 'gris'], notes: 'a' }), T0);
  updateItem(db, alice, id, valid({ name: 'Four', keys: ['Marque', 'Série'], values: ['Binder', '42'], notes: 'b' }), T1);
  updateItem(db, alice, id, valid({ name: 'Four', keys: ['Marque', 'Série'], values: ['Binder', '42'], notes: '' }), T2);
  assert.deepEqual(itemChanges(db, id).map((c) => c.labels), [
    ['Notes effacées'],
    ['Marque : Memmert → Binder', // étape U3 : avant → après
     'Propriété « Série » ajoutée', 'Propriété « Couleur » retirée', 'Notes modifiées'],
  ]);
});

test('numéros de fiche jamais réutilisés (AUTOINCREMENT), même après suppression de la plus récente', () => {
  const first = createItem(db, alice, valid({ name: 'Ancienne' }), T0);
  updateItem(db, alice, first, valid({ name: 'Ancienne 2' }), T0);
  correctLocation(db, alice, first, 3, T0);
  assert.equal(first, db.prepare('SELECT max(id) AS m FROM items').get().m, 'la fiche supprimée est la plus récente');
  deleteItem(db, alice, first, T1);
  const second = createItem(db, bob, valid({ name: 'Nouvelle' }), T2);
  assert.equal(second, first + 1);
  assert.deepEqual(itemChanges(db, second), [], 'aucune modification héritée');
  assert.equal(getItem(db, second).at, null, 'aucune localisation héritée');
  // Même après suppression de toutes les fiches, la numérotation continue.
  deleteItem(db, bob, second, T2);
  assert.equal(count('items'), 0);
  assert.equal(createItem(db, bob, valid({ name: 'Troisième' }), T2), first + 2);
  // La séquence garde le plus grand numéro jamais attribué.
  assert.equal(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'items'").get().seq, first + 2);
});

test('changeLabels : détails illisibles ou incomplets → libellé générique, jamais le JSON brut', () => {
  assert.deepEqual(changeLabels('item.update', 'pas du json'), ['Fiche modifiée']);
  assert.deepEqual(changeLabels('item.update', 'null'), ['Fiche modifiée']);
  assert.deepEqual(changeLabels('item.update', '{"autre":1}'), ['Fiche modifiée']);
  assert.deepEqual(changeLabels('item.update', '{"properties":5}'), ['Ordre des propriétés modifié']);
  assert.deepEqual(changeLabels('item.update', '{"notes":null}'), ['Notes modifiées']);
  assert.deepEqual(changeLabels('autre.action', '{}'), ['Fiche modifiée']);
});
