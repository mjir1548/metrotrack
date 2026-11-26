// Ouverture de la base SQLite (node:sqlite) et application des migrations.
// Les migrations sont les fichiers server/migrations/NNN_nom.sql, appliquées dans
// l'ordre ; la version courante du schéma est PRAGMA user_version.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');
const BUSY_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;

export function openDb(path) {
  const db = new DatabaseSync(path);
  // EN PREMIER : sur une base neuve, passer en WAL et appliquer les migrations prennent un
  // verrou d'écriture. Sans délai d'attente déjà en place, deux processus qui ouvrent la même
  // base au même moment (deux « serve », un « serve » et un « dev-seed »...) échouent
  // aussitôt avec « database is locked » au lieu d'attendre leur tour.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA foreign_keys = ON');
  // SÉCURITÉ (journaux en ajout seul) : sans cette option, « INSERT OR REPLACE » supprime la
  // ligne en conflit SANS déclencher les triggers BEFORE DELETE, et pourrait donc écraser une
  // ligne de scans ou d'audit_log. Avec elle, ces suppressions implicites déclenchent les
  // triggers d'ajout seul, qui les refusent. (location_corrections : trigger dédié, migration 004.)
  db.exec('PRAGMA recursive_triggers = ON');
  enableWal(db, path);
  migrate(db);
  return db;
}

/**
 * Passage en WAL, avec nouvelles tentatives. Sur une base neuve ouverte par plusieurs
 * connexions à la fois, SQLite refuse ce changement par SQLITE_BUSY SANS attendre le délai
 * busy_timeout (mesuré : échec immédiat ; deux connexions qui veulent chacune passer d'un
 * verrou partagé à un verrou exclusif, SQLite en fait échouer une au lieu de la faire
 * attendre). On réessaie donc ici, dans la même limite de temps que busy_timeout. Dès qu'une
 * connexion a réussi, la base est en WAL et la commande des autres n'a plus rien à changer.
 */
export function enableWal(db, path) {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let mode;
    try {
      mode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
    } catch (err) {
      if ((err.errcode & 0xff) !== SQLITE_BUSY || Date.now() >= deadline) throw err;
      Atomics.wait(pause, 0, 0, 10); // attente synchrone de 10 ms (ouverture seulement)
      continue;
    }
    // SQLite ne signale pas d'erreur s'il ne peut pas passer en WAL (par exemple un système
    // de fichiers sans mémoire partagée) : il renvoie le mode resté en place. On refuse alors
    // de démarrer plutôt que de tourner sans les garanties attendues (lectures pendant les
    // écritures). Seule exception : une base en mémoire (tests), qui reste en mode « memory ».
    const expected = path === ':memory:' ? 'memory' : 'wal';
    if (mode !== expected) {
      throw new Error(`base ${path} : passage en mode WAL impossible (mode « ${mode} »). Placez la base sur un disque local.`);
    }
    return;
  }
}

function migrate(db) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  // Lecture rapide hors transaction : une base déjà à jour (cas courant) ne prend aucun
  // verrou d'écriture. Elle ne sert qu'à sauter les migrations déjà faites ; la décision
  // d'appliquer est reprise sous verrou ci-dessous.
  const known = db.prepare('PRAGMA user_version').get().user_version;
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (version <= known) continue;
    // Une migration et la mise à jour de user_version sont atomiques. La version est lue
    // APRÈS BEGIN IMMEDIATE (verrou d'écriture pris) : si un autre processus a appliqué cette
    // migration entre-temps, on le voit ici et on ne la rejoue pas (elle échouerait, par
    // exemple sur un CREATE TABLE déjà fait).
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db.prepare('PRAGMA user_version').get().user_version;
      if (version > current) {
        db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
        db.exec(`PRAGMA user_version = ${version}`);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} échouée : ${err.message}`, { cause: err });
    }
  }
}
