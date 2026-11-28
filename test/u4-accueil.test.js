// Étape U4 : écran d'accueil. Mouvements (server/accueil.js : un rescan au même poste n'est pas un
// mouvement, corrections, lecteur non affecté, ordre, limite), lecteurs silencieux (seuil 24 h),
// puces à traiter (aperçu et total), page / (contenus, liens, états vides, salutation),
// compatibilité /?q= → /inventaire, navigation.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { openDb } from '../server/db.js';
import { createFrameServer } from '../server/http.js';
import { DUMMY_HASH } from '../server/password.js';
import { createSession, csrfTokenFor } from '../server/sessions.js';
import { correctLocation, createItem } from '../server/items.js';
import { unknownChipsOverview, unknownChipsCount, createChipsCounter } from '../server/chips.js';
import { recentMovements, readersHealth, homeData, HOME_MOVEMENTS, HOME_VISIBLE_MOVEMENTS, SILENT_READER_MS } from '../server/accueil.js';
import { greetingName, silenceLength, homePage } from '../server/views.js';
import { AIDE } from '../server/aide.js';
import { makeTestCerts } from './tls-fixture.js';

let dir, certs, server, port;
const KEY = Buffer.alloc(32, 0x44);
const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60_000).toISOString();

function makeDb(name) {
  const db = openDb(join(dir, `${name}.db`));
  const user = Number(db.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)').run('claire.martin', DUMMY_HASH, ago(0)).lastInsertRowid);
  return { db, user };
}

// Base principale : postes A, B, C ; lecteur 1 (A), 2 (B), 3 (C, jamais de scan), 4 (C, scan
// il y a 3 jours), 5 (non affecté), 6 (désactivé, jamais de scan : ignoré).
let db, alice, token;
let counter = 0;
const scan = (readerId, stationId, uid, at) => db.prepare('INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (?, ?, ?, ?, ?)').run(readerId, stationId, uid, ++counter, at);
const newItem = (name, uid) => {
  const id = createItem(db, alice, { name, notes: '', properties: [] }, ago(10_000));
  if (uid) db.prepare('UPDATE items SET uid_nfc = ? WHERE id = ?').run(uid, id);
  return id;
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'metrotrack-u4a-'));
  certs = makeTestCerts(dir);
  ({ db, user: alice } = makeDb('main'));
  for (const [id, name] of [[1, 'Poste A'], [2, 'Poste B'], [3, 'Atelier']]) db.prepare('INSERT INTO stations (id, name, created_at) VALUES (?, ?, ?)').run(id, name, ago(10_000));
  for (const [id, station, active] of [[1, 1, 1], [2, 2, 1], [3, 3, 1], [4, 3, 1], [5, null, 1], [6, 3, 0]]) {
    db.prepare('INSERT INTO readers (id, station_id, aead_key, active, created_at) VALUES (?, ?, ?, ?, ?)').run(id, station, KEY, active, ago(10_000));
  }
  db.prepare("UPDATE readers SET name = 'Boîtier établi' WHERE id = 4").run();
  token = createSession(db, alice);
  server = createFrameServer(db, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve();
  }));
});

after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function send(path, cookie = `__Host-mt_session=${token}`) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: cookie ? { Cookie: cookie } : {}, ca: certs.ca, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const movesOf = (list) => list.map((m) => `${m.type}:${m.item_name}@${m.station_name ?? 'non affecté'}`);

// ---------------------------------------------------------------- unités

test('salutation : prénom tiré de l\'identifiant, rien pour un identifiant technique ou sans lettres', () => {
  assert.equal(greetingName('claire.martin'), 'Claire');
  assert.equal(greetingName('CLAIRE'), 'Claire');
  assert.equal(greetingName('jean-pierre'), 'Jean');
  assert.equal(greetingName('alice_2'), 'Alice');
  for (const none of ['admin', 'demo', 'Test', 'root.x', 'a', 'j2', '42', '_x', 'metrotrack']) assert.equal(greetingName(none), null, none);
});

