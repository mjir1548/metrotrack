// Aucun caractère bidirectionnel ni invisible littéral dans le code (« Trojan Source »,
// CVE-2021-42574) : ils peuvent faire lire à un auditeur autre chose que ce qui s'exécute.
// Là où ils sont nécessaires (filtre de la recherche, tests), ils s'écrivent en échappement
// \uXXXX. Les octets cherchés sont donnés en valeurs numériques : ce fichier n'en contient aucun.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

// Encodages UTF-8 : U+200B à U+200F (espaces de largeur nulle, marques LRM/RLM), U+202A à
// U+202E (enchâssements et forçages bidi), U+2066 à U+2069 (isolats bidi), U+FEFF (BOM).
const FORBIDDEN = [
  ...[0x8B, 0x8C, 0x8D, 0x8E, 0x8F].map((b) => [0xE2, 0x80, b]),
  ...[0xAA, 0xAB, 0xAC, 0xAD, 0xAE].map((b) => [0xE2, 0x80, b]),
  ...[0xA6, 0xA7, 0xA8, 0xA9].map((b) => [0xE2, 0x81, b]),
  [0xEF, 0xBB, 0xBF],
].map((bytes) => Buffer.from(bytes));

function filesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(js|mjs|sql|css|html)$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

test('aucun caractère bidi ni invisible littéral dans server/, web/ et test/', () => {
  const files = ['server', 'web', 'test'].flatMap((d) => filesUnder(join(ROOT, d)));
  assert.ok(files.length > 20, `${files.length} fichiers`);
  const found = [];
  for (const file of files) {
    const content = readFileSync(file);
    for (const bytes of FORBIDDEN) {
      const at = content.indexOf(bytes);
      if (at >= 0) found.push(`${relative(ROOT, file)} : octets ${bytes.toString('hex')} à la position ${at}`);
    }
  }
  assert.deepEqual(found, []);
});

test('le contrôle détecte bien un caractère bidi littéral', () => {
  const sample = Buffer.concat([Buffer.from('a'), FORBIDDEN[9], Buffer.from('b')]); // U+202E
  assert.ok(FORBIDDEN.some((bytes) => sample.includes(bytes)));
});
