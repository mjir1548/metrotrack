// Pages HTML de l'interface (direction visuelle B « Clair et aéré », D-017). Toutes passent par
// le gabarit html`...` (server/html.js) : chaque valeur interpolée est échappée automatiquement.
// Aucun attribut style, aucune balise <style> ni <script> : la CSP les bloquerait, et toute
// la mise en forme est dans web/static/style.css (polices : web/static/fonts.css).
// Icônes : sprite SVG intégré en tête de page, limité aux symboles utilisés (server/icones.js),
// toujours décoratives.
// Aide « Comment ça marche ? » sous le titre des pages : texte constant, dans server/aide.js.

import { html } from './html.js';
import { formatAge, formatDateTime, formatSince, formatDay, formatDayParts, formatLongDay } from './dates.js';
import { MAX_QUERY_CHARS } from './inventory.js';
import {
  MAX_NAME_CHARS, MAX_NOTES_CHARS, MAX_PROPERTIES, MAX_PROPERTY_KEY_CHARS, MAX_PROPERTY_VALUE_CHARS,
} from './items.js';
import { MAX_STATION_NAME_CHARS, MAX_STATION_DESCRIPTION_CHARS, hasHistory } from './stations.js';
import { MAX_READER_ID, MAX_READER_NAME_CHARS } from './readers.js';
import { AIDE } from './aide.js';
import { HOME_VISIBLE_MOVEMENTS } from './accueil.js';
import { NAV_CHIPS_CAP } from './chips.js';
import { icon, spriteFor } from './icones.js';

export const BUSY_MESSAGE = 'Trop de connexions en cours. Réessayez dans un instant.';
// Page de connexion réaffichée parce que son jeton anti-falsification a expiré (web.js, login).
export const LOGIN_EXPIRED_MESSAGE = 'La page était restée ouverte trop longtemps. Saisissez à nouveau votre mot de passe.';
// Envoi d'un formulaire après expiration de la session (web.js, postForm → /login?info=session).
export const SESSION_EXPIRED_MESSAGE = 'Votre session a expiré. Reconnectez-vous pour continuer.';

// Messages de confirmation après une action. La page reçoit seulement un code constant
// (?ok=cree...) : le texte affiché est toujours l'un de ceux-ci, jamais un texte reçu.
// Code inconnu : aucun message.
const LIST_NOTICES = { supprime: 'Fiche supprimée.' };
const ITEM_NOTICES = {
  cree: 'Fiche créée.',
  modifie: 'Modifications enregistrées.',
  inchange: 'Aucune modification : la fiche était déjà à jour.',
  corrige: 'Emplacement corrigé.',
  cree_puce: 'Fiche créée avec la puce scannée : l\'emplacement suit désormais les scans de cette puce.',
  puce_associee: 'Puce associée : l\'emplacement de la fiche suit désormais cette puce.',
  puce_remplacee: 'Puce remplacée : l\'ancienne puce est détachée, l\'emplacement suit désormais la nouvelle.',
};
const STATION_LIST_NOTICES = { supprime: 'Poste supprimé.' };
const STATION_NOTICES = {
  cree: 'Poste créé.',
  modifie: 'Modifications enregistrées.',
  inchange: 'Aucune modification : le poste était déjà à jour.',
};
const READER_NOTICES = {
  affecte: 'Poste du lecteur modifié. Les scans déjà enregistrés gardent leur poste.',
  inchange: 'Aucune modification : le lecteur était déjà à ce poste.',
  desactive: 'Lecteur désactivé. Ses scans sont désormais refusés.',
  renomme: 'Nom du lecteur enregistré.',
  nom_inchange: 'Aucune modification : le lecteur portait déjà ce nom.',
};

// Marque : pastille + nom. Dans l'application, c'est un lien vers l'accueil.
// Logo officiel (web/static/logo.svg, couleurs de marque), intégré au HTML : sans xmlns ni
// style, décoratif (aria-hidden) puisque le mot « MetroTrack » est écrit à côté.
const LOGO = html`<svg class="logo-image" viewBox="0 0 900 900" aria-hidden="true"><defs><clipPath id="mt-losange"><rect x="167" y="172" width="566" height="566" rx="96" transform="rotate(45 450 455)"></rect></clipPath></defs><g clip-path="url(#mt-losange)"><rect x="0" y="0" width="900" height="900" fill="#0E95A4"></rect><rect x="238" y="455" width="426" height="460" fill="#03245A"></rect></g><circle cx="451" cy="455" r="213" fill="#FFFFFF"></circle><circle cx="451" cy="455" r="114" fill="#03245A"></circle></svg>`;
const BRAND_CONTENT = html`${LOGO}<span>MetroTrack</span>`;

// script : charge web/static/app.js (pages de l'application seulement, D-021). Fichier local,
// différé (defer), sans aucun script en ligne : la CSP default-src 'self' est inchangée.
// icons : icônes à inclure au sprite pour les éléments ajoutés par app.js (icones.js, spriteFor).
function documentPage(title, bodyClass, content, script = false, icons = []) {
  const body = html`<a class="lien-evitement" href="#contenu">Aller au contenu</a>
${content}`;
  return html`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · MetroTrack</title>
<link rel="stylesheet" href="/static/fonts.css">
<link rel="stylesheet" href="/static/style.css">
<link rel="icon" href="/static/logo.svg" type="image/svg+xml">
${script ? html`<script src="/static/app.js" defer></script>
` : null}</head>
<body class="${bodyClass}">
${spriteFor(body, icons)}
${body}
</body>
</html>
`;
}

// ---------------------------------------------------------------- hors session

// Page hors session (connexion, refus, erreurs) : une carte centrée.
function cardLayout(title, content) {
  return documentPage(title, 'page-seule', html`<main id="contenu" class="seule">
<div class="carte carte-seule">
<p class="logo logo--grand">${BRAND_CONTENT}</p>
${content}
</div>
</main>`);
}

/**
 * Page de connexion. message : texte affiché au-dessus du formulaire, ou null.
 * username : identifiant à pré-remplir ('' : aucun). Seul usage : la page réaffichée après
 * l'expiration du jeton de connexion (web.js), avec un identifiant au format autorisé.
 * Le mot de passe n'est jamais réaffiché. Identifiant pré-rempli : le curseur va au mot de passe.
 */
export function loginPage(csrf, message, username = '') {
  const error = message === null ? null : html`<p class="erreur" role="alert">${message}</p>\n`;
  const prefilled = username !== '';
  return cardLayout('Connexion', html`<h1>Connexion</h1>
<p class="sous-titre">Inventaire du matériel</p>
${error}<form class="formulaire" method="post" action="/login">
<input type="hidden" name="csrf" value="${csrf}">
<div class="champ">
<label for="username">Identifiant</label>
<input id="username" name="username"${prefilled ? html` value="${username}"` : null} autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required${prefilled ? null : html` autofocus`}>
</div>
<div class="champ">
<label for="password">Mot de passe</label>
<input id="password" name="password" type="password" autocomplete="current-password" required${prefilled ? html` autofocus` : null}>
</div>
<button class="bouton bouton-large" type="submit">Se connecter</button>
</form>`);
}

/**
 * Refus d'un envoi de formulaire (contrôle anti-falsification, web.js). connected : une session
 * valide accompagne la requête ; le lien mène alors à l'accueil plutôt qu'à la connexion.
 */
