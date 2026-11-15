// Bout en bout par la ligne de commande, avec le code du projet et une configuration
// temporaire (METROTRACK_CONFIG) : base et clé (dev/reader-1.key) sont créées à côté
// de cette configuration, sans toucher aux dossiers data/ et dev/ du projet.
// dev-seed → serve → tools/simulateur.js → 204 → item_locations = « Poste 1 » → même trame → 400.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const ROOT = join(import.meta.dirname, '..');
let dir, port, serverProcess;
const serverOutput = [];

async function freePort() {
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port: p } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return p;
}

const writeConfig = (name, config) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(config));
  return path;
};
const runMain = (command, configPath) =>
  spawnSync(process.execPath, [join(ROOT, 'server', 'main.js'), command], {
    env: { ...process.env, METROTRACK_CONFIG: configPath }, encoding: 'utf8', timeout: 10_000,
  });
const simulate = (counter) =>
  spawnSync(process.execPath, [join(ROOT, 'tools', 'simulateur.js'),
    '--url', `http://127.0.0.1:${port}/api/frames`, '--reader', '1',
    '--key-file', join(dir, 'dev', 'reader-1.key'), '--uid', '04A1B2C3D4E5F6', '--counter', String(counter)],
  { encoding: 'utf8', timeout: 10_000 });
const readDb = (sql) => {
  const db = new DatabaseSync(join(dir, 'data', 'mt.db'), { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-cli-'));
  port = await freePort();
});

// Sous Windows, le fichier de base reste verrouillé tant que le processus n'est pas terminé.
async function stopServer() {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
  const exited = new Promise((resolve) => serverProcess.once('exit', resolve));
  serverProcess.kill();
  await exited;
}

after(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('serve refuse de démarrer hors boucle locale (0.0.0.0, ::, IP du LAN, host absent)', () => {
  for (const host of ['0.0.0.0', '::', '192.168.1.10', undefined]) {
    const config = writeConfig('host.json', { host, port, dbPath: 'data/refus.db' });
    const res = runMain('serve', config);
    assert.equal(res.status, 1, `host ${host}`);
    assert.match(res.stderr, /refusé/, `host ${host}`);
  }
});

test('dev-seed avec une clé déjà présente : échec, clé existante intacte, base laissée vide', () => {
  const sub = join(dir, 'cle-existante');
  mkdirSync(join(sub, 'dev'), { recursive: true });
  const existing = 'ab'.repeat(32) + '\n';
  writeFileSync(join(sub, 'dev', 'reader-1.key'), existing);
  const configPath = join(sub, 'config.json');
  writeFileSync(configPath, JSON.stringify({ host: '127.0.0.1', port, dbPath: 'data/x.db' }));

  const res = runMain('dev-seed', configPath);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /EEXIST/);
  assert.equal(readFileSync(join(sub, 'dev', 'reader-1.key'), 'utf8'), existing);
  const db = new DatabaseSync(join(sub, 'data', 'x.db'), { readOnly: true });
  try {
    const { n } = db.prepare('SELECT (SELECT COUNT(*) FROM stations) + (SELECT COUNT(*) FROM readers) + (SELECT COUNT(*) FROM items) AS n').get();
    assert.equal(n, 0);
  } finally { db.close(); }
});

test('dev-seed, serve, simulateur : 204, localisation « Poste 1 », puis même trame → 400', async () => {
  const config = writeConfig('config.json', { host: '127.0.0.1', port, dbPath: 'data/mt.db' });

  const seed = runMain('dev-seed', config);
  assert.equal(seed.status, 0, seed.stderr);
  assert.ok(existsSync(join(dir, 'dev', 'reader-1.key')));
  // Un second dev-seed est refusé (base non vide).
  assert.equal(runMain('dev-seed', config).status, 1);

  serverProcess = spawn(process.execPath, [join(ROOT, 'server', 'main.js'), 'serve'], {
    env: { ...process.env, METROTRACK_CONFIG: config }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (d) => serverOutput.push(d.toString()));
  serverProcess.stderr.on('data', (d) => serverOutput.push(d.toString()));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`serveur non démarré : ${serverOutput.join('')}`)), 10_000);
    serverProcess.stdout.on('data', () => {
      if (serverOutput.join('').includes('écoute sur')) { clearTimeout(timer); resolve(); }
    });
    serverProcess.once('exit', (code) => { clearTimeout(timer); reject(new Error(`serveur arrêté (${code}) : ${serverOutput.join('')}`)); });
  });

  const first = simulate(1);
  assert.equal(first.stdout.trim(), 'HTTP 204', first.stderr);
  assert.equal(first.status, 0);
  const loc = readDb(`SELECT st.name AS poste, i.name AS objet FROM item_locations l
                        JOIN items i ON i.id = l.item_id JOIN stations st ON st.id = l.station_id`);
  assert.deepEqual(loc.map((r) => ({ ...r })), [{ poste: 'Poste 1', objet: 'Multimètre démo' }]);

  const replay = simulate(1);
  assert.equal(replay.stdout.trim(), 'HTTP 400');
  assert.equal(replay.status, 1);
  assert.equal(readDb('SELECT COUNT(*) AS n FROM scans')[0].n, 1);

  // spawnSync bloque la boucle d'événements : la sortie du serveur est lue maintenant.
  const deadline = Date.now() + 5_000;
  while (!/cause=replay/.test(serverOutput.join('')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const log = serverOutput.join('');
  assert.match(log, /scan accepté : lecteur 1, poste "Poste 1", uid 04A1B2C3D4E5F6/);
  assert.match(log, /trame rejetée : cause=replay/);
  // La clé n'apparaît jamais dans la sortie du serveur.
  const key = readDb('SELECT hex(aead_key) AS k FROM readers')[0].k.toLowerCase();
  assert.ok(!log.toLowerCase().includes(key));

  await stopServer();
});
