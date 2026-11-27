// Design system (étape U1, direction B, D-017) :
// - aucune couleur codée en dur hors des blocs de variables ;
// - contrastes WCAG AA des couples principaux, thème clair et thème sombre ;
// - focus clavier visible, rubrique courante signalée autrement que par la couleur, liens
//   soulignés, animations coupées si l'utilisateur les réduit ;
// - polices et feuilles de style servies localement, en liste blanche, avec les bons en-têtes ;
// - gabarit : lien « Aller au contenu », sprite d'icônes conforme à la CSP, raccourci Ctrl K
//   annoncé seulement sur les pages qui chargent le script qui le met en œuvre (étape U2).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession } from '../server/sessions.js';
import { ICON_NAMES, icon, spriteFor } from '../server/icones.js';
import { html } from '../server/html.js';
import { makeTestCerts } from './tls-fixture.js';

const STATIC = join(import.meta.dirname, '..', 'web', 'static');
const CSS = readFileSync(join(STATIC, 'style.css'), 'utf8');
const FONTS_CSS = readFileSync(join(STATIC, 'fonts.css'), 'utf8');
const withoutComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// ---------------------------------------------------------------- couleurs

// Blocs « :root { ... } » (thème clair, puis thème sombre dans @media) : seuls endroits où une
// couleur peut être écrite.
const ROOT_BLOCK = /:root\s*\{[^}]*\}/g;
const NAMED_COLORS = ['white', 'black', 'red', 'green', 'blue', 'gray', 'grey', 'orange', 'yellow', 'purple', 'pink', 'silver',
  'navy', 'teal', 'maroon', 'olive', 'lime', 'aqua', 'fuchsia', 'brown', 'beige', 'ivory', 'gold', 'coral', 'salmon', 'tomato',
  'crimson', 'indigo', 'violet', 'khaki', 'turquoise', 'tan', 'wheat', 'snow', 'linen'];

function hardCodedColors(css) {
  const outside = withoutComments(css).replace(ROOT_BLOCK, '');
  const found = [];
  for (const m of outside.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) found.push(m[0]);
  for (const m of outside.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi)) found.push(m[0]);
  // Mots-clés de couleur en valeur de propriété (après « : » ou une virgule / un espace dans une valeur).
  for (const decl of outside.matchAll(/:\s*([^;{}]+);/g)) {
    for (const word of decl[1].toLowerCase().split(/[^a-z-]+/)) if (NAMED_COLORS.includes(word)) found.push(word);
  }
  return found;
}

test('aucune couleur codée en dur hors des blocs de variables (style.css, fonts.css)', () => {
  assert.deepEqual(hardCodedColors(CSS), []);
  assert.deepEqual(hardCodedColors(FONTS_CSS), []);
  // Le contrôle détecte bien une couleur glissée hors des variables.
  assert.deepEqual(hardCodedColors(':root { --a: #fff; } .x { color: #123456; background: rgb(1, 2, 3); border-color: red; }'), ['#123456', 'rgb(', 'red']);
});

// ---------------------------------------------------------------- contrastes

/** Variables de couleur d'un bloc :root (valeurs hexadécimales). */
function variables(block) {
  const vars = {};
  for (const [, name, value] of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)) vars[name] = value;
  return vars;
}
const blocks = withoutComments(CSS).match(ROOT_BLOCK);
const LIGHT = variables(blocks[0]);
const DARK = { ...LIGHT, ...variables(blocks[1]) };

// Luminance relative et rapport de contraste (WCAG 2.x).
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// [premier plan, fond, seuil] : 4,5:1 pour du texte, 3:1 pour un contour ou un repère porteur
// de sens (WCAG 1.4.11).
const PAIRS = [
  ['texte', 'fond', 4.5], ['texte', 'carte', 4.5], ['texte', 'zone', 4.5],
  ['texte-doux', 'fond', 4.5], ['texte-doux', 'carte', 4.5], ['texte-doux', 'zone', 4.5],
  ['accent', 'fond', 4.5], ['accent', 'carte', 4.5], // liens, bouton discret
  ['accent', 'accent-doux', 4.5], // pastille « actif », badge, survol du bouton discret
  ['sur-accent', 'accent', 4.5], ['sur-accent', 'accent-fort', 4.5], // bouton principal, survol
  ['attention-texte', 'fond', 4.5], ['attention-texte', 'carte', 4.5], ['attention-texte', 'attention-doux', 4.5],
  ['danger', 'fond', 4.5], ['danger', 'carte', 4.5], ['danger', 'danger-doux', 4.5], // lien Supprimer, erreurs
  ['sur-danger', 'danger', 4.5], ['sur-danger', 'danger-fort', 4.5], // bouton rouge, survol
  ['texte', 'accent-doux', 4.5], ['texte', 'attention-doux', 4.5], ['texte', 'danger-doux', 4.5], // messages, panneaux
  ['texte-doux', 'attention-doux', 4.5], ['texte-doux', 'danger-doux', 4.5],
  ['bordure-champ', 'carte', 3], ['bordure-champ', 'fond', 3], // contour des champs (audit : 2,47:1 avant U1)
  ['focus', 'fond', 3], ['focus', 'carte', 3], // anneau de focus
  ['danger', 'carte', 3], // contour d'un champ en erreur
];

