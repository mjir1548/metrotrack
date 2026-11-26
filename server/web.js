// Interface web : connexion, déconnexion, inventaire (liste et fiche), édition des fiches
// (création, modification, suppression, correction de localisation), postes et lecteurs
// (étape 6), puces inconnues et association (étape 7), fichiers statiques (feuilles de style et polices, en liste blanche).
// HTML rendu côté serveur, sans JavaScript côté client, sans ressource externe.
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
import { listItems, getItem, recentScans, parseItemId, parseUid, normalizeQuery } from './inventory.js';
import {
  validateItemInput, createItem, updateItem, deleteItem, correctLocation, listStations, itemHistory, MAX_PROPERTIES,
} from './items.js';
import {
  validateStationInput, createStation, updateStation, deleteStation, stationHistory, stationHasHistory, getStation,
  listStationSummaries, stationReaders, stationItems,
} from './stations.js';
import {
  createReader, assignReader, deactivateReader, replaceReader, listReaders, getReader, readerScans,
} from './readers.js';
import {
  listUnknownChips, getChip, chipPreviousOwner, createItemForChip, associateChip, MAX_ASSOCIATE_RESULTS,
} from './chips.js';
import {
  loginPage as loginView, forbiddenPage, errorPage, inventoryPage, itemPage as itemView, itemNotFoundPage, BUSY_MESSAGE,
  LOGIN_EXPIRED_MESSAGE, SESSION_EXPIRED_MESSAGE,
  itemFormPage, deleteItemPage as deleteView, locationPage as locationView,
  stationsPage, stationPage as stationView, stationFormPage, deleteStationPage as deleteStationView, stationNotFoundPage,
  readersPage, readerPage as readerView, readerFormPage, readerStationPage, deactivateReaderPage as deactivateView,
  replaceReaderPage as replaceView, readerKeyPage, readerNotFoundPage, readerInactivePage, readerIdsExhaustedPage,
  chipsPage, associateSearchPage, associateConfirmPage, chipNotFoundPage, chipKnownPage,
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
// (no-cache), pour qu'une mise à jour du serveur soit vue tout de suite.
// Polices : SIL Open Font License 1.1, licences dans web/static/fonts/OFL-*.txt.
const STATIC_DIR = join(import.meta.dirname, '..', 'web', 'static');
const CSS_TYPE = 'text/css; charset=utf-8';
const FONT_TYPE = 'font/ttf';
const STYLE_CACHE = 'no-cache';
const FONT_CACHE = 'max-age=604800';
const STATIC_FILES = new Map([
  ['/static/style.css', ['style.css', CSS_TYPE, STYLE_CACHE]],
  ['/static/fonts.css', ['fonts.css', CSS_TYPE, STYLE_CACHE]],
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
  '/': { GET: inventory },
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
};
const STATION_ROUTES = {
  '': { GET: stationPage },
  edit: { GET: editStationPage, POST: updateStationAction },
  delete: { GET: deleteStationPage, POST: deleteStationAction },
};
const READER_ROUTES = {
  '': { GET: readerPage },
  station: { GET: readerStationForm, POST: assignReaderAction },
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

// Liste de l'inventaire, avec recherche facultative (?q=).
function inventory(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const query = normalizeQuery(queryParam(req, 'q'));
  const items = listItems(ctx.db, query);
  sendHtml(res, 200, inventoryPage(pageUser(session), { query, items, now: Date.now(), notice: queryParam(req, 'ok') }));
}

// Fiche d'un objet. La session est vérifiée AVANT l'identifiant : sans session, toute adresse
// /items/... redirige vers la connexion, sans révéler si la fiche existe.
// ?ok= : code de confirmation, affiché seulement s'il est connu (views.js, ITEM_NOTICES).
function itemPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  const scans = item.uid_nfc === null ? [] : recentScans(ctx.db, item.uid_nfc);
  const history = itemHistory(ctx.db, item.id);
  sendHtml(res, 200, itemView(user, { item, scans, history, now: Date.now(), notice: queryParam(req, 'ok') }));
}

// ---------------------------------------------------------------- édition des fiches
// Pages GET : session obligatoire. Envois POST : voir postForm (session, Origin, jeton CSRF).
// Une saisie invalide réaffiche le formulaire, avec les valeurs saisies et les erreurs, en 400.
// Une action réussie redirige (303) vers une page fixe avec un code ?ok= constant.

function newItemPage(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const form = { name: '', notes: '', rows: [], blankRows: BLANK_ROWS };
  sendHtml(res, 200, itemFormPage(pageUser(session), { item: null, form, errors: {} }));
}

function createItemAction(ctx, req, res) {
  postForm(ctx, req, res, (session, form) => {
    const valid = submittedItem(ctx, res, pageUser(session), form, null);
    if (!valid) return;
    const id = createItem(ctx.db, session.userId, valid);
    ctx.log(`fiche ${id} créée par ${session.username}`);
    redirect(res, `/items/${id}?ok=cree`);
  });
}

function editItemPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  const rows = item.properties.map(([key, value]) => ({ key, value, error: null }));
  const form = withBlankRows({ name: item.name, notes: item.notes, rows }, BLANK_ROWS);
  sendHtml(res, 200, itemFormPage(user, { item, form, errors: {} }));
}

function updateItemAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
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
  const user = pageUser(session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  sendHtml(res, 200, deleteView(user, { item }));
}

function deleteItemAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(session);
    const id = parseItemId(idText);
    if (id === null || !deleteItem(ctx.db, session.userId, id)) return sendHtml(res, 404, itemNotFoundPage(user));
    ctx.log(`fiche ${id} supprimée par ${session.username}`);
    redirect(res, '/?ok=supprime');
  });
}

function locationPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const item = findItem(ctx, res, user, idText);
  if (!item) return;
  sendHtml(res, 200, locationView(user, { item, stations: listStations(ctx.db) }));
}

function correctLocationAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
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
  sendHtml(res, 200, stationsPage(pageUser(session), { stations: listStationSummaries(ctx.db), notice: queryParam(req, 'ok') }));
}

function stationPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const station = findStation(ctx, res, user, idText);
  if (!station) return;
  sendHtml(res, 200, stationView(user, {
    station,
    readers: stationReaders(ctx.db, station.id),
    items: stationItems(ctx.db, station.id),
    deletable: !stationHasHistory(ctx.db, station.id),
    now: Date.now(),
    notice: queryParam(req, 'ok'),
  }));
}

function newStationPage(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  sendHtml(res, 200, stationFormPage(pageUser(session), { station: null, form: { name: '', description: '' }, errors: {} }));
}

const duplicateStationError = (existing) => `Un poste porte déjà ce nom : « ${existing} » (majuscules et minuscules confondues). Choisissez un autre nom.`;

function createStationAction(ctx, req, res) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
    const result = validateStationInput({ name: form.get('name'), description: form.get('description') });
    if (!result.ok) return sendHtml(res, 400, stationFormPage(user, { station: null, form: result.form, errors: result.errors }));
    const outcome = createStation(ctx.db, session.userId, result.station);
    if (outcome.duplicate !== undefined) {
      return sendHtml(res, 400, stationFormPage(user, { station: null, form: result.form, errors: { name: duplicateStationError(outcome.duplicate) } }));
    }
    ctx.log(`poste ${outcome.id} créé par ${session.username}`);
    redirect(res, `/stations/${outcome.id}?ok=cree`);
  });
}

function editStationPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const station = findStation(ctx, res, user, idText);
  if (!station) return;
  sendHtml(res, 200, stationFormPage(user, { station, form: { name: station.name, description: station.description }, errors: {} }));
}

function updateStationAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
    const station = findStation(ctx, res, user, idText);
    if (!station) return;
    const result = validateStationInput({ name: form.get('name'), description: form.get('description') });
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
  const user = pageUser(session);
  const station = findStation(ctx, res, user, idText);
  if (!station) return;
  sendHtml(res, 200, deleteStationView(user, { station, history: stationHistory(ctx.db, station.id) }));
}

function deleteStationAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(session);
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
  sendHtml(res, 200, readersPage(pageUser(session), { readers: listReaders(ctx.db), now: Date.now() }));
}

function readerPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  sendHtml(res, 200, readerView(user, { reader, scans: readerScans(ctx.db, reader.id), now: Date.now(), notice: queryParam(req, 'ok') }));
}

function newReaderPage(ctx, req, res) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  sendHtml(res, 200, readerFormPage(pageUser(session), { stations: listStations(ctx.db) }));
}

function createReaderAction(ctx, req, res) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
    const stationId = stationChoice(form);
    const outcome = stationId === undefined ? 'no_station' : createReader(ctx.db, session.userId, stationId);
    if (outcome === 'no_station') {
      return sendHtml(res, 400, readerFormPage(user, { stations: listStations(ctx.db), selected: form.get('station') ?? '', error: STATION_GONE }));
    }
    if (outcome === 'ids_exhausted') {
      ctx.log('création de lecteur refusée : plus aucun numéro de lecteur disponible');
      return sendHtml(res, 409, readerIdsExhaustedPage(user));
    }
    ctx.log(`lecteur ${outcome.id} créé par ${session.username}`); // jamais la clé
    sendKeyPage(res, user, outcome, null);
  });
}

function readerStationForm(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  if (reader.active !== 1) return sendHtml(res, 200, readerInactivePage(user, { reader }));
  sendHtml(res, 200, readerStationPage(user, { reader, stations: listStations(ctx.db) }));
}

function assignReaderAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
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

