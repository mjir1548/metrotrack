import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, parseHeader, decryptFrame } from '../server/protocol.js';

// Vecteurs de test de docs/protocole.md §8.
const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex');
const VECTORS = [
  {
    readerId: 1, counter: 1, uid: '04A1B2C3D4E5F6',
    frame: '010000000100000001b5d9723ff84416793eb9ac384529e207c863cdd16605bc9059b104',
  },
  {
    readerId: 1, counter: 2, uid: 'DEADBEEF',
    frame: '0100000001000000028f22de611bf05f4cf9d25f36131eda9cf50410fc51251c7b300745',
  },
];

for (const [i, v] of VECTORS.entries()) {
  test(`vecteur ${i + 1} : encodeFrame reproduit la trame octet pour octet`, () => {
    const frame = encodeFrame({ readerId: v.readerId, counter: v.counter, uid: Buffer.from(v.uid, 'hex'), key: KEY });
    assert.equal(frame.toString('hex'), v.frame);
  });

  test(`vecteur ${i + 1} : décodage et déchiffrement`, () => {
    const frame = Buffer.from(v.frame, 'hex');
    assert.deepEqual(parseHeader(frame), { ok: true, readerId: v.readerId, counter: v.counter });
    const content = decryptFrame(frame, KEY);
    assert.equal(content.ok, true);
    assert.equal(content.uid.toString('hex').toUpperCase(), v.uid);
  });
}

test('UID de 10 octets : aller-retour', () => {
  const uid = Buffer.from('0102030405060708090A', 'hex');
  const content = decryptFrame(encodeFrame({ readerId: 7, counter: 9, uid, key: KEY }), KEY);
  assert.equal(content.ok, true);
  assert.deepEqual(content.uid, uid);
});

test('parseHeader : taille et version', () => {
  const frame = Buffer.from(VECTORS[0].frame, 'hex');
  assert.equal(parseHeader(frame.subarray(0, 35)).reason, 'bad_size');
  assert.equal(parseHeader(Buffer.concat([frame, Buffer.alloc(1)])).reason, 'bad_size');
  const v2 = Buffer.from(frame);
  v2[0] = 0x02;
  assert.equal(parseHeader(v2).reason, 'bad_version');
});

test('decryptFrame : tout bit modifié (en-tête, chiffré, tag) invalide le tag', () => {
  const frame = Buffer.from(VECTORS[0].frame, 'hex');
  for (let byte = 1; byte < 36; byte++) { // l'octet 0 (version) est filtré avant par parseHeader
    const tampered = Buffer.from(frame);
    tampered[byte] ^= 0x01;
    assert.equal(decryptFrame(tampered, KEY).reason, 'bad_tag', `octet ${byte}`);
  }
});

test('decryptFrame : mauvaise clé', () => {
  const frame = Buffer.from(VECTORS[0].frame, 'hex');
  const otherKey = Buffer.from(KEY);
  otherKey[31] ^= 0x80;
  assert.equal(decryptFrame(frame, otherKey).reason, 'bad_tag');
});

test('encodeFrame : paramètres invalides refusés', () => {
  const uid = Buffer.from('DEADBEEF', 'hex');
  assert.throws(() => encodeFrame({ readerId: 0, counter: 1, uid, key: KEY }), RangeError);
  assert.throws(() => encodeFrame({ readerId: 1, counter: 0, uid, key: KEY }), RangeError);
  assert.throws(() => encodeFrame({ readerId: 1, counter: 2 ** 32, uid, key: KEY }), RangeError);
  assert.throws(() => encodeFrame({ readerId: 1, counter: 1, uid: Buffer.alloc(5), key: KEY }), RangeError);
  assert.throws(() => encodeFrame({ readerId: 1, counter: 1, uid, key: KEY.subarray(0, 16) }), RangeError);
});
