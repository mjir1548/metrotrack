// Lanceur de démonstration Windows (D-018) : démarre le serveur MetroTrack s'il ne tourne pas,
// puis ouvre une fenêtre Microsoft Edge en mode application sur l'interface.
// Usage :
//   node tools/lanceur.mjs [--config <chemin>] [--boite-erreur]
//   node tools/lanceur.mjs [--config <chemin>] --arreter
// Config par défaut : dev/demo/config.json (instance de démonstration).
//   --boite-erreur : affiche aussi les erreurs dans une boîte de dialogue (utilisé par le
//                    raccourci, dont la console est minimisée).
//   --arreter      : arrête le serveur lancé par ce lanceur (PID noté dans lanceur.pid).
// Le serveur continue de tourner en arrière-plan après la fin du lanceur ; son journal est
// écrit dans lanceur.log, à côté de la configuration.
//
// Sécurité :
// - la fenêtre Edge ne fait confiance qu'au certificat de CE serveur, désigné par l'empreinte
//   SHA-256 de sa clé publique (--ignore-certificate-errors-spki-list). Aucune autorité n'est
//   ajoutée au magasin de Windows, et l'option globale --ignore-certificate-errors (qui
//   accepterait N'IMPORTE QUEL certificat, sur n'importe quel site) n'est jamais utilisée ;
// - un profil Edge dédié (%LOCALAPPDATA%\MetroTrack\fenetre) isole la fenêtre du navigateur
//   habituel de l'utilisateur : l'exception ci-dessus ne s'applique qu'à ce profil (Chromium
//   n'honore d'ailleurs cette option qu'avec un --user-data-dir explicite) ;
// - --arreter ne tue un processus qu'après avoir vérifié qu'il s'agit bien de node exécutant
//   le server/main.js de CE projet, et qu'il écoute sur le port de CETTE configuration (un PID
//   peut avoir été réattribué à un autre programme, ou désigner le serveur d'une autre config).

import { readFileSync, writeFileSync, renameSync, existsSync, rmSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { connect } from 'node:tls';
import { X509Certificate, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';

export const PROJECT_ROOT = resolve(import.meta.dirname, '..');
export const SERVER_MAIN = join(PROJECT_ROOT, 'server', 'main.js');
const DEFAULT_CONFIG = join(PROJECT_ROOT, 'dev', 'demo', 'config.json');
const START_TIMEOUT_MS = 10_000;
const RACE_GRACE_MS = 3000;

/**
 * Lit la configuration comme server/main.js (chemins relatifs au dossier du fichier).
 * server/main.js n'exporte rien (il exécute sa commande à l'import) : ces quelques lignes
 * sont donc reprises ici, limitées à ce dont le lanceur a besoin.
 */
export function loadLauncherConfig(configPath) {
  const path = resolve(configPath);
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`lecture de la configuration ${path} impossible : ${err.message}`);
  }
  const { host, port } = config;
  if (typeof host !== 'string' || host === '') throw new Error('config : host manquant');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('config : port invalide');
  if (typeof config.tls?.certPath !== 'string') throw new Error('config : tls.certPath manquant');
  const configDir = dirname(path);
  const certPath = resolve(configDir, config.tls.certPath);
  let cert;
  try {
    cert = readFileSync(certPath);
  } catch (err) {
    throw new Error(`certificat du serveur illisible (${certPath}) : ${err.message}`);
  }
  return {
    configPath: path,
    configDir,
    host,
    port,
    cert,
    pidPath: join(configDir, 'lanceur.pid'),
    logPath: join(configDir, 'lanceur.log'),
  };
}

/** Empreinte « SPKI » : base64 du SHA-256 de la clé publique du certificat (format DER). */
export function spkiFingerprint(certPem) {
  const spki = new X509Certificate(certPem).publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('base64');
}

/** Arguments de la fenêtre Edge (fonction pure). */
export function edgeArguments({ port, spki, profileDir }) {
  return [
    `--app=https://localhost:${port}/`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--window-size=1440,900',
    // Profil dédié jamais relié au compte Microsoft de la session Windows (sinon Edge le
    // connecte d'office) ni synchronisé : l'historique MetroTrack ne part pas dans le nuage.
    '--disable-sync',
    '--disable-features=msImplicitSignin',
    // Exception TLS limitée à la clé publique de notre serveur (voir l'en-tête du fichier).
    `--ignore-certificate-errors-spki-list=${spki}`,
    // Masque le bandeau « indicateur de ligne de commande non pris en charge » qu'Edge affiche
    // à cause de l'option précédente. Option de test de Chromium : à valider (voir D-018).
    '--test-type',
  ];
}

