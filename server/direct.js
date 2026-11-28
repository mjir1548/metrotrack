// Le direct (étape U4) : GET /api/direct, flux « Server-Sent Events » (text/event-stream), sans
// dépendance. Le serveur pousse aux navigateurs connectés un événement léger à chaque scan
// accepté, à chaque correction manuelle d'emplacement et à chaque changement de puce d'une fiche.
//
// SÉCURITÉ (à l'attention de l'auditeur) :
//   - la route vérifie la session et l'origine (web.js, directApi) ; la session est revérifiée à
//     chaque battement de cœur (session expirée, compte désactivé : flux fermé), et la
//     déconnexion ferme les flux de cette session (closeSession) ;
//   - MINIMISATION : un événement ne contient ni clé, ni compteur, ni numéro de puce. Pour une
//     puce inconnue, seulement « puce inconnue » et le poste ; la page qui a besoin du numéro (pour
//     « Créer une fiche ») le demande à GET /api/puces-inconnues, protégé comme /api/recherche ;
//   - le JSON est échappé comme les réponses de /api/recherche (< > & U+2028 U+2029) et ne
//     contient aucun saut de ligne (JSON.stringify les échappe) : un nom d'objet ne peut pas
//     fabriquer une ligne SSE (« data: », « event: ») ;
//   - DISPONIBILITÉ : les flux sont des connexions longues. Ils sont plafonnés (MAX_DIRECT_CLIENTS
//     au total, MAX_DIRECT_PER_SESSION par session) pour ne jamais occuper plus d'une petite part
//     du plafond de connexions du serveur (256, server/http.js), partagé avec les boîtiers : il
//     reste toujours au moins 256 − 50 = 206 connexions pour eux. Au-delà du plafond total : 503,
//     sans calcul. Au-delà du plafond par session : le flux le plus ancien de la session est fermé
//     (onglet rechargé ou abandonné) ;
//   - la publication n'a aucun effet sur la réception des trames : elle est faite après la
//     réponse au boîtier, et une erreur y est seulement journalisée (server/http.js).
//
// REPRISE : chaque événement porte un numéro croissant (id SSE). Les HISTORY_EVENTS derniers sont
// gardés en mémoire ; un navigateur qui se reconnecte (en-tête Last-Event-ID envoyé par
// EventSource, ou ?depuis= quand app.js rouvre lui-même le flux) reçoit ceux qu'il a manqués. S'il
// en a manqué davantage (ou si le serveur a redémarré), il reçoit un événement « resynchro » et
// la page propose d'actualiser. Les numéros partent de l'heure du démarrage : ceux d'un
// processus précédent sont toujours plus petits.

import { findSession } from './sessions.js';
import { scanMove } from './accueil.js';

export const MAX_DIRECT_CLIENTS = 50;
export const MAX_DIRECT_PER_SESSION = 8;
export const HEARTBEAT_MS = 25_000;
export const HISTORY_EVENTS = 100;
// Délai de reconnexion conseillé au navigateur (champ « retry » du flux), en millisecondes.
export const RETRY_MS = 3000;

// Même échappement que sendJson (web.js) ; expression construite à partir des points de code
// (aucun caractère invisible littéral dans ce fichier).
const JSON_ESCAPED = new RegExp(`[<>&${String.fromCodePoint(0x2028, 0x2029)}]`, 'g');
const encode = (value) => JSON.stringify(value).replace(JSON_ESCAPED, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);

/**
 * Événement d'un scan accepté (server/http.js, après le COMMIT et la réponse au boîtier), ou null.
 * {type: 'scan', itemId, nom, poste, posteId, lecteur, iso, inconnu, deplacement}
 *   poste null : lecteur non affecté ; deplacement : l'objet arrive à un autre lieu (accueil.js).
 */
export function scanEvent(db, scanId) {
  const row = scanMove(db, scanId);
  if (!row) return null;
  const known = row.item_id !== null;
  return {
    type: 'scan',
    itemId: known ? row.item_id : null,
    nom: known ? row.item_name : null,
    poste: row.station_id === null ? null : row.station_name,
    posteId: row.station_id,
    lecteur: row.reader_id,
    iso: row.at,
    inconnu: !known,
    deplacement: row.move,
    par: null,
  };
}

