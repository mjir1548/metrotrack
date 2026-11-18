// Traitement d'une trame de scan, indépendant du transport (Wi-Fi direct ou boîtier mère).
// Suit l'ordre normatif de docs/protocole.md §5. Aucune trame non authentifiée ne
// modifie la base ; les rejets ne sont pas écrits en base (anti-remplissage).

import { parseHeader, decryptFrame } from './protocol.js';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Uint8Array} frameBytes octets bruts reçus
 * @param {string} [receivedAt] heure de réception ISO 8601 UTC (horloge du serveur)
 * @returns {{ok:true, scanId:number} | {ok:false, reason:string, readerId?:number}}
 *   readerId, en cas de rejet, est l'identifiant ANNONCÉ par la trame (non authentifié),
 *   destiné uniquement au journal.
 */
export function ingestFrame(db, frameBytes, receivedAt = new Date().toISOString()) {
  const frame = Buffer.isBuffer(frameBytes) ? frameBytes : Buffer.from(frameBytes);

  // 1-2. Taille exacte et version.
  const header = parseHeader(frame);
  if (!header.ok) return header;
  const { readerId, counter } = header;
  const reject = (reason) => ({ ok: false, reason, readerId });

  // 3. Lecteur connu et actif (révocation = désactivation).
  const reader = db.prepare('SELECT aead_key, active FROM readers WHERE id = ?').get(readerId);
  if (!reader) return reject('unknown_reader');
  if (reader.active !== 1) return reject('inactive_reader');

  // 4. Pré-filtre anti-rejeu (évite le coût AES pour un rejeu évident) ; refait à l'étape 7.
  if (counter <= lastCounter(db, readerId)) return reject('replay');

  // 5-6. Vérification du tag, déchiffrement, contrôle du contenu.
  const content = decryptFrame(frame, reader.aead_key);
  if (!content.ok) return reject(content.reason);
  const uidHex = content.uid.toString('hex').toUpperCase();

  // 7. Enregistrement atomique. BEGIN IMMEDIATE prend le verrou d'écriture tout de
  // suite : deux trames concurrentes du même lecteur ne peuvent pas passer toutes
  // les deux la re-vérification du compteur. UNIQUE(reader_id, counter) reste le filet.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (counter <= lastCounter(db, readerId)) {
      db.exec('ROLLBACK');
      return reject('replay');
    }
    // Le poste est figé à l'instant du scan (lu dans la même transaction).
    // La condition active = 1 couvre une désactivation survenue entre-temps.
    const result = db.prepare(
      `INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at)
       SELECT id, station_id, ?, ?, ? FROM readers WHERE id = ? AND active = 1`
    ).run(uidHex, counter, receivedAt, readerId);
    if (result.changes !== 1) {
      db.exec('ROLLBACK');
      return reject('inactive_reader');
    }
    db.exec('COMMIT');
    return { ok: true, scanId: Number(result.lastInsertRowid) };
  } catch (err) {
    // isTransaction : ne pas masquer l'erreur d'origine si SQLite a déjà annulé.
    if (db.isTransaction) db.exec('ROLLBACK');
    if (isDuplicateScan(err)) return reject('replay');
    throw err;
  }
}

// Filet anti-rejeu (D-005) : un couple (lecteur, compteur) déjà enregistré est refusé par la
// base, soit par le trigger scans_no_replace (migration 004, vérifié en premier), soit par
// UNIQUE (reader_id, counter). Dans les deux cas, c'est un rejeu : rejet 400 normal, jamais
// une erreur interne. Toute autre erreur est relancée.
function isDuplicateScan(err) {
  if (err.errcode === 2067 /* SQLITE_CONSTRAINT_UNIQUE */) return true;
  return err.errcode === 1811 /* SQLITE_CONSTRAINT_TRIGGER */ && err.message === 'scans: append-only';
}

function lastCounter(db, readerId) {
  return db.prepare('SELECT COALESCE(MAX(counter), 0) AS c FROM scans WHERE reader_id = ?').get(readerId).c;
}
