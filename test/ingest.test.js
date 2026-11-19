import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { openDb } from '../server/db.js';
import { ingestFrame } from '../server/ingest.js';
import { encodeFrame } from '../server/protocol.js';

const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const KEY_INACTIVE = Buffer.alloc(32, 0x42);
const UID = Buffer.from('04A1B2C3D4E5F6', 'hex');
const NOW = '2026-11-15T10:00:00.000Z';

let db;
beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO stations (id, name, created_at) VALUES (1, 'Poste 1', ?), (2, 'Poste 2', ?)").run(NOW, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (1, 1, ?, 1, ?)').run(KEY, NOW);
  db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (2, 1, ?, 0, ?)').run(KEY_INACTIVE, NOW);
  db.prepare("INSERT INTO items (id, uid_nfc, name, created_at, updated_at) VALUES (1, '04A1B2C3D4E5F6', 'Multimètre démo', ?, ?)").run(NOW, NOW);
});

const frame = (counter, { readerId = 1, uid = UID, key = KEY } = {}) => encodeFrame({ readerId, counter, uid, key });
const scanCount = () => db.prepare('SELECT COUNT(*) AS n FROM scans').get().n;

// Trame correctement authentifiée mais au contenu arbitraire (pour tester l'étape 6 du §5).
function frameWithPlaintext(counter, plaintext) {
  const header = Buffer.alloc(9);
  header[0] = 0x01;
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(counter, 5);
  const nonce = Buffer.alloc(12);
  header.copy(nonce, 0, 1, 9);
  const cipher = createCipheriv('aes-256-gcm', KEY, nonce, { authTagLength: 16 });
  cipher.setAAD(header);
  return Buffer.concat([header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

test('trame valide acceptée : scan enregistré avec le poste du lecteur, UID en hex majuscule', () => {
  const result = ingestFrame(db, frame(1), NOW);
  assert.equal(result.ok, true);
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(result.scanId);
  assert.deepEqual({ ...scan }, {
    id: result.scanId, reader_id: 1, station_id: 1, uid_nfc: '04A1B2C3D4E5F6', counter: 1, received_at: NOW,
  });
  const loc = db.prepare('SELECT * FROM item_locations WHERE item_id = 1').get();
  assert.deepEqual({ ...loc }, { item_id: 1, station_id: 1, at: NOW, source: 'scan', reader_id: 1 });
});

test('horodatage par défaut : heure du serveur au format ISO 8601', () => {
  const result = ingestFrame(db, frame(1));
  const { received_at } = db.prepare('SELECT received_at FROM scans WHERE id = ?').get(result.scanId);
  assert.match(received_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('les vecteurs de test du protocole sont acceptés en séquence', () => {
  const v1 = Buffer.from('010000000100000001b5d9723ff84416793eb9ac384529e207c863cdd16605bc9059b104', 'hex');
  const v2 = Buffer.from('0100000001000000028f22de611bf05f4cf9d25f36131eda9cf50410fc51251c7b300745', 'hex');
  assert.equal(ingestFrame(db, v1, NOW).ok, true);
  assert.equal(ingestFrame(db, v2, NOW).ok, true);
  assert.deepEqual(db.prepare('SELECT uid_nfc FROM scans ORDER BY id').all().map((r) => r.uid_nfc), ['04A1B2C3D4E5F6', 'DEADBEEF']);
});

const rejections = [
  ['35 octets', () => frame(1).subarray(0, 35), 'bad_size'],
  ['37 octets', () => Buffer.concat([frame(1), Buffer.alloc(1)]), 'bad_size'],
  ['version inconnue', () => { const f = frame(1); f[0] = 0x02; return f; }, 'bad_version'],
  ['lecteur inconnu', () => frame(1, { readerId: 99 }), 'unknown_reader'],
  ['lecteur désactivé', () => frame(1, { readerId: 2, key: KEY_INACTIVE }), 'inactive_reader'],
  ['tag modifié d\'un bit', () => { const f = frame(1); f[35] ^= 0x01; return f; }, 'bad_tag'],
  ['compteur modifié dans l\'en-tête (AAD)', () => { const f = frame(1); f[8] = 0x05; return f; }, 'bad_tag'],
  ['mauvaise clé', () => frame(1, { key: Buffer.alloc(32, 0x07) }), 'bad_tag'],
  ['compteur 0', () => frameWithPlaintext(0, Buffer.from('0704a1b2c3d4e5f6000000', 'hex')), 'replay'],
  ['uid_len invalide (5)', () => frameWithPlaintext(1, Buffer.from('0504a1b2c3d40000000000', 'hex')), 'bad_uid_len'],
  ['uid_len invalide (0)', () => frameWithPlaintext(1, Buffer.alloc(11)), 'bad_uid_len'],
  ['bourrage non nul', () => frameWithPlaintext(1, Buffer.from('0704a1b2c3d4e5f6000001', 'hex')), 'bad_padding'],
];

for (const [name, build, reason] of rejections) {
  test(`rejet : ${name} (aucune ligne ajoutée dans scans)`, () => {
    const result = ingestFrame(db, build(), NOW);
    assert.equal(result.ok, false);
    assert.equal(result.reason, reason);
    assert.equal(scanCount(), 0);
  });
}

test('rejet : compteur rejoué, puis compteur inférieur (aucune ligne ajoutée)', () => {
  assert.equal(ingestFrame(db, frame(5), NOW).ok, true);
  assert.deepEqual(ingestFrame(db, frame(5), NOW), { ok: false, reason: 'replay', readerId: 1 });
  assert.deepEqual(ingestFrame(db, frame(3), NOW), { ok: false, reason: 'replay', readerId: 1 });
  assert.equal(scanCount(), 1);
  assert.equal(ingestFrame(db, frame(6), NOW).ok, true);
});

test('puce inconnue : scan enregistré, aucune fiche créée ni modifiée', () => {
  const before = db.prepare('SELECT * FROM items').all();
  const result = ingestFrame(db, frame(1, { uid: Buffer.from('DEADBEEF', 'hex') }), NOW);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT uid_nfc FROM scans WHERE id = ?').get(result.scanId).uid_nfc, 'DEADBEEF');
  assert.deepEqual(db.prepare('SELECT * FROM items').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_locations').get().n, 0);
});

test('scans est en ajout seul : UPDATE et DELETE refusés par la base', () => {
  ingestFrame(db, frame(1), NOW);
  assert.throws(() => db.exec('UPDATE scans SET station_id = 2'), /append-only/);
  assert.throws(() => db.exec('DELETE FROM scans'), /append-only/);
  assert.equal(scanCount(), 1);
});

test('déplacer le lecteur ne change pas la localisation déjà dérivée', () => {
  ingestFrame(db, frame(1), '2026-11-15T10:00:00.000Z');
  db.exec('UPDATE readers SET station_id = 2 WHERE id = 1');
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 1);
  // Un nouveau scan après le déplacement localise l'objet au nouveau poste.
  ingestFrame(db, frame(2), '2026-11-15T10:05:00.000Z');
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, 2);
});

test('lecteur non affecté : scan accepté avec station_id NULL', () => {
  db.exec('UPDATE readers SET station_id = NULL WHERE id = 1');
  const result = ingestFrame(db, frame(1), NOW);
  assert.equal(result.ok, true);
  assert.equal(db.prepare('SELECT station_id FROM item_locations WHERE item_id = 1').get().station_id, null);
});

test('filet de sécurité : un doublon (reader_id, counter) inséré directement est refusé par la base', () => {
  ingestFrame(db, frame(1), NOW);
  // Refusé d'abord par le trigger scans_no_replace (message propre depuis la migration 005), avant UNIQUE(reader_id, counter).
  assert.throws(
    () => db.prepare("INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 'DEADBEEF', 1, ?)").run(NOW),
    (err) => err.errcode === 1811 && err.message === 'scans: duplicate',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 1);
});

test('filet de sécurité atteint par ingestFrame (pré-vérifications du compteur contournées) : rejet « replay », jamais une exception', () => {
  assert.equal(ingestFrame(db, frame(5), NOW).ok, true);
  // Base dont la lecture du dernier compteur répond 0 : seule la base peut encore refuser le doublon.
  const blind = {
    prepare: (sql) => (sql.includes('MAX(counter)') ? { get: () => ({ c: 0 }) } : db.prepare(sql)),
    exec: (sql) => db.exec(sql),
    get isTransaction() { return db.isTransaction; },
  };
  assert.deepEqual(ingestFrame(blind, frame(5), NOW), { ok: false, reason: 'replay', readerId: 1 });
  assert.equal(db.isTransaction, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scans').get().n, 1);
  assert.equal(ingestFrame(blind, frame(6), NOW).ok, true, 'un compteur nouveau passe toujours');
});