export function forbiddenPage(connected = false) {
  return cardLayout('Action refusée', html`<h1>Action refusée</h1>
<p class="sous-titre">La page a peut-être expiré. Rechargez-la puis recommencez.</p>
${connected
    ? html`<a class="bouton" href="/">Revenir à l'accueil</a>`
    : html`<a class="bouton" href="/login">Revenir à la connexion</a>`}`);
}

// Pages d'erreur de l'interface web (web.js, sendErrorPage ; 500 : http.js). Textes constants,
// sans code d'erreur ni détail technique (la cause reste dans le journal du serveur), et sans
// aucune donnée de la requête. Clé : code HTTP, ou '405-adresse' (405 sur une adresse ouverte
// directement, sans formulaire : GET /logout tapé dans la barre d'adresse, par exemple).
const UNREADABLE_FORM = { title: 'Action impossible', text: 'Le formulaire envoyé n\'a pas pu être lu. Revenez en arrière et réessayez.' };
const ERROR_PAGES = {
  400: UNREADABLE_FORM,
  404: { title: 'Page introuvable', text: 'Cette page n\'existe pas ou n\'existe plus.' },
  405: UNREADABLE_FORM,
  '405-adresse': { title: 'Action impossible', text: 'Cette adresse ne s\'ouvre pas directement.' },
  413: {
    title: 'Formulaire trop long',
    text: 'Le texte envoyé dépasse la taille permise. Revenez en arrière : votre saisie est peut-être encore dans la page précédente.',
  },
  500: { title: 'Un problème est survenu', text: 'L\'opération n\'a pas abouti. Réessayez dans un instant.' },
};

/**
 * Page d'erreur pour une clé de ERROR_PAGES. Carte centrée, comme la connexion : elle ne lit
 * rien du compte (pas de bandeau), et peut donc être produite même quand l'erreur vient de là.
 * connected : lien « Revenir à l'accueil » ; sinon « Se connecter ».
 */
export function errorPage(status, connected = false) {
  const { title, text } = ERROR_PAGES[status];
  return cardLayout(title, html`<h1>${title}</h1>
<p class="sous-titre">${text}</p>
${connected
    ? html`<a class="bouton" href="/">Revenir à l'accueil</a>`
    : html`<a class="bouton" href="/login">Se connecter</a>`}`);
}

// ---------------------------------------------------------------- application

// Rubriques du bandeau. Pas de badge « nombre de puces inconnues » sur l'onglet : il serait
// calculé sur chaque page, et son calcul coûte environ 20 ms à 300 000 scans
// (server/chips.js), au-delà du budget fixé.
const SECTION_HOME = 'home';
const SECTION_ITEMS = 'items';
const SECTION_STATIONS = 'stations';
const SECTION_READERS = 'readers';
const SECTION_CHIPS = 'chips';
const NAV = [
  ['/', 'Accueil', SECTION_HOME],
  ['/inventaire', 'Inventaire', SECTION_ITEMS],
  ['/stations', 'Postes', SECTION_STATIONS],
  ['/readers', 'Lecteurs', SECTION_READERS],
  ['/chips', 'Puces inconnues', SECTION_CHIPS],
];

/**
 * Lien du bandeau. Rubrique courante : aria-current="page" sur la liste elle-même,
 * aria-current="true" sur ses sous-pages (fiche, formulaires). La feuille de style signale la
 * rubrique par un fond et une graisse, pas par la couleur seule.
 */
function navLink(href, label, active, exact, extra = null) {
  let current = null;
  if (active) current = exact ? html` aria-current="page"` : html` aria-current="true"`;
  return html`<li><a href="${href}"${current}>${label}${extra}</a></li>`;
}

/**
 * Nombre de « Puces inconnues » dans la barre (étape U4) : absent à zéro, « 200+ » au-delà du
 * plafond du décompte (chips.js, NAV_CHIPS_CAP). app.js le met à jour à chaque événement du direct.
 */
function navChipsCounter(count) {
  const n = Number.isSafeInteger(count) ? count : 0;
  if (n === 0) return null; // app.js l'ajoute si une puce arrive
  return html` <span class="nombre-pastille nombre-pastille--nav" id="nav-puces"><span data-nombre>${n > NAV_CHIPS_CAP ? `${NAV_CHIPS_CAP}+` : n}</span><span class="visuellement-cache"> à traiter</span></span>`;
}

// Initiales du compte pour la pastille (identifiant au format [A-Za-z0-9._-], D-011).
// Identifiant en deux parties (« claire.martin », « jean-pierre_d ») : une lettre de chacune.
function initials(username) {
  const parts = username.split(/[._-]+/).filter((part) => /^[A-Za-z]/.test(part));
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  const letters = username.replace(/[^A-Za-z0-9]/g, '');
  return (letters === '' ? username : letters).slice(0, 2).toUpperCase();
}

/**
 * Page de l'application : bandeau (marque, navigation, recherche, compte, déconnexion) puis
 * contenu.
 * @param {{username: string, csrf: string}} user
 * @param {{section?: string, exact?: boolean, search?: boolean, icons?: string[]}} [options]
 *   section : rubrique active du bandeau ; exact : la page est la liste de cette rubrique ;
 *   search : recherche compacte dans le bandeau (absente de l'inventaire et de l'accueil, qui ont
 *   la leur) ; icons : icônes des éléments ajoutés en direct par app.js (étape U4).
 */
function appLayout(user, title, content, { section = SECTION_ITEMS, exact = false, search = true, icons = [] } = {}) {
  const searchForm = search
    ? html`<form class="recherche-barre" method="get" action="/inventaire" role="search">
${icon('recherche')}
<input name="q" type="search" maxlength="${MAX_QUERY_CHARS}" aria-label="Rechercher un objet dans l'inventaire" placeholder="Où est… ?" autocomplete="off" spellcheck="false">
${SHORTCUT_HINT}
</form>`
    : null;
  return documentPage(title, 'page-app', html`<header class="barre">
<div class="barre-interieur">
<a class="logo" href="/">${BRAND_CONTENT}</a>
<nav class="nav" aria-label="Navigation principale">
<ul>
${NAV.map(([href, label, key]) => navLink(href, label, key === section, exact, key === SECTION_CHIPS ? navChipsCounter(user.chips) : null))}
</ul>
</nav>
<div class="barre-recherche">
${searchForm}
</div>
<div class="compte">
<span class="avatar" aria-hidden="true">${initials(user.username)}</span>
<span class="compte-nom"><span class="visuellement-cache">Connecté en tant que </span><strong>${user.username}</strong></span>
<form method="post" action="/logout">
<input type="hidden" name="csrf" value="${user.csrf}">
<button class="bouton bouton-discret bouton-petit" type="submit">Se déconnecter</button>
</form>
</div>
</div>
</header>
<main id="contenu" class="page">
${content}
</main>`, true, ['fermer', 'attention', 'poste', ...icons]);
}

/**
 * Fil d'Ariane : liens [href, libellé] vers les pages parentes, puis la page courante (texte).
 * Toutes les adresses sont des chemins fixes du site, avec des identifiants lus en base.
 */
const INVENTORY_TRAIL = ['/inventaire', 'Inventaire'];

function trail(links, current) {
  return html`<nav class="fil" aria-label="Fil d'Ariane">
${links.map(([href, label]) => html`<a href="${href}">${label}</a>${icon('chevron')}`)}<span>${current}</span>
</nav>`;
}

/** Message de confirmation pour un code ?ok= connu, sinon rien. */
function noticeFor(notices, code) {
  if (typeof code !== 'string' || !Object.hasOwn(notices, code)) return null;
  return html`<p class="succes" role="status">${notices[code]}</p>\n`;
}

/**
 * Numéro de puce (UID hexadécimal validé ou lu en base au format strict) : groupé par octets
 * (« 04 A1 B2 C3 »), en chasse fixe. Affiché seulement là où il sert (fiche, puces inconnues).
 */
function chipNumber(uid) {
  return uid.match(/../g).join(' ');
}
function chipCode(uid) {
  return html`<span class="uid">${chipNumber(uid)}</span>`;
}

// Emplacement d'une ligne (liste ou fiche) : libellé et état pour la pastille.
function locationOf(row) {
  if (row.at === null) return { label: 'jamais localisé', state: 'jamais' };
  if (row.station_id === null) return { label: 'lecteur non affecté', state: 'inconnue' };
  return { label: row.station_name, state: 'poste' };
}

// Pastille d'emplacement. Scan sur un lecteur non affecté : la pastille mène à la fiche du
// lecteur, où on peut l'affecter à un poste (reader_id : entier lu en base).
function locationBadge(row) {
  const { label, state } = locationOf(row);
  const badge = html`<span class="etat etat-${state}">${label}</span>`;
  return state === 'inconnue' ? html`<a class="lien-etat" href="/readers/${row.reader_id}">${badge}</a>` : badge;
}

// Ancienneté lisible, avec l'horodatage exact pour les machines (datetime) et au survol (title).
// data-age : web/static/app.js recalcule ce texte chaque minute à partir de datetime (étape U4).
function timeTag(iso, now) {
  return html`<time datetime="${iso}" title="${formatDateTime(iso)}" data-age>${formatAge(iso, now)}</time>`;
}

/**
 * Heure d'arrivée à l'emplacement actuel (inventory.js, withLocations), pour « Depuis ».
 * Remontée bornée (arrived_at_bounded = 1) : « au moins » devant l'heure, car l'objet est là
 * depuis plus longtemps encore ; la date exacte au survol est celle du plus ancien scan examiné.
 * bounded : texte placé devant l'heure dans ce cas (« au moins » sous l'en-tête « Depuis »).
 * arrived_at manquant (ne devrait pas arriver) : heure du dernier événement.
 */
function arrivalTag(row, now) {
  const iso = row.arrived_at ?? row.at;
  return html`<time datetime="${iso}" title="${formatDateTime(iso)}">${formatSince(iso, now, row.arrived_at_bounded === 1)}</time>`;
}

/**
 * Résultat de recherche pour GET /api/recherche (objet sérialisé en JSON par web.js, puis
 * affiché par web/static/app.js avec textContent : jamais interprété comme du HTML).
 * Minimisation : ni clé, ni compteur, ni numéro de puce, SAUF quand c'est la puce qui
 * correspond à la saisie (trouve.type = 'puce') ; il est alors groupé par 2, comme à l'écran.
 * Le numéro de lecteur n'est donné que pour « lecteur non affecté » : la pastille mène à sa
 * fiche, comme dans la liste. Les textes de date sont calculés ici, comme dans les pages.
 * @param {object} row ligne de inventory.js (listItems, searchItems), found facultatif
 */
export function searchResult(row, now, { compact = false, withChip = false } = {}) {
  const { label, state } = locationOf(row);
  const place = { etat: state, libelle: label };
  if (state === 'inconnue') place.lecteur = row.reader_id;
  let arrival = null;
  if (row.at !== null) {
    const iso = row.arrived_at ?? row.at;
    const atLeast = row.arrived_at_bounded === 1;
    // « depuis 4 min », « depuis au moins hier à 17:40 » ; exacte : date complète, au survol.
    arrival = { iso, texte: formatSince(iso, now, atLeast), exacte: formatDateTime(iso), auMoins: atLeast };
    // compact (lignes de tableau, &tout=1) : seulement ce qu'affiche une ligne.
    if (!compact) arrival.par = row.arrival_source === 'manual' ? 'correction' : 'scan';
  }
  const result = { id: row.id, nom: row.name, emplacement: place, arrivee: arrival };
  // withChip : page « Associer la puce », qui affiche la puce actuelle de chaque fiche (groupée).
  if (withChip) result.puce = row.uid_nfc === null ? null : chipNumber(row.uid_nfc);
  if (compact) return result;
  if (row.found?.type === 'nom') result.trouve = { type: 'nom' };
  else if (row.found?.type === 'propriete') result.trouve = { type: 'propriete', cle: row.found.key, valeur: row.found.value };
  else if (row.found?.type === 'puce') result.trouve = { type: 'puce', puce: chipNumber(row.uid_nfc) };
  return result;
}

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const thousands = (n) => n.toLocaleString('fr-FR');

/** État vide ou page d'information : encadré centré, icône, texte, action éventuelle. */
function emptyState(iconName, content) {
  return html`<div class="vide">
<span class="vide-icone">${icon(iconName)}</span>
${content}
</div>`;
}

// Indice du raccourci de la palette (affiché par la feuille de style seulement si app.js est
// actif : sans script, le raccourci n'existe pas).
const SHORTCUT_HINT = html`<kbd class="raccourci" aria-hidden="true"><kbd>Ctrl</kbd><kbd>K</kbd></kbd>`;

/**
 * Bouton « Créer la fiche « … » » d'une recherche sans résultat : nouvelle fiche avec ce nom
 * pré-rempli (web.js, newItemPage, ?nom=). SÉCURITÉ : l'adresse est un chemin FIXE du site ; la
 * saisie n'y figure que comme valeur de paramètre, encodée par encodeURIComponent (aucun « & »,
 * « ? », « # » ni schéma possible), puis échappée par le gabarit dans l'attribut.
 * Bouton secondaire : la page a déjà son bouton principal (« Nouvelle fiche »).
 */
function createItemLink(query) {
  return html`<a class="bouton bouton-secondaire" href="/items/new?nom=${encodeURIComponent(query)}">${icon('ajouter')}Créer la fiche «&nbsp;${query}&nbsp;»</a>`;
}

/**
 * Liste de l'inventaire.
 * @param {{query: string, items: object[], now: number, notice?: string|null}} data
 *   notice : code ?ok= reçu (seuls les codes connus affichent un message)
 */
export function inventoryPage(user, { query, items, now, notice = null }) {
  const searching = query !== '';
  const summary = searching
    ? html`<p class="resultats" role="status">${plural(items.length, 'résultat', 'résultats')} pour «&nbsp;${query}&nbsp;» · <a href="/inventaire">Effacer</a></p>`
    : html`<p class="resultats">${plural(items.length, 'objet', 'objets')}</p>`;

  let body;
  if (items.length === 0 && !searching) {
    body = emptyState('objet', html`<p>Aucun objet dans l'inventaire pour le moment.</p>
<p class="texte-doux">Créez la première fiche avec le bouton «&nbsp;Nouvelle fiche&nbsp;».</p>`);
  } else if (items.length === 0) {
    body = emptyState('recherche', html`<p>Aucun objet ne correspond à «&nbsp;${query}&nbsp;».</p>
<p class="texte-doux">Essayez un autre mot du nom ou d'une propriété, ou quelques caractères du numéro de sa puce.</p>
${createItemLink(query)}`);
  } else {
    body = html`<div class="panneau-tableau">
<table class="tableau tableau-inventaire">
<thead><tr><th scope="col">Objet</th><th scope="col">Emplacement</th><th scope="col">Depuis</th></tr></thead>
<tbody>
${items.map((item) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/items/${item.id}">${item.name}</a></td>
<td data-label="Emplacement">${locationBadge(item)}</td>
<td data-label="Depuis">${item.at === null ? html`<span class="texte-doux">—</span>` : arrivalTag(item, now)}</td>
</tr>
`)}</tbody>
</table>
</div>`;
  }

  return appLayout(user, 'Inventaire', html`${noticeFor(LIST_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>Inventaire</h1>
<div class="actions-page">
<a class="bouton" href="/items/new">${icon('ajouter')}Nouvelle fiche</a>
</div>
</div>
${AIDE.inventaire}<form class="recherche recherche--direct" method="get" action="/inventaire" role="search">
${icon('recherche')}
<label class="visuellement-cache" for="q">Rechercher un objet par nom, propriété ou numéro de puce</label>
<input id="q" name="q" type="search" value="${query}" maxlength="${MAX_QUERY_CHARS}" placeholder="Nom, n° de série, numéro de puce…" autocomplete="off" spellcheck="false" aria-controls="inventaire-resultats">
${SHORTCUT_HINT}
<button class="bouton bouton-secondaire" type="submit">Rechercher</button>
</form>
<div id="inventaire-resultats">
${summary}
${body}
</div>`, { exact: true, search: false });
}

/**
 * Lieu cliquable : le nom du poste, lien discret vers sa fiche (/stations/<id>, identifiant lu
 * en base) ; « Lecteur non affecté » mène au lecteur, pour le rattacher à un poste.
 */
function placeLink(row, unassignedLabel = 'Lecteur non affecté') {
  if (row.station_id === null) return html`<a class="lien-simple lien-discret" href="/readers/${row.reader_id}">${unassignedLabel}</a>`;
  return html`<a class="lien-simple lien-discret" href="/stations/${row.station_id}">${row.station_name ?? 'poste supprimé'}</a>`;
}

/**
 * Emplacement actuel en grand, en tête de la fiche d'un objet : le poste (lien vers sa fiche),
 * puis « depuis 6 h · aujourd'hui à 16:06 » et UN badge qui dit d'où vient l'information, avec
 * son heure ou son auteur (icône ET texte) : « Scanné il y a 4 min », « Corrigé à la main par … ».
 */
function currentPlace(item, now) {
  // Fiche sans puce : « Donner une puce » est proposé ici, là où l'on cherche l'emplacement.
  const giveChip = html`<a class="bouton bouton-secondaire bouton-petit" href="/items/${item.id}/puce">${icon('puce')}Donner une puce</a>`;
  if (item.at === null) {
    if (item.uid_nfc === null) {
      return html`<p class="emplacement emplacement--vide">${icon('poste')}${locationBadge(item)}</p>
<p class="texte-doux">Aucune puce : l'objet ne peut pas être localisé par un scan. Donnez-lui une puce, ou corrigez son emplacement à la main.</p>
<p class="entete-action">${giveChip}</p>`;
    }
    return html`<p class="emplacement emplacement--vide">${icon('poste')}${locationBadge(item)}</p>
<p class="texte-doux">Cette puce n'a encore été scannée sur aucun poste.</p>`;
  }
  const badge = item.source === 'manual'
    ? html`<span class="badge badge--main">${icon('main')}Corrigé à la main par ${item.corrected_by ?? 'un compte inconnu'}</span>`
    // Heure du dernier scan seulement si elle diffère de l'arrivée (rescans au même poste) :
    // sinon « depuis … » la donne déjà (étape U4, revue UX).
    : html`<span class="badge badge--ok">${icon('lecteur')}Scanné${(item.arrived_at ?? item.at) === item.at ? null : html` ${timeTag(item.at, now)}`}</span>`;
  const unassigned = item.station_id === null;
  const place = unassigned
    ? html`<p class="emplacement emplacement--attention">${icon('attention')}${locationBadge(item)}</p>`
    : html`<p class="emplacement emplacement--xl">${icon('poste')}<a class="lien-simple lien-discret" href="/stations/${item.station_id}">${locationBadge(item)}</a></p>`;
  return html`${place}
<p class="localisation-detail"><span>${sinceForSheet(item, now)}</span>${badge}</p>
${unassigned ? html`<p class="note-emplacement">Le lecteur qui a scanné l'objet n'est rattaché à aucun poste. <a href="/readers/${item.reader_id}">Rattacher ce lecteur à un poste</a></p>\n` : null}${item.uid_nfc === null ? html`<p class="note-emplacement">Sans puce, l'objet n'est pas suivi par les lecteurs : seule une correction à la main change son emplacement.</p>
<p class="entete-action">${giveChip}</p>\n` : null}`;
}

/**
 * « depuis 6 h · aujourd'hui à 16:06 » (fiche d'un objet) : l'heure exacte est ajoutée quand
 * « depuis » ne la donne pas déjà ; « à l'instant » pour une arrivée de moins d'une minute.
 * Remontée bornée : « depuis au moins … ».
 */
function sinceForSheet(row, now) {
  const iso = row.arrived_at ?? row.at;
  const atLeast = row.arrived_at_bounded === 1;
  let since = formatSince(iso, now, atLeast);
  const elapsed = now - Date.parse(iso);
  if (!atLeast && elapsed >= -60_000 && elapsed < 60_000) since = 'à l\'instant';
  const day = formatDay(iso, now);
  return html`<time datetime="${iso}" title="${formatDateTime(iso)}">${since}</time>${since.endsWith(day) ? null : html` · ${day}`}`;
}

// ---------------------------------------------------------------- frise des déplacements (U3)

/** Colonne de gauche d'une étape : « Aujourd'hui » / « Hier » / date, et l'heure en dessous. */
function timelineWhen(iso, now) {
  const { day, time } = formatDayParts(iso, now);
  return html`<p class="frise-quand"><time datetime="${iso}" title="${formatDateTime(iso)}">${day}<small>${time}</small></time></p>`;
}

const CHIP_CHANGES = { donnee: 'Puce donnée', changee: 'Puce changée', retiree: 'Puce retirée' };

/**
 * Une étape de la frise (server/timeline.js) : arrivée scannée (scans consécutifs regroupés),
 * correction à la main (icône main ET texte, encadré pointillé), changement de puce (icône puce
 * ET texte), ou création de la fiche. entry.current : badge « Emplacement actuel » ; fresh :
 * correction qui vient d'être enregistrée (classe « nouveau » : mise en évidence quelques
 * secondes, voir style.css).
 */
function timelineEntry(entry, now, { fresh = false } = {}) {
  const current = entry.current === true;
  const classes = ['frise-etape'];
  if (current) classes.push('frise-etape--actuel');
  if (entry.type === 'correction') classes.push('frise-etape--main');
  if (entry.type === 'chip') classes.push('frise-etape--puce');
  if (entry.type === 'creation') classes.push('frise-etape--creation');
  if (fresh) classes.push('nouveau');
  const here = current ? html` <span class="badge badge--ok">${icon('poste')}Emplacement actuel</span>` : null;
  let when = entry.at;
  let node;
  let body;
  if (entry.type === 'scan') {
    when = entry.arrived_at;
    node = 'lecteur';
    // Lecteur nommé (D-019) : « Scanné par <nom> » (nom ACTUEL du lecteur de l'arrivée).
    const by = entry.reader_name === '' || entry.reader_name === null
      ? null
      : html` par ${readerLabel({ id: entry.reader_id, name: entry.reader_name, station_id: null })}`;
    const count = entry.count > 1
      ? html`<p class="frise-suite">${entry.bounded ? 'Au moins ' : ''}${thousands(entry.count)} scans ici · le dernier ${timeTag(entry.last_at, now)}</p>\n`
      : null;
    body = html`<p class="frise-lieu">${placeLink(entry)}</p>
<p class="frise-detail">Scanné${by}${here}</p>
${count}`;
  } else if (entry.type === 'correction') {
    node = 'main';
    body = html`<p class="frise-lieu">${placeLink(entry)}</p>
<p class="frise-detail">${icon('main')}<span><strong>Corrigé à la main</strong> par ${entry.username ?? 'un compte inconnu'}</span>${here}</p>
`;
  } else if (entry.type === 'chip') {
    node = 'puce';
    let what = null;
    if (entry.change === 'changee') what = html` : ${chipCode(entry.uid)}${entry.previous ? html` (remplace ${chipCode(entry.previous)})` : null}`;
    else if (entry.change === 'donnee') what = html` : ${chipCode(entry.uid)}`;
    else if (entry.previous) what = html` : ${chipCode(entry.previous)}`;
    body = html`<p class="frise-lieu">${CHIP_CHANGES[entry.change]}${what}</p>
<p class="frise-detail">${icon('puce')}<span>par ${entry.username ?? 'l\'outil d\'administration'}</span></p>
`;
  } else {
    node = 'ajouter';
    const by = entry.known ? html` par ${entry.username ?? 'l\'outil d\'administration'}` : null;
    body = html`<p class="frise-lieu">Fiche créée${by}</p>
`;
  }
  return html`<li class="${classes.join(' ')}">
${timelineWhen(when, now)}
<span class="frise-noeud">${icon(node)}</span>
<div class="frise-contenu">
${body}</div>
</li>
`;
}

/**
 * Frise des déplacements. fresh : une correction vient d'être enregistrée (?ok=corrige) : la
 * correction en tête est mise en évidence.
 */
function timelineList(entries, now, { fresh = false } = {}) {
  return html`<ol class="frise">
${entries.map((entry, i) => timelineEntry(entry, now, { fresh: fresh && i === 0 && entry.type === 'correction' }))}</ol>`;
}

/** Phrase au-dessus d'une frise sans déplacement (seulement la création, et des repères). */
function noMoveHint(item, entries) {
  if (entries.some((entry) => entry.type === 'scan' || entry.type === 'correction')) return null;
  const text = item.uid_nfc === null
    ? 'Aucun déplacement : l\'objet n\'a pas de puce. Donnez-lui une puce pour suivre ses passages devant les lecteurs.'
    : 'Aucun déplacement pour l\'instant : la puce n\'a encore été scannée sur aucun lecteur.';
  return html`<p class="texte-doux frise-vide">${text}</p>\n`;
}

/**
 * Libellé de modification (items.js, changeLabels) : texte, ou segments dont les UID {uid} sont
 * affichés groupés, en chasse fixe. Chaque segment passe par le gabarit (échappé).
 */
function changeLabel(label) {
  if (!Array.isArray(label)) return label;
  return label.map((part) => (typeof part === 'string' ? part : chipCode(part.uid)));
}

/** Carte repliable « Modifications de la fiche » (nom, propriétés, notes, puce). */
function changesCard(changes, now) {
  const body = changes.length === 0
    ? html`<p class="texte-doux">Aucune modification depuis la création de la fiche.</p>`
    : html`<ul class="modifications-liste">
${changes.map((change) => html`<li>
<p class="modification-quoi">${change.labels.map((label, i) => html`${i > 0 ? ' · ' : null}${changeLabel(label)}`)}</p>
<p class="modification-qui">par ${change.username ?? 'l\'outil d\'administration'} · ${timeTag(change.at, now)}</p>
</li>
`)}</ul>`;
  return html`<details class="carte modifications">
<summary class="carte-titre">${icon('modifier')}Modifications de la fiche${changes.length === 0 ? null : html` <span class="compte-titre">${changes.length}</span>`}${icon('chevron')}</summary>
<div class="modifications-corps">
${body}
</div>
</details>`;
}

// Correction d'emplacement : boutons radio jusqu'à ce nombre de postes, liste déroulante au-delà.
const MAX_RADIO_STATIONS = 12;

/**
 * Choix du poste (champ « station »), commun à la page « Corriger l'emplacement » et au panneau
 * de la fiche : un bouton radio par poste s'il y en a peu (un seul clic), sinon une liste
 * déroulante. prefix : préfixe des id (deux formulaires peuvent coexister sur une page) ;
 * currentId : poste actuel de l'objet, signalé « actuel » (non présélectionné : choisir ce
 * poste n'est presque jamais l'intention).
 */
function stationChoice({ stations, selected = null, error = null, prefix = 'station', currentId = null, hasChip = true }) {
  const help = `${prefix}-aide`;
  const errorId = `${prefix}-erreur`;
  // Objet sans puce : aucun scan ne remplacera la correction, la phrase ne l'évoque pas.
  const helpText = hasChip
    ? 'La correction s\'applique tout de suite. Le prochain scan de l\'objet la remplacera.'
    : 'La correction s\'applique tout de suite.';
  const mark = (station) => (station.id === currentId ? html` <span class="choix-actuel">actuel</span>` : null);
  if (stations.length <= MAX_RADIO_STATIONS) {
    return html`<fieldset class="champ choix-postes" aria-describedby="${describedBy(help, errorId, error)}">
<legend>Poste où se trouve l'objet</legend>
<div class="choix-liste">
${stations.map((station) => html`<label class="choix-poste" for="${prefix}-${station.id}"><input type="radio" name="station" value="${station.id}" required${String(station.id) === selected ? html` checked` : null}${invalid(error)} id="${prefix}-${station.id}"><span>${station.name}</span>${mark(station)}</label>
`)}</div>
<p class="aide" id="${help}">${helpText}</p>
${fieldError(errorId, error)}</fieldset>`;
  }
  return html`<div class="champ">
<label for="${prefix}">Poste où se trouve l'objet</label>
<select id="${prefix}" name="station" required aria-describedby="${describedBy(help, errorId, error)}"${invalid(error)}>
<option value="">Choisir un poste…</option>
${stations.map((station) => html`<option value="${station.id}"${String(station.id) === selected ? html` selected` : null}>${station.name}${station.id === currentId ? ' (actuel)' : null}</option>
`)}</select>
<p class="aide" id="${help}">${helpText}</p>
${fieldError(errorId, error)}</div>`;
}

/**
 * Panneau « Corriger l'emplacement » de la fiche (<dialog>, ouvert par web/static/app.js). Même
 * formulaire POST que la page /items/<id>/location (jeton CSRF compris) : sans JavaScript, le
 * bouton de la fiche mène à cette page et le panneau reste fermé (donc invisible).
 */
function correctionDialog(user, item, stations) {
  const body = stations.length === 0
    ? html`<p>Aucun poste n'existe encore. Créez d'abord un poste pour pouvoir y localiser un objet.</p>
<div class="actions-formulaire">
<a class="bouton" href="/stations/new">Créer un poste</a>
<button class="lien-annuler bouton-texte" type="button" data-fermer>Annuler</button>
</div>`
    : html`<form method="post" action="/items/${item.id}/location">
<input type="hidden" name="csrf" value="${user.csrf}">
${stationChoice({ stations, prefix: 'panneau-station', currentId: item.station_id, hasChip: item.uid_nfc !== null })}
<div class="actions-formulaire">
<button class="bouton" type="submit">Enregistrer</button>
<button class="lien-annuler bouton-texte" type="button" data-fermer>Annuler</button>
</div>
</form>`;
  return html`<dialog class="dialogue" id="dialogue-corriger" aria-labelledby="dialogue-corriger-titre">
<div class="dialogue-entete">
<h2 id="dialogue-corriger-titre">Corriger l'emplacement</h2>
<button class="bouton bouton-discret bouton-icone" type="button" data-fermer aria-label="Fermer">${icon('fermer')}</button>
</div>
<p class="dialogue-intro">Où se trouve «&nbsp;${item.name}&nbsp;» maintenant ?</p>
${body}
</dialog>`;
}

/**
 * Fiche d'un objet (étape U3, maquette B) : en-tête « identité + emplacement », propriétés,
 * notes, identification, modifications ; à droite, la frise des déplacements.
 * @param {{item: object, timeline?: {entries: object[], next: string|null}, changes?: object[],
 *   stations?: {id: number, name: string}[], now: number, notice?: string|null}} data
 *   timeline : server/timeline.js ; changes : items.js, itemChanges ; stations : choix du
 *   panneau de correction ; notice : code ?ok= reçu.
 */
export function itemPage(user, { item, timeline = { entries: [], next: null }, changes = [], stations = [], now, notice = null }) {
  const properties = item.properties.length === 0
    ? html`<p class="texte-doux">Aucune propriété. <a class="lien-simple" href="/items/${item.id}/edit">Ajouter des propriétés</a></p>`
    : html`<dl class="proprietes">
${item.properties.map(([key, value]) => html`<div><dt>${key}</dt><dd>${value}</dd></div>
`)}</dl>`;

  const notes = item.notes.trim() === ''
    ? html`<p class="texte-doux">Aucune note</p>`
    : html`<p class="notes">${item.notes}</p>`;

  const hasChip = item.uid_nfc !== null;
  const identification = hasChip
    ? html`<p class="numero-puce"><span class="etiquette">Numéro de puce</span><span class="numero-puce-droite">${chipCode(item.uid_nfc)} <a class="lien-simple" href="/items/${item.id}/puce">Changer</a></span></p>`
    : html`<p class="texte-doux">Aucune puce. <a class="lien-simple" href="/items/${item.id}/puce">Donner une puce</a></p>`;

  // Correction réussie : le message nomme le poste, lu en base (emplacement actuel de la fiche,
  // que la correction vient de fixer) ; le code ?ok= reste un code constant.
  const corrected = notice === 'corrige' && item.source === 'manual' && item.station_name;
  let noticeHtml = noticeFor(ITEM_NOTICES, notice);
  if (corrected) noticeHtml = html`<p class="succes" role="status">Emplacement corrigé : ${item.station_name}</p>\n`;
  // Retrait de puce : le message dit l'emplacement qui reste (lu en base ; codes constants).
  if (notice === 'puce_retiree_gardee' && item.station_name) noticeHtml = html`<p class="succes" role="status">Puce retirée. Emplacement conservé : ${item.station_name}.</p>\n`;
  if (notice === 'puce_retiree') noticeHtml = html`<p class="succes" role="status">Puce retirée. Emplacement : ${locationOf(item).label}.</p>\n`;
  const more = timeline.next === null
    ? null
    : html`<p class="frise-tout"><a class="bouton bouton-discret bouton-petit" href="/items/${item.id}/historique">${icon('historique')}Voir tout l'historique</a></p>\n`;
  return appLayout(user, item.name, html`${trail([INVENTORY_TRAIL], item.name)}
${noticeHtml}<div class="carte fiche-entete">
<div class="fiche-entete-haut">
<div class="fiche-titre">${icon('objet')}<h1>${item.name}</h1></div>
<div class="actions-page fiche-actions">
<a class="bouton" href="/items/${item.id}/location" data-dialogue="corriger">${icon('deplace')}Corriger l'emplacement</a>
<a class="bouton bouton-secondaire" href="/items/${item.id}/edit">${icon('modifier')}Modifier la fiche</a>
<details class="menu">
<summary class="bouton bouton-secondaire bouton-icone" aria-label="Plus d'actions" title="Plus d'actions">${icon('options')}</summary>
<div class="menu-panneau">
${hasChip ? html`<a class="menu-item" href="/items/${item.id}/puce">${icon('puce')}Changer de puce</a>
<a class="menu-item" href="/items/${item.id}/retirer-puce">${icon('puce')}Retirer la puce…</a>
` : null}<a class="menu-item menu-item-danger" href="/items/${item.id}/delete">${icon('supprimer')}Supprimer la fiche…</a>
</div>
</details>
</div>
</div>
<p class="etiquette">Emplacement actuel</p>
${currentPlace(item, now)}
</div>
${AIDE.fiche}<div class="fiche">
<div class="fiche-colonne">
<section class="carte carte-corps" aria-labelledby="titre-proprietes">
<h2 id="titre-proprietes" class="carte-titre">${icon('reglages')}Propriétés</h2>
${properties}
</section>
<section class="carte carte-corps" aria-labelledby="titre-notes">
<h2 id="titre-notes" class="carte-titre">${icon('note')}Notes</h2>
${notes}
</section>
<section class="carte carte-corps" aria-labelledby="titre-identification">
<h2 id="titre-identification" class="carte-titre">${icon('puce')}Identification</h2>
${identification}
</section>
${changesCard(changes, now)}
</div>
<section class="carte carte-corps carte-historique" aria-labelledby="titre-historique">
<h2 id="titre-historique" class="carte-titre">${icon('historique')}Historique des déplacements</h2>
${noMoveHint(item, timeline.entries)}${timelineList(timeline.entries, now, { fresh: Boolean(corrected) })}
${more}</section>
</div>
${correctionDialog(user, item, stations)}`);
}

/**
 * Tout l'historique des déplacements d'un objet, par pages (curseur ?avant=, timeline.js).
 * @param {{item: object, timeline: {entries: object[], next: string|null}, first: boolean, now: number}} data
 *   first : page la plus récente (sans curseur).
 */
export function itemHistoryPage(user, { item, timeline, first, now }) {
  const base = `/items/${item.id}/historique`;
  const links = [];
  if (!first) links.push(html`<a class="bouton bouton-secondaire bouton-petit" href="${base}">Revenir aux plus récents</a>`);
  if (timeline.next !== null) links.push(html`<a class="bouton bouton-secondaire bouton-petit" href="${base}?avant=${encodeURIComponent(timeline.next)}">Déplacements plus anciens${icon('chevron')}</a>`);
  return appLayout(user, `Historique · ${item.name}`, html`${trail([INVENTORY_TRAIL, [`/items/${item.id}`, item.name]], 'Historique')}
<div class="entete-page">
<h1>Historique des déplacements</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.historique}<section class="carte carte-corps" aria-label="Déplacements">
${first ? noMoveHint(item, timeline.entries) : null}${timelineList(timeline.entries, now)}
</section>
<nav class="pagination" aria-label="Pages de l'historique">
<a class="lien-annuler" href="/items/${item.id}">Retour à la fiche</a>
${links}
</nav>`);
}

/**
 * « Donner une puce » / « Changer de puce » depuis la fiche (étape U3) : les puces inconnues les
 * plus récemment scannées. Le choix réutilise l'association de l'étape 7 (mêmes contrôles,
 * même audit, même 409) :
 *   - fiche sans puce et puce neuve : « Choisir cette puce » envoie directement le formulaire
 *     d'association (POST /chips/<UID>/associate/<id>, previous vide, jeton CSRF) ;
 *   - fiche qui a déjà une puce (remplacement), ou puce qui a déjà servi à une autre fiche :
 *     le bouton mène à la page de confirmation, qui affiche l'avertissement correspondant.
 * @param {{item: object, chips: object[], more: boolean, owners: Map<string, object>, now: number}} data
 *   chips, more : chips.js, listUnknownChips ; owners : chips.js, chipPreviousOwners.
 */
// Puce scannée depuis moins de ce délai : « Scannée à l'instant » (c'est sans doute celle qu'on vient de poser).
const FRESH_CHIP_MS = 2 * 60_000;

export function giveChipPage(user, { item, chips, more, owners, now }) {
  const replacing = item.uid_nfc !== null;
  const title = replacing ? 'Changer de puce' : 'Donner une puce';
  const self = `/items/${item.id}/puce`;
  const choose = (chip, primary) => {
    const style = primary ? 'bouton bouton-petit' : 'bouton bouton-secondaire bouton-petit';
    const action = `/chips/${chip.uid}/associate/${item.id}`;
    if (replacing || owners.has(chip.uid)) return html`<a class="${style}" href="${action}?depuis=fiche">${icon('associer')}Choisir cette puce</a>`;
    return html`<form method="post" action="${action}">
<input type="hidden" name="csrf" value="${user.csrf}">
<input type="hidden" name="previous" value="">
<button class="${style}" type="submit">${icon('associer')}Choisir cette puce</button>
</form>`;
  };
  // Sans puce à proposer : la liste (vide, masquée) attend la puce scannée, ajoutée en direct par
  // app.js ; sans script, « Actualiser » recharge la page.
  const body = chips.length === 0
    ? html`<ul class="carte liste-puces" id="puces-offertes" hidden></ul>
${emptyState('puce', html`<p>Aucune puce inconnue pour l'instant. Scannez la nouvelle puce sur un lecteur : elle apparaîtra ici.</p>
<a class="bouton" href="${self}">Actualiser</a>`)}`
    : html`<ul class="carte liste-puces" id="puces-offertes">
${chips.map((chip, i) => html`<li class="encart" data-uid="${chip.uid}">
<span class="encart-icone">${icon('puce')}</span>
<div class="encart-corps">
<p class="encart-texte">Puce ${chipCode(chip.uid)}</p>
<p class="encart-meta">${now - Date.parse(chip.received_at) < FRESH_CHIP_MS ? html`<span class="badge badge--ok">Scannée à l'instant</span> ` : html`Scannée ${timeTag(chip.received_at, now)} · `}${chipBadge(chip)}${owners.has(chip.uid) ? ' · a déjà servi pour une autre fiche' : null}</p>
</div>
<div class="groupe-boutons">
${choose(chip, i === 0)}
</div>
</li>
`)}</ul>
${more ? html`<p class="resultats">Seules les ${chips.length} puces scannées le plus récemment sont affichées.</p>\n` : null}`;
  return appLayout(user, title, html`${trail([INVENTORY_TRAIL, [`/items/${item.id}`, item.name]], title)}
<div class="entete-page">
<h1>${title}</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.donnerPuce}<p class="intro-action">Scannez la puce sur n'importe quel lecteur, puis choisissez-la ici. <a href="${self}">Actualiser</a></p>
${replacing ? html`<div class="panneau panneau-info" role="note"><p>Puce actuelle : ${chipCode(item.uid_nfc)}. L'historique est conservé ; les prochains scans viendront de la nouvelle puce.</p></div>\n` : null}${body}
<p class="alternative"><a class="lien-annuler" href="/items/${item.id}">Retour à la fiche</a></p>`, { icons: ['puce', 'associer'] });
}

/**
 * Confirmation « Retirer la puce » (étape U3). La phrase dit ce qui va se passer pour
 * l'emplacement :
 *   - emplacement donné par un scan, à un poste : case COCHÉE « Garder « Poste B » comme
 *     emplacement » (une correction vers ce poste est alors enregistrée avec le retrait) ;
 *   - scan sur un lecteur non affecté : pas de case (on ne corrige pas vers un non-poste) ;
 *   - emplacement corrigé à la main : il ne change pas.
 * fallback : poste de la dernière correction de la fiche (emplacement sans la puce), ou null.
 * changed : l'envoi précédent a été refusé (la fiche a changé entre-temps) : page réaffichée en 409.
 */
export function detachChipPage(user, { item, changed = false, fallback = null }) {
  const after = fallback === null ? 'jamais localisé' : fallback;
  let consequence = null;
  let keep = null;
  if (item.uid_nfc !== null && item.source === 'scan' && item.station_id !== null) {
    keep = html`<div class="champ case-garder">
<input type="hidden" name="poste" value="${item.station_id}">
<label class="case" for="garder"><input type="checkbox" id="garder" name="garder" value="1" checked aria-describedby="garder-aide"><span>Garder «&nbsp;${item.station_name}&nbsp;» comme emplacement</span></label>
<p class="aide" id="garder-aide">Sinon, l'emplacement deviendra «&nbsp;${after}&nbsp;».</p>
</div>
`;
  } else if (item.uid_nfc !== null && item.source === 'scan') {
    consequence = html` L'emplacement affiché deviendra «&nbsp;${after}&nbsp;».`;
  } else if (item.uid_nfc !== null && item.source === 'manual') {
    consequence = html` L'emplacement «&nbsp;${item.station_name}&nbsp;», corrigé à la main, ne change pas.`;
  }
  const body = item.uid_nfc === null
    ? emptyState('puce', html`<p>Cette fiche n'a pas de puce : il n'y a rien à retirer.</p>
<a class="bouton" href="/items/${item.id}">Retour à la fiche</a>`)
    : html`<div class="panneau panneau-danger">
<p>La puce ${chipCode(item.uid_nfc)} sera détachée de cette fiche et redeviendra inconnue.${consequence}</p>
<form method="post" action="/items/${item.id}/retirer-puce">
<input type="hidden" name="csrf" value="${user.csrf}">
<input type="hidden" name="previous" value="${item.uid_nfc}">
${keep}<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Retirer la puce</button>
<a class="lien-annuler" href="/items/${item.id}">Annuler</a>
</div>
</form>
</div>`;
  return appLayout(user, 'Retirer la puce', html`${trail([INVENTORY_TRAIL, [`/items/${item.id}`, item.name]], 'Retirer la puce')}
<div class="entete-page">
<h1>Retirer la puce</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.retirerPuce}${changed ? html`<p class="erreur" role="alert">La puce de la fiche a changé depuis l'affichage de la page précédente : rien n'a été modifié. Vérifiez ci-dessous.</p>\n` : null}${body}`);
}

/**
 * Page « introuvable » d'une fiche, d'un poste ou d'un lecteur : une phrase, et deux issues.
 * « Chercher un objet » ouvre la palette si app.js est actif (data-palette), sinon l'inventaire
 * et sa recherche.
 */
function notFoundPage(user, { title, text, parents, layout, iconName }) {
  return appLayout(user, title, html`${trail(parents, title)}
${emptyState(iconName, html`<h1>${title}</h1>
<p>${text}</p>
<div class="groupe-boutons">
<a class="bouton" href="/inventaire" data-palette="ouvrir">${icon('recherche')}Chercher un objet</a>
<a class="bouton bouton-secondaire" href="/inventaire">Retour à l'inventaire</a>
</div>`)}`, layout);
}

export function itemNotFoundPage(user) {
  return notFoundPage(user, {
    title: 'Fiche introuvable', text: 'Cette fiche n\'existe pas ou a été supprimée.', parents: [INVENTORY_TRAIL], layout: undefined, iconName: 'objet',
  });
}

// ---------------------------------------------------------------- édition

// Message d'erreur près d'un champ (id référencé par aria-describedby du champ).
function fieldError(id, message) {
  return message ? html`<p class="erreur-champ" id="${id}">${message}</p>\n` : null;
}
const invalid = (message) => (message ? html` aria-invalid="true"` : null);
// Valeur de aria-describedby : l'aide, plus le message d'erreur s'il existe.
const describedBy = (helpId, errorId, message) => (message ? `${helpId} ${errorId}` : helpId);

const EMPTY_ROW = { key: '', value: '', error: null };

/**
 * Formulaire de création ou de modification d'une fiche.
 * @param {{
 *   item: {id: number|bigint, name: string}|null,
 *   form: {name: string, notes: string, rows: {key: string, value: string, error: string|null}[], blankRows: number},
 *   errors: {name?: string, notes?: string, properties?: string},
 * }} data
 *   item : null pour une création ; sinon la fiche modifiée (nom actuellement enregistré) ;
 *   form : valeurs à afficher (saisies nettoyées, ou fiche enregistrée), puis blankRows lignes vides ;
 *   chip : création depuis une puce inconnue (étape 7) : la puce (chips.js, getChip), affichée
 *   en lecture seule. Son UID est dans l'adresse du formulaire, jamais dans un champ ;
 *   now : heure actuelle (ms), pour l'ancienneté du dernier scan de la puce.
 */
export function itemFormPage(user, { item, form, errors, chip = null, now = Date.now() }) {
  const editing = item !== null;
  let action = '/items/new';
  let cancel = '/inventaire';
  let parents = [INVENTORY_TRAIL];
  if (editing) {
    action = `/items/${item.id}/edit`;
    cancel = `/items/${item.id}`;
    parents = [INVENTORY_TRAIL, [cancel, item.name]];
  } else if (chip !== null) {
    action = `/chips/${chip.uid}/new`;
    cancel = '/chips';
    parents = [['/chips', 'Puces inconnues']];
  }
  const title = editing ? 'Modifier la fiche' : 'Nouvelle fiche';
  let help = AIDE.nouvelleFiche;
  if (editing) help = AIDE.modifierFiche;
  else if (chip !== null) help = AIDE.ficheDepuisPuce;
  const failed = Object.keys(errors).length > 0 || form.rows.some((row) => row.error !== null);
  const rows = [...form.rows, ...Array(form.blankRows).fill(EMPTY_ROW)];
  const chipField = chip === null ? null : html`<div class="champ">
<p class="libelle">Puce</p>
<p class="puce-lecture">${icon('puce')}${chipCode(chip.uid)}</p>
<p class="aide">Dernier scan : ${chipPlace(chip)}, ${timeTag(chip.received_at, now)}. Dès la création, l'objet est localisé à ce scan.</p>
</div>
`;

  return appLayout(user, title, html`${trail(parents, title)}
<div class="entete-page">
<h1>${title}</h1>
${editing ? html`<p class="sous-titre-page">${item.name}</p>\n` : null}</div>
${help}${failed ? html`<p class="erreur" role="alert">La fiche n'a pas été enregistrée. Corrigez les champs signalés ci-dessous : votre saisie est conservée.</p>\n` : null}${chip === null ? null : reuseWarning(chip)}<form class="formulaire-page" method="post" action="${action}">
<input type="hidden" name="csrf" value="${user.csrf}">
${chipField}<div class="champ">
<label for="name">Nom <span class="obligatoire">(obligatoire)</span></label>
<input id="name" name="name" value="${form.name}" maxlength="${MAX_NAME_CHARS}" required autocomplete="off" aria-describedby="${describedBy('name-aide', 'name-erreur', errors.name)}"${invalid(errors.name)}${editing ? null : html` autofocus`}>
<p class="aide" id="name-aide">Par exemple «&nbsp;Multimètre Fluke 87V&nbsp;».</p>
${fieldError('name-erreur', errors.name)}</div>
<div class="champ">
<label for="notes">Notes</label>
<textarea id="notes" name="notes" rows="5" maxlength="${MAX_NOTES_CHARS}" aria-describedby="${describedBy('notes-aide', 'notes-erreur', errors.notes)}"${invalid(errors.notes)}>${form.notes}</textarea>
<p class="aide" id="notes-aide">Texte libre, sur plusieurs lignes si besoin.</p>
${fieldError('notes-erreur', errors.notes)}</div>
<fieldset class="champ-proprietes" aria-describedby="${describedBy('proprietes-aide', 'proprietes-erreur', errors.properties)}">
<legend>Propriétés</legend>
<p class="aide" id="proprietes-aide">Par exemple «&nbsp;N° de série&nbsp;» et «&nbsp;4410278&nbsp;». Une ligne laissée vide est ignorée.</p>
${fieldError('proprietes-erreur', errors.properties)}<div class="proprietes-saisie">
<div class="propriete-entete" aria-hidden="true"><span>Nom</span><span>Valeur</span></div>
${rows.map((row, i) => propertyRow(row, i + 1))}</div>
</fieldset>
<div class="actions-formulaire">
<button class="bouton" type="submit">${editing ? 'Enregistrer' : 'Créer la fiche'}</button>
<button class="bouton bouton-secondaire" type="submit" name="action" value="lignes" formnovalidate>Ajouter des lignes</button>
<a class="lien-annuler" href="${cancel}">Annuler</a>
</div>
</form>`, chip === null ? undefined : chipsSection);
}

// Ligne de propriété n (à partir de 1) : deux champs répétés prop_key / prop_value, chacun avec
// un libellé lu par les lecteurs d'écran (les en-têtes visibles « Nom », « Valeur » sont
// masqués pour eux).
function propertyRow(row, n) {
  const errorId = `propriete-erreur-${n}`;
  const extra = row.error ? html` aria-invalid="true" aria-describedby="${errorId}"` : null;
  return html`<div class="propriete-ligne">
<label class="visuellement-cache" for="prop-key-${n}">Nom de la propriété ${n}</label>
<input id="prop-key-${n}" name="prop_key" value="${row.key}" maxlength="${MAX_PROPERTY_KEY_CHARS}" autocomplete="off"${extra}>
<label class="visuellement-cache" for="prop-value-${n}">Valeur de la propriété ${n}</label>
<input id="prop-value-${n}" name="prop_value" value="${row.value}" maxlength="${MAX_PROPERTY_VALUE_CHARS}" autocomplete="off"${extra}>
${row.error ? html`<p class="erreur-champ" id="${errorId}">${row.error}</p>\n` : null}</div>
`;
}

/** Confirmation de suppression d'une fiche. */
export function deleteItemPage(user, { item }) {
  return appLayout(user, 'Supprimer la fiche', html`${trail([INVENTORY_TRAIL, [`/items/${item.id}`, item.name]], 'Supprimer')}
<div class="entete-page">
<h1>Supprimer la fiche</h1>
</div>
${AIDE.supprimerFiche}<div class="panneau panneau-danger">
<p>La fiche «&nbsp;<strong class="nom-confirme">${item.name}</strong>&nbsp;» sera supprimée ; ses déplacements restent dans l'historique.</p>
<form method="post" action="/items/${item.id}/delete">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Supprimer définitivement</button>
<a class="lien-annuler" href="/items/${item.id}">Annuler</a>
</div>
</form>
</div>`);
}

/**
 * Correction manuelle de l'emplacement.
 * @param {{item: object, stations: {id: number, name: string}[], selected?: string|null, error?: string|null}} data
 *   item : fiche avec son emplacement (getItem) ; selected : valeur choisie à réafficher.
 */
export function locationPage(user, { item, stations, selected = null, error = null }) {
  const current = html`<p class="localisation-actuelle"><span class="texte-doux">Emplacement actuel :</span> ${locationBadge(item)}</p>`;
  let body;
  if (stations.length === 0) {
    body = emptyState('poste', html`<p>Aucun poste n'existe encore.</p>
<p class="texte-doux">Il faut d'abord créer un poste pour pouvoir y localiser un objet.</p>
<a class="bouton" href="/stations/new">Créer un poste</a>`);
  } else {
    const choice = stationChoice({ stations, selected, error, currentId: item.station_id, hasChip: item.uid_nfc !== null });
    body = html`<form class="formulaire-page" method="post" action="/items/${item.id}/location">
<input type="hidden" name="csrf" value="${user.csrf}">
${choice}
<div class="actions-formulaire">
<button class="bouton" type="submit">Enregistrer la correction</button>
<a class="lien-annuler" href="/items/${item.id}">Annuler</a>
</div>
</form>`;
  }
  return appLayout(user, 'Corriger l\'emplacement', html`${trail([INVENTORY_TRAIL, [`/items/${item.id}`, item.name]], 'Corriger l\'emplacement')}
<div class="entete-page">
<h1>Corriger l'emplacement</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.localisation}${current}
${body}`);
}

// ---------------------------------------------------------------- postes et lecteurs (étape 6)

const stationsSection = { section: SECTION_STATIONS };
const readersSection = { section: SECTION_READERS };
const STATIONS_TRAIL = ['/stations', 'Postes'];
const READERS_TRAIL = ['/readers', 'Lecteurs'];

/**
 * Désignation d'un lecteur à l'écran (D-019), SEULE fonction qui la construit :
 *   1. son nom, s'il en a un ;
 *   2. sinon, s'il est affecté, « Lecteur du Poste 2 » (nom de poste commençant par « Poste »)
 *      ou « Lecteur · Atelier » ;
 *   3. sinon « Lecteur n° <numéro> ».
 * Texte brut : échappé par le gabarit html`...` là où il est inséré.
 * Deux lecteurs peuvent porter la même désignation (remplaçant qui reprend le nom, deux
 * lecteurs sans nom au même poste) : les tableaux de lecteurs (liste, fiche poste) affichent
 * donc aussi le numéro, dans une colonne « N° boîtier ».
 * @param {{id: number, name: string, station_id: number|null, station_name?: string|null}} reader
 *   station : poste ACTUEL du lecteur (readers.station_id), pas celui d'un scan passé.
 */
export function readerLabel(reader) {
  if (reader.name) return reader.name;
  if (reader.station_id !== null && reader.station_name) {
    // « Lecteur du Poste 2 » si le nom du poste commence déjà par « Poste », sinon « Lecteur · Atelier »
    // (et non « Lecteur du poste Atelier » ni « Lecteur du Atelier »).
    return /^poste\b/i.test(reader.station_name) ? `Lecteur du ${reader.station_name}` : `Lecteur · ${reader.station_name}`;
  }
  return `Lecteur n° ${reader.id}`;
}

const readerTrail = (reader) => [READERS_TRAIL, [`/readers/${reader.id}`, readerLabel(reader)]];

// Sous-titre des pages d'action sur un lecteur : sa désignation, puis son poste quand la
// désignation ne le contient pas déjà (lecteur nommé, ou non affecté).
function readerSubtitle(reader) {
  const label = readerLabel(reader);
  if (reader.name === '' && reader.station_id !== null) return label;
  return `${label} · ${reader.station_id === null ? 'non affecté' : reader.station_name}`;
}

/**
 * Page d'information (introuvable, action impossible) : encadré centré.
 * layout : rubrique du bandeau ; parent : lien [href, libellé] du fil d'Ariane.
 */
function messagePage(user, { title, text, hint = null, parents, action = null, layout, iconName = 'attention' }) {
  return appLayout(user, title, html`${trail(parents, title)}
${emptyState(iconName, html`<h1>${title}</h1>
<p>${text}</p>
${hint === null ? null : html`<p class="texte-doux">${hint}</p>\n`}${action === null ? null : html`<a class="bouton" href="${action.href}">${action.label}</a>\n`}`)}`, layout);
}

export function stationNotFoundPage(user) {
  return notFoundPage(user, {
    title: 'Poste introuvable', text: 'Ce poste n\'existe pas ou a été supprimé.', parents: [STATIONS_TRAIL], layout: stationsSection, iconName: 'poste',
  });
}

export function readerNotFoundPage(user) {
  return notFoundPage(user, {
    title: 'Lecteur introuvable', text: 'Ce lecteur n\'existe pas ou a été supprimé.', parents: [READERS_TRAIL], layout: readersSection, iconName: 'lecteur',
  });
}

/** Action impossible sur un lecteur désactivé (affectation, remplacement, désactivation). */
export function readerInactivePage(user, { reader }) {
  return messagePage(user, {
    title: 'Lecteur désactivé',
    text: `${readerLabel(reader)} est désactivé définitivement : il ne peut plus changer de poste, ni être désactivé ou remplacé une seconde fois.`,
    hint: 'Pour remettre un boîtier en service, créez un nouveau lecteur.',
    parents: readerTrail(reader),
    action: { href: '/readers/new', label: 'Nouveau lecteur' },
    layout: readersSection,
    iconName: 'lecteur',
  });
}

/** Plus aucun identifiant de lecteur libre (reader_id sur 32 bits). */
export function readerIdsExhaustedPage(user) {
  return messagePage(user, {
    title: 'Aucun numéro de lecteur disponible',
    text: `Le plus grand numéro de lecteur possible (${thousands(MAX_READER_ID)}) est déjà attribué : aucun nouveau lecteur ne peut être créé.`,
    hint: 'Rien n\'a été modifié.',
    parents: [READERS_TRAIL],
    layout: readersSection,
  });
}

// État d'un lecteur : pastille verte (actif) ou grise (désactivé).
function readerBadge(reader) {
  return reader.active === 1
    ? html`<span class="etat etat-actif">actif</span>`
    : html`<span class="etat etat-desactive">désactivé</span>`;
}

// Poste d'un lecteur (ou d'un scan) : lien vers le poste, ou « non affecté ».
function stationLink(id, name, none = 'non affecté') {
  return id === null ? html`<span class="texte-doux">${none}</span>` : html`<a class="lien-simple" href="/stations/${id}">${name}</a>`;
}

/**
 * Liste des postes.
 * @param {{stations: {id, name, description, active_readers, items_here}[], notice?: string|null}} data
 */
export function stationsPage(user, { stations, notice = null }) {
  const body = stations.length === 0
    ? emptyState('poste', html`<p>Aucun poste pour le moment.</p>
<p class="texte-doux">Créez le premier poste avec le bouton «&nbsp;Nouveau poste&nbsp;», puis affectez-lui un lecteur.</p>`)
    : html`<div class="panneau-tableau">
<table class="tableau tableau-postes">
<thead><tr><th scope="col">Poste</th><th scope="col">Objets présents</th><th scope="col">Lecteurs actifs</th></tr></thead>
<tbody>
${stations.map((station) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/stations/${station.id}">${station.name}</a>${station.description === '' ? null : html`<span class="description-courte">${station.description}</span>`}</td>
<td data-label="Objets présents">${station.items_here}</td>
<td data-label="Lecteurs actifs">${station.active_readers}</td>
</tr>
`)}</tbody>
</table>
</div>`;
  return appLayout(user, 'Postes', html`${noticeFor(STATION_LIST_NOTICES, notice)}<div class="entete-page entete-actions">
<h1>Postes</h1>
<div class="actions-page">
<a class="bouton" href="/stations/new">${icon('ajouter')}Nouveau poste</a>
</div>
</div>
${AIDE.postes}<p class="resultats">${plural(stations.length, 'poste', 'postes')}</p>
${body}`, { ...stationsSection, exact: true });
}

/**
 * Fiche d'un poste : les objets présents d'abord (l'usage quotidien), puis les lecteurs et
 * les informations.
 * @param {{station: object, readers: object[], items: object[], deletable: boolean, now: number, notice?: string|null}} data
 */
export function stationPage(user, { station, readers, items, deletable, now, notice = null }) {
  const activeCount = readers.filter((reader) => reader.active === 1).length;

  const readerList = readers.length === 0
    ? html`<p class="texte-doux">Aucun lecteur n'est affecté à ce poste. On affecte un lecteur depuis sa fiche («&nbsp;Changer de poste&nbsp;»), ou à sa création.</p>`
    : html`<table class="tableau tableau-lecteurs-poste">
<thead><tr><th scope="col">Lecteur</th><th scope="col">N° boîtier</th><th scope="col">État</th><th scope="col">Dernier scan</th></tr></thead>
<tbody>
${readers.map((reader) => html`<tr>
<td><a class="lien-objet" href="/readers/${reader.id}">${readerLabel(reader)}</a></td>
<td data-label="N° boîtier"><span class="numero-boitier">${reader.id}</span></td>
<td data-label="État">${readerBadge(reader)}</td>
<td data-label="Dernier scan">${reader.last_scan_at === null ? html`<span class="texte-doux">aucun</span>` : timeTag(reader.last_scan_at, now)}</td>
</tr>
`)}</tbody>
</table>`;

  const itemList = items.length === 0
    ? html`<p class="texte-doux">Aucun objet n'est actuellement localisé à ce poste.</p>`
    : html`<table class="tableau tableau-objets-poste">
<thead><tr><th scope="col">Objet</th><th scope="col">Depuis</th></tr></thead>
<tbody>
${items.map((item) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/items/${item.id}">${item.name}</a></td>
<td data-label="Depuis">${arrivalTag(item, now)}${item.arrival_source === 'manual' ? html` <span class="texte-doux">(correction)</span>` : null}</td>
</tr>
`)}</tbody>
</table>`;

  return appLayout(user, station.name, html`${trail([STATIONS_TRAIL], station.name)}
${noticeFor(STATION_NOTICES, notice)}<div class="entete-page entete-actions">
<div class="titre-icone">${icon('poste')}<h1>${station.name}</h1></div>
<div class="actions-page">
<a class="bouton" href="/stations/${station.id}/edit">${icon('modifier')}Modifier</a>
${deletable ? html`<a class="lien-danger" href="/stations/${station.id}/delete">${icon('supprimer')}Supprimer</a>` : null}
</div>
</div>
${station.description === '' ? null : html`<p class="description-page">${station.description}</p>\n`}
${AIDE.poste}<div class="fiche fiche--poste">
<section class="carte carte-corps fiche-large" aria-labelledby="titre-objets">
<h2 id="titre-objets" class="carte-titre">${icon('objet')}Objets présents <span class="compte-titre">${items.length}</span></h2>
${itemList}
</section>
<section class="carte carte-corps" aria-labelledby="titre-lecteurs">
<h2 id="titre-lecteurs" class="carte-titre">${icon('lecteur')}Lecteurs</h2>
${readerList}
</section>
<section class="carte carte-corps" aria-labelledby="titre-informations">
<h2 id="titre-informations" class="carte-titre">${icon('note')}Informations</h2>
<dl class="proprietes">
<div><dt>Créé</dt><dd>${formatDateTime(station.created_at)}</dd></div>
<div><dt>Lecteurs actifs</dt><dd>${activeCount}</dd></div>
<div><dt>Objets présents</dt><dd>${items.length}</dd></div>
</dl>
${deletable ? null : html`<p class="note-poste">Ce poste a un historique (scans, corrections ou lecteurs) : il ne peut pas être supprimé, mais vous pouvez le renommer.</p>\n`}</section>
</div>`, stationsSection);
}

/**
 * Formulaire de création ou de modification d'un poste.
 * @param {{station: {id, name}|null, form: {name: string, description: string}, errors: {name?: string, description?: string}}} data
 *   station : null pour une création ; sinon le poste modifié (nom actuellement enregistré).
 */
export function stationFormPage(user, { station, form, errors }) {
  const editing = station !== null;
  const action = editing ? `/stations/${station.id}/edit` : '/stations/new';
  const cancel = editing ? `/stations/${station.id}` : '/stations';
  const title = editing ? 'Modifier le poste' : 'Nouveau poste';
  const parents = editing ? [STATIONS_TRAIL, [cancel, station.name]] : [STATIONS_TRAIL];
  const failed = Object.keys(errors).length > 0;
  return appLayout(user, title, html`${trail(parents, title)}
<div class="entete-page">
<h1>${title}</h1>
${editing ? html`<p class="sous-titre-page">${station.name}</p>\n` : null}</div>
${editing ? AIDE.modifierPoste : AIDE.nouveauPoste}${failed ? html`<p class="erreur" role="alert">Le poste n'a pas été enregistré. Corrigez les champs signalés ci-dessous : votre saisie est conservée.</p>\n` : null}<form class="formulaire-page" method="post" action="${action}">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="champ">
<label for="name">Nom <span class="obligatoire">(obligatoire)</span></label>
<input id="name" name="name" value="${form.name}" maxlength="${MAX_STATION_NAME_CHARS}" required autocomplete="off" aria-describedby="${describedBy('name-aide', 'name-erreur', errors.name)}"${invalid(errors.name)}>
<p class="aide" id="name-aide">Par exemple «&nbsp;Banc de mesure 2&nbsp;». Chaque poste a un nom différent.</p>
${fieldError('name-erreur', errors.name)}</div>
<div class="champ">
<label for="description">Description</label>
<textarea id="description" name="description" rows="4" maxlength="${MAX_STATION_DESCRIPTION_CHARS}" aria-describedby="${describedBy('description-aide', 'description-erreur', errors.description)}"${invalid(errors.description)}>${form.description}</textarea>
<p class="aide" id="description-aide">Facultative : emplacement, usage…</p>
${fieldError('description-erreur', errors.description)}</div>
<div class="actions-formulaire">
<button class="bouton" type="submit">${editing ? 'Enregistrer' : 'Créer le poste'}</button>
<a class="lien-annuler" href="${cancel}">Annuler</a>
</div>
</form>`, stationsSection);
}

/**
 * Suppression d'un poste : confirmation s'il n'a aucun historique, sinon explication.
 * @param {{station: object, history: {scans: number, corrections: number, readers: number}}} data
 */
export function deleteStationPage(user, { station, history }) {
  const parents = [STATIONS_TRAIL, [`/stations/${station.id}`, station.name]];
  if (hasHistory(history)) {
    const counted = (n, one, many) => `${thousands(n)} ${n > 1 ? many : one}`;
    const causes = [
      history.scans > 0 ? `${counted(history.scans, 'scan enregistré', 'scans enregistrés')} à ce poste` : null,
      history.corrections > 0 ? `${counted(history.corrections, 'correction manuelle', 'corrections manuelles')} d'emplacement vers ce poste` : null,
      history.readers > 0 ? `${counted(history.readers, 'lecteur affecté', 'lecteurs affectés')} à ce poste (actifs ou désactivés)` : null,
    ].filter((cause) => cause !== null);
    return appLayout(user, 'Suppression impossible', html`${trail(parents, 'Supprimer')}
<div class="entete-page">
<h1>Suppression impossible</h1>
<p class="sous-titre-page">${station.name}</p>
</div>
<div class="panneau panneau-info">
<p>Ce poste ne peut pas être supprimé, car il a un historique&nbsp;:</p>
<ul class="liste-causes">
${causes.map((cause) => html`<li>${cause}</li>
`)}</ul>
<p class="texte-doux">Les scans et les corrections désignent ce poste : ils doivent être conservés. Si le poste a changé de nom ou d'usage, renommez-le.</p>
<div class="actions-formulaire">
<a class="bouton" href="/stations/${station.id}/edit">Renommer le poste</a>
<a class="lien-annuler" href="/stations/${station.id}">Retour au poste</a>
</div>
</div>`, stationsSection);
  }
  return appLayout(user, 'Supprimer le poste', html`${trail(parents, 'Supprimer')}
<div class="entete-page">
<h1>Supprimer le poste</h1>
</div>
${AIDE.supprimerPoste}<div class="panneau panneau-danger">
<p>Vous allez supprimer le poste «&nbsp;<strong class="nom-confirme">${station.name}</strong>&nbsp;».</p>
<p class="texte-doux">Il n'a aucun historique : aucun scan, aucune correction d'emplacement, aucun lecteur. L'historique des modifications garde la trace de la suppression.</p>
<form method="post" action="/stations/${station.id}/delete">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Supprimer définitivement</button>
<a class="lien-annuler" href="/stations/${station.id}">Annuler</a>
</div>
</form>
</div>`, stationsSection);
}

