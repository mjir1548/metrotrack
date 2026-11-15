// Simulateur de boîtier lecteur : construit une trame v0 et l'envoie au serveur.
// Usage :
//   node tools/simulateur.js --reader 1 --key-file dev/reader-1.key --uid 04A1B2C3D4E5F6 --counter 1
//                            [--url http://127.0.0.1:8080/api/frames]
// Sécurité : la clé n'est acceptée QUE via un fichier (jamais en argument, pour
// qu'elle n'apparaisse ni dans l'historique du shell ni dans la liste des processus).

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { encodeFrame } from '../server/protocol.js';

function fail(message) {
  console.error(`erreur : ${message}`);
  process.exit(2);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      reader: { type: 'string' },
      'key-file': { type: 'string' },
      uid: { type: 'string' },
      counter: { type: 'string' },
      url: { type: 'string', default: 'http://127.0.0.1:8080/api/frames' },
    },
    strict: true, // toute option inconnue (ex. --key) est refusée
  }));
} catch (err) {
  fail(err.message);
}

const toUint32 = (name, text) => {
  if (!/^\d+$/.test(text ?? '')) fail(`--${name} : entier attendu`);
  const n = Number(text);
  if (n < 1 || n > 0xffffffff) fail(`--${name} : hors plage (1 à 4294967295)`);
  return n;
};

const readerId = toUint32('reader', values.reader);
const counter = toUint32('counter', values.counter);
if (!/^(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{14}|[0-9A-Fa-f]{20})$/.test(values.uid ?? '')) {
  fail('--uid : 8, 14 ou 20 caractères hexadécimaux attendus');
}
if (!values['key-file']) fail('--key-file obligatoire');
let keyHex;
try {
  keyHex = readFileSync(values['key-file'], 'utf8').trim();
} catch (err) {
  fail(`lecture du fichier de clé impossible : ${err.message}`);
}
if (!/^[0-9A-Fa-f]{64}$/.test(keyHex)) fail('fichier de clé : 64 caractères hexadécimaux attendus');

const frame = encodeFrame({
  readerId,
  counter,
  uid: Buffer.from(values.uid, 'hex'),
  key: Buffer.from(keyHex, 'hex'),
});

try {
  const response = await fetch(values.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: frame,
  });
  console.log(`HTTP ${response.status}`);
  process.exit(response.status === 204 ? 0 : 1);
} catch (err) {
  fail(`envoi impossible : ${err.message}`);
}
