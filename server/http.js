// Transport HTTPS : extrait les octets de la trame et appelle ingestFrame.
// Aucune logique métier ici. Il n'existe aucun serveur en clair.

import { createServer } from 'node:https';
import { constants } from 'node:crypto';
import { ingestFrame } from './ingest.js';

const FRAMES_PATH = '/api/frames';
// Plafond de lecture du corps : une trame fait 36 octets. Au-delà, on cesse de lire
// et on rejette, pour qu'un émetteur ne puisse pas faire consommer de mémoire.
const MAX_BODY_BYTES = 64;

// Politique TLS (protocole.md §4) :
// - TLS 1.2 minimum : SSLv3, TLS 1.0 et 1.1 sont refusés à la négociation.
// - TLS 1.2 : uniquement des suites à échange de clés ECDHE (confidentialité persistante)
//   et chiffrement AEAD (AES-GCM, ChaCha20-Poly1305). Ni RSA statique, ni CBC, ni SHA-1.
// - TLS 1.3 : suites par défaut d'OpenSSL (toutes ECDHE/DHE + AEAD par construction).
//   L'option « ciphers » ne contient que des noms TLS 1.2 : Node laisse alors les
//   suites TLS 1.3 à leur valeur par défaut.
const TLS12_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');
// HSTS : un navigateur qui a vu le site en HTTPS refusera ensuite tout accès en clair.
const HSTS = 'max-age=31536000';
// Plafond de connexions simultanées (anti-saturation) : largement suffisant pour quelques
// dizaines de boîtiers et de navigateurs. Au-delà, les nouvelles connexions sont fermées.
const MAX_CONNECTIONS = 256;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{tls: {cert: Buffer|string, key: Buffer|string}, log?: (line:string) => void, maxConnections?: number}} options
 *   tls : certificat et clé privée du serveur (PEM), OBLIGATOIRES ;
 *   log : destination du journal (console par défaut) ;
 *   maxConnections : réservé aux tests (petite valeur) ; pas un paramètre de configuration.
 */
export function createFrameServer(db, { tls, log = console.log, maxConnections = MAX_CONNECTIONS } = {}) {
  if (!tls?.cert || !tls?.key) throw new Error('certificat et clé TLS obligatoires');
  const options = {
    cert: tls.cert,
    key: tls.key,
    minVersion: 'TLSv1.2',
    ciphers: TLS12_CIPHERS,
    honorCipherOrder: true,
    // Pas de renégociation initiée par le client (TLS 1.2 ; coût CPU, historique de failles).
    // Pas de tickets de session TLS 1.2 : leur clé de chiffrement n'est jamais renouvelée
    // par le serveur, ce qui affaiblirait la confidentialité persistante.
    secureOptions: constants.SSL_OP_NO_RENEGOTIATION | constants.SSL_OP_NO_TICKET,
    handshakeTimeout: 5_000, // poignée de main TLS incomplète : connexion fermée
    connectionsCheckingInterval: 1000, // fréquence de contrôle de requestTimeout / headersTimeout
  };
  const server = createServer(options, (req, res) => {
    res.setHeader('Strict-Transport-Security', HSTS);
    // Toute exception (y compris dans les callbacks 'data' / 'end') est capturée :
    // une requête malformée ne doit jamais pouvoir arrêter le processus.
    const fail = (err) => {
      log(`erreur interne lors du traitement d'une requête : ${err.message}`);
      if (!res.headersSent) sendEmpty(res, 500, true);
      else res.destroy();
    };
    const guard = (fn) => (...args) => {
      try {
        fn(...args);
      } catch (err) {
        fail(err);
      }
    };
    guard(handleRequest)(db, log, req, res, guard);
  });
  // Limite le temps laissé à un client pour envoyer sa requête complète.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.maxConnections = maxConnections;
  server.on('drop', () => log(`connexion refusée : plafond de ${maxConnections} connexions atteint`));
  // Échec de poignée de main (version, suite, certificat client...) : code seul, pour le diagnostic.
  server.on('tlsClientError', (err) => log(`TLS refusé : ${err.code}`));
  return server;
}

function handleRequest(db, log, req, res, guard) {
  // Comparaison textuelle du chemin, sans analyse d'URL : une cible invalide
  // (ex. « //[ ») est simplement un autre chemin, donc 404.
  const path = req.url.split('?')[0];
  if (path !== FRAMES_PATH) return sendEmpty(res, 404, true);
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendEmpty(res, 405, true);
  }

  // Rejet : 400 SANS CORPS, identique quelle que soit la cause (la cause n'est
  // révélée qu'au journal serveur, pour ne pas renseigner un attaquant).
  // La connexion est TOUJOURS fermée après un rejet : sinon les en-têtes
  // (Connection: close / keep-alive) trahiraient un rejet précoce.
  const reject = (reason, announcedReaderId) => {
    const reader = announcedReaderId === undefined ? '-' : announcedReaderId;
    log(`trame rejetée : cause=${reason}, reader_id annoncé=${reader} (non authentifié)`);
    sendEmpty(res, 400, true);
  };

  const mediaType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (mediaType !== 'application/octet-stream') return reject('bad_content_type');
  const declaredLength = Number(req.headers['content-length']);
  if (declaredLength > MAX_BODY_BYTES) return reject('body_too_large');

  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('error', (err) => log(`requête interrompue : ${err.message}`));
  req.on('data', guard((chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      req.pause(); // on cesse de lire ; la connexion est fermée après la réponse
      return reject('body_too_large');
    }
    chunks.push(chunk);
  }));
  req.on('end', guard(() => {
    if (aborted) return;
    const result = ingestFrame(db, Buffer.concat(chunks), new Date().toISOString());
    if (!result.ok) return reject(result.reason, result.readerId);
    // Le scan est enregistré (COMMIT fait) : un échec de journalisation ne change pas la réponse.
    try {
      logAccepted(db, log, result.scanId);
    } catch (err) {
      log(`scan ${result.scanId} accepté, mais journalisation détaillée impossible : ${err.message}`);
    }
    sendEmpty(res, 204, false);
  }));
}

function sendEmpty(res, status, closeConnection) {
  // Si le corps n'a pas été lu en entier, on ferme la connexion après la réponse
  // plutôt que de continuer à le consommer.
  if (closeConnection) res.setHeader('Connection', 'close');
  res.writeHead(status);
  res.end();
}

// Journal d'un scan accepté. Ne contient jamais la clé du lecteur.
function logAccepted(db, log, scanId) {
  const row = db.prepare(
    `SELECT s.reader_id, s.uid_nfc, st.name AS station_name, i.name AS item_name
       FROM scans s
       LEFT JOIN stations st ON st.id = s.station_id
       LEFT JOIN items i ON i.uid_nfc = s.uid_nfc
      WHERE s.id = ?`
  ).get(scanId);
  const station = row.station_name ?? 'lecteur non affecté';
  const item = row.item_name ?? 'puce inconnue';
  // JSON.stringify : guillemets et échappement des retours à la ligne (pas d'injection de ligne de journal).
  log(`scan accepté : lecteur ${row.reader_id}, poste ${JSON.stringify(station)}, uid ${row.uid_nfc}, objet ${JSON.stringify(item)}`);
}
