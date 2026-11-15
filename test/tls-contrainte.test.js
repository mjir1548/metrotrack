// Contrainte de noms de la CA (nameConstraints critique : localhost, 127.0.0.1, ::1) :
// un certificat signé par cette CA pour un autre nom doit être rejeté, même si la clé de la CA
// a fuité. Et : pas de reprise de session TLS (SSL_OP_NO_TICKET, aucun ticket émis).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer as createHttpsServer } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { makeTestCerts } from './tls-fixture.js';

const NOW = '2026-11-15T10:00:00.000Z';
let dir, certs, forged;

// Extensions des certificats forgés (signés par la CA de test avec sa clé).
const EXT = `[evil]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:evil.example
[mixed]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1,DNS:evil.example
[otherip]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1,IP:10.0.0.1
[cnonly]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
`;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-contrainte-'));
  certs = makeTestCerts(dir);
  const ossl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'forged.cnf'), EXT);
  ossl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'forged.key');
  forged = {};
  for (const [name, cn] of [['evil', 'localhost'], ['mixed', 'localhost'], ['otherip', 'localhost'], ['cnonly', 'evil.example']]) {
    ossl('req', '-new', '-key', 'forged.key', '-subj', `/CN=${cn}`, '-out', `${name}.csr`);
    ossl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
      '-days', '1', '-sha256', '-extfile', 'forged.cnf', '-extensions', name, '-out', `${name}.crt`);
    forged[name] = readFileSync(join(dir, `${name}.crt`));
  }
  forged.key = readFileSync(join(dir, 'forged.key'));
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('openssl verify : certificat légitime OK ; certificats hors contrainte rejetés (permitted subtree violation)', () => {
  const verify = (file) => spawnSync('openssl', ['verify', '-CAfile', 'ca.crt', file], { cwd: dir, encoding: 'utf8' });
  assert.equal(verify('server.crt').status, 0);
  for (const name of ['evil', 'mixed', 'otherip', 'cnonly']) {
    const res = verify(`${name}.crt`);
    assert.notEqual(res.status, 0, name);
    assert.match(res.stdout + res.stderr, /permitted subtree violation/, name);
  }
});

test('client Node : un faux serveur présentant un certificat hors contrainte est rejeté', async () => {
  const tryCert = async (cert, servername) => {
    const srv = createHttpsServer({ cert, key: forged.key }, (req, res) => { res.writeHead(204); res.end(); });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    try {
      return await new Promise((resolve) => {
        const s = tlsConnect({ host: '127.0.0.1', port: srv.address().port, ca: certs.ca, servername }, () => { s.destroy(); resolve('accepté'); });
        s.on('error', (e) => resolve(e.message));
      });
    } finally {
      srv.close();
    }
  };
  assert.match(await tryCert(forged.evil, 'evil.example'), /permitted subtree violation/);
  assert.match(await tryCert(forged.cnonly, 'evil.example'), /permitted subtree violation/);
  // SAN mixte : même pour un nom autorisé (localhost, 127.0.0.1), la chaîne entière est invalide.
  assert.match(await tryCert(forged.mixed, 'localhost'), /permitted subtree violation/);
  assert.match(await tryCert(forged.mixed, undefined), /permitted subtree violation/);
  assert.match(await tryCert(forged.otherip, undefined), /permitted subtree violation/);
});

test('pas de reprise de session TLS (ni TLS 1.2 ni TLS 1.3) : aucun ticket émis', async () => {
  const db = openDb(':memory:');
  const server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    for (const version of ['TLSv1.2', 'TLSv1.3']) {
      let session;
      const ticketLength = await new Promise((resolve) => {
        const s = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca, minVersion: version, maxVersion: version },
          () => s.write('GET /x HTTP/1.1\r\nHost: x\r\n\r\n'));
        s.on('session', (sess) => { session = sess; });
        s.on('data', () => {});
        s.on('error', () => {});
        s.on('close', () => resolve(s.getTLSTicket()?.length ?? 0));
        setTimeout(() => s.destroy(), 300);
      });
      assert.equal(ticketLength, 0, `${version} : ticket émis`);
      const reused = await new Promise((resolve) => {
        const s = tlsConnect({ host: '127.0.0.1', port, ca: certs.ca, minVersion: version, maxVersion: version, session },
          () => { const r = s.isSessionReused(); s.destroy(); resolve(r); });
        s.on('error', () => resolve('erreur'));
      });
      assert.equal(reused, false, `${version} : session reprise`);
    }
  } finally {
    server.closeAllConnections();
    server.close();
    db.close();
  }
});
