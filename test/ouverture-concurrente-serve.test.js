// Ouverture concurrente, au niveau PROCESSUS (complète test/ouverture-concurrente.test.js, qui
// utilise des threads) : plusieurs « node server/main.js serve » lancés en même temps sur la
// même base NEUVE, chacun sur son port. Avant le correctif de server/db.js, certains
// s'arrêtaient sur « database is locked » ou sur une migration rejouée (« table ... already
// exists »). Attendu : tous écoutent, base en WAL à la dernière version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeTestCerts } from './tls-fixture.js';

const ROOT = join(import.meta.dirname, '..');
const LATEST = Math.max(...readdirSync(join(ROOT, 'server', 'migrations'))
  .filter((f) => /^[0-9]{3}_/.test(f)).map((f) => Number(f.slice(0, 3))));
const PROCESSES = 4;
const ROUNDS = 2;

// Ports libres : réservés par le système (port 0), puis relâchés juste avant le lancement.
async function freePorts(n) {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  })));
  const ports = servers.map((s) => s.address().port);
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

test(`${PROCESSES} « serve » simultanés sur une base neuve (${ROUNDS} essais) : tous écoutent, aucun « database is locked »`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'metrotrack-serve-concurrent-'));
  const certs = makeTestCerts(dir);
  try {
    for (let round = 0; round < ROUNDS; round++) {
      const dbPath = join(dir, `fresh-${round}.db`);
      const ports = await freePorts(PROCESSES);
      const procs = ports.map((port, i) => {
        const cfg = join(dir, `config-${round}-${i}.json`);
        writeFileSync(cfg, JSON.stringify({ host: '127.0.0.1', port, dbPath, tls: { certPath: certs.certPath, keyPath: certs.keyPath } }));
        const p = spawn(process.execPath, ['server/main.js', 'serve'], { cwd: ROOT, env: { ...process.env, METROTRACK_CONFIG: cfg } });
        p.output = '';
        p.stdout.on('data', (d) => { p.output += d; });
        p.stderr.on('data', (d) => { p.output += d; });
        p.exited = new Promise((resolve) => p.on('exit', resolve));
        return p;
      });
      try {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline && !procs.every((p) => p.output.includes('écoute') || p.exitCode !== null)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        for (const p of procs) {
          assert.match(p.output, /écoute sur https:/, `essai ${round} : un processus n'écoute pas : ${p.output}`);
          assert.doesNotMatch(p.output, /database is locked|already exists|migration .* échouée/);
        }
      } finally {
        for (const p of procs) p.kill(); // uniquement les processus lancés par ce test
        await Promise.all(procs.map((p) => p.exited));
      }
      const db = new DatabaseSync(dbPath);
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, LATEST);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