test('durée de silence : en heures jusqu\'à 48 h, puis en jours', () => {
  assert.equal(silenceLength(25 * 3_600_000), '25 h');
  assert.equal(silenceLength(47.9 * 3_600_000), '47 h');
  assert.equal(silenceLength(3 * 24 * 3_600_000 + 5), '3 jours');
});

test('mouvements : un rescan au même poste n\'en est pas un ; arrivée ailleurs, correction, lecteur non affecté ; du plus récent au plus ancien', () => {
  const multi = newItem('Multimètre', '0A000001');
  newItem('Oscilloscope', '0A000002');
  scan(1, 1, '0A000001', ago(100)); // arrivée A
  scan(1, 1, '0A000001', ago(90)); //  rescan A : pas un mouvement
  scan(2, 2, '0A000001', ago(80)); //  arrivée B
  scan(2, 2, '0A000002', ago(70)); //  arrivée B (oscillo)
  correctLocation(db, alice, multi, 3, ago(60)); // corrigé vers Atelier
  correctLocation(db, alice, multi, 3, ago(55)); // même lieu : pas un mouvement
  scan(5, null, '0A000002', ago(50)); // lecteur non affecté : lieu à part
  scan(2, 2, '0A000001', ago(40)); //  retour B après la correction : mouvement
  scan(2, 2, 'FF000001', ago(30)); //  puce inconnue : pas dans les mouvements
  assert.deepEqual(movesOf(recentMovements(db)), [
    'scan:Multimètre@Poste B', 'scan:Oscilloscope@non affecté', 'correction:Multimètre@Atelier',
    'scan:Oscilloscope@Poste B', 'scan:Multimètre@Poste B', 'scan:Multimètre@Poste A',
  ]);
  const correction = recentMovements(db).find((m) => m.type === 'correction');
  assert.equal(correction.username, 'claire.martin');
  assert.equal(correction.reader_id, null);
  assert.equal(recentMovements(db).find((m) => m.station_id === null).reader_id, 5);
  assert.equal(recentMovements(db, 2).length, 2);
});

test('mouvements : au plus HOME_MOVEMENTS', () => {
  const id = newItem('Navette', '0A0000AA');
  for (let i = 0; i < 25; i++) scan(1 + (i % 2), 1 + (i % 2), '0A0000AA', ago(30 - i));
  const list = recentMovements(db);
  assert.equal(list.length, HOME_MOVEMENTS);
  assert.ok(list.every((m) => m.item_id === id));
  assert.ok(list.every((m, i) => i === 0 || list[i - 1].at >= m.at));
});

test('lecteurs : silencieux (jamais, ou plus de 24 h), ceux qui fonctionnent, désactivé ignoré', () => {
  scan(4, 3, 'FF000002', ago(3 * 24 * 60));
  const health = readersHealth(db, NOW);
  assert.equal(health.total, 5);
  assert.deepEqual(health.silent.map((r) => r.id), [3, 4]); // jamais, puis le plus ancien silence
  assert.equal(health.working, 3);
  assert.ok(health.lastScanAt > ago(25));
  // Seuil : 24 h pile = fonctionne encore, au-delà = silencieux.
  const last1 = Date.parse(db.prepare('SELECT max(received_at) AS m FROM scans WHERE reader_id = 1').get().m);
  assert.ok(!readersHealth(db, last1 + SILENT_READER_MS).silent.some((r) => r.id === 1));
  assert.ok(readersHealth(db, last1 + SILENT_READER_MS + 1).silent.some((r) => r.id === 1));
});

test('puces à traiter : les plus récentes d\'abord, total exact', () => {
  const { chips, total } = unknownChipsOverview(db, 3);
  assert.equal(total, 2);
  assert.deepEqual(chips.map((c) => c.uid), ['FF000001', 'FF000002']);
  assert.equal(unknownChipsOverview(db, 1).chips.length, 1);
  assert.equal(unknownChipsOverview(db, 1).total, 2);
});

