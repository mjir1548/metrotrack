// Commande « node server/main.js user-add <identifiant> » avec une entrée standard non
// interactive (première ligne = mot de passe), sur une configuration et une base temporaires.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { verifyPassword } from '../server/password.js';

const ROOT = join(import.meta.dirname, '..');
let dir, configPath;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-useradd-'));
  configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port: 8443, dbPath: 'data/mt.db' }));
});

after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const userAdd = (args, input) => spawnSync(process.execPath, [join(ROOT, 'server', 'main.js'), 'user-add', ...args], {
  env: { ...process.env, METROTRACK_CONFIG: configPath }, input, encoding: 'utf8', timeout: 10_000,
});
const users = () => {
  const db = new DatabaseSync(join(dir, 'data', 'mt.db'), { readOnly: true });
  try { return db.prepare('SELECT username, password_hash, active FROM users ORDER BY id').all(); } finally { db.close(); }
};

test('création via stdin non interactif : compte actif, empreinte argon2id, mot de passe absent de la sortie', async () => {
  const password = 'Mot-de-passe-du-test-1';
  const res = userAdd(['alice'], `${password}\nligne ignorée\n`);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'user-add : compte alice créé');
  const [row] = users();
  assert.equal(row.username, 'alice');
  assert.equal(row.active, 1);
  assert.ok(row.password_hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$'));
  assert.equal(await verifyPassword(password, row.password_hash), true);
  for (const out of [res.stdout, res.stderr]) {
    assert.ok(!out.includes(password));
    assert.ok(!out.includes(row.password_hash));
    assert.ok(!out.includes('argon2'));
  }
});

test('fin de ligne Windows (CRLF) et absence de saut de ligne final acceptées', async () => {
  assert.equal(userAdd(['crlf'], 'Mot-de-passe-crlf-1\r\n').status, 0);
  assert.equal(userAdd(['sans-saut'], 'Mot-de-passe-sans-saut').status, 0);
  const rows = Object.fromEntries(users().map((r) => [r.username, r.password_hash]));
  assert.equal(await verifyPassword('Mot-de-passe-crlf-1', rows.crlf), true);
  assert.equal(await verifyPassword('Mot-de-passe-sans-saut', rows['sans-saut']), true);
});

test('identifiant invalide : refusé, avant toute lecture du mot de passe', () => {
  for (const name of ['', 'a b', 'é', '<script>', 'a/b', 'a'.repeat(65)]) {
    const res = userAdd([name], 'Mot-de-passe-valide-1\n');
    assert.equal(res.status, 1, JSON.stringify(name));
    assert.match(res.stderr, /identifiant invalide/);
  }
  assert.equal(userAdd(['a'.repeat(64)], 'Mot-de-passe-valide-1\n').status, 0);
});

test('identifiant déjà pris (casse différente) : refusé', () => {
  const before = users().length;
  const res = userAdd(['ALICE'], 'Mot-de-passe-valide-1\n');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /identifiant déjà utilisé/);
  assert.equal(users().length, before);
});

test('mot de passe trop court, vide ou trop long : refusé, aucun compte créé, mot de passe non affiché', () => {
  const before = users().length;
  const cases = { 'onzecaract!': /trop court/, '': /trop court/, ['x'.repeat(1025)]: /trop long/ };
  for (const [password, expected] of Object.entries(cases)) {
    const res = userAdd(['bob'], `${password}\n`);
    assert.equal(res.status, 1, password.slice(0, 20));
    assert.match(res.stderr, expected);
    if (password) assert.ok(!res.stderr.includes(password) && !res.stdout.includes(password));
  }
  // Entrée vide (EOF immédiat).
  assert.equal(userAdd(['bob'], '').status, 1);
  assert.equal(users().length, before);
});

test('arguments : identifiant manquant ou en trop → erreur ; commande inconnue → usage', () => {
  assert.match(userAdd([], 'x\n').stderr, /usage : node server\/main.js user-add <identifiant>/);
  assert.equal(userAdd(['carol', 'Mot-de-passe-en-argument'], '').status, 1);
  assert.ok(!users().some((u) => u.username === 'carol'));
  const unknown = spawnSync(process.execPath, [join(ROOT, 'server', 'main.js'), 'inconnue'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /usage : node server\/main.js <serve\|dev-seed\|user-add <identifiant>>/);
});
