// Ouverture de la base SQLite (node:sqlite) et application des migrations.
// Les migrations sont les fichiers server/migrations/NNN_nom.sql, appliquées dans
// l'ordre ; la version courante du schéma est PRAGMA user_version.

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  // SÉCURITÉ (journaux en ajout seul) : sans cette option, « INSERT OR REPLACE » supprime la
  // ligne en conflit SANS déclencher les triggers BEFORE DELETE, et pourrait donc écraser une
  // ligne de scans ou d'audit_log. Avec elle, ces suppressions implicites déclenchent les
  // triggers d'ajout seul, qui les refusent. (location_corrections : trigger dédié, migration 004.)
  db.exec('PRAGMA recursive_triggers = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (version <= current) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // Une migration et la mise à jour de user_version sont atomiques.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} échouée : ${err.message}`, { cause: err });
    }
  }
}
