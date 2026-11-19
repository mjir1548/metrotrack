// Outil des tests de corps trop gros (pas de test ici ; node --test exécute ce fichier sans effet).
//
// Le serveur refuse un corps trop gros par 413, puis ferme la connexion SANS lire la suite :
// c'est voulu, un client ne doit pas pouvoir lui faire consommer de la mémoire ou du temps.
// Si le client est encore en train d'écrire à cet instant, le système peut lui signaler
// ECONNRESET (ou EPIPE) avant qu'il ait lu la réponse. C'est une course côté client
// (observée sous Windows, environ une fois sur 13), pas un défaut du serveur.
// Les deux issues prouvent le refus ; chaque test vérifie en plus qu'aucune écriture n'a eu lieu.

export const CUT = 'connexion coupée';

/**
 * Statut HTTP d'une requête, ou CUT si la connexion a été coupée pendant l'envoi.
 * @param {Promise<{status: number}|number>} pending réponse ({status}) ou statut seul
 */
export function statusOrCut(pending) {
  return pending.then(
    (res) => (typeof res === 'number' ? res : res.status),
    (err) => {
      if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return CUT;
      throw err;
    },
  );
}
