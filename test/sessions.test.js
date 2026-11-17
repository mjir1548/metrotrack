// Migration 002 (users, sessions) et logique des sessions : empreinte seule en base,
// expiration absolue, compte désactivé, suppression, jeton CSRF dérivé.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import {
  createSession, findSession, deleteSession, csrfTokenFor, isTokenFormat, safeEqual, SESSION_TTL_MS,
} from '../server/sessions.js';

const NOW = '2026-11-17T10:00:00.000Z';
let dir, db;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-sessions-'));
  db = openDb(join(dir, 'test.db'));
  db.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (1, 'alice', 'x', ?), (2, 'bob', 'x', ?)").run(NOW, NOW);
});

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const sha256 = (s) => createHash('sha256').update(s).digest();

test('migration 002 appliquée sur une base existante en version 1, données conservées, aucun compte créé', () => {
  const path = join(dir, 'v1.db');
  const v1 = new DatabaseSync(path);
  v1.exec(readFileSync(join(import.meta.dirname, '..', 'server', 'migrations', '001_init.sql'), 'utf8'));
  v1.exec('PRAGMA user_version = 1');
  v1.prepare("INSERT INTO stations (name, created_at) VALUES ('Poste existant', ?)").run(NOW);
  v1.close();

  const migrated = openDb(path);
  try {
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(migrated.prepare('SELECT name FROM stations').get().name, 'Poste existant');
    assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    assert.equal(migrated.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
  } finally {
    migrated.close();
  }
  // Réouverture : aucune migration rejouée.
  const again = openDb(path);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, 2);
  again.close();
});

test('users : identifiant unique sans tenir compte de la casse, format contrôlé par la base', () => {
  const insert = (name) => db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run(name, 'x', NOW);
  assert.throws(() => insert('ALICE'), /UNIQUE/);
  for (const bad of ['', 'a b', '<script>', 'é', 'a'.repeat(65)]) assert.throws(() => insert(bad), /CHECK/, bad);
  assert.throws(() => db.prepare("UPDATE users SET active = 2 WHERE id = 1").run(), /CHECK/);
});

test('session créée : seul le SHA-256 du jeton est stocké, expiration à 8 h', () => {
  const now = Date.parse(NOW);
  const token = createSession(db, 1, now);
  assert.ok(isTokenFormat(token));
  assert.equal(Buffer.from(token, 'base64url').length, 32);
  const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token));
  assert.ok(row);
  assert.equal(row.created_at, NOW);
  assert.equal(row.expires_at, new Date(now + SESSION_TTL_MS).toISOString());
  assert.equal(SESSION_TTL_MS, 8 * 3600 * 1000);
  for (const value of Object.values(row)) assert.ok(!String(value).includes(token));
  assert.deepEqual(findSession(db, token, now), { token, userId: 1, username: 'alice' });
});

test('expiration absolue : valide juste avant 8 h, invalide à 8 h, jamais prolongée par l\'usage', () => {
  const now = Date.parse(NOW);
  const token = createSession(db, 1, now);
  for (let t = now; t < now + SESSION_TTL_MS; t += SESSION_TTL_MS / 4) assert.ok(findSession(db, token, t));
  assert.ok(findSession(db, token, now + SESSION_TTL_MS - 1));
  assert.equal(findSession(db, token, now + SESSION_TTL_MS), null);
});

test('session inconnue, jeton malformé ou absent : null, sans erreur', () => {
  for (const t of [undefined, null, '', 'abc', 'A'.repeat(43), 'A'.repeat(44), '!'.repeat(43), "' OR 1=1 --"]) {
    assert.equal(findSession(db, t), null, String(t));
  }
  assert.doesNotThrow(() => deleteSession(db, undefined));
});

test('compte désactivé : ses sessions ne sont plus valides', () => {
  const token = createSession(db, 2);
  assert.ok(findSession(db, token));
  db.exec('UPDATE users SET active = 0 WHERE id = 2');
  assert.equal(findSession(db, token), null);
  db.exec('UPDATE users SET active = 1 WHERE id = 2');
});

test('suppression : la session disparaît de la base', () => {
  const token = createSession(db, 1);
  deleteSession(db, token);
  assert.equal(findSession(db, token), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(sha256(token)).n, 0);
});

test('les sessions expirées sont purgées à la création d\'une session', () => {
  const now = Date.parse(NOW);
  const old = createSession(db, 1, now - SESSION_TTL_MS - 1000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(sha256(old)).n, 1);
  createSession(db, 1, now);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(sha256(old)).n, 0);
});

test('jeton CSRF : déterministe pour une session, différent entre sessions, différent du jeton de session', () => {
  const a = createSession(db, 1);
  const b = createSession(db, 1);
  assert.equal(csrfTokenFor(a), csrfTokenFor(a));
  assert.notEqual(csrfTokenFor(a), csrfTokenFor(b));
  assert.notEqual(csrfTokenFor(a), a);
  assert.match(csrfTokenFor(a), /^[A-Za-z0-9_-]{43}$/);
});

test('safeEqual : égalité exacte uniquement', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(null, null), false);
  assert.equal(safeEqual('', undefined), false);
});