/** Chemin de msedge.exe aux emplacements standard, ou null. */
export function findEdge(env = process.env) {
  const bases = [env['ProgramFiles(x86)'], env.ProgramFiles].filter(Boolean);
  for (const base of bases) {
    const candidate = join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Adresse à laquelle se connecter pour joindre un serveur qui écoute sur `host`.
function connectHost(host) {
  if (host === '0.0.0.0') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

/**
 * Le serveur de cette configuration répond-il ?
 * Renvoie 'notre-serveur', 'absent' (connexion refusée) ou 'autre' (le port répond, mais pas
 * avec notre certificat : autre programme, ou serveur pas encore prêt).
 * Sécurité : la vérification par CA est désactivée (rejectUnauthorized: false) car elle est
 * remplacée par une comparaison plus stricte : le certificat présenté doit être EXACTEMENT celui
 * de la configuration. Aucune donnée n'est envoyée : la poignée de main TLS suffit.
 */
export function serverStatus(config, timeoutMs = 2000) {
  const expected = new X509Certificate(config.cert).raw;
  return new Promise((resolvePromise) => {
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      // Fermeture propre une fois la poignée de main faite (sinon le serveur journalise une
      // connexion réinitialisée à chaque vérification) ; brutale dans les autres cas.
      if (status === 'notre-serveur') socket.end();
      else socket.destroy();
      resolvePromise(status);
    };
    const socket = connect({
      host: connectHost(config.host),
      port: config.port,
      servername: 'localhost',
      rejectUnauthorized: false,
    });
    socket.setTimeout(timeoutMs, () => done('autre'));
    socket.once('secureConnect', () => {
      const peer = socket.getPeerX509Certificate();
      done(peer && peer.raw.equals(expected) ? 'notre-serveur' : 'autre');
    });
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED' ? 'absent' : 'autre'));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Démarre le serveur s'il ne répond pas déjà. Renvoie { started: boolean, pid?: number }.
 * Le serveur est détaché (il survit au lanceur), sans fenêtre, journal dans lanceur.log.
 */
export async function ensureServer(config, { timeoutMs = START_TIMEOUT_MS } = {}) {
  const status = await serverStatus(config);
  if (status === 'notre-serveur') return { started: false };
  if (status === 'autre') {
    throw new Error(`le port ${config.port} est déjà utilisé par un autre programme`);
  }

  const log = openSync(config.logPath, 'a');
  let child;
  try {
    child = spawn(process.execPath, [SERVER_MAIN, 'serve'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, METROTRACK_CONFIG: config.configPath },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', log, log],
    });
  } finally {
    closeSync(log);
  }
  let exitCode = null;
  let exitedAt = 0;
  const onExit = (code) => { exitCode = code ?? -1; exitedAt = Date.now(); };
  child.once('exit', onExit);
  child.once('error', () => onExit(-1));
  child.unref();

  // Deux lancements rapprochés (double-clic) peuvent démarrer deux serveurs : un seul obtient le
  // port, l'autre s'arrête. lanceur.pid n'est donc écrit qu'une fois établi que c'est NOTRE
  // enfant qui écoute sur le port (et jamais supprimé ici) : le fichier désigne toujours le
  // serveur qui tourne réellement.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ours = await serverStatus(config, 1000) === 'notre-serveur';
    if (ours && exitCode === null && listeningPids(config.port).includes(child.pid)) {
      writePidFile(config.pidPath, child.pid);
      return { started: true, pid: child.pid };
    }
    if (exitCode !== null) {
      // Un autre lanceur a gagné la course : son serveur répond, rien à faire.
      if (ours) return { started: false };
      // Notre serveur a pu échouer À CAUSE de l'autre (port pris, base verrouillée pendant ses
      // migrations) avant que celui-ci réponde : on lui laisse quelques secondes.
      if (Date.now() - exitedAt > RACE_GRACE_MS) {
        throw new Error(`le serveur s'est arrêté au démarrage (code ${exitCode}) : ${lastLogLine(config.logPath)} ; journal : ${config.logPath}`);
      }
    }
    await sleep(200);
  }
  throw new Error(`le serveur ne répond pas après ${timeoutMs / 1000} s ; voir ${config.logPath}`);
}

// Dernière ligne non vide du journal (la cause de l'arrêt, en général), bornée en longueur.
function lastLogLine(logPath) {
  try {
    const lines = readFileSync(logPath, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
    return (lines.at(-1) ?? '').slice(0, 300);
  } catch {
    return '';
  }
}

// Écriture atomique (fichier temporaire puis renommage) : jamais de lanceur.pid à moitié écrit.
function writePidFile(pidPath, pid) {
  const tmp = `${pidPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${pid}\n`);
  renameSync(tmp, pidPath);
}

/**
 * PID des processus qui écoutent sur le port TCP `port` (Windows). server/main.js ne prend pas
 * la configuration en argument : c'est le port d'écoute qui relie un processus à SA config.
 */
export function listeningPids(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  // `port` est un entier validé ci-dessus : aucune injection possible dans la commande.
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess }; exit 0`,
  ], { encoding: 'utf8', windowsHide: true });
  return out.split(/\s+/).filter((s) => /^\d+$/.test(s)).map(Number);
}

/**
 * La ligne de commande désigne-t-elle le server/main.js de CE projet lancé par node ?
 * (fonction pure ; comparaison insensible à la casse et aux séparateurs, comme Windows)
 */
export function isOurServer(processInfo) {
  if (!processInfo || typeof processInfo.CommandLine !== 'string') return false;
  if (!/^node(\.exe)?$/i.test(processInfo.Name ?? '')) return false;
  const norm = (s) => s.replaceAll('\\', '/').toLowerCase();
  const cmd = norm(processInfo.CommandLine);
  return cmd.includes(norm(SERVER_MAIN)) && /\sserve(\s|$)/.test(cmd);
}

/** Nom et ligne de commande du processus `pid` (Windows), ou null s'il n'existe pas. */
export function processInfo(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  // `pid` est un entier validé ci-dessus : aucune injection possible dans le filtre.
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object Name,CommandLine | ConvertTo-Json -Compress`,
  ], { encoding: 'utf8', windowsHide: true }).trim();
  return out ? JSON.parse(out) : null;
}

