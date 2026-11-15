// Certificats TLS de test, générés à l'exécution (aucune clé privée versionnée, même de test).
// Mêmes paramètres que tools/devcert.sh : CA EC P-256, certificat serveur signé par elle,
// SAN DNS:localhost, IP:127.0.0.1, IP:::1, usage serverAuth, contrainte de noms critique sur la CA.
// Nécessite le CLI openssl. À GARDER SYNCHRONISÉ avec tools/devcert.sh.
// (node --test exécute aussi ce fichier : il ne contient aucun test et n'a pas d'effet à l'import.)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CNF = `[req]
distinguished_name = dn
prompt = no
[dn]
CN = MetroTrack test
[ca_ext]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical,permitted;DNS:localhost,permitted;IP:127.0.0.1/255.255.255.255,permitted;IP:::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
[server_ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1,IP:::1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
`;

/**
 * Génère dans `dir` : ca.crt/ca.key, server.crt/server.key (signé par ca), other-ca.crt
 * (CA sans rapport, pour les tests de mauvaise CA).
 * @returns {{ca: Buffer, otherCa: Buffer, cert: Buffer, key: Buffer, caPath: string, otherCaPath: string, certPath: string, keyPath: string}}
 */
export function makeTestCerts(dir) {
  const ossl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'openssl-test.cnf'), CNF);
  const newCa = (name) => {
    ossl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', `${name}.key`);
    ossl('req', '-config', 'openssl-test.cnf', '-new', '-x509', '-key', `${name}.key`, '-subj', `/CN=${name}`,
      '-days', '2', '-sha256', '-extensions', 'ca_ext', '-out', `${name}.crt`);
  };
  newCa('ca');
  newCa('other-ca');
  ossl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', 'server.key');
  ossl('req', '-config', 'openssl-test.cnf', '-new', '-key', 'server.key', '-subj', '/CN=localhost', '-out', 'server.csr');
  ossl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial',
    '-days', '2', '-sha256', '-extfile', 'openssl-test.cnf', '-extensions', 'server_ext', '-out', 'server.crt');
  const path = (f) => join(dir, f);
  return {
    caPath: path('ca.crt'), otherCaPath: path('other-ca.crt'), certPath: path('server.crt'), keyPath: path('server.key'),
    ca: readFileSync(path('ca.crt')), otherCa: readFileSync(path('other-ca.crt')),
    cert: readFileSync(path('server.crt')), key: readFileSync(path('server.key')),
  };
}
