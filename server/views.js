// Pages HTML de l'interface (direction visuelle B « Clair et aéré », D-017). Toutes passent par
// le gabarit html`...` (server/html.js) : chaque valeur interpolée est échappée automatiquement.
// Aucun attribut style, aucune balise <style> ni <script> : la CSP les bloquerait, et toute
// la mise en forme est dans web/static/style.css (polices : web/static/fonts.css).
// Icônes : sprite SVG intégré en tête de page, limité aux symboles utilisés (server/icones.js),
// toujours décoratives.
// Aide « Comment ça marche ? » sous le titre des pages : texte constant, dans server/aide.js.

import { html } from './html.js';
import { formatAge, formatDateTime } from './dates.js';
import { MAX_QUERY_CHARS } from './inventory.js';
import {
  MAX_NAME_CHARS, MAX_NOTES_CHARS, MAX_PROPERTIES, MAX_PROPERTY_KEY_CHARS, MAX_PROPERTY_VALUE_CHARS,
} from './items.js';
import { MAX_STATION_NAME_CHARS, MAX_STATION_DESCRIPTION_CHARS, hasHistory } from './stations.js';
import { MAX_READER_ID } from './readers.js';
import { AIDE } from './aide.js';
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
};

// Marque : pastille + nom. Dans l'application, c'est un lien vers l'inventaire.
// Logo officiel (web/static/logo.svg, couleurs de marque), intégré au HTML : sans xmlns ni
// style, décoratif (aria-hidden) puisque le mot « MetroTrack » est écrit à côté.
const LOGO = html`<svg class="logo-image" viewBox="0 0 900 900" aria-hidden="true"><defs><clipPath id="mt-losange"><rect x="167" y="172" width="566" height="566" rx="96" transform="rotate(45 450 455)"></rect></clipPath></defs><g clip-path="url(#mt-losange)"><rect x="0" y="0" width="900" height="900" fill="#0E95A4"></rect><rect x="238" y="455" width="426" height="460" fill="#03245A"></rect></g><circle cx="451" cy="455" r="213" fill="#FFFFFF"></circle><circle cx="451" cy="455" r="114" fill="#03245A"></circle></svg>`;
const BRAND_CONTENT = html`${LOGO}<span>MetroTrack</span>`;