/**
 * Liste des lecteurs.
 * @param {{readers: object[], now: number}} data
 */
export function readersPage(user, { readers, now }) {
  const activeCount = readers.filter((reader) => reader.active === 1).length;
  const body = readers.length === 0
    ? emptyState('lecteur', html`<p>Aucun lecteur pour le moment.</p>
<p class="texte-doux">Créez un lecteur avec le bouton «&nbsp;Nouveau lecteur&nbsp;» : l'application lui attribue un numéro et une clé, à installer dans le boîtier.</p>`)
    : html`<div class="panneau-tableau">
<table class="tableau tableau-lecteurs">
<thead><tr><th scope="col">Lecteur</th><th scope="col">N° boîtier</th><th scope="col">Poste</th><th scope="col">État</th><th scope="col">Dernier scan</th><th scope="col">Créé</th></tr></thead>
<tbody>
${readers.map((reader) => html`<tr>
<td><a class="lien-objet" href="/readers/${reader.id}">${readerLabel(reader)}</a></td>
<td data-label="N° boîtier"><span class="numero-boitier">${reader.id}</span></td>
<td data-label="Poste">${stationLink(reader.station_id, reader.station_name)}</td>
<td data-label="État">${readerBadge(reader)}</td>
<td data-label="Dernier scan">${reader.last_scan_at === null ? html`<span class="texte-doux">aucun</span>` : timeTag(reader.last_scan_at, now)}</td>
<td data-label="Créé">${formatDateTime(reader.created_at)}</td>
</tr>
`)}</tbody>
</table>
</div>`;
  return appLayout(user, 'Lecteurs', html`<div class="entete-page entete-actions">
<h1>Lecteurs</h1>
<div class="actions-page">
<a class="bouton" href="/readers/new">${icon('ajouter')}Nouveau lecteur</a>
</div>
</div>
${AIDE.lecteurs}<p class="resultats">${plural(readers.length, 'lecteur', 'lecteurs')}${readers.length === 0 ? null : html` · ${plural(activeCount, 'actif', 'actifs')}`}</p>
${body}`, { ...readersSection, exact: true });
}

