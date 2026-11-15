// Point d'entrée en ligne de commande.
//   node server/main.js serve     démarre le serveur HTTPS (TLS obligatoire)
//   node server/main.js dev-seed  crée des données de démonstration (base vide uniquement)
// Configuration : config.json à la racine du projet, ou chemin donné par METROTRACK_CONFIG.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from './db.js';
import { createFrameServer } from './http.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

function loadConfig() {
  const configPath = resolve(process.env.METROTRACK_CONFIG ?? join(PROJECT_ROOT, 'config.json'));
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`lecture de la configuration ${configPath} impossible : ${err.message}`);
  }
  if (typeof config.dbPath !== 'string' || config.dbPath === '') throw new Error('config : dbPath manquant');
  // Chemins relatifs (dbPath, tls.*) = relatifs au dossier du fichier de configuration.
  const configDir = dirname(configPath);
  return { ...config, configDir, dbPath: resolve(configDir, config.dbPath) };
}

function openConfiguredDb(config) {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  return openDb(config.dbPath);
}

// Lit le certificat et la clé TLS ; sans eux le serveur ne démarre pas (aucun repli en clair).
function loadTls(config) {
  const { tls } = config;
  if (typeof tls?.certPath !== 'string' || typeof tls?.keyPath !== 'string') {
    throw new Error('config : tls.certPath et tls.keyPath obligatoires (aucun serveur en clair)');
  }
  const read = (name, path) => {
    const full = resolve(config.configDir, path);
    try {
      return readFileSync(full);
    } catch (err) {
      throw new Error(`config : ${name} illisible (${full}) : ${err.message}`);
    }
  };
  return { cert: read('tls.certPath', tls.certPath), key: read('tls.keyPath', tls.keyPath) };
}

function serve() {
  const config = loadConfig();
  const { host, port } = config;
  if (typeof host !== 'string' || host === '') throw new Error('config : host manquant');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('config : port invalide');
  const tls = loadTls(config);

  const db = openConfiguredDb(config);
  const server = createFrameServer(db, { tls });
  // Avant l'écoute (port occupé, adresse invalide...) : arrêt. Après : simple journal,
  // une erreur ponctuelle (ex. EMFILE à l'acceptation) ne doit pas arrêter le serveur.
  let listening = false;
  server.on('error', (err) => {
    if (!listening) {
      console.error(`erreur : écoute impossible sur ${host}:${port} : ${err.message}`);
      process.exit(1);
    }
    console.error(`erreur du serveur : ${err.code ?? err.message}`);
  });
  server.listen(port, host, () => {
    listening = true;
    console.log(`MetroTrack : écoute sur https://${host}:${port} (base ${config.dbPath})`);
  });

  const stop = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function devSeed() {
  const config = loadConfig();
  const db = openConfiguredDb(config);
  const { n } = db.prepare(
    `SELECT (SELECT COUNT(*) FROM stations) + (SELECT COUNT(*) FROM readers)
          + (SELECT COUNT(*) FROM items) + (SELECT COUNT(*) FROM scans) AS n`
  ).get();
  if (n > 0) throw new Error('la base contient déjà des données : dev-seed refusé');

  const now = new Date().toISOString();
  // Clé AES-256 issue du CSPRNG du système (OpenSSL). Elle n'est jamais affichée ni
  // journalisée : seulement écrite dans <dossier de la config>/dev/reader-1.key
  // (à la racine du projet avec la config par défaut ; dev/ est ignoré par git).
  const key = randomBytes(32);
  const keyPath = join(config.configDir, 'dev', 'reader-1.key');

  // Atomicité base + fichier : la clé est écrite dans la transaction, juste avant le
  // COMMIT. Tout échec annule la transaction ET supprime le fichier s'il a été créé :
  // ni base semi-initialisée, ni clé orpheline.
  let keyWritten = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const station = db.prepare('INSERT INTO stations (name, created_at) VALUES (?, ?)').run('Poste 1', now);
    db.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, ?, ?, ?)')
      .run(station.lastInsertRowid, key, now);
    db.prepare('INSERT INTO items (uid_nfc, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('04A1B2C3D4E5F6', 'Multimètre démo', now, now);
    mkdirSync(dirname(keyPath), { recursive: true });
    // flag 'wx' : ne jamais écraser une clé existante. Mode 0o600 : lisible par le
    // seul propriétaire (sans effet réel sous Windows, où les ACL s'appliquent).
    writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    keyWritten = true;
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    if (keyWritten) rmSync(keyPath, { force: true });
    throw err;
  } finally {
    db.close();
  }
  console.log(`dev-seed : poste "Poste 1", lecteur 1 (clé dans ${keyPath}), objet "Multimètre démo" (UID 04A1B2C3D4E5F6)`);
}

const commands = { serve, 'dev-seed': devSeed };
const command = commands[process.argv[2]];
if (!command) {
  console.error('usage : node server/main.js <serve|dev-seed>');
  process.exit(2);
}
try {
  command();
} catch (err) {
  console.error(`erreur : ${err.message}`);
  process.exit(1);
}