/**
 * Événement d'une action sur une fiche (web.js) : 'correction' (emplacement corrigé à la main) ou
 * 'puce' (puce associée, fiche créée depuis une puce, puce retirée). item : inventory.js, getItem
 * (emplacement après l'action). par : identifiant du compte qui a agi.
 */
export function itemEvent(type, item, par, iso = new Date().toISOString()) {
  const placed = item.at !== null && item.station_id !== null;
  return {
    type,
    itemId: item.id,
    nom: item.name,
    poste: placed ? item.station_name : null,
    posteId: placed ? item.station_id : null,
    lecteur: null,
    iso,
    inconnu: false,
    deplacement: type === 'correction',
    par,
  };
}

/** Numéro « depuis » valide (chiffres seulement, entier sûr), ou null. */
export function parseEventId(text) {
  if (typeof text !== 'string' || !/^[0-9]{1,16}$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Concentrateur des flux d'un serveur (un par createFrameServer).
 * @param {{db, maxClients?: number, maxPerSession?: number, heartbeatMs?: number}} options
 *   maxClients, maxPerSession, heartbeatMs : réservés aux tests (petites valeurs).
 */
export function createDirectHub({
  db, maxClients = MAX_DIRECT_CLIENTS, maxPerSession = MAX_DIRECT_PER_SESSION, heartbeatMs = HEARTBEAT_MS,
}) {
  const clients = new Set(); // {res, token, openedAt}
  const history = []; // [{id, text}] : les HISTORY_EVENTS derniers événements, déjà encodés
  let nextId = Date.now();
  let timer = null;

  function remove(client) {
    if (!clients.delete(client)) return;
    if (clients.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  function end(client) {
    remove(client);
    client.res.end();
  }

  // Battement de cœur (commentaire SSE, ignoré par EventSource) : garde la connexion ouverte à
  // travers les équipements réseau, et revérifie la session de chaque flux.
  function beat() {
    for (const client of [...clients]) {
      if (!findSession(db, client.token)) {
        end(client);
        continue;
      }
      client.res.write(': battement\n\n');
    }
  }

  return {
    /**
     * Ouvre un flux sur la réponse. Renvoie false (rien n'est écrit) si le plafond total est
     * atteint. lastId : dernier numéro reçu par le navigateur (reprise), ou null.
     */
    open(req, res, token, lastId) {
      if (clients.size >= maxClients) return false;
      const mine = [...clients].filter((client) => client.token === token);
      if (mine.length >= maxPerSession) end(mine[0]); // le plus ancien (ordre d'insertion du Set)
      const client = { res, token };
      clients.add(client);
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      res.on('close', () => remove(client));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(`retry: ${RETRY_MS}\n: ouvert\n\n`);
      if (lastId !== null) {
        const firstKept = history.length > 0 ? history[0].id : nextId;
        if (lastId < firstKept - 1) res.write('event: resynchro\ndata: {}\n\n');
        for (const event of history) if (event.id > lastId) res.write(event.text);
      }
      if (timer === null) {
        timer = setInterval(beat, heartbeatMs);
        timer.unref();
      }
      return true;
    },

    /** Envoie un événement à tous les flux ouverts (et le garde pour la reprise). */
    publish(event) {
      const id = nextId++;
      const text = `id: ${id}\ndata: ${encode(event)}\n\n`;
      history.push({ id, text });
      if (history.length > HISTORY_EVENTS) history.shift();
      for (const client of clients) client.res.write(text);
    },

    /** Ferme les flux d'une session (déconnexion). */
    closeSession(token) {
      for (const client of [...clients]) if (client.token === token) end(client);
    },

    /** Nombre de flux ouverts (tests, journal). */
    get size() {
      return clients.size;
    },

    /** Ferme tous les flux (arrêt du serveur). */
    closeAll() {
      for (const client of [...clients]) end(client);
    },
  };
}
