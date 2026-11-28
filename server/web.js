// Interface web : connexion, déconnexion, inventaire (liste et fiche), édition des fiches
// (création, modification, suppression, correction de localisation), postes et lecteurs
// (étape 6), puces inconnues et association (étape 7), écran d'accueil et direct (étape U4),
// fichiers statiques (feuilles de style et polices, en liste blanche).
// HTML rendu côté serveur, sans ressource externe. Un seul fichier JavaScript local
// (web/static/app.js, D-021) améliore les pages (recherche Ctrl K, résultats pendant la frappe,
// via GET /api/recherche) ; chaque page reste utilisable sans lui.
//
// ÉCHAPPEMENT : toutes les pages sont produites par les gabarits de server/views.js, écrits
// avec html`...` (server/html.js), qui échappe automatiquement chaque valeur interpolée.
// sendHtml n'accepte qu'un fragment produit par ce gabarit : une chaîne construite à la main
// ne peut pas être envoyée par erreur.
// Le formulaire de connexion ne réaffiche jamais le mot de passe. L'identifiant tapé n'est
// réaffiché que dans un cas : jeton de connexion expiré (voir login), et seulement s'il
// respecte le format des identifiants.
//
// ERREURS : les refus de l'interface (404, 405, 400, 413, 403, et 500 via server/http.js)
// renvoient une petite page lisible au texte constant (views.js, errorPage, forbiddenPage),
// jamais un détail technique ni une donnée de la requête. Les réponses de POST /api/frames,
// elles, restent sans corps (contrat avec les boîtiers, docs/protocole.md §5, D-008) : elles
// ne passent pas par ce fichier.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { verifyPassword, DUMMY_HASH, USERNAME_FORMAT } from './password.js';
import {
  SESSION_COOKIE, createSession, findSession, deleteSession, csrfTokenFor, newToken, isTokenFormat, safeEqual,
} from './sessions.js';
import { isSafeHtml } from './html.js';
import { listItems, searchItems, getItem, parseItemId, parseUid, normalizeQuery } from './inventory.js';
import { itemTimeline, parseCursor, TIMELINE_ENTRIES, TIMELINE_PAGE_ENTRIES } from './timeline.js';
import {
  validateItemInput, createItem, updateItem, deleteItem, correctLocation, listStations, itemChanges, MAX_PROPERTIES,
  cleanLine, MAX_NAME_CHARS,
} from './items.js';
import {
  validateStationInput, createStation, updateStation, deleteStation, stationHistory, stationHasHistory, getStation,
  listStationSummaries, stationReaders, stationItems,
} from './stations.js';
import {
  createReader, assignReader, deactivateReader, replaceReader, renameReader, validateReaderName, listReaders, getReader, readerScans,
} from './readers.js';
import {
  listUnknownChips, getChip, chipPreviousOwner, chipPreviousOwners, createItemForChip, associateChip, detachChip, MAX_ASSOCIATE_RESULTS,
  MAX_OFFERED_CHIPS, MAX_UNKNOWN_CHIPS, unknownChipsOverview,
} from './chips.js';
import { homeData, isOnboarding, recentMovements } from './accueil.js';
import { itemEvent, parseEventId } from './direct.js';
import {
  loginPage as loginView, forbiddenPage, errorPage, inventoryPage, itemPage as itemView, itemNotFoundPage, BUSY_MESSAGE,
  LOGIN_EXPIRED_MESSAGE, SESSION_EXPIRED_MESSAGE,
  itemFormPage, deleteItemPage as deleteView, locationPage as locationView,
  stationsPage, stationPage as stationView, stationFormPage, deleteStationPage as deleteStationView, stationNotFoundPage,
  readersPage, readerPage as readerView, readerFormPage, readerStationPage, deactivateReaderPage as deactivateView,
  replaceReaderPage as replaceView, readerRenamePage, readerKeyPage, readerNotFoundPage, readerInactivePage, readerIdsExhaustedPage,
  chipsPage, associateSearchPage, associateConfirmPage, chipNotFoundPage, chipKnownPage, searchResult,
  itemHistoryPage, giveChipPage as giveChipView, detachChipPage as detachChipView, homePage as homeView, chipResult,
} from './views.js';

// Délai avant la réponse à un échec de connexion (ralentit les essais successifs ; la
// réponse est différée par setTimeout, le serveur n'est pas bloqué).
export const LOGIN_FAILURE_DELAY_MS = 1000;
const LOGIN_CSRF_COOKIE = '__Host-mt_login_csrf';
const LOGIN_CSRF_MAX_AGE_S = 600;
// Plafond du corps d'un formulaire : identifiant + mot de passe (≤ 1 Kio) + jeton tiennent
// largement. Au-delà, on cesse de lire (pas de consommation mémoire à la demande d'un client).
const MAX_FORM_BYTES = 4096;
// Plafond du corps des formulaires d'édition (fiche, suppression, localisation). Au-delà :
// 413 avec une page d'erreur au texte constant (« Formulaire trop long »), comme /login, et la
// lecture s'arrête.
// - Une fiche remplie au maximum en texte courant (nom 200, notes 10 000, 50 propriétés de
//   1 100 caractères ; accents et ponctuation encodés en %XX, 6 à 9 octets par caractère)
//   tient sous ce plafond.
// - LIMITE ACCEPTÉE : une fiche presque entièrement accentuée, en écriture non latine ou en
//   emoji peut le dépasser une fois encodée (jusqu'à 9 octets par unité UTF-16). Elle reçoit
//   alors un 413 et la saisie est perdue. C'est rare et n'ouvre aucune faille.
// - Mémoire par requête : le corps brut (au plus ce plafond), sa copie décodée en texte, puis
//   la page éventuellement réaffichée, elle-même bornée par MAX_FORM_ROWS. Soit quelques fois
//   le plafond par requête, et non un total garanti pour le serveur.
export const MAX_EDIT_FORM_BYTES = 256 * 1024;
// Lignes de propriété vides ajoutées au formulaire (affichage initial, « Ajouter des lignes »).
const BLANK_ROWS = 3;
// Nombre maximal de lignes de propriété (prop_key, comme prop_value) qu'un formulaire de
// l'application peut afficher, donc renvoyer : MAX_PROPERTIES lignes remplies + BLANK_ROWS
// lignes vides. Toutes les pages respectent ce total :
//   - modification : propriétés enregistrées (au plus MAX_PROPERTIES, validées) + 3 vides ;
//   - saisie refusée : lignes reçues non vides (≤ MAX_FORM_ROWS) + vides jusqu'au total ;
//   - « Ajouter des lignes » : 3 vides de plus, sans jamais dépasser le total.
// Au-delà, la requête ne vient pas de nos pages : 400 avec une page d'erreur au texte
// constant, sans réaffichage de la saisie (une page
// de 24 000 lignes serait sinon produite à partir d'un corps de 256 Kio).
export const MAX_FORM_ROWS = MAX_PROPERTIES + BLANK_ROWS;
// Valeur du bouton « Ajouter des lignes » : réaffiche le formulaire, sans rien enregistrer.
const ADD_ROWS_ACTION = 'lignes';
const GENERIC_LOGIN_ERROR = 'Identifiant ou mot de passe incorrect.';
// Messages de la page de connexion choisis par ?info= : la page reçoit seulement un code
// constant, le texte affiché est toujours l'un de ceux-ci (code inconnu : aucun message).
const LOGIN_INFO = { session: SESSION_EXPIRED_MESSAGE };
// Redirection d'un envoi de formulaire dont la session a expiré : la connexion l'explique.
const LOGIN_AFTER_EXPIRY = '/login?info=session';

/**
 * Cible de la redirection d'un envoi sans session valide : « session expirée » seulement si
 * la requête portait un cookie de session (non vide) devenu invalide ; sans aucun cookie
 * (jamais connecté, ou requête venue d'ailleurs : SameSite=Strict ne l'envoie pas), /login
 * sans message. Le cookie n'est que constaté présent, jamais lu ni journalisé.
 */
function loginAfterNoSession(req) {
  return readCookies(req).get(SESSION_COOKIE) ? LOGIN_AFTER_EXPIRY : '/login';
}
// Connexions (sockets) sur lesquelles un 503 « Connection: close » est déjà en file : Node
// les fermera après cette réponse. Références faibles : aucune fuite mémoire.
const closingConnections = new WeakSet();

