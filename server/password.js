// Règles des comptes (identifiant, mot de passe) et hachage des mots de passe :
// argon2id (node:crypto), format PHC. Paramètres : décision D-011 (minimum recommandé par
// l'OWASP). Le mot de passe et l'empreinte ne sont jamais journalisés ni affichés.
// Module sans dépendance vers l'interface web : utilisé aussi par la commande user-add.

import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

// Identifiant : [A-Za-z0-9._-], 1 à 64 caractères. Ces caractères n'ont aucune signification
// en HTML : l'identifiant peut être affiché sans échappement (web.js). Même règle en base (CHECK).
export const USERNAME_FORMAT = /^[A-Za-z0-9._-]{1,64}$/;

// m = 19 456 Kio (19 Mio), t = 2 passes, p = 1 voie, empreinte de 32 octets.
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };
const SALT_BYTES = 16; // sel aléatoire par mot de passe : deux comptes au même mot de passe ont des empreintes différentes
const PHC_PREFIX = `$argon2id$v=19$m=${PARAMS.memory},t=${PARAMS.passes},p=${PARAMS.parallelism}$`;

export const MIN_PASSWORD_CHARS = 12;
// Plafond : évite qu'une entrée démesurée soit hachée (le coût d'argon2 croît peu avec
// la longueur, mais rien ne justifie d'accepter plus).
export const MAX_PASSWORD_BYTES = 1024;

// Bornes acceptées en RELISANT une empreinte stockée. Elles refusent une chaîne aberrante
// (base corrompue ou modifiée) qui ferait allouer une mémoire ou un temps démesurés.
const LIMITS = { memoryMax: 262144 /* 256 Mio */, passesMax: 16, parallelismMax: 16, saltMin: 8, saltMax: 64, tagMin: 16, tagMax: 64 };

// Empreinte factice, aux paramètres courants, utilisée quand le compte est inconnu ou
// désactivé : le calcul argon2 est fait quand même, pour que le temps de réponse ne révèle
// pas l'existence d'un compte. Elle ne correspond à aucun mot de passe connu (empreinte nulle).
export const DUMMY_HASH = PHC_PREFIX + b64(Buffer.alloc(SALT_BYTES)) + '$' + b64(Buffer.alloc(PARAMS.tagLength));

// File unique : un seul calcul argon2 à la fois dans le processus. Chaque calcul alloue
// ~19 Mio ; sans file, N connexions simultanées alloueraient N × 19 Mio. Simple chaîne de
// promesses ; une erreur n'interrompt pas la chaîne.
//
// La file est BORNÉE : au plus MAX_PENDING_ARGON2 calculs en attente ou en cours. Sans borne,
// un client pourrait empiler des tentatives (connexions coupées aussitôt, ou requêtes
// enchaînées sur une même connexion) : la mémoire retenue par les requêtes en attente
// croîtrait sans limite et l'attente des utilisateurs légitimes aussi. Au-delà, le calcul est
// refusé immédiatement (Argon2BusyError) ; l'appelant répond 503. 16 calculs ≈ 16 × 20 à
// 50 ms : moins d'une seconde d'attente au pire pour une connexion acceptée.
export const MAX_PENDING_ARGON2 = 16;
let queue = Promise.resolve();
let pending = 0; // calculs en attente ou en cours
let started = 0; // calculs réellement lancés depuis le démarrage (observation par les tests)

export class Argon2BusyError extends Error {
  constructor() {
    super('file argon2 pleine');
    this.code = 'ARGON2_BUSY';
  }
}

/** Réservé aux tests : état de la file argon2. */
export function argon2Stats() {
  return { pending, started };
}

/**
 * @param {() => boolean} [skip] vrai si le calcul n'a plus d'objet (client parti) : il n'est
 *   alors ni mis en file ni lancé. Évalué à l'entrée dans la file et au moment du lancement.
 * @returns {Promise<Buffer|null>} empreinte, ou null si le calcul a été abandonné (skip)
 */