function deactivateReaderPage(ctx, req, res, idText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  if (reader.active !== 1) return sendHtml(res, 200, readerInactivePage(user, { reader }));
  sendHtml(res, 200, deactivateView(user, { reader }));
}

function deactivateReaderAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(session);
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
  const user = pageUser(session);
  const reader = findReader(ctx, res, user, idText);
  if (!reader) return;
  if (reader.active !== 1) return sendHtml(res, 200, readerInactivePage(user, { reader }));
  sendHtml(res, 200, replaceView(user, { reader }));
}

function replaceReaderAction(ctx, req, res, idText) {
  postForm(ctx, req, res, (session) => {
    const user = pageUser(session);
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
function sendKeyPage(res, user, created, oldId) {
  sendHtml(res, 200, readerKeyPage(user, { id: created.id, station: created.station, keyHex: created.key.toString('hex'), oldId }));
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
  sendHtml(res, 200, chipsPage(pageUser(session), { ...listUnknownChips(ctx.db), now: Date.now() }));
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
  const user = pageUser(session);
  const chip = findUnknownChip(ctx, res, user, uidText);
  if (!chip) return;
  const form = { name: '', notes: '', rows: [], blankRows: BLANK_ROWS };
  sendHtml(res, 200, itemFormPage(user, { item: null, chip: withPreviousOwner(ctx, chip), now: Date.now(), form, errors: {} }));
}

function createChipItemAction(ctx, req, res, uidText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
    const chip = findUnknownChip(ctx, res, user, uidText);
    if (!chip) return;
    const valid = submittedItem(ctx, res, user, form, null, chip);
    if (!valid) return;
    const outcome = createItemForChip(ctx.db, session.userId, chip.uid, valid);
    if (chipConflictAnswered(res, user, chip.uid, outcome)) return;
    ctx.log(`fiche ${outcome.id} créée par ${session.username} avec la puce ${chip.uid}`);
    redirect(res, `/items/${outcome.id}?ok=cree_puce`);
  });
}

// « Associer à une fiche existante » : recherche (même logique que l'inventaire), limitée à
// MAX_ASSOCIATE_RESULTS fiches affichées.
function associateSearch(ctx, req, res, uidText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const chip = findUnknownChip(ctx, res, user, uidText);
  if (!chip) return;
  const query = normalizeQuery(queryParam(req, 'q'));
  const found = listItems(ctx.db, query);
  sendHtml(res, 200, associateSearchPage(user, {
    chip, query, items: found.slice(0, MAX_ASSOCIATE_RESULTS), total: found.length, now: Date.now(),
  }));
}

function associateConfirm(ctx, req, res, uidText, itemIdText) {
  const session = currentSession(ctx, req);
  if (!session) return redirect(res, '/login');
  const user = pageUser(session);
  const chip = findUnknownChip(ctx, res, user, uidText);
  if (!chip) return;
  const item = findItem(ctx, res, user, itemIdText);
  if (!item) return;
  sendHtml(res, 200, associateConfirmPage(user, { chip: withPreviousOwner(ctx, chip), item, now: Date.now() }));
}

function associateChipAction(ctx, req, res, uidText, itemIdText) {
  postForm(ctx, req, res, (session, form) => {
    const user = pageUser(session);
    const uid = parseUid(uidText);
    const itemId = parseItemId(itemIdText);
    if (uid === null) return sendHtml(res, 404, chipNotFoundPage(user));
    if (itemId === null) return sendHtml(res, 404, itemNotFoundPage(user));
    // previous : puce de la fiche affichée sur la page de confirmation ('' : aucune).
    const outcome = associateChip(ctx.db, session.userId, uid, itemId, form.get('previous'));
    if (chipConflictAnswered(res, user, uid, outcome)) return;
    if (outcome === 'no_item') return sendHtml(res, 404, itemNotFoundPage(user));
    if (outcome.changed) {
      // La fiche a changé de puce depuis la confirmation : page réaffichée, à jour, sans écriture.
      const chip = withPreviousOwner(ctx, getChip(ctx.db, uid));
      const item = getItem(ctx.db, itemId);
      return sendHtml(res, 409, associateConfirmPage(user, { chip, item, now: Date.now(), changed: true }));
    }
    const replaced = outcome.previousUid === null ? '' : ` (remplace ${outcome.previousUid})`;
    ctx.log(`puce ${uid} associée à la fiche ${outcome.id} par ${session.username}${replaced}`);
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
 * Compte affiché dans le bandeau, avec le jeton CSRF du formulaire de déconnexion.
 * Défense en profondeur : l'identifiant est échappé par le gabarit, mais il doit en plus
 * respecter le format imposé à la création (sinon exception → 500, rien n'est affiché).
 */
function pageUser(session) {
  if (!USERNAME_FORMAT.test(session.username)) throw new Error('identifiant de compte hors format');
  return { username: session.username, csrf: csrfTokenFor(session.token) };
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