/**
 * Fiche d'un lecteur, sans sa clé.
 * @param {{reader: object, scans: object[], now: number, notice?: string|null}} data
 */
export function readerPage(user, { reader, scans, now, notice = null }) {
  const active = reader.active === 1;
  const label = readerLabel(reader);
  // « Renommer » reste proposé sur un lecteur désactivé : le nom aide à le reconnaître dans
  // l'historique.
  const actions = active
    ? html`<div class="actions-page">
<a class="bouton" href="/readers/${reader.id}/station">Changer de poste</a>
<a class="bouton bouton-secondaire" href="/readers/${reader.id}/rename">${icon('modifier')}Renommer</a>
<a class="bouton bouton-secondaire" href="/readers/${reader.id}/replace">Remplacer la clé</a>
<a class="lien-danger" href="/readers/${reader.id}/deactivate">Désactiver</a>
</div>`
    : html`<div class="actions-page">
<a class="bouton bouton-secondaire" href="/readers/${reader.id}/rename">${icon('modifier')}Renommer</a>
</div>`;

  const scanList = scans.length === 0
    ? html`<p class="texte-doux">Aucun scan reçu de ce lecteur.</p>`
    : html`<table class="tableau tableau-scans-lecteur">
<thead><tr><th scope="col">Objet</th><th scope="col">Poste</th><th scope="col">Heure</th></tr></thead>
<tbody>
${scans.map((scan) => html`<tr>
<td>${scan.item_id === null ? html`<span class="texte-doux">puce inconnue</span> ${chipCode(scan.uid_nfc)}` : html`<a class="lien-simple" href="/items/${scan.item_id}">${scan.item_name}</a>`}</td>
<td data-label="Poste">${stationLink(scan.station_id, scan.station_name)}</td>
<td data-label="Heure">${timeTag(scan.received_at, now)}</td>
</tr>
`)}</tbody>
</table>`;

  return appLayout(user, label, html`${trail([READERS_TRAIL], label)}
${noticeFor(READER_NOTICES, notice)}<div class="entete-page entete-actions">
<div class="titre-icone">${icon('lecteur')}<h1>${label}</h1></div>
${actions}
</div>
${AIDE.lecteur}<div class="fiche">
<section class="carte carte-corps" aria-labelledby="titre-etat">
<h2 id="titre-etat" class="carte-titre">${icon('valide')}État</h2>
<p>${readerBadge(reader)}</p>
<p class="localisation-detail">${active
    ? 'Ses scans sont acceptés. Sa clé n\'est jamais réaffichée : si elle est perdue, remplacez la clé.'
    : 'Désactivé définitivement : ses scans sont refusés. Ses scans passés sont conservés.'}</p>
</section>
<section class="carte carte-corps" aria-labelledby="titre-identification">
<h2 id="titre-identification" class="carte-titre">${icon('note')}Identification</h2>
<dl class="proprietes">
<div><dt>Nom</dt><dd>${reader.name === '' ? html`<span class="texte-doux">aucun</span>` : reader.name}</dd></div>
<div><dt>Poste</dt><dd>${stationLink(reader.station_id, reader.station_name)}</dd></div>
<div><dt>Numéro à configurer dans le boîtier</dt><dd><span class="numero-boitier">${reader.id}</span></dd></div>
<div><dt>Créé</dt><dd>${formatDateTime(reader.created_at)}</dd></div>
<div><dt>Dernier scan</dt><dd>${reader.last_scan_at === null ? html`<span class="texte-doux">aucun</span>` : timeTag(reader.last_scan_at, now)}</dd></div>
</dl>
</section>
<section class="carte carte-corps fiche-large" aria-labelledby="titre-scans">
<h2 id="titre-scans" class="carte-titre">${icon('historique')}Derniers scans</h2>
${scanList}
</section>
</div>`, readersSection);
}

