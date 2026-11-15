// Simulateur de boîtier lecteur : construit une trame v0 et l'envoie au serveur en HTTPS.
// Usage :
//   node tools/simulateur.js --reader 1 --key-file dev/reader-1.key --uid 04A1B2C3D4E5F6 --counter 1
//                            --ca dev/tls/ca.crt [--url https://127.0.0.1:8443/api/frames]
// Sécurité :
// - la clé n'est acceptée QUE via un fichier (jamais en argument, pour qu'elle
//   n'apparaisse ni dans l'historique du shell ni dans la liste des processus) ;
// - le certificat du serveur est TOUJOURS vérifié (CA donnée par --ca, sinon les CA
//   intégrées à Node) ; il n'existe volontairement aucune option pour désactiver cette
//   vérification. node:https est utilisé car fetch n'accepte pas de CA personnalisée.

import { readFileSync } from 'node:fs';
import { request } from 'node:https';
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
      ca: { type: 'string' },
      url: { type: 'string', default: 'https://127.0.0.1:8443/api/frames' },
    },
    strict: true, // toute option inconnue (ex. --key, --insecure) est refusée
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

let url;
try {
  url = new URL(values.url);
} catch {
  fail('--url invalide');
}
if (url.protocol !== 'https:') fail('--url : https:// obligatoire');
let ca;
if (values.ca) {
  try {
    ca = readFileSync(values.ca);
  } catch (err) {
    fail(`lecture du fichier de CA impossible : ${err.message}`);
  }
}

const req = request(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': frame.length },
  ca, // undefined = CA intégrées à Node
  // Explicite, et donc prioritaire sur la variable d'environnement NODE_TLS_REJECT_UNAUTHORIZED=0 :
  // la vérification du certificat du serveur ne peut être désactivée par aucun moyen.
  rejectUnauthorized: true,
  agent: false,
}, (res) => {
  res.resume();
  res.on('end', () => {
    console.log(`HTTP ${res.statusCode}`);
    process.exit(res.statusCode === 204 ? 0 : 1);
  });
});
req.on('error', (err) => fail(`envoi impossible : ${err.message}`));
req.end(frame);