function runArgon2(message, nonce, params, skip = () => false) {
  if (skip()) return Promise.resolve(null);
  if (pending >= MAX_PENDING_ARGON2) return Promise.reject(new Argon2BusyError());
  pending += 1;
  const result = queue
    .then(() => {
      if (skip()) return null;
      started += 1;
      return new Promise((resolve, reject) => {
        argon2('argon2id', { message, nonce, ...params }, (err, tag) => (err ? reject(err) : resolve(tag)));
      });
    })
    .finally(() => { pending -= 1; });
  queue = result.catch(() => {});
  return result;
}

// Normalisation Unicode NFC avant hachage et vérification : « é » saisi précomposé (U+00E9)
// ou décomposé (e + U+0301) selon le clavier ou le système donne le même mot de passe.
function normalized(password) {
  return Buffer.from(password.normalize('NFC'), 'utf8');
}

/** Base64 standard sans « = » final (format PHC). */
function b64(buf) {
  return buf.toString('base64').replace(/=+$/, '');
}

/** Décodage base64 PHC strict : refuse tout ce qui ne se ré-encode pas à l'identique. */
function fromB64(text) {
  const buf = Buffer.from(text, 'base64');
  return b64(buf) === text ? buf : null;
}

/**
 * Règles du mot de passe (création de compte).
 * @returns {string|null} message d'erreur, ou null si le mot de passe est acceptable
 */
export function passwordPolicyError(password) {
  if (typeof password !== 'string') return 'mot de passe invalide';
  password = password.normalize('NFC'); // règles appliquées à la forme effectivement hachée
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return `mot de passe trop long (${MAX_PASSWORD_BYTES} octets au plus)`;
  // Longueur en caractères (points de code), pas en unités UTF-16.
  if ([...password].length < MIN_PASSWORD_CHARS) return `mot de passe trop court (${MIN_PASSWORD_CHARS} caractères au moins)`;
  return null;
}

/** @returns {Promise<string>} empreinte au format PHC */
export async function hashPassword(password) {
  if (typeof password !== 'string') throw new TypeError('mot de passe invalide');
  const salt = randomBytes(SALT_BYTES); // CSPRNG du système (OpenSSL)
  const tag = await runArgon2(normalized(password), salt, PARAMS);
  return PHC_PREFIX + b64(salt) + '$' + b64(tag);
}

/**
 * Analyse une empreinte PHC argon2id. Les paramètres sont relus depuis la chaîne (une
 * empreinte créée avec d'autres paramètres reste vérifiable), dans les bornes LIMITS.
 * @returns {{params: object, salt: Buffer, tag: Buffer}|null}
 */
function parsePhc(stored) {
  if (typeof stored !== 'string') return null;
  const m = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (!m) return null;
  const [memory, passes, parallelism] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (parallelism < 1 || parallelism > LIMITS.parallelismMax) return null;
  if (passes < 1 || passes > LIMITS.passesMax) return null;
  if (memory < 8 * parallelism || memory > LIMITS.memoryMax) return null; // m ≥ 8p : exigence d'argon2
  const salt = fromB64(m[4]);
  const tag = fromB64(m[5]);
  if (!salt || salt.length < LIMITS.saltMin || salt.length > LIMITS.saltMax) return null;
  if (!tag || tag.length < LIMITS.tagMin || tag.length > LIMITS.tagMax) return null;
  return { params: { memory, passes, parallelism, tagLength: tag.length }, salt, tag };
}

/**
 * Vérifie un mot de passe contre une empreinte stockée.
 * @param {{skip?: () => boolean}} [options] skip : voir runArgon2 (client parti : pas de calcul)
 * @returns {Promise<boolean>} false aussi si l'empreinte est malformée ou si le calcul a été
 *   abandonné (skip) ; rejet Argon2BusyError si la file est pleine
 */
export async function verifyPassword(password, stored, { skip } = {}) {
  if (typeof password !== 'string') return false;
  const parsed = parsePhc(stored);
  if (!parsed) return false;
  const tag = await runArgon2(normalized(password), parsed.salt, parsed.params, skip);
  if (tag === null) return false;
  // Comparaison en temps constant (les longueurs sont égales par construction : tagLength).
  return timingSafeEqual(tag, parsed.tag);
}
