// Transport HTTP : extrait les octets de la trame et appelle ingestFrame.
// Aucune logique métier ici. TLS arrive à l'étape 2 (écoute en boucle locale d'ici là).

import { createServer } from 'node:http';
import { ingestFrame } from './ingest.js';

const FRAMES_PATH = '/api/frames';
// Plafond de lecture du corps : une trame fait 36 octets. Au-delà, on cesse de lire
// et on rejette, pour qu'un émetteur ne puisse pas faire consommer de mémoire.
const MAX_BODY_BYTES = 64;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{log?: (line:string) => void}} [options] log : destination du journal (console par défaut)
 */
export function createFrameServer(db, { log = console.log } = {}) {
  // connectionsCheckingInterval : fréquence de contrôle de requestTimeout / headersTimeout.
  const server = createServer({ connectionsCheckingInterval: 1000 }, (req, res) => {
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
