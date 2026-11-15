// tools/devcert.sh : le VRAI script du projet, avec un dossier temporaire en argument
// (jamais le dev/ du projet pendant les tests).
// Nécessite sh et openssl (Git Bash sous Windows) ; test ignoré sinon.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey } from 'node:crypto';

const ROOT = join(import.meta.dirname, '..');
const hasSh = spawnSync('sh', ['-c', 'command -v openssl'], { stdio: 'ignore' }).status === 0;
let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-devcert-'));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const run = () => spawnSync('sh', [join(ROOT, 'tools', 'devcert.sh'), join(dir, 'dev', 'tls')], { encoding: 'utf8', timeout: 30_000 });

test('devcert.sh : CA EC P-256 + certificat serveur (SAN localhost/127.0.0.1/::1, serverAuth) ; refuse d\'écraser', { skip: !hasSh && 'sh/openssl absents' }, () => {
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const tlsDir = join(dir, 'dev', 'tls');
  // Seuls les 4 produits restent (fichiers temporaires nettoyés).
  assert.deepEqual(readdirSync(tlsDir).sort(), ['ca.crt', 'ca.key', 'server.crt', 'server.key']);

  const ca = new X509Certificate(readFileSync(join(tlsDir, 'ca.crt')));
  const srv = new X509Certificate(readFileSync(join(tlsDir, 'server.crt')));
  assert.equal(ca.ca, true);
  assert.equal(srv.ca, false);
  assert.ok(srv.verify(ca.publicKey), 'certificat serveur signé par la CA');
  assert.ok(srv.checkIssued(ca));
  assert.equal(srv.subjectAltName, 'DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1');
  assert.deepEqual(srv.keyUsage, ['1.3.6.1.5.5.7.3.1']); // extendedKeyUsage = serverAuth
  assert.equal(srv.checkHost('localhost'), 'localhost');
  assert.equal(srv.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(srv.checkHost('evil.example'), undefined);
  for (const f of ['ca.key', 'server.key']) {
    const key = createPrivateKey(readFileSync(join(tlsDir, f)));
    assert.equal(key.asymmetricKeyType, 'ec', f);
    assert.equal(key.asymmetricKeyDetails.namedCurve, 'prime256v1', f);
  }
  // La clé du serveur correspond bien à son certificat.
  const pub = createPrivateKey(readFileSync(join(tlsDir, 'server.key')));
  assert.ok(srv.checkPrivateKey(pub));

  // Seconde exécution : refus, rien n'est modifié.
  const before = readFileSync(join(tlsDir, 'server.key'), 'utf8');
  const second = run();
  assert.equal(second.status, 1);
  assert.match(second.stderr, /existe déjà/);
  assert.equal(readFileSync(join(tlsDir, 'server.key'), 'utf8'), before);
  // Vérification croisée par openssl.
  const out = execFileSync('openssl', ['verify', '-CAfile', 'ca.crt', 'server.crt'], { cwd: tlsDir, encoding: 'utf8' });
  assert.match(out, /server\.crt: OK/);
  // Contrainte de noms critique sur la CA : limitée à localhost, 127.0.0.1 et ::1.
  const caText = execFileSync('openssl', ['x509', '-in', 'ca.crt', '-noout', '-ext', 'nameConstraints'], { cwd: tlsDir, encoding: 'utf8' });
  assert.match(caText, /Name Constraints: critical/);
  assert.match(caText, /Permitted:\s+DNS:localhost\s+IP:127\.0\.0\.1\/255\.255\.255\.255\s+IP:0:0:0:0:0:0:0:1\/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF\s*$/);
  assert.doesNotMatch(caText, /Excluded/);
});
