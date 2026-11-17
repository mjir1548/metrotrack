// Hachage des mots de passe : argon2id au format PHC, vérification, empreintes malformées,
// règles de longueur, file de calcul.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argon2Sync } from 'node:crypto';
import {
  hashPassword, verifyPassword, passwordPolicyError, DUMMY_HASH, MAX_PASSWORD_BYTES, MAX_PENDING_ARGON2, Argon2BusyError, argon2Stats,
} from '../server/password.js';

const PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';

test('empreinte au format PHC argon2id avec les paramètres D-011 (sel 16 octets, empreinte 32 octets)', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.ok(hash.startsWith(PREFIX), hash);
  const [salt, tag] = hash.slice(PREFIX.length).split('$');
  assert.match(salt, /^[A-Za-z0-9+/]+$/); // base64 sans « = »
  assert.equal(Buffer.from(salt, 'base64').length, 16);
  assert.equal(Buffer.from(tag, 'base64').length, 32);
});

test('l\'empreinte correspond à argon2id calculé indépendamment avec le même sel', async () => {
  const hash = await hashPassword('mot de passe de référence');
  const [salt, tag] = hash.slice(PREFIX.length).split('$');
  const expected = argon2Sync('argon2id', {
    message: Buffer.from('mot de passe de référence'), nonce: Buffer.from(salt, 'base64'),
    memory: 19456, passes: 2, parallelism: 1, tagLength: 32,
  });
  assert.equal(Buffer.from(tag, 'base64').toString('hex'), expected.toString('hex'));
});