// Liste déroulante des postes, avec « Non affecté » en tête (valeur vide).
function stationSelect({ stations, selected, error, help }) {
  return html`<div class="champ">
<label for="station">Poste</label>
<select id="station" name="station" aria-describedby="${describedBy('station-aide', 'station-erreur', error)}"${invalid(error)}>
<option value=""${selected === '' ? html` selected` : null}>Non affecté</option>
${stations.map((station) => html`<option value="${station.id}"${String(station.id) === selected ? html` selected` : null}>${station.name}</option>
`)}</select>
<p class="aide" id="station-aide">${help}</p>
${fieldError('station-erreur', error)}</div>`;
}

// Champ « Nom » d'un lecteur (création, renommage) : facultatif, une ligne.
function readerNameField({ value, error }) {
  return html`<div class="champ">
<label for="name">Nom <span class="obligatoire">(facultatif)</span></label>
<input id="name" name="name" value="${value}" maxlength="${MAX_READER_NAME_CHARS}" autocomplete="off" aria-describedby="${describedBy('name-aide', 'name-erreur', error)}"${invalid(error)}>
<p class="aide" id="name-aide">Pour reconnaître le boîtier, par exemple «&nbsp;Boîtier établi gauche&nbsp;». Sans nom, le lecteur est désigné par son poste.</p>
${fieldError('name-erreur', error)}</div>`;
}