// Fichiers statiques : LISTE BLANCHE de chemins exacts, lus UNE fois au démarrage et servis
// depuis la mémoire. Aucun chemin de fichier n'est dérivé de l'URL : une adresse absente de
// cette liste donne 404 (pas de traversée de répertoire possible, pas de listage).
// Type MIME fixé par fichier (le navigateur ne devine rien : X-Content-Type-Options nosniff).
// Cache : les polices ne changent pas (nouveau nom de fichier si elles changent un jour) et
// peuvent être gardées une semaine ; les feuilles de style sont revalidées à chaque page
// (no-cache), pour qu'une mise à jour du serveur soit vue tout de suite. Même règle pour
// app.js, le seul script (D-021) : le navigateur le revalide à chaque page.
// Polices : SIL Open Font License 1.1, licences dans web/static/fonts/OFL-*.txt.
const STATIC_DIR = join(import.meta.dirname, '..', 'web', 'static');
const CSS_TYPE = 'text/css; charset=utf-8';
const FONT_TYPE = 'font/ttf';
const STYLE_CACHE = 'no-cache';
const SCRIPT_TYPE = 'text/javascript; charset=utf-8';
const FONT_CACHE = 'max-age=604800';
const STATIC_FILES = new Map([
  ['/static/style.css', ['style.css', CSS_TYPE, STYLE_CACHE]],
  ['/static/fonts.css', ['fonts.css', CSS_TYPE, STYLE_CACHE]],
  ['/static/app.js', ['app.js', SCRIPT_TYPE, STYLE_CACHE]],
  // Logo (icône de la fenêtre et des onglets) : SVG autonome, sans script ni ressource externe.
  ['/static/logo.svg', ['logo.svg', 'image/svg+xml', STYLE_CACHE]],
  ['/static/fonts/Inter-Variable.ttf', ['fonts/Inter-Variable.ttf', FONT_TYPE, FONT_CACHE]],
  ['/static/fonts/SpaceGrotesk-Variable.ttf', ['fonts/SpaceGrotesk-Variable.ttf', FONT_TYPE, FONT_CACHE]],
  ['/static/fonts/JetBrainsMono-Variable.ttf', ['fonts/JetBrainsMono-Variable.ttf', FONT_TYPE, FONT_CACHE]],
].map(([path, [file, type, cache]]) => [path, { body: readFileSync(join(STATIC_DIR, file)), type, cache }]));

// En-têtes de sécurité sur toutes les réponses de l'interface web.
const SECURITY_HEADERS = {
  // Ressources uniquement depuis ce serveur ; aucun script ni style inline possible ;
  // formulaires uniquement vers ce serveur ; page non intégrable dans un cadre (clickjacking).
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // Le navigateur respecte le Content-Type annoncé (pas de « devinette » de type).
  'X-Content-Type-Options': 'nosniff',
  // « same-origin » et non « no-referrer » : avec no-referrer, les navigateurs envoient
  // « Origin: null » sur un POST de formulaire (spécification Fetch), ce qui ferait échouer la
  // vérification d'Origin ci-dessous. same-origin n'envoie aucun Referer vers un autre site.
  'Referrer-Policy': 'same-origin',
};

