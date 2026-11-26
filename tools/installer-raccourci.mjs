// Crée (ou supprime) les raccourcis « MetroTrack » du Bureau et du menu Démarrer de
// l'utilisateur courant, qui lancent tools/lanceur.mjs avec le node.exe actuel (D-018).
// Usage :
//   node tools/installer-raccourci.mjs              crée ou remplace les deux raccourcis
//   node tools/installer-raccourci.mjs --supprimer  les supprime
// Pourquoi node.exe plutôt qu'un .exe à nous : node.exe est signé (fondation OpenJS), alors
// qu'un .exe non signé est bloqué par Smart App Control.
// Les raccourcis sont écrits par PowerShell (objet COM WScript.Shell). La commande est passée
// directement (pas de fichier .ps1, que la politique d'exécution pourrait bloquer). Sécurité :
// tous les chemins et textes sont transmis par variables d'environnement, jamais insérés dans
// le texte de la commande : espaces, apostrophes ou caractères spéciaux ne peuvent ni casser
// la commande ni y injecter quoi que ce soit.

import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const LAUNCHER = join(PROJECT_ROOT, 'tools', 'lanceur.mjs');

// Dossiers obtenus de Windows (gère par exemple un Bureau redirigé vers OneDrive).
const PATHS = `
$bureau = Join-Path ([Environment]::GetFolderPath('Desktop')) 'MetroTrack.lnk'
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'MetroTrack.lnk'
`;

const CREATE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${PATHS}
$shell = New-Object -ComObject WScript.Shell
foreach ($chemin in @($bureau, $menu)) {
  $lnk = $shell.CreateShortcut($chemin)
  $lnk.TargetPath = $env:MT_CIBLE
  $lnk.Arguments = $env:MT_ARGUMENTS
  $lnk.WorkingDirectory = $env:MT_DOSSIER
  $lnk.WindowStyle = 7
  $lnk.Description = $env:MT_DESCRIPTION
  $lnk.IconLocation = $env:MT_ICONE
  $lnk.Save()
  Write-Output "raccourci créé : $chemin"
}
`;

const REMOVE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
${PATHS}
foreach ($chemin in @($bureau, $menu)) {
  if (Test-Path -LiteralPath $chemin) {
    Remove-Item -LiteralPath $chemin
    Write-Output "raccourci supprimé : $chemin"
  }
}
`;

const { values } = parseArgs({ options: { supprimer: { type: 'boolean', default: false } }, strict: true });

try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', values.supprimer ? REMOVE : CREATE], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      MT_CIBLE: process.execPath,
      // Guillemets : le chemin du lanceur peut contenir des espaces (un chemin Windows ne peut
      // pas contenir de guillemet). --boite-erreur : la console du raccourci est minimisée.
      MT_ARGUMENTS: `"${LAUNCHER}" --boite-erreur`,
      MT_DOSSIER: PROJECT_ROOT,
      MT_DESCRIPTION: 'MetroTrack — inventaire',
      // Icône MetroTrack (tools/metrotrack.ico, générée depuis docs/maquettes/assets/logo.svg).
      MT_ICONE: `${join(PROJECT_ROOT, 'tools', 'metrotrack.ico')},0`,
    },
  });
  process.stdout.write(out || 'aucun raccourci à supprimer\n');
} catch (err) {
  console.error(`erreur : ${err.stderr?.toString().trim() || err.message}`);
  process.exitCode = 1;
}