/**
 * Création d'un lecteur : nom et poste facultatifs.
 * @param {{stations: {id, name}[], selected?: string, error?: string|null, name?: string, nameError?: string|null}} data
 *   error : erreur sur le poste ; name : saisie du nom à réafficher.
 */
export function readerFormPage(user, { stations, selected = '', error = null, name = '', nameError = null }) {
  return appLayout(user, 'Nouveau lecteur', html`${trail([READERS_TRAIL], 'Nouveau lecteur')}
<div class="entete-page">
<h1>Nouveau lecteur</h1>
</div>
${AIDE.nouveauLecteur}${error === null && nameError === null ? null : html`<p class="erreur" role="alert">Le lecteur n'a pas été créé. Corrigez les champs signalés ci-dessous : votre saisie est conservée.</p>\n`}<form class="formulaire-page" method="post" action="/readers/new">
<input type="hidden" name="csrf" value="${user.csrf}">
${readerNameField({ value: name, error: nameError })}
${stationSelect({ stations, selected, error, help: 'Facultatif : le lecteur peut être affecté à un poste plus tard.' })}
<p class="aide">L'application attribue le numéro du lecteur et crée sa clé. La clé sera affichée une seule fois, sur la page suivante, pour être installée dans le boîtier.</p>
<div class="actions-formulaire">
<button class="bouton" type="submit">Créer le lecteur</button>
<a class="lien-annuler" href="/readers">Annuler</a>
</div>
</form>`, readersSection);
}

/**
 * Changement de poste d'un lecteur actif.
 * @param {{reader: object, stations: {id, name}[], selected?: string|null, error?: string|null}} data
 *   selected : valeur à présélectionner (par défaut le poste actuel).
 */
export function readerStationPage(user, { reader, stations, selected = null, error = null }) {
  const current = selected ?? (reader.station_id === null ? '' : String(reader.station_id));
  return appLayout(user, 'Changer de poste', html`${trail(readerTrail(reader), 'Changer de poste')}
<div class="entete-page">
<h1>Changer de poste</h1>
<p class="sous-titre-page">${readerSubtitle(reader)}</p>
</div>
${AIDE.changerPoste}${error === null ? null : html`<p class="erreur" role="alert">Le poste n'a pas été changé.</p>\n`}<form class="formulaire-page" method="post" action="/readers/${reader.id}/station">
<input type="hidden" name="csrf" value="${user.csrf}">
${stationSelect({ stations, selected: current, error, help: 'Les scans déjà enregistrés gardent leur poste : seuls les prochains scans de ce lecteur seront rattachés au poste choisi.' })}
<div class="actions-formulaire">
<button class="bouton" type="submit">Enregistrer</button>
<a class="lien-annuler" href="/readers/${reader.id}">Annuler</a>
</div>
</form>`, readersSection);
}

/**
 * Renommage d'un lecteur (actif ou désactivé). Nom vide : le lecteur redevient désigné par son
 * poste (readerLabel).
 * @param {{reader: object, name?: string|null, error?: string|null}} data
 *   name : saisie à réafficher (par défaut le nom actuel).
 */
export function readerRenamePage(user, { reader, name = null, error = null }) {
  return appLayout(user, 'Renommer le lecteur', html`${trail(readerTrail(reader), 'Renommer')}
<div class="entete-page">
<h1>Renommer le lecteur</h1>
<p class="sous-titre-page">${readerSubtitle(reader)}</p>
</div>
${AIDE.renommerLecteur}${error === null ? null : html`<p class="erreur" role="alert">Le nom n'a pas été enregistré. Corrigez le champ signalé ci-dessous : votre saisie est conservée.</p>\n`}<form class="formulaire-page" method="post" action="/readers/${reader.id}/rename">
<input type="hidden" name="csrf" value="${user.csrf}">
${readerNameField({ value: name ?? reader.name, error })}
<div class="actions-formulaire">
<button class="bouton" type="submit">Enregistrer</button>
<a class="lien-annuler" href="/readers/${reader.id}">Annuler</a>
</div>
</form>`, readersSection);
}

/** Confirmation de désactivation (définitive) d'un lecteur actif. */
export function deactivateReaderPage(user, { reader }) {
  return appLayout(user, 'Désactiver le lecteur', html`${trail(readerTrail(reader), 'Désactiver')}
<div class="entete-page">
<h1>Désactiver le lecteur</h1>
<p class="sous-titre-page">${readerSubtitle(reader)}</p>
</div>
${AIDE.desactiverLecteur}<div class="panneau panneau-danger">
<p>Ses scans seront refusés dès maintenant.</p>
<p><strong>La désactivation est définitive</strong> : un lecteur désactivé ne peut pas être réactivé. Pour remettre le boîtier en service, il faudra créer un nouveau lecteur.</p>
<p class="texte-doux">Ses scans passés et les emplacements qui en découlent sont conservés.</p>
<form method="post" action="/readers/${reader.id}/deactivate">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Désactiver définitivement</button>
<a class="lien-annuler" href="/readers/${reader.id}">Annuler</a>
</div>
</form>
</div>`, readersSection);
}

/** Confirmation du remplacement de clé d'un lecteur actif. */
export function replaceReaderPage(user, { reader }) {
  const station = reader.station_id === null ? 'non affecté' : reader.station_name;
  return appLayout(user, 'Remplacer la clé', html`${trail(readerTrail(reader), 'Remplacer la clé')}
<div class="entete-page">
<h1>Remplacer la clé</h1>
<p class="sous-titre-page">${readerSubtitle(reader)}</p>
</div>
${AIDE.remplacerCle}<div class="panneau panneau-danger">
<p>Un <strong>nouveau lecteur</strong> sera créé, avec un nouveau numéro et une nouvelle clé, au même poste (${station})${reader.name === '' ? null : html`, sous le même nom`}.</p>
<p>Ce lecteur sera <strong>désactivé définitivement</strong> : ses scans seront refusés dès maintenant, jusqu'à ce que le boîtier reçoive le nouveau numéro et la nouvelle clé.</p>
<p class="texte-doux">La nouvelle clé sera affichée une seule fois, sur la page suivante : préparez-vous à l'installer dans le boîtier. Les scans passés sont conservés.</p>
<form method="post" action="/readers/${reader.id}/replace">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="actions-formulaire">
<button class="bouton bouton-danger" type="submit">Remplacer la clé</button>
<a class="lien-annuler" href="/readers/${reader.id}">Annuler</a>
</div>
</form>
</div>`, readersSection);
}

/**
 * Page UNIQUE où la clé d'un lecteur est affichée : réponse directe au POST de création ou de
 * remplacement (aucune redirection, aucune URL ne la contient), envoyée avec
 * Cache-Control: no-store comme toute page (web.js, sendHtml). Elle n'est jamais réaffichée.
 * @param {{id: number, name: string, station: {id, name}|null, keyHex: string, oldId?: number|null}} data
 *   keyHex : 64 caractères hexadécimaux en minuscules, le format du fichier lu par
 *   tools/simulateur.js --key-file (comme dev/reader-1.key) ; oldId : lecteur remplacé.
 */
export function readerKeyPage(user, { id, name, station, keyHex, oldId = null, home = false }) {
  const reader = { id, name, station_id: station?.id ?? null, station_name: station?.name ?? null };
  const label = readerLabel(reader);
  const done = oldId === null
    ? `Lecteur créé : ${label}.`
    : `Clé remplacée : nouveau numéro ${id}. L'ancien numéro (${oldId}) est désactivé.`;
  return appLayout(user, `Clé : ${label}`, html`${trail([READERS_TRAIL, [`/readers/${id}`, label]], 'Clé')}
<p class="succes" role="status">${done}</p>
<div class="entete-page">
<h1>Clé du lecteur</h1>
<p class="sous-titre-page">${readerSubtitle(reader)}</p>
</div>
<div class="panneau panneau-alerte" role="note">
<p>Copiez cette clé dans le boîtier maintenant : elle ne sera plus affichée. Si vous la perdez, vous pourrez en créer une nouvelle.</p>
</div>
<section class="carte carte-corps carte-cle" aria-labelledby="titre-numero">
<h2 id="titre-numero" class="etiquette">Numéro à configurer dans le boîtier</h2>
<p class="numero-lecteur">${id}</p>
<h2 id="titre-cle" class="etiquette">Clé secrète</h2>
<pre class="cle">${keyHex}</pre>
<p class="aide">Un clic sur la clé la sélectionne en entier.</p>
</section>
<div class="actions-formulaire">
${home ? html`<a class="bouton" href="/">Continuer : retour à l'accueil</a>` : html`<a class="bouton" href="/readers">Retour aux lecteurs</a>`}
</div>`, readersSection);
}

// ---------------------------------------------------------------- puces inconnues (étape 7)
// Les adresses /chips/<UID>/... ne contiennent qu'un UID validé (inventory.js, parseUid :
// hexadécimal majuscule de 8, 14 ou 20 caractères) ou lu en base au même format, et des
// identifiants entiers lus en base.

const chipsSection = { section: SECTION_CHIPS };
const CHIPS_TRAIL = ['/chips', 'Puces inconnues'];

/** Lieu du dernier scan d'une puce, en texte : nom du poste, ou lecteur non affecté (lien vers le lecteur). */
function chipPlace(chip) {
  return chip.station_id === null
    ? html`<a class="lien-simple" href="/readers/${chip.reader_id}">lecteur non affecté</a>`
    : chip.station_name;
}

/**
 * Avertissement avant de réutiliser une puce qui a déjà appartenu à une fiche
 * (chip.previous : chips.js, chipPreviousOwner), ou rien. Ses anciens scans, restés au journal,
 * seront rattachés à la nouvelle fiche (cadrage.md §3, choix 1 : « ne pas réutiliser une puce »).
 */
function reuseWarning(chip) {
  const previous = chip.previous ?? null;
  if (previous === null) return null;
  const name = html`«&nbsp;${previous.name ?? 'sans nom'}&nbsp;»`;
  const owner = previous.exists
    ? html`<a href="/items/${previous.itemId}">${name} (n° ${previous.itemId})</a>`
    : html`${name} (n° ${previous.itemId}, supprimée depuis)`;
  const scans = chip.scan_count > 1
    ? `Ses ${thousands(chip.scan_count)} scans enregistrés, y compris ceux de cette époque, seront rattachés à la nouvelle fiche : ils apparaîtront dans son historique.`
    : 'Son scan enregistré sera rattaché à la nouvelle fiche : il apparaîtra dans son historique.';
  return html`<div class="panneau panneau-alerte panneau-reutilisation" role="note">
<p><strong>Cette puce a déjà appartenu à la fiche ${owner}</strong>, jusqu'au ${formatDateTime(previous.until)}.</p>
<p>${scans} Si possible, préférez une puce neuve.</p>
</div>
`;
}

/** Même information en pastille (liste) : le poste, ou un lecteur non affecté (lien vers le lecteur). */
function chipBadge(chip) {
  return chip.station_id === null
    ? html`<a class="lien-etat" href="/readers/${chip.reader_id}"><span class="etat etat-inconnue">lecteur non affecté</span></a>`
    : html`<span class="etat etat-poste">${chip.station_name}</span>`;
}

/**
 * Liste des puces inconnues.
 * @param {{chips: object[], more?: boolean, now: number}} data chips, more : chips.js,
 *   listUnknownChips (more : d'autres puces, plus anciennes, ne sont pas affichées).
 */
export function chipsPage(user, { chips, more = false, now }) {
  const summary = more
    ? html`<p class="resultats" role="status">Plus de ${plural(chips.length, 'puce inconnue', 'puces inconnues')} · les ${chips.length} plus récentes sont affichées. Associez-les ou créez leurs fiches pour voir les suivantes.</p>`
    : html`<p class="resultats">${plural(chips.length, 'puce inconnue', 'puces inconnues')}</p>`;
  const body = chips.length === 0
    ? emptyState('valide', html`<p>Aucune puce inconnue : toutes les puces scannées sont associées à une fiche.</p>
<p class="texte-doux">Une puce scannée sur un poste sans fiche apparaîtra ici, avec le poste et l'heure de son dernier scan.</p>`)
    : html`<ul class="carte liste-puces">
${chips.map((chip) => html`<li class="encart">
<span class="encart-icone">${icon('puce')}</span>
<div class="encart-corps">
<p class="encart-texte">Puce ${chipCode(chip.uid)}</p>
<p class="encart-meta">Dernier scan ${timeTag(chip.received_at, now)} · ${chipBadge(chip)} · ${thousands(chip.scan_count)} ${chip.scan_count > 1 ? 'scans' : 'scan'}</p>
</div>
<div class="groupe-boutons">
<a class="bouton bouton-secondaire bouton-petit" href="/chips/${chip.uid}/new">${icon('ajouter')}Créer une fiche</a>
<a class="bouton bouton-discret bouton-petit" href="/chips/${chip.uid}/associate">${icon('associer')}Associer à une fiche existante</a>
</div>
</li>
`)}</ul>`;
  return appLayout(user, 'Puces inconnues', html`<div class="entete-page">
<h1>Puces inconnues</h1>
<p class="intro">Puces scannées sur un poste qu'aucune fiche ne porte encore. Créez une fiche, ou associez la puce à une fiche existante : l'objet sera localisé au poste de son dernier scan.</p>
</div>
${AIDE.puces}${summary}
${body}`, { ...chipsSection, exact: true });
}

/**
 * Recherche de la fiche à laquelle associer une puce inconnue.
 * @param {{chip: object, query: string, items: object[], total: number, now: number}} data
 *   items : fiches affichées (au plus chips.js MAX_ASSOCIATE_RESULTS), total : fiches trouvées.
 */
export function associateSearchPage(user, { chip, query, items, total, now }) {
  const searching = query !== '';
  const base = `/chips/${chip.uid}/associate`;
  const truncated = total > items.length
    ? html` · les ${items.length} premières sont affichées : précisez la recherche.`
    : null;
  const summary = searching
    ? html`<p class="resultats" role="status">${plural(total, 'résultat', 'résultats')} pour «&nbsp;${query}&nbsp;»${truncated} · <a href="${base}">Effacer</a></p>`
    : html`<p class="resultats">${plural(total, 'fiche', 'fiches')}${truncated}</p>`;

  let body;
  if (total === 0 && !searching) {
    body = emptyState('objet', html`<p>Aucune fiche dans l'inventaire.</p>
<p class="texte-doux">Créez plutôt une fiche pour cette puce.</p>
<a class="bouton" href="/chips/${chip.uid}/new">Créer une fiche</a>`);
  } else if (total === 0) {
    body = emptyState('recherche', html`<p>Aucune fiche ne correspond à «&nbsp;${query}&nbsp;».</p>
<p class="texte-doux">Essayez une partie du nom, ou quelques caractères du numéro de sa puce actuelle.</p>`);
  } else {
    body = html`<div class="panneau-tableau">
<table class="tableau tableau-association">
<thead><tr><th scope="col">Objet</th><th scope="col">Puce actuelle</th><th scope="col">Emplacement</th><th scope="col"><span class="visuellement-cache">Action</span></th></tr></thead>
<tbody>
${items.map((item) => html`<tr>
<td class="cellule-objet"><a class="lien-objet" href="/items/${item.id}">${item.name}</a></td>
<td data-label="Puce actuelle">${item.uid_nfc === null ? html`<span class="texte-doux">aucune puce</span>` : chipCode(item.uid_nfc)}</td>
<td data-label="Emplacement">${locationBadge(item)}</td>
<td class="cellule-actions"><a class="bouton bouton-secondaire bouton-petit" href="${base}/${item.id}">${icon('associer')}Associer</a></td>
</tr>
`)}</tbody>
</table>
</div>`;
  }

  return appLayout(user, 'Associer la puce', html`${trail([CHIPS_TRAIL], 'Associer la puce')}
<div class="entete-page">
<h1>Associer la puce à une fiche</h1>
<p class="sous-titre-page">Puce ${chipCode(chip.uid)} · dernier scan : ${chipPlace(chip)}, ${timeTag(chip.received_at, now)}</p>
</div>
${AIDE.associerRecherche}<form class="recherche recherche--direct" method="get" action="${base}" role="search">
${icon('recherche')}
<label class="visuellement-cache" for="q">Rechercher une fiche par nom, propriété ou numéro de puce</label>
<input id="q" name="q" type="search" value="${query}" maxlength="${MAX_QUERY_CHARS}" placeholder="Nom, n° de série, numéro de puce…" autocomplete="off" spellcheck="false" aria-controls="association-resultats">
<button class="bouton bouton-secondaire" type="submit">Rechercher</button>
</form>
<div id="association-resultats">
${summary}
${body}
</div>
${total === 0 && !searching ? null : html`<p class="alternative">L'objet n'a pas encore de fiche ? <a href="/chips/${chip.uid}/new">Créer une fiche pour cette puce</a></p>\n`}`, chipsSection);
}

/**
 * Confirmation de l'association d'une puce inconnue à une fiche. Si la fiche porte déjà une
 * puce : avertissement (l'ancienne puce sera détachée) et bouton rouge.
 * @param {{chip: object, item: object, now: number, changed?: boolean}} data
 *   item : fiche avec son emplacement (inventory.js, getItem) ; changed : l'envoi précédent a
 *   été refusé parce que la fiche avait changé de puce entre-temps (page réaffichée en 409).
 */
export function associateConfirmPage(user, { chip, item, now, changed = false, fromItem = false }) {
  const replacing = item.uid_nfc !== null;
  const title = replacing ? 'Remplacer la puce de la fiche' : 'Associer la puce';
  const search = `/chips/${chip.uid}/associate`;
  // fromItem : page ouverte depuis « Donner une puce » de la fiche (étape U3) : fil d'Ariane et
  // « Annuler » ramènent à cette page ; le formulaire le signale (champ depuis) pour un 409.
  const back = fromItem ? `/items/${item.id}/puce` : search;
  const parents = fromItem
    ? [INVENTORY_TRAIL, [`/items/${item.id}`, item.name], [back, replacing ? 'Changer de puce' : 'Donner une puce']]
    : [CHIPS_TRAIL, [search, 'Associer la puce']];
  const lastScan = html`${chipPlace(chip)}, ${timeTag(chip.received_at, now)}`;
  // Sémantique de la vue item_locations : la plus récente des deux l'emporte. Une correction
  // manuelle postérieure au dernier scan de la puce reste donc l'emplacement après association.
  const correctionWins = item.source === 'manual' && item.at > chip.received_at;
  const explanation = replacing
    ? html`<p><strong>La fiche «&nbsp;<span class="nom-confirme">${item.name}</span>&nbsp;» porte déjà une puce</strong> (${chipCode(item.uid_nfc)}).</p>
<ul class="liste-causes">
<li>L'ancienne puce sera détachée de la fiche. Ses scans sont conservés, et elle redevient une puce inconnue.</li>
<li>L'emplacement de la fiche suivra désormais la nouvelle puce (${chipCode(chip.uid)}), scannée en dernier : ${lastScan}.</li>
</ul>`
    : html`<p>La puce ${chipCode(chip.uid)} sera associée à la fiche «&nbsp;<strong class="nom-confirme">${item.name}</strong>&nbsp;».</p>
<p>La fiche sera localisée au dernier scan de la puce : ${lastScan}.</p>`;

  return appLayout(user, title, html`${trail(parents, title)}
<div class="entete-page">
<h1>${title}</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.associerConfirmation}${changed ? html`<p class="erreur" role="alert">La fiche a changé de puce depuis l'affichage de la page précédente : rien n'a été modifié. Vérifiez ci-dessous, puis confirmez à nouveau.</p>\n` : null}${reuseWarning(chip)}<div class="panneau ${replacing ? 'panneau-danger' : 'panneau-info'}">
${explanation}
${correctionWins ? html`<p class="texte-doux">Une correction manuelle d'emplacement plus récente que ce scan existe : elle reste l'emplacement de la fiche jusqu'au prochain scan de la puce.</p>\n` : null}<form method="post" action="${search}/${item.id}">
<input type="hidden" name="csrf" value="${user.csrf}">
<input type="hidden" name="previous" value="${item.uid_nfc ?? ''}">
${fromItem ? html`<input type="hidden" name="depuis" value="fiche">
` : null}<div class="actions-formulaire">
${replacing
    ? html`<button class="bouton bouton-danger" type="submit">Remplacer la puce</button>`
    : html`<button class="bouton" type="submit">Associer la puce</button>`}
<a class="lien-annuler" href="${back}">Annuler</a>
</div>
</form>
</div>`, fromItem ? undefined : chipsSection);
}

export function chipNotFoundPage(user) {
  return messagePage(user, {
    title: 'Puce introuvable',
    text: 'Aucune puce scannée ne correspond à cette adresse.',
    hint: 'Une puce apparaît dans la liste des puces inconnues dès son premier scan sur un poste.',
    parents: [CHIPS_TRAIL],
    layout: chipsSection,
    iconName: 'puce',
  });
}

/** La puce est (devenue) associée à une fiche : plus rien à faire ici. */
export function chipKnownPage(user, { uid, itemId }) {
  return messagePage(user, {
    title: 'Puce déjà associée',
    text: `La puce ${chipNumber(uid)} est déjà associée à une fiche : elle n'est plus inconnue.`,
    hint: 'Rien n\'a été modifié.',
    parents: [CHIPS_TRAIL],
    action: { href: `/items/${itemId}`, label: 'Voir la fiche' },
    layout: chipsSection,
    iconName: 'valide',
  });
}

// ---------------------------------------------------------------- écran d'accueil (étape U4)

/**
 * Puce inconnue pour GET /api/puces-inconnues (sérialisée en JSON par web.js, affichée par
 * app.js avec textContent). Le numéro sert aux adresses /chips/<UID>/… ; il n'est donné qu'aux
 * comptes connectés, comme sur la page « Puces inconnues ».
 */
export function chipResult(chip, now) {
  return {
    uid: chip.uid,
    numero: chipNumber(chip.uid),
    poste: chip.station_id === null ? null : chip.station_name,
    lecteur: chip.reader_id,
    iso: chip.received_at,
    texte: formatAge(chip.received_at, now),
    exacte: formatDateTime(chip.received_at),
  };
}

// Identifiants techniques qui ne sont pas des prénoms : pas de « Bonjour Admin ».
const NOT_A_NAME = new Set(['admin', 'administrateur', 'root', 'demo', 'test', 'user', 'utilisateur', 'metrotrack']);

/**
 * Prénom pour la salutation, tiré de l'identifiant (« claire.martin » → « Claire »), ou null :
 * première partie avant « . », « _ » ou « - », lettres seulement, au moins deux, et pas un
 * identifiant technique. L'identifiant est au format restreint [A-Za-z0-9._-] (D-011).
 */
export function greetingName(username) {
  const first = username.split(/[._-]/)[0];
  if (!/^[A-Za-z]{2,}$/.test(first) || NOT_A_NAME.has(first.toLowerCase())) return null;
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

/** « 3 jours », « 26 h » : durée d'un silence de lecteur (plus de 24 h par définition). */
export function silenceLength(ms) {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} jours`;
}

/**
 * Heure exacte sous l'ancienneté d'un mouvement, ou null si l'ancienneté la donne déjà
 * (« 25 nov. 2026 à 08:47 ») ; « hier à … » n'est pas répété (date complète à la place).
 */
function exactUnder(iso, now) {
  const age = formatAge(iso, now);
  const day = formatDay(iso, now);
  if (day !== age) return day;
  const full = formatDateTime(iso);
  return full === age ? null : full;
}

/**
 * Un mouvement de l'accueil (accueil.js, recentMovements). Même structure que celle produite par
 * app.js pour un mouvement reçu en direct. Un scan n'a pas de mention (c'est le cas courant) ;
 * une correction porte « Corrigé à la main par … » (icône ET texte).
 */
function movementItem(move, now) {
  const manual = move.type === 'correction';
  const under = exactUnder(move.at, now);
  return html`<li class="mouvement${manual ? ' mouvement--main' : ''}">
<span class="mouvement-icone">${icon(manual ? 'main' : 'lecteur')}</span>
<div class="mouvement-objet">
<a href="/items/${move.item_id}">${move.item_name}</a>
${manual ? html`<p class="mouvement-detail"><span class="badge badge--main">${icon('main')}Corrigé à la main</span>par ${move.username ?? 'un compte inconnu'}</p>\n` : null}</div>
<p class="mouvement-vers">${icon('poste')}<span><span class="visuellement-cache">Déplacé vers </span>${placeLink(move)}</span></p>
<p class="mouvement-quand">${timeTag(move.at, now)}${under === null ? null : html`<small>${under}</small>`}</p>
</li>
`;
}

/** Lieu d'une puce inconnue, en texte : nom du poste, ou « lecteur non affecté ». */
const chipWhere = (chip) => (chip.station_id === null ? 'lecteur non affecté' : chip.station_name);

/**
 * Une puce inconnue de « À traiter » (même structure que celle produite par app.js) :
 * « Nouvelle puce · Réception », sans préposition devant le nom du poste (« au Réception »).
 */
function chipToDo(chip, now) {
  return html`<li class="encart encart--empile">
<span class="encart-icone">${icon('puce')}</span>
<div class="encart-corps">
<p class="encart-texte">Nouvelle puce · <strong>${chipWhere(chip)}</strong></p>
<p class="encart-meta">${timeTag(chip.received_at, now)}</p>
</div>
<div class="groupe-boutons">
<a class="bouton bouton-petit" href="/chips/${chip.uid}/new">${icon('ajouter')}Créer une fiche</a>
<a class="bouton bouton-secondaire bouton-petit" href="/chips/${chip.uid}/associate">${icon('associer')}Associer à une fiche existante</a>
</div>
</li>
`;
}

/** Contenu de la carte « À traiter » (remplacé par app.js quand une puce arrive en direct). */
function chipsToDo({ chips, total }, now) {
  if (total === 0) {
    return html`<div class="etat-ok etat-ok--seul">
${icon('valide')}
<div><p class="etat-ok-titre">Rien à traiter</p><p>Chaque puce scannée a sa fiche.</p></div>
</div>`;
  }
  return html`<ul class="encart-liste">
${chips.map((chip) => chipToDo(chip, now))}</ul>
<p class="voir-tout"><a href="/chips">${total === 1 ? 'Voir la nouvelle puce' : `Voir les ${thousands(total)} nouvelles puces`}${icon('chevron')}</a></p>`;
}

const okReaders = (n) => (n === 1 ? '1 lecteur fonctionne' : `${n} lecteurs fonctionnent`);

/** Carte « Lecteurs » : lecteurs silencieux en orange (icône ET texte), puis ceux qui fonctionnent. */
function readersCard(readers, now) {
  if (readers.total === 0) {
    return html`<div class="carte-vide carte-vide--action">
<p>Ajoutez un lecteur : chaque poste a besoin du sien pour localiser les objets.</p>
<a class="bouton bouton-petit" href="/readers/new">${icon('ajouter')}Ajouter un lecteur</a>
</div>`;
  }
  const silent = readers.silent.map((reader) => {
    const since = reader.last_scan_at === null
      ? 'aucun scan reçu pour l\'instant'
      : `aucun scan depuis ${silenceLength(now - Date.parse(reader.last_scan_at))}`;
    const hint = reader.last_scan_at === null
      ? html`Vérifiez qu'il est branché et que sa clé est installée.`
      : html`Dernier scan ${timeTag(reader.last_scan_at, now)}. Vérifiez qu'il est allumé et branché.`;
    return html`<div class="alerte-lecteur" data-lecteur="${reader.id}">
${icon('silence')}
<div>
<p class="alerte-lecteur-titre"><span class="visuellement-cache">À surveiller : </span><a href="/readers/${reader.id}">${readerLabel(reader)}</a> : ${since}</p>
<p>${hint}</p>
</div>
</div>
`;
  });
  const last = readers.lastScanAt === null
    ? html`<p id="dernier-scan" hidden>Dernier scan reçu <time data-age></time></p>`
    : html`<p id="dernier-scan">Dernier scan reçu ${timeTag(readers.lastScanAt, now)}</p>`;
  return html`${silent}<div class="etat-ok" id="lecteurs-ok" data-nombre="${readers.working}"${readers.working === 0 ? html` hidden` : null}>
${icon('valide')}
<div><p class="etat-ok-titre">${okReaders(readers.working)}</p>${last}</div>
</div>`;
}