for (const [theme, vars] of [['clair', LIGHT], ['sombre', DARK]]) {
  test(`contrastes WCAG AA, thème ${theme} : texte 4,5:1, contours et focus 3:1`, () => {
    const failures = [];
    for (const [fg, bg, min] of PAIRS) {
      assert.ok(vars[fg] && vars[bg], `variables --${fg} et --${bg} définies`);
      const ratio = contrast(vars[fg], vars[bg]);
      if (ratio < min) failures.push(`--${fg} sur --${bg} : ${ratio.toFixed(2)}:1 < ${min}:1`);
    }
    assert.deepEqual(failures, []);
  });
}

test('le calcul de contraste est juste (valeurs de référence WCAG)', () => {
  assert.equal(contrast('#000000', '#FFFFFF').toFixed(1), '21.0');
  assert.equal(contrast('#767676', '#FFFFFF').toFixed(2), '4.54');
});

// ---------------------------------------------------------------- accessibilité dans la feuille

const rule = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[}\\s,])${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(withoutComments(CSS))?.[1] ?? null;
};

test('focus clavier visible sur tout élément interactif ; champs avec anneau et halo', () => {
  assert.match(rule(':focus-visible'), /outline:\s*2px solid var\(--focus\)/);
  assert.match(CSS, /input:focus-visible,\s*textarea:focus-visible,\s*select:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  assert.match(CSS, /details\.aide-page > summary:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--focus\)/);
  // Un champ qui retire son propre anneau le reporte sur son conteneur (focus-within).
  assert.match(rule('.recherche:focus-within'), /border-color:\s*var\(--focus\)/);
  assert.match(rule('.recherche-barre:focus-within'), /border-color:\s*var\(--focus\)/);
});

test('rubrique courante : fond et graisse en plus de la couleur ; liens soulignés par défaut', () => {
  const current = rule('.nav a[aria-current]');
  assert.match(current, /background:\s*var\(--zone\)/);
  assert.match(current, /font-weight:\s*600/);
  assert.match(rule('a'), /text-decoration:\s*underline/);
});

test('lien « Aller au contenu » hors écran, visible au focus ; animations coupées en mouvement réduit', () => {
  assert.match(rule('.lien-evitement'), /top:\s*-100px/);
  assert.match(CSS, /\.lien-evitement:focus,\s*\.lien-evitement:focus-visible\s*\{\s*top:/);
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)\s*\{[^@]*animation:\s*none !important;[^@]*transition:\s*none !important;/);
});