// Attributs des cookies : préfixe __Host- (imposé par le navigateur : Secure, Path=/, pas de
// Domain, donc ni un sous-domaine ni une page en clair ne peuvent le poser) ; HttpOnly
// (illisible par du script) ; SameSite=Strict (jamais envoyé sur une requête initiée par un
// autre site). Le cookie de session n'a pas de Max-Age : il disparaît à la fermeture du
// navigateur ; la durée de 8 h est imposée côté serveur.
const COOKIE_ATTRIBUTES = 'Path=/; Secure; HttpOnly; SameSite=Strict';
const sessionCookie = (token) => `${SESSION_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}`;
const loginCsrfCookie = (token) => `${LOGIN_CSRF_COOKIE}=${token}; ${COOKIE_ATTRIBUTES}; Max-Age=${LOGIN_CSRF_MAX_AGE_S}`;
const clearCookie = (name) => `${name}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;

// Table des routes : chemin exact → méthode → gestionnaire.
const ROUTES = {
  '/': { GET: home },
  '/inventaire': { GET: inventory },
  '/api/recherche': { GET: searchApi },
  '/api/direct': { GET: directApi },
  '/api/puces-inconnues': { GET: chipsApi },
  '/login': { GET: loginPage, POST: login },
  '/logout': { POST: logout },
  ...Object.fromEntries([...STATIC_FILES].map(([path, file]) => [path, { GET: (ctx, req, res) => sendStatic(res, file) }])),
  '/items/new': { GET: newItemPage, POST: createItemAction },
  '/stations': { GET: stationsList },
  '/stations/new': { GET: newStationPage, POST: createStationAction },
  '/readers': { GET: readersList },
  '/readers/new': { GET: newReaderPage, POST: createReaderAction },
  '/chips': { GET: chipsList },
};
// Pages d'une entité : <préfixe><id> et <préfixe><id>/<action>. Le segment <id> est validé
// par le gestionnaire (entier strict) ; tout autre chemin sous le préfixe (/items/1/x,
// /items/1/, /items/1/edit/2...) n'est pas une route. Les chemins exacts de ROUTES
// (/items/new, /stations/new, /readers/new) sont résolus avant.
const ITEM_ROUTES = {
  '': { GET: itemPage },
  edit: { GET: editItemPage, POST: updateItemAction },
  delete: { GET: deleteItemPage, POST: deleteItemAction },
  location: { GET: locationPage, POST: correctLocationAction },
  historique: { GET: historyPage }, // étape U3 : tout l'historique des déplacements
  puce: { GET: giveChipPage }, // étape U3 : donner ou changer la puce depuis la fiche
  'retirer-puce': { GET: detachChipPage, POST: detachChipAction }, // étape U3
};
const STATION_ROUTES = {
  '': { GET: stationPage },
  edit: { GET: editStationPage, POST: updateStationAction },
  delete: { GET: deleteStationPage, POST: deleteStationAction },
};
const READER_ROUTES = {
  '': { GET: readerPage },
  station: { GET: readerStationForm, POST: assignReaderAction },
  rename: { GET: readerRenameForm, POST: renameReaderAction },
  deactivate: { GET: deactivateReaderPage, POST: deactivateReaderAction },
  replace: { GET: replaceReaderPage, POST: replaceReaderAction },
};
const ENTITY_ROUTES = [['/items/', ITEM_ROUTES], ['/stations/', STATION_ROUTES], ['/readers/', READER_ROUTES]];
// Puces inconnues (étape 7) : /chips/<UID>/new, /chips/<UID>/associate et
// /chips/<UID>/associate/<id de fiche>. Le segment <UID> est validé par le gestionnaire
// (parseUid : forme exacte, sans décodage) ; /chips/<UID> seul n'est pas une route.
const CHIP_PREFIX = '/chips/';
const CHIP_ROUTES = {
  new: { GET: newChipItemPage, POST: createChipItemAction },
  associate: { GET: associateSearch },
};
const CHIP_CONFIRM_ROUTE = { GET: associateConfirm, POST: associateChipAction };

/**
 * Chemin → {route, idText, subIdText}, ou null si aucune route.
 * idText : segment <id> (ou <UID>) brut, non validé, ou null ; subIdText : second identifiant
 * brut (fiche visée par une association), ou null.
 */
function resolveRoute(path) {
  // Object.hasOwn : un chemin comme « /__proto__ » ou « constructor » ne résout rien d'hérité.
  if (Object.hasOwn(ROUTES, path)) return { route: ROUTES[path], idText: null };
  if (path.startsWith(CHIP_PREFIX)) {
    const parts = path.slice(CHIP_PREFIX.length).split('/');
    if (parts.length === 2 && Object.hasOwn(CHIP_ROUTES, parts[1])) return { route: CHIP_ROUTES[parts[1]], idText: parts[0] };
    if (parts.length === 3 && parts[1] === 'associate') return { route: CHIP_CONFIRM_ROUTE, idText: parts[0], subIdText: parts[2] };
    return null;
  }
  for (const [prefix, routes] of ENTITY_ROUTES) {
    if (!path.startsWith(prefix)) continue;
    const parts = path.slice(prefix.length).split('/');
    if (parts.length === 1) return { route: routes[''], idText: parts[0] };
    if (parts.length === 2 && parts[1] !== '' && Object.hasOwn(routes, parts[1])) {
      return { route: routes[parts[1]], idText: parts[0] };
    }
    return null;
  }
  return null;
}

/**
 * Point d'entrée de l'interface web (toute requête qui n'est pas POST /api/frames).
 * @param {{db, log, loginFailureDelayMs: number, guard: Function, fail: Function}} ctx
 *   guard : enveloppe un callback pour capturer ses exceptions ; fail : réponse 500.
 */
export function handleWeb(ctx, path, req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  const resolved = resolveRoute(path);
  if (!resolved) return sendErrorPage(res, 404, isConnected(ctx, req));
  const { route, idText, subIdText = null } = resolved;
  const handler = Object.hasOwn(route, req.method) ? route[req.method] : null;
  if (!handler) {
    res.setHeader('Allow', Object.keys(route).join(', '));
    // GET (ou HEAD) sur une adresse qui n'accepte qu'un envoi de formulaire, par exemple
    // /logout tapé dans la barre d'adresse : il n'y a pas de formulaire à évoquer.
    const page = req.method === 'GET' || req.method === 'HEAD' ? '405-adresse' : 405;
    return sendErrorPage(res, 405, isConnected(ctx, req), page);
  }
  handler(ctx, req, res, idText, subIdText);
}

// ---------------------------------------------------------------- gestionnaires

// Écran d'accueil (étape U4) : recherche, derniers mouvements, puces à traiter, lecteurs.
// Compatibilité : l'inventaire était à « / » avant U4 ; une ancienne adresse /?q=… (favori,
// lien enregistré) mène aux mêmes résultats, sur /inventaire. La cible est un chemin FIXE ; la
// saisie n'y figure que comme valeur de paramètre, encodée (pas de redirection ouverte).
function home(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const query = queryParam(req, 'q');
  if (query !== null) {
    const q = normalizeQuery(query);
    return redirect(res, q === '' ? '/inventaire' : `/inventaire?${new URLSearchParams({ q })}`);
  }
  const now = Date.now();
  sendHtml(res, 200, homeView(pageUser(ctx, session), { ...homeData(ctx.db, now), now, notice: queryParam(req, 'ok') }));
}

// Liste de l'inventaire, avec recherche facultative (?q=).
function inventory(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const query = normalizeQuery(queryParam(req, 'q'));
  const items = listItems(ctx.db, query);
  sendHtml(res, 200, inventoryPage(pageUser(ctx, session), { query, items, now: Date.now(), notice: queryParam(req, 'ok') }));
}

// Fiche d'un objet. La session est vérifiée AVANT l'identifiant : sans session, toute adresse
// /items/... redirige vers la connexion, sans révéler si la fiche existe.
// ?ok= : code de confirmation, affiché seulement s'il est connu (views.js, ITEM_NOTICES).
function itemPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  // Frise des déplacements (lectures bornées, server/timeline.js), autres modifications, et
  // postes du panneau « Corriger l'emplacement ».
  const timeline = itemTimeline(ctx.db, item, { limit: TIMELINE_ENTRIES });
  const changes = itemChanges(ctx.db, item.id);
  sendHtml(res, 200, itemView(user, {
    item, timeline, changes, stations: listStations(ctx.db), now: Date.now(), notice: queryParam(req, 'ok'),
  }));
}

// Tout l'historique des déplacements d'une fiche, par pages. ?avant= : curseur de la page
// suivante, produit par la page précédente (timeline.js, parseCursor : format exact, sinon 404).
function historyPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  const cursorText = queryParam(req, 'avant');
  const cursor = cursorText === null ? null : parseCursor(cursorText);
  if (cursorText !== null && cursor === null) return sendErrorPage(res, 404, true);
  const timeline = itemTimeline(ctx.db, item, { cursor, limit: TIMELINE_PAGE_ENTRIES });
  sendHtml(res, 200, itemHistoryPage(user, { item, timeline, first: cursor === null, now: Date.now() }));
}

// « Donner une puce » / « Changer de puce » : puces inconnues récentes (au plus
// MAX_OFFERED_CHIPS). Le choix passe par les routes d'association de l'étape 7
// (/chips/<UID>/associate/<id>) : mêmes contrôles, même audit, même 409.
function giveChipPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  const { chips, more } = listUnknownChips(ctx.db, MAX_OFFERED_CHIPS);
  // Anciens propriétaires des puces proposées : une seule lecture de audit_log, et aucune
  // s'il n'y a pas de puce à proposer.
  const owners = chips.length === 0 ? new Map() : chipPreviousOwners(ctx.db, chips.map((chip) => chip.uid));
  sendHtml(res, 200, giveChipView(user, { item, chips, more, owners, now: Date.now() }));
}

// « Retirer la puce » : confirmation, puis retrait (chips.js, detachChip : transaction et audit).
function detachChipPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  sendHtml(res, 200, detachChipView(user, { item, fallback: lastCorrectionStation(ctx.db, item.id) }));
}

/** Poste de la dernière correction d'une fiche (emplacement après retrait de la puce), ou null. */
function lastCorrectionStation(db, itemId) {
  return db.prepare(
    `SELECT st.name FROM location_corrections c JOIN stations st ON st.id = c.station_id
      WHERE c.item_id = ? ORDER BY c.created_at DESC, c.id DESC LIMIT 1`
  ).get(itemId)?.name ?? null;
}

function detachChipAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const id = parseItemId(idText);
    if (id === null) return sendHtml(res, 404, itemNotFoundPage(user));
    // previous : puce affichée sur la page de confirmation. Si la fiche a changé de puce
    // depuis, rien n'est écrit et la page est réaffichée, à jour (409).
    // garder=1 (case « Garder … comme emplacement ») : poste lu dans le champ poste (même format
    // strict qu'un identifiant), vérifié dans la transaction d'écriture.
    const keep = form.get('garder') === '1' ? parseItemId(form.get('poste') ?? '') : null;
    if (form.get('garder') === '1' && keep === null) return sendErrorPage(res, 400, true);
    const before = getItem(ctx.db, id); // emplacement avant le retrait, pour le direct (étape U6)
    const outcome = detachChip(ctx.db, session.userId, id, form.get('previous'), keep);
    if (outcome === 'no_item') return sendHtml(res, 404, itemNotFoundPage(user));
    if (outcome === 'no_station' || outcome.changed) {
      const item = getItem(ctx.db, id);
      if (!item) return sendHtml(res, 404, itemNotFoundPage(user));
      return sendHtml(res, 409, detachChipView(user, { item, changed: true, fallback: lastCorrectionStation(ctx.db, id) }));
    }
    ctx.log(`puce ${outcome.previousUid} retirée de la fiche ${outcome.id} par ${session.username}${outcome.kept ? ' (emplacement gardé)' : ''}`);
    publishItem(ctx, 'puce', outcome.id, session.username, before);
    redirect(res, `/items/${outcome.id}?ok=${outcome.kept ? 'puce_retiree_gardee' : 'puce_retiree'}`);
  });
}

// ---------------------------------------------------------------- recherche pendant la frappe

// Longueur maximale du paramètre q de GET /api/recherche (en caractères) : au-delà, 400. Nos
// champs sont limités à MAX_QUERY_CHARS (normalizeQuery tronque à cette longueur) ; ce plafond
// plus large ne refuse que des requêtes qui ne viennent pas de nos pages.
export const MAX_API_QUERY_CHARS = 200;

/**
 * GET /api/recherche?q=... : résultats de la palette Ctrl K (au plus MAX_SEARCH_RESULTS, et le
 * nombre total) ; avec &tout=1, toutes les fiches qui correspondent (filtre pendant la frappe
 * de la page Inventaire ; q vide : tout l'inventaire, comme GET /).
 *
 * SÉCURITÉ :
 * - session obligatoire ; sans session, 401 JSON minimal (pas de redirection : l'appelant est
 *   un script, qui affiche « session expirée ») ;
 * - même origine : aucun en-tête CORS, donc une page d'un autre site ne peut pas lire la
 *   réponse ; le cookie SameSite=Strict n'est de toute façon pas envoyé depuis un autre site.
 *   En plus, si le navigateur annonce l'origine de la requête (Sec-Fetch-Site), seule
 *   « same-origin » est acceptée (403 sinon) : la réponse n'est même pas calculée pour une
 *   requête venue d'ailleurs ou tapée dans la barre d'adresse ;
 * - lecture seule (GET), aucune écriture : pas de jeton CSRF nécessaire ;
 * - contenu minimal (views.js, searchResult), JSON échappé (sendJson), jamais mis en cache.
 * Ce n'est pas la route des boîtiers (POST /api/frames, http.js), qui n'est pas concernée.
 */
function searchApi(ctx, req, res) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return sendJson(res, 403, { erreur: 'origine' });
  const session = currentSession(ctx, req);
  if (!session) return sendJson(res, 401, { erreur: 'session' });
  const raw = queryParam(req, 'q') ?? '';
  if ([...raw].length > MAX_API_QUERY_CHARS) return sendJson(res, 400, { erreur: 'requete' });
  const query = normalizeQuery(raw);
  const now = Date.now();
  if (queryParam(req, 'pour') === 'association') {
    // Page « Associer la puce » : fiches sans puce d'abord, au plus MAX_ASSOCIATE_RESULTS, avec
    // leur puce actuelle (affichée sur cette page).
    const items = associationCandidates(ctx.db, query);
    const shown = items.slice(0, MAX_ASSOCIATE_RESULTS).map((row) => searchResult(row, now, { compact: true, withChip: true }));
    return sendJson(res, 200, { total: items.length, resultats: shown });
  }
  if (queryParam(req, 'tout') === '1') {
    // Page Inventaire : toutes les fiches, lignes allégées (ce qu'affiche une ligne du tableau).
    const items = listItems(ctx.db, query);
    return sendJson(res, 200, { total: items.length, resultats: items.map((row) => searchResult(row, now, { compact: true })) });
  }
  const { total, items } = searchItems(ctx.db, query);
  sendJson(res, 200, { total, resultats: items.map((row) => searchResult(row, now)) });
}

// ---------------------------------------------------------------- direct (étape U4)

/**
 * GET /api/direct : flux d'événements du direct (server/direct.js). Mêmes contrôles que
 * /api/recherche : Sec-Fetch-Site same-origin si annoncé (403 sinon), session obligatoire (401
 * JSON sinon), aucun en-tête CORS. Plafond de flux atteint : 503 JSON, sans rien ouvrir.
 * Reprise : Last-Event-ID (EventSource) ou ?depuis= (app.js), au format strict (parseEventId).
 */
function directApi(ctx, req, res) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return sendJson(res, 403, { erreur: 'origine' });
  const session = currentSession(ctx, req);
  if (!session) return sendJson(res, 401, { erreur: 'session' });
  const lastId = parseEventId(req.headers['last-event-id'] ?? queryParam(req, 'depuis'));
  if (!ctx.direct.open(req, res, session.token, lastId)) {
    ctx.log('direct : plafond de flux atteint, connexion refusée');
    res.setHeader('Retry-After', '30');
    return sendJson(res, 503, { erreur: 'plein' });
  }
}

/** Publie l'événement d'une action sur une fiche (après l'écriture) ; un échec est seulement journalisé. */
// before : la fiche avant l'action (getItem), ou null (fiche créée) : champ « de » (étape U6).
function publishItem(ctx, type, itemId, username, before = null) {
  try {
    const item = getItem(ctx.db, itemId);
    if (!item) return;
    const event = itemEvent(type, item, username, undefined, before);
    if (type === 'puce') event.puces = ctx.chipsCounter.refresh();
    ctx.direct.publish(event);
  } catch (err) {
    ctx.log(`diffusion en direct impossible : ${err.message}`);
  }
}

// Nombre maximal de puces demandées à GET /api/puces-inconnues : la page « Puces inconnues »
// (étape U5) se met à jour en direct et affiche au plus MAX_UNKNOWN_CHIPS puces.
const MAX_API_CHIPS = MAX_UNKNOWN_CHIPS;

/**
 * GET /api/puces-inconnues?n=3 : les n puces inconnues les plus récentes (1 ≤ n ≤ MAX_API_CHIPS,
 * 3 par défaut), avec leur nombre de scans, et leur nombre total. Appelé par app.js après un événement du direct « puce
 * inconnue » (le flux, lui, ne contient jamais de numéro de puce). Mêmes contrôles que
 * /api/recherche (origine, session, JSON échappé, no-store). Ces numéros sont ceux qu'affiche
 * déjà la page « Puces inconnues » au même compte.
 */
function chipsApi(ctx, req, res) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin') return sendJson(res, 403, { erreur: 'origine' });
  const session = currentSession(ctx, req);
  if (!session) return sendJson(res, 401, { erreur: 'session' });
  const text = queryParam(req, 'n') ?? '3';
  const n = /^[1-9][0-9]{0,2}$/.test(text) ? Number(text) : 0;
  if (n < 1 || n > MAX_API_CHIPS) return sendJson(res, 400, { erreur: 'requete' });
  const { chips, total } = unknownChipsOverview(ctx.db, n);
  const now = Date.now();
  sendJson(res, 200, { total, puces: chips.map((chip) => chipResult(chip, now)) });
}

// ---------------------------------------------------------------- édition des fiches
// Pages GET : session obligatoire. Envois POST : voir postForm (session, Origin, jeton CSRF).
// Une saisie invalide réaffiche le formulaire, avec les valeurs saisies et les erreurs, en 400.
// Une action réussie redirige (303) vers une page fixe avec un code ?ok= constant.

function newItemPage(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  // ?nom= : nom pré-rempli (bouton « Créer la fiche » de la recherche sans résultat). Nettoyé
  // comme un nom saisi (cleanLine) et borné ; échappé par le gabarit ; rien n'est enregistré.
  const name = [...cleanLine(queryParam(req, 'nom'))].slice(0, MAX_NAME_CHARS).join('');
  const form = { name, notes: '', rows: [], blankRows: BLANK_ROWS };
  sendHtml(res, 200, itemFormPage(pageUser(ctx, session), { item: null, form, errors: {} }));
}

function createItemAction(ctx, req, res) {
  postForm(ctx, req, res, (session, form) => {
    const valid = submittedItem(ctx, res, pageUser(ctx, session), form, null);
    if (!valid) return;
    const id = createItem(ctx.db, session.userId, valid);
    ctx.log(`fiche ${id} créée par ${session.username}`);
    redirect(res, `/items/${id}?ok=cree`);
  });
}

function editItemPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  const rows = item.properties.map(([key, value]) => ({ key, value, error: null }));
  const form = withBlankRows({ name: item.name, notes: item.notes, rows }, BLANK_ROWS);
  sendHtml(res, 200, itemFormPage(user, { item, form, errors: {} }));
}

function updateItemAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const item = findItem(ctx, res, user, idText);
    if (!item) return;
    const valid = submittedItem(ctx, res, user, form, item);
    if (!valid) return;
    const changed = updateItem(ctx.db, session.userId, item.id, valid);
    if (changed === null) return sendHtml(res, 404, itemNotFoundPage(user));
    if (changed.length > 0) ctx.log(`fiche ${item.id} modifiée par ${session.username} (${changed.join(', ')})`);
    redirect(res, `/items/${item.id}?ok=${changed.length > 0 ? 'modifie' : 'inchange'}`);
  });
}

function deleteItemPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  sendHtml(res, 200, deleteView(user, { item }));
}

function deleteItemAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(ctx, session);
    const id = parseItemId(idText);
    if (id === null || !deleteItem(ctx.db, session.userId, id)) return sendHtml(res, 404, itemNotFoundPage(user));
    ctx.log(`fiche ${id} supprimée par ${session.username}`);
    ctx.chipsCounter.refresh(); // sa puce redevient inconnue
    redirect(res, '/inventaire?ok=supprime');
  });
}

function locationPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  sendHtml(res, 200, locationView(user, { item, stations: listStations(ctx.db) }));
}

function correctLocationAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const item = findItem(ctx, res, user, idText);
    if (!item) return;
    // Identifiant de poste : même format strict qu'un identifiant de fiche (entier positif) ;
    // son existence est vérifiée dans la transaction d'écriture.
    const selected = form.get('station') ?? '';
    const outcome = correctLocation(ctx.db, session.userId, item.id, parseItemId(selected));
    if (outcome === 'no_item') return sendHtml(res, 404, itemNotFoundPage(user));
    if (outcome === 'no_station') {
      const error = selected === '' ? 'Choisissez un poste dans la liste.' : 'Ce poste n\'existe pas ou plus. Choisissez un poste dans la liste.';
      return sendHtml(res, 400, locationView(user, { item, stations: listStations(ctx.db), selected, error }));
    }
    ctx.log(`localisation de la fiche ${item.id} corrigée par ${session.username}`);
    publishItem(ctx, 'correction', item.id, session.username, item);
    redirect(res, `/items/${item.id}?ok=corrige`);
  });
}

/**
 * Fiche désignée par le segment d'URL, ou null après avoir répondu 404 (identifiant mal
 * formé ou fiche inexistante : même page, sans distinction).
 */
function findItem(ctx, res, user, idText) {
  const id = parseItemId(idText);
  const item = id === null ? null : getItem(ctx.db, id);
  if (!item) sendHtml(res, 404, itemNotFoundPage(user));
  return item;
}

/**
 * Envoi du formulaire de fiche (création : item null ; modification : la fiche). Champs :
 * name, notes, et prop_key / prop_value répétés, appariés par position.
 * Renvoie la fiche validée à enregistrer, ou null après avoir répondu :
 *   - plus de MAX_FORM_ROWS lignes : 400, page d'erreur au texte constant (rien de la saisie
 *     n'est réaffiché), connexion fermée ;
 *   - « Ajouter des lignes » : 200, saisie réaffichée (nettoyée, sans erreurs) avec
 *     BLANK_ROWS lignes vides de plus, dans la limite de MAX_FORM_ROWS ; rien n'est écrit ;
 *   - saisie invalide : 400, formulaire réaffiché avec les valeurs et les erreurs.
 * chip : création depuis une puce inconnue (étape 7), réaffichée en lecture seule ; sinon null.
 */
function submittedItem(ctx, res, user, form, item, chip = null) {
  const keys = form.getAll('prop_key');
  const values = form.getAll('prop_value');
  if (keys.length > MAX_FORM_ROWS || values.length > MAX_FORM_ROWS) {
    ctx.log(`formulaire de fiche refusé : ${Math.max(keys.length, values.length)} lignes de propriétés (plafond ${MAX_FORM_ROWS})`);
    sendErrorPage(res, 400, true); // appelé après postForm : la session est valide
    return null;
  }
  const result = validateItemInput({ name: form.get('name'), notes: form.get('notes'), keys, values });
  const now = Date.now();
  // Puce réaffichée avec son avertissement de réutilisation, lu seulement si la page est produite.
  const shownChip = () => (chip === null ? null : withPreviousOwner(ctx, chip));
  if (form.get('action') === ADD_ROWS_ACTION) {
    const rows = result.form.rows.map((row) => ({ ...row, error: null }));
    sendHtml(res, 200, itemFormPage(user, { item, chip: shownChip(), now, form: withBlankRows({ ...result.form, rows }, result.form.blankRows + BLANK_ROWS), errors: {} }));
    return null;
  }
  if (!result.ok) {
    sendHtml(res, 400, itemFormPage(user, { item, chip: shownChip(), now, form: withBlankRows(result.form, BLANK_ROWS), errors: result.errors }));
    return null;
  }
  return result.item;
}

/**
 * Formulaire avec `wanted` lignes vides après ses lignes remplies, sans dépasser MAX_FORM_ROWS
 * lignes au total : une page de l'application ne peut ainsi jamais produire un envoi refusé
 * pour excès de lignes, et « Ajouter des lignes » répété plafonne au même total.
 */
function withBlankRows(form, wanted) {
  return { ...form, blankRows: Math.max(0, Math.min(wanted, MAX_FORM_ROWS - form.rows.length)) };
}

// ---------------------------------------------------------------- postes (étape 6)
// Mêmes règles que l'édition des fiches : session obligatoire, tout POST par postForm, saisie
// invalide réaffichée en 400, action réussie suivie d'une redirection 303 avec un code ?ok=.
// Action impossible (poste avec historique, lecteur désactivé, numéros épuisés) : page
// d'explication en 409, sans aucune écriture.

function stationsList(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  // ?ok=ajoute&poste=<id> : poste ajouté depuis le champ en ligne ; son nom est lu en base (le
  // message reste un texte constant, seul le nom vient de la base).
  const notice = queryParam(req, 'ok');
  const addedId = notice === 'ajoute' ? parseItemId(queryParam(req, 'poste') ?? '') : null;
  const added = addedId === null ? null : getStation(ctx.db, addedId);
  sendHtml(res, 200, stationsPage(pageUser(ctx, session), {
    stations: listStationSummaries(ctx.db), now: Date.now(), notice, added: added === null ? null : { id: added.id, name: added.name },
  }));
}

function stationPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const station = findStation(ctx, res, user, idText);
  if (!station) return;
  sendHtml(res, 200, stationView(user, {
    station,
    readers: stationReaders(ctx.db, station.id),
    items: stationItems(ctx.db, station.id),
    movements: recentMovements(ctx.db, STATION_MOVEMENTS, station.id),
    deletable: !stationHasHistory(ctx.db, station.id),
    now: Date.now(),
    notice: queryParam(req, 'ok'),
  }));
}

function newStationPage(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  sendHtml(res, 200, stationFormPage(pageUser(ctx, session), { station: null, form: { name: '', description: '' }, errors: {} }));
}

// Dernières arrivées affichées sur la fiche d'un poste (étape U6).
const STATION_MOVEMENTS = 8;

const duplicateStationError = (existing) => `Un poste porte déjà ce nom : « ${existing} » (majuscules et minuscules confondues). Choisissez un autre nom.`;

function createStationAction(ctx, req, res) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const result = validateStationInput({ name: form.get('name'), description: form.get('description') });
    if (!result.ok) return sendHtml(res, 400, stationFormPage(user, { station: null, form: result.form, errors: result.errors }));
    const outcome = createStation(ctx.db, session.userId, result.station);
    if (outcome.duplicate !== undefined) {
      return sendHtml(res, 400, stationFormPage(user, { station: null, form: result.form, errors: { name: duplicateStationError(outcome.duplicate) } }));
    }
    ctx.log(`poste ${outcome.id} créé par ${session.username}`);
    // Démarrage guidé (étape U4) : tant qu'aucun objet n'a été localisé, retour à l'accueil, qui
    // montre l'étape suivante.
    // Champ en ligne de la page Postes (retour=postes, étape U6) : retour à la liste, poste mis en
    // évidence. Sinon, pendant le démarrage guidé, retour à l'accueil.
    if (form.get('retour') === 'postes') return redirect(res, `/stations?ok=ajoute&poste=${outcome.id}`);
    redirect(res, isOnboarding(ctx.db) ? '/?ok=poste' : `/stations/${outcome.id}?ok=cree`);
  });
}

function editStationPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const station = findStation(ctx, res, user, idText);
  if (!station) return;
  sendHtml(res, 200, stationFormPage(user, { station, form: { name: station.name, description: station.description }, errors: {} }));
}

function updateStationAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const station = findStation(ctx, res, user, idText);
    if (!station) return;
    // « Renommer » sur place (étape U6) n'envoie que le nom : sans champ description, la
    // description enregistrée est gardée telle quelle.
    const description = form.has('description') ? form.get('description') : station.description;
    const result = validateStationInput({ name: form.get('name'), description });
    if (!result.ok) return sendHtml(res, 400, stationFormPage(user, { station, form: result.form, errors: result.errors }));
    const outcome = updateStation(ctx.db, session.userId, station.id, result.station);
    if (outcome === null) return sendHtml(res, 404, stationNotFoundPage(user));
    if (outcome.duplicate !== undefined) {
      return sendHtml(res, 400, stationFormPage(user, { station, form: result.form, errors: { name: duplicateStationError(outcome.duplicate) } }));
    }
    if (outcome.changed.length > 0) ctx.log(`poste ${station.id} modifié par ${session.username} (${outcome.changed.join(', ')})`);
    redirect(res, `/stations/${station.id}?ok=${outcome.changed.length > 0 ? 'modifie' : 'inchange'}`);
  });
}

function deleteStationPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const station = findStation(ctx, res, user, idText);
  if (!station) return;
  sendHtml(res, 200, deleteStationView(user, { station, history: stationHistory(ctx.db, station.id) }));
}

function deleteStationAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(ctx, session);
    const station = findStation(ctx, res, user, idText);
    if (!station) return;
    const outcome = deleteStation(ctx.db, session.userId, station.id);
    if (outcome === 'no_station') return sendHtml(res, 404, stationNotFoundPage(user));
    if (outcome !== 'ok') {
      ctx.log(`suppression du poste ${station.id} refusée : le poste a un historique`);
      return sendHtml(res, 409, deleteStationView(user, { station, history: outcome.blocked }));
    }
    ctx.log(`poste ${station.id} supprimé par ${session.username}`);
    redirect(res, '/stations?ok=supprime');
  });
}

/** Poste désigné par le segment d'URL, ou null après avoir répondu 404 (format invalide ou inexistant). */
function findStation(ctx, res, user, idText) {
  const id = parseItemId(idText);
  const station = id === null ? null : getStation(ctx.db, id);
  if (!station) sendHtml(res, 404, stationNotFoundPage(user));
  return station;
}

// ---------------------------------------------------------------- lecteurs (étape 6)
// SÉCURITÉ : la clé d'un lecteur n'apparaît que dans la réponse au POST de création ou de
// remplacement (sendKeyPage). Elle n'est jamais journalisée (ctx.log ne reçoit que des
// numéros et l'identifiant du compte), jamais mise dans une URL, jamais réaffichée.

const STATION_GONE = 'Ce poste n\'existe pas ou plus. Choisissez un poste dans la liste.';

/**
 * Champ « station » d'un formulaire de lecteur : '' → null (non affecté), entier strict →
 * identifiant (BigInt), absent ou mal formé → undefined (refusé). L'existence du poste est
 * vérifiée dans la transaction d'écriture.
 */
function stationChoice(form) {
  const selected = form.get('station');
  if (selected === '') return null;
  return parseItemId(selected) ?? undefined;
}

function readersList(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  sendHtml(res, 200, readersPage(pageUser(ctx, session), { readers: listReaders(ctx.db), now: Date.now() }));
}

function readerPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  // stations : choix du panneau « Changer de poste » (étape U6), seulement pour un lecteur actif.
  const stations = reader.active === 1 ? listStations(ctx.db) : [];
  sendHtml(res, 200, readerView(user, { reader, scans: readerScans(ctx.db, reader.id), now: Date.now(), notice: queryParam(req, 'ok'), stations }));
}

function newReaderPage(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  // ?poste=<id> : poste présélectionné (lien « Ajouter un lecteur » d'un poste, étape U6).
  // Poste inexistant : « Pas de poste pour l'instant » reste coché.
  const preset = parseItemId(queryParam(req, 'poste') ?? '');
  const stations = listStations(ctx.db);
  const known = preset !== null && stations.some((station) => String(station.id) === String(preset));
  sendHtml(res, 200, readerFormPage(pageUser(ctx, session), { stations, selected: known ? String(preset) : '' }));
}

function createReaderAction(ctx, req, res) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const name = validateReaderName(form.get('name'));
    const stationId = stationChoice(form);
    // Formulaire réaffiché en 400 avec les deux erreurs possibles (nom, poste) et la saisie
    // nettoyée ; rien n'est écrit tant que le nom est invalide.
    const again = (stationError) => sendHtml(res, 400, readerFormPage(user, {
      stations: listStations(ctx.db), selected: form.get('station') ?? '', error: stationError, name: name.name, nameError: name.error,
    }));
    if (!name.ok) return again(stationId === undefined ? STATION_GONE : null);
    const outcome = stationId === undefined ? 'no_station' : createReader(ctx.db, session.userId, stationId, undefined, name.name);
    if (outcome === 'no_station') return again(STATION_GONE);
    if (outcome === 'ids_exhausted') {
      ctx.log('création de lecteur refusée : plus aucun numéro de lecteur disponible');
      return sendHtml(res, 409, readerIdsExhaustedPage(user));
    }
    ctx.log(`lecteur ${outcome.id} créé par ${session.username}`); // jamais la clé
    // Démarrage guidé : la page de clé reste affichée ; son bouton ramène à l'accueil.
    sendKeyPage(res, user, outcome, null, isOnboarding(ctx.db));
  });
}

function readerStationForm(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  if (reader.active !== 1) return sendHtml(res, 200, readerInactivePage(user, { reader }));
  sendHtml(res, 200, readerStationPage(user, { reader, stations: listStations(ctx.db) }));
}

function assignReaderAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const reader = findReader(ctx, res, user, idText);
    if (!reader) return;
    if (reader.active !== 1) return sendHtml(res, 409, readerInactivePage(user, { reader }));
    const stationId = stationChoice(form);
    const outcome = stationId === undefined ? 'no_station' : assignReader(ctx.db, session.userId, reader.id, stationId);
    if (outcome === 'no_reader') return sendHtml(res, 404, readerNotFoundPage(user));
    if (outcome === 'inactive') return sendHtml(res, 409, readerInactivePage(user, { reader }));
    if (outcome === 'no_station') {
      return sendHtml(res, 400, readerStationPage(user, { reader, stations: listStations(ctx.db), selected: form.get('station') ?? '', error: STATION_GONE }));
    }
    if (outcome.changed) ctx.log(`lecteur ${reader.id} changé de poste par ${session.username}`);
    redirect(res, `/readers/${reader.id}?ok=${outcome.changed ? 'affecte' : 'inchange'}`);
  });
}

// Renommage (D-019) : permis aussi pour un lecteur désactivé (le nom ne change rien à la
// réception des scans, il aide seulement à reconnaître le boîtier dans l'historique).
function readerRenameForm(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  sendHtml(res, 200, readerRenamePage(user, { reader }));
}

function renameReaderAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const reader = findReader(ctx, res, user, idText);
    if (!reader) return;
    const name = validateReaderName(form.get('name'));
    if (!name.ok) return sendHtml(res, 400, readerRenamePage(user, { reader, name: name.name, error: name.error }));
    const outcome = renameReader(ctx.db, session.userId, reader.id, name.name);
    if (outcome === 'no_reader') return sendHtml(res, 404, readerNotFoundPage(user));
    if (outcome.changed) ctx.log(`lecteur ${reader.id} renommé par ${session.username}`);
    redirect(res, `/readers/${reader.id}?ok=${outcome.changed ? 'renomme' : 'nom_inchange'}`);
  });
}

function deactivateReaderPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  if (reader.active !== 1) return sendHtml(res, 200, readerInactivePage(user, { reader }));
  sendHtml(res, 200, deactivateView(user, { reader }));
}

function deactivateReaderAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(ctx, session);
    const reader = findReader(ctx, res, user, idText);
    if (!reader) return;
    const outcome = deactivateReader(ctx.db, session.userId, reader.id);
    if (outcome === 'no_reader') return sendHtml(res, 404, readerNotFoundPage(user));
    if (outcome === 'inactive') return sendHtml(res, 409, readerInactivePage(user, { reader }));
    ctx.log(`lecteur ${reader.id} désactivé par ${session.username}`);
    redirect(res, `/readers/${reader.id}?ok=desactive`);
  });
}

function replaceReaderPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  if (reader.active !== 1) return sendHtml(res, 200, readerInactivePage(user, { reader }));
  sendHtml(res, 200, replaceView(user, { reader }));
}

function replaceReaderAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(ctx, session);
    const reader = findReader(ctx, res, user, idText);
    if (!reader) return;
    const outcome = replaceReader(ctx.db, session.userId, reader.id);
    if (outcome === 'no_reader') return sendHtml(res, 404, readerNotFoundPage(user));
    if (outcome === 'inactive') return sendHtml(res, 409, readerInactivePage(user, { reader }));
    if (outcome === 'ids_exhausted') {
      ctx.log(`remplacement de la clé du lecteur ${reader.id} refusé : plus aucun numéro de lecteur disponible`);
      return sendHtml(res, 409, readerIdsExhaustedPage(user));
    }
    ctx.log(`clé du lecteur ${outcome.oldId} remplacée par ${session.username} : nouveau lecteur ${outcome.id}, lecteur ${outcome.oldId} désactivé`); // jamais la clé
    sendKeyPage(res, user, outcome, outcome.oldId);
  });
}

/**
 * SÉCURITÉ : seule réponse qui contient une clé de lecteur. Réponse directe au POST, sans
 * redirection (la clé n'est dans aucune URL, et aucune page consultable ensuite ne la
 * contient), avec Cache-Control: no-store (sendHtml). Format : 64 caractères hexadécimaux en
 * minuscules, celui du fichier lu par tools/simulateur.js --key-file.
 */
function sendKeyPage(res, user, created, oldId, home = false) {
  sendHtml(res, 200, readerKeyPage(user, { id: created.id, name: created.name, station: created.station, keyHex: created.key.toString('hex'), oldId, home }));
}

/** Lecteur désigné par le segment d'URL, ou null après avoir répondu 404 (format invalide ou inexistant). */
function findReader(ctx, res, user, idText) {
  const id = parseItemId(idText);
  const reader = id === null ? null : getReader(ctx.db, id);
  if (!reader) sendHtml(res, 404, readerNotFoundPage(user));
  return reader;
}

// ---------------------------------------------------------------- puces inconnues (étape 7)
// Mêmes règles : session obligatoire, tout POST par postForm, action réussie suivie d'une
// redirection 303 avec un code ?ok=. Aucune saisie manuelle d'UID : l'UID vient de l'adresse,
// il doit avoir été scanné (sinon 404) et être encore inconnu (sinon 409). Ces deux
// conditions sont vérifiées à l'affichage, puis à nouveau dans la transaction d'écriture
// (server/chips.js). Le journal des scans n'est jamais modifié.

function chipsList(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  sendHtml(res, 200, chipsPage(pageUser(ctx, session), { ...listUnknownChips(ctx.db), now: Date.now() }));
}

/**
 * Puce inconnue désignée par le segment d'URL, ou null après avoir répondu :
 * 404 si le segment n'est pas un UID au format exact ou si cet UID n'a jamais été scanné
 * (même page, sans distinction) ; 409 si une fiche porte déjà cette puce.
 */
function findUnknownChip(ctx, res, user, uidText) {
  const uid = parseUid(uidText);
  const chip = uid === null ? null : getChip(ctx.db, uid);
  if (!chip) {
    sendHtml(res, 404, chipNotFoundPage(user));
    return null;
  }
  if (chip.item_id !== null) {
    sendHtml(res, 409, chipKnownPage(user, { uid: chip.uid, itemId: chip.item_id }));
    return null;
  }
  return chip;
}

/**
 * Puce complétée de previous : la dernière fiche qui l'a portée (avertissement de réutilisation), ou null.
 * chipPreviousOwner parcourt audit_log (chips.js) : il n'est appelé QUE pour une page qui affiche
 * l'avertissement (formulaire de création depuis la puce, réaffiché compris ; confirmation
 * d'association, 409 compris). Ni la recherche d'association ni une création réussie ne le lisent.
 */
function withPreviousOwner(ctx, chip) {
  return { ...chip, previous: chipPreviousOwner(ctx.db, chip.uid) };
}

/** Issue d'une écriture refusée par chips.js (puce jamais scannée ou déjà associée) : réponse, puis vrai. */
function chipConflictAnswered(res, user, uid, outcome) {
  if (outcome === 'never_scanned') {
    sendHtml(res, 404, chipNotFoundPage(user));
    return true;
  }
  if (outcome.known !== undefined) {
    sendHtml(res, 409, chipKnownPage(user, { uid, itemId: outcome.known }));
    return true;
  }
  return false;
}

// « Créer une fiche » depuis une puce inconnue : formulaire de l'étape 5, UID en lecture seule.
function newChipItemPage(ctx, req, res, uidText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const chip = findUnknownChip(ctx, res, user, uidText);
  if (!chip) return;
  const form = { name: '', notes: '', rows: [], blankRows: BLANK_ROWS };
  sendHtml(res, 200, itemFormPage(user, { item: null, chip: withPreviousOwner(ctx, chip), now: Date.now(), form, errors: {} }));
}

function createChipItemAction(ctx, req, res, uidText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const chip = findUnknownChip(ctx, res, user, uidText);
    if (!chip) return;
    const valid = submittedItem(ctx, res, user, form, null, chip);
    if (!valid) return;
    const outcome = createItemForChip(ctx.db, session.userId, chip.uid, valid);
    if (chipConflictAnswered(res, user, chip.uid, outcome)) return;
    ctx.log(`fiche ${outcome.id} créée par ${session.username} avec la puce ${chip.uid}`);
    publishItem(ctx, 'puce', outcome.id, session.username);
    redirect(res, `/items/${outcome.id}?ok=cree_puce`);
  });
}

/**
 * Fiches proposées pour recevoir une puce inconnue : même recherche que l'inventaire, mais les
 * fiches SANS puce d'abord (ce sont elles qui attendent une puce), dans l'ordre de la recherche
 * (tri stable). Page HTML et GET /api/recherche?pour=association.
 */
function associationCandidates(db, query) {
  return listItems(db, query).sort((a, b) => (a.uid_nfc === null ? 0 : 1) - (b.uid_nfc === null ? 0 : 1));
}

// « Associer à une fiche existante » : recherche (même logique que l'inventaire), limitée à
// MAX_ASSOCIATE_RESULTS fiches affichées.
function associateSearch(ctx, req, res, uidText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const chip = findUnknownChip(ctx, res, user, uidText);
  if (!chip) return;
  const query = normalizeQuery(queryParam(req, 'q'));
  const found = associationCandidates(ctx.db, query);
  sendHtml(res, 200, associateSearchPage(user, {
    chip, query, items: found.slice(0, MAX_ASSOCIATE_RESULTS), total: found.length, now: Date.now(),
  }));
}

function associateConfirm(ctx, req, res, uidText, itemIdText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(ctx, session);
  const chip = findUnknownChip(ctx, res, user, uidText);
  if (!chip) return;
  const item = findItem(ctx, res, user, itemIdText);
  if (!item) return;
  const fromItem = queryParam(req, 'depuis') === 'fiche'; // page ouverte depuis « Donner une puce »
  sendHtml(res, 200, associateConfirmPage(user, { chip: withPreviousOwner(ctx, chip), item, now: Date.now(), fromItem }));
}

function associateChipAction(ctx, req, res, uidText, itemIdText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(ctx, session);
    const uid = parseUid(uidText);
    const itemId = parseItemId(itemIdText);
    if (uid === null) return sendHtml(res, 404, chipNotFoundPage(user));
    if (itemId === null) return sendHtml(res, 404, itemNotFoundPage(user));
    // previous : puce de la fiche affichée sur la page de confirmation ('' : aucune).
    const before = getItem(ctx.db, itemId); // emplacement avant l'association, pour le direct (étape U6)
    const outcome = associateChip(ctx.db, session.userId, uid, itemId, form.get('previous'));
    if (chipConflictAnswered(res, user, uid, outcome)) return;
    if (outcome === 'no_item') return sendHtml(res, 404, itemNotFoundPage(user));
    if (outcome.changed) {
      // La fiche a changé de puce depuis la confirmation : page réaffichée, à jour, sans écriture.
      const chip = withPreviousOwner(ctx, getChip(ctx.db, uid));
      const item = getItem(ctx.db, itemId);
      return sendHtml(res, 409, associateConfirmPage(user, { chip, item, now: Date.now(), changed: true, fromItem: form.get('depuis') === 'fiche' }));
    }
    const replaced = outcome.previousUid === null ? '' : ` (remplace ${outcome.previousUid})`;
    ctx.log(`puce ${uid} associée à la fiche ${outcome.id} par ${session.username}${replaced}`);
    publishItem(ctx, 'puce', outcome.id, session.username, before);
    redirect(res, `/items/${outcome.id}?ok=${outcome.previousUid === null ? 'puce_associee' : 'puce_remplacee'}`);
  });
}

function loginPage(ctx, req, res) {
  if (currentSession(ctx, req)) return redirect(res, '/');
  // Jeton CSRF de connexion (double soumission) : réutilisé s'il est déjà présent et bien
  // formé (plusieurs onglets restent valides), sinon nouveau. Durée de validité renouvelée.
  const existing = readCookies(req).get(LOGIN_CSRF_COOKIE);
  const csrf = isTokenFormat(existing) ? existing : newToken();
  // ?info= : code constant (LOGIN_INFO), par exemple après une session expirée pendant un envoi.
  const code = queryParam(req, 'info');
  const message = code !== null && Object.hasOwn(LOGIN_INFO, code) ? LOGIN_INFO[code] : null;
  sendHtml(res, 200, loginView(csrf, message), [loginCsrfCookie(csrf)]);
}

function login(ctx, req, res) {
  // Adresse lue dès le début : si le client coupe pendant le calcul, req.socket.remoteAddress
  // devient indéfini, et l'adresse disparaîtrait du journal.
  const remote = req.socket.remoteAddress ?? '-';
  if (!originMatchesHost(req)) return forbidden(ctx, req, res, 'origin', remote);
  readForm(ctx, req, res, MAX_FORM_BYTES, (form) => {
    const cookies = readCookies(req);
    const csrfCookie = cookies.get(LOGIN_CSRF_COOKIE);
    const username = form.get('username') ?? '';
    // Jeton de connexion EXPIRÉ : la page de connexion est restée ouverte plus de
    // LOGIN_CSRF_MAX_AGE_S, le navigateur a supprimé le cookie, mais le formulaire porte encore
    // un jeton bien formé. La page est réaffichée avec un nouveau jeton et un message ;
    // l'identifiant est pré-rempli s'il respecte le format, le mot de passe est vidé.
    // SÉCURITÉ : ce chemin ne fait AUCUNE vérification de mot de passe (pas d'argon2), ne crée
    // aucune session et n'écrit rien : il ne fait que redonner un formulaire, comme GET /login.
    // Il n'affaiblit donc pas la protection contre la falsification de connexion, qui reste
    // assurée par Origin (déjà vérifié ci-dessus) et par la double soumission pour toute
    // connexion effective. Tout autre écart (cookie présent mais différent ou mal formé, champ
    // absent ou mal formé) reste refusé en 403 ci-dessous.
    if (csrfCookie === undefined && isTokenFormat(form.get('csrf'))) {
      ctx.log(`connexion : jeton de connexion expiré, formulaire réaffiché, depuis ${remote}`);
      const csrf = newToken();
      const shown = USERNAME_FORMAT.test(username) ? username : '';
      return sendHtml(res, 200, loginView(csrf, LOGIN_EXPIRED_MESSAGE, shown), [loginCsrfCookie(csrf)]);
    }
    // Double soumission : le champ du formulaire doit égaler le cookie __Host- posé par
    // GET /login. Un site tiers ne peut ni lire ni poser ce cookie. isTokenFormat exclut le
    // cas « cookie vide = champ vide ».
    if (!isTokenFormat(csrfCookie) || !safeEqual(form.get('csrf'), csrfCookie)) return forbidden(ctx, req, res, 'csrf', remote);

    const password = form.get('password') ?? '';
    // COLLATE NOCASE sur la colonne : identifiant insensible à la casse.
    const user = USERNAME_FORMAT.test(username)
      ? ctx.db.prepare('SELECT id, username, password_hash, active FROM users WHERE username = ?').get(username)
      : undefined;
    const usable = user?.active === 1;
    // Compte inconnu ou désactivé : argon2 est calculé quand même sur une empreinte factice,
    // pour un temps de réponse homogène (pas d'énumération des comptes par le temps).
    // skip : si le client est déjà parti quand vient son tour dans la file, le calcul n'est pas
    // lancé (il ne servirait à rien et retarderait les autres).
    verifyPassword(password, usable ? user.password_hash : DUMMY_HASH, { skip: () => req.socket.destroyed }).then((ok) => {
      if (ok && usable) {
        // Anti-fixation : toujours un NOUVEAU jeton ; l'éventuelle session précédente est supprimée.
        deleteSession(ctx.db, cookies.get(SESSION_COOKIE));
        const token = createSession(ctx.db, user.id);
        ctx.log(`connexion réussie : compte ${user.username} depuis ${remote}`);
        return redirect(res, '/', [sessionCookie(token), clearCookie(LOGIN_CSRF_COOKIE)]);
      }
      // Ni l'identifiant saisi (donnée de l'attaquant, voire mot de passe tapé dans le mauvais
      // champ) ni la cause (compte inconnu, désactivé, mauvais mot de passe) ne sont journalisés.
      ctx.log(`connexion refusée depuis ${remote}`);
      if (req.socket.destroyed) return; // client parti : rien à lui répondre
      setTimeout(ctx.guard(() => {
        // Un seul message générique, quelle que soit la cause ; l'identifiant n'est pas réaffiché.
        sendHtml(res, 401, loginView(csrfCookie, GENERIC_LOGIN_ERROR), [loginCsrfCookie(csrfCookie)]);
      }), ctx.loginFailureDelayMs);
    }).catch((err) => {
      // File argon2 pleine (password.js, MAX_PENDING_ARGON2) : refus immédiat, sans calcul.
      // La page de connexion est réaffichée avec un message, statut 503 et connexion fermée.
      // Aucun cookie n'est posé : le formulaire réutilise le jeton CSRF de connexion de la
      // requête, déjà vérifié ci-dessus (format et égalité avec le champ).
      if (err.code === 'ARGON2_BUSY') {
        ctx.log(`connexion refusée : file argon2 pleine, depuis ${remote}`);
        // Un seul 503 par connexion. Les requêtes enchaînées APRÈS lui sur la même connexion ne
        // reçoivent aucune réponse : HTTP/1.1, après une réponse « Connection: close », le
        // serveur ferme et le client ne doit pas en attendre d'autres. (Les requêtes reçues
        // AVANT lui gardent leur réponse : Node envoie les réponses dans l'ordre, puis ferme.)
        // Sans cela, chaque requête ajouterait une page 503 au tampon d'écriture, derrière les
        // 401 retardés, et Node finirait par couper la connexion par son propre 400.
        if (closingConnections.has(req.socket)) return;
        closingConnections.add(req.socket);
        res.setHeader('Connection', 'close');
        return sendHtml(res, 503, loginView(csrfCookie, BUSY_MESSAGE));
      }
      ctx.fail(err); // chemin asynchrone : toute autre erreur donne un 500, jamais un arrêt
    });
  });
}

function logout(ctx, req, res) {
  const remote = req.socket.remoteAddress ?? '-';
  if (!originMatchesHost(req)) return forbidden(ctx, req, res, 'origin', remote);
  readForm(ctx, req, res, MAX_FORM_BYTES, (form) => {
    const session = currentSession(ctx, req);
    // Sans session valide, aucun jeton CSRF ne peut être valide : 403 comme tout POST non vérifié.
    if (!session || !safeEqual(form.get('csrf'), csrfTokenFor(session.token))) return forbidden(ctx, req, res, 'csrf', remote);
    deleteSession(ctx.db, session.token); // invalidation côté serveur, pas seulement le cookie
    ctx.direct.closeSession(session.token); // flux du direct de cette session fermés aussitôt
    ctx.log(`déconnexion : compte ${session.username}`);
    redirect(res, '/login', [clearCookie(SESSION_COOKIE)]);
  });
}

/**
 * Envoi d'un formulaire de l'application (POST), dans cet ordre :
 *   1. session valide, sinon 303 vers la connexion (corps non lu, rien n'est écrit) :
 *      /login?info=session si un cookie de session était présent (session expirée ou fermée :
 *      la page l'explique), /login sans message si la requête n'en avait aucun ;
 *   2. CSRF, première barrière : Origin égal à ce serveur, sinon 403 avant de lire le corps ;
 *   3. corps lu, plafonné à MAX_EDIT_FORM_BYTES (sinon 413) ;
 *   4. session relue (elle a pu être fermée pendant la lecture, même redirection), puis jeton
 *      CSRF du formulaire comparé en temps constant au jeton dérivé de la session (D-011),
 *      sinon 403 ;
 *   5. onForm(session, form) : seule étape qui peut écrire.
 */
function postForm(ctx, req, res, onForm) {
  const remote = req.socket.remoteAddress ?? '-';
  if (!currentSession(ctx, req)) {
    res.setHeader('Connection', 'close'); // corps non lu : la connexion n'est pas réutilisée
    return redirect(res, loginAfterNoSession(req));
  }
  if (!originMatchesHost(req)) return forbidden(ctx, req, res, 'origin', remote);
  readForm(ctx, req, res, MAX_EDIT_FORM_BYTES, (form) => {
    const session = currentSession(ctx, req);
    if (!session) return redirect(res, loginAfterNoSession(req));
    if (!safeEqual(form.get('csrf'), csrfTokenFor(session.token))) return forbidden(ctx, req, res, 'csrf', remote);
    onForm(session, form);
  });
}

// Fichier de la liste blanche STATIC_FILES (une route n'existe que pour ces chemins exacts).
function sendStatic(res, { body, type, cache }) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.writeHead(200);
  res.end(body);
}

// ---------------------------------------------------------------- requêtes

function currentSession(ctx, req) {
  return findSession(ctx.db, readCookies(req).get(SESSION_COOKIE));
}

/**
 * Compte affiché dans le bandeau, avec le jeton CSRF du formulaire de déconnexion, et le nombre
 * de puces inconnues du compteur de la barre (étape U4, mémorisé : server/chips.js).
 * Défense en profondeur : l'identifiant est échappé par le gabarit, mais il doit en plus
 * respecter le format imposé à la création (sinon exception → 500, rien n'est affiché).
 */
function pageUser(ctx, session) {
  if (!USERNAME_FORMAT.test(session.username)) throw new Error('identifiant de compte hors format');
  // direct : numéro du dernier événement du direct au moment de la page (étape U6) ; app.js ouvre
  // le flux à partir de là (?depuis=), sans rien manquer entre l'affichage et la connexion.
  return { username: session.username, csrf: csrfTokenFor(session.token), chips: ctx.chipsCounter.get(), direct: ctx.direct.lastId };
}

/** Première valeur d'un paramètre de la chaîne de requête, ou null. Décodage tolérant (jamais d'exception). */
function queryParam(req, name) {
  const start = req.url.indexOf('?');
  return start < 0 ? null : new URLSearchParams(req.url.slice(start + 1)).get(name);
}

/** En-tête Cookie → Map nom → valeur (première occurrence d'un nom). */
function readCookies(req) {
  const cookies = new Map();
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!cookies.has(name)) cookies.set(name, part.slice(eq + 1).trim());
  }
  return cookies;
}

/**
 * CSRF, première barrière : un navigateur joint toujours l'en-tête Origin à un POST, et une
 * page d'un autre site ne peut pas le falsifier. Il doit désigner exactement ce serveur
 * (« https:// » + Host tel que demandé par le navigateur). Origin absent : refus.
 * (Node fusionne des en-têtes Origin multiples en « a, b » : la comparaison échoue alors.)
 */
function originMatchesHost(req) {
  const { origin, host } = req.headers;
  return typeof origin === 'string' && typeof host === 'string' && host !== '' && origin === `https://${host}`;
}

