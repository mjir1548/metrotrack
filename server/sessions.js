// Sessions des utilisateurs de l'interface web et jeton CSRF associé (décision D-011).
//
// - Jeton de session : 32 octets du CSPRNG, encodés en base64url, transmis uniquement dans
//   le cookie __Host-mt_session. La base ne contient que son SHA-256 : une fuite de la base
//   ne permet pas de reprendre une session. Le jeton ayant 256 bits d'entropie, un simple
//   SHA-256 (sans sel ni étirement) suffit ; la recherche par empreinte rend aussi inutile
//   toute comparaison en temps constant du jeton lui-même.
// - Durée absolue de 8 h, jamais prolongée. Une session expirée, inconnue ou d'un compte
//   désactivé n'existe pas.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = '__Host-mt_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;
// 32 octets en base64url sans remplissage = 43 caractères.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;

/** Nouveau jeton aléatoire (session ou CSRF de connexion), base64url. */
export function newToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Vrai si la valeur a la forme d'un jeton émis par newToken (sinon : inutile d'aller en base). */
export function isTokenFormat(value) {
  return typeof value === 'string' && TOKEN_FORMAT.test(value);
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Crée une session pour un compte et purge les sessions expirées.
 * @returns {string} jeton en clair, à placer dans le cookie (jamais stocké ni journalisé)
 */
export function createSession(db, userId, now = Date.now()) {
  const token = newToken();
  const nowIso = new Date(now).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowIso);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash(token), userId, nowIso, new Date(now + SESSION_TTL_MS).toISOString());
  return token;
}

/**
 * Session valide associée au jeton, ou null (jeton absent ou malformé, session inconnue,
 * expirée, ou compte désactivé).
 * @returns {{token: string, userId: number, username: string}|null}
 */
export function findSession(db, token, now = Date.now()) {
  if (!isTokenFormat(token)) return null;
  const row = db.prepare(
    `SELECT u.id AS user_id, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`
  ).get(tokenHash(token), new Date(now).toISOString());
  return row ? { token, userId: row.user_id, username: row.username } : null;
}

/** Supprime la session (déconnexion, ou remplacement à la connexion). Sans effet si inconnue. */
export function deleteSession(db, token) {
  if (!isTokenFormat(token)) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

/**
 * Jeton CSRF d'une session : HMAC-SHA256(clé = jeton de session, message « csrf »), base64url.
 * Il n'est pas stocké : il se recalcule depuis le cookie. Un attaquant qui ne connaît pas
 * le jeton de session (cookie HttpOnly) ne peut pas le calculer.
 */
export function csrfTokenFor(sessionToken) {
  return createHmac('sha256', Buffer.from(sessionToken, 'base64url')).update('csrf').digest('base64url');
}

/**
 * Comparaison en temps constant de deux chaînes (jetons CSRF). La longueur n'est pas
 * secrète (jetons de longueur fixe) : un écart de longueur répond false immédiatement.
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