test('vérification : bon mot de passe OK, mauvais KO, casse et espace final comptent', async () => {
  const hash = await hashPassword('Mot-de-passe-123');
  assert.equal(await verifyPassword('Mot-de-passe-123', hash), true);
  assert.equal(await verifyPassword('mot-de-passe-123', hash), false);
  assert.equal(await verifyPassword('Mot-de-passe-123 ', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('deux hachages du même mot de passe diffèrent (sel aléatoire)', async () => {
  const [a, b] = await Promise.all([hashPassword('identique-identique'), hashPassword('identique-identique')]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('identique-identique', a), true);
  assert.equal(await verifyPassword('identique-identique', b), true);
});

test('paramètres relus depuis l\'empreinte : une empreinte à d\'autres paramètres (raisonnables) reste vérifiable', async () => {
  const salt = Buffer.alloc(16, 7);
  const tag = argon2Sync('argon2id', { message: Buffer.from('autre-param-123'), nonce: salt, memory: 4096, passes: 3, parallelism: 2, tagLength: 32 });
  const b64 = (b) => b.toString('base64').replace(/=+$/, '');
  const stored = `$argon2id$v=19$m=4096,t=3,p=2$${b64(salt)}$${b64(tag)}`;
  assert.equal(await verifyPassword('autre-param-123', stored), true);
  assert.equal(await verifyPassword('autre-param-124', stored), false);
});

test('empreinte malformée ou aberrante : false, sans exception ni calcul démesuré', async () => {
  const good = await hashPassword('mot-de-passe-ok');
  const [, , , , salt, tag] = good.split('$');
  const cases = [
    undefined, null, '', 'texte', good.replace('argon2id', 'argon2i'), good.replace('v=19', 'v=16'),
    `$argon2id$v=19$m=4194304,t=2,p=1$${salt}$${tag}`, // 4 Gio : refusé avant tout calcul
    `$argon2id$v=19$m=19456,t=99,p=1$${salt}$${tag}`,
    `$argon2id$v=19$m=19456,t=0,p=1$${salt}$${tag}`,
    `$argon2id$v=19$m=19456,t=2,p=0$${salt}$${tag}`,
    `$argon2id$v=19$m=19456,t=2,p=1$${salt}==$${tag}`, // remplissage interdit
    `$argon2id$v=19$m=19456,t=2,p=1$QUFB$${tag}`, // sel de 3 octets
    `$argon2id$v=19$m=19456,t=2,p=1$${salt}$QUFBQUFB`, // empreinte de 6 octets
    `$argon2id$v=19$m=19456,t=2,p=1$${salt}$${tag}$extra`,
    `${good}\n`,
  ];
  for (const stored of cases) {
    assert.equal(await verifyPassword('mot-de-passe-ok', stored), false, String(stored));
  }
  assert.equal(await verifyPassword(undefined, good), false);
});

test('empreinte factice (comptes inconnus ou désactivés) : bien formée, ne valide aucun mot de passe', async () => {
  assert.ok(DUMMY_HASH.startsWith(PREFIX));
  assert.equal(await verifyPassword('', DUMMY_HASH), false);
  assert.equal(await verifyPassword('n-importe-quoi', DUMMY_HASH), false);
});

test('règles : 12 caractères au moins (points de code), 1024 octets au plus', () => {
  assert.match(passwordPolicyError('a'.repeat(11)), /trop court/);
  assert.equal(passwordPolicyError('a'.repeat(12)), null);
  assert.equal(passwordPolicyError('é'.repeat(12)), null); // 12 caractères, 24 octets
  assert.match(passwordPolicyError('🔒'.repeat(6)), /trop court/); // 6 caractères (12 unités UTF-16)
  assert.equal(passwordPolicyError('a'.repeat(MAX_PASSWORD_BYTES)), null);
  assert.match(passwordPolicyError('a'.repeat(MAX_PASSWORD_BYTES + 1)), /trop long/);
  assert.match(passwordPolicyError('é'.repeat(513)), /trop long/); // 1026 octets
  assert.match(passwordPolicyError(undefined), /invalide/);
});

test('normalisation NFC : « é » précomposé ou décomposé donne le même mot de passe', async () => {
  const composed = 'mot-de-passe-été';      // é = U+00E9
  const decomposed = 'mot-de-passe-été';  // é = e + U+0301
  assert.notEqual(composed, decomposed);
  const hash = await hashPassword(decomposed);
  assert.equal(await verifyPassword(composed, hash), true);
  assert.equal(await verifyPassword(decomposed, hash), true);
  // Les règles de longueur s'appliquent à la forme normalisée (12 caractères ici, pas 24).
  assert.equal(passwordPolicyError('é'.repeat(12)), null);
  assert.match(passwordPolicyError('é'.repeat(11)), /trop court/);
});

test(`file bornée : au-delà de ${MAX_PENDING_ARGON2} calculs en attente, refus immédiat (Argon2BusyError) sans calcul`, async () => {
  assert.equal(MAX_PENDING_ARGON2, 16);
  const startedBefore = argon2Stats().started;
  const settled = await Promise.allSettled(Array.from({ length: 20 }, () => verifyPassword('x', DUMMY_HASH)));
  const busy = settled.filter((r) => r.status === 'rejected');
  assert.equal(busy.length, 4);
  for (const r of busy) {
    assert.ok(r.reason instanceof Argon2BusyError);
    assert.equal(r.reason.code, 'ARGON2_BUSY');
  }
  assert.equal(argon2Stats().started - startedBefore, 16);
  assert.equal(argon2Stats().pending, 0);
  // La file fonctionne de nouveau.
  assert.equal(await verifyPassword('x', DUMMY_HASH), false);
});

test('abandon (skip) : aucun calcul si le demandeur est parti, à l\'entrée ou au moment du lancement', async () => {
  const startedBefore = argon2Stats().started;
  assert.equal(await verifyPassword('x', DUMMY_HASH, { skip: () => true }), false);
  assert.equal(argon2Stats().started, startedBefore);
  // Parti pendant l'attente : le premier calcul occupe la file, le second est abandonné.
  let gone = false;
  const first = verifyPassword('x', DUMMY_HASH);
  const second = verifyPassword('x', DUMMY_HASH, { skip: () => gone });
  gone = true;
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(argon2Stats().started - startedBefore, 1);
  assert.equal(argon2Stats().pending, 0);
});

test('file unique : des calculs concurrents aboutissent tous, une erreur n\'interrompt pas la file', async () => {
  const hashes = await Promise.all(Array.from({ length: 5 }, (_, i) => hashPassword(`concurrent-${i}-xxxx`)));
  await assert.rejects(hashPassword(42), TypeError);
  const results = await Promise.all(hashes.map((h, i) => verifyPassword(`concurrent-${i}-xxxx`, h)));
  assert.deepEqual(results, [true, true, true, true, true]);
});
