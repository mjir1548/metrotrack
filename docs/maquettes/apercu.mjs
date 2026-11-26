// Petit serveur statique local pour prévisualiser docs/maquettes (127.0.0.1 uniquement).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage : node docs/maquettes/apercu.mjs   puis ouvrir http://127.0.0.1:8790/
const root = resolve(process.argv[2] || dirname(fileURLToPath(import.meta.url)));
const port = Number(process.argv[3] || 8790);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

createServer(async (req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); }
  catch { res.writeHead(400).end(); return; }
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  // Refuse tout fichier hors du dossier des maquettes (traversée de chemin).
  const rel = relative(root, file);
  if (rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }).end(body);
  } catch { res.writeHead(404).end('introuvable'); }
}).listen(port, '127.0.0.1', () => console.log(`maquettes sur http://127.0.0.1:${port}/`));