test('feuilles de style sans import ni ressource externe ; url() seulement vers les polices de la liste blanche', () => {
  assert.doesNotMatch(CSS, /@import|url\(|https?:|\/\//i);
  assert.doesNotMatch(FONTS_CSS, /@import|https?:|\/\//i);
  const urls = [...FONTS_CSS.matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepEqual(urls, ['"/static/fonts/SpaceGrotesk-Variable.ttf"', '"/static/fonts/Inter-Variable.ttf"', '"/static/fonts/JetBrainsMono-Variable.ttf"']);
});

test('logo servi : SVG autonome sans script, sans gestionnaire d\'événement ni ressource externe (xmlns seul)', () => {
  const svg = readFileSync(join(STATIC, 'logo.svg'), 'utf8');
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" '));
  // La seule adresse est l'espace de noms SVG (identifiant, jamais chargé) ; url(#...) est interne.
  assert.deepEqual(svg.match(/https?:[^"]*/g), ['http://www.w3.org/2000/svg']);
  assert.doesNotMatch(svg, /<script|\son[a-z]+\s*=|href=|<image|<foreignObject|<style/i);
  for (const [, ref] of svg.matchAll(/url\(([^)]*)\)/g)) assert.match(ref, /^#[a-z-]+$/);
});

test('polices embarquées avec leur licence OFL', () => {
  for (const name of ['Inter', 'SpaceGrotesk', 'JetBrainsMono']) {
    assert.ok(existsSync(join(STATIC, 'fonts', `${name}-Variable.ttf`)), name);
    assert.match(readFileSync(join(STATIC, 'fonts', `OFL-${name}.txt`), 'utf8'), /SIL Open Font License, Version 1\.1/, name);
  }
});

// ---------------------------------------------------------------- icônes

test('sprite d\'icônes : masqué par une classe, sans attribut style ni xmlns ; nom inconnu refusé', () => {
  const all = String(spriteFor(html`${ICON_NAMES.map((name) => icon(name))}`));
  assert.ok(all.startsWith('<svg class="sprite" aria-hidden="true">\n<symbol id="i-'));
  assert.equal((all.match(/<symbol id="i-/g) ?? []).length, ICON_NAMES.length);
  assert.doesNotMatch(all, /\sstyle\s*=|xmlns|https?:|\/\/|<script|\son[a-z]+\s*=|&quot;|&lt;/i);
  assert.equal(String(icon('poste')), '<svg class="ic" aria-hidden="true"><use href="#i-poste"></use></svg>');
  assert.throws(() => icon('inconnue'), /icône inconnue/);
  assert.throws(() => icon('poste" onload="x'), /icône inconnue/);
});

test('sprite d\'une page : seulement les symboles utilisés ; un texte affiché ne peut pas en ajouter', () => {
  const page = html`${icon('poste')} ${'<use href="#i-objet"></use>'}`;
  const sprite = String(spriteFor(page));
  assert.deepEqual([...sprite.matchAll(/<symbol id="i-([a-z]+)"/g)].map((m) => m[1]), ['poste']);
  assert.equal(spriteFor(html`<p>rien</p>`), null);
});

// ---------------------------------------------------------------- serveur : fichiers statiques et gabarit

let dir, db, server, port, certs, token;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-design-'));
  certs = makeTestCerts(dir);
  db = openDb(join(dir, 'test.db'));
  const userId = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)')
    .run('claire.martin', DUMMY_HASH, '2026-11-26T08:00:00.000Z').lastInsertRowid);
  token = createSession(db, userId);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function send({ method = 'GET', path, session = null }) {
  return new Promise((resolve, reject) => {
    const headers = session ? { Cookie: `__Host-mt_session=${session}` } : {};
    const req = request({ host: '127.0.0.1', port, path, method, headers, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const STATIC_FILES = [
  ['/static/style.css', 'style.css', 'text/css; charset=utf-8', 'no-cache'],
  ['/static/fonts.css', 'fonts.css', 'text/css; charset=utf-8', 'no-cache'],
  ['/static/logo.svg', 'logo.svg', 'image/svg+xml', 'no-cache'],
  ['/static/app.js', 'app.js', 'text/javascript; charset=utf-8', 'no-cache'], // seul script (D-021)
  ['/static/fonts/Inter-Variable.ttf', 'fonts/Inter-Variable.ttf', 'font/ttf', 'max-age=604800'],
  ['/static/fonts/SpaceGrotesk-Variable.ttf', 'fonts/SpaceGrotesk-Variable.ttf', 'font/ttf', 'max-age=604800'],
  ['/static/fonts/JetBrainsMono-Variable.ttf', 'fonts/JetBrainsMono-Variable.ttf', 'font/ttf', 'max-age=604800'],
];

test('fichiers statiques de la liste blanche : contenu exact, type MIME, cache, en-têtes de sécurité, sans session', async () => {
  for (const [path, file, type, cache] of STATIC_FILES) {
    const res = await send({ path });
    assert.equal(res.status, 200, path);
    assert.equal(res.headers['content-type'], type, path);
    assert.equal(res.headers['cache-control'], cache, path);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
    assert.match(res.headers['content-security-policy'], /^default-src 'self'/, path);
    assert.ok(res.body.equals(readFileSync(join(STATIC, file))), path);
  }
});

test('hors liste blanche : 404, sans accès au disque par l\'URL (licences, variantes de casse, traversées)', async () => {
  for (const path of ['/static/fonts/', '/static/fonts/OFL-Inter.txt', '/static/fonts/inter-variable.ttf', '/static/fonts/Inter-Variable.TTF',
    '/static/fonts/../style.css', '/static/fonts/%2e%2e/style.css', '/static/fonts//Inter-Variable.ttf', '/static/fonts/Inter-Variable.ttf/',
    '/static/icones.svg', '/static/fonts.css/', '/fonts/Inter-Variable.ttf', '/static/fonts/Inter-Variable.ttf%00']) {
    assert.equal((await send({ path })).status, 404, path);
  }
  const post = await send({ method: 'POST', path: '/static/fonts/Inter-Variable.ttf' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET');
});

test('gabarit : « Aller au contenu » vers <main id="contenu">, polices et style locaux, sprite ; script et Ctrl K seulement dans l\'application', async () => {
  for (const [path, session] of [['/', token], ['/stations', token], ['/login', null], ['/inconnu', token]]) {
    const html = (await send({ path, session })).body.toString('utf8');
    assert.ok(html.includes('<a class="lien-evitement" href="#contenu">Aller au contenu</a>'), path);
    assert.match(html, /<main id="contenu"/, path);
    assert.ok(html.includes('<link rel="stylesheet" href="/static/fonts.css">\n<link rel="stylesheet" href="/static/style.css">'), path);
    // Sprite en tête de page, avec au moins le logo ; chaque icône utilisée y a son symbole.
    if (html.includes('<use href="#i-')) assert.match(html, /<body class="[a-z-]+">\n<svg class="sprite" aria-hidden="true">\n<symbol id="i-/, path);
    // Logo officiel : favicon (icône de la fenêtre) et marque intégrée au bandeau ou à la carte.
    assert.ok(html.includes('<link rel="icon" href="/static/logo.svg" type="image/svg+xml">'), path);
    assert.ok(html.includes('<svg class="logo-image" viewBox="0 0 900 900" aria-hidden="true">'), path);
    for (const [, name] of html.matchAll(/<use href="#i-([a-z]+)">/g)) assert.ok(html.includes(`<symbol id="i-${name}" `), `${path} : ${name}`);
    // Script de l'application (D-021) : chargé une fois, dans <head>, par les pages connectées
    // seulement ; aucune autre balise <script>. L'indice Ctrl K n'apparaît qu'avec lui (et la
    // feuille de style ne l'affiche que si le script est actif : classe « js »).
    // Pages d'erreur (404) et de connexion : carte centrée, sans script ni raccourci.
    const app = path === '/' || path === '/stations';
    const scripts = html.match(/<script[^>]*>/g) ?? [];
    assert.deepEqual(scripts, app ? ['<script src="/static/app.js" defer>'] : [], path);
    if (app) assert.ok(html.includes('<link rel="icon" href="/static/logo.svg" type="image/svg+xml">\n<script src="/static/app.js" defer></script>\n</head>'), path);
    if (!app) assert.doesNotMatch(html, /<kbd|Ctrl|aria-keyshortcuts/i, path);
  }
  // Indice dans la recherche compacte de la barre (absente de l'inventaire, qui a la sienne).
  const stations = (await send({ path: '/stations', session: token })).body.toString('utf8');
  assert.ok(stations.includes('<kbd class="raccourci" aria-hidden="true"><kbd>Ctrl</kbd><kbd>K</kbd></kbd>\n</form>'));
  assert.match(rule('.recherche-barre .raccourci'), /display:\s*none/);
  assert.match(rule('.js .recherche-barre .raccourci'), /display:\s*inline-flex/);
});

test('bandeau : rubrique courante en aria-current="page" sur la liste, "true" sur une sous-page ; recherche compacte vers /?q=', async () => {
  const list = (await send({ path: '/stations', session: token })).body.toString('utf8');
  assert.ok(list.includes('<li><a href="/stations" aria-current="page">Postes</a></li>'));
  assert.ok(list.includes('<li><a href="/">Inventaire</a></li>'));
  assert.ok(list.includes('<form class="recherche-barre" method="get" action="/" role="search">'));
  const sub = (await send({ path: '/stations/new', session: token })).body.toString('utf8');
  assert.ok(sub.includes('<li><a href="/stations" aria-current="true">Postes</a></li>'));
  assert.equal((sub.match(/aria-current=/g) ?? []).length, 1);
  // L'inventaire a sa propre recherche : pas de recherche compacte dans le bandeau.
  const home = (await send({ path: '/', session: token })).body.toString('utf8');
  assert.ok(!home.includes('recherche-barre'));
  assert.ok(home.includes('<li><a href="/" aria-current="page">Inventaire</a></li>'));
});
