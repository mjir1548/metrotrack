// Contrôle statique de web/static/app.js, le seul script de l'interface (D-021, étape U2) :
// DOM construit par createElement et textContent uniquement, aucune évaluation de code, aucun
// appel vers un autre site, aucun stockage dans le navigateur, mode strict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(import.meta.dirname, '..', 'web', 'static', 'app.js'), 'utf8');
// Code sans les commentaires (ils citent les constructions interdites pour l'auditeur).
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

test('app.js : mode strict, une seule portée (fonction immédiatement appelée)', () => {
  assert.match(CODE, /^\s*'use strict';\s*\n\s*\n?\(\(\) => \{/m);
  assert.ok(CODE.trimEnd().endsWith('})();'));
});

test('app.js : aucune insertion de HTML ni évaluation de code', () => {
  for (const forbidden of [/innerHTML/, /outerHTML/, /insertAdjacentHTML/, /document\.write/, /\beval\s*\(/, /\bFunction\s*\(/, /new\s+Function/,
    /createContextualFragment/, /DOMParser/, /setTimeout\(\s*['"`]/, /setInterval/, /srcdoc/, /javascript:/i, /\.on[a-z]+\s*=/, /setAttribute\(\s*['"]on/i,
    /setAttribute\(\s*['"]style/i, /\.style\b/, /\bimport\s*\(/]) {
    assert.doesNotMatch(CODE, forbidden, String(forbidden));
  }
  // Le contrôle détecte bien une construction interdite.
  assert.match('x.innerHTML = y', /innerHTML/);
});

test('app.js : aucun autre site, aucun stockage local ; un seul point d\'accès, sur ce serveur', () => {
  // Seule adresse absolue : l'espace de noms SVG (identifiant, jamais chargé).
  assert.deepEqual(CODE.match(/https?:\/\/[^'"`\s]*/g), ['http://www.w3.org/2000/svg']);
  for (const forbidden of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/, /XMLHttpRequest/, /WebSocket/,
    /sendBeacon/, /postMessage/, /window\.open/, /clipboard\.read/]) {
    assert.doesNotMatch(CODE, forbidden, String(forbidden));
  }
  // Presse-papiers : seulement l'écriture de la clé affichée (bouton « Copier la clé », étape U2),
  // jamais de lecture.
  assert.deepEqual(CODE.match(/navigator\.clipboard\.[a-zA-Z]+/g), ['navigator.clipboard.writeText']);
  assert.match(CODE, /navigator\.clipboard\.writeText\(keyBlock\.textContent\.trim\(\)\)/);
  // Deux lectures : la recherche (U2) et la liste des puces inconnues après un événement du direct (U4).
  assert.equal((CODE.match(/\bfetch\(/g) ?? []).length, 2);
  assert.match(CODE, /fetch\(`\$\{API\}\?\$\{params\}`/);
  assert.match(CODE, /const API = '\/api\/recherche';/);
  assert.match(CODE, /fetch\(`\$\{CHIPS_API\}\?\$\{new URLSearchParams\(/);
  assert.match(CODE, /const CHIPS_API = '\/api\/puces-inconnues';/);
  // Direct (U4) : un seul flux EventSource, vers /api/direct sur ce serveur.
  assert.equal((CODE.match(/new EventSource\(/g) ?? []).length, 1);
  assert.match(CODE, /new EventSource\(lastId === null \? DIRECT_API : `\$\{DIRECT_API\}\?\$\{new URLSearchParams\(\{ depuis: lastId \}\)\}`\)/);
  assert.match(CODE, /const DIRECT_API = '\/api\/direct';/);
  // Adresses construites : chemins fixes du site uniquement.
  // `${base}/…` : adresse du formulaire d'association, vérifiée par ASSOCIATE_PATH (chemin fixe /chips/<UID>/associate).
  for (const [, url] of CODE.matchAll(/\.href = (`[^`]*`|'[^']*')/g)) assert.match(url, /^(?:[`']\/(?!\/)|`\$\{base\}\/)/, url);
  assert.match(CODE, /ASSOCIATE_PATH\.test\(associateBase\)/);
  for (const [, url] of CODE.matchAll(/location\.assign\((`[^`]*`)/g)) assert.match(url, /^`\/(?!\/)/, url);
});

test('app.js : accessibilité de la palette (combobox, listbox, activedescendant, zone annoncée, dialog modal)', () => {
  for (const needle of ["'role', 'combobox'", "'role', 'listbox'", "'role', 'option'", 'aria-activedescendant', "'aria-expanded'",
    "'aria-live', 'polite'", 'showModal()', "'aria-selected'", 'AbortController', 'aria-keyshortcuts']) {
    assert.ok(CODE.includes(needle), needle);
  }
});