/** Lit un corps application/x-www-form-urlencoded plafonné à maxBytes, puis appelle onForm(URLSearchParams). */
function readForm(ctx, req, res, maxBytes, onForm) {
  const [type, ...params] = (req.headers['content-type'] ?? '').split(';');
  if (type.trim().toLowerCase() !== 'application/x-www-form-urlencoded') return sendErrorPage(res, 400, isConnected(ctx, req));
  // Le corps est décodé en UTF-8 : un autre jeu de caractères annoncé est refusé plutôt que
  // mal interprété (un même mot de passe ne doit avoir qu'une seule représentation).
  for (const param of params) {
    const eq = param.indexOf('=');
    const name = (eq < 0 ? param : param.slice(0, eq)).trim().toLowerCase();
    if (name !== 'charset') continue;
    const value = eq < 0 ? '' : param.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1').toLowerCase();
    if (value !== 'utf-8') return sendErrorPage(res, 400, isConnected(ctx, req));
  }
  if (Number(req.headers['content-length']) > maxBytes) return sendErrorPage(res, 413, isConnected(ctx, req));
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('error', (err) => ctx.log(`requête interrompue : ${err.message}`));
  req.on('data', ctx.guard((chunk) => {
    if (aborted) return;
    size += chunk.length;
    if (size > maxBytes) {
      aborted = true;
      req.pause(); // on cesse de lire ; la connexion est fermée après la réponse
      return sendErrorPage(res, 413, isConnected(ctx, req));
    }
    chunks.push(chunk);
  }));
  req.on('end', ctx.guard(() => {
    if (aborted) return;
    onForm(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
  }));
}

// ---------------------------------------------------------------- réponses

// page : fragment produit par html`...` UNIQUEMENT (toute autre valeur : exception → 500).
function sendHtml(res, status, page, cookies = []) {
  if (!isSafeHtml(page)) throw new TypeError('page HTML non produite par le gabarit html');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); // pages avec données de session : jamais en cache
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.writeHead(status);
  res.end(page.toString());
}

