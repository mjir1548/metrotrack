// Trame de scan v0 : décodage, vérification, encodage.
// Référence normative : docs/protocole.md §2 (format) et §3 (cryptographie).
//
// Trame (36 octets, big-endian) :
//   version(1) ‖ reader_id(4) ‖ counter(4) ‖ ciphertext(11) ‖ tag(16)
// Clair chiffré (11 octets) : uid_len(1) ‖ uid complété par des 0x00 jusqu'à 10 octets.

import { createCipheriv, createDecipheriv } from 'node:crypto';

const FRAME_SIZE = 36;
const FRAME_VERSION = 0x01;
const HEADER_SIZE = 9; // version + reader_id + counter = AAD
const PLAINTEXT_SIZE = 11;
const TAG_SIZE = 16;
const KEY_SIZE = 32;
const ALLOWED_UID_LENGTHS = new Set([4, 7, 10]);
const UINT32_MAX = 0xffffffff;

// Nonce GCM de 12 octets, jamais transmis : reader_id(4) ‖ counter(4) ‖ 00000000.
// Unicité : la clé est propre au lecteur et le compteur ne sert qu'une fois par
// lecteur (persistant côté firmware, strictement croissant vérifié côté serveur).
// Une réutilisation de nonce sous la même clé casserait GCM (protocole.md §3).
function buildNonce(readerId, counter) {
  const nonce = Buffer.alloc(12); // les 4 derniers octets restent à 0x00
  nonce.writeUInt32BE(readerId, 0);
  nonce.writeUInt32BE(counter, 4);
  return nonce;
}

/**
 * Contrôles de structure sur l'en-tête en clair (non authentifié à ce stade).
 * @returns {{ok:true, readerId:number, counter:number} | {ok:false, reason:string}}
 */
export function parseHeader(frame) {
  if (frame.length !== FRAME_SIZE) return { ok: false, reason: 'bad_size' };
  if (frame[0] !== FRAME_VERSION) return { ok: false, reason: 'bad_version' };
  return { ok: true, readerId: frame.readUInt32BE(1), counter: frame.readUInt32BE(5) };
}

/**
 * Vérifie le tag et déchiffre une trame dont l'en-tête a été validé par parseHeader.
 * @param {Buffer} frame trame de 36 octets
 * @param {Uint8Array} key clé AES-256 du lecteur annoncé
 * @returns {{ok:true, uid:Buffer} | {ok:false, reason:string}}
 */
export function decryptFrame(frame, key) {
  if (key.length !== KEY_SIZE) throw new Error('clé de lecteur invalide (32 octets attendus)');
  const header = frame.subarray(0, HEADER_SIZE);
  const ciphertext = frame.subarray(HEADER_SIZE, HEADER_SIZE + PLAINTEXT_SIZE);
  const tag = frame.subarray(HEADER_SIZE + PLAINTEXT_SIZE);
  const nonce = buildNonce(frame.readUInt32BE(1), frame.readUInt32BE(5));

  // authTagLength: 16 impose un tag complet de 128 bits : OpenSSL refuse un tag
  // tronqué (qui affaiblirait l'authentification).
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_SIZE });
  // AAD = les 9 octets d'en-tête : version, reader_id et counter sont authentifiés,
  // un attaquant ne peut pas les modifier sans invalider le tag.
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const updated = decipher.update(ciphertext);
  let plaintext;
  try {
    // final() vérifie le tag (comparaison en temps constant dans OpenSSL) et lève
    // une exception s'il est invalide. Le résultat de update() n'est utilisé
    // QU'APRÈS ce succès : aucune donnée non authentifiée n'est exploitée.
    plaintext = Buffer.concat([updated, decipher.final()]);
  } catch {
    return { ok: false, reason: 'bad_tag' };
  }

  // Contenu authentifié mais mal formé = bug firmware : rejet (protocole.md §5, étape 6).
  const uidLen = plaintext[0];
  if (!ALLOWED_UID_LENGTHS.has(uidLen)) return { ok: false, reason: 'bad_uid_len' };
  for (let i = 1 + uidLen; i < PLAINTEXT_SIZE; i++) {
    if (plaintext[i] !== 0x00) return { ok: false, reason: 'bad_padding' };
  }
  return { ok: true, uid: plaintext.subarray(1, 1 + uidLen) };
}

/**
 * Construit une trame v0. Utilisé UNIQUEMENT par le simulateur et les tests
 * (le serveur n'émet jamais de trame).
 * @param {{readerId:number, counter:number, uid:Uint8Array, key:Uint8Array}} p
 * @returns {Buffer} trame de 36 octets
 */
export function encodeFrame({ readerId, counter, uid, key }) {
  if (!Number.isInteger(readerId) || readerId < 1 || readerId > UINT32_MAX) throw new RangeError('readerId hors plage');
  if (!Number.isInteger(counter) || counter < 1 || counter > UINT32_MAX) throw new RangeError('counter hors plage');
  if (!ALLOWED_UID_LENGTHS.has(uid.length)) throw new RangeError('UID de 4, 7 ou 10 octets attendu');
  if (key.length !== KEY_SIZE) throw new RangeError('clé de 32 octets attendue');

  const header = Buffer.alloc(HEADER_SIZE);
  header[0] = FRAME_VERSION;
  header.writeUInt32BE(readerId, 1);
  header.writeUInt32BE(counter, 5);

  const plaintext = Buffer.alloc(PLAINTEXT_SIZE); // bourrage à 0x00
  plaintext[0] = uid.length;
  Buffer.from(uid).copy(plaintext, 1);

  const cipher = createCipheriv('aes-256-gcm', key, buildNonce(readerId, counter), { authTagLength: TAG_SIZE });
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([header, ciphertext, cipher.getAuthTag()]);
}