/** Surtitre : « Bonjour Claire · jeudi 27 novembre », ou la date seule. */
const surtitle = (greeting, today) => (greeting === null ? today : `Bonjour ${greeting} · ${today}`);

/** Étape du démarrage guidé : coche (icône ET texte caché « fait » / « à faire »), titre, suite. */
function guideStep(done, title, body, id = null) {
  return html`<li class="etape${done ? ' etape--faite' : ''}"${id === null ? null : html` id="${id}"`}>
<span class="etape-coche">${done ? icon('valide') : null}<span class="visuellement-cache">${done ? 'Fait : ' : 'À faire : '}</span></span>
<div class="etape-corps">
<p class="etape-titre">${title}</p>
${body}
</div>
</li>
`;
}

/**
 * Démarrage guidé (étape U4), en tête de l'accueil tant qu'aucun objet n'a été localisé : postes,
 * lecteurs, premier scan. L'étape « scan » attend en direct (app.js) ; une puce déjà reçue
 * propose « Créer sa fiche ». main : la section porte le titre principal de la page (h1).
 */
function startGuide({ counts, chips, greeting, today, main }) {
  const stations = counts.stations > 0;
  const readers = counts.readers > 0;
  const chip = chips.chips[0] ?? null;
  const heading = main
    ? html`<h1 id="titre-demarrage">Bienvenue&nbsp;! Préparons MetroTrack</h1>`
    : html`<h2 id="titre-demarrage">Bienvenue&nbsp;! Préparons MetroTrack</h2>`;
  const stationStep = stations
    ? html`<p class="etape-detail">${plural(counts.stations, 'poste créé', 'postes créés')} · <a href="/stations/new">Ajouter un autre poste</a></p>`
    : html`<p class="etape-detail">Un poste par lieu de travail : établi, banc d'essais, magasin…</p>
<a class="bouton bouton-petit" href="/stations/new">${icon('ajouter')}Créer un poste</a>`;
  const readerStep = readers
    ? html`<p class="etape-detail">${plural(counts.readers, 'lecteur ajouté', 'lecteurs ajoutés')} · <a href="/readers/new">Ajouter un autre lecteur</a></p>`
    : html`<p class="etape-detail">Un lecteur par poste ; sa clé s'installe dans le boîtier.</p>
<a class="bouton${stations ? '' : ' bouton-secondaire'} bouton-petit" href="/readers/new">${icon('ajouter')}Ajouter un lecteur</a>`;
  const scanStep = chip === null
    ? html`<p class="etape-detail etape-attente" id="etape-scan-detail"><span class="direct-point" aria-hidden="true"></span>On attend votre premier scan…</p>`
    : html`<p class="etape-detail" id="etape-scan-detail">Nouvelle puce · <strong>${chipWhere(chip)}</strong> · ${timeTag(chip.received_at, Date.now())}</p>
<a class="bouton bouton-petit" href="/chips/${chip.uid}/new">${icon('ajouter')}Créer sa fiche</a>`;
  return html`<section class="carte demarrage" id="demarrage" aria-labelledby="titre-demarrage">
${main ? html`<p class="heros-surtitre">${surtitle(greeting, today)}</p>\n` : null}${heading}
<p class="demarrage-intro">Trois étapes pour localiser votre premier objet.</p>
<ol class="demarrage-etapes">
${guideStep(stations, 'Créer vos postes', stationStep)}${guideStep(readers, 'Ajouter un lecteur', readerStep)}${guideStep(chip !== null, 'Scanner un premier objet', scanStep, 'etape-scan')}</ol>
<p class="demarrage-autre">Pas encore de puce sous la main&nbsp;? <a href="/items/new">Créez une fiche</a> : un nom suffit.</p>
</section>
`;
}