function documentPage(title, bodyClass, content) {
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
</head>
<body class="${bodyClass}">
${spriteFor(body)}
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
 * valide accompagne la requête ; le lien mène alors à l'inventaire plutôt qu'à la connexion.
 */
export function forbiddenPage(connected = false) {
  return cardLayout('Action refusée', html`<h1>Action refusée</h1>
<p class="sous-titre">La page a peut-être expiré. Rechargez-la puis recommencez.</p>
${connected
    ? html`<a class="bouton" href="/">Revenir à l'inventaire</a>`
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
 * connected : lien « Revenir à l'inventaire » ; sinon « Se connecter ».
 */
export function errorPage(status, connected = false) {
  const { title, text } = ERROR_PAGES[status];
  return cardLayout(title, html`<h1>${title}</h1>
<p class="sous-titre">${text}</p>
${connected
    ? html`<a class="bouton" href="/">Revenir à l'inventaire</a>`
    : html`<a class="bouton" href="/login">Se connecter</a>`}`);
}

// ---------------------------------------------------------------- application

// Rubriques du bandeau. Pas de badge « nombre de puces inconnues » sur l'onglet : il serait
// calculé sur chaque page, et son calcul coûte environ 20 ms à 300 000 scans
// (server/chips.js), au-delà du budget fixé.
const SECTION_ITEMS = 'items';
const SECTION_STATIONS = 'stations';
const SECTION_READERS = 'readers';
const SECTION_CHIPS = 'chips';
const NAV = [
  ['/', 'Inventaire', SECTION_ITEMS],
  ['/stations', 'Postes', SECTION_STATIONS],
  ['/readers', 'Lecteurs', SECTION_READERS],
  ['/chips', 'Puces inconnues', SECTION_CHIPS],
];

/**
 * Lien du bandeau. Rubrique courante : aria-current="page" sur la liste elle-même,
 * aria-current="true" sur ses sous-pages (fiche, formulaires). La feuille de style signale la
 * rubrique par un fond et une graisse, pas par la couleur seule.
 */
function navLink(href, label, active, exact) {
  let current = null;
  if (active) current = exact ? html` aria-current="page"` : html` aria-current="true"`;
  return html`<li><a href="${href}"${current}>${label}</a></li>`;
}

// Initiales du compte pour la pastille (identifiant au format [A-Za-z0-9._-], D-011).
function initials(username) {
  const letters = username.replace(/[^A-Za-z0-9]/g, '');
  return (letters === '' ? username : letters).slice(0, 2).toUpperCase();
}

/**
 * Page de l'application : bandeau (marque, navigation, recherche, compte, déconnexion) puis
 * contenu.
 * @param {{username: string, csrf: string}} user
 * @param {{section?: string, exact?: boolean, search?: boolean}} [options]
 *   section : rubrique active du bandeau ; exact : la page est la liste de cette rubrique ;
 *   search : recherche compacte dans le bandeau (absente de l'inventaire, qui a la sienne).
 */
function appLayout(user, title, content, { section = SECTION_ITEMS, exact = false, search = true } = {}) {
  const searchForm = search
    ? html`<form class="recherche-barre" method="get" action="/" role="search">
${icon('recherche')}
<input name="q" type="search" maxlength="${MAX_QUERY_CHARS}" aria-label="Rechercher un objet dans l'inventaire" placeholder="Où est… ?" autocomplete="off" spellcheck="false">
</form>`
    : null;
  return documentPage(title, 'page-app', html`<header class="barre">
<div class="barre-interieur">
<a class="logo" href="/">${BRAND_CONTENT}</a>
<nav class="nav" aria-label="Navigation principale">
<ul>
${NAV.map(([href, label, key]) => navLink(href, label, key === section, exact))}
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
</main>`);
}

/**
 * Fil d'Ariane : liens [href, libellé] vers les pages parentes, puis la page courante (texte).
 * Toutes les adresses sont des chemins fixes du site, avec des identifiants lus en base.
 */
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
function timeTag(iso, now) {
  return html`<time datetime="${iso}" title="${formatDateTime(iso)}">${formatAge(iso, now)}</time>`;
}

/**
 * Heure d'arrivée à l'emplacement actuel (inventory.js, withLocations), pour « Depuis ».
 * Remontée bornée (arrived_at_bounded = 1) : « au moins » devant l'heure, car l'objet est là
 * depuis plus longtemps encore ; la date exacte au survol est celle du plus ancien scan examiné.
 * bounded : texte placé devant l'heure dans ce cas (« au moins » sous l'en-tête « Depuis »).
 * arrived_at manquant (ne devrait pas arriver) : heure du dernier événement.
 */
function arrivalTag(row, now, bounded = 'au moins') {
  return html`${row.arrived_at_bounded === 1 ? html`${bounded} ` : null}${timeTag(row.arrived_at ?? row.at, now)}`;
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

/**
 * Liste de l'inventaire.
 * @param {{query: string, items: object[], now: number, notice?: string|null}} data
 *   notice : code ?ok= reçu (seuls les codes connus affichent un message)
 */
export function inventoryPage(user, { query, items, now, notice = null }) {
  const searching = query !== '';
  const summary = searching
    ? html`<p class="resultats" role="status">${plural(items.length, 'résultat', 'résultats')} pour «&nbsp;${query}&nbsp;» · <a href="/">Effacer</a></p>`
    : html`<p class="resultats">${plural(items.length, 'objet', 'objets')}</p>`;

  let body;
  if (items.length === 0 && !searching) {
    body = emptyState('objet', html`<p>Aucun objet dans l'inventaire pour le moment.</p>
<p class="texte-doux">Créez la première fiche avec le bouton «&nbsp;Nouvelle fiche&nbsp;».</p>`);
  } else if (items.length === 0) {
    body = emptyState('recherche', html`<p>Aucun objet ne correspond à «&nbsp;${query}&nbsp;».</p>
<p class="texte-doux">Essayez une partie du nom, ou quelques caractères du numéro de sa puce.</p>`);
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
${AIDE.inventaire}<form class="recherche" method="get" action="/" role="search">
${icon('recherche')}
<label class="visuellement-cache" for="q">Rechercher un objet par nom ou numéro de puce</label>
<input id="q" name="q" type="search" value="${query}" maxlength="${MAX_QUERY_CHARS}" placeholder="Nom ou numéro de puce" autocomplete="off" spellcheck="false">
<button class="bouton bouton-secondaire" type="submit">Rechercher</button>
</form>
${summary}
${body}`, { exact: true, search: false });
}

/**
 * Emplacement actuel en grand, en tête de la fiche d'un objet : le poste (ou l'état), puis la
 * ligne « depuis » (localisation-detail).
 */
function currentPlace(item, now) {
  if (item.at === null) {
    return html`<p class="emplacement emplacement--vide">${icon('poste')}${locationBadge(item)}</p>
<p class="texte-doux">${item.uid_nfc === null ? 'Aucune puce associée : l\'objet ne peut pas être localisé par un scan.' : 'Cette puce n\'a encore été scannée sur aucun poste.'}</p>`;
  }
  // D'abord l'heure d'arrivée à cet emplacement (« depuis »), puis le dernier événement. Si
  // l'objet y a été signalé à nouveau depuis son arrivée, l'heure de ce dernier signalement
  // est ajoutée. Remontée bornée : « Depuis : au moins » devant l'heure d'arrivée.
  const again = (item.arrived_at ?? item.at) !== item.at;
  const last = item.source === 'manual'
    ? html`${again ? html`dernière correction manuelle ${timeTag(item.at, now)}` : 'correction manuelle'} par ${item.corrected_by ?? 'un compte inconnu'}`
    : html`${again ? html`dernier scan ${timeTag(item.at, now)}` : 'scanné'}`;
  const unassigned = item.station_id === null;
  const place = unassigned
    ? html`<p class="emplacement emplacement--attention">${icon('attention')}${locationBadge(item)}</p>`
    : html`<p class="emplacement emplacement--xl">${icon('poste')}${locationBadge(item)}</p>`;
  return html`${place}
<p class="localisation-detail">Depuis : ${arrivalTag(item, now)} · ${last}</p>
${unassigned ? html`<p class="note-emplacement">Le lecteur qui a scanné l'objet n'est rattaché à aucun poste. <a href="/readers/${item.reader_id}">Rattacher ce lecteur à un poste</a></p>\n` : null}`;
}

/**
 * Fiche d'un objet.
 * @param {{item: object, scans: object[], history: object[], now: number, notice?: string|null}} data
 *   history : dernières modifications (items.js, itemHistory) ; notice : code ?ok= reçu
 */
export function itemPage(user, { item, scans, history = [], now, notice = null }) {
  const properties = item.properties.length === 0
    ? html`<p class="texte-doux">Aucune propriété</p>`
    : html`<dl class="proprietes">
${item.properties.map(([key, value]) => html`<div><dt>${key}</dt><dd>${value}</dd></div>
`)}</dl>`;

  const notes = item.notes.trim() === ''
    ? html`<p class="texte-doux">Aucune note</p>`
    : html`<p class="notes">${item.notes}</p>`;

  // Derniers scans de la puce, en frise verticale (le plus récent en haut). Le premier est
  // marqué « Emplacement actuel » quand c'est lui qui donne l'emplacement (pas de correction
  // manuelle plus récente).
  let scanHistory;
  if (item.uid_nfc === null) scanHistory = html`<p class="texte-doux">Aucune puce associée.</p>`;
  else if (scans.length === 0) scanHistory = html`<p class="texte-doux">Aucun scan pour cette puce.</p>`;
  else {
    scanHistory = html`<ol class="frise">
${scans.map((scan, i) => {
    const current = i === 0 && item.source === 'scan';
    return html`<li class="${current ? 'frise-etape frise-etape--actuel' : 'frise-etape'}">
<p class="frise-quand">${timeTag(scan.received_at, now)}</p>
<span class="frise-noeud">${icon('lecteur')}</span>
<div class="frise-contenu">
<p class="frise-lieu">${scan.station_id === null ? html`<a class="lien-simple" href="/readers/${scan.reader_id}">Lecteur non affecté</a>` : scan.station_name}</p>
<p class="frise-detail">Scanné${current ? html` <span class="badge badge--ok">Emplacement actuel</span>` : null}</p>
</div>
</li>
`;
  })}</ol>`;
  }

  const changes = history.length === 0
    ? html`<p class="texte-doux">Aucune modification enregistrée.</p>`
    : html`<ol class="frise frise--modifications">
${history.map((entry) => html`<li class="frise-etape">
<p class="frise-quand">${timeTag(entry.at, now)}</p>
<span class="frise-noeud">${icon('modifier')}</span>
<div class="frise-contenu">
<p class="frise-lieu">${historyLabel(entry.label)}</p>
<p class="frise-detail">par ${entry.username ?? 'l\'outil d\'administration'}</p>
</div>
</li>
`)}</ol>`;

  return appLayout(user, item.name, html`${trail([['/', 'Inventaire']], item.name)}
${noticeFor(ITEM_NOTICES, notice)}<div class="carte fiche-entete">
<div class="fiche-entete-haut">
<div class="fiche-titre">${icon('objet')}<h1>${item.name}</h1></div>
<div class="actions-page">
<a class="bouton" href="/items/${item.id}/location">${icon('deplace')}Corriger l'emplacement</a>
<a class="bouton bouton-secondaire" href="/items/${item.id}/edit">${icon('modifier')}Modifier la fiche</a>
<a class="lien-danger" href="/items/${item.id}/delete">${icon('supprimer')}Supprimer</a>
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
<dl class="proprietes">
<div><dt>Numéro de puce</dt><dd>${item.uid_nfc === null ? html`<span class="texte-doux">aucune puce associée</span>` : chipCode(item.uid_nfc)}</dd></div>
<div><dt>Créée</dt><dd>${formatDateTime(item.created_at)}</dd></div>
<div><dt>Modifiée</dt><dd>${formatDateTime(item.updated_at)}</dd></div>
</dl>
${item.uid_nfc === null ? html`<p class="note-carte">Pour localiser l'objet, scannez sa puce sur un poste, puis associez-la depuis <a href="/chips">Puces inconnues</a>.</p>\n` : null}</section>
</div>
<div class="fiche-colonne">
<section class="carte carte-corps" aria-labelledby="titre-scans">
<h2 id="titre-scans" class="carte-titre">${icon('historique')}Derniers scans</h2>
${scanHistory}
</section>
<section class="carte carte-corps" aria-labelledby="titre-modifications">
<h2 id="titre-modifications" class="carte-titre">${icon('modifier')}Historique des modifications</h2>
${changes}
</section>
</div>
</div>`);
}

/**
 * Libellé d'une ligne d'historique (items.js, auditLabel) : texte, ou segments dont les UID
 * {uid} sont affichés groupés, en chasse fixe. Chaque segment passe par le gabarit (échappé).
 */
function historyLabel(label) {
  if (!Array.isArray(label)) return label;
  return label.map((part) => (typeof part === 'string' ? part : chipCode(part.uid)));
}

export function itemNotFoundPage(user) {
  return appLayout(user, 'Fiche introuvable', html`${trail([['/', 'Inventaire']], 'Fiche introuvable')}
${emptyState('objet', html`<h1>Fiche introuvable</h1>
<p class="texte-doux">Aucun objet ne correspond à cette adresse.</p>`)}`);
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
  let cancel = '/';
  let parents = [['/', 'Inventaire']];
  if (editing) {
    action = `/items/${item.id}/edit`;
    cancel = `/items/${item.id}`;
    parents = [['/', 'Inventaire'], [cancel, item.name]];
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
<input id="name" name="name" value="${form.name}" maxlength="${MAX_NAME_CHARS}" required autocomplete="off" aria-describedby="${describedBy('name-aide', 'name-erreur', errors.name)}"${invalid(errors.name)}>
<p class="aide" id="name-aide">Par exemple «&nbsp;Multimètre Fluke 87V&nbsp;». ${MAX_NAME_CHARS} caractères au plus.</p>
${fieldError('name-erreur', errors.name)}</div>
<div class="champ">
<label for="notes">Notes</label>
<textarea id="notes" name="notes" rows="5" maxlength="${MAX_NOTES_CHARS}" aria-describedby="${describedBy('notes-aide', 'notes-erreur', errors.notes)}"${invalid(errors.notes)}>${form.notes}</textarea>
<p class="aide" id="notes-aide">Texte libre sur plusieurs lignes. ${thousands(MAX_NOTES_CHARS)} caractères au plus.</p>
${fieldError('notes-erreur', errors.notes)}</div>
<fieldset class="champ-proprietes" aria-describedby="${describedBy('proprietes-aide', 'proprietes-erreur', errors.properties)}">
<legend>Propriétés</legend>
<p class="aide" id="proprietes-aide">Paires libres, par exemple «&nbsp;Marque&nbsp;» et «&nbsp;Fluke&nbsp;». ${MAX_PROPERTIES} au plus ; nom de ${MAX_PROPERTY_KEY_CHARS} caractères au plus, valeur de ${thousands(MAX_PROPERTY_VALUE_CHARS)}. Une ligne laissée vide est ignorée. Plus de lignes : bouton «&nbsp;Ajouter des lignes&nbsp;» en bas du formulaire.</p>
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
  return appLayout(user, 'Supprimer la fiche', html`${trail([['/', 'Inventaire'], [`/items/${item.id}`, item.name]], 'Supprimer')}
<div class="entete-page">
<h1>Supprimer la fiche</h1>
</div>
${AIDE.supprimerFiche}<div class="panneau panneau-danger">
<p>Vous allez supprimer la fiche «&nbsp;<strong class="nom-confirme">${item.name}</strong>&nbsp;».</p>
<p>Ses propriétés, ses notes et l'historique de ses corrections manuelles d'emplacement seront supprimés avec elle.</p>
${item.uid_nfc === null ? null : html`<p>Sa puce sera détachée : si elle a déjà été scannée, elle réapparaîtra dans «&nbsp;Puces inconnues&nbsp;» avec ses scans.</p>\n`}<p class="texte-doux">Les scans de sa puce et l'historique des modifications sont conservés.</p>
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
    body = html`<form class="formulaire-page" method="post" action="/items/${item.id}/location">
<input type="hidden" name="csrf" value="${user.csrf}">
<div class="champ">
<label for="station">Poste où se trouve l'objet</label>
<select id="station" name="station" required aria-describedby="${describedBy('station-aide', 'station-erreur', error)}"${invalid(error)}>
<option value="">Choisir un poste…</option>
${stations.map((station) => html`<option value="${station.id}"${String(station.id) === selected ? html` selected` : null}>${station.name}</option>
`)}</select>
<p class="aide" id="station-aide">La correction s'applique tout de suite, à l'heure actuelle. Le prochain scan de l'objet la remplacera.</p>
${fieldError('station-erreur', error)}</div>
<div class="actions-formulaire">
<button class="bouton" type="submit">Enregistrer la correction</button>
<a class="lien-annuler" href="/items/${item.id}">Annuler</a>
</div>
</form>`;
  }
  return appLayout(user, 'Corriger l\'emplacement', html`${trail([['/', 'Inventaire'], [`/items/${item.id}`, item.name]], 'Corriger l\'emplacement')}
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
const readerTrail = (reader) => [READERS_TRAIL, [`/readers/${reader.id}`, `Lecteur n° ${reader.id}`]];

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
  return messagePage(user, {
    title: 'Poste introuvable', text: 'Aucun poste ne correspond à cette adresse.', parents: [STATIONS_TRAIL], layout: stationsSection, iconName: 'poste',
  });
}

export function readerNotFoundPage(user) {
  return messagePage(user, {
    title: 'Lecteur introuvable', text: 'Aucun lecteur ne correspond à cette adresse.', parents: [READERS_TRAIL], layout: readersSection, iconName: 'lecteur',
  });
}

/** Action impossible sur un lecteur désactivé (affectation, remplacement, désactivation). */
export function readerInactivePage(user, { reader }) {
  return messagePage(user, {
    title: 'Lecteur désactivé',
    text: `Le lecteur n° ${reader.id} est désactivé définitivement : il ne peut plus changer de poste, ni être désactivé ou remplacé une seconde fois.`,
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
  const description = station.description === ''
    ? html`<p class="texte-doux">Aucune description</p>`
    : html`<p class="notes">${station.description}</p>`;
  const activeCount = readers.filter((reader) => reader.active === 1).length;

  const readerList = readers.length === 0
    ? html`<p class="texte-doux">Aucun lecteur n'est affecté à ce poste. On affecte un lecteur depuis sa fiche («&nbsp;Changer de poste&nbsp;»), ou à sa création.</p>`
    : html`<table class="tableau tableau-lecteurs-poste">
<thead><tr><th scope="col">Lecteur</th><th scope="col">État</th><th scope="col">Créé</th></tr></thead>
<tbody>
${readers.map((reader) => html`<tr>
<td><a class="lien-objet" href="/readers/${reader.id}">Lecteur n° ${reader.id}</a></td>
<td data-label="État">${readerBadge(reader)}</td>
<td data-label="Créé">${formatDateTime(reader.created_at)}</td>
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
${description}
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
<p class="aide" id="name-aide">Par exemple «&nbsp;Banc de mesure 2&nbsp;». Deux postes ne peuvent pas porter le même nom (majuscules et minuscules confondues). ${MAX_STATION_NAME_CHARS} caractères au plus.</p>
${fieldError('name-erreur', errors.name)}</div>
<div class="champ">
<label for="description">Description</label>
<textarea id="description" name="description" rows="4" maxlength="${MAX_STATION_DESCRIPTION_CHARS}" aria-describedby="${describedBy('description-aide', 'description-erreur', errors.description)}"${invalid(errors.description)}>${form.description}</textarea>
<p class="aide" id="description-aide">Facultative : emplacement, usage… ${thousands(MAX_STATION_DESCRIPTION_CHARS)} caractères au plus.</p>
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
<thead><tr><th scope="col">Lecteur</th><th scope="col">Poste</th><th scope="col">État</th><th scope="col">Dernier scan</th><th scope="col">Créé</th></tr></thead>
<tbody>
${readers.map((reader) => html`<tr>
<td><a class="lien-objet" href="/readers/${reader.id}">Lecteur n° ${reader.id}</a></td>
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
  const actions = active
    ? html`<div class="actions-page">
<a class="bouton" href="/readers/${reader.id}/station">Changer de poste</a>
<a class="bouton bouton-secondaire" href="/readers/${reader.id}/replace">Remplacer la clé</a>
<a class="lien-danger" href="/readers/${reader.id}/deactivate">Désactiver</a>
</div>`
    : null;

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

  return appLayout(user, `Lecteur n° ${reader.id}`, html`${trail([READERS_TRAIL], `Lecteur n° ${reader.id}`)}
${noticeFor(READER_NOTICES, notice)}<div class="entete-page entete-actions">
<div class="titre-icone">${icon('lecteur')}<h1>Lecteur n° ${reader.id}</h1></div>
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
<div><dt>Poste</dt><dd>${stationLink(reader.station_id, reader.station_name)}</dd></div>
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

/**
 * Création d'un lecteur : choix facultatif du poste.
 * @param {{stations: {id, name}[], selected?: string, error?: string|null}} data
 */
export function readerFormPage(user, { stations, selected = '', error = null }) {
  return appLayout(user, 'Nouveau lecteur', html`${trail([READERS_TRAIL], 'Nouveau lecteur')}
<div class="entete-page">
<h1>Nouveau lecteur</h1>
</div>
${AIDE.nouveauLecteur}<form class="formulaire-page" method="post" action="/readers/new">
<input type="hidden" name="csrf" value="${user.csrf}">
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
<p class="sous-titre-page">Lecteur n° ${reader.id}</p>
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

/** Confirmation de désactivation (définitive) d'un lecteur actif. */
export function deactivateReaderPage(user, { reader }) {
  return appLayout(user, 'Désactiver le lecteur', html`${trail(readerTrail(reader), 'Désactiver')}
<div class="entete-page">
<h1>Désactiver le lecteur</h1>
<p class="sous-titre-page">Lecteur n° ${reader.id} · ${reader.station_id === null ? 'non affecté' : reader.station_name}</p>
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
<p class="sous-titre-page">Lecteur n° ${reader.id} · ${station}</p>
</div>
${AIDE.remplacerCle}<div class="panneau panneau-danger">
<p>Un <strong>nouveau lecteur</strong> sera créé, avec un nouveau numéro et une nouvelle clé, au même poste (${station}).</p>
<p>Le lecteur n° ${reader.id} sera <strong>désactivé définitivement</strong> : ses scans seront refusés dès maintenant, jusqu'à ce que le boîtier reçoive le nouveau numéro et la nouvelle clé.</p>
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
 * @param {{id: number, station: {id, name}|null, keyHex: string, oldId?: number|null}} data
 *   keyHex : 64 caractères hexadécimaux en minuscules, le format du fichier lu par
 *   tools/simulateur.js --key-file (comme dev/reader-1.key) ; oldId : lecteur remplacé.
 */
export function readerKeyPage(user, { id, station, keyHex, oldId = null }) {
  const done = oldId === null
    ? `Lecteur n° ${id} créé.`
    : `Clé remplacée : lecteur n° ${id} créé, lecteur n° ${oldId} désactivé.`;
  return appLayout(user, `Clé du lecteur n° ${id}`, html`${trail([READERS_TRAIL], `Clé du lecteur n° ${id}`)}
<p class="succes" role="status">${done}</p>
<div class="entete-page">
<h1>Clé du lecteur n° ${id}</h1>
<p class="sous-titre-page">Poste : ${station === null ? 'non affecté' : station.name}</p>
</div>
<div class="panneau panneau-alerte" role="alert">
<p><strong>Cette clé ne sera plus jamais affichée.</strong> Installez-la maintenant dans le boîtier, avec son numéro de lecteur. Si elle est perdue, remplacez la clé depuis la fiche du lecteur.</p>
<p>Ne rechargez pas cette page : le navigateur proposerait de renvoyer le formulaire, ce qui créerait un autre lecteur.</p>
<p>Fermez cet onglet une fois la clé installée dans le boîtier.</p>
</div>
<section class="carte carte-corps carte-cle" aria-labelledby="titre-numero">
<h2 id="titre-numero" class="etiquette">Numéro du lecteur</h2>
<p class="numero-lecteur">${id}</p>
<h2 id="titre-cle" class="etiquette">Clé secrète</h2>
<pre class="cle">${keyHex}</pre>
<p class="aide">Un clic sur la clé la sélectionne en entier.</p>
</section>
<div class="actions-formulaire">
<a class="bouton" href="/readers">Retour aux lecteurs</a>
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
    ? `Ses ${thousands(chip.scan_count)} scans enregistrés, y compris ceux de cette époque, seront rattachés à la nouvelle fiche : ils compteront dans ses derniers scans.`
    : 'Son scan enregistré sera rattaché à la nouvelle fiche : il comptera dans ses derniers scans.';
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
${AIDE.associerRecherche}<form class="recherche" method="get" action="${base}" role="search">
${icon('recherche')}
<label class="visuellement-cache" for="q">Rechercher une fiche par nom ou numéro de puce</label>
<input id="q" name="q" type="search" value="${query}" maxlength="${MAX_QUERY_CHARS}" placeholder="Nom ou numéro de puce" autocomplete="off" spellcheck="false">
<button class="bouton bouton-secondaire" type="submit">Rechercher</button>
</form>
${summary}
${body}
${total === 0 && !searching ? null : html`<p class="alternative">L'objet n'a pas encore de fiche ? <a href="/chips/${chip.uid}/new">Créer une fiche pour cette puce</a></p>\n`}`, chipsSection);
}

/**
 * Confirmation de l'association d'une puce inconnue à une fiche. Si la fiche porte déjà une
 * puce : avertissement (l'ancienne puce sera détachée) et bouton rouge.
 * @param {{chip: object, item: object, now: number, changed?: boolean}} data
 *   item : fiche avec son emplacement (inventory.js, getItem) ; changed : l'envoi précédent a
 *   été refusé parce que la fiche avait changé de puce entre-temps (page réaffichée en 409).
 */
export function associateConfirmPage(user, { chip, item, now, changed = false }) {
  const replacing = item.uid_nfc !== null;
  const title = replacing ? 'Remplacer la puce de la fiche' : 'Associer la puce';
  const search = `/chips/${chip.uid}/associate`;
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

  return appLayout(user, title, html`${trail([CHIPS_TRAIL, [search, 'Associer la puce']], title)}
<div class="entete-page">
<h1>${title}</h1>
<p class="sous-titre-page">${item.name}</p>
</div>
${AIDE.associerConfirmation}${changed ? html`<p class="erreur" role="alert">La fiche a changé de puce depuis l'affichage de la page précédente : rien n'a été modifié. Vérifiez ci-dessous, puis confirmez à nouveau.</p>\n` : null}${reuseWarning(chip)}<div class="panneau ${replacing ? 'panneau-danger' : 'panneau-info'}">
${explanation}
${correctionWins ? html`<p class="texte-doux">Une correction manuelle d'emplacement plus récente que ce scan existe : elle reste l'emplacement de la fiche jusqu'au prochain scan de la puce.</p>\n` : null}<form method="post" action="${search}/${item.id}">
<input type="hidden" name="csrf" value="${user.csrf}">
<input type="hidden" name="previous" value="${item.uid_nfc ?? ''}">
<div class="actions-formulaire">
${replacing
    ? html`<button class="bouton bouton-danger" type="submit">Remplacer la puce</button>`
    : html`<button class="bouton" type="submit">Associer la puce</button>`}
<a class="lien-annuler" href="${search}">Annuler</a>
</div>
</form>
</div>`, chipsSection);
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
