// tools/lanceur.mjs : ce qui se teste sans ouvrir Edge.
// Instance temporaire (dossier et port libres) : jamais la démo de dev/demo.
// Nécessite sh et openssl (Git Bash sous Windows) pour les certificats ; arrêt testé sous Windows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer as createTlsServer } from 'node:tls';
import { createServer as createTcpServer } from 'node:net';
import {
  loadLauncherConfig, spkiFingerprint, edgeArguments, serverStatus, ensureServer, stopServer, isOurServer, listeningPids, processInfo, SERVER_MAIN,
} from '../tools/lanceur.mjs';
import { openDb } from '../server/db.js';

const ROOT = join(import.meta.dirname, '..');
const hasSh = spawnSync('sh', ['-c', 'command -v openssl && command -v base64'], { stdio: 'ignore' }).status === 0;
const isWindows = process.platform === 'win32';
let dir;
let configPath;
let config;
const toKill = [];

const freePort = () => new Promise((resolve) => {
  const s = createTcpServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
// Les connexions restantes sont détruites à la fermeture (sinon server.close peut attendre
// indéfiniment une socket à demi fermée).
const listen = (server, port) => {
  server.sockets = new Set();
  server.on('connection', (s) => {
    s.on('error', () => {});
    server.sockets.add(s);
    s.on('close', () => server.sockets.delete(s));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
};
const close = (server) => new Promise((resolve) => {
  server.close(resolve);
  for (const s of server.sockets) s.destroy();
});

before(async () => {
  if (!hasSh) return;
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-lanceur-'));
  const tlsDir = join(dir, 'tls');
  const gen = spawnSync('sh', [join(ROOT, 'tools', 'devcert.sh'), tlsDir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(gen.status, 0, gen.stderr);
  configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1', port: await freePort(), dbPath: 'data/test.db',
    tls: { certPath: 'tls/server.crt', keyPath: 'tls/server.key' },
  }));
  config = loadLauncherConfig(configPath);
});

after(() => {
  // Filet : tout serveur de CE projet resté à l'écoute sur le port de test (échec en cours de test).
  if (config && isWindows) {
    for (const pid of listeningPids(config.port)) if (isOurServer(processInfo(pid))) toKill.push(pid);
  }
  for (const pid of toKill) if (alive(pid)) process.kill(pid);
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

test('empreinte SPKI identique à celle calculée par openssl', { skip: !hasSh && 'sh/openssl absents' }, () => {
  const expected = execFileSync('sh', ['-c',
    'openssl x509 -in server.crt -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64'],
  { cwd: join(dir, 'tls'), encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
  assert.match(expected, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(spkiFingerprint(config.cert), expected);
  // La CA a une autre clé : empreinte différente.
  assert.notEqual(spkiFingerprint(readFileSync(join(dir, 'tls', 'ca.crt'))), expected);
});

test('configuration : chemins relatifs au dossier de la config, fichiers pid et journal à côté', { skip: !hasSh && 'sh/openssl absents' }, () => {
  assert.equal(config.configDir, dir);
  assert.equal(config.pidPath, join(dir, 'lanceur.pid'));
  assert.equal(config.logPath, join(dir, 'lanceur.log'));
  assert.deepEqual(config.cert, readFileSync(join(dir, 'tls', 'server.crt')));
  assert.throws(() => loadLauncherConfig(join(dir, 'absente.json')), /lecture de la configuration/);
});

test('arguments Edge : mode application, profil dédié, exception TLS limitée à une clé', () => {
  const args = edgeArguments({ port: 18443, spki: 'AAAA+/BB=', profileDir: 'C:\\Users\\x y\\AppData\\Local\\MetroTrack\\fenetre' });
  assert.deepEqual(args, [
    '--app=https://localhost:18443/',
    '--user-data-dir=C:\\Users\\x y\\AppData\\Local\\MetroTrack\\fenetre',
    '--no-first-run',
    '--window-size=1440,900',
    '--disable-sync',
    '--disable-features=msImplicitSignin',
    '--ignore-certificate-errors-spki-list=AAAA+/BB=',
    '--test-type',
  ]);
  // Jamais l'option globale, qui accepterait n'importe quel certificat.
  assert.ok(!args.some((a) => a === '--ignore-certificate-errors' || a.startsWith('--ignore-certificate-errors=')));
});

test('isOurServer : seul node exécutant le server/main.js de ce projet avec « serve »', () => {
  const cmd = `"C:\\Program Files\\nodejs\\node.exe" ${SERVER_MAIN} serve`;
  assert.equal(isOurServer({ Name: 'node.exe', CommandLine: cmd }), true);
  assert.equal(isOurServer({ Name: 'node.exe', CommandLine: cmd.replaceAll('\\', '/').toUpperCase() }), true);
  assert.equal(isOurServer({ Name: 'notepad.exe', CommandLine: cmd }), false);
  assert.equal(isOurServer({ Name: 'node.exe', CommandLine: 'node C:\\autre\\server\\main.js serve' }), false);
  assert.equal(isOurServer({ Name: 'node.exe', CommandLine: `node ${SERVER_MAIN} dev-seed` }), false);
  assert.equal(isOurServer({ Name: 'node.exe', CommandLine: null }), false);
  assert.equal(isOurServer(null), false);
});

test('détection : absent, notre serveur, autre programme TLS, programme non TLS', { skip: !hasSh && 'sh/openssl absents' }, async () => {
  assert.equal(await serverStatus(config), 'absent');

  const tlsDir = join(dir, 'tls');
  const ours = createTlsServer({ cert: config.cert, key: readFileSync(join(tlsDir, 'server.key')) }, (s) => s.end());
  await listen(ours, config.port);
  try {
    assert.equal(await serverStatus(config), 'notre-serveur');
  } finally {
    await close(ours);
  }

  // Même port, autre certificat (celui de la CA) : pas notre serveur.
  const other = createTlsServer({ cert: readFileSync(join(tlsDir, 'ca.crt')), key: readFileSync(join(tlsDir, 'ca.key')) }, (s) => s.end());
  await listen(other, config.port);
  try {
    assert.equal(await serverStatus(config), 'autre');
    await assert.rejects(ensureServer(config), /déjà utilisé par un autre programme/);
  } finally {
    await close(other);
  }

  // Programme qui accepte la connexion sans parler TLS.
  const plain = createTcpServer((s) => s.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
  await listen(plain, config.port);
  try {
    assert.equal(await serverStatus(config), 'autre');
  } finally {
    await close(plain);
  }
});

test('arrêt : refuse un PID qui n\'est pas notre serveur, sans rien tuer', { skip: (!hasSh && 'sh/openssl absents') || (!isWindows && 'Windows uniquement') }, async () => {
  // Processus node dont la ligne de commande imite le serveur, mais avec un autre chemin.
  const decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(dir, 'server', 'main.js'), 'serve'], { stdio: 'ignore' });
  toKill.push(decoy.pid);
  await new Promise((r) => decoy.once('spawn', r));

  writeFileSync(config.pidPath, `${decoy.pid}\n`);
  const result = stopServer(config);
  assert.equal(result.stopped, false);
  assert.match(result.message, /n'est pas le serveur MetroTrack/);
  assert.ok(alive(decoy.pid), 'le processus leurre doit être toujours vivant');

  writeFileSync(config.pidPath, 'abc\n');
  assert.match(stopServer(config).message, /illisible/);

  rmSync(config.pidPath);
  assert.match(stopServer(config).message, /pas de lanceur\.pid/);
  decoy.kill();
});

test('listeningPids : retrouve le processus qui écoute sur un port', { skip: !isWindows && 'Windows uniquement' }, async () => {
  const server = createTcpServer();
  await listen(server, 0);
  try {
    assert.ok(listeningPids(server.address().port).includes(process.pid));
  } finally {
    await close(server);
  }
  assert.deepEqual(listeningPids(0), []);
  assert.deepEqual(listeningPids('1; Remove-Item x'), []);
});

test('démarrage réel puis arrêt : un seul serveur, PID vérifié', { skip: (!hasSh && 'sh/openssl absents') || (!isWindows && 'Windows uniquement'), timeout: 60_000 }, async () => {
  mkdirSync(join(dir, 'data'), { recursive: true });
  // Base déjà créée, comme celle de la démo. (Sur une base NEUVE, deux serveurs démarrés en même
  // temps peuvent tous deux échouer sur « database is locked » dans server/db.js : signalé, hors
  // du périmètre du lanceur.)
  openDb(join(dir, 'data', 'test.db')).close();
  // Double-clic rapide : deux lancements simultanés. Un seul serveur garde le port, et
  // lanceur.pid désigne CELUI-LÀ (le perdant ne l'écrase ni ne le supprime).
  const results = await Promise.all([ensureServer(config), ensureServer(config)]);
  const winners = results.filter((r) => r.started);
  assert.equal(winners.length, 1, JSON.stringify(results));
  const first = winners[0];
  toKill.push(first.pid);
  assert.equal(readFileSync(config.pidPath, 'utf8').trim(), String(first.pid));
  assert.deepEqual(listeningPids(config.port), [first.pid]);
  assert.equal(await serverStatus(config), 'notre-serveur');

  // Le PID est bien un serveur MetroTrack de ce projet, mais pas celui d'une AUTRE config
  // (autre dossier, autre port) : refus, le serveur continue de tourner.
  const otherDir = join(dir, 'autre');
  mkdirSync(otherDir);
  const otherConfig = { ...config, port: await freePort(), configDir: otherDir, pidPath: join(otherDir, 'lanceur.pid') };
  writeFileSync(otherConfig.pidPath, `${first.pid}\n`);
  const refused = stopServer(otherConfig);
  assert.equal(refused.stopped, false);
  assert.match(refused.message, /n'écoute pas sur le port/);
  assert.ok(alive(first.pid));

  // Deuxième lancement : rien n'est relancé.
  const second = await ensureServer(config);
  assert.equal(second.started, false);
  assert.equal(readFileSync(config.pidPath, 'utf8').trim(), String(first.pid));

  const stop = stopServer(config);
  assert.equal(stop.stopped, true, stop.message);
  assert.equal(existsSync(config.pidPath), false);
  for (let i = 0; i < 50 && alive(first.pid); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(first.pid), false);
  // Windows libère le port un court instant après la fin du processus (ECONNRESET entre-temps).
  let status;
  for (let i = 0; i < 50 && (status = await serverStatus(config)) !== 'absent'; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(status, 'absent');
  assert.match(readFileSync(config.logPath, 'utf8'), /écoute sur https:\/\/127\.0\.0\.1:/);
});