// ---------------------------------------------------------------- page

test('accueil : recherche, À traiter au-dessus des mouvements, 5 mouvements + « Voir plus », lecteurs silencieux, aide', async () => {
  const res = await send('/');
  assert.equal(res.status, 200);
  const { body } = res;
  assert.match(body, /<title>Accueil · MetroTrack<\/title>/);
  assert.ok(body.includes('<li><a href="/" aria-current="page">Accueil</a></li>'));
  assert.ok(body.includes('<li><a href="/inventaire">Inventaire</a></li>'));
  assert.ok(body.indexOf('>Accueil</a>') < body.indexOf('>Inventaire</a>'));
  assert.ok(body.includes('<p class="heros-surtitre">Bonjour Claire · '));
  assert.ok(body.includes('<h1 id="titre-recherche" class="heros-titre">Où est…&nbsp;?</h1>'));
  assert.ok(!body.includes('id="demarrage"'), 'des objets ont été localisés : pas de démarrage guidé');
  assert.ok(body.includes('<form class="recherche recherche--heros" method="get" action="/inventaire" role="search">'));
  assert.match(body, /placeholder="Un objet, un n° de série… parmi \d+ objets"/);
  assert.ok(!body.includes('recherche-barre'), 'pas de recherche compacte : la grande recherche suffit');
  // Avatar : « CM » pour claire.martin.
  assert.ok(body.includes('<span class="avatar" aria-hidden="true">CM</span>'));
  // Compteur de la barre.
  assert.ok(body.includes('<a href="/chips">Puces inconnues <span class="nombre-pastille nombre-pastille--nav" id="nav-puces"><span data-nombre>2</span><span class="visuellement-cache"> à traiter</span></span></a>'));
  // À traiter (non vide) AU-DESSUS des mouvements, grille des lecteurs seule.
  assert.ok(body.indexOf('id="traiter"') < body.indexOf('id="mouvements-section"'));
  assert.ok(body.includes('class="grille-2 grille-2--seule"'));
  // Mouvements : 5 visibles (zone annoncée), la suite derrière « Voir plus ».
  const shown = /<ol class="mouvements" id="mouvements" aria-live="polite">([\s\S]*?)<\/ol>/.exec(body)[1];
  const more = /<ol class="mouvements" id="mouvements-suite">([\s\S]*?)<\/ol>/.exec(body)[1];
  assert.equal((shown.match(/<li class="mouvement/g) ?? []).length, HOME_VISIBLE_MOVEMENTS);
  assert.equal((more.match(/<li class="mouvement/g) ?? []).length, HOME_MOVEMENTS - HOME_VISIBLE_MOVEMENTS);
  assert.ok(body.includes('<details class="mouvements-plus" id="mouvements-plus">\n<summary>Voir plus</summary>'));
  assert.match(shown, /<a href="\/items\/\d+">Navette<\/a>/);
  assert.match(shown, /<a class="lien-simple lien-discret" href="\/stations\/[12]">Poste [AB]<\/a>/);
  assert.match(shown, /<time datetime="[^"]+" title="[^"]+" data-age>il y a \d+ min<\/time><small>aujourd&#39;hui à \d\d:\d\d<\/small>/);
  assert.ok(!shown.includes('Scanné'), 'un scan n\'a pas de mention répétée');
  // À traiter : « Nouvelle puce · Poste B », sans « au » collé au nom du poste.
  assert.ok(body.includes('href="/chips/FF000001/new"'));
  assert.ok(body.includes('href="/chips/FF000001/associate"'));
  assert.ok(body.includes('Nouvelle puce · <strong>Poste B</strong>'));
  assert.doesNotMatch(body, / au <strong>/);
  assert.ok(body.includes('<span class="nombre-pastille" id="puces-nombre">2</span>'));
  assert.ok(body.includes('<a href="/chips">Voir les 2 nouvelles puces'));
  // Lecteurs : orange avec icône ET texte, lien vers le lecteur.
  assert.ok(body.includes('<div class="alerte-lecteur" data-lecteur="3">\n<svg class="ic" aria-hidden="true"><use href="#i-silence"></use></svg>'));
  assert.ok(body.includes('<a href="/readers/3">Lecteur · Atelier</a> : aucun scan reçu pour l&#39;instant'));
  assert.ok(body.includes('<a href="/readers/4">Boîtier établi</a> : aucun scan depuis 3 jours'));
  assert.ok(body.includes('<p class="etat-ok-titre">3 lecteurs fonctionnent</p>'));
  assert.ok(!body.includes('data-lecteur="6"'), 'lecteur désactivé ignoré');
  // Indicateur du direct : zone annoncée, masquée sans script (app.js l'affiche).
  assert.ok(body.includes('<p class="direct-etat" id="direct-etat" role="status" hidden>'));
  assert.ok(body.includes(String(AIDE.accueil)));
  // Icônes des éléments ajoutés en direct présentes dans le sprite.
  for (const name of ['lecteur', 'main', 'poste', 'puce', 'ajouter', 'associer', 'valide', 'fermer', 'attention']) assert.ok(body.includes(`<symbol id="i-${name}"`), name);
  // Aucun script en ligne.
  assert.deepEqual(body.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi), ['<script src="/static/app.js" defer></script>']);
});

test('fiche : badge court « Scanné » (l\'heure est déjà dans « depuis »)', async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'Navette'").get().id;
  const sheet = (await send(`/items/${id}`)).body;
  assert.ok(sheet.includes('<span class="badge badge--ok"><svg class="ic" aria-hidden="true"><use href="#i-lecteur"></use></svg>Scanné</span>'));
});

test('compatibilité : /?q=… mène aux résultats sur /inventaire (303, saisie encodée) ; sans session → connexion', async () => {
  const res = await send('/?q=multi%20m%C3%A8tre');
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, '/inventaire?q=multi+m%C3%A8tre');
  assert.equal((await send('/?q=')).headers.location, '/inventaire');
  assert.equal((await send('/?q=https%3A%2F%2Fevil.example')).headers.location, '/inventaire?q=https%3A%2F%2Fevil.example');
  assert.equal((await send('/', null)).headers.location, '/login');
  assert.equal((await send('/?q=x', null)).headers.location, '/login');
  const list = await send('/inventaire?q=multi');
  assert.equal(list.status, 200);
  assert.ok(list.body.includes('<li><a href="/inventaire" aria-current="page">Inventaire</a></li>'));
  assert.ok(list.body.includes('pour «&nbsp;multi&nbsp;»'));
});

test('démarrage guidé : base vide → liste cochée (h1), sans recherche ; poste créé → coché ; puce reçue → « Créer sa fiche » ; objet localisé → fini', () => {
  const user = { username: 'demo', csrf: 'x' };
  const fresh = makeDb('vide').db;
  const render = () => String(homePage(user, { ...homeData(fresh, NOW), now: NOW }));
  let page = render();
  assert.ok(page.includes('<h1 id="titre-demarrage">Bienvenue&nbsp;! Préparons MetroTrack</h1>'));
  assert.ok(!page.includes('recherche--heros'), 'base vide : rien à chercher');
  assert.equal((page.match(/<li class="etape"/g) ?? []).length, 3, 'trois étapes à faire');
  assert.ok(page.includes('<a class="bouton bouton-petit" href="/stations/new">'));
  assert.ok(page.includes('href="/readers/new"'));
  assert.ok(page.includes('On attend votre premier scan…'));
  assert.ok(page.includes('<a href="/items/new">Créez une fiche</a> : un nom suffit.'));
  assert.ok(!page.includes('Bonjour'), 'pas de « Bonjour Demo »');
  // Un poste : étape cochée ; la recherche et les sections apparaissent, le démarrage reste en tête.
  fresh.prepare('INSERT INTO stations (id, name, created_at) VALUES (1, ?, ?)').run('Réception', ago(0));
  page = render();
  assert.ok(page.includes('<li class="etape etape--faite">'));
  assert.ok(page.includes('<span class="visuellement-cache">Fait : </span>'));
  assert.ok(page.includes('1 poste créé'));
  assert.ok(page.indexOf('id="demarrage"') < page.indexOf('recherche--heros'));
  assert.ok(page.includes('<h2 id="titre-recherche" class="heros-titre">'), 'un seul h1 : celui du démarrage');
  assert.equal((page.match(/<h1/g) ?? []).length, 1);
  assert.ok(page.includes('Aucun mouvement pour l\'instant. Scannez un objet à un poste.'));
  assert.ok(page.includes('<ol class="mouvements" id="mouvements" aria-live="polite" hidden>'));
  assert.ok(page.includes('<details class="mouvements-plus" id="mouvements-plus" hidden>'));
  assert.ok(page.includes('<p class="etat-ok-titre">Rien à traiter</p>'));
  assert.ok(page.includes('<span class="nombre-pastille" id="puces-nombre" hidden>0</span>'));
  assert.ok(page.includes('Ajoutez un lecteur') && page.includes('<a class="bouton bouton-petit" href="/readers/new">'));
  assert.ok(page.includes('placeholder="Un objet, un n° de série…"'));
  // Lecteur et puce inconnue reçue : étapes cochées, « Créer sa fiche » pour cette puce.
  fresh.prepare('INSERT INTO readers (id, station_id, aead_key, created_at) VALUES (1, 1, ?, ?)').run(KEY, ago(0));
  fresh.prepare("INSERT INTO scans (reader_id, station_id, uid_nfc, counter, received_at) VALUES (1, 1, 'ABCDEF01', 1, ?)").run(ago(1));
  page = render();
  assert.equal((page.match(/<li class="etape etape--faite"/g) ?? []).length, 3);
  assert.ok(page.includes('Nouvelle puce · <strong>Réception</strong>'));
  assert.ok(page.includes('<a class="bouton bouton-petit" href="/chips/ABCDEF01/new">'));
  assert.ok(page.includes('Créer sa fiche'));
  // La puce reçoit une fiche : un objet est localisé, le démarrage disparaît.
  fresh.prepare("INSERT INTO items (uid_nfc, name, created_at, updated_at) VALUES ('ABCDEF01', 'Objet', ?, ?)").run(ago(0), ago(0));
  page = render();
  assert.ok(!page.includes('id="demarrage"'));
  assert.ok(page.includes('<h1 id="titre-recherche" class="heros-titre">'));
  fresh.close();
});

test('démarrage guidé : après « Créer un poste », retour à l\'accueil (?ok=poste) ; la page de clé ramène à l\'accueil ; hors démarrage, comportement habituel', async () => {
  const { db: fresh, user } = makeDb('guide');
  const tok = createSession(fresh, user);
  const srv = createFrameServer(fresh, { tls: { cert: certs.cert, key: certs.key }, log: () => {}, loginFailureDelayMs: 0 });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const p = srv.address().port;
  const post = (path, fields) => new Promise((resolve, reject) => {
    const body = new URLSearchParams({ ...fields, csrf: csrfTokenFor(tok) }).toString();
    const req = request({
      host: '127.0.0.1', port: p, path, method: 'POST', ca: certs.ca, agent: false,
      headers: { Cookie: `__Host-mt_session=${tok}`, Origin: `https://127.0.0.1:${p}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    const created = await post('/stations/new', { name: 'Réception', description: '' });
    assert.equal(created.status, 303);
    assert.equal(created.headers.location, '/?ok=poste');
    const home = String(homePage({ username: 'claire.martin', csrf: 'x' }, { ...homeData(fresh, NOW), now: NOW, notice: 'poste' }));
    assert.ok(home.includes('<p class="succes" role="status">Poste créé. Étape suivante : ajoutez un lecteur.</p>'));
    const reader = await post('/readers/new', { name: '', station: '1' });
    assert.equal(reader.status, 200, 'la page de clé reste affichée');
    assert.match(reader.body, /<pre class="cle">[0-9a-f]{64}<\/pre>/);
    assert.ok(reader.body.includes('<a class="bouton" href="/">Continuer : retour à l\'accueil</a>'));
    // Un objet localisé : fin du démarrage, retours habituels.
    fresh.prepare("INSERT INTO items (name, created_at, updated_at) VALUES ('Objet', ?, ?)").run(ago(0), ago(0));
    fresh.prepare('INSERT INTO location_corrections (item_id, station_id, user_id, created_at) VALUES (1, 1, ?, ?)').run(user, ago(0));
    const second = await post('/stations/new', { name: 'Magasin', description: '' });
    assert.match(second.headers.location, /^\/stations\/\d+\?ok=cree$/);
    const key = await post('/readers/new', { name: '', station: '' });
    assert.ok(key.body.includes('<a class="bouton" href="/readers">Retour aux lecteurs</a>'));
  } finally {
    srv.closeAllConnections();
    srv.close();
    fresh.close();
  }
});

test('nombre de la barre : absent à zéro, « 200+ » au-delà du plafond, mémorisé et recalculé après invalidation', () => {
  const user = (chips) => ({ username: 'claire.martin', csrf: 'x', chips });
  const page = (chips) => String(homePage(user(chips), { ...homeData(db, NOW), now: NOW }));
  assert.ok(page(0).includes('<a href="/chips">Puces inconnues</a>'), 'à zéro : rien (app.js l\'ajoute si une puce arrive)');
  assert.ok(page(201).includes('<span data-nombre>200+</span>'));
  assert.ok(page(200).includes('<span data-nombre>200</span>'));
  assert.equal(unknownChipsCount(db), 2);
  assert.equal(unknownChipsCount(db, 1), 2, 'plafonné à cap + 1');
  let t = 0;
  const counter = createChipsCounter(db, { now: () => t });
  assert.equal(counter.get(), 2);
  scan(1, 1, 'FF000003', ago(1));
  assert.equal(counter.get(), 2, 'mémorisé tant que rien ne l\'invalide');
  counter.invalidate();
  assert.equal(counter.get(), 2, 'au plus un calcul par seconde');
  t = 1000;
  assert.equal(counter.get(), 3);
  t = 40_000;
  scan(1, 1, 'FF000004', ago(1));
  assert.equal(counter.get(), 4, 'recalculé après la durée de vie, même sans invalidation');
});

test('navigation : « Accueil » en premier partout ; fil d\'Ariane et retours vers /inventaire ; suppression → /inventaire', async () => {
  const id = db.prepare("SELECT id FROM items WHERE name = 'Multimètre'").get().id;
  const sheet = (await send(`/items/${id}`)).body;
  assert.ok(sheet.includes('<li><a href="/">Accueil</a></li><li><a href="/inventaire" aria-current="true">Inventaire</a></li>'));
  assert.ok(sheet.includes('<nav class="fil" aria-label="Fil d\'Ariane">\n<a href="/inventaire">Inventaire</a>'));
  assert.ok(sheet.includes('<form class="recherche-barre" method="get" action="/inventaire" role="search">'));
  const stations = (await send('/stations')).body;
  assert.ok(stations.includes('<li><a href="/">Accueil</a></li>'));
  assert.equal((stations.match(/aria-current=/g) ?? []).length, 1);
  const missing = (await send('/items/99999')).body;
  assert.ok(missing.includes('href="/inventaire">Retour à l\'inventaire</a>'));
});