/** Message après une action qui ramène à l'accueil (démarrage guidé : ?ok=poste). */
function homeNotice(notice, counts) {
  if (notice !== 'poste') return null;
  const text = counts.readers === 0 ? 'Poste créé. Étape suivante : ajoutez un lecteur.' : 'Poste créé.';
  return html`<p class="succes" role="status">${text}</p>\n`;
}

/** Section « À traiter ». */
function toDoSection(chips, now) {
  return html`<section id="traiter" aria-labelledby="titre-puces">
<div class="section-entete">
<h2 id="titre-puces">À traiter <span class="nombre-pastille" id="puces-nombre"${chips.total === 0 ? html` hidden` : null}>${thousands(chips.total)}</span></h2>
</div>
<div class="carte carte-corps" id="a-traiter">
${chipsToDo(chips, now)}
</div>
</section>
`;
}

/**
 * Écran d'accueil (maquette B). Les sections portent des identifiants que web/static/app.js
 * met à jour en direct (mouvements, À traiter, lecteurs, démarrage) ; sans script, la page est
 * complète. « À traiter » passe au-dessus des mouvements quand il n'est pas vide.
 * @param {{counts: {items, stations, readers, scans}, onboarding: boolean, movements: object[],
 *   chips: {chips, total}, readers: object, now: number, notice?: string|null}} data accueil.js, homeData
 */
export function homePage(user, { counts, onboarding, movements, chips, readers, now, notice = null }) {
  const greeting = greetingName(user.username);
  const today = formatLongDay(now);
  const options = {
    section: SECTION_HOME, exact: true, search: false,
    icons: ['lecteur', 'main', 'poste', 'puce', 'ajouter', 'associer', 'valide', 'chevron'],
  };
  const noticeHtml = homeNotice(notice, counts);
  // Base vide : seulement le démarrage guidé (rien à chercher ni à voir encore).
  if (counts.items === 0 && counts.stations === 0 && counts.readers === 0) {
    return appLayout(user, 'Accueil', html`${noticeHtml}${startGuide({ counts, chips, greeting, today, main: true })}${AIDE.accueil}`, options);
  }
  const placeholder = counts.items === 0
    ? 'Un objet, un n° de série…'
    : `Un objet, un n° de série… parmi ${thousands(counts.items)} ${counts.items > 1 ? 'objets' : 'objet'}`;
  const shown = movements.slice(0, HOME_VISIBLE_MOVEMENTS);
  const more = movements.slice(HOME_VISIBLE_MOVEMENTS);
  const searchTitle = onboarding
    ? html`<h2 id="titre-recherche" class="heros-titre">Où est…&nbsp;?</h2>`
    : html`<h1 id="titre-recherche" class="heros-titre">Où est…&nbsp;?</h1>`;
  const toDoFirst = chips.total > 0;
  return appLayout(user, 'Accueil', html`${noticeHtml}${onboarding ? startGuide({ counts, chips, greeting, today, main: true }) : null}<section class="heros${onboarding ? ' heros--compact' : ''}" aria-labelledby="titre-recherche">
${onboarding ? null : html`<p class="heros-surtitre">${surtitle(greeting, today)}</p>\n`}${searchTitle}
<form class="recherche recherche--heros" method="get" action="/inventaire" role="search">
${icon('recherche')}
<label class="visuellement-cache" for="recherche-accueil">Rechercher un objet par nom, propriété ou numéro de puce</label>
<input id="recherche-accueil" name="q" type="search" maxlength="${MAX_QUERY_CHARS}" placeholder="${placeholder}" autocomplete="off" spellcheck="false">
${SHORTCUT_HINT}
<button class="bouton" type="submit">Rechercher</button>
</form>
</section>
<div class="pile" id="accueil-pile">
${toDoFirst ? toDoSection(chips, now) : null}<section id="mouvements-section" aria-labelledby="titre-mouvements">
<div class="section-entete">
<h2 id="titre-mouvements">Derniers mouvements</h2>
<p class="direct-etat" id="direct-etat" role="status" hidden><span class="direct-point" aria-hidden="true"></span><span class="direct-texte">En direct</span></p>
</div>
<div class="carte mouvements-carte">
<ol class="mouvements" id="mouvements" aria-live="polite"${shown.length === 0 ? html` hidden` : null}>
${shown.map((move) => movementItem(move, now))}</ol>
<details class="mouvements-plus" id="mouvements-plus"${more.length === 0 ? html` hidden` : null}>
<summary>Voir plus</summary>
<ol class="mouvements" id="mouvements-suite">
${more.map((move) => movementItem(move, now))}</ol>
</details>
${shown.length === 0 ? html`<p class="carte-vide" id="mouvements-vide">Aucun mouvement pour l'instant. Scannez un objet à un poste.</p>\n` : null}</div>
</section>
<div class="grille-2${toDoFirst ? ' grille-2--seule' : ''}" id="accueil-grille">
${toDoFirst ? null : toDoSection(chips, now)}<section aria-labelledby="titre-lecteurs">
<div class="section-entete">
<h2 id="titre-lecteurs">Lecteurs</h2>
<a class="section-lien" href="/readers">Tous les lecteurs</a>
</div>
<div class="carte carte-corps" id="lecteurs-etat">
${readersCard(readers, now)}
</div>
</section>
</div>
${AIDE.accueil}</div>`, options);
}