// Caractères échappés en \uXXXX dans le JSON envoyé : < > & (défense en profondeur : même
// ouverte comme une page par erreur, la réponse ne contient aucune balise ; nosniff interdit déjà
// au navigateur de la prendre pour du HTML), et les séparateurs de ligne U+2028 et U+2029.
// L'expression est construite à partir des points de code : aucun caractère invisible littéral
// dans ce fichier (test/sources-invisibles.test.js).
const JSON_ESCAPED = new RegExp(`[<>&${String.fromCodePoint(0x2028, 0x2029)}]`, 'g');

/** Réponse JSON (GET /api/recherche) : jamais en cache, échappée (JSON_ESCAPED). */
function sendJson(res, status, value) {
  const body = JSON.stringify(value).replace(JSON_ESCAPED, (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(status);
  res.end(body);
}

// Redirections vers des chemins fixes du site uniquement : aucune cible fournie par le
// client (pas de redirection ouverte).
function redirect(res, location, cookies = []) {
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
  res.writeHead(303);
  res.end();
}

/**
 * Vrai si la requête porte une session valide. Sert UNIQUEMENT à choisir le lien d'une page
 * d'erreur (« Revenir à l'inventaire » ou « Se connecter ») : jamais à autoriser quoi que ce
 * soit. Une page d'erreur ne dit rien d'autre de la ressource demandée.
 */
function isConnected(ctx, req) {
  return currentSession(ctx, req) !== null;
}

// Page d'erreur au texte constant (views.js, errorPage) ; connexion fermée (le corps de la
// requête n'a peut-être pas été lu, et il ne doit pas l'être).
// page : texte à afficher (views.js, ERROR_PAGES), par défaut celui du code HTTP.
function sendErrorPage(res, status, connected, page = status) {
  res.setHeader('Connection', 'close');
  sendHtml(res, status, errorPage(page, connected));
}

/**
 * Erreur interne (500) d'une requête de l'interface web, appelée par server/http.js quand un
 * gestionnaire lève une exception avant d'avoir répondu. Page au texte constant, sans aucun
 * détail (la cause est déjà au journal), connexion fermée. Les en-têtes de sécurité sont
 * reposés : l'exception a pu survenir n'importe où. Les cookies et la redirection
 * éventuellement préparés par le gestionnaire interrompu sont retirés : rien de cette
 * réponse inachevée ne doit partir. Si la session ne peut pas être lue (base en cause),
 * le lien proposé est « Se connecter ».
 */
export function sendInternalError(ctx, req, res) {
  // Réponse déjà partie (en-têtes envoyés) : impossible d'y substituer une page, on coupe.
  if (res.headersSent) return res.destroy();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.removeHeader('Set-Cookie');
  res.removeHeader('Location');
  let connected = false;
  try {
    connected = isConnected(ctx, req);
  } catch {
    connected = false;
  }
  sendErrorPage(res, 500, connected);
}

// Refus CSRF (cause « origin » ou « csrf »). Le journal ne contient que la cause et l'adresse,
// jamais les valeurs reçues (en-têtes, cookies, champs : données de l'attaquant).
function forbidden(ctx, req, res, cause, remote) {
  ctx.log(`requête refusée : ${cause}, depuis ${remote}`);
  res.setHeader('Connection', 'close');
  sendHtml(res, 403, forbiddenPage(isConnected(ctx, req)));
}