/**
 * Arrête le serveur noté dans lanceur.pid, après vérification de son identité.
 * Renvoie { stopped: boolean, message: string }. Ne tue jamais un processus non vérifié.
 */
export function stopServer(config) {
  let text;
  try {
    text = readFileSync(config.pidPath, 'utf8').trim();
  } catch {
    return { stopped: false, message: 'aucun serveur lancé par le lanceur (pas de lanceur.pid)' };
  }
  if (!/^\d{1,10}$/.test(text)) {
    return { stopped: false, message: `lanceur.pid illisible : rien n'a été arrêté` };
  }
  const pid = Number(text);
  const info = processInfo(pid);
  if (!info) {
    rmSync(config.pidPath, { force: true });
    return { stopped: false, message: `le serveur (PID ${pid}) n'est plus en cours d'exécution` };
  }
  if (!isOurServer(info)) {
    return { stopped: false, message: `le PID ${pid} n'est pas le serveur MetroTrack : rien n'a été arrêté` };
  }
  // Un serveur MetroTrack de ce projet, mais est-ce celui de CETTE configuration ?
  if (!listeningPids(config.port).includes(pid)) {
    return { stopped: false, message: `le PID ${pid} n'écoute pas sur le port ${config.port} de cette configuration : rien n'a été arrêté` };
  }
  // Sous Windows, c'est un arrêt immédiat (TerminateProcess). SQLite en mode WAL garantit que
  // la base reste cohérente : toute transaction validée est conservée, les autres sont annulées.
  process.kill(pid);
  rmSync(config.pidPath, { force: true });
  return { stopped: true, message: `serveur MetroTrack arrêté (PID ${pid})` };
}

/** Ouvre la fenêtre Edge, détachée du lanceur. Renvoie le processus créé. */
export function openEdge(edge, args) {
  const child = spawn(edge, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

function profileDir(env = process.env) {
  const base = env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return join(base, 'MetroTrack', 'fenetre');
}

// Boîte de dialogue Windows. Le texte passe par une variable d'environnement : aucun échappement
// à faire dans la commande PowerShell, aucune injection possible.
function showMessage(message) {
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Add-Type -AssemblyName PresentationFramework; [void][System.Windows.MessageBox]::Show($env:MT_MESSAGE, "MetroTrack")',
    ], { env: { ...process.env, MT_MESSAGE: message }, windowsHide: true, stdio: 'ignore' });
  } catch {
    // La console reste la seule sortie.
  }
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        config: { type: 'string', default: DEFAULT_CONFIG },
        arreter: { type: 'boolean', default: false },
        'boite-erreur': { type: 'boolean', default: false },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`erreur : ${err.message}\nusage : node tools/lanceur.mjs [--config <chemin>] [--boite-erreur | --arreter]`);
    process.exitCode = 2;
    return;
  }
  const notify = (message) => {
    console.log(message);
    if (values['boite-erreur']) showMessage(message);
  };
  try {
    const config = loadLauncherConfig(values.config);
    if (values.arreter) {
      const { stopped, message } = stopServer(config);
      console.log(message);
      process.exitCode = stopped ? 0 : 1;
      return;
    }
    const { started, pid } = await ensureServer(config);
    console.log(started ? `serveur démarré (PID ${pid}), journal : ${config.logPath}` : 'serveur déjà en cours d\'exécution');

    const url = `https://localhost:${config.port}/`;
    const edge = findEdge();
    if (!edge) {
      notify(`Microsoft Edge est introuvable. Ouvrez cette adresse dans un navigateur : ${url}`);
      return;
    }
    const args = edgeArguments({ port: config.port, spki: spkiFingerprint(config.cert), profileDir: profileDir() });
    openEdge(edge, args);
    console.log(`fenêtre ouverte : ${url}`);
  } catch (err) {
    console.error(`erreur : ${err.message}`);
    if (values['boite-erreur']) showMessage(`MetroTrack n'a pas pu démarrer :\n${err.message}`);
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
